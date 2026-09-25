begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_retention;
insert into auth.users(id,email,email_confirmed_at) values
 ('91000000-0000-0000-0000-000000000001','ret-owner@example.invalid',clock_timestamp()),
 ('91000000-0000-0000-0000-000000000002','ret-other@example.invalid',clock_timestamp());
select private.bootstrap_organization('92000000-0000-0000-0000-000000000001','Retention A','91000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('92000000-0000-0000-0000-000000000002','Retention B','91000000-0000-0000-0000-000000000002',gen_random_uuid());
insert into public.employees(id,organization_id,code,display_name) values
 ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','one','Synthetic One'),
 ('94000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000002','two','Synthetic Two');
insert into private.kiosk_network_buckets(organization_id,subject_hash,window_start)
 values('92000000-0000-0000-0000-000000000001',repeat('a',64),clock_timestamp()-interval '25 hours'),
 ('92000000-0000-0000-0000-000000000002',repeat('b',64),clock_timestamp()-interval '25 hours');
set constraints all immediate;
select ok(not exists(select 1 from pg_roles where rolname='fichaje_retention' and
 (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreatedb or rolcreaterole)),
 'retention role cannot login or bypass RLS');
select ok(not has_function_privilege('authenticated','private.purge_operational(uuid,timestamptz,text)',
 'EXECUTE'),'authenticated cannot purge');
select ok(not has_function_privilege('service_role','private.purge_operational(uuid,timestamptz,text)',
 'EXECUTE'),'service role cannot purge');
select set_config('request.jwt.claims','{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select private.purge_operational('92000000-0000-0000-0000-000000000001',clock_timestamp(),'owner')$$,
 '42501',null,'OWNER cannot call offline purge');
reset role;
set local role fichaje_retention;
select throws_ok($$select private.purge_operational('92000000-0000-0000-0000-000000000001',
 clock_timestamp()+interval '1 day','authorization')$$,'22023','INVALID_INPUT','future cutoff rejected');
select private.record_legal_hold('92000000-0000-0000-0000-000000000001',null,'Preserve','AUTH-HOLD-1');
select throws_ok($$select private.purge_operational('92000000-0000-0000-0000-000000000001',
 clock_timestamp(),'AUTH-PURGE-1')$$,'42501','LEGAL_HOLD','organization hold blocks expiry');
select private.record_legal_hold('92000000-0000-0000-0000-000000000001',null,'Release','AUTH-RELEASE-1',
 (select id from private.legal_holds where organization_id='92000000-0000-0000-0000-000000000001' and release_of is null));
select ok(private.purge_operational('92000000-0000-0000-0000-000000000001',clock_timestamp(),
 'AUTH-PURGE-2') is not null,'authorized operational purge committed');
reset role;
select is((select count(*)::int from private.kiosk_network_buckets where organization_id='92000000-0000-0000-0000-000000000001'),0,'only own expired bucket purged');
select is((select count(*)::int from private.kiosk_network_buckets where organization_id='92000000-0000-0000-0000-000000000002'),1,'other tenant retained');
select is((select count(*)::int from private.legal_holds where organization_id='92000000-0000-0000-0000-000000000001'),2,'hold and release are append-only');
select is((select counts->>'network_buckets' from private.retention_runs where organization_id='92000000-0000-0000-0000-000000000001'),'1','manifest counts deletion');
select ok((select digest=encode(sha256(convert_to(jsonb_build_array(organization_id,cutoff,authorization_ref,counts)::text,'UTF8')),'hex')
 from private.retention_runs where organization_id='92000000-0000-0000-0000-000000000001'), 'manifest digest reproducible');
select * from finish();
rollback;
