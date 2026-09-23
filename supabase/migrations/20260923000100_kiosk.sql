-- H4: private gateway boundary. No client/service_role grants.
create role fichaje_kiosk nologin noinherit;
create role fichaje_gateway nologin noinherit;
grant fichaje_kiosk,fichaje_gateway to postgres;
grant usage on schema private,public to fichaje_kiosk,fichaje_gateway;
grant create on schema private to fichaje_kiosk,fichaje_guard;
grant execute on function private.request_uid(),private.current_role(uuid),private.scoped_tenant(text),private.scoped_subject(text) to fichaje_kiosk;
alter table private.mutation_context drop constraint mutation_context_route_check;
alter table private.mutation_context add constraint mutation_context_route_check check(route in
 ('member','bootstrap','invitation','clock','correction_submit','correction_decide','kiosk_admin','kiosk_device','kiosk_clock'));

create table private.kiosk_devices (
 id uuid primary key, organization_id uuid not null references public.organizations(id) on delete restrict,
 auth_user_id uuid not null unique references auth.users(id) on delete restrict,
 name text not null check(length(name) between 1 and 100), active boolean not null default true,
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), check(expires_at>created_at)
);
create table private.kiosk_credentials (
 organization_id uuid not null, employee_id uuid not null,
 pin_hash text not null check(pin_hash ~ '^\$argon2id\$v=19\$m=19456,t=2,p=1\$'),
 credential_version bigint not null check(credential_version>0),
 failed_attempts integer not null default 0 check(failed_attempts>=0),
 window_start timestamptz not null default clock_timestamp(), locked_until timestamptz,
 changed_at timestamptz not null default clock_timestamp(), primary key(organization_id,employee_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict
);
create table private.kiosk_challenges (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, device_id uuid not null,
 employee_id uuid not null, action public.time_action not null, expected_version bigint not null check(expected_version>=0),
 request_id uuid not null, token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 credential_version bigint not null, created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default (clock_timestamp()+interval '60 seconds'), used_at timestamptz,
 foreign key(organization_id,device_id) references private.kiosk_devices(organization_id,id) on delete restrict,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 check(expires_at>created_at and expires_at<=created_at+interval '60 seconds')
);
create table private.auth_attempt_buckets (
 organization_id uuid not null, device_id uuid not null, subject_hash text not null check(subject_hash ~ '^[0-9a-f]{64}$'),
 window_start timestamptz not null, failures integer not null default 0 check(failures>=0), locked_until timestamptz,
 primary key(organization_id,device_id,subject_hash),
 foreign key(organization_id,device_id) references private.kiosk_devices(organization_id,id) on delete restrict
);
-- Additional tenant-scoped network defense; only keyed digests reach PostgreSQL.
create table private.kiosk_network_buckets (
 organization_id uuid not null references public.organizations(id),
 subject_hash text not null check(subject_hash ~ '^[0-9a-f]{64}$'),
 window_start timestamptz not null, failures integer not null default 0 check(failures>=0), locked_until timestamptz,
 primary key(organization_id,subject_hash)
);
alter table public.time_events alter column actor_membership_id drop not null;
alter table public.time_events drop constraint time_events_source_check;
alter table public.time_events add column kiosk_device_id uuid;
alter table public.time_events add foreign key(organization_id,kiosk_device_id) references private.kiosk_devices(organization_id,id) on delete restrict;
alter table public.time_events add constraint time_events_source_check check(
 (source='WEB' and actor_membership_id is not null and kiosk_device_id is null) or
 (source='KIOSK' and actor_membership_id is null and kiosk_device_id is not null));

do $$ declare t text; begin
 foreach t in array array['kiosk_devices','kiosk_credentials','kiosk_challenges','auth_attempt_buckets','kiosk_network_buckets'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('alter table private.%I force row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role,fichaje_gateway',t);
 execute format('grant select,insert,update on private.%I to fichaje_kiosk',t);
 execute format('create policy kiosk_access on private.%I to fichaje_kiosk using(
 organization_id=coalesce(private.scoped_tenant(''kiosk_admin''),private.scoped_tenant(''kiosk_device''),private.scoped_tenant(''kiosk_clock'')))
 with check(organization_id=coalesce(private.scoped_tenant(''kiosk_admin''),private.scoped_tenant(''kiosk_device''),private.scoped_tenant(''kiosk_clock'')))',t);
 end loop;
end $$;
-- Guard reads only device identities; no credential hash, challenge or business DML.
grant select on private.kiosk_devices to fichaje_guard;
create policy kiosk_guard on private.kiosk_devices for select to fichaje_guard using(true);
create function private.kiosk_identity_exclusion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.auth_user_id::text,4));
 if (TG_TABLE_NAME='memberships' and exists(select 1 from private.kiosk_devices where auth_user_id=new.auth_user_id))
 or (TG_TABLE_NAME='kiosk_devices' and exists(select 1 from public.memberships where auth_user_id=new.auth_user_id))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 return new;
end $$;
alter function private.kiosk_identity_exclusion() owner to fichaje_guard;
revoke all on function private.kiosk_identity_exclusion() from public,anon,authenticated,service_role;
create trigger kiosk_identity_exclusion before insert or update on public.memberships for each row execute function private.kiosk_identity_exclusion();
create trigger kiosk_identity_exclusion before insert or update on private.kiosk_devices for each row execute function private.kiosk_identity_exclusion();

create function private.kiosk_access(p_org uuid,p_device uuid,p_employee uuid,p_admin boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_admin then
  if coalesce(private.current_role(p_org)::text,'') not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 else
  if not exists(select 1 from private.kiosk_devices d join public.organizations o on o.id=d.organization_id
   where d.organization_id=p_org and d.id=p_device and d.auth_user_id=private.request_uid()
   and d.active and d.expires_at>clock_timestamp() and o.status='ACTIVE')
  or exists(select 1 from public.memberships where auth_user_id=private.request_uid())
  then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 end if;
 if p_employee is not null and not exists(select 1 from public.employees where organization_id=p_org and id=p_employee and active)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
end $$;
alter function private.kiosk_access(uuid,uuid,uuid,boolean) owner to fichaje_guard;
create function private.kiosk_scope(p_org uuid,p_device uuid,p_employee uuid,p_admin boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.kiosk_access(p_org,p_device,p_employee,p_admin);
 perform private.bind_context(p_org,case when p_admin then 'kiosk_admin' when p_employee is null then 'kiosk_device' else 'kiosk_clock' end,
 coalesce(p_employee,p_device));
end $$;
alter function private.kiosk_scope(uuid,uuid,uuid,boolean) owner to fichaje_guard;
revoke all on function private.kiosk_access(uuid,uuid,uuid,boolean),private.kiosk_scope(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function private.kiosk_access(uuid,uuid,uuid,boolean),private.kiosk_scope(uuid,uuid,uuid,boolean) to fichaje_kiosk;

alter table public.audit_log drop constraint audit_log_actor_kind_check;
alter table public.audit_log add constraint audit_log_actor_kind_check check(actor_kind in ('USER','SYSTEM','KIOSK'));
alter table private.idempotency_records drop constraint idempotency_records_principal_kind_check;
alter table private.idempotency_records add constraint idempotency_records_principal_kind_check check(principal_kind in ('USER','SYSTEM','KIOSK'));

-- No grants to the SQL gateway login except the explicitly listed entrypoints below.
grant select,update(id) on public.organizations to fichaje_kiosk;
create policy kiosk_lock on public.organizations to fichaje_kiosk
 using(id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device'),private.scoped_tenant('kiosk_clock')))
 with check(id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device'),private.scoped_tenant('kiosk_clock')));
grant select on public.employees to fichaje_kiosk;
create policy kiosk_employee on public.employees for select to fichaje_kiosk using(
 organization_id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device')) or
 (organization_id=private.scoped_tenant('kiosk_clock') and id=private.scoped_subject('kiosk_clock')));
grant select on public.work_policies,public.employee_policy_assignments,public.time_events,public.work_sessions,private.employee_state to fichaje_kiosk;
grant insert on public.time_events,public.work_sessions,public.audit_log,private.idempotency_records to fichaje_kiosk;
grant select on private.idempotency_records to fichaje_kiosk;
grant update on private.employee_state to fichaje_kiosk;
create policy kiosk_policy on public.work_policies for select to fichaje_kiosk using(organization_id=private.scoped_tenant('kiosk_clock'));
create policy kiosk_assignment on public.employee_policy_assignments for select to fichaje_kiosk using(organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock'));
do $$ declare t text; begin
 foreach t in array array['public.work_sessions','public.time_events','private.employee_state'] loop
 execute format('create policy kiosk_clock on %s to fichaje_kiosk using(organization_id=private.scoped_tenant(''kiosk_clock'') and employee_id=private.scoped_subject(''kiosk_clock''))
 with check(organization_id=private.scoped_tenant(''kiosk_clock'') and employee_id=private.scoped_subject(''kiosk_clock''))',t);
 end loop;
end $$;
create policy kiosk_audit on public.audit_log for insert to fichaje_kiosk with check(
 (organization_id=private.scoped_tenant('kiosk_admin') and actor_kind='USER' and actor_id=private.request_uid() and action in ('kiosk_provision','kiosk_revoke','kiosk_reset')) or
 (organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock') and actor_kind='KIOSK' and action='kiosk_record_event'
 and actor_id=private.request_uid()));
create policy kiosk_receipt on private.idempotency_records to fichaje_kiosk using(
 (organization_id=private.scoped_tenant('kiosk_admin') and principal_kind='USER' and principal_id=private.request_uid() and operation in ('kiosk_provision','kiosk_revoke','kiosk_reset')) or
 (organization_id=private.scoped_tenant('kiosk_clock') and principal_kind='KIOSK' and operation='kiosk_record_event' and principal_id in
 (select id from private.kiosk_devices where organization_id=private.scoped_tenant('kiosk_clock') and auth_user_id=private.request_uid())))
 with check(
 (organization_id=private.scoped_tenant('kiosk_admin') and principal_kind='USER' and principal_id=private.request_uid() and operation in ('kiosk_provision','kiosk_revoke','kiosk_reset')) or
 (organization_id=private.scoped_tenant('kiosk_clock') and principal_kind='KIOSK' and operation='kiosk_record_event' and principal_id in
 (select id from private.kiosk_devices where organization_id=private.scoped_tenant('kiosk_clock') and auth_user_id=private.request_uid())));
grant execute on function private.check_clock(timestamptz,timestamptz),private.replay(uuid,uuid,text,jsonb) to fichaje_kiosk;

create function private.apply_time_event(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_action public.time_action,p_expected_version bigint,p_actor uuid,p_device uuid)
returns jsonb language plpgsql set search_path='' as $$
declare s private.employee_state; t timestamptz; next_state public.clock_state; session uuid;
 event uuid:=gen_random_uuid(); policy public.work_policies; r jsonb; prior private.idempotency_records;
 kind text:=case when p_device is null then 'USER' else 'KIOSK' end;
 principal uuid:=coalesce(p_device,private.request_uid());
 op text:=case when p_device is null then 'record_time_event' else 'kiosk_record_event' end;
 payload jsonb:=jsonb_build_array(p_employee_id,p_action,p_expected_version);
begin
 select * into s from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id for update;
 if not FOUND then raise exception using errcode='55000',message='STATE_MISSING'; end if;
 -- Authorization precedes receipt recovery, even for previously successful requests.
 if p_request_id is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into prior from private.idempotency_records where organization_id=p_organization_id and principal_kind=kind
 and principal_id=principal and operation=op and key=p_request_id;
 if FOUND then
  if prior.payload_sha256<>encode(sha256(convert_to(payload::text,'UTF8')),'hex') then raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  r:=prior.response;
 end if;
 if r is not null then return r; end if;
 if p_action is null or p_expected_version is null or p_expected_version<0 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if s.version<>p_expected_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 next_state:=case
 when s.state='OUT' and p_action='CLOCK_IN' then 'WORKING'::public.clock_state
 when s.state='WORKING' and p_action='BREAK_START' then 'PAUSED'::public.clock_state
 when s.state='PAUSED' and p_action='BREAK_END' then 'WORKING'::public.clock_state
 when s.state in ('WORKING','PAUSED') and p_action='CLOCK_OUT' then 'OUT'::public.clock_state end;
 if next_state is null then raise exception using errcode='22023',message='INVALID_TRANSITION'; end if;
 -- The sole effective clock sample; all persisted event/receipt/audit times use it.
 t:=clock_timestamp();
 -- Corrections can move/void the last effective event, but cannot lower the
 -- high-water mark of observed server time from immutable originals.
 perform private.check_clock(greatest(s.last_event_at,(select max(e.server_at) from public.time_events e
  where e.organization_id=p_organization_id and e.employee_id=p_employee_id)),t);
 session:=s.open_session_id;
 if p_action='CLOCK_IN' then
  select p.* into policy from public.employee_policy_assignments a join public.work_policies p
  on p.organization_id=a.organization_id and p.id=a.policy_id
  where a.organization_id=p_organization_id and a.employee_id=p_employee_id and a.effective_from<=t and p.valid_from<=t
  order by a.effective_from desc limit 1;
  if not FOUND then raise exception using errcode='22023',message='POLICY_REQUIRED'; end if;
  insert into public.work_sessions(organization_id,employee_id,policy_id,timezone,created_at)
  values(p_organization_id,p_employee_id,policy.id,policy.timezone,t) returning id into session;
 end if;
 insert into public.time_events(id,organization_id,employee_id,session_id,sequence,event_type,server_at,actor_membership_id,kiosk_device_id,source,request_id)
 values(event,p_organization_id,p_employee_id,session,s.last_sequence+1,p_action,t,p_actor,p_device,case when p_device is null then 'WEB' else 'KIOSK' end,p_request_id);
 update private.employee_state set state=next_state,open_session_id=case when next_state='OUT' then null else session end,
 version=s.version+1,last_sequence=s.last_sequence+1,last_event_at=t where organization_id=p_organization_id and employee_id=p_employee_id;
 r:=jsonb_build_object('event_id',event,'session_id',session,'server_at',t,'state',next_state,'version',s.version+1,'sequence',s.last_sequence+1,'request_id',p_request_id);
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id,server_at,safe_details)
 values(p_organization_id,kind,private.request_uid(),p_employee_id,op,'time_events',event,p_request_id,t,
 jsonb_build_object('event_type',p_action,'session_id',session,'sequence',s.last_sequence+1,'before',jsonb_build_object('state',s.state,'version',s.version),
 'after',jsonb_build_object('state',next_state,'version',s.version+1)));
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response,created_at)
 values(p_organization_id,kind,principal,op,p_request_id,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),r,t);
 return r;
end $$;

revoke all on function private.apply_time_event(uuid,uuid,uuid,public.time_action,bigint,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.apply_time_event(uuid,uuid,uuid,public.time_action,bigint,uuid,uuid) to fichaje_clock,fichaje_kiosk;
create or replace function public.record_time_event(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_action public.time_action,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
 -- Lock order shared with H1: organization, then employee state. Serializing by
 -- tenant deliberately favors correct revocation over throughput in V1.
 perform private.clock_scope(p_organization_id,p_employee_id);
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 -- Revalidate after the H1 tenant lock. Do not bind/delete contexts again
 -- while holding it: a waiting transaction may hold a context-cleanup row lock.
 if private.current_role(p_organization_id) is null then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select m.id into actor from public.memberships m join public.employees e
 on e.organization_id=m.organization_id and e.membership_id=m.id
 where m.organization_id=p_organization_id and m.auth_user_id=private.request_uid() and m.active and e.active and e.id=p_employee_id;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 return private.apply_time_event(p_organization_id,p_request_id,p_employee_id,p_action,p_expected_version,actor,null);
end $$;

create function private.kiosk_admin_prepare(p_org uuid,p_request uuid,p_op text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.kiosk_scope(p_org,null,null,true);
 perform 1 from public.organizations where id=p_org and status='ACTIVE' for update;
 perform private.kiosk_access(p_org,null,null,true);
 if p_op not in ('kiosk_provision','kiosk_revoke','kiosk_reset') then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 return private.replay(p_org,p_request,p_op,p_payload);
end $$;

create function private.kiosk_admin_apply(p_org uuid,p_request uuid,p_op text,p_payload jsonb,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; target uuid; v bigint; t timestamptz:=clock_timestamp();
begin
 r:=private.kiosk_admin_prepare(p_org,p_request,p_op,p_payload);
 if r is not null then return r; end if;
 target:=(p_payload->>'target')::uuid;
 if p_op='kiosk_provision' then
  if (p_payload->>'expires_at')::timestamptz<=t then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  insert into private.kiosk_devices(id,organization_id,auth_user_id,name,expires_at)
  values(target,p_org,(p_data->>'auth_user_id')::uuid,p_payload->>'name',(p_payload->>'expires_at')::timestamptz);
  r:=jsonb_build_object('device_id',target,'delivery',p_data->'delivery','request_id',p_request);
 elsif p_op='kiosk_revoke' then
  update private.kiosk_devices set active=false where organization_id=p_org and id=target;
  if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  r:=jsonb_build_object('device_id',target,'active',false,'request_id',p_request);
 else
  if not exists(select 1 from public.employees where organization_id=p_org and id=target and active)
  then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  insert into private.kiosk_credentials(organization_id,employee_id,pin_hash,credential_version)
  values(p_org,target,p_data->>'pin_hash',1)
  on conflict(organization_id,employee_id) do update set pin_hash=excluded.pin_hash,
   credential_version=kiosk_credentials.credential_version+1,changed_at=t
  returning credential_version into v;
  -- Reset does not clear an active brute-force lock. Old challenges fail the version check.
  r:=jsonb_build_object('employee_id',target,'credential_version',v,'delivery',p_data->'delivery','request_id',p_request);
 end if;
 insert into public.audit_log(organization_id,actor_kind,actor_id,action,entity_type,entity_id,request_id,safe_details)
 values(p_org,'USER',private.request_uid(),p_op,case when p_op='kiosk_reset' then 'kiosk_credentials' else 'kiosk_devices' end,target,p_request,
 jsonb_build_object('credential_version',v,'active',p_op<>'kiosk_revoke'));
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
 values(p_org,'USER',private.request_uid(),p_op,p_request,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'),r);
 return r;
end $$;

-- Reservations count as failure until verified. Failed responses COMMIT the attempt.
-- Verification is local Argon2id within this transaction; no network I/O under locks.
create function private.kiosk_auth_begin(p_org uuid,p_device uuid,p_code text,p_network text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; c private.kiosk_credentials; b private.auth_attempt_buckets; n private.kiosk_network_buckets;
 t timestamptz; subject text:=encode(sha256(convert_to('device','UTF8')),'hex'); blocked boolean;
begin
 perform private.kiosk_scope(p_org,p_device,null,false);
 perform 1 from public.organizations where id=p_org and status='ACTIVE' for update;
 perform private.kiosk_access(p_org,p_device,null,false);
 t:=clock_timestamp();
 if p_network is null or p_network !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 insert into private.kiosk_network_buckets(organization_id,subject_hash,window_start)
 values(p_org,p_network,t) on conflict do nothing;
 select * into n from private.kiosk_network_buckets where organization_id=p_org and subject_hash=p_network for update;
 if n.window_start<=t-interval '15 minutes' and coalesce(n.locked_until,t)<=t then
  update private.kiosk_network_buckets set failures=0,window_start=t,locked_until=null where organization_id=p_org and subject_hash=p_network;
  n.locked_until:=null;
 end if;
 insert into private.auth_attempt_buckets(organization_id,device_id,subject_hash,window_start)
 values(p_org,p_device,subject,t) on conflict do nothing;
 select * into b from private.auth_attempt_buckets where organization_id=p_org and device_id=p_device and subject_hash=subject for update;
 if b.window_start<=t-interval '15 minutes' and coalesce(b.locked_until,t)<=t then
  update private.auth_attempt_buckets set failures=0,window_start=t,locked_until=null
   where organization_id=p_org and device_id=p_device and subject_hash=subject;
  b.failures:=0; b.locked_until:=null;
 end if;
 select id into e from public.employees where organization_id=p_org and code=p_code and active;
 select * into c from private.kiosk_credentials where organization_id=p_org and employee_id=e for update;
 if c.window_start<=t-interval '15 minutes' and coalesce(c.locked_until,t)<=t then
  update private.kiosk_credentials set failed_attempts=0,window_start=t,locked_until=null where organization_id=p_org and employee_id=e;
  c.failed_attempts:=0; c.locked_until:=null;
 end if;
 blocked:=coalesce(n.locked_until>t,false) or coalesce(b.locked_until>t,false) or coalesce(c.locked_until>t,false);
 if not blocked then
  update private.kiosk_network_buckets set failures=failures+1,locked_until=case when failures+1>=60 then t+interval '15 minutes' else null end
   where organization_id=p_org and subject_hash=p_network;
  update private.auth_attempt_buckets set failures=failures+1,locked_until=case when failures+1>=30 then t+interval '15 minutes' else null end
   where organization_id=p_org and device_id=p_device and subject_hash=subject;
  update private.kiosk_credentials set failed_attempts=failed_attempts+1,locked_until=case when failed_attempts+1>=5 then t+interval '15 minutes' else null end
   where organization_id=p_org and employee_id=e;
 end if;
 return jsonb_build_object('employee_id',e,'pin_hash',c.pin_hash,'credential_version',c.credential_version,'blocked',blocked);
end $$;

create function private.kiosk_auth_finish(p_org uuid,p_device uuid,p_employee uuid,p_version bigint,p_action public.time_action,p_expected bigint,p_request uuid,p_hash text,p_network text) returns void
language plpgsql security definer set search_path='' as $$
declare t timestamptz:=clock_timestamp();
begin
 if p_org is distinct from private.scoped_tenant('kiosk_device') or p_device is distinct from private.scoped_subject('kiosk_device')
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.kiosk_access(p_org,p_device,p_employee,false);
 update private.kiosk_credentials set failed_attempts=greatest(0,failed_attempts-1),locked_until=null
 where organization_id=p_org and employee_id=p_employee and credential_version=p_version;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 update private.auth_attempt_buckets set failures=greatest(0,failures-1),locked_until=null where organization_id=p_org and device_id=p_device;
 update private.kiosk_network_buckets set failures=greatest(0,failures-1),locked_until=null where organization_id=p_org and subject_hash=p_network;
 insert into private.kiosk_challenges(organization_id,device_id,employee_id,action,expected_version,request_id,token_hash,credential_version,created_at,expires_at)
 values(p_org,p_device,p_employee,p_action,p_expected,p_request,p_hash,p_version,t,t+interval '60 seconds');
end $$;

create function private.kiosk_record_event(p_org uuid,p_device uuid,p_employee uuid,p_action public.time_action,p_expected bigint,p_request uuid,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.kiosk_challenges; r jsonb;
begin
 perform private.kiosk_scope(p_org,p_device,p_employee,false);
 perform 1 from public.organizations where id=p_org and status='ACTIVE' for update;
 perform private.kiosk_access(p_org,p_device,p_employee,false);
 select * into c from private.kiosk_challenges where organization_id=p_org and device_id=p_device and employee_id=p_employee
  and token_hash=p_hash and action=p_action and expected_version=p_expected and request_id=p_request for update;
 if not FOUND or not exists(select 1 from private.kiosk_credentials where organization_id=p_org and employee_id=p_employee and credential_version=c.credential_version)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if c.used_at is not null then
  -- Consumed challenge is only a receipt-recovery capability for this exact tuple.
  select response into r from private.idempotency_records where organization_id=p_org and principal_kind='KIOSK' and principal_id=p_device
   and operation='kiosk_record_event' and key=p_request
   and payload_sha256=encode(sha256(convert_to(jsonb_build_array(p_employee,p_action,p_expected)::text,'UTF8')),'hex');
  if r is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  return r;
 end if;
 if c.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 r:=private.apply_time_event(p_org,p_request,p_employee,p_action,p_expected,null,p_device);
 update private.kiosk_challenges set used_at=clock_timestamp() where id=c.id;
 return r;
end $$;

do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='private'::regnamespace
 and proname in ('kiosk_admin_prepare','kiosk_admin_apply','kiosk_auth_begin','kiosk_auth_finish','kiosk_record_event') loop
 execute format('alter function %s owner to fichaje_kiosk',f);
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to fichaje_gateway',f);
 end loop;
end $$;
revoke create on schema private from fichaje_kiosk,fichaje_guard;

-- Column grants and per-route policies narrow the internal writer further:
-- clocking cannot provision/revoke/reset a credential even inside its tenant.
revoke update on private.kiosk_devices,private.kiosk_credentials,private.kiosk_challenges,private.auth_attempt_buckets from fichaje_kiosk;
grant update(active) on private.kiosk_devices to fichaje_kiosk;
grant update(pin_hash,credential_version,failed_attempts,window_start,locked_until,changed_at) on private.kiosk_credentials to fichaje_kiosk;
grant update(used_at) on private.kiosk_challenges to fichaje_kiosk;
grant update(window_start,failures,locked_until) on private.auth_attempt_buckets to fichaje_kiosk;
drop policy kiosk_access on private.kiosk_devices;
create policy kiosk_device_read on private.kiosk_devices for select to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_admin') or
 (organization_id=coalesce(private.scoped_tenant('kiosk_device'),private.scoped_tenant('kiosk_clock')) and auth_user_id=private.request_uid()));
create policy kiosk_device_insert on private.kiosk_devices for insert to fichaje_kiosk with check(organization_id=private.scoped_tenant('kiosk_admin'));
create policy kiosk_device_update on private.kiosk_devices for update to fichaje_kiosk using(organization_id=private.scoped_tenant('kiosk_admin')) with check(organization_id=private.scoped_tenant('kiosk_admin'));
drop policy kiosk_access on private.kiosk_credentials;
create policy kiosk_credential_read on private.kiosk_credentials for select to fichaje_kiosk using(
 organization_id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device')) or
 (organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock')));
create policy kiosk_credential_insert on private.kiosk_credentials for insert to fichaje_kiosk with check(organization_id=private.scoped_tenant('kiosk_admin'));
create policy kiosk_credential_update on private.kiosk_credentials for update to fichaje_kiosk using(
 organization_id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device')))
 with check(organization_id=coalesce(private.scoped_tenant('kiosk_admin'),private.scoped_tenant('kiosk_device')));
drop policy kiosk_access on private.kiosk_challenges;
create policy kiosk_challenge_read on private.kiosk_challenges for select to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock') and
 device_id in (select id from private.kiosk_devices where auth_user_id=private.request_uid()));
create policy kiosk_challenge_insert on private.kiosk_challenges for insert to fichaje_kiosk with check(
 organization_id=private.scoped_tenant('kiosk_device') and device_id=private.scoped_subject('kiosk_device'));
create policy kiosk_challenge_update on private.kiosk_challenges for update to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock') and
 device_id in (select id from private.kiosk_devices where auth_user_id=private.request_uid()))
 with check(organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock'));
drop policy kiosk_access on private.auth_attempt_buckets;
create policy kiosk_attempt on private.auth_attempt_buckets to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_device') and device_id=private.scoped_subject('kiosk_device'))
 with check(organization_id=private.scoped_tenant('kiosk_device') and device_id=private.scoped_subject('kiosk_device'));
drop policy kiosk_clock on public.time_events;
create policy kiosk_clock on public.time_events to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock'))
 with check(organization_id=private.scoped_tenant('kiosk_clock') and employee_id=private.scoped_subject('kiosk_clock')
 and source='KIOSK' and actor_membership_id is null and kiosk_device_id in
 (select id from private.kiosk_devices where auth_user_id=private.request_uid()));

revoke update on private.kiosk_network_buckets from fichaje_kiosk;
grant update(window_start,failures,locked_until) on private.kiosk_network_buckets to fichaje_kiosk;
drop policy kiosk_access on private.kiosk_network_buckets;
create policy kiosk_network on private.kiosk_network_buckets to fichaje_kiosk
 using(organization_id=private.scoped_tenant('kiosk_device'))
 with check(organization_id=private.scoped_tenant('kiosk_device'));
