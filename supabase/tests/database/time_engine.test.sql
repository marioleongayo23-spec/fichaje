begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to fichaje_writer;
insert into auth.users(id,email,email_confirmed_at) values
 ('11111111-1111-1111-1111-111111111111','h2-a@example.invalid',clock_timestamp()),
 ('22222222-2222-2222-2222-222222222222','h2-b@example.invalid',clock_timestamp());
select private.bootstrap_organization('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A','11111111-1111-1111-1111-111111111111',gen_random_uuid());
select private.bootstrap_organization('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B','22222222-2222-2222-2222-222222222222',gen_random_uuid());
insert into public.employees(id,organization_id,code,display_name,membership_id)
select 'aaaaaaaa-1111-1111-1111-111111111111',organization_id,'A','A',id from public.memberships where organization_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
insert into public.employees(id,organization_id,code,display_name,membership_id)
select 'bbbbbbbb-1111-1111-1111-111111111111',organization_id,'B','B',id from public.memberships where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
set constraints all immediate;
select is((select count(*)::int from private.employee_state),2,'state created with employee in same transaction');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relname in ('work_policies','employee_policy_assignments','work_sessions','time_events','employee_state')
 and n.nspname in ('public','private') and not(c.relrowsecurity and c.relforcerowsecurity)),'H2 all tenant tables FORCE RLS');
select lives_ok($$select private.check_clock('2026-01-01Z','2026-01-01Z')$$,'TIME-04 equality permitted by production guard');
select throws_ok($$select private.check_clock('2026-01-02Z','2026-01-01Z')$$,'22023','CLOCK_REGRESSION','TIME-05 regression rejected by production guard');
select lives_ok($$select private.check_clock(null,'2026-01-01Z')$$,'first event has no predecessor');
-- No replacement of clock_timestamp, RPC body, RLS predicate or machine under test.
-- Historical fixtures below use real timestamptz and IANA zone database in PostgreSQL.
select is(extract(epoch from ('2026-03-30 00:00 Europe/Madrid'::timestamptz-'2026-03-29 00:00 Europe/Madrid'::timestamptz))::int,82800,'TIME-03 Madrid spring day 23h');
select is(extract(epoch from ('2026-10-26 00:00 Europe/Madrid'::timestamptz-'2026-10-25 00:00 Europe/Madrid'::timestamptz))::int,90000,'TIME-03 Madrid autumn day 25h');
select is(extract(epoch from ('2026-03-30 00:00 Atlantic/Canary'::timestamptz-'2026-03-29 00:00 Atlantic/Canary'::timestamptz))::int,82800,'TIME-03 Canary spring day 23h');
select is(extract(epoch from ('2026-10-26 00:00 Atlantic/Canary'::timestamptz-'2026-10-25 00:00 Atlantic/Canary'::timestamptz))::int,90000,'TIME-03 Canary autumn day 25h');
select is(('2026-06-01 23:30Z'::timestamptz at time zone 'Europe/Madrid')::date,'2026-06-02'::date,'TIME-02 Madrid local entry date');
select is(('2026-06-01 22:30Z'::timestamptz at time zone 'Atlantic/Canary')::date,'2026-06-01'::date,'TIME-02 Canary differs at local midnight');
select is(extract(epoch from ('2026-10-25 02:30+01'::timestamptz-'2026-10-25 02:30+02'::timestamptz))::int,3600,'TIME-03 repeated local hour still ordered in UTC');
select is(extract(epoch from ('2026-03-29 03:30+02'::timestamptz-'2026-03-29 01:30+01'::timestamptz))::int,3600,'TIME-03 spring skipped hour not worked');

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}',true);
set local role authenticated;
select public.create_work_policy('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000001','Europe/Madrid',false);
select public.assign_work_policy('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000002','aaaaaaaa-1111-1111-1111-111111111111',(select id from public.work_policies limit 1));
select public.record_time_event('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','10000000-0000-0000-0000-000000000003','aaaaaaaa-1111-1111-1111-111111111111','CLOCK_IN',0);
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501',null,'IMM-01 client UPDATE denied');
select throws_ok($$delete from public.time_events$$,'42501',null,'IMM-01 client DELETE denied');
select throws_ok($$truncate public.time_events$$,'42501',null,'IMM-01 client TRUNCATE denied');
select throws_ok($$select * from private.employee_state$$,'42501',null,'state projection private');
select throws_ok($$select public.record_time_event('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',gen_random_uuid(),'bbbbbbbb-1111-1111-1111-111111111111','CLOCK_IN',0)$$,'42501','FORBIDDEN','cross tenant RPC denied');
reset role;
set local role fichaje_writer;
select is((select count(*)::int from private.employee_state),1,'SEC-H2 writer sees only bound tenant projection');
select is((select count(*)::int from public.time_events),1,'SEC-H2 writer sees only bound tenant event');
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501',null,'IMM-01 technical writer UPDATE denied');
select throws_ok($$delete from public.time_events$$,'42501',null,'IMM-01 technical writer DELETE denied');
select throws_ok($$truncate public.time_events$$,'42501',null,'IMM-01 technical writer TRUNCATE denied');
select throws_ok($$insert into private.employee_state(organization_id,employee_id) values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-1111-1111-1111-111111111111')$$,'42501',null,'SEC-H2 foreign state INSERT rejected by RLS');
with changed as (update private.employee_state set version=99 where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' returning *)
 select is((select count(*)::int from changed),0,'SEC-H2 unfiltered technical mutation cannot reach foreign state');
select throws_ok($$update private.employee_state set organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,'42501',null,'SEC-H2 cannot move projection tenant');
select throws_ok($$insert into public.work_sessions(organization_id,employee_id,policy_id,timezone,created_at)
 values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-1111-1111-1111-111111111111',(select id from public.work_policies limit 1),'Europe/Madrid',clock_timestamp())$$,'23503',null,'H2 composite employee FK rejects foreign subject');
reset role;
-- Even an accidentally over-granted ordinary role cannot bypass immutable triggers.
grant update,delete,truncate on public.time_events to fichaje_writer;
set local role fichaje_writer;
select throws_ok($$update public.time_events set server_at=clock_timestamp()$$,'42501','IMMUTABLE','IMM trigger blocks technical UPDATE even with accidental grant');
select throws_ok($$delete from public.time_events$$,'42501','IMMUTABLE','IMM trigger blocks technical DELETE even with accidental grant');
select throws_ok($$truncate public.time_events$$,'42501','IMMUTABLE','IMM trigger blocks technical TRUNCATE even with accidental grant');
reset role;
revoke update,delete,truncate on public.time_events from fichaje_writer;
-- Empty capability cannot expose H2 data, even with forged GUC. Harness-only
-- context deletion is postgres and rolled back, never a production entry point.
delete from private.mutation_context where route='member';
set local role fichaje_writer;
select set_config('app.organization_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true);
select is((select count(*)::int from public.time_events),0,'SEC-H2 no context, forged GUC cannot read events');
select is((select count(*)::int from private.employee_state),0,'SEC-H2 no context cannot read state');
reset role;
-- Real stored historical sessions: equal timestamps and overnight paused exit.
-- Original rows are inserted as privileged synthetic fixtures, never edited.
insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at)
select 'aaaaaaaa-2222-2222-2222-222222222222',organization_id,'aaaaaaaa-1111-1111-1111-111111111111',id,timezone,'2026-03-28 23:00+01' from public.work_policies;
insert into public.time_events(organization_id,employee_id,session_id,sequence,event_type,server_at,actor_membership_id,source,request_id)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-1111-1111-1111-111111111111','aaaaaaaa-2222-2222-2222-222222222222',v.seq,v.action::public.time_action,v.t::timestamptz,m.id,'WEB',gen_random_uuid()
from (values(100,'CLOCK_IN','2026-03-28 23:00+01'),(101,'BREAK_START','2026-03-29 01:30+01'),(102,'CLOCK_OUT','2026-03-29 03:30+02')) v(seq,action,t)
join public.memberships m on m.organization_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is((select count(*)::int from public.time_events where session_id='aaaaaaaa-2222-2222-2222-222222222222' and event_type='BREAK_END'),0,'paused exit has no fabricated BREAK_END');
select is((select extract(epoch from(max(server_at)-min(server_at)))::int from public.time_events where session_id='aaaaaaaa-2222-2222-2222-222222222222'),12600,'TIME-02/03 overnight DST session has 3.5h gross, not 4.5h');
select is((select (created_at at time zone timezone)::date from public.work_sessions where id='aaaaaaaa-2222-2222-2222-222222222222'),'2026-03-28'::date,'overnight session belongs to local entry day');
with intervals as (select event_type,server_at,lead(server_at) over(order by sequence) as next_at from public.time_events where session_id='aaaaaaaa-2222-2222-2222-222222222222')
select is((select extract(epoch from sum(next_at-server_at) filter(where event_type='CLOCK_IN'))::int from intervals),9000,'paused exit: 2.5h working');
with intervals as (select event_type,server_at,lead(server_at) over(order by sequence) as next_at from public.time_events where session_id='aaaaaaaa-2222-2222-2222-222222222222')
select is((select extract(epoch from sum(next_at-server_at) filter(where event_type='BREAK_START'))::int from intervals),3600,'paused exit: pause ends at CLOCK_OUT, exactly 1h');
insert into public.time_events(organization_id,employee_id,session_id,sequence,event_type,server_at,actor_membership_id,source,request_id)
select organization_id,employee_id,session_id,103,'CLOCK_IN',server_at,actor_membership_id,source,gen_random_uuid() from public.time_events where sequence=102;
select is((select count(*)::int from public.time_events where session_id='aaaaaaaa-2222-2222-2222-222222222222' and server_at='2026-03-29 03:30+02'),2,'TIME-04 equal instants stored without timestamp uniqueness');
-- No scheduled close: projection represents an open prior-day session indefinitely.
update private.employee_state set state='PAUSED',open_session_id='aaaaaaaa-2222-2222-2222-222222222222',last_event_at='2026-03-29 01:30+01' where employee_id='aaaaaaaa-1111-1111-1111-111111111111';
set local role authenticated;
select is(public.get_employee_state('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-1111-1111-1111-111111111111')->>'incident','OPEN_SESSION','TIME-02 prior-day session remains open, no synthetic hours');
reset role;
select * from finish();
rollback;
