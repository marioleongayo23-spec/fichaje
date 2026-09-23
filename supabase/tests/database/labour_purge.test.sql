begin;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,email_confirmed_at) values
 ('a1000000-0000-0000-0000-000000000001','purge-a@example.invalid',now()),
 ('a1000000-0000-0000-0000-000000000002','purge-b@example.invalid',now());
select private.bootstrap_organization('a2000000-0000-0000-0000-000000000001','Purge A',
 'a1000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('a2000000-0000-0000-0000-000000000002','Purge B',
 'a1000000-0000-0000-0000-000000000002',gen_random_uuid());
insert into public.employees(id,organization_id,code,display_name) values
 ('a3000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','p-a','Synthetic A'),
 ('a3000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000002','p-b','Synthetic B');
insert into public.work_policies(id,organization_id,version,timezone,break_counts_as_work,valid_from,created_by,created_at)
select 'a4000000-0000-0000-0000-000000000001',organization_id,1,'Europe/Madrid',false,
 '2019-01-01',id,'2019-01-01' from public.memberships where organization_id='a2000000-0000-0000-0000-000000000001';
insert into public.work_policies(id,organization_id,version,timezone,break_counts_as_work,valid_from,created_by,created_at)
select 'a4000000-0000-0000-0000-000000000002',organization_id,1,'Atlantic/Canary',false,
 '2019-01-01',id,'2019-01-01' from public.memberships where organization_id='a2000000-0000-0000-0000-000000000002';
insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at) values
 ('a5000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000001','Europe/Madrid','2020-01-10 08:00+00'),
 ('a5000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000002',
  'a3000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000002','Atlantic/Canary','2020-01-10 08:00+00');
insert into public.time_events(organization_id,employee_id,session_id,sequence,event_type,server_at,
 actor_membership_id,source,request_id)
select s.organization_id,s.employee_id,s.id,n.seq,n.action,n.at,m.id,'WEB',gen_random_uuid()
from public.work_sessions s join public.memberships m on m.organization_id=s.organization_id
cross join (values (1,'CLOCK_IN'::public.time_action,'2020-01-10 08:00+00'::timestamptz),
 (2,'CLOCK_OUT'::public.time_action,'2020-01-10 16:00+00'::timestamptz)) n(seq,action,at);
select ok(not has_function_privilege('authenticated',
 'private.purge_labour(uuid,uuid,date,timestamptz,text)','EXECUTE'),'JWT role cannot purge labour');
select ok(not has_function_privilege('service_role',
 'private.purge_labour(uuid,uuid,date,timestamptz,text)','EXECUTE'),'service role cannot purge labour');
set local role fichaje_retention;
select throws_ok($$select private.purge_labour('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000002','2020-01-01','2024-02-01','AUTH-A')$$,
 '42501','FORBIDDEN','cross-tenant employee indistinguishable');
select throws_ok($$select private.purge_labour('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000001','2020-01-01','2024-01-31 22:59:59+00','AUTH-A')$$,
 '22023','NOT_EXPIRED','one second before four-year boundary rejected');
select private.record_legal_hold('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000001','Preserve','HOLD-A');
select throws_ok($$select private.purge_labour('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000001','2020-01-01','2024-01-31 23:00+00','AUTH-A')$$,
 '42501','LEGAL_HOLD','employee hold blocks labour purge');
select private.record_legal_hold('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000001','Released','RELEASE-A',
 (select id from private.legal_holds where authorized_by='HOLD-A'));
select ok(private.purge_labour('a2000000-0000-0000-0000-000000000001',
 'a3000000-0000-0000-0000-000000000001','2020-01-01','2024-01-31 23:00+00','AUTH-A') is not null,
 'exact boundary permits authorized purge');
reset role;
select is((select count(*)::int from public.work_sessions where organization_id='a2000000-0000-0000-0000-000000000001'),0,'session removed');
select is((select count(*)::int from public.time_events where organization_id='a2000000-0000-0000-0000-000000000001'),0,'events removed');
select is((select count(*)::int from public.work_sessions where organization_id='a2000000-0000-0000-0000-000000000002'),1,'other tenant untouched');
select is((select counts->>'time_events' from private.retention_runs where authorization_ref='AUTH-A'),'2','manifest counts actual events');
select ok((select digest=encode(sha256(convert_to(jsonb_build_array(organization_id,cutoff,authorization_ref,counts)::text,'UTF8')),'hex')
 from private.retention_runs where authorization_ref='AUTH-A'),'manifest reproducible');
select is((select count(*)::int from private.legal_holds where organization_id='a2000000-0000-0000-0000-000000000001'),2,
 'hold and release preserved append-only');
select * from finish();
rollback;
