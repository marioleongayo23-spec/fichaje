-- H2 only. H1 functions, roles, capabilities and policies remain unchanged.
create type public.clock_state as enum ('OUT','WORKING','PAUSED');
create type public.time_action as enum ('CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT');
create table public.work_policies (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete restrict,
 version bigint not null check(version>0), timezone text not null,
 break_counts_as_work boolean not null, valid_from timestamptz not null,
 created_by uuid not null, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,version),
 foreign key(organization_id,created_by) references public.memberships(organization_id,id) on delete restrict
);
create function private.validate_timezone() returns trigger language plpgsql set search_path='' as $$
begin
 if new.timezone !~ '^[A-Za-z_]+/[A-Za-z_+-]+(/[A-Za-z_+-]+)?$'
 or not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone)
 then raise exception using errcode='22023',message='INVALID_TIMEZONE'; end if;
 return new;
end $$;
revoke all on function private.validate_timezone() from public,anon,authenticated,service_role;
create trigger policy_timezone before insert on public.work_policies for each row execute function private.validate_timezone();
create table public.employee_policy_assignments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid not null, policy_id uuid not null, effective_from timestamptz not null,
 created_by uuid not null, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,employee_id,effective_from),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,policy_id) references public.work_policies(organization_id,id) on delete restrict,
 foreign key(organization_id,created_by) references public.memberships(organization_id,id) on delete restrict
);
create table public.work_sessions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 policy_id uuid not null, timezone text not null, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,employee_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,policy_id) references public.work_policies(organization_id,id) on delete restrict
);
create table private.employee_state (
 organization_id uuid not null, employee_id uuid not null,
 state public.clock_state not null default 'OUT', open_session_id uuid,
 version bigint not null default 0 check(version>=0), last_sequence bigint not null default 0 check(last_sequence>=0),
 last_event_at timestamptz,
 primary key(organization_id,employee_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,employee_id,open_session_id) references public.work_sessions(organization_id,employee_id,id) on delete restrict,
 check((state='OUT' and open_session_id is null) or (state<>'OUT' and open_session_id is not null)),
 check((last_sequence=0 and last_event_at is null) or (last_sequence>0 and last_event_at is not null))
);
create table public.time_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 session_id uuid not null, sequence bigint not null check(sequence>0), event_type public.time_action not null,
 server_at timestamptz not null, actor_membership_id uuid not null,
 source text not null check(source='WEB'), request_id uuid not null,
 unique(organization_id,id), unique(organization_id,employee_id,sequence),
 foreign key(organization_id,employee_id,session_id) references public.work_sessions(organization_id,employee_id,id) on delete restrict,
 foreign key(organization_id,actor_membership_id) references public.memberships(organization_id,id) on delete restrict
);
create index time_events_session on public.time_events(organization_id,session_id,sequence);
create index sessions_employee on public.work_sessions(organization_id,employee_id,created_at);
-- Same protected member capability as H1; no global writer or client-settable scope.
do $$ declare t text; begin
 foreach t in array array['public.work_policies','public.employee_policy_assignments','public.work_sessions','public.time_events','private.employee_state'] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('revoke all on %s from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on %s to fichaje_writer',t);
  execute format('create policy writer_access on %s to fichaje_writer using(organization_id=private.scoped_tenant(''member'')) with check(organization_id=private.scoped_tenant(''member''))',t);
  if t<>'private.employee_state' then
   execute format('grant select on %s to authenticated',t);
   execute format('create trigger immutable before update or delete or truncate on %s for each statement execute function private.immutable_record()',t);
  end if;
 end loop;
end $$;
grant update on private.employee_state to fichaje_writer;
create policy own_read on public.employee_policy_assignments for select to authenticated using(
 private.current_role(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=employee_policy_assignments.organization_id and e.id=employee_policy_assignments.employee_id));
create policy own_read on public.work_sessions for select to authenticated using(
 private.current_role(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=work_sessions.organization_id and e.id=work_sessions.employee_id));
create policy own_read on public.time_events for select to authenticated using(
 private.current_role(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=time_events.organization_id and e.id=time_events.employee_id));
create policy own_read on public.work_policies for select to authenticated using(
 private.current_role(organization_id) in ('OWNER','ADMIN') or
 (private.current_role(organization_id)='EMPLOYEE' and exists(select 1 from public.employee_policy_assignments a
 where a.organization_id=work_policies.organization_id and a.policy_id=work_policies.id)));
-- Invoker trigger: never lends a definer capability. H1 employee creation and this
-- projection either commit together or both roll back. Existing employees get OUT.
create function private.initialize_employee_state() returns trigger language plpgsql set search_path='' as $$
begin
 insert into private.employee_state(organization_id,employee_id) values(new.organization_id,new.id);
 return new;
end $$;
revoke all on function private.initialize_employee_state() from public,anon,authenticated,service_role;
create trigger employee_initial_state after insert on public.employees for each row execute function private.initialize_employee_state();
insert into private.employee_state(organization_id,employee_id) select organization_id,id from public.employees;

create function private.check_clock(p_last timestamptz,p_now timestamptz) returns void language plpgsql set search_path='' as $$
begin
 if p_now is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if p_now<p_last then raise exception using errcode='22023',message='CLOCK_REGRESSION'; end if;
end $$;
revoke all on function private.check_clock(timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.check_clock(timestamptz,timestamptz) to fichaje_writer;
grant create on schema public to fichaje_writer;

create function public.create_work_policy(p_organization_id uuid,p_request_id uuid,p_timezone text,p_break_counts_as_work boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; payload jsonb:=jsonb_build_array(p_timezone,p_break_counts_as_work); t timestamptz; actor uuid; v public.work_policies;
begin
 if private.authorize(p_organization_id) not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 r:=private.replay(p_organization_id,p_request_id,'create_work_policy',payload);
 if r is not null then return r; end if;
 if p_timezone is null or p_break_counts_as_work is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 t:=clock_timestamp();
 select id into actor from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid();
 insert into public.work_policies(organization_id,version,timezone,break_counts_as_work,valid_from,created_by,created_at)
 select p_organization_id,coalesce(max(version),0)+1,p_timezone,p_break_counts_as_work,t,actor,t
 from public.work_policies where organization_id=p_organization_id returning * into v;
 return private.receipt(p_organization_id,p_request_id,'create_work_policy',payload,jsonb_build_object('id',v.id,'version',v.version),
 'work_policies',v.id,jsonb_build_object('timezone',v.timezone,'break_counts_as_work',v.break_counts_as_work,'version',v.version));
end $$;
alter function public.create_work_policy(uuid,uuid,text,boolean) owner to fichaje_writer;
revoke all on function public.create_work_policy(uuid,uuid,text,boolean) from public,anon,service_role;
grant execute on function public.create_work_policy(uuid,uuid,text,boolean) to authenticated;

create function public.assign_work_policy(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_policy_id uuid,p_effective_from timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; payload jsonb:=jsonb_build_array(p_employee_id,p_policy_id,p_effective_from); t timestamptz; actor uuid; v_id uuid;
begin
 if private.authorize(p_organization_id) not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 r:=private.replay(p_organization_id,p_request_id,'assign_work_policy',payload);
 if r is not null then return r; end if;
 perform 1 from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 t:=clock_timestamp();
 if p_effective_from<t then raise exception using errcode='22023',message='POLICY_BACKDATE'; end if;
 if not exists(select 1 from public.work_policies where organization_id=p_organization_id and id=p_policy_id and valid_from<=coalesce(p_effective_from,t))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select id into actor from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid();
 insert into public.employee_policy_assignments(organization_id,employee_id,policy_id,effective_from,created_by,created_at)
 values(p_organization_id,p_employee_id,p_policy_id,coalesce(p_effective_from,t),actor,t) returning id into v_id;
 return private.receipt(p_organization_id,p_request_id,'assign_work_policy',payload,jsonb_build_object('id',v_id),
 'employee_policy_assignments',v_id,jsonb_build_object('employee_id',p_employee_id,'policy_id',p_policy_id,'effective_from',coalesce(p_effective_from,t)));
end $$;
alter function public.assign_work_policy(uuid,uuid,uuid,uuid,timestamptz) owner to fichaje_writer;
revoke all on function public.assign_work_policy(uuid,uuid,uuid,uuid,timestamptz) from public,anon,service_role;
grant execute on function public.assign_work_policy(uuid,uuid,uuid,uuid,timestamptz) to authenticated;

create function public.record_time_event(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_action public.time_action,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.employee_state; actor uuid; t timestamptz; next_state public.clock_state; session uuid;
 event uuid:=gen_random_uuid(); policy public.work_policies; r jsonb;
 payload jsonb:=jsonb_build_array(p_employee_id,p_action,p_expected_version);
begin
 -- Lock order shared with H1: organization, then employee state. Serializing by
 -- tenant deliberately favors correct revocation over throughput in V1.
 perform private.authorize(p_organization_id);
 select m.id into actor from public.memberships m join public.employees e
 on e.organization_id=m.organization_id and e.membership_id=m.id
 where m.organization_id=p_organization_id and m.auth_user_id=private.request_uid() and m.active and e.active and e.id=p_employee_id;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into s from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id for update;
 if not FOUND then raise exception using errcode='55000',message='STATE_MISSING'; end if;
 -- Authorization precedes receipt recovery, even for previously successful requests.
 r:=private.replay(p_organization_id,p_request_id,'record_time_event',payload);
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
 perform private.check_clock(s.last_event_at,t);
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
 insert into public.time_events(id,organization_id,employee_id,session_id,sequence,event_type,server_at,actor_membership_id,source,request_id)
 values(event,p_organization_id,p_employee_id,session,s.last_sequence+1,p_action,t,actor,'WEB',p_request_id);
 update private.employee_state set state=next_state,open_session_id=case when next_state='OUT' then null else session end,
 version=s.version+1,last_sequence=s.last_sequence+1,last_event_at=t where organization_id=p_organization_id and employee_id=p_employee_id;
 r:=jsonb_build_object('event_id',event,'session_id',session,'server_at',t,'state',next_state,'version',s.version+1,'sequence',s.last_sequence+1,'request_id',p_request_id);
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id,server_at,safe_details)
 values(p_organization_id,'USER',private.request_uid(),p_employee_id,'record_time_event','time_events',event,p_request_id,t,
 jsonb_build_object('event_type',p_action,'session_id',session,'sequence',s.last_sequence+1,'before',jsonb_build_object('state',s.state,'version',s.version),
 'after',jsonb_build_object('state',next_state,'version',s.version+1)));
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response,created_at)
 values(p_organization_id,'USER',private.request_uid(),'record_time_event',p_request_id,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),r,t);
 return r;
end $$;
alter function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) owner to fichaje_writer;
revoke all on function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) from public,anon,service_role;
grant execute on function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) to authenticated;

-- Authorized operational state, not an hours report. Open sessions stay explicitly
-- incomplete indefinitely, including after midnight. No scheduled auto-close job.
create function public.get_employee_state(p_organization_id uuid,p_employee_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.member_role; s private.employee_state;
begin
 r:=private.authorize(p_organization_id);
 if not exists(select 1 from public.employees e where e.organization_id=p_organization_id and e.id=p_employee_id
 and (r in ('OWNER','ADMIN') or e.membership_id in (select id from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid() and active)))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into strict s from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id;
 return jsonb_build_object('state',s.state,'version',s.version,'last_sequence',s.last_sequence,'last_event_at',s.last_event_at,
 'open_session_id',s.open_session_id,'incident',case when s.state<>'OUT' then 'OPEN_SESSION' else null end);
end $$;
alter function public.get_employee_state(uuid,uuid) owner to fichaje_writer;
revoke all on function public.get_employee_state(uuid,uuid) from public,anon,service_role;
grant execute on function public.get_employee_state(uuid,uuid) to authenticated;
revoke create on schema public from fichaje_writer;
