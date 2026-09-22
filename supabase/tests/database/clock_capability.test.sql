begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_clock,fichaje_state_reader,fichaje_writer;
insert into auth.users(id,email,email_confirmed_at) values
 ('31000000-0000-0000-0000-000000000001','clock-owner@example.invalid',clock_timestamp()),
 ('31000000-0000-0000-0000-000000000002','clock-worker@example.invalid',clock_timestamp()),
 ('31000000-0000-0000-0000-000000000003','clock-foreign@example.invalid',clock_timestamp());
select private.bootstrap_organization('32000000-0000-0000-0000-000000000001','Clock A','31000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('32000000-0000-0000-0000-000000000002','Clock B','31000000-0000-0000-0000-000000000003',gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role)
values('33000000-0000-0000-0000-000000000002','32000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000002','EMPLOYEE');
insert into public.employees(id,organization_id,code,display_name,membership_id)
select '34000000-0000-0000-0000-000000000001',organization_id,'owner','Owner',id from public.memberships where auth_user_id='31000000-0000-0000-0000-000000000001';
insert into public.employees(id,organization_id,code,display_name,membership_id)
values('34000000-0000-0000-0000-000000000002','32000000-0000-0000-0000-000000000001','worker','Worker','33000000-0000-0000-0000-000000000002');
insert into public.employees(id,organization_id,code,display_name,membership_id)
select '34000000-0000-0000-0000-000000000003',organization_id,'foreign','Foreign',id from public.memberships where auth_user_id='31000000-0000-0000-0000-000000000003';
set constraints all immediate;
select ok(not exists(select 1 from pg_roles where rolname in ('fichaje_clock','fichaje_state_reader')
 and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb)),'clock roles have no login or privileged attributes');
select set_config('request.jwt.claims','{"sub":"31000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select public.record_time_event('32000000-0000-0000-0000-000000000001',gen_random_uuid(),'34000000-0000-0000-0000-000000000002','CLOCK_IN',0)$$,
 '22023','POLICY_REQUIRED','valid EMPLOYEE reaches policy validation without manager capability');
select is(public.get_employee_state('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000002')->>'version','0','policy failure leaves initial state unchanged');
select throws_ok($$select public.get_employee_state('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000001')$$,'42501','FORBIDDEN','employee cannot read another state');
select throws_ok($$select public.create_work_policy('32000000-0000-0000-0000-000000000001',gen_random_uuid(),'Europe/Madrid',false)$$,'42501','FORBIDDEN','EMPLOYEE still cannot create policies');
reset role;
set local role fichaje_writer;
select throws_ok($$select private.authorize('32000000-0000-0000-0000-000000000001')$$,'42501','FORBIDDEN','H1 member gate remains manager-only');
select throws_ok($$select private.clock_scope('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000002')$$,'42501',null,'H1 writer cannot borrow clock capability');
reset role;
set local role fichaje_clock;
select set_config('app.organization_id','32000000-0000-0000-0000-000000000001',true);
select is((select count(*)::int from private.employee_state),0,'clock with forged GUC and no capability sees nothing');
select throws_ok($$select private.bind_context('32000000-0000-0000-0000-000000000001','clock','34000000-0000-0000-0000-000000000002')$$,'42501',null,'clock cannot manufacture context');
select throws_ok($$select private.member_scope('32000000-0000-0000-0000-000000000001')$$,'42501',null,'clock cannot obtain H1 manager scope');
select private.clock_scope('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000002');
select is((select count(*)::int from private.employee_state),1,'unfiltered clock read limited to one employee');
with changed as (update private.employee_state set version=99 where employee_id='34000000-0000-0000-0000-000000000001' returning *)
 select is((select count(*)::int from changed),0,'clock cannot mutate other employee in same tenant');
with changed as (update private.employee_state set version=99 where organization_id='32000000-0000-0000-0000-000000000002' returning *)
 select is((select count(*)::int from changed),0,'clock cannot mutate foreign tenant');
select throws_ok($$update private.employee_state set employee_id='34000000-0000-0000-0000-000000000001'$$,'42501',null,'clock cannot move projection to other employee');
select throws_ok($$update private.employee_state set organization_id='32000000-0000-0000-0000-000000000002'$$,'42501',null,'clock cannot move projection tenant');
select throws_ok($$update public.memberships set role='OWNER'$$,'42501',null,'clock cannot elevate membership');
select throws_ok($$update public.employees set active=false$$,'42501',null,'clock cannot edit employee');
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501',null,'clock cannot UPDATE originals');
select throws_ok($$delete from public.time_events$$,'42501',null,'clock cannot DELETE originals');
select throws_ok($$truncate public.time_events$$,'42501',null,'clock cannot TRUNCATE originals');
select throws_ok($$select private.clock_scope('32000000-0000-0000-0000-000000000002','34000000-0000-0000-0000-000000000003')$$,'42501','FORBIDDEN','clock rejects cross-tenant scope');
select throws_ok($$select private.clock_scope('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000001')$$,'42501','FORBIDDEN','clock rejects other employee scope');
reset role;
select is((select count(*)::int from public.time_events),0,'policy failure creates no event');
select is((select count(*)::int from public.work_sessions),0,'policy failure creates no session');
select is((select count(*)::int from public.audit_log where action='record_time_event'),0,'policy failure creates no audit');
select is((select count(*)::int from private.idempotency_records where operation='record_time_event'),0,'policy failure consumes no request');
set local role fichaje_state_reader;
select is((select count(*)::int from private.employee_state),1,'read-only role filters employee state without mutation context');
select throws_ok($$update private.employee_state set version=99$$,'42501',null,'state reader has no mutation privilege');
select throws_ok($$select private.clock_scope('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000002')$$,'42501',null,'state reader cannot bind mutation context');
reset role;
select set_config('request.jwt.claims','{"sub":"31000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is(public.get_employee_state('32000000-0000-0000-0000-000000000001','34000000-0000-0000-0000-000000000002')->>'state','OUT','manager may read employee state');
select throws_ok($$select public.record_time_event('32000000-0000-0000-0000-000000000001',gen_random_uuid(),'34000000-0000-0000-0000-000000000002','CLOCK_IN',0)$$,'42501','FORBIDDEN','manager cannot clock for another employee');
reset role;
select * from finish();
rollback;
