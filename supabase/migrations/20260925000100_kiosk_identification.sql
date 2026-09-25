-- KIO-H6-01: a kiosk cannot know state or version before the employee proves
-- code+PIN. After verification the server resolves employee, authoritative
-- state and version itself and issues one independent challenge per legal
-- action. Executing any challenge of a grant consumes all its siblings.
-- Unchanged: Argon2id+pepper in the gateway, reservations and rate limits,
-- minimized network digest, hashed challenges, H2 engine, idempotent receipts.
grant create on schema private to fichaje_kiosk,fichaje_guard;
alter table private.mutation_context drop constraint mutation_context_route_check;
alter table private.mutation_context add constraint mutation_context_route_check
 check(route in ('member','bootstrap','invitation','clock','correction_submit','correction_decide',
 'kiosk_admin','kiosk_device','kiosk_clock','report','kiosk_grant'));

-- Legacy rows (single-action H4 challenges) expire within 60 seconds; every new
-- challenge belongs to exactly one grant and a grant holds one per action.
alter table private.kiosk_challenges add column grant_id uuid;
alter table private.kiosk_challenges add constraint kiosk_challenge_grant check(grant_id is not null) not valid;
create unique index kiosk_challenge_grant_action on private.kiosk_challenges(organization_id,grant_id,action);

-- 'kiosk_grant' only lets the grant function read the one verified employee's
-- projection. It confers no write, event, history, directory or receipt access.
create policy kiosk_grant_state on private.employee_state for select to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_grant') and employee_id=private.scoped_subject('kiosk_grant'));
-- Device scope may resolve which employee its own challenge was issued to.
create policy kiosk_challenge_lookup on private.kiosk_challenges for select to fichaje_kiosk using(
 organization_id=private.scoped_tenant('kiosk_device') and device_id=private.scoped_subject('kiosk_device') and
 device_id in (select id from private.kiosk_devices where auth_user_id=private.request_uid()));

create function private.kiosk_grant_scope(p_org uuid,p_device uuid,p_employee uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_employee is null or p_org is distinct from private.scoped_tenant('kiosk_device')
 or p_device is distinct from private.scoped_subject('kiosk_device')
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.kiosk_access(p_org,p_device,p_employee,false);
 -- Called while holding the H1 tenant lock: add this transaction's row only and
 -- never clean up other contexts (a waiter may hold one; RACE-01).
 insert into private.mutation_context values(pg_current_xact_id(),pg_backend_pid(),'kiosk_grant',p_org,private.request_uid(),p_employee,null)
 on conflict do nothing;
 if not exists(select 1 from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route='kiosk_grant' and organization_id=p_org and principal_id is not distinct from private.request_uid() and subject_id=p_employee)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
end $$;
alter function private.kiosk_grant_scope(uuid,uuid,uuid) owner to fichaje_guard;
revoke all on function private.kiosk_grant_scope(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.kiosk_grant_scope(uuid,uuid,uuid) to fichaje_kiosk;

-- Same transaction as kiosk_auth_begin, which holds the tenant lock and has
-- reserved the failure. The client never names the employee, action or version.
create function private.kiosk_auth_grant(p_org uuid,p_device uuid,p_code text,p_version bigint,p_network text,p_hashes jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid; s private.employee_state; t timestamptz:=clock_timestamp(); g uuid:=gen_random_uuid();
 legal public.time_action[]; offered jsonb:='[]'::jsonb; req uuid;
begin
 if p_org is distinct from private.scoped_tenant('kiosk_device') or p_device is distinct from private.scoped_subject('kiosk_device')
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if jsonb_typeof(p_hashes) is distinct from 'array' or jsonb_array_length(p_hashes)<>2
 or p_hashes->>0 !~ '^[0-9a-f]{64}$' or p_hashes->>1 !~ '^[0-9a-f]{64}$' or p_hashes->>0=p_hashes->>1
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select id into e from public.employees where organization_id=p_org and code=p_code and active;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.kiosk_access(p_org,p_device,e,false);
 update private.kiosk_credentials set failed_attempts=greatest(0,failed_attempts-1),locked_until=null
 where organization_id=p_org and employee_id=e and credential_version=p_version;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 update private.auth_attempt_buckets set failures=greatest(0,failures-1),locked_until=null where organization_id=p_org and device_id=p_device;
 update private.kiosk_network_buckets set failures=greatest(0,failures-1),locked_until=null where organization_id=p_org and subject_hash=p_network;
 perform private.kiosk_grant_scope(p_org,p_device,e);
 select * into s from private.employee_state where organization_id=p_org and employee_id=e;
 if not FOUND then raise exception using errcode='55000',message='STATE_MISSING'; end if;
 -- Offer exactly the H2 transitions that are legal from the authoritative state.
 legal:=case s.state when 'OUT' then array['CLOCK_IN'] when 'WORKING' then array['BREAK_START','CLOCK_OUT']
  when 'PAUSED' then array['BREAK_END','CLOCK_OUT'] end::public.time_action[];
 for i in 1..cardinality(legal) loop
  req:=gen_random_uuid();
  insert into private.kiosk_challenges(organization_id,device_id,employee_id,action,expected_version,request_id,token_hash,
   credential_version,grant_id,created_at,expires_at)
  values(p_org,p_device,e,legal[i],s.version,req,p_hashes->>(i-1),p_version,g,t,t+interval '60 seconds');
  offered:=offered||jsonb_build_array(jsonb_build_object('action',legal[i],'request_id',req));
 end loop;
 return jsonb_build_object('state',s.state,'version',s.version,'challenges',offered);
end $$;

-- Unchanged tuple binding, receipt recovery and H2 engine; a successful event
-- additionally consumes every sibling of the same grant in the same transaction.
create or replace function private.kiosk_record_event(p_org uuid,p_device uuid,p_employee uuid,p_action public.time_action,p_expected bigint,p_request uuid,p_hash text) returns jsonb
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
 update private.kiosk_challenges set used_at=clock_timestamp() where id=c.id
  or (organization_id=p_org and grant_id=c.grant_id and used_at is null);
 return r;
end $$;

-- Device scope for the challenge lookup only. Insert-only: kiosk_record_event
-- binds (and cleans stale contexts) next, and two cleanup DELETEs with
-- different snapshots in one transaction can deadlock concurrent double clicks.
create function private.kiosk_lookup_scope(p_org uuid,p_device uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.kiosk_access(p_org,p_device,null,false);
 insert into private.mutation_context values(pg_current_xact_id(),pg_backend_pid(),'kiosk_device',p_org,private.request_uid(),p_device,null)
 on conflict do nothing;
 if not exists(select 1 from private.mutation_context where transaction_id=pg_current_xact_id() and backend_pid=pg_backend_pid()
 and route='kiosk_device' and organization_id=p_org and principal_id is not distinct from private.request_uid() and subject_id=p_device)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
end $$;
alter function private.kiosk_lookup_scope(uuid,uuid) owner to fichaje_guard;
revoke all on function private.kiosk_lookup_scope(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.kiosk_lookup_scope(uuid,uuid) to fichaje_kiosk;

-- Gateway entrypoint: the challenge, not the client, identifies the employee.
create function private.kiosk_record(p_org uuid,p_device uuid,p_action public.time_action,p_expected bigint,p_request uuid,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e uuid;
begin
 perform private.kiosk_lookup_scope(p_org,p_device);
 select employee_id into e from private.kiosk_challenges where organization_id=p_org and device_id=p_device and token_hash=p_hash;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 return private.kiosk_record_event(p_org,p_device,e,p_action,p_expected,p_request,p_hash);
end $$;

-- The single-action issuer is removed; the full-tuple writer becomes internal.
drop function private.kiosk_auth_finish(uuid,uuid,uuid,bigint,public.time_action,bigint,uuid,text,text);
revoke all on function private.kiosk_record_event(uuid,uuid,uuid,public.time_action,bigint,uuid,text) from fichaje_gateway;
do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='private'::regnamespace
 and proname in ('kiosk_auth_grant','kiosk_record') loop
 execute format('alter function %s owner to fichaje_kiosk',f);
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to fichaje_gateway',f);
 end loop;
end $$;
revoke create on schema private from fichaje_kiosk,fichaje_guard;
