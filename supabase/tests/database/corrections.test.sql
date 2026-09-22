begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_correction;
insert into auth.users(id,email,email_confirmed_at) values
 ('51000000-0000-0000-0000-000000000001','clock-owner@example.invalid',clock_timestamp()),
 ('51000000-0000-0000-0000-000000000002','clock-worker@example.invalid',clock_timestamp()),
 ('51000000-0000-0000-0000-000000000003','clock-foreign@example.invalid',clock_timestamp());
select private.bootstrap_organization('52000000-0000-0000-0000-000000000001','Clock A','51000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('52000000-0000-0000-0000-000000000002','Clock B','51000000-0000-0000-0000-000000000003',gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role)
values('53000000-0000-0000-0000-000000000002','52000000-0000-0000-0000-000000000001','51000000-0000-0000-0000-000000000002','EMPLOYEE');
insert into public.employees(id,organization_id,code,display_name,membership_id)
select '54000000-0000-0000-0000-000000000001',organization_id,'owner','Owner',id from public.memberships where auth_user_id='51000000-0000-0000-0000-000000000001';
insert into public.employees(id,organization_id,code,display_name,membership_id)
values('54000000-0000-0000-0000-000000000002','52000000-0000-0000-0000-000000000001','worker','Worker','53000000-0000-0000-0000-000000000002');
insert into public.employees(id,organization_id,code,display_name,membership_id)
select '54000000-0000-0000-0000-000000000003',organization_id,'foreign','Foreign',id from public.memberships where auth_user_id='51000000-0000-0000-0000-000000000003';
set constraints all immediate;

select ok(not exists(select 1 from pg_roles where rolname='fichaje_correction' and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb)),'H3 role has no privileged attributes');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('public.correction_requests'::regclass,'public.correction_decisions'::regclass,'public.event_adjustments'::regclass)),'all correction evidence FORCE RLS');
select set_config('request.jwt.claims','{"sub":"51000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role fichaje_correction;
select set_config('app.organization_id','52000000-0000-0000-0000-000000000001',true);
select is((select count(*)::int from private.employee_state),0,'forged GUC without protected scope sees no projection');
select throws_ok($$select private.bind_context('52000000-0000-0000-0000-000000000001','correction_decide','54000000-0000-0000-0000-000000000002')$$,'42501',null,'correction role cannot forge context');
select throws_ok($$select private.member_scope('52000000-0000-0000-0000-000000000001')$$,'42501',null,'correction role cannot acquire administrative scope');
select throws_ok($$select private.clock_scope('52000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000002')$$,'42501',null,'correction role cannot acquire clock capability');
select private.correction_scope('52000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000002');
select is((select count(*)::int from private.employee_state),1,'unfiltered read with submit scope sees exactly one employee');
with changed as (update private.employee_state set version=99 returning *) select is((select count(*)::int from changed),0,'submit capability cannot update even its own projection');
select throws_ok($$insert into public.correction_requests(organization_id,employee_id,submitted_by_membership_id,base_version,reason,proposal,created_at) values('52000000-0000-0000-0000-000000000002','54000000-0000-0000-0000-000000000003','53000000-0000-0000-0000-000000000002',0,'test','[]',clock_timestamp())$$,'42501',null,'technical role cross-tenant request insert denied by RLS');
select throws_ok($$insert into public.correction_requests(organization_id,employee_id,submitted_by_membership_id,base_version,reason,proposal,created_at) values('52000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000002',0,'test','[]',clock_timestamp())$$,'42501',null,'technical role same-tenant other employee insert denied');
select throws_ok($$insert into public.correction_decisions(organization_id,employee_id,request_id,decision,actor_membership_id,reason,created_at) values('52000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000002',gen_random_uuid(),'APPROVE','53000000-0000-0000-0000-000000000002','test',clock_timestamp())$$,'42501',null,'submit scope cannot insert decisions');
select throws_ok($$update public.memberships set role='OWNER'$$,'42501',null,'H3 cannot modify identity');
select throws_ok($$insert into public.time_events default values$$,'42501',null,'H3 cannot fabricate original events');
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501',null,'H3 cannot update originals');
select throws_ok($$delete from public.time_events$$,'42501',null,'H3 cannot delete originals');
select throws_ok($$truncate public.time_events$$,'42501',null,'H3 cannot truncate originals');
select throws_ok($$select private.correction_scope('52000000-0000-0000-0000-000000000002','54000000-0000-0000-0000-000000000003')$$,'42501','FORBIDDEN','cross-tenant scope denied');
reset role;
grant update,delete,truncate on public.correction_requests to fichaje_correction;
set local role fichaje_correction;
select throws_ok($$update public.correction_requests set id=id$$,null,null,'immutable correction_requests survives accidental grant: update');
select throws_ok($$delete from public.correction_requests$$,null,null,'immutable correction_requests survives accidental grant: delete');
select throws_ok($$truncate public.correction_requests$$,null,null,'immutable correction_requests survives accidental grant: truncate');
reset role;
grant update,delete,truncate on public.correction_decisions to fichaje_correction;
set local role fichaje_correction;
select throws_ok($$update public.correction_decisions set id=id$$,null,null,'immutable correction_decisions survives accidental grant: update');
select throws_ok($$delete from public.correction_decisions$$,null,null,'immutable correction_decisions survives accidental grant: delete');
select throws_ok($$truncate public.correction_decisions$$,null,null,'immutable correction_decisions survives accidental grant: truncate');
reset role;
grant update,delete,truncate on public.event_adjustments to fichaje_correction;
set local role fichaje_correction;
select throws_ok($$update public.event_adjustments set id=id$$,null,null,'immutable event_adjustments survives accidental grant: update');
select throws_ok($$delete from public.event_adjustments$$,null,null,'immutable event_adjustments survives accidental grant: delete');
select throws_ok($$truncate public.event_adjustments$$,null,null,'immutable event_adjustments survives accidental grant: truncate');
reset role;
grant update,delete,truncate on public.time_events to fichaje_correction;
set local role fichaje_correction;
select throws_ok($$update public.time_events set id=id$$,null,null,'immutable time_events survives accidental grant: update');
select throws_ok($$delete from public.time_events$$,null,null,'immutable time_events survives accidental grant: delete');
select throws_ok($$truncate public.time_events$$,null,null,'immutable time_events survives accidental grant: truncate');
reset role;
select * from finish();
rollback;
