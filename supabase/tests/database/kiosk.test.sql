begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_kiosk,fichaje_gateway;
insert into auth.users(id,email,email_confirmed_at) values
 ('71000000-0000-0000-0000-000000000001','kio-owner@example.invalid',clock_timestamp()),
 ('71000000-0000-0000-0000-000000000002','kio-device@example.invalid',clock_timestamp()),
 ('71000000-0000-0000-0000-000000000003','kio-foreign@example.invalid',clock_timestamp());
select private.bootstrap_organization('72000000-0000-0000-0000-000000000001','Kiosk A','71000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('72000000-0000-0000-0000-000000000002','Kiosk B','71000000-0000-0000-0000-000000000003',gen_random_uuid());
insert into public.employees(id,organization_id,code,display_name) values
 ('74000000-0000-0000-0000-000000000001','72000000-0000-0000-0000-000000000001','a','Synthetic A'),
 ('74000000-0000-0000-0000-000000000002','72000000-0000-0000-0000-000000000002','b','Synthetic B');
insert into private.kiosk_devices(id,organization_id,auth_user_id,name,expires_at) values
 ('75000000-0000-0000-0000-000000000001','72000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000002','Device',clock_timestamp()+interval '1 day');
set constraints all immediate;
select ok(not exists(select 1 from pg_class where relnamespace='private'::regnamespace and relname in ('kiosk_devices','kiosk_credentials','kiosk_challenges','auth_attempt_buckets','kiosk_network_buckets') and (not relrowsecurity or not relforcerowsecurity)),'all kiosk data FORCE RLS');
select ok(not exists(select 1 from pg_roles where rolname in ('fichaje_kiosk','fichaje_gateway') and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreatedb or rolcreaterole)),'dedicated roles minimum privileges');
select throws_ok($$insert into public.memberships(organization_id,auth_user_id,role) values('72000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000002','EMPLOYEE')$$,'42501','FORBIDDEN','technical Auth cannot gain even foreign human membership');
select throws_ok($$insert into private.kiosk_devices(id,organization_id,auth_user_id,name,expires_at) values(gen_random_uuid(),'72000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000001','Bad',clock_timestamp()+interval '1 day')$$,'42501','FORBIDDEN','human Auth cannot become a device');
select set_config('request.jwt.claims','{"sub":"71000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is((select count(*)::int from public.employees),0,'device has no employee directory');
select is((select count(*)::int from public.memberships),0,'device has no memberships');
select is((select count(*)::int from public.time_events),0,'device has no free event SELECT');
select throws_ok($$select * from private.kiosk_credentials$$,'42501',null,'credentials not accessible');
select throws_ok($$select private.kiosk_record_event(null,null,null,null,null,null,null)$$,'42501',null,'device cannot call gateway function directly');
select throws_ok($$select public.get_employee_state('72000000-0000-0000-0000-000000000001','74000000-0000-0000-0000-000000000001')$$,'42501','FORBIDDEN','no free state API');
reset role;
set local role fichaje_gateway;
select throws_ok($$select * from public.employees$$,'42501',null,'gateway login no table reads');
select throws_ok($$select private.bind_context('72000000-0000-0000-0000-000000000001','member')$$,'42501',null,'gateway cannot manufacture capabilities');
select throws_ok($$select public.manage_employee(null,null,null,null,null,null,null,null)$$,'42501',null,'gateway no administrative H1 RPC');
select throws_ok($$select private.apply_time_event(null,null,null,null,null,null,null)$$,'42501',null,'gateway cannot bypass challenge to invoke engine');
reset role;
set local role fichaje_kiosk;
select set_config('app.organization_id','72000000-0000-0000-0000-000000000001',true);
select is((select count(*)::int from private.kiosk_devices),0,'no capability: no device data despite forged GUC');
select is((select count(*)::int from public.employees),0,'no capability: no employees');
select throws_ok($$select private.bind_context('72000000-0000-0000-0000-000000000001','kiosk_admin')$$,'42501',null,'kiosk writer cannot mint context');
select throws_ok($$select private.member_scope('72000000-0000-0000-0000-000000000001')$$,'42501',null,'kiosk writer cannot borrow H1');
select throws_ok($$select private.clock_scope('72000000-0000-0000-0000-000000000001','74000000-0000-0000-0000-000000000001')$$,'42501',null,'kiosk writer cannot borrow human clock scope');
select private.kiosk_scope('72000000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000001','74000000-0000-0000-0000-000000000001',false);
select is((select count(*)::int from private.employee_state),1,'unfiltered technical state SELECT limited to scoped employee');
with changed as (update private.employee_state set version=99 where organization_id='72000000-0000-0000-0000-000000000002' returning *) select is((select count(*)::int from changed),0,'technical UPDATE cannot reach other tenant');
select throws_ok($$update private.employee_state set organization_id='72000000-0000-0000-0000-000000000002'$$,'42501',null,'cannot move projection to foreign tenant');
select throws_ok($$insert into private.kiosk_credentials(organization_id,employee_id,pin_hash,credential_version) values('72000000-0000-0000-0000-000000000002','74000000-0000-0000-0000-000000000002','not-a-pin',1)$$,'42501',null,'technical cross-tenant credential INSERT blocked by RLS');
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501',null,'kiosk cannot UPDATE originals');
select throws_ok($$delete from public.time_events$$,'42501',null,'kiosk cannot DELETE originals');
select throws_ok($$truncate public.time_events$$,'42501',null,'kiosk cannot TRUNCATE originals');
select throws_ok($$update public.memberships set active=false$$,'42501',null,'kiosk writer cannot modify memberships');
select throws_ok($$select private.kiosk_scope('72000000-0000-0000-0000-000000000002','75000000-0000-0000-0000-000000000001',null,false)$$,'42501','FORBIDDEN','technical scope cannot cross tenant');
select throws_ok($$select private.kiosk_scope('72000000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000001','74000000-0000-0000-0000-000000000002',false)$$,'42501','FORBIDDEN','technical scope rejects foreign employee');
select private.kiosk_scope('72000000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000001',null,false);
insert into private.kiosk_network_buckets(organization_id,subject_hash,window_start) values('72000000-0000-0000-0000-000000000001',repeat('a',64),clock_timestamp());
select is((select count(*)::int from private.kiosk_network_buckets),1,'network scope permits own tenant');
select throws_ok($$insert into private.kiosk_network_buckets(organization_id,subject_hash,window_start) values('72000000-0000-0000-0000-000000000002',repeat('b',64),clock_timestamp())$$,'42501',null,'network RLS denies foreign tenant INSERT');
with changed as (update private.kiosk_network_buckets set failures=99 where organization_id='72000000-0000-0000-0000-000000000002' returning *) select is((select count(*)::int from changed),0,'network RLS denies foreign tenant UPDATE');
select throws_ok($$update private.kiosk_network_buckets set subject_hash=repeat('c',64)$$,'42501',null,'network writer cannot change bucket identity');
reset role;
insert into private.kiosk_network_buckets(organization_id,subject_hash,window_start) values('72000000-0000-0000-0000-000000000002',repeat('b',64),clock_timestamp());
set local role fichaje_kiosk;
select is((select count(*)::int from private.kiosk_network_buckets),1,'network RLS hides existing foreign bucket');
reset role;
select * from finish();
rollback;
