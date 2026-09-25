-- KIO-H6-01: identification after code+PIN, one bound challenge per legal action.
begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_kiosk,fichaje_gateway;
insert into auth.users(id,email,email_confirmed_at) values
 ('81000000-0000-0000-0000-000000000001','kio6-owner@example.invalid',clock_timestamp()),
 ('81000000-0000-0000-0000-000000000002','kio6-device@example.invalid',clock_timestamp()),
 ('81000000-0000-0000-0000-000000000003','kio6-foreign@example.invalid',clock_timestamp()),
 ('81000000-0000-0000-0000-000000000004','kio6-device2@example.invalid',clock_timestamp());
select private.bootstrap_organization('82000000-0000-0000-0000-000000000001','Kiosk ID A','81000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('82000000-0000-0000-0000-000000000002','Kiosk ID B','81000000-0000-0000-0000-000000000003',gen_random_uuid());
insert into public.employees(id,organization_id,code,display_name) values
 ('84000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','a1','Synthetic A1'),
 ('84000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000001','a2','Synthetic A2'),
 ('84000000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000002','b1','Synthetic B1');
insert into public.work_policies(id,organization_id,version,timezone,break_counts_as_work,valid_from,created_by,created_at)
 select '83000000-0000-0000-0000-000000000001',organization_id,1,'Europe/Madrid',false,clock_timestamp()-interval '1 day',id,clock_timestamp()
 from public.memberships where organization_id='82000000-0000-0000-0000-000000000001';
insert into public.employee_policy_assignments(organization_id,employee_id,policy_id,effective_from,created_by,created_at)
 select organization_id,'84000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001',clock_timestamp()-interval '1 day',id,clock_timestamp()
 from public.memberships where organization_id='82000000-0000-0000-0000-000000000001';
insert into private.kiosk_devices(id,organization_id,auth_user_id,name,expires_at) values
 ('85000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','Device',clock_timestamp()+interval '1 day'),
 ('85000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000004','Device 2',clock_timestamp()+interval '1 day');
insert into private.kiosk_credentials(organization_id,employee_id,pin_hash,credential_version) values
 ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','$argon2id$v=19$m=19456,t=2,p=1$synthetic',1),
 ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002','$argon2id$v=19$m=19456,t=2,p=1$synthetic',1);
set constraints all immediate;

-- Entrypoint surface: exactly five gateway functions; the issuer that required
-- action/version before authentication no longer exists.
select is(array(select p.oid::regprocedure::text from pg_proc p where p.pronamespace in ('private'::regnamespace,'public'::regnamespace)
 and has_function_privilege('fichaje_gateway',p.oid,'EXECUTE') order by 1),
 array['private.kiosk_admin_apply(uuid,uuid,text,jsonb,jsonb)','private.kiosk_admin_prepare(uuid,uuid,text,jsonb)',
 'private.kiosk_auth_begin(uuid,uuid,text,text)','private.kiosk_auth_grant(uuid,uuid,text,bigint,text,jsonb)',
 'private.kiosk_record(uuid,uuid,time_action,bigint,uuid,text)'],'gateway executes only the five kiosk entrypoints');
select ok(to_regprocedure('private.kiosk_auth_finish(uuid,uuid,uuid,bigint,public.time_action,bigint,uuid,text,text)') is null,'single-action pre-authentication issuer removed');
select ok(not has_function_privilege('fichaje_gateway','private.kiosk_record_event(uuid,uuid,uuid,public.time_action,bigint,uuid,text)','EXECUTE'),'gateway cannot name the employee when recording');
select ok(not exists(select 1 from pg_proc where proname in ('kiosk_auth_grant','kiosk_record','kiosk_grant_scope','kiosk_lookup_scope')
 and (has_function_privilege('authenticated',oid,'EXECUTE') or has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('service_role',oid,'EXECUTE'))),'no client or service_role EXECUTE on identification');
select is((select array_agg(distinct pg_get_userbyid(proowner)::text) from pg_proc where proname in ('kiosk_grant_scope','kiosk_lookup_scope')),array['fichaje_guard'],'grant and lookup scopes minted only by guard');
select ok((select prosecdef from pg_proc where proname='kiosk_auth_grant') and (select prosecdef from pg_proc where proname='kiosk_record'),'entrypoints run as definer with fixed search_path');
select ok(not exists(select 1 from pg_class where relnamespace='private'::regnamespace and relname='kiosk_challenges' and (not relrowsecurity or not relforcerowsecurity)),'challenges keep FORCE RLS');

select set_config('request.jwt.claims','{"sub":"81000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select private.kiosk_auth_grant(null,null,null,null,null,null)$$,'42501',null,'device JWT cannot call identification directly');
select throws_ok($$select private.kiosk_record(null,null,null,null,null,null)$$,'42501',null,'device JWT cannot call record directly');
select throws_ok($$select private.kiosk_grant_scope(null,null,null)$$,'42501',null,'device JWT cannot mint grant scope');
select throws_ok($$select private.kiosk_lookup_scope(null,null)$$,'42501',null,'device JWT cannot mint lookup scope');
reset role;
set local role fichaje_gateway;
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001')$$,'42501',null,'gateway cannot mint grant scope');
select throws_ok($$select private.kiosk_record_event(null,null,null,null,null,null,null)$$,'42501',null,'gateway cannot call employee-named writer');
select throws_ok($$select private.kiosk_lookup_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001')$$,'42501',null,'gateway cannot mint lookup scope');
select throws_ok($$select * from private.kiosk_challenges$$,'42501',null,'gateway cannot read challenges');
reset role;

-- The device capability alone never reveals state, events or history.
set local role fichaje_kiosk;
select private.kiosk_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001',null,false);
select is((select count(*)::int from private.employee_state),0,'device scope: no employee state');
select is((select count(*)::int from public.time_events),0,'device scope: no events');
select is((select count(*)::int from public.work_sessions),0,'device scope: no sessions');
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000003')$$,'42501','FORBIDDEN','grant scope rejects foreign employee');
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000002','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000003')$$,'42501','FORBIDDEN','grant scope rejects foreign tenant');
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000002','84000000-0000-0000-0000-000000000001')$$,'42501','FORBIDDEN','grant scope rejects another device');
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001',null)$$,'42501','FORBIDDEN','grant scope requires one employee');
select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001');
select is((select array_agg(employee_id) from private.employee_state),array['84000000-0000-0000-0000-000000000001'::uuid],'grant scope reads exactly the verified employee state');
select is((select count(*)::int from public.time_events)+(select count(*)::int from public.work_sessions),0,'grant scope confers no events or history');
with changed as (update private.employee_state set version=99 returning *) select is((select count(*)::int from changed),0,'grant scope is read-only');
select throws_ok($$select private.kiosk_grant_scope('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002')$$,'42501','FORBIDDEN','a transaction cannot widen its grant to a second employee');
reset role;

-- Real SQL flow with the device identity (gateway verifies Argon2id in between).
select private.kiosk_auth_begin('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',repeat('e',64));
select throws_ok($$select private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',2,repeat('e',64),jsonb_build_array(repeat('1',64),repeat('2',64)))$$,'42501','FORBIDDEN','stale credential version cannot obtain challenges');
select throws_ok($$select private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','b1',1,repeat('e',64),jsonb_build_array(repeat('1',64),repeat('2',64)))$$,'42501','FORBIDDEN','code from another tenant resolves to nothing');
select throws_ok($$select private.kiosk_auth_grant('82000000-0000-0000-0000-000000000002','85000000-0000-0000-0000-000000000001','a1',1,repeat('e',64),jsonb_build_array(repeat('1',64),repeat('2',64)))$$,'42501','FORBIDDEN','grant requires the device scope tenant');
select throws_ok($$select private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',1,repeat('e',64),jsonb_build_array(repeat('1',64),repeat('1',64)))$$,'42501','FORBIDDEN','duplicate challenge hashes rejected');
create temporary table kio6(label text primary key,r jsonb) on commit drop;
insert into kio6 select 'out',private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',1,repeat('e',64),jsonb_build_array(repeat('1',64),repeat('2',64)));
select is((select array(select jsonb_object_keys(r) order by 1) from kio6 where label='out'),array['challenges','state','version'],'grant returns only state, version and challenges');
select is((select r->>'state' from kio6 where label='out'),'OUT','authoritative state OUT');
select is((select (r->>'version')::bigint from kio6 where label='out'),(select version from private.employee_state where employee_id='84000000-0000-0000-0000-000000000001'),'authoritative version');
select is((select array(select x->>'action' from jsonb_array_elements(r->'challenges') x) from kio6 where label='out'),array['CLOCK_IN'],'OUT offers only CLOCK_IN');
select ok((select bool_and(c.organization_id='82000000-0000-0000-0000-000000000001' and c.device_id='85000000-0000-0000-0000-000000000001'
 and c.employee_id='84000000-0000-0000-0000-000000000001' and c.action='CLOCK_IN' and c.expected_version=0 and c.credential_version=1
 and c.request_id=(k.r->'challenges'->0->>'request_id')::uuid and c.token_hash=repeat('1',64) and c.grant_id is not null
 and c.expires_at-c.created_at=interval '60 seconds' and c.used_at is null) from private.kiosk_challenges c, kio6 k where k.label='out' and c.token_hash=repeat('1',64)),
 'challenge bound to tenant, device, employee, action, version, own request, credential and 60 s TTL');
select is((select count(*)::int from private.kiosk_challenges where token_hash=repeat('2',64)),0,'unused candidate hash is never stored');
-- Before any clock capability exists in this transaction, so only the tuple can reject it.
select throws_ok($$select private.kiosk_record_event('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002','CLOCK_IN',0,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='out'),repeat('1',64))$$,'42501','FORBIDDEN','challenge rejects another employee');
select is(private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','CLOCK_IN',0,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='out'),repeat('1',64))->>'state','WORKING','bound challenge records through the H2 engine');

select private.kiosk_auth_begin('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',repeat('e',64));
insert into kio6 select 'working',private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',1,repeat('e',64),jsonb_build_array(repeat('3',64),repeat('4',64)));
select is((select r->>'state'||'/'||(r->>'version') from kio6 where label='working'),'WORKING/1','authoritative WORKING and advanced version');
select is((select array(select x->>'action' from jsonb_array_elements(r->'challenges') x) from kio6 where label='working'),array['BREAK_START','CLOCK_OUT'],'WORKING offers BREAK_START and CLOCK_OUT');
select is((select count(distinct grant_id)::int||'/'||count(distinct request_id)||'/'||count(distinct token_hash) from private.kiosk_challenges where token_hash in (repeat('3',64),repeat('4',64))),'1/2/2','siblings share one grant with independent requests and secrets');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','CLOCK_OUT',1,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='working'),repeat('3',64))$$,'42501','FORBIDDEN','challenge rejects another action');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','BREAK_START',0,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='working'),repeat('3',64))$$,'42501','FORBIDDEN','challenge rejects another version');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','BREAK_START',1,
 (select (r->'challenges'->1->>'request_id')::uuid from kio6 where label='working'),repeat('3',64))$$,'42501','FORBIDDEN','challenge rejects its sibling request');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000002','BREAK_START',1,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='working'),repeat('3',64))$$,'42501','FORBIDDEN','challenge rejects another device');
insert into kio6 select 'paused',private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','BREAK_START',1,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='working'),repeat('3',64));
select is((select r->>'state' from kio6 where label='paused'),'PAUSED','first sibling executes');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','CLOCK_OUT',1,
 (select (r->'challenges'->1->>'request_id')::uuid from kio6 where label='working'),repeat('4',64))$$,'42501','FORBIDDEN','executing one challenge consumes its sibling');
select is((select count(*)::int from public.time_events where employee_id='84000000-0000-0000-0000-000000000001'),2,'sibling never produces a second event');
select is(private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','BREAK_START',1,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='working'),repeat('3',64)),(select r from kio6 where label='paused'),'executed challenge only recovers its exact receipt');

select private.kiosk_auth_begin('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',repeat('e',64));
insert into kio6 select 'pausedgrant',private.kiosk_auth_grant('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','a1',1,repeat('e',64),jsonb_build_array(repeat('5',64),repeat('6',64)));
select is((select r->>'state'||'/'||(r->>'version') from kio6 where label='pausedgrant'),'PAUSED/2','authoritative PAUSED and version');
select is((select array(select x->>'action' from jsonb_array_elements(r->'challenges') x) from kio6 where label='pausedgrant'),array['BREAK_END','CLOCK_OUT'],'PAUSED offers BREAK_END and CLOCK_OUT');
update private.kiosk_challenges set created_at=statement_timestamp()-interval '61 seconds',expires_at=statement_timestamp()-interval '1 second' where token_hash=repeat('5',64);
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','BREAK_END',2,
 (select (r->'challenges'->0->>'request_id')::uuid from kio6 where label='pausedgrant'),repeat('5',64))$$,'42501','FORBIDDEN','expired challenge rejected');
select throws_ok($$select private.kiosk_record('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','CLOCK_OUT',2,
 gen_random_uuid(),repeat('9',64))$$,'42501','FORBIDDEN','unknown challenge rejected');
select throws_ok($$insert into private.kiosk_challenges(organization_id,device_id,employee_id,action,expected_version,request_id,token_hash,credential_version,grant_id)
 select organization_id,device_id,employee_id,action,expected_version,gen_random_uuid(),repeat('7',64),credential_version,grant_id from private.kiosk_challenges where token_hash=repeat('6',64)$$,
 '23505',null,'a grant holds at most one challenge per action');
select throws_ok($$insert into private.kiosk_challenges(organization_id,device_id,employee_id,action,expected_version,request_id,token_hash,credential_version)
 values('82000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','CLOCK_OUT',2,gen_random_uuid(),repeat('8',64),1)$$,
 '23514',null,'no challenge outside a grant');
select * from finish();
rollback;
