begin;
set local search_path=public,extensions;
select no_plan();
-- Test harness only; rolled back with fixtures. Production writer has no pgTAP access.
grant usage on schema extensions to fichaje_writer;
insert into auth.users(id,email,email_confirmed_at) values
 ('11111111-1111-1111-1111-111111111111','owner-a@example.invalid',clock_timestamp()),
 ('22222222-2222-2222-2222-222222222222','owner-b@example.invalid',clock_timestamp()),
 ('33333333-3333-3333-3333-333333333333','worker@example.invalid',clock_timestamp());
select private.bootstrap_organization('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A','11111111-1111-1111-1111-111111111111',gen_random_uuid());
select private.bootstrap_organization('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B','22222222-2222-2222-2222-222222222222',gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role) values
 ('33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333','EMPLOYEE'),
 ('11111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','ADMIN');
insert into public.employees(id,organization_id,code,display_name) values
 ('aaaaaaaa-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A1','A'),
 ('bbbbbbbb-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B1','B');
set constraints all immediate;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}',true);
set local role fichaje_writer;
select is((select count(*)::int from public.employees),0,'SEC writer without context reads zero');
select set_config('app.organization_id','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
select set_config('request.organization_id','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
select is((select count(*)::int from public.employees),0,'SEC forged GUC is not authority');
select throws_ok($$insert into private.mutation_context values(pg_current_xact_id(),pg_backend_pid(),'member','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',null,null,null)$$,'42501',null,'SEC writer cannot manufacture context');
select private.member_scope('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.employees),1,'SEC writer reads scoped tenant only');
select is((select count(*)::int from public.organizations),1,'SEC root scoped');
select is((select count(*)::int from public.memberships where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),0,'SEC memberships scoped');
select is((select count(*)::int from public.audit_log where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),0,'SEC audit scoped');
select is((select count(*)::int from private.idempotency_records where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),0,'SEC receipts scoped');
select throws_ok($$select private.member_scope('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,'42501','FORBIDDEN','SEC cannot switch tenant even when actor belongs to both');
select throws_ok($$insert into public.employees(organization_id,code,display_name) values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','BAD','BAD')$$,'42501',null,'SEC foreign INSERT blocked by RLS');
with changed as (update public.employees set active=false where id='bbbbbbbb-1111-1111-1111-111111111111' returning id) select is((select count(*)::int from changed),0,'SEC foreign UPDATE cannot find row');
select throws_ok($$update public.employees set organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id='aaaaaaaa-1111-1111-1111-111111111111'$$,'42501',null,'SEC WITH CHECK prevents tenant move');
select throws_ok($$select private.invitation_scope('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',repeat('1',64))$$,'42501',null,'SEC writer cannot invoke invitation capability');
select throws_ok($$select private.bootstrap_organization(gen_random_uuid(),'BAD','11111111-1111-1111-1111-111111111111',gen_random_uuid())$$,'42501',null,'SEC writer cannot bootstrap');
select throws_ok($$delete from private.mutation_context$$,'42501',null,'SEC writer cannot clear scope');
reset role;
-- Deliberately defective ordinary definer: no org filter. RLS still scopes its query.
grant create on schema public to fichaje_writer;
create function public.h1_defective_reader() returns bigint language sql security definer set search_path='' as $$ select count(*) from public.employees $$;
alter function public.h1_defective_reader() owner to fichaje_writer;
revoke create on schema public from fichaje_writer;
grant execute on function public.h1_defective_reader() to authenticated;
set local role authenticated;
select is(public.h1_defective_reader(),1::bigint,'SEC missing procedural filter still cannot read another tenant');
reset role;
-- Ordinary context is fixed for this transaction; audit commands all target A.
set local role authenticated;
select public.manage_membership('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000001','33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',1,'ADMIN',false);
select public.manage_membership('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000002','33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',2,'EMPLOYEE',true);
select is((select jsonb_agg(safe_details order by (safe_details#>>'{after,version}')::int) from public.audit_log where entity_id='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and action='manage_membership'),
 '[{"before":{"role":"EMPLOYEE","active":true,"version":1},"after":{"role":"ADMIN","active":false,"version":2}},{"before":{"role":"ADMIN","active":false,"version":2},"after":{"role":"EMPLOYEE","active":true,"version":3}}]'::jsonb,
 'AUD two successive role/state transitions reconstruct exclusively from audit');
select public.manage_membership('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000002','33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',2,'EMPLOYEE',true);
select is((select count(*)::int from public.audit_log where action='manage_membership'),2,'AUD replay does not append duplicate change');
select public.manage_employee('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'aaaaaaaa-1111-1111-1111-111111111111',1,'A1','A','33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false);
select public.manage_employee('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'aaaaaaaa-1111-1111-1111-111111111111',2,'A1','A',null,true);
select is((select jsonb_agg(safe_details order by (safe_details#>>'{after,version}')::int) from public.audit_log where action='manage_employee'),
 '[{"before":{"active":true,"membership_id":null,"version":1},"after":{"active":false,"membership_id":"33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa","version":2}},{"before":{"active":false,"membership_id":"33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa","version":2},"after":{"active":true,"membership_id":null,"version":3}}]'::jsonb,
 'AUD employee active and membership linkage reconstruct from audit');
set constraints all deferred;
select public.transfer_ownership('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',gen_random_uuid(),'33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',3);
set constraints all immediate;
select ok((select safe_details#>>'{changes,0,before,role}'='OWNER' and safe_details#>>'{changes,0,after,role}'='ADMIN'
 and safe_details#>>'{changes,1,before,role}'='EMPLOYEE' and safe_details#>>'{changes,1,after,role}'='OWNER'
 and safe_details#>>'{changes,1,membership_id}'='33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
 from public.audit_log where action='transfer_ownership'),'AUD transfer records both parties before and after');
select ok(not exists(select 1 from public.audit_log where safe_details::text ~ '(email|token|payload|display_name|example.invalid)'), 'AUD no email/token/payload/name');
reset role;
select * from finish();
rollback;
