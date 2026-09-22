-- H2 employee clock capability. The H1 member gate remains manager-only.
create role fichaje_clock nologin noinherit;
create role fichaje_state_reader nologin noinherit;
grant fichaje_clock,fichaje_state_reader to postgres;
grant usage on schema public,private to fichaje_clock,fichaje_state_reader;
grant create on schema public to fichaje_clock,fichaje_state_reader;
grant create on schema private to fichaje_guard;
alter table private.mutation_context drop constraint mutation_context_route_check;
alter table private.mutation_context add constraint mutation_context_route_check
 check(route in ('member','bootstrap','invitation','clock'));
grant select on public.employees to fichaje_guard;
create policy guard_clock_read on public.employees for select to fichaje_guard using(true);

create function private.clock_scope(p_org uuid,p_employee uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 if private.current_role(p_org) is null or not exists(
  select 1 from public.employees e join public.memberships m
  on m.organization_id=e.organization_id and m.id=e.membership_id
  where e.organization_id=p_org and e.id=p_employee and e.active
  and m.auth_user_id=private.request_uid() and m.active)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.bind_context(p_org,'clock',p_employee);
end $$;
alter function private.clock_scope(uuid,uuid) owner to fichaje_guard;
revoke all on function private.clock_scope(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.clock_scope(uuid,uuid) to fichaje_clock;
revoke create on schema private from fichaje_guard;
grant execute on function private.request_uid(),private.current_role(uuid),
 private.scoped_tenant(text),private.scoped_subject(text) to fichaje_clock;
grant execute on function private.check_clock(timestamptz,timestamptz),
 private.replay(uuid,uuid,text,jsonb) to fichaje_clock;
grant select,update(id) on public.organizations to fichaje_clock;
create policy clock_lock on public.organizations to fichaje_clock
 using(id=private.scoped_tenant('clock')) with check(id=private.scoped_tenant('clock'));
grant select on public.memberships,public.employees,public.work_policies,
 public.employee_policy_assignments,public.work_sessions,public.time_events,
 private.employee_state,private.idempotency_records to fichaje_clock;
create policy clock_member on public.memberships for select to fichaje_clock
 using(organization_id=private.scoped_tenant('clock') and auth_user_id=private.request_uid() and active);
create policy clock_employee on public.employees for select to fichaje_clock
 using(organization_id=private.scoped_tenant('clock') and id=private.scoped_subject('clock'));
create policy clock_policy on public.work_policies for select to fichaje_clock
 using(organization_id=private.scoped_tenant('clock'));
create policy clock_assignment on public.employee_policy_assignments for select to fichaje_clock
 using(organization_id=private.scoped_tenant('clock') and employee_id=private.scoped_subject('clock'));
grant insert on public.work_sessions,public.time_events,public.audit_log,private.idempotency_records to fichaje_clock;
grant update on private.employee_state to fichaje_clock;
do $$ declare t text; begin
 foreach t in array array['public.work_sessions','public.time_events','private.employee_state'] loop
  execute format('create policy clock_access on %s to fichaje_clock
   using(organization_id=private.scoped_tenant(''clock'') and employee_id=private.scoped_subject(''clock''))
   with check(organization_id=private.scoped_tenant(''clock'') and employee_id=private.scoped_subject(''clock''))',t);
 end loop;
end $$;
create policy clock_audit on public.audit_log for insert to fichaje_clock
 with check(organization_id=private.scoped_tenant('clock') and employee_id=private.scoped_subject('clock')
 and actor_kind='USER' and actor_id=private.request_uid() and action='record_time_event' and entity_type='time_events');
create policy clock_receipt on private.idempotency_records to fichaje_clock
 using(organization_id=private.scoped_tenant('clock') and principal_kind='USER'
 and principal_id=private.request_uid() and operation='record_time_event')
 with check(organization_id=private.scoped_tenant('clock') and principal_kind='USER'
 and principal_id=private.request_uid() and operation='record_time_event');

-- Read-only operational view: manager or own employee, including inactive history.
-- This role cannot bind any mutation capability or write any table.
grant execute on function private.request_uid(),private.current_role(uuid) to fichaje_state_reader;
grant select on public.memberships,public.employees,private.employee_state to fichaje_state_reader;
create policy state_member on public.memberships for select to fichaje_state_reader
 using(private.current_role(organization_id) is not null and auth_user_id=private.request_uid() and active);
create policy state_employee on public.employees for select to fichaje_state_reader
 using(private.current_role(organization_id) in ('OWNER','ADMIN') or
 (private.current_role(organization_id)='EMPLOYEE' and membership_id in
 (select id from public.memberships where organization_id=employees.organization_id)));
create policy state_read on private.employee_state for select to fichaje_state_reader
 using(exists(select 1 from public.employees e where e.organization_id=employee_state.organization_id and e.id=employee_state.employee_id));

create or replace function public.record_time_event(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_action public.time_action,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.employee_state; actor uuid; t timestamptz; next_state public.clock_state; session uuid;
 event uuid:=gen_random_uuid(); policy public.work_policies; r jsonb;
 payload jsonb:=jsonb_build_array(p_employee_id,p_action,p_expected_version);
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
alter function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) owner to fichaje_clock;
revoke all on function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) from public,anon,service_role;
grant execute on function public.record_time_event(uuid,uuid,uuid,public.time_action,bigint) to authenticated;

create or replace function public.get_employee_state(p_organization_id uuid,p_employee_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.member_role; s private.employee_state;
begin
 r:=private.current_role(p_organization_id);
 if r is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if not exists(select 1 from public.employees e where e.organization_id=p_organization_id and e.id=p_employee_id
 and (r in ('OWNER','ADMIN') or e.membership_id in (select id from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid() and active)))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into strict s from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id;
 return jsonb_build_object('state',s.state,'version',s.version,'last_sequence',s.last_sequence,'last_event_at',s.last_event_at,
 'open_session_id',s.open_session_id,'incident',case when s.state<>'OUT' then 'OPEN_SESSION' else null end);
end $$;
alter function public.get_employee_state(uuid,uuid) owner to fichaje_state_reader;
revoke all on function public.get_employee_state(uuid,uuid) from public,anon,service_role;
grant execute on function public.get_employee_state(uuid,uuid) to authenticated;
revoke create on schema public from fichaje_clock,fichaje_state_reader;
