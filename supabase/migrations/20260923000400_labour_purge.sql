-- Offline, tenant-scoped labour purge. This role is reachable only by the
-- separately provisioned PostgreSQL operator, never by PostgREST or JWT roles.
create table private.retention_delete_guard (
 backend_pid integer not null, transaction_id xid8 not null,
 organization_id uuid not null, authorization_ref text not null,
 primary key(backend_pid,transaction_id)
);
alter table private.retention_delete_guard enable row level security;
alter table private.retention_delete_guard force row level security;
revoke all on private.retention_delete_guard from public,anon,authenticated,service_role;
grant select,insert,delete on private.retention_delete_guard to fichaje_retention;
create policy offline_guard on private.retention_delete_guard to fichaje_retention using(true) with check(true);

-- No trigger is disabled. UPDATE and TRUNCATE remain forbidden, as does every
-- DELETE outside an explicitly authorized offline purge transaction.
create or replace function private.immutable_record() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_user='fichaje_retention' and exists (
  select 1 from private.retention_delete_guard g
  where g.backend_pid=pg_catalog.pg_backend_pid()
   and g.transaction_id=pg_catalog.pg_current_xact_id()
   and length(btrim(g.authorization_ref))>0
 ) and (tg_table_schema,tg_table_name) in (
  ('public','audit_log'),('public','time_events'),('public','work_sessions'),
  ('public','correction_requests'),('public','correction_decisions'),
  ('public','event_adjustments'),('public','hour_classifications')) then
  return null;
 end if;
 raise exception using errcode='42501',message='IMMUTABLE';
end $$;

grant select,delete on public.time_events,public.work_sessions,public.correction_requests,
 public.correction_decisions,public.event_adjustments,public.hour_classifications,
 public.audit_log to fichaje_retention;
grant select on public.organizations,public.work_policies,public.employees,
 private.employee_state,private.idempotency_records to fichaje_retention;
create policy retention_org on public.organizations for select to fichaje_retention using(true);
create policy retention_policy on public.work_policies for select to fichaje_retention using(true);
create policy retention_employee on public.employees for select to fichaje_retention using(true);
create policy retention_state on private.employee_state for select to fichaje_retention using(true);
create policy retention_receipt on private.idempotency_records for select to fichaje_retention using(true);
do $$ declare t text; begin
 foreach t in array array['time_events','work_sessions','correction_requests',
  'correction_decisions','event_adjustments','hour_classifications','audit_log'] loop
  execute format('create policy retention_read on public.%I for select to fichaje_retention using(true)',t);
  execute format('create policy retention_delete on public.%I for delete to fichaje_retention using(true)',t);
 end loop;
end $$;

-- A single local-month scope is deliberately conservative: shared requests,
-- incomplete sessions and newer revisions prevent removal of the whole scope.
-- Dependencies are removed leaf-first, in the same transaction as the manifest.
create function private.purge_labour(p_org uuid,p_employee uuid,p_month date,
 p_cutoff timestamptz,p_authorization text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_ids uuid[]; v_requests uuid[]; v_decisions uuid[]; v_events uuid[];
 v_adjustments uuid[]; v_classifications uuid[]; v_audit bigint;
 v_counts jsonb; v_digest text; v_run uuid;
begin
 if p_org is null or p_employee is null or p_month is null or extract(day from p_month)<>1
  or p_cutoff is null or p_cutoff>clock_timestamp()
  or length(btrim(coalesce(p_authorization,''))) not between 1 and 200 then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform 1 from public.organizations where id=p_org for key share;
 if not found or not exists(select 1 from public.employees where organization_id=p_org and id=p_employee)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text,39));
 if private.active_legal_hold(p_org,p_employee) then
  raise exception using errcode='42501',message='LEGAL_HOLD'; end if;
 select array_agg(s.id order by s.id) into v_ids from public.work_sessions s
 where s.organization_id=p_org and s.employee_id=p_employee
  and (s.created_at at time zone s.timezone)::date>=p_month
  and (s.created_at at time zone s.timezone)::date<(p_month+interval '1 month')::date;
 if v_ids is null then raise exception using errcode='22023',message='EMPTY_PERIOD'; end if;
 -- Month closure, last correction and last classification each start their own
 -- four-year clock. At the exact expiry instant the period becomes eligible.
 if p_cutoff < ((p_month+interval '1 month')::date::timestamp at time zone
   (select timezone from public.work_sessions where id=v_ids[1]))+interval '4 years'
  or exists(select 1 from public.event_adjustments a where a.organization_id=p_org
   and a.session_id=any(v_ids) and a.created_at+interval '4 years'>p_cutoff)
  or exists(select 1 from public.hour_classifications c where c.organization_id=p_org
   and c.employee_id=p_employee and c.local_month=p_month
   and c.created_at+interval '4 years'>p_cutoff) then
  raise exception using errcode='22023',message='NOT_EXPIRED'; end if;
 if exists(select 1 from public.work_sessions s where s.id=any(v_ids) and (
  not exists(select 1 from public.time_events t where t.organization_id=p_org
   and t.session_id=s.id and t.event_type='CLOCK_OUT')
  or exists(select 1 from private.employee_state st where st.organization_id=p_org
   and st.employee_id=p_employee and st.open_session_id=s.id))) then
  raise exception using errcode='22023',message='INCOMPLETE_PERIOD'; end if;
 -- Requests that mention more than this one period are retained together with
 -- all their linked events; never sever a chain to make a deletion succeed.
 select array_agg(distinct r.id order by r.id) into v_requests
 from public.correction_requests r
 where r.organization_id=p_org and r.employee_id=p_employee and exists(
  select 1 from jsonb_array_elements(r.proposal) op
  where (op->>'session_id')::uuid=any(v_ids));
 if exists(select 1 from public.correction_requests r where r.id=any(v_requests) and (
  r.created_at+interval '4 years'>p_cutoff
  or not exists(select 1 from public.correction_decisions d where d.organization_id=p_org and d.request_id=r.id)
  or exists(select 1 from jsonb_array_elements(r.proposal) op
   where (op->>'session_id')::uuid<>all(v_ids)))) then
  raise exception using errcode='22023',message='DEPENDENT_EVIDENCE'; end if;
 select array_agg(id order by id) into v_decisions from public.correction_decisions
 where organization_id=p_org and request_id=any(v_requests);
 if exists(select 1 from public.event_adjustments a where a.organization_id=p_org
  and (a.session_id=any(v_ids) or a.decision_id=any(v_decisions))
  and (a.session_id<>all(v_ids) or a.decision_id<>all(v_decisions))) then
  raise exception using errcode='22023',message='DEPENDENT_EVIDENCE'; end if;
 select array_agg(id order by id) into v_adjustments from public.event_adjustments
 where organization_id=p_org and session_id=any(v_ids);
 select array_agg(id order by id) into v_events from public.time_events
 where organization_id=p_org and session_id=any(v_ids);
 select array_agg(id order by id) into v_classifications from public.hour_classifications
 where organization_id=p_org and employee_id=p_employee and local_month=p_month;
 -- Historical idempotency receipts are deliberately retained: dropping them
 -- would permit replay of the same clock/correction request after a purge.
 insert into private.retention_delete_guard values(pg_catalog.pg_backend_pid(),
  pg_catalog.pg_current_xact_id(),p_org,p_authorization);
 with gone as (delete from public.audit_log a where a.organization_id=p_org
  and a.employee_id=p_employee and a.server_at<=p_cutoff and (
   a.entity_id=any(v_ids) or a.entity_id=any(v_events) or a.entity_id=any(v_requests)
   or a.entity_id=any(v_decisions) or a.entity_id=any(v_adjustments)
   or a.entity_id=any(v_classifications)) returning 1)
 select count(*) into v_audit from gone;
 delete from public.event_adjustments where organization_id=p_org and id=any(v_adjustments);
 delete from public.correction_decisions where organization_id=p_org and id=any(v_decisions);
 delete from public.correction_requests where organization_id=p_org and id=any(v_requests);
 delete from public.hour_classifications where organization_id=p_org and id=any(v_classifications);
 delete from public.time_events where organization_id=p_org and id=any(v_events);
 delete from public.work_sessions where organization_id=p_org and id=any(v_ids);
 v_counts:=jsonb_build_object('work_sessions',cardinality(v_ids),
  'time_events',coalesce(cardinality(v_events),0),'correction_requests',coalesce(cardinality(v_requests),0),
  'correction_decisions',coalesce(cardinality(v_decisions),0),
  'event_adjustments',coalesce(cardinality(v_adjustments),0),
  'hour_classifications',coalesce(cardinality(v_classifications),0),'audit_log',v_audit);
 v_digest:=encode(sha256(convert_to(jsonb_build_array(p_org,p_cutoff,p_authorization,v_counts)::text,'UTF8')),'hex');
 insert into private.retention_runs(organization_id,cutoff,authorization_ref,counts,digest)
 values(p_org,p_cutoff,p_authorization,v_counts,v_digest) returning id into v_run;
 delete from private.retention_delete_guard where backend_pid=pg_catalog.pg_backend_pid()
  and transaction_id=pg_catalog.pg_current_xact_id();
 return v_run;
end $$;
alter function private.purge_labour(uuid,uuid,date,timestamptz,text) owner to fichaje_retention;
revoke all on function private.purge_labour(uuid,uuid,date,timestamptz,text)
 from public,anon,authenticated,service_role;
