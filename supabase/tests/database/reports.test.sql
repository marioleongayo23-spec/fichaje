begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_report;
insert into auth.users(id,email,email_confirmed_at) values
 ('81000000-0000-0000-0000-000000000001','report-owner@example.invalid',clock_timestamp()),
 ('81000000-0000-0000-0000-000000000002','report-employee@example.invalid',clock_timestamp()),
 ('81000000-0000-0000-0000-000000000003','report-other@example.invalid',clock_timestamp());
select private.bootstrap_organization('82000000-0000-0000-0000-000000000001','Report A','81000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('82000000-0000-0000-0000-000000000002','Report B','81000000-0000-0000-0000-000000000003',gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role) values
 ('83000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','EMPLOYEE');
insert into public.employees(id,organization_id,code,display_name,membership_id) values
 ('84000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','=SUM(1,1)','Synthetic', '83000000-0000-0000-0000-000000000001');
insert into public.employees(id,organization_id,code,display_name)
 values('84000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000002','other','Other');
set constraints all immediate;

select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
 ('public.hour_classifications'::regclass,'private.export_jobs'::regclass,
  'private.legal_holds'::regclass,'private.retention_runs'::regclass)), 'H5 tables FORCE RLS');
select ok(not exists(select 1 from pg_roles where rolname in ('fichaje_report','fichaje_export_worker')
 and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreatedb or rolcreaterole)), 'H5 technical roles restricted');
select hasnt_table_privilege('authenticated','private.export_jobs','SELECT','clients cannot read raw jobs');
select hasnt_table_privilege('service_role','private.legal_holds','SELECT','service role cannot read holds');
select is((select public from storage.buckets where id='fichaje-evidence'),false,'private evidence bucket');
select set_config('request.jwt.claims','{"sub":"81000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is((public.get_own_evidence('82000000-0000-0000-0000-000000000001','2026-09-01','2026-09-30','Europe/Madrid')->'employees'->0->>'id'),
 '84000000-0000-0000-0000-000000000001','employee only own evidence');
select throws_ok($$select public.request_export('82000000-0000-0000-0000-000000000001',gen_random_uuid(),
 '84000000-0000-0000-0000-000000000002','2026-09-01','2026-09-30','Europe/Madrid')$$,
 '42501','FORBIDDEN','foreign employee UUID denied');
select throws_ok($$select public.request_export('82000000-0000-0000-0000-000000000002',gen_random_uuid(),
 null,'2026-09-01','2026-09-30','Europe/Madrid')$$,
 '42501','FORBIDDEN','foreign tenant denied');
select ok((public.request_export('82000000-0000-0000-0000-000000000001',gen_random_uuid(),
 null,'2026-09-01','2026-09-30','Europe/Madrid') ? 'job_id'),'own export materialized');
select throws_ok($$select public.authorize_export_link('82000000-0000-0000-0000-000000000001',gen_random_uuid())$$,
 '42501','FORBIDDEN','unknown export UUID denied');
reset role;
set local role fichaje_report;
select is((select count(*)::int from public.employees),0,'reporter without transaction scope sees nothing');
select throws_ok($$select private.bind_context('82000000-0000-0000-0000-000000000002','report')$$,
 '42501',null,'reporter cannot mint cross-tenant capability');
reset role;
select * from finish();
rollback;
