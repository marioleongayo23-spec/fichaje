begin;
set local search_path=public,extensions;
select no_plan();
grant usage on schema extensions to authenticated,anon,fichaje_clock,fichaje_correction,fichaje_writer,
 fichaje_ops_monitor,fichaje_ops_reviewer,fichaje_ops_repairer;
-- OPS-02 fixtures: two synthetic tenants driven through the real H1-H3 RPCs.
insert into auth.users(id,email,email_confirmed_at) values
 ('a1000000-0000-0000-0000-000000000001','ops-owner-a@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000002','ops-worker-a@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000003','ops-admin-a@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000004','ops-owner-b@example.invalid',clock_timestamp());
select private.bootstrap_organization('a2000000-0000-0000-0000-000000000001','Ops A','a1000000-0000-0000-0000-000000000001',gen_random_uuid());
select private.bootstrap_organization('a2000000-0000-0000-0000-000000000002','Ops B','a1000000-0000-0000-0000-000000000004',gen_random_uuid());
insert into public.memberships(id,organization_id,auth_user_id,role) values
 ('a3000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','EMPLOYEE'),
 ('a3000000-0000-0000-0000-000000000003','a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','ADMIN');
insert into public.employees(id,organization_id,code,display_name,membership_id) values
 ('a4000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000001','ops-worker','Synthetic worker','a3000000-0000-0000-0000-000000000002');
insert into public.employees(id,organization_id,code,display_name,membership_id)
select 'a4000000-0000-0000-0000-000000000003',organization_id,'ops-foreign','Synthetic foreign',id from public.memberships
 where auth_user_id='a1000000-0000-0000-0000-000000000004';
set constraints all immediate;

select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select public.create_work_policy('a2000000-0000-0000-0000-000000000001','a5000000-0000-0000-0000-000000000001','Europe/Madrid',false);
select public.assign_work_policy('a2000000-0000-0000-0000-000000000001','a5000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000002',
 (select id from public.work_policies where organization_id='a2000000-0000-0000-0000-000000000001'));
reset role;
delete from private.mutation_context;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000004","role":"authenticated"}',true);
set local role authenticated;
select public.create_work_policy('a2000000-0000-0000-0000-000000000002','a5000000-0000-0000-0000-000000000003','Atlantic/Canary',true);
select public.assign_work_policy('a2000000-0000-0000-0000-000000000002','a5000000-0000-0000-0000-000000000004','a4000000-0000-0000-0000-000000000003',
 (select id from public.work_policies where organization_id='a2000000-0000-0000-0000-000000000002'));
reset role;
delete from private.mutation_context;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000004","role":"authenticated"}',true);
set local role authenticated;
select public.record_time_event('a2000000-0000-0000-0000-000000000002','a6000000-0000-0000-0000-000000000009','a4000000-0000-0000-0000-000000000003','CLOCK_IN',0);
reset role;
delete from private.mutation_context;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select public.record_time_event('a2000000-0000-0000-0000-000000000001','a6000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','CLOCK_IN',0);
select public.record_time_event('a2000000-0000-0000-0000-000000000001','a6000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000002','BREAK_START',1);
select public.record_time_event('a2000000-0000-0000-0000-000000000001','a6000000-0000-0000-0000-000000000003','a4000000-0000-0000-0000-000000000002','BREAK_END',2);
select public.record_time_event('a2000000-0000-0000-0000-000000000001','a6000000-0000-0000-0000-000000000004','a4000000-0000-0000-0000-000000000002','CLOCK_OUT',3);
reset role;
delete from private.mutation_context;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select public.submit_correction('a2000000-0000-0000-0000-000000000001','a7000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002',4,
 'Synthetic correction',(select jsonb_build_array(jsonb_build_object('operation','REPLACE','target_event_id',e.id,'session_id',e.session_id,
  'event_type','CLOCK_OUT','effective_at',to_char(e.server_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'timezone','Europe/Madrid','ordinal',4))
  from public.time_events e where e.organization_id='a2000000-0000-0000-0000-000000000001' and e.employee_id='a4000000-0000-0000-0000-000000000002' and e.sequence=4));
reset role;
delete from private.mutation_context;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select public.decide_correction('a2000000-0000-0000-0000-000000000001','a7000000-0000-0000-0000-000000000002',
 (select id from public.correction_requests where organization_id='a2000000-0000-0000-0000-000000000001'),'APPROVE','Synthetic independent approval');
reset role;
delete from private.mutation_context;

-- OBS-07: least privilege of every technical identity.
select ok(not exists(select 1 from pg_roles where rolname like 'fichaje\_ops%'
 and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb)),'OPS roles are NOLOGIN, NOINHERIT and NOBYPASSRLS');
select is((select count(*)::int from pg_roles where rolname like 'fichaje\_ops%'),6,'exactly six OPS roles exist');
select ok(not exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname like 'fichaje\_ops%'),'OPS roles inherit no other role');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where relnamespace='private'::regnamespace and relname like 'ops\_%' and relkind='r'),
 'every OPS table forces RLS');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join unnest(array['fichaje_ops_monitor','fichaje_ops_reviewer','fichaje_ops_repairer']) r(name)
 where n.nspname in ('public','private') and c.relkind in ('r','v','m','p')
 and (has_table_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE'))),
 'operator entry roles hold no table or column privilege at all');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private')
 and c.relkind='r' and c.relname not like 'ops\_%' and (has_table_privilege('fichaje_ops',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
 or has_any_column_privilege('fichaje_ops',c.oid,'INSERT,UPDATE'))),'read-only definer cannot write any business table');
select ok(not has_column_privilege('fichaje_ops','public.employees','display_name','SELECT') and not has_column_privilege('fichaje_ops','public.employees','code','SELECT')
 and not has_column_privilege('fichaje_ops','public.correction_requests','reason','SELECT') and not has_column_privilege('fichaje_ops','public.correction_decisions','reason','SELECT')
 and not has_any_column_privilege('fichaje_ops','private.kiosk_credentials','SELECT') and not has_column_privilege('fichaje_ops','private.kiosk_challenges','token_hash','SELECT')
 and not has_any_column_privilege('fichaje_ops','private.invitations','SELECT') and not has_column_privilege('fichaje_ops','private.export_jobs','snapshot','SELECT')
 and not has_column_privilege('fichaje_ops','private.idempotency_records','payload_sha256','SELECT'),
 'definer never reads names, codes, reasons, credentials, challenges, invitations or export content');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'
 and c.relname not in ('employee_state','audit_log','organizations','ops_projection_repairs','ops_repair_context')
 and (has_table_privilege('fichaje_ops_repair',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege('fichaje_ops_repair',c.oid,'INSERT,UPDATE'))),
 'repair definer writes only the projection, its evidence and audit');
select ok(not has_table_privilege('fichaje_ops_repair','public.audit_log','UPDATE,DELETE,TRUNCATE') and not has_table_privilege('fichaje_ops_repair','private.employee_state','INSERT,DELETE,TRUNCATE')
 and not has_column_privilege('fichaje_ops_repair','private.employee_state','employee_id','UPDATE') and not has_column_privilege('fichaje_ops_repair','private.employee_state','organization_id','UPDATE'),
 'repair cannot delete projections, move them between tenants or rewrite audit');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like 'ops\_%'
 and p.proname<>'ops_ingest_client_metrics' and (has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('anon',p.oid,'EXECUTE')
 or has_function_privilege('service_role',p.oid,'EXECUTE'))),'no API role can execute technical OPS functions');
select ok(has_function_privilege('authenticated','public.ops_ingest_client_metrics(text,jsonb)','EXECUTE')
 and not has_function_privilege('anon','public.ops_ingest_client_metrics(text,jsonb)','EXECUTE')
 and not has_function_privilege('service_role','public.ops_ingest_client_metrics(text,jsonb)','EXECUTE'),'only authenticated clients add aggregated telemetry');
select is(pg_get_function_result('private.ops_invariant_summary()'::regprocedure),'TABLE(invariant text, severity text, findings bigint, tenants bigint)',
 'routine monitor output carries counts only, no identifiers');

-- OBS-05 on coherent history, including an approved correction.
set local role fichaje_ops_reviewer;
select is((select count(*)::int from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000001') where severity='CRITICAL'),0,
 'coherent tenant has no critical invariant finding');
select is((select status from private.ops_projection_candidates('a2000000-0000-0000-0000-000000000001') where employee_id='a4000000-0000-0000-0000-000000000002'),'MATCH',
 'projection equals replay of originals plus approved adjustments');
select is((select (candidate->>'version')::int from private.ops_projection_candidates('a2000000-0000-0000-0000-000000000001') where employee_id='a4000000-0000-0000-0000-000000000002'),5,
 'derived version counts four originals plus one approval');
select ok(exists(select 1 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002') where invariant='OPEN_SESSIONS' and severity='INFO'),
 'open session reported, never closed');
select ok(not exists(select 1 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002') where organization_id<>'a2000000-0000-0000-0000-000000000002'),
 'tenant detail never includes another tenant');
select throws_ok($$select * from private.ops_invariant_findings(null)$$,'22023','INVALID_INPUT','detail requires an explicit tenant');
reset role;
select is((select state::text from private.employee_state where employee_id='a4000000-0000-0000-0000-000000000003'),'WORKING','open session untouched by the checker');

-- Snapshot of the immutable history and exact projection before synthetic drift.
create temporary table ops_projection_before on commit drop as
 select * from private.employee_state where employee_id='a4000000-0000-0000-0000-000000000002';
create temporary table ops_history_before on commit drop as select
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.time_events t where t.organization_id in ('a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002')) as originals,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.work_sessions t where t.organization_id in ('a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002')) as sessions,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.event_adjustments t where t.organization_id='a2000000-0000-0000-0000-000000000001') as adjustments,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.correction_decisions t where t.organization_id='a2000000-0000-0000-0000-000000000001') as decisions,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.correction_requests t where t.organization_id='a2000000-0000-0000-0000-000000000001') as requests,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.audit_log t where t.organization_id='a2000000-0000-0000-0000-000000000001' and t.action<>'rebuild_projection') as audit,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.key)) from private.idempotency_records t where t.organization_id='a2000000-0000-0000-0000-000000000001') as receipts;
create temporary view ops_history_now as select
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.time_events t where t.organization_id in ('a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002')) as originals,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.work_sessions t where t.organization_id in ('a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002')) as sessions,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.event_adjustments t where t.organization_id='a2000000-0000-0000-0000-000000000001') as adjustments,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.correction_decisions t where t.organization_id='a2000000-0000-0000-0000-000000000001') as decisions,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.correction_requests t where t.organization_id='a2000000-0000-0000-0000-000000000001') as requests,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.id)) from public.audit_log t where t.organization_id='a2000000-0000-0000-0000-000000000001' and t.action<>'rebuild_projection') as audit,
 (select md5(string_agg(row_to_json(t)::text,'' order by t.key)) from private.idempotency_records t where t.organization_id='a2000000-0000-0000-0000-000000000001') as receipts;

-- Synthetic projection drift (privileged fixture write in this rolled-back test).
update private.employee_state set state='WORKING',version=4,
 open_session_id=(select session_id from public.time_events where employee_id='a4000000-0000-0000-0000-000000000002' and sequence=1)
 where employee_id='a4000000-0000-0000-0000-000000000002';
set local role fichaje_ops_reviewer;
select ok(exists(select 1 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000001') where invariant='PROJECTION_DRIFT' and severity='CRITICAL'
 and subject_id='a4000000-0000-0000-0000-000000000002' and (detail->>'repairable')::boolean and detail->'fields' ?& array['state','open_session_id','version']),
 'drift detected with exact field codes and marked repairable');
select is((select status from private.ops_projection_candidates('a2000000-0000-0000-0000-000000000001') where employee_id='a4000000-0000-0000-0000-000000000002'),'DRIFT',
 'candidate compares projection against immutable sources');
reset role;
set local role fichaje_ops_monitor;
select ok((select findings from private.ops_invariant_summary() where invariant='PROJECTION_DRIFT' and severity='CRITICAL')>=1,'aggregated monitor signal raised');
select throws_ok($$select * from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000001')$$,'42501',null,'routine monitor cannot read tenant detail');
select throws_ok($$select private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002',gen_random_uuid(),'x')$$,'42501',null,
 'routine monitor cannot repair');
select throws_ok($$select count(*) from public.time_events$$,'42501',null,'monitor has no labour table access');
select throws_ok($$select count(*) from private.employee_state$$,'42501',null,'monitor has no projection access');
reset role;
select ok((select b.originals=n.originals and b.sessions=n.sessions and b.adjustments=n.adjustments and b.decisions=n.decisions and b.requests=n.requests
 and b.audit=n.audit and b.receipts=n.receipts from ops_history_before b, ops_history_now n),'checking never mutates history, audit or receipts');

-- RES-03: authorized rebuild of the projection only.
set local role fichaje_ops_repairer;
select is(private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','a8000000-0000-0000-0000-000000000001','PGTAP-AUTH-1')->>'outcome',
 'APPLIED','authorized rebuild applies the derived projection');
reset role;
select is((select row_to_json(s)::text from private.employee_state s where employee_id='a4000000-0000-0000-0000-000000000002'),
 (select row_to_json(p)::text from ops_projection_before p),'rebuild restores exactly the pre-drift projection');
select ok((select b.originals=n.originals and b.sessions=n.sessions and b.adjustments=n.adjustments and b.decisions=n.decisions and b.requests=n.requests
 and b.audit=n.audit and b.receipts=n.receipts from ops_history_before b, ops_history_now n),'rebuild leaves originals, corrections, adjustments, audit and receipts byte-identical');
select is((select count(*)::int from public.audit_log where action='rebuild_projection' and employee_id='a4000000-0000-0000-0000-000000000002'
 and actor_kind='SYSTEM' and request_id='a8000000-0000-0000-0000-000000000001'),1,'rebuild audited in the same transaction');
select is((select outcome from private.ops_projection_repairs where request_id='a8000000-0000-0000-0000-000000000001'),'APPLIED','operational evidence recorded');
set local role fichaje_ops_repairer;
select is(private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','a8000000-0000-0000-0000-000000000001','PGTAP-AUTH-1')->>'replayed',
 'true','same request replays the recorded outcome');
select throws_ok($$select private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','a8000000-0000-0000-0000-000000000001','OTHER')$$,
 '22023','IDEMPOTENCY_CONFLICT','same request with another authorization conflicts');
select is(private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','a8000000-0000-0000-0000-000000000002','PGTAP-AUTH-2')->>'outcome',
 'NOOP','second execution is a no-op');
select throws_ok($$select private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000003',gen_random_uuid(),'PGTAP-X')$$,
 '42501','FORBIDDEN','an employee of another tenant cannot be rebuilt through this tenant');
select throws_ok($$update private.employee_state set version=0$$,'42501',null,'repair operator has no direct projection write');
reset role;
select is((select count(*)::int from public.audit_log where action='rebuild_projection' and employee_id='a4000000-0000-0000-0000-000000000002'),1,'no-op and replay add no audit');

-- Immutable-evidence tampering is detected against the recorded baseline and
-- blocks automatic repair; the projection is left for human review.
set local role fichaje_ops_monitor;
select ok((private.ops_record_invariant_run()->>'run_id') is not null,'monitor records an evidence run');
reset role;
select ok(exists(select 1 from private.ops_original_baselines where employee_id='a4000000-0000-0000-0000-000000000002' and max_sequence=4),
 'baseline recorded for coherent originals');
select throws_ok($$update private.ops_invariant_runs set critical=0$$,'42501','IMMUTABLE','operational evidence is append-only');
alter table public.time_events disable trigger immutable;
update public.time_events set actor_membership_id=(select id from public.memberships where organization_id='a2000000-0000-0000-0000-000000000001' and role='OWNER')
 where employee_id='a4000000-0000-0000-0000-000000000002' and sequence=2;
alter table public.time_events enable trigger immutable;
update private.employee_state set version=4 where employee_id='a4000000-0000-0000-0000-000000000002';
set local role fichaje_ops_reviewer;
select ok(exists(select 1 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000001') where invariant='ORIGINAL_IMMUTABLE'
 and detail->>'reason'='ORIGINAL_DIGEST_MISMATCH'),'altered original detected against its baseline');
reset role;
set local role fichaje_ops_repairer;
select is(private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002','a8000000-0000-0000-0000-000000000003','PGTAP-AUTH-3')->>'outcome',
 'BLOCKED','incoherent immutable source blocks automatic repair');
reset role;
select is((select version from private.employee_state where employee_id='a4000000-0000-0000-0000-000000000002'),4::bigint,'blocked repair leaves the projection untouched');
alter table public.audit_log disable trigger audit_immutable;
set local role fichaje_ops_monitor;
select ok(exists(select 1 from private.ops_invariant_summary() where invariant='IMMUTABILITY_GUARD' and severity='CRITICAL'),'disabled append-only guard detected');
reset role;
alter table public.audit_log enable trigger audit_immutable;

-- Baselines never advance while a structural guard is compromised.
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000004","role":"authenticated"}',true);
set local role authenticated;
select public.record_time_event('a2000000-0000-0000-0000-000000000002','a6000000-0000-0000-0000-000000000010','a4000000-0000-0000-0000-000000000003','BREAK_START',1);
select public.record_time_event('a2000000-0000-0000-0000-000000000002','a6000000-0000-0000-0000-000000000011','a4000000-0000-0000-0000-000000000003','BREAK_END',2);
select public.record_time_event('a2000000-0000-0000-0000-000000000002','a6000000-0000-0000-0000-000000000012','a4000000-0000-0000-0000-000000000003','CLOCK_OUT',3);
select public.record_time_event('a2000000-0000-0000-0000-000000000002','a6000000-0000-0000-0000-000000000013','a4000000-0000-0000-0000-000000000003','CLOCK_IN',4);
reset role;
delete from private.mutation_context;
alter table public.time_events disable trigger immutable;
set local role fichaje_ops_monitor;
select is((private.ops_record_invariant_run()->>'baselines_frozen')::boolean,true,'a disabled append-only guard freezes every baseline');
reset role;
select ok(not exists(select 1 from private.ops_original_baselines where employee_id='a4000000-0000-0000-0000-000000000003' and max_sequence=5),
 'no baseline advances while a structural guard is compromised');
alter table public.time_events enable trigger immutable;
set local role fichaje_ops_monitor;
select is((private.ops_record_invariant_run()->>'baselines_frozen')::boolean,false,'restored guard unfreezes baselines');
reset role;
select ok(exists(select 1 from private.ops_original_baselines where employee_id='a4000000-0000-0000-0000-000000000003' and max_sequence=5),
 'baselines advance again once every guard is back');

-- A replayed purge (tenant-only evidence) never marks unrelated employees as purged.
insert into private.recovery_applied(id,organization_id,kind) values('a9000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002','PURGE');
select ok(not private.ops_history_purged('a2000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000003'),
 'a replayed tenant purge does not cover an employee whose history starts at sequence 1');
alter table public.time_events disable trigger immutable;
delete from public.time_events where employee_id='a4000000-0000-0000-0000-000000000003' and sequence=3;
alter table public.time_events enable trigger immutable;
select ok(not private.ops_history_purged('a2000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000003'),
 'an internal gap is never taken for a purge');
set local role fichaje_ops_reviewer;
select ok(exists(select 1 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002') where invariant='SEQUENCE_CONTIGUOUS' and severity='CRITICAL'),
 'the gap stays a critical finding in a tenant with a replayed purge');
select ok((select bool_and(severity='CRITICAL') from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002') where invariant='RECEIPT_WITHOUT_EVENT'),
 'a receipt newer than every recorded purge cutoff stays critical');
reset role;
alter table public.time_events disable trigger immutable;
delete from public.time_events where employee_id='a4000000-0000-0000-0000-000000000003' and sequence in (1,2,4);
alter table public.time_events enable trigger immutable;
select ok(private.ops_history_purged('a2000000-0000-0000-0000-000000000002','a4000000-0000-0000-0000-000000000003'),
 'whole sessions removed from the start with a contiguous remainder match a replayed purge');
insert into private.retention_runs(organization_id,cutoff,authorization_ref,counts,digest)
 values('a2000000-0000-0000-0000-000000000002',clock_timestamp(),'REPLAY:a9000000-0000-0000-0000-000000000001','{"time_events":4}',repeat('0',64));
set local role fichaje_ops_reviewer;
select ok((select bool_and(severity='INFO') and count(*)=4 from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002') where invariant='RECEIPT_WITHOUT_EVENT'),
 'receipts older than a recorded labour purge cutoff are informational');
reset role;

-- OBS-02 client telemetry: aggregated, bounded labels, write-only for clients.
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics('pgtap.1','[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":2,"sum_ms":150.5,"buckets":[1,1,0,0,0,0,0,0,0,0]}]')->>'accepted',
 '1','authenticated client adds aggregated counters');
select public.ops_ingest_client_metrics('pgtap.1','[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":1,"sum_ms":40,"buckets":[1,0,0,0,0,0,0,0,0,0]}]');
select throws_ok($$select public.ops_ingest_client_metrics('pgtap.1','[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0],"employee_id":"a4000000-0000-0000-0000-000000000002"}]')$$,
 '22023','INVALID_INPUT','identifiers cannot be attached to telemetry');
select throws_ok($$select public.ops_ingest_client_metrics('pgtap.1','[{"operation":"a4000000-0000-0000-0000-000000000002","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','unbounded label values rejected');
select throws_ok($$select public.ops_ingest_client_metrics('pgtap.1','[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":2,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','inconsistent histogram rejected');
select throws_ok($$select public.ops_ingest_client_metrics('ops@example.invalid','[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','release label cannot carry arbitrary text');
select throws_ok($$select count(*) from private.ops_client_metrics$$,'42501',null,'clients cannot read telemetry tables');
select throws_ok($$select * from private.ops_client_metrics_snapshot(null)$$,'42501',null,'clients cannot read telemetry through OPS functions');
reset role;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select * from private.ops_invariant_summary()$$,'42501',null,'OWNER has no technical telemetry access');
select throws_ok($$select * from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002')$$,'42501',null,'OWNER of tenant A cannot read tenant B findings');
select throws_ok($$select private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002',gen_random_uuid(),'x')$$,'42501',null,
 'OWNER cannot trigger repairs');
reset role;
select set_config('request.jwt.claims','',true);
set local role anon;
select throws_ok($$select public.ops_ingest_client_metrics('pgtap.1','[]')$$,'42501',null,'anonymous callers cannot ingest');
reset role;
set local role fichaje_ops_monitor;
select is((select sum(requests)::int from private.ops_client_metrics_snapshot(null) where release='pgtap.1' and operation='clock.CLOCK_IN'),3,
 'aggregation sums counters without identities');
select is((select array_agg(s order by i) from (select u.i,sum(u.b)::bigint as s from private.ops_client_metrics_snapshot(null) m,
 unnest(m.duration_buckets) with ordinality u(b,i) where m.release='pgtap.1' group by u.i) x),array[2,1,0,0,0,0,0,0,0,0]::bigint[],'histogram buckets aggregate element-wise');
select ok((private.ops_db_health()->>'status')='UP' and (private.ops_db_health()->>'max_connections')::int>0,'database health exposes only saturation counters');
reset role;
select * from finish();
rollback;
