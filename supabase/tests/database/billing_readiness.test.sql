begin;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,email_confirmed_at) values
 ('81000000-0000-4000-8000-000000000001','billing-owner@example.invalid',clock_timestamp()),
 ('81000000-0000-4000-8000-000000000002','billing-admin@example.invalid',clock_timestamp());

select private.bootstrap_organization(
 '82000000-0000-4000-8000-000000000001','Billing Demo',
 '81000000-0000-4000-8000-000000000001',gen_random_uuid()
);
insert into public.memberships(id,organization_id,auth_user_id,role,active)
values(
 '83000000-0000-4000-8000-000000000002',
 '82000000-0000-4000-8000-000000000001',
 '81000000-0000-4000-8000-000000000002','ADMIN',true
);

select ok((not has_table_privilege('authenticated','private.billing_accounts','SELECT')),
 'billing account is never directly readable by clients');
select ok((not has_table_privilege('service_role','private.billing_accounts','SELECT')),
 'service role uses fixed RPC rather than direct billing table access');
select ok((has_function_privilege('authenticated','public.get_billing_summary(uuid)','EXECUTE')),
 'authenticated may call owner-scoped summary');
select ok((not has_function_privilege('authenticated','public.billing_server_context(uuid)','EXECUTE')),
 'client cannot execute server billing context');
select ok((has_function_privilege('service_role','public.billing_server_context(uuid)','EXECUTE')),
 'service role may execute fixed server billing context');
select ok((not has_function_privilege('authenticated','public.billing_attach_customer(uuid,text)','EXECUTE')),
 'client cannot attach Stripe customer mapping');

-- OWNER gets safe billing summary; ADMIN does not.
select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is(
 (public.get_billing_summary('82000000-0000-4000-8000-000000000001')->>'status'),
 'NOT_CONFIGURED','owner sees unconfigured billing state'
);
select is(
 (public.get_billing_summary('82000000-0000-4000-8000-000000000001')->>'active_employees')::int,
 0,'owner summary counts active employees server-side'
);
reset role;

select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select throws_ok(
 $$select public.get_billing_summary('82000000-0000-4000-8000-000000000001')$$,
 '42501','FORBIDDEN','ADMIN cannot control company billing'
);
reset role;

-- Employee changes only queue durable seat intent; no external side effect exists.
insert into public.employees(id,organization_id,code,display_name,active)
values('84000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','B1','Billing One',true);
select is(
 (select desired_quantity from private.billing_seat_outbox where organization_id='82000000-0000-4000-8000-000000000001'),
 1,'employee insert queues authoritative active count'
);
select is(
 (select revision from private.billing_seat_outbox where organization_id='82000000-0000-4000-8000-000000000001'),
 1::bigint,'first employee change creates the first outbox revision for a newly-created tenant'
);
update public.employees set active=false
where id='84000000-0000-4000-8000-000000000001';
select is(
 (select desired_quantity from private.billing_seat_outbox where organization_id='82000000-0000-4000-8000-000000000001'),
 0,'employee deactivation queues reduced authoritative count'
);
select is(
 (select revision from private.billing_seat_outbox where organization_id='82000000-0000-4000-8000-000000000001'),
 2::bigint,'seat intent revisions are monotonic'
);

-- Fixed service RPCs own the external identifiers; clients never supply them to labour RPCs.
set local role service_role;
select is(
 public.billing_attach_customer(
  '82000000-0000-4000-8000-000000000001','cus_Synthetic01'
 )->>'attached','true','service attaches Stripe customer id'
);
select is(
 public.billing_server_context('82000000-0000-4000-8000-000000000001')->>'stripe_customer_id',
 'cus_Synthetic01','server context resolves the attached customer'
);
select is(
 public.billing_record_subscription_snapshot(
  'evt_Synthetic01','customer.subscription.updated',100,
  '82000000-0000-4000-8000-000000000001',
  'cus_Synthetic01','sub_Synthetic01','si_Synthetic01','ACTIVE',0,false,
  '2026-11-02T00:00:00Z'
 )->>'applied','true','signed webhook worker can persist a validated current snapshot'
);
select is(
 public.billing_record_subscription_snapshot(
  'evt_Synthetic01','customer.subscription.updated',100,
  '82000000-0000-4000-8000-000000000001',
  'cus_Synthetic01','sub_Synthetic01','si_Synthetic01','ACTIVE',0,false,
  '2026-11-02T00:00:00Z'
 )->>'duplicate','true','webhook event replay is idempotent'
);
reset role;
select is(
 (select count(*)::int from private.billing_events where stripe_event_id='evt_Synthetic01'),
 1,'event ledger stores one row for a replay'
);
set local role service_role;
select is(
 public.billing_ack_seat_sync(
  '82000000-0000-4000-8000-000000000001',2,0
 )->>'acked','true','seat sync ACK consumes only the matching revision'
);
select is(
 public.billing_server_context('82000000-0000-4000-8000-000000000001')->>'desired_seat_quantity',
 '0','server context falls back to current count after ACK'
);
reset role;

select * from finish();
rollback;
