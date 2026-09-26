-- OPS-02: operational observability and bounded self-healing.
-- No labour table gains UPDATE/DELETE/TRUNCATE. Checks are read-only; the only
-- writable derived data is the authorized private.employee_state projection,
-- rebuilt exclusively from immutable originals + approved adjustments.
-- Definer roles hold the minimum technical columns; entry roles (what an
-- operator login inherits) hold EXECUTE only and no table privilege at all.
create role fichaje_ops nologin noinherit nobypassrls;
create role fichaje_ops_repair nologin noinherit nobypassrls;
create role fichaje_ops_ingest nologin noinherit nobypassrls;
create role fichaje_ops_monitor nologin noinherit nobypassrls;
create role fichaje_ops_reviewer nologin noinherit nobypassrls;
create role fichaje_ops_repairer nologin noinherit nobypassrls;
grant fichaje_ops,fichaje_ops_repair,fichaje_ops_ingest,fichaje_ops_monitor,fichaje_ops_reviewer,fichaje_ops_repairer to postgres;
do $$ begin if exists(select 1 from pg_roles where rolname like 'fichaje\_ops%' and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls))
 then raise exception 'UNSAFE_TECHNICAL_ROLE'; end if; end $$;
grant usage on schema private,public to fichaje_ops,fichaje_ops_repair,fichaje_ops_ingest,fichaje_ops_monitor,fichaje_ops_reviewer,fichaje_ops_repairer;
grant create on schema private to fichaje_ops,fichaje_ops_repair;
grant create on schema public to fichaje_ops_ingest;

-- Operational evidence. Append-only like labour evidence; never a copy of it:
-- only technical UUIDs, stable codes, counts and versions.
create table private.ops_invariant_runs (
 id uuid primary key, started_at timestamptz not null, finished_at timestamptz not null,
 critical integer not null check(critical>=0), warning integer not null check(warning>=0), info integer not null check(info>=0),
 summary jsonb not null check(jsonb_typeof(summary)='array' and octet_length(summary::text)<=65536)
);
create table private.ops_invariant_findings (
 run_id uuid not null references private.ops_invariant_runs(id) on delete restrict,
 ordinal integer not null check(ordinal>0), invariant text not null check(invariant ~ '^[A-Z][A-Z0-9_]{2,63}$'),
 severity text not null check(severity in ('CRITICAL','WARNING','INFO')),
 organization_id uuid, subject_kind text not null check(subject_kind ~ '^[a-z_]{2,40}$'), subject_id uuid,
 detail jsonb not null check(jsonb_typeof(detail)='object' and octet_length(detail::text)<=2048),
 primary key(run_id,ordinal)
);
create table private.ops_original_baselines (
 organization_id uuid not null, employee_id uuid not null, max_sequence bigint not null check(max_sequence>0),
 digest text not null check(digest ~ '^[0-9a-f]{64}$'),
 run_id uuid not null references private.ops_invariant_runs(id) on delete restrict,
 recorded_at timestamptz not null, primary key(organization_id,employee_id,max_sequence),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict
);
create table private.ops_projection_repairs (
 id uuid primary key, organization_id uuid not null, employee_id uuid not null, request_id uuid not null,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
 authorization_ref text not null check(length(btrim(authorization_ref)) between 1 and 200),
 outcome text not null check(outcome in ('APPLIED','NOOP','BLOCKED')),
 reasons jsonb not null check(jsonb_typeof(reasons)='array'),
 before jsonb not null, candidate jsonb not null, created_at timestamptz not null,
 unique(organization_id,request_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict
);
-- Transaction-bound repair scope (same idea as retention_delete_guard): RLS of
-- the repair definer only matches the tenant/employee of its own transaction.
create table private.ops_repair_context (
 backend_pid integer not null, transaction_id xid8 not null,
 organization_id uuid not null, employee_id uuid not null,
 primary key(backend_pid,transaction_id)
);
-- Aggregated client telemetry: no tenant, user, employee, request or free text.
create table private.ops_telemetry_vocabulary (
 kind text not null check(kind in ('operation','outcome','error_class')), value text not null,
 primary key(kind,value)
);
create table private.ops_client_metrics (
 bucket_start timestamptz not null, release text not null check(release ~ '^[0-9A-Za-z.+_-]{1,64}$'),
 operation text not null, outcome text not null, error_class text not null,
 requests bigint not null check(requests>=0), duration_sum_ms double precision not null check(duration_sum_ms>=0),
 duration_buckets bigint[] not null check(cardinality(duration_buckets)=10),
 primary key(bucket_start,release,operation,outcome,error_class)
);
insert into private.ops_telemetry_vocabulary(kind,value)
select 'operation',x from unnest(array[
 'clock.CLOCK_IN','clock.BREAK_START','clock.BREAK_END','clock.CLOCK_OUT',
 'kiosk.authenticate','kiosk.clock.CLOCK_IN','kiosk.clock.BREAK_START','kiosk.clock.BREAK_END','kiosk.clock.CLOCK_OUT',
 'kiosk.provision','kiosk.revoke','kiosk.reset','export.link','auth.sign_in','select',
 'rpc.get_employee_state','rpc.get_effective_timeline','rpc.get_own_evidence','rpc.submit_correction','rpc.decide_correction',
 'rpc.request_export','rpc.manage_employee','rpc.manage_membership','rpc.transfer_ownership','rpc.create_invitation',
 'rpc.accept_invitation','rpc.create_work_policy','rpc.assign_work_policy','rpc.classify_hours',
 'rpc.record_evidence_delivery','rpc.authorize_export_link','rpc.other']) x
union all select 'outcome',x from unnest(array['success','failure','timeout','unknown','rejected']) x
union all select 'error_class',x from unnest(array['NONE','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','ALREADY_DECIDED',
 'CLOCK_REGRESSION','POLICY_REQUIRED','INVALID_TRANSITION','INVALID_INPUT','INVALID_TIMEZONE','INVALID_TIMELINE',
 'INVALID_ORDINAL','FUTURE_TIME','POLICY_BACKDATE','HOURS_MISMATCH','INCOMPLETE_PERIOD','LAST_OWNER','FORBIDDEN',
 'UNAUTHENTICATED','AUTH_FAILED','RATE_LIMITED','TIMEOUT','NETWORK','UPSTREAM_5XX','RETRYABLE_TIMEOUT','INVALID_RESPONSE']) x;

do $$ declare t text; begin
 foreach t in array array['ops_invariant_runs','ops_invariant_findings','ops_original_baselines','ops_projection_repairs',
  'ops_repair_context','ops_telemetry_vocabulary','ops_client_metrics'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('alter table private.%I force row level security',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['ops_invariant_runs','ops_invariant_findings','ops_original_baselines','ops_projection_repairs','ops_telemetry_vocabulary'] loop
  execute format('create trigger immutable before update or delete or truncate on private.%I for each statement execute function private.immutable_record()',t);
 end loop;
end $$;

-- Read-only definer: technical columns only. No names, employee codes,
-- reasons, PIN hashes, challenge hashes, emails, invitations or export content.
grant select(id,status) on public.organizations to fichaje_ops;
grant select(id,organization_id,auth_user_id,active) on public.memberships to fichaje_ops;
grant select(id,organization_id,membership_id,active) on public.employees to fichaje_ops;
grant select on private.employee_state,public.time_events,public.event_adjustments to fichaje_ops;
grant select(id,organization_id,employee_id,policy_id,timezone,created_at) on public.work_sessions to fichaje_ops;
grant select(id,organization_id,employee_id,request_id,decision,actor_membership_id,created_at) on public.correction_decisions to fichaje_ops;
grant select(id,organization_id,employee_id,proposal,created_at) on public.correction_requests to fichaje_ops;
grant select(id,organization_id,employee_id,action,entity_type,entity_id,request_id,actor_kind,safe_details) on public.audit_log to fichaje_ops;
grant select(organization_id,principal_kind,operation,key,response) on private.idempotency_records to fichaje_ops;
grant select(id,organization_id,status,checksum,object_path,created_at,expires_at) on private.export_jobs to fichaje_ops;
grant select(organization_id,created_at) on private.kiosk_challenges to fichaje_ops;
grant select(id,organization_id,authorization_ref,counts,digest) on private.retention_runs to fichaje_ops;
grant select(id,organization_id,kind,payload) on private.recovery_outbox to fichaje_ops;
grant select(id,organization_id,kind) on private.recovery_applied to fichaje_ops;
grant select(id,organization_id) on private.legal_holds to fichaje_ops;
grant select,insert on private.ops_invariant_runs,private.ops_invariant_findings,private.ops_original_baselines to fichaje_ops;
grant select on private.ops_client_metrics,private.ops_projection_repairs to fichaje_ops;
do $$ declare t text; begin
 foreach t in array array['public.organizations','public.memberships','public.employees','private.employee_state',
  'public.time_events','public.event_adjustments','public.work_sessions','public.correction_decisions',
  'public.correction_requests','public.audit_log','private.idempotency_records','private.export_jobs',
  'private.kiosk_challenges','private.retention_runs','private.recovery_outbox','private.recovery_applied',
  'private.legal_holds','private.ops_invariant_runs','private.ops_invariant_findings','private.ops_original_baselines',
  'private.ops_client_metrics','private.ops_projection_repairs'] loop
  execute format('create policy ops_read on %s for select to fichaje_ops using(true)',t);
 end loop;
 foreach t in array array['private.ops_invariant_runs','private.ops_invariant_findings','private.ops_original_baselines'] loop
  execute format('create policy ops_record on %s for insert to fichaje_ops with check(true)',t);
 end loop;
end $$;
grant execute on function private.effective_timeline(uuid,uuid,timestamptz),private.validate_timeline(uuid,uuid,timestamptz) to fichaje_ops;

-- Database saturation signals visible to any role (no query text, no pg_monitor).
create function private.ops_db_health() returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('status','UP',
  'connections',(select count(*) from pg_catalog.pg_stat_activity),
  'max_connections',pg_catalog.current_setting('max_connections')::integer,
  'lock_waiting',(select count(*) from pg_catalog.pg_locks where not granted),
  'deadlocks',(select coalesce(sum(deadlocks),0) from pg_catalog.pg_stat_database where datname=pg_catalog.current_database()))
$$;

-- Timezone-independent digest of originals up to a sequence high-water mark.
create function private.ops_originals_digest(p_org uuid,p_employee uuid,p_max bigint) returns text
language sql stable security definer set search_path='' as $$
 select encode(sha256(convert_to(coalesce(string_agg(concat_ws('|',t.id,t.sequence,t.event_type,
  to_char(t.server_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),t.session_id,t.source,
  coalesce(t.actor_membership_id::text,'-'),coalesce(t.kiosk_device_id::text,'-'),t.request_id),E'\n' order by t.sequence),''),'UTF8')),'hex')
 from public.time_events t where t.organization_id=p_org and t.employee_id=p_employee and t.sequence<=p_max
$$;

-- A labour purge (H5) legitimately removes closed sessions while the projection
-- keeps its high-water marks. Replayed purges only record the tenant.
create function private.ops_history_purged(p_org uuid,p_employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.recovery_outbox o where o.organization_id=p_org and o.kind='PURGE'
  and o.payload->>'employee_id'=p_employee::text)
 or exists(select 1 from private.recovery_applied a where a.organization_id=p_org and a.kind='PURGE')
$$;

-- Source-level coherence of one employee's immutable evidence. Any issue here
-- blocks automatic repair: evidence is escalated, never "fixed".
create function private.ops_source_issues(p_org uuid,p_employee uuid) returns text[]
language plpgsql stable security definer set search_path='' as $$
declare issues text[]:='{}'; b private.ops_original_baselines;
begin
 if exists(select 1 from public.time_events t where t.organization_id=p_org and t.employee_id=p_employee
  and (select count(*) from public.audit_log a where a.organization_id=t.organization_id and a.entity_id=t.id
   and a.action in ('record_time_event','kiosk_record_event'))<>1) then issues:=array_append(issues,'EVENT_AUDIT_MISMATCH'); end if;
 if exists(select 1 from public.time_events t where t.organization_id=p_org and t.employee_id=p_employee
  and not exists(select 1 from private.idempotency_records r where r.organization_id=t.organization_id
   and r.operation in ('record_time_event','kiosk_record_event') and r.key=t.request_id and r.response->>'event_id'=t.id::text))
 then issues:=array_append(issues,'EVENT_RECEIPT_MISSING'); end if;
 if exists(select 1 from (select t.server_at<lag(t.server_at) over(order by t.sequence) as regressed
  from public.time_events t where t.organization_id=p_org and t.employee_id=p_employee) x where x.regressed)
 then issues:=array_append(issues,'ORIGINAL_ORDER'); end if;
 if exists(select 1 from public.time_events t left join public.work_sessions s on s.id=t.session_id
  where t.organization_id=p_org and t.employee_id=p_employee
  and (s.id is null or s.organization_id<>t.organization_id or s.employee_id<>t.employee_id))
 then issues:=array_append(issues,'TENANT_REFERENCE'); end if;
 if exists(select 1 from public.correction_decisions d join public.correction_requests q
  on q.organization_id=d.organization_id and q.id=d.request_id
  where d.organization_id=p_org and d.employee_id=p_employee and (select count(*) from public.event_adjustments a
   where a.organization_id=d.organization_id and a.decision_id=d.id)<>case when d.decision='APPROVE' then jsonb_array_length(q.proposal) else 0 end)
 then issues:=array_append(issues,'CORRECTION_INCOHERENT'); end if;
 if not private.ops_history_purged(p_org,p_employee) then
  select * into b from private.ops_original_baselines where organization_id=p_org and employee_id=p_employee order by max_sequence desc limit 1;
  if found and private.ops_originals_digest(p_org,p_employee,b.max_sequence) is distinct from b.digest then
   issues:=array_append(issues,'ORIGINAL_DIGEST_MISMATCH'); end if;
 end if;
 return issues;
end $$;

-- RES-03 candidate. Source of truth: time_events (originals) + event_adjustments
-- of APPROVE decisions, replayed by the same H3 function that approvals use.
-- version = originals + approvals; last_sequence = max original sequence.
create function private.ops_projection_candidate(p_org uuid,p_employee uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.employee_state; tl jsonb; n_events bigint; max_seq bigint; n_approved bigint; purged boolean;
 blockers text[]:='{}'; fields text[]:='{}'; status text; d_version bigint; d_state text; d_session uuid; d_last timestamptz;
begin
 select * into s from private.employee_state where organization_id=p_org and employee_id=p_employee;
 if not found then
  return jsonb_build_object('status','BLOCKED','reasons',jsonb_build_array('PROJECTION_MISSING'),'fields','[]'::jsonb,
   'current',null,'derived',null,'open',false,'stale_open',false);
 end if;
 select count(*),coalesce(max(sequence),0) into n_events,max_seq from public.time_events where organization_id=p_org and employee_id=p_employee;
 select count(*) into n_approved from public.correction_decisions where organization_id=p_org and employee_id=p_employee and decision='APPROVE';
 purged:=private.ops_history_purged(p_org,p_employee);
 begin
  tl:=private.validate_timeline(p_org,p_employee,clock_timestamp());
 exception when sqlstate '22023' then
  blockers:=array_append(blockers,case when sqlerrm in ('INVALID_TIMELINE','INVALID_ORDINAL','FUTURE_TIME') then sqlerrm else 'INVALID_TIMELINE' end);
 end;
 d_version:=n_events+n_approved;
 if tl is not null then
  d_state:=tl->>'state'; d_session:=(tl->>'open_session_id')::uuid; d_last:=(tl->>'last_event_at')::timestamptz;
  if s.state::text is distinct from d_state then fields:=array_append(fields,'state'); end if;
  if s.open_session_id is distinct from d_session then fields:=array_append(fields,'open_session_id'); end if;
 end if;
 blockers:=blockers||private.ops_source_issues(p_org,p_employee);
 if purged then
  -- High-water marks and last_event_at may legitimately exceed what remains:
  -- never derived again. Only state/open session stay comparable.
  status:=case when cardinality(blockers)>0 or cardinality(fields)>0 then 'BLOCKED' else 'PURGED' end;
  if status='BLOCKED' then blockers:=array_append(blockers,'HISTORY_PURGED'); end if;
 else
  if tl is not null and s.last_event_at is distinct from d_last then fields:=array_append(fields,'last_event_at'); end if;
  if s.version<>d_version then fields:=array_append(fields,'version'); end if;
  if s.last_sequence<>max_seq then fields:=array_append(fields,'last_sequence'); end if;
  if n_events<>max_seq then blockers:=array_append(blockers,'SEQUENCE_GAP'); end if;
  -- Never lower a concurrency/sequence high-water mark automatically.
  if s.version>d_version or s.last_sequence>max_seq then blockers:=array_append(blockers,'HIGH_WATER_AHEAD'); end if;
  status:=case when cardinality(blockers)>0 then 'BLOCKED' when cardinality(fields)>0 then 'DRIFT' else 'MATCH' end;
 end if;
 return jsonb_build_object('status',status,'reasons',to_jsonb(blockers),'fields',to_jsonb(fields),
  'current',jsonb_build_object('state',s.state,'open_session_id',s.open_session_id,'last_event_at',s.last_event_at,
   'version',s.version,'last_sequence',s.last_sequence),
  'derived',case when tl is null or purged then null else jsonb_build_object('state',d_state,'open_session_id',d_session,
   'last_event_at',d_last,'version',d_version,'last_sequence',max_seq) end,
  'open',coalesce(d_state,s.state::text)<>'OUT',
  'stale_open',coalesce(d_state,s.state::text)<>'OUT' and coalesce(d_last,s.last_event_at)<clock_timestamp()-interval '16 hours');
end $$;

-- OBS-05 read-only invariants. p_org null = every tenant (only aggregated
-- summaries leave the database for the routine monitor, see below).
create function private.ops_invariant_rows(p_org uuid)
returns table(invariant text,severity text,organization_id uuid,subject_kind text,subject_id uuid,detail jsonb)
language plpgsql security definer set search_path='' as $$
declare e record; c jsonb; r text; kind text;
begin
 if p_org is null then
  -- Structural: append-only guards present and enabled for UPDATE, DELETE, TRUNCATE.
  return query select 'IMMUTABILITY_GUARD'::text,'CRITICAL'::text,null::uuid,'table'::text,null::uuid,jsonb_build_object('table',x.t)
   from unnest(array['public.audit_log','private.idempotency_records','public.work_policies','public.employee_policy_assignments',
    'public.work_sessions','public.time_events','public.correction_requests','public.correction_decisions','public.event_adjustments',
    'public.hour_classifications','private.legal_holds','private.retention_runs','private.evidence_deliveries','private.recovery_outbox',
    'private.recovery_applied','private.ops_invariant_runs','private.ops_invariant_findings','private.ops_original_baselines',
    'private.ops_projection_repairs']) x(t)
   where not exists(select 1 from pg_catalog.pg_trigger g where g.tgrelid=x.t::regclass and not g.tgisinternal
    and g.tgenabled in ('O','A') and g.tgfoid='private.immutable_record()'::regprocedure and (g.tgtype::integer & 58)=58);
  return query select 'FOREIGN_KEY_VALIDATED'::text,'CRITICAL'::text,null::uuid,'table'::text,null::uuid,
   jsonb_build_object('table',c2.conrelid::regclass::text)
   from pg_catalog.pg_constraint c2 join pg_catalog.pg_namespace n on n.oid=c2.connamespace
   where c2.contype='f' and not c2.convalidated and n.nspname in ('public','private');
 end if;
 -- Projection versus effective timeline, sequences, source coherence, open sessions.
 for e in select s.organization_id as org,s.employee_id as emp from private.employee_state s
  where p_org is null or s.organization_id=p_org order by 1,2 loop
  c:=private.ops_projection_candidate(e.org,e.emp);
  if c->>'status'='DRIFT' then
   return query select 'PROJECTION_DRIFT'::text,'CRITICAL'::text,e.org,'employee'::text,e.emp,jsonb_build_object('fields',c->'fields','repairable',true);
  elsif c->>'status'='PURGED' then
   return query select 'HISTORY_PURGED'::text,'INFO'::text,e.org,'employee'::text,e.emp,'{}'::jsonb;
  elsif c->>'status'='BLOCKED' then
   if jsonb_array_length(c->'fields')>0 or c->'reasons' ? 'PROJECTION_MISSING' or c->'reasons' ? 'HISTORY_PURGED' then
    return query select 'PROJECTION_DRIFT'::text,'CRITICAL'::text,e.org,'employee'::text,e.emp,jsonb_build_object('fields',c->'fields','repairable',false);
   end if;
   for r in select jsonb_array_elements_text(c->'reasons') loop
    kind:=case r when 'INVALID_TIMELINE' then 'TIMELINE_VALID' when 'INVALID_ORDINAL' then 'TIMELINE_VALID' when 'FUTURE_TIME' then 'TIMELINE_VALID'
     when 'SEQUENCE_GAP' then 'SEQUENCE_CONTIGUOUS' when 'HIGH_WATER_AHEAD' then 'VERSION_HIGH_WATER'
     when 'EVENT_AUDIT_MISMATCH' then 'EVENT_AUDIT' when 'EVENT_RECEIPT_MISSING' then 'EVENT_RECEIPT'
     when 'ORIGINAL_ORDER' then 'ORIGINAL_IMMUTABLE' when 'ORIGINAL_DIGEST_MISMATCH' then 'ORIGINAL_IMMUTABLE'
     when 'TENANT_REFERENCE' then 'TENANT_REFERENCE' when 'CORRECTION_INCOHERENT' then 'CORRECTION_COHERENCE' else null end;
    if kind is not null then
     return query select kind,'CRITICAL'::text,e.org,'employee'::text,e.emp,jsonb_build_object('reason',r);
    end if;
   end loop;
  end if;
  if (c->>'stale_open')::boolean then
   return query select 'OPEN_SESSION_STALE'::text,'WARNING'::text,e.org,'employee'::text,e.emp,jsonb_build_object('open_for','>16h');
  end if;
 end loop;
 -- Open sessions are reported, never closed: aggregated per tenant.
 return query select 'OPEN_SESSIONS'::text,'INFO'::text,s.organization_id,'tenant'::text,null::uuid,jsonb_build_object('count',count(*))
  from private.employee_state s where (p_org is null or s.organization_id=p_org) and s.state<>'OUT' group by s.organization_id;
 -- Evidence that references a missing original means deletion outside the purge process.
 return query select 'AUDIT_WITHOUT_EVENT'::text,'CRITICAL'::text,a.organization_id,'audit_log'::text,a.id,'{}'::jsonb
  from public.audit_log a where (p_org is null or a.organization_id=p_org) and a.action in ('record_time_event','kiosk_record_event')
  and not exists(select 1 from public.time_events t where t.organization_id=a.organization_id and t.id=a.entity_id);
 return query select 'RECEIPT_WITHOUT_EVENT'::text,
   case when exists(select 1 from private.recovery_outbox o where o.organization_id=r2.organization_id and o.kind='PURGE')
    or exists(select 1 from private.recovery_applied a where a.organization_id=r2.organization_id and a.kind='PURGE') then 'INFO' else 'CRITICAL' end,
   r2.organization_id,'time_event'::text,(r2.response->>'event_id')::uuid,'{}'::jsonb
  from private.idempotency_records r2 where (p_org is null or r2.organization_id=p_org)
  and r2.operation in ('record_time_event','kiosk_record_event') and r2.response ? 'event_id'
  and not exists(select 1 from public.time_events t where t.organization_id=r2.organization_id and t.id::text=r2.response->>'event_id');
 -- Soft references that no foreign key can enforce must stay inside the tenant.
 return query select 'TENANT_REFERENCE'::text,'CRITICAL'::text,a.organization_id,'audit_log'::text,a.id,jsonb_build_object('reference','time_event')
  from public.audit_log a join public.time_events t on t.id=a.entity_id
  where (p_org is null or a.organization_id=p_org) and a.entity_type='time_events' and t.organization_id<>a.organization_id;
 return query select 'TENANT_REFERENCE'::text,'CRITICAL'::text,r3.organization_id,'receipt'::text,null::uuid,jsonb_build_object('reference','time_event')
  from private.idempotency_records r3 join public.time_events t on t.id::text=r3.response->>'event_id'
  where (p_org is null or r3.organization_id=p_org) and r3.operation in ('record_time_event','kiosk_record_event') and t.organization_id<>r3.organization_id;
 -- Decided corrections versus adjustments and their audit evidence.
 return query select 'CORRECTION_COHERENCE'::text,'CRITICAL'::text,d.organization_id,'correction_decision'::text,d.id,
   jsonb_build_object('decision',d.decision,'operations',jsonb_array_length(q.proposal),'adjustments',
    (select count(*) from public.event_adjustments a where a.organization_id=d.organization_id and a.decision_id=d.id))
  from public.correction_decisions d join public.correction_requests q on q.organization_id=d.organization_id and q.id=d.request_id
  where (p_org is null or d.organization_id=p_org) and (select count(*) from public.event_adjustments a where a.organization_id=d.organization_id
   and a.decision_id=d.id)<>case when d.decision='APPROVE' then jsonb_array_length(q.proposal) else 0 end;
 return query select 'CORRECTION_AUDIT'::text,'CRITICAL'::text,d.organization_id,'correction_decision'::text,d.id,'{}'::jsonb
  from public.correction_decisions d where (p_org is null or d.organization_id=p_org) and not exists(select 1 from public.audit_log a
   where a.organization_id=d.organization_id and a.action='decide_correction' and a.entity_id=d.id);
 -- Manifests, journal outbox and job states (retention/export lag).
 return query select 'MANIFEST_COHERENCE'::text,'CRITICAL'::text,m.organization_id,'retention_run'::text,m.id,jsonb_build_object('kind','labour_purge')
  from private.retention_runs m where (p_org is null or m.organization_id=p_org) and m.counts ? 'time_events' and m.authorization_ref not like 'REPLAY:%'
  and not exists(select 1 from public.audit_log a where a.organization_id=m.organization_id and a.action='purge_labour' and a.entity_id=m.id
   and a.safe_details->>'digest'=m.digest);
 return query select 'MANIFEST_COHERENCE'::text,'CRITICAL'::text,m.organization_id,'retention_run'::text,m.id,jsonb_build_object('kind','replay')
  from private.retention_runs m where (p_org is null or m.organization_id=p_org) and m.authorization_ref like 'REPLAY:%'
  and not exists(select 1 from private.recovery_applied a where a.organization_id=m.organization_id and 'REPLAY:'||a.id::text=m.authorization_ref);
 return query select 'JOURNAL_OUTBOX'::text,'CRITICAL'::text,o.organization_id,'recovery_outbox'::text,o.id,jsonb_build_object('kind',o.kind)
  from private.recovery_outbox o where (p_org is null or o.organization_id=p_org) and (
   (o.kind='PURGE' and not exists(select 1 from private.retention_runs m where m.organization_id=o.organization_id and m.id::text=o.payload->>'run_id'))
   or (o.kind='HOLD' and not exists(select 1 from private.legal_holds h where h.organization_id=o.organization_id and h.id::text=o.payload->>'id'))
   or o.kind not in ('PURGE','HOLD','IDENTITY_STATE','ORGANIZATION_STATE'));
 return query select 'EXPORT_JOB_STATE'::text,
   case when j.status='READY' and (j.checksum is null or j.object_path is null) then 'CRITICAL' else 'WARNING' end,
   j.organization_id,'export_job'::text,j.id,
   jsonb_build_object('status',j.status,'lag',case when j.status='PENDING' then 'pending>1h' else 'expired>48h' end)
  from private.export_jobs j where (p_org is null or j.organization_id=p_org) and (
   (j.status='READY' and (j.checksum is null or j.object_path is null))
   or (j.status='PENDING' and j.created_at<clock_timestamp()-interval '1 hour')
   or j.expires_at<clock_timestamp()-interval '48 hours');
 return query select 'RETENTION_OVERDUE'::text,'WARNING'::text,k.organization_id,'tenant'::text,null::uuid,jsonb_build_object('kiosk_challenges',count(*))
  from private.kiosk_challenges k where (p_org is null or k.organization_id=p_org) and k.created_at<clock_timestamp()-interval '48 hours'
  group by k.organization_id;
end $$;

-- Routine monitor output: counts only, no tenant or subject identifiers.
create function private.ops_invariant_summary() returns table(invariant text,severity text,findings bigint,tenants bigint)
language sql security definer set search_path='' as $$
 select x.invariant,x.severity,count(*),count(distinct x.organization_id) from private.ops_invariant_rows(null) x group by 1,2 order by 1,2
$$;
-- Human review: tenant-scoped detail, never a global dump of subjects.
create function private.ops_invariant_findings(p_org uuid)
returns table(invariant text,severity text,organization_id uuid,subject_kind text,subject_id uuid,detail jsonb)
language plpgsql security definer set search_path='' as $$
begin
 if p_org is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 return query select * from private.ops_invariant_rows(p_org) x where x.organization_id=p_org;
end $$;
create function private.ops_affected_tenants() returns table(organization_id uuid,critical bigint,warning bigint)
language sql security definer set search_path='' as $$
 select x.organization_id,count(*) filter(where x.severity='CRITICAL'),count(*) filter(where x.severity='WARNING')
 from private.ops_invariant_rows(null) x where x.organization_id is not null and x.severity in ('CRITICAL','WARNING') group by 1 order by 1
$$;
create function private.ops_projection_candidates(p_org uuid)
returns table(employee_id uuid,status text,reasons jsonb,fields jsonb,projection jsonb,candidate jsonb)
language plpgsql security definer set search_path='' as $$
begin
 if p_org is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 return query select s.employee_id,x.c->>'status',x.c->'reasons',x.c->'fields',x.c->'current',x.c->'derived'
  from private.employee_state s cross join lateral (select private.ops_projection_candidate(s.organization_id,s.employee_id) as c) x
  where s.organization_id=p_org order by s.employee_id;
end $$;

-- Evidence of a monitoring run. Writes ONLY ops evidence tables; baselines are
-- recorded solely for employees whose immutable sources are coherent.
create function private.ops_record_invariant_run() returns jsonb
language plpgsql security definer set search_path='' as $$
declare run uuid:=gen_random_uuid(); started timestamptz:=clock_timestamp(); found_rows jsonb; totals jsonb; n_c integer; n_w integer; n_i integer;
begin
 select coalesce(jsonb_agg(to_jsonb(x) order by x.severity,x.invariant,x.organization_id,x.subject_id),'[]'::jsonb) into found_rows
 from private.ops_invariant_rows(null) x;
 select coalesce(jsonb_agg(jsonb_build_object('invariant',g.invariant,'severity',g.severity,'findings',g.n) order by g.invariant,g.severity),'[]'::jsonb),
  coalesce(sum(g.n) filter(where g.severity='CRITICAL'),0),coalesce(sum(g.n) filter(where g.severity='WARNING'),0),coalesce(sum(g.n) filter(where g.severity='INFO'),0)
 into totals,n_c,n_w,n_i
 from (select f.v->>'invariant' as invariant,f.v->>'severity' as severity,count(*) as n from jsonb_array_elements(found_rows) as f(v) group by 1,2) g;
 insert into private.ops_invariant_runs(id,started_at,finished_at,critical,warning,info,summary) values(run,started,clock_timestamp(),n_c,n_w,n_i,totals);
 insert into private.ops_invariant_findings(run_id,ordinal,invariant,severity,organization_id,subject_kind,subject_id,detail)
 select run,f.o::integer,f.v->>'invariant',f.v->>'severity',(f.v->>'organization_id')::uuid,f.v->>'subject_kind',(f.v->>'subject_id')::uuid,f.v->'detail'
 from jsonb_array_elements(found_rows) with ordinality as f(v,o);
 insert into private.ops_original_baselines(organization_id,employee_id,max_sequence,digest,run_id,recorded_at)
 select t.organization_id,t.employee_id,max(t.sequence),private.ops_originals_digest(t.organization_id,t.employee_id,max(t.sequence)),run,clock_timestamp()
 from public.time_events t group by t.organization_id,t.employee_id
 having max(t.sequence)>coalesce((select max(b.max_sequence) from private.ops_original_baselines b
   where b.organization_id=t.organization_id and b.employee_id=t.employee_id),0)
  and not private.ops_history_purged(t.organization_id,t.employee_id)
  and not exists(select 1 from jsonb_array_elements(found_rows) as f(v) where f.v->>'organization_id'=t.organization_id::text
   and f.v->>'subject_id'=t.employee_id::text and f.v->>'severity'='CRITICAL' and f.v->>'invariant'<>'PROJECTION_DRIFT');
 return jsonb_build_object('run_id',run,'critical',n_c,'warning',n_w,'info',n_i,'summary',totals);
end $$;

create function private.ops_client_metrics_snapshot(p_since timestamptz)
returns table(bucket_start timestamptz,release text,operation text,outcome text,error_class text,requests bigint,duration_sum_ms double precision,duration_buckets bigint[])
language sql security definer set search_path='' as $$
 select m.bucket_start,m.release,m.operation,m.outcome,m.error_class,m.requests,m.duration_sum_ms,m.duration_buckets
 from private.ops_client_metrics m where m.bucket_start>=coalesce(p_since,'-infinity') order by 1,2,3,4,5
$$;

do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p where p.pronamespace='private'::regnamespace and p.proname in
  ('ops_originals_digest','ops_history_purged','ops_source_issues','ops_projection_candidate','ops_invariant_rows',
   'ops_invariant_summary','ops_invariant_findings','ops_affected_tenants','ops_projection_candidates',
   'ops_record_invariant_run','ops_client_metrics_snapshot') loop
  execute format('alter function %s owner to fichaje_ops',f);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end $$;
revoke all on function private.ops_db_health() from public,anon,authenticated,service_role;
grant execute on function private.ops_db_health(),private.ops_invariant_summary(),private.ops_record_invariant_run(),
 private.ops_client_metrics_snapshot(timestamptz) to fichaje_ops_monitor;
grant execute on function private.ops_invariant_findings(uuid),private.ops_affected_tenants(),
 private.ops_projection_candidates(uuid) to fichaje_ops_reviewer;
grant execute on function private.ops_projection_candidates(uuid) to fichaje_ops_repairer;
revoke create on schema private from fichaje_ops;

-- RES-03 authorized rebuild of private.employee_state ONLY. Same lock order as
-- H1-H4 (tenant row, then projection row). Idempotent per request_id; blocked
-- when immutable sources are incoherent; audited in the same transaction.
grant select on private.employee_state to fichaje_ops_repair;
grant update(state,open_session_id,version,last_sequence,last_event_at) on private.employee_state to fichaje_ops_repair;
grant select(id,status),update(id) on public.organizations to fichaje_ops_repair;
grant insert on public.audit_log to fichaje_ops_repair;
grant select,insert on private.ops_projection_repairs to fichaje_ops_repair;
grant select,insert,delete on private.ops_repair_context to fichaje_ops_repair;
grant execute on function private.ops_projection_candidate(uuid,uuid) to fichaje_ops_repair;
create policy repair_own_context on private.ops_repair_context to fichaje_ops_repair
 using(backend_pid=pg_catalog.pg_backend_pid() and transaction_id=pg_catalog.pg_current_xact_id())
 with check(backend_pid=pg_catalog.pg_backend_pid() and transaction_id=pg_catalog.pg_current_xact_id());
create policy repair_scope on private.employee_state to fichaje_ops_repair
 using(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=employee_state.organization_id and c.employee_id=employee_state.employee_id))
 with check(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=employee_state.organization_id and c.employee_id=employee_state.employee_id));
create policy repair_lock on public.organizations to fichaje_ops_repair
 using(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=organizations.id))
 with check(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=organizations.id));
create policy repair_evidence on private.ops_projection_repairs to fichaje_ops_repair
 using(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=ops_projection_repairs.organization_id))
 with check(exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
  and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=ops_projection_repairs.organization_id
  and c.employee_id=ops_projection_repairs.employee_id));
create policy repair_audit on public.audit_log for insert to fichaje_ops_repair
 with check(actor_kind='SYSTEM' and actor_id is null and action='rebuild_projection' and entity_type='employee_state'
  and exists(select 1 from private.ops_repair_context c where c.backend_pid=pg_catalog.pg_backend_pid()
   and c.transaction_id=pg_catalog.pg_current_xact_id() and c.organization_id=audit_log.organization_id
   and c.employee_id=audit_log.employee_id and c.employee_id=audit_log.entity_id));

create function private.ops_rebuild_projection(p_org uuid,p_employee uuid,p_request_id uuid,p_authorization_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior private.ops_projection_repairs; c jsonb; verify jsonb; outcome text; t timestamptz; repair uuid:=gen_random_uuid(); digest text;
begin
 if p_org is null or p_employee is null or p_request_id is null or length(btrim(coalesce(p_authorization_ref,''))) not between 1 and 200
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_employee,btrim(p_authorization_ref))::text,'UTF8')),'hex');
 insert into private.ops_repair_context values(pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),p_org,p_employee);
 perform 1 from public.organizations where id=p_org for update;
 if not found then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into prior from private.ops_projection_repairs where organization_id=p_org and request_id=p_request_id;
 if found then
  if prior.payload_sha256<>digest then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  delete from private.ops_repair_context where backend_pid=pg_catalog.pg_backend_pid() and transaction_id=pg_catalog.pg_current_xact_id();
  return jsonb_build_object('repair_id',prior.id,'outcome',prior.outcome,'reasons',prior.reasons,'request_id',p_request_id,'replayed',true);
 end if;
 perform 1 from private.employee_state where organization_id=p_org and employee_id=p_employee for update;
 if not found then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 -- Candidate computed under the same locks every labour mutation takes first.
 c:=private.ops_projection_candidate(p_org,p_employee);
 t:=clock_timestamp();
 if c->>'status'='DRIFT' then
  update private.employee_state set state=(c->'derived'->>'state')::public.clock_state,
   open_session_id=(c->'derived'->>'open_session_id')::uuid,last_event_at=(c->'derived'->>'last_event_at')::timestamptz,
   version=(c->'derived'->>'version')::bigint,last_sequence=(c->'derived'->>'last_sequence')::bigint
  where organization_id=p_org and employee_id=p_employee;
  verify:=private.ops_projection_candidate(p_org,p_employee);
  if verify->>'status'<>'MATCH' then raise exception using errcode='55000',message='REBUILD_VERIFY_FAILED'; end if;
  insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id,server_at,safe_details)
  values(p_org,'SYSTEM',null,p_employee,'rebuild_projection','employee_state',p_employee,p_request_id,t,
   jsonb_build_object('repair_id',repair,'authorization_ref',btrim(p_authorization_ref),'fields',c->'fields','before',c->'current','after',c->'derived'));
  outcome:='APPLIED';
 elsif c->>'status' in ('MATCH','PURGED') then outcome:='NOOP';
 else outcome:='BLOCKED';
 end if;
 insert into private.ops_projection_repairs(id,organization_id,employee_id,request_id,payload_sha256,authorization_ref,outcome,reasons,before,candidate,created_at)
 values(repair,p_org,p_employee,p_request_id,digest,btrim(p_authorization_ref),outcome,c->'reasons',coalesce(c->'current','{}'::jsonb),coalesce(c->'derived','{}'::jsonb),t);
 delete from private.ops_repair_context where backend_pid=pg_catalog.pg_backend_pid() and transaction_id=pg_catalog.pg_current_xact_id();
 return jsonb_build_object('repair_id',repair,'outcome',outcome,'reasons',c->'reasons','fields',c->'fields','request_id',p_request_id,'replayed',false);
end $$;
alter function private.ops_rebuild_projection(uuid,uuid,uuid,text) owner to fichaje_ops_repair;
revoke all on function private.ops_rebuild_projection(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.ops_rebuild_projection(uuid,uuid,uuid,text) to fichaje_ops_repairer;
revoke create on schema private from fichaje_ops_repair;

-- OBS-02 client telemetry: authenticated clients add aggregated counters only.
-- Nothing identifies the tenant, person, device, request or record; no client
-- can read any telemetry back.
grant select on private.ops_telemetry_vocabulary to fichaje_ops_ingest;
grant select,insert,update on private.ops_client_metrics to fichaje_ops_ingest;
grant execute on function private.request_uid() to fichaje_ops_ingest;
create policy ingest_vocabulary on private.ops_telemetry_vocabulary for select to fichaje_ops_ingest using(true);
create policy ops_vocabulary on private.ops_telemetry_vocabulary for select to fichaje_ops using(true);
grant select on private.ops_telemetry_vocabulary to fichaje_ops;
create policy ingest_metrics on private.ops_client_metrics to fichaje_ops_ingest using(true) with check(true);
create function public.ops_ingest_client_metrics(p_release text,p_batch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare x jsonb; bucket timestamptz; accepted integer:=0; counts bigint[];
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 if p_release is null or p_release !~ '^[0-9A-Za-z.+_-]{1,64}$' or p_batch is null or jsonb_typeof(p_batch)<>'array'
  or jsonb_array_length(p_batch) not between 1 and 100 or octet_length(p_batch::text)>32768
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 bucket:=date_bin('5 minutes',clock_timestamp(),timestamptz '2000-01-01 00:00:00+00');
 for x in select value from jsonb_array_elements(p_batch) loop
  if jsonb_typeof(x)<>'object'
   or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['buckets','count','error_class','operation','outcome','sum_ms']
   or not exists(select 1 from private.ops_telemetry_vocabulary v where v.kind='operation' and v.value=x->>'operation')
   or not exists(select 1 from private.ops_telemetry_vocabulary v where v.kind='outcome' and v.value=x->>'outcome')
   or not exists(select 1 from private.ops_telemetry_vocabulary v where v.kind='error_class' and v.value=x->>'error_class')
   or jsonb_typeof(x->'count')<>'number' or (x->>'count') !~ '^[1-9][0-9]{0,3}$'
   or jsonb_typeof(x->'sum_ms')<>'number' or (x->>'sum_ms') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$'
   or jsonb_typeof(x->'buckets')<>'array' or jsonb_array_length(x->'buckets')<>10
   or exists(select 1 from jsonb_array_elements(x->'buckets') as e(b) where jsonb_typeof(e.b)<>'number' or e.b::text !~ '^(0|[1-9][0-9]{0,3})$')
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  select array_agg(e.b::text::bigint order by e.o) into counts from jsonb_array_elements(x->'buckets') with ordinality as e(b,o);
  if (select sum(u) from unnest(counts) u)<>(x->>'count')::bigint then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  insert into private.ops_client_metrics as m(bucket_start,release,operation,outcome,error_class,requests,duration_sum_ms,duration_buckets)
  values(bucket,p_release,x->>'operation',x->>'outcome',x->>'error_class',(x->>'count')::bigint,(x->>'sum_ms')::double precision,counts)
  on conflict(bucket_start,release,operation,outcome,error_class) do update set requests=m.requests+excluded.requests,
   duration_sum_ms=m.duration_sum_ms+excluded.duration_sum_ms,
   duration_buckets=(select array_agg(u.a+u.b order by u.i) from unnest(m.duration_buckets,excluded.duration_buckets) with ordinality u(a,b,i));
  accepted:=accepted+1;
 end loop;
 return jsonb_build_object('accepted',accepted);
end $$;
alter function public.ops_ingest_client_metrics(text,jsonb) owner to fichaje_ops_ingest;
revoke all on function public.ops_ingest_client_metrics(text,jsonb) from public,anon,service_role;
grant execute on function public.ops_ingest_client_metrics(text,jsonb) to authenticated;
revoke create on schema public from fichaje_ops_ingest;
