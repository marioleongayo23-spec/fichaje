-- Only the dedicated offline role can apply externally committed tombstones.
create table private.recovery_applied (
 id uuid primary key, organization_id uuid not null, kind text not null,
 applied_at timestamptz not null default clock_timestamp()
);
alter table private.recovery_applied enable row level security;
alter table private.recovery_applied force row level security;
revoke all on private.recovery_applied from public,anon,authenticated,service_role;
grant select,insert on private.recovery_applied to fichaje_retention;
create policy offline_applied on private.recovery_applied to fichaje_retention
 using(organization_id=private.retention_scope()) with check(organization_id=private.retention_scope());
create trigger immutable before update or delete or truncate on private.recovery_applied
 for each statement execute function private.immutable_record();
grant select on public.memberships to fichaje_retention;
grant update(active,version) on public.memberships,public.employees to fichaje_retention;
grant update(status) on public.organizations to fichaje_retention;
create policy retention_member_read on public.memberships for select to fichaje_retention using(organization_id=private.retention_scope());
create policy recovery_member on public.memberships for update to fichaje_retention
 using(organization_id=private.retention_scope()) with check(organization_id=private.retention_scope());
create policy recovery_employee on public.employees for update to fichaje_retention
 using(organization_id=private.retention_scope()) with check(organization_id=private.retention_scope());
create policy recovery_org on public.organizations for update to fichaje_retention
 using(id=private.retention_scope()) with check(id=private.retention_scope());
create policy recovery_audit on public.audit_log for insert to fichaje_retention
 with check(organization_id=private.retention_scope() and actor_kind='SYSTEM'
  and actor_id is null and action='recovery_replay');
grant create on schema private to fichaje_retention;
create function private.replay_recovery(p_id uuid,p_org uuid,p_kind text,p_payload jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare t text; ids uuid[]; n bigint; c jsonb:='{}'; digest text; hold_employee uuid;
begin
 if p_id is null or p_org is null or p_payload is null then raise exception 'INVALID_INPUT'; end if;
 if not private.verify_journal_entry(p_id,p_org,p_kind,p_payload) then
  raise exception using errcode='42501',message='UNVERIFIED_RECOVERY_ENTRY'; end if;
 insert into private.retention_delete_guard values(pg_catalog.pg_backend_pid(),
  pg_catalog.pg_current_xact_id(),p_org,'RECOVERY:'||p_id::text);
 if exists(select 1 from private.recovery_applied where id=p_id and organization_id=p_org)
  or exists(select 1 from private.recovery_outbox where id=p_id and organization_id=p_org) then
  delete from private.retention_delete_guard where backend_pid=pg_catalog.pg_backend_pid()
   and transaction_id=pg_catalog.pg_current_xact_id(); return false;
 end if;
 perform 1 from public.organizations where id=p_org for update;
 if not found then raise exception 'RECOVERY_MISSING_TENANT'; end if;
 insert into private.recovery_replay_context values(pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id());
 if p_kind='HOLD' then
  hold_employee:=(p_payload->>'employee_id')::uuid;
  insert into private.legal_holds(id,organization_id,employee_id,scope,reason,authorized_by,created_at,release_of)
  values((p_payload->>'id')::uuid,p_org,hold_employee,p_payload->>'scope','Recovery journal replay',
   p_payload->>'authorized_by',(p_payload->>'created_at')::timestamptz,(p_payload->>'release_of')::uuid);
 elsif p_kind='IDENTITY_STATE' then
  t:=p_payload->>'table';
  if t not in ('memberships','employees') then raise exception 'INVALID_RECOVERY_TABLE'; end if;
  execute format('update public.%I set active=$1,version=greatest(version,$2) where organization_id=$3 and id=$4',t)
   using (p_payload->>'active')::boolean,(p_payload->>'version')::bigint,p_org,(p_payload->>'id')::uuid;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'RECOVERY_MISSING_IDENTITY'; end if;
 elsif p_kind='ORGANIZATION_STATE' then
  if (p_payload->>'id')::uuid<>p_org then raise exception 'FORBIDDEN'; end if;
  update public.organizations set status=p_payload->>'status' where id=p_org;
 elsif p_kind='PURGE' then
  if private.active_legal_hold(p_org,(p_payload->>'employee_id')::uuid) then raise exception 'LEGAL_HOLD'; end if;
  -- These identifiers certify a prior committed legal purge. An old restored
  -- session may lack a later closing event: replay removes that already-purged
  -- evidence by exact IDs, without recalculating or inventing missing hours.
  foreach t in array array['audit_log','event_adjustments','correction_decisions',
   'correction_requests','hour_classifications','time_events','work_sessions'] loop
   select array_agg(value::uuid) into ids from jsonb_array_elements_text(
    case when jsonb_typeof(p_payload->'ids'->t)='array' then p_payload->'ids'->t else '[]'::jsonb end);
   execute format('delete from public.%I where organization_id=$1 and id=any($2)',t) using p_org,ids;
   get diagnostics n=row_count;
   c:=c||jsonb_build_object(t,n);
  end loop;
  digest:=encode(sha256(convert_to(jsonb_build_array(p_org,(p_payload->>'cutoff')::timestamptz,
   'REPLAY:'||p_id::text,c)::text,'UTF8')),'hex');
  insert into private.retention_runs(organization_id,cutoff,authorization_ref,counts,digest)
  values(p_org,(p_payload->>'cutoff')::timestamptz,'REPLAY:'||p_id::text,c,digest);
 else raise exception 'INVALID_RECOVERY_KIND'; end if;
 insert into private.recovery_applied(id,organization_id,kind) values(p_id,p_org,p_kind);
 insert into public.audit_log(organization_id,actor_kind,actor_id,action,entity_type,entity_id,request_id,safe_details)
 values(p_org,'SYSTEM',null,'recovery_replay','recovery_applied',p_id,p_id,jsonb_build_object('kind',p_kind));
 delete from private.recovery_replay_context where backend_pid=pg_catalog.pg_backend_pid()
  and transaction_id=pg_catalog.pg_current_xact_id();
 delete from private.retention_delete_guard where backend_pid=pg_catalog.pg_backend_pid()
  and transaction_id=pg_catalog.pg_current_xact_id();
 return true;
end $$;
alter function private.replay_recovery(uuid,uuid,text,jsonb) owner to fichaje_retention;
revoke all on function private.replay_recovery(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke create on schema private from fichaje_retention;
