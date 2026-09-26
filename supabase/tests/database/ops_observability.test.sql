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
select ok(has_function_privilege('authenticated','public.ops_ingest_client_metrics(jsonb)','EXECUTE')
 and not has_function_privilege('anon','public.ops_ingest_client_metrics(jsonb)','EXECUTE')
 and not has_function_privilege('service_role','public.ops_ingest_client_metrics(jsonb)','EXECUTE'),'only authenticated clients add aggregated telemetry');
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
select is(public.ops_ingest_client_metrics('[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":2,"sum_ms":120.5,"buckets":[1,1,0,0,0,0,0,0,0,0]}]')->>'accepted',
 '1','authenticated client adds aggregated counters');
select public.ops_ingest_client_metrics('[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":1,"sum_ms":40,"buckets":[1,0,0,0,0,0,0,0,0,0]}]');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0],"employee_id":"a4000000-0000-0000-0000-000000000002"}]')$$,
 '22023','INVALID_INPUT','identifiers cannot be attached to telemetry');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"a4000000-0000-0000-0000-000000000002","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','unbounded label values rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"clock.CLOCK_IN","outcome":"success","error_class":"NONE","count":2,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','inconsistent histogram rejected');
select throws_ok($$select public.ops_ingest_client_metrics('ops@example.invalid','[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '42883',null,'SEC-OPS-01 a client cannot choose a release: the ingestion takes no release at all');
select throws_ok($$select count(*) from private.ops_client_metrics$$,'42501',null,'clients cannot read telemetry tables');
select throws_ok($$select * from private.ops_client_metrics_snapshot(null)$$,'42501',null,'clients cannot read telemetry through OPS functions');
select throws_ok($$select count(*) from private.ops_ingest_subjects$$,'42501',null,'SEC-OPS-01 clients cannot read quota state');
select throws_ok($$select count(*) from private.ops_ingest_limits$$,'42501',null,'SEC-OPS-01 clients cannot read the ingestion limits');
reset role;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select throws_ok($$select * from private.ops_invariant_summary()$$,'42501',null,'OWNER has no technical telemetry access');
select throws_ok($$select * from private.ops_invariant_findings('a2000000-0000-0000-0000-000000000002')$$,'42501',null,'OWNER of tenant A cannot read tenant B findings');
select throws_ok($$select private.ops_rebuild_projection('a2000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000002',gen_random_uuid(),'x')$$,'42501',null,
 'OWNER cannot trigger repairs');
select throws_ok($$select * from private.ops_ingest_windows$$,'42501',null,'SEC-OPS-01 OWNER cannot read quota windows');
reset role;
select set_config('request.jwt.claims','',true);
set local role anon;
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '42501',null,'anonymous callers cannot ingest');
reset role;
set local role fichaje_ops_monitor;
select is((select sum(requests)::int from private.ops_client_metrics_snapshot(null) where operation='clock.CLOCK_IN'),3,
 'aggregation sums counters without identities');
select is((select array_agg(s order by i) from (select u.i,sum(u.b)::bigint as s from private.ops_client_metrics_snapshot(null) m,
 unnest(m.duration_buckets) with ordinality u(b,i) group by u.i) x),array[2,1,0,0,0,0,0,0,0,0]::bigint[],'histogram buckets aggregate element-wise');
select ok((private.ops_db_health()->>'status')='UP' and (private.ops_db_health()->>'max_connections')::int>0,'database health exposes only saturation counters');
select throws_ok($$select count(*) from private.ops_ingest_subjects$$,'42501',null,'SEC-OPS-01 the monitor never sees quota pseudonyms');
reset role;

-- SEC-OPS-01: the server bounds ingestion; the browser's own limits are not a defence.
select is(pg_get_function_result('private.ops_client_metrics_snapshot(timestamptz)'::regprocedure),
 'TABLE(bucket_start timestamp with time zone, operation text, outcome text, error_class text, requests bigint, duration_sum_ms double precision, duration_buckets bigint[])',
 'SEC-OPS-01 client metrics carry no release, tenant, person or record dimension');
select is((select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_schema='private' and table_name='ops_client_metrics'),
 'bucket_start,operation,outcome,error_class,requests,duration_sum_ms,duration_buckets','SEC-OPS-01 the telemetry store has no release column');
select is((select array_agg(p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='ops_ingest_client_metrics'),
 array['ops_ingest_client_metrics(jsonb)'],'SEC-OPS-01 a single ingestion signature, without a client-chosen release');
select is((select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_schema='private' and table_name='ops_ingest_subjects'),
 'window_start,subject,attempts,events,series','SEC-OPS-01 quota rows hold a per-window pseudonym and counters only');
select ok((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c where c.oid in
 ('private.ops_ingest_limits'::regclass,'private.ops_ingest_windows'::regclass,'private.ops_ingest_subjects'::regclass)),'SEC-OPS-01 quota tables force RLS');
select ok(not exists(select 1 from unnest(array['anon','authenticated','service_role','fichaje_ops','fichaje_ops_monitor','fichaje_ops_reviewer','fichaje_ops_repairer']) r(role),
 unnest(array['private.ops_ingest_limits','private.ops_ingest_windows','private.ops_ingest_subjects']) t(tbl)
 where has_table_privilege(r.role,t.tbl,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')),'SEC-OPS-01 no API or OPS role reaches quota tables');
select ok(has_table_privilege('fichaje_ops_ingest','private.ops_ingest_limits','SELECT')
 and not has_table_privilege('fichaje_ops_ingest','private.ops_ingest_limits','INSERT,UPDATE,DELETE,TRUNCATE')
 and not has_table_privilege('fichaje_ops_ingest','private.ops_telemetry_vocabulary','INSERT,UPDATE,DELETE,TRUNCATE')
 and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r'
  and c.relname not in ('ops_client_metrics','ops_ingest_windows','ops_ingest_subjects')
  and (has_table_privilege('fichaje_ops_ingest',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege('fichaje_ops_ingest',c.oid,'INSERT,UPDATE'))),
 'SEC-OPS-01 the ingestion definer writes only aggregates and its own quota state; limits are read-only for it');
select is((select row(subject_calls,subject_events,subject_series,global_subjects,global_events,bucket_series,retention_days)::text from private.ops_ingest_limits),
 '(30,2000,200,5000,200000,1000,7)','SEC-OPS-01 default limits per identity, per window and per bucket');
-- Deterministic small limits for this transaction (rolled back).
update private.ops_ingest_limits set subject_calls=5,subject_events=1200,subject_series=120,global_subjects=6,global_events=3000,bucket_series=150;
insert into auth.users(id,email,email_confirmed_at) values
 ('a1000000-0000-0000-0000-000000000011','ops-abuse-a@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000012','ops-abuse-b@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000013','ops-abuse-c@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000014','ops-abuse-d@example.invalid',clock_timestamp()),
 ('a1000000-0000-0000-0000-000000000015','ops-abuse-e@example.invalid',clock_timestamp());
create temporary table sec_one as select '[{"operation":"rpc.classify_hours","outcome":"failure","error_class":"UPSTREAM_5XX","count":1,"sum_ms":60,"buckets":[0,1,0,0,0,0,0,0,0,0]}]'::jsonb as b;
create temporary table sec_series as
with combos as (select o.value as op,r.value as outcome,e.value as err,row_number() over(order by o.value,r.value,e.value) as n
 from private.ops_telemetry_vocabulary o,private.ops_telemetry_vocabulary r,private.ops_telemetry_vocabulary e
 where o.kind='operation' and r.kind='outcome' and e.kind='error_class' and o.value like 'kiosk.%')
select jsonb_agg(jsonb_build_object('operation',op,'outcome',outcome,'error_class',err,'count',1,'sum_ms',10,'buckets',jsonb_build_array(1,0,0,0,0,0,0,0,0,0)) order by n)
  filter(where n<=100) as hundred,
 jsonb_agg(jsonb_build_object('operation',op,'outcome',outcome,'error_class',err,'count',1,'sum_ms',10,'buckets',jsonb_build_array(1,0,0,0,0,0,0,0,0,0)) order by n)
  filter(where n<=101) as too_many
from combos;
grant select on sec_one,sec_series to authenticated;
create temporary table sec_results(label text,n integer,result jsonb);
grant insert,select on sec_results to authenticated;
create function pg_temp.sec_total() returns bigint language sql as $$
 select coalesce(sum(requests),0) from private.ops_client_metrics where operation='rpc.classify_hours' and outcome='failure' and error_class='UPSTREAM_5XX' $$;

-- Identity A: consecutive calls stop at its quota; rejected attempts still count.
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000011","role":"authenticated"}',true);
set local role authenticated;
insert into sec_results select 'a',g,public.ops_ingest_client_metrics(b) from sec_one,generate_series(1,8) g;
reset role;
select is((select array_agg(result order by n) from sec_results where label='a'),
 array_fill('{"accepted":1}'::jsonb,array[5])||array_fill('{"accepted":0,"limited":true}'::jsonb,array[3]),
 'SEC-OPS-01 one identity cannot exceed its call quota by repeating calls');
select is(pg_temp.sec_total(),5::bigint,'SEC-OPS-01 only the accepted calls reached the aggregates');
select is((select row(s.attempts,s.events,s.series)::text from private.ops_ingest_subjects s join private.ops_ingest_windows w using(window_start)
 where s.subject=encode(sha256(w.salt||convert_to('a1000000-0000-0000-0000-000000000011','UTF8')),'hex')),'(8,5,5)',
 'SEC-OPS-01 limited attempts are committed to the persistent quota');
select ok(not exists(select 1 from private.ops_ingest_subjects s where s.subject in ('a1000000-0000-0000-0000-000000000011',
 encode(sha256(convert_to('a1000000-0000-0000-0000-000000000011','UTF8')),'hex'),encode(sha256(convert_to('ops-abuse-a@example.invalid','UTF8')),'hex'))),
 'SEC-OPS-01 the quota key is neither the uid, nor its plain hash, nor the email');
-- Per-call bounds hold even for an identity already over quota (nothing is written).
set local role authenticated;
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":9999,"sum_ms":10,"buckets":[9999,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 count=9999 rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1001,"sum_ms":10,"buckets":[1001,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 more than 1000 events per series rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":999999999,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 a duration outside its bucket cannot inflate latency');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":120001,"buckets":[0,0,0,0,0,0,0,0,0,1]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 the open bucket is capped at 120 s');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":2,"sum_ms":0,"buckets":[0,2,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 a duration below its bucket cannot deflate latency');
select throws_ok($$select public.ops_ingest_client_metrics((select too_many from sec_series))$$,'22023','INVALID_INPUT','SEC-OPS-01 more than 100 series per call rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]},
 {"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,'22023','INVALID_INPUT','SEC-OPS-01 duplicated series rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"clock.FORGE","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 operation outside the vocabulary rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"maybe","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 outcome outside the vocabulary rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"failure","error_class":"SQLSTATE_23505","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 error class outside the vocabulary rejected');
select throws_ok($$select public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0],"release":"x-1"}]')$$,
 '22023','INVALID_INPUT','SEC-OPS-01 a release smuggled inside the batch rejected');
reset role;
select is(pg_temp.sec_total(),5::bigint,'SEC-OPS-01 rejected payloads wrote nothing');

-- Identity B is not blocked by A; 100 series fit one call; series and events quotas hold.
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000012","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics(b)->>'accepted','1','SEC-OPS-01 a second identity does not inherit the first one''s block') from sec_one;
select is(public.ops_ingest_client_metrics(hundred)->>'accepted','100','SEC-OPS-01 100 series in one call are accepted within quota') from sec_series;
select is(public.ops_ingest_client_metrics(hundred),'{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 series quota per identity and window') from sec_series;
reset role;
select is((select count(*)::int from private.ops_client_metrics where operation like 'kiosk.%'),100,'SEC-OPS-01 rows grow only by accepted distinct series');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000013","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":1000,"sum_ms":20000,"buckets":[1000,0,0,0,0,0,0,0,0,0]}]')->>'accepted',
 '1','SEC-OPS-01 1000 events in one series are accepted');
select is(public.ops_ingest_client_metrics('[{"operation":"select","outcome":"success","error_class":"NONE","count":201,"sum_ms":2010,"buckets":[201,0,0,0,0,0,0,0,0,0]}]'),
 '{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 events quota per identity and window');
reset role;

-- Intentional global limits: bucket rows, window volume, identities per window.
select is((select series from private.ops_ingest_windows where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')),
 (select count(*)::int from private.ops_client_metrics where bucket_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')),
 'SEC-OPS-01 the window counts exactly the distinct rows of its bucket');
update private.ops_ingest_limits set bucket_series=(select count(*)::int from private.ops_client_metrics where bucket_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00'));
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000014","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics('[{"operation":"export.link","outcome":"success","error_class":"NONE","count":1,"sum_ms":4,"buckets":[1,0,0,0,0,0,0,0,0,0]}]'),
 '{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 a full bucket accepts no new series');
select is(public.ops_ingest_client_metrics(b)->>'accepted','1','SEC-OPS-01 existing series still aggregate in a full bucket') from sec_one;
reset role;
update private.ops_ingest_limits set global_events=(select events from private.ops_ingest_windows where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00'))+1;
set local role authenticated;
select is(public.ops_ingest_client_metrics('[{"operation":"rpc.classify_hours","outcome":"failure","error_class":"UPSTREAM_5XX","count":2,"sum_ms":120,"buckets":[0,2,0,0,0,0,0,0,0,0]}]'),
 '{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 global event volume per window is capped');
reset role;
update private.ops_ingest_limits set global_events=3000,bucket_series=150,
 global_subjects=(select subjects from private.ops_ingest_windows where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00'));
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000015","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics(b),'{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 identities per window are capped') from sec_one;
reset role;
select is((select count(*)::int from private.ops_ingest_subjects s join private.ops_ingest_windows w using(window_start)
 where s.subject=encode(sha256(w.salt||convert_to('a1000000-0000-0000-0000-000000000015','UTF8')),'hex')),0,'SEC-OPS-01 an identity over the global cap leaves no quota row');
select is((select count(*)::int from private.ops_ingest_subjects where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')),
 (select subjects from private.ops_ingest_windows where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')),'SEC-OPS-01 quota rows equal the identities counted by the window');

-- Fail closed: without a limits row nothing is accepted.
create temporary table sec_limits as select * from private.ops_ingest_limits;
delete from private.ops_ingest_limits;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000012","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics(b),'{"accepted":0,"limited":true}'::jsonb,'SEC-OPS-01 a missing limits row fails closed') from sec_one;
reset role;
insert into private.ops_ingest_limits select * from sec_limits;

-- Window expiry: counters reset in the next window; old quota state and expired buckets are purged.
update private.ops_ingest_limits set global_subjects=6;
insert into private.ops_client_metrics values(date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')-interval '8 days','select','success','NONE',1,4,array[1,0,0,0,0,0,0,0,0,0]::bigint[]),
 (date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')-interval '6 days','select','success','NONE',1,4,array[1,0,0,0,0,0,0,0,0,0]::bigint[]);
create temporary table sec_old_salt as select salt from private.ops_ingest_windows where window_start=date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00');
update private.ops_ingest_subjects set window_start=window_start-interval '1 hour';
update private.ops_ingest_windows set window_start=window_start-interval '1 hour';
select set_config('request.jwt.claims','{"sub":"a1000000-0000-0000-0000-000000000011","role":"authenticated"}',true);
set local role authenticated;
select is(public.ops_ingest_client_metrics(b)->>'accepted','1','SEC-OPS-01 an expired window resets the identity''s quota') from sec_one;
reset role;
select is((select count(*)::int from private.ops_ingest_windows where window_start<date_bin('5 minutes',now(),timestamptz '2000-01-01 00:00:00+00')),0,
 'SEC-OPS-01 expired quota windows are purged by the next window');
select is((select count(*)::int from private.ops_ingest_subjects),1,'SEC-OPS-01 expired pseudonyms are purged: only the new window''s subject remains');
select ok((select salt from private.ops_ingest_windows)<>(select salt from sec_old_salt),'SEC-OPS-01 each window has its own salt: pseudonyms do not link across windows');
select is((select array_agg(to_char(bucket_start at time zone 'UTC','YYYY-MM-DD') order by bucket_start) from private.ops_client_metrics where bucket_start<now()-interval '1 day'),
 array[to_char((now()-interval '6 days') at time zone 'UTC','YYYY-MM-DD')],'SEC-OPS-01 client buckets older than the retention are purged; recent ones are kept');

select * from finish();
rollback;
