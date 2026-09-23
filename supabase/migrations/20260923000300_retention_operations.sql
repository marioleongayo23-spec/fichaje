-- H5 offline-only retention authority; not part of the PostgREST API schema.
create role fichaje_retention nologin noinherit nobypassrls;
grant fichaje_retention to postgres;
grant usage,create on schema private to fichaje_retention;
grant usage on schema public to fichaje_retention;
grant select,insert on private.legal_holds,private.retention_runs to fichaje_retention;
grant insert on public.audit_log to fichaje_retention;
grant select,delete on private.kiosk_challenges,private.auth_attempt_buckets,
 private.kiosk_network_buckets,private.export_jobs to fichaje_retention;
grant select on storage.objects to fichaje_retention;
create policy retention_storage_check on storage.objects for select to fichaje_retention
 using(bucket_id='fichaje-evidence');
create policy retention_holds on private.legal_holds to fichaje_retention using(true) with check(true);
create policy retention_manifests on private.retention_runs to fichaje_retention using(true) with check(true);
create policy retention_audit on public.audit_log for insert to fichaje_retention
 with check(actor_kind='SYSTEM' and actor_id is null and action in ('legal_hold','release_hold'));
do $$ declare t text; begin
 foreach t in array array['kiosk_challenges','auth_attempt_buckets','kiosk_network_buckets','export_jobs'] loop
  execute format('create policy offline_expiry on private.%I for select to fichaje_retention using(true)',t);
  execute format('create policy offline_delete on private.%I for delete to fichaje_retention using(true)',t);
 end loop;
end $$;

create function private.active_legal_hold(p_org uuid,p_employee uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from private.legal_holds h where h.organization_id=p_org
  and h.release_of is null and (h.employee_id is null or h.employee_id=p_employee)
  and not exists(select 1 from private.legal_holds release where release.organization_id=p_org
   and release.release_of=h.id))
$$;
revoke all on function private.active_legal_hold(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.active_legal_hold(uuid,uuid) to fichaje_retention;

create function private.record_legal_hold(p_org uuid,p_employee uuid,p_reason text,p_authorization text,
 p_release_of uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior private.legal_holds; id uuid; t timestamptz;
begin
 if p_org is null or length(btrim(coalesce(p_reason,''))) not between 1 and 1000
  or length(btrim(coalesce(p_authorization,''))) not between 1 and 200 then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text,39));
 if p_release_of is not null then
  select * into prior from private.legal_holds where organization_id=p_org and id=p_release_of
   and release_of is null;
  if not FOUND or prior.employee_id is distinct from p_employee or exists(
   select 1 from private.legal_holds where organization_id=p_org and release_of=p_release_of) then
   raise exception using errcode='42501',message='FORBIDDEN'; end if;
 end if;
 t:=clock_timestamp();
 insert into private.legal_holds(organization_id,employee_id,scope,reason,authorized_by,created_at,release_of)
 values(p_org,p_employee,case when p_employee is null then 'ORGANIZATION' else 'EMPLOYEE' end,
  p_reason,p_authorization,t,p_release_of) returning private.legal_holds.id into id;
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,
  entity_id,request_id,server_at,safe_details) values(p_org,'SYSTEM',null,p_employee,
  case when p_release_of is null then 'legal_hold' else 'release_hold' end,'legal_holds',id,
  gen_random_uuid(),t,jsonb_build_object('release_of',p_release_of,'authorization_ref',p_authorization));
 return id;
end $$;
alter function private.record_legal_hold(uuid,uuid,text,text,uuid) owner to fichaje_retention;
revoke all on function private.record_legal_hold(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;

-- Operational expiry does not touch labour evidence. Storage objects must have
-- been removed first; any remaining object stops the export row deletion.
create function private.purge_operational(p_org uuid,p_cutoff timestamptz,p_authorization text) returns uuid
language plpgsql security definer set search_path='' as $$
declare c jsonb; n_challenges bigint; n_attempts bigint; n_network bigint; n_exports bigint;
 run_id uuid; digest text;
begin
 if p_org is null or p_cutoff is null or p_cutoff>clock_timestamp()
  or length(btrim(coalesce(p_authorization,''))) not between 1 and 200 then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text,39));
 if private.active_legal_hold(p_org,null) or exists(
  select 1 from private.legal_holds h where h.organization_id=p_org and h.employee_id is not null
   and h.release_of is null and not exists(select 1 from private.legal_holds r
    where r.organization_id=p_org and r.release_of=h.id)) then
  raise exception using errcode='42501',message='LEGAL_HOLD'; end if;
 with removed as (delete from private.kiosk_challenges where organization_id=p_org
  and created_at+interval '24 hours'<=p_cutoff returning 1)
 select count(*) into n_challenges from removed;
 with removed as (delete from private.auth_attempt_buckets where organization_id=p_org
  and greatest(window_start,coalesce(locked_until,window_start))+interval '24 hours'<=p_cutoff returning 1)
 select count(*) into n_attempts from removed;
 with removed as (delete from private.kiosk_network_buckets where organization_id=p_org
  and greatest(window_start,coalesce(locked_until,window_start))+interval '24 hours'<=p_cutoff returning 1)
 select count(*) into n_network from removed;
 with removed as (delete from private.export_jobs j where j.organization_id=p_org
  and j.expires_at<=p_cutoff and (j.object_path is null or not exists(
   select 1 from storage.objects o where o.bucket_id='fichaje-evidence' and o.name=j.object_path)) returning 1)
 select count(*) into n_exports from removed;
 c:=jsonb_build_object('challenges',n_challenges,'attempt_buckets',n_attempts,
  'network_buckets',n_network,'export_jobs',n_exports);
 digest:=encode(sha256(convert_to(jsonb_build_array(p_org,p_cutoff,p_authorization,c)::text,'UTF8')),'hex');
 insert into private.retention_runs(organization_id,cutoff,authorization_ref,counts,digest)
 values(p_org,p_cutoff,p_authorization,c,digest) returning id into run_id;
 return run_id;
end $$;
alter function private.purge_operational(uuid,timestamptz,text) owner to fichaje_retention;
revoke all on function private.purge_operational(uuid,timestamptz,text) from public,anon,authenticated,service_role;
revoke create on schema private from fichaje_retention;
