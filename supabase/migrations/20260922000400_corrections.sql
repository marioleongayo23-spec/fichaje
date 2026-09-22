-- H3: isolated correction capabilities; H1/H2 gates and grants are unchanged.
create role fichaje_correction nologin noinherit;
grant fichaje_correction to postgres;
grant usage,create on schema public,private to fichaje_correction;
grant create on schema private to fichaje_guard;
alter table private.mutation_context drop constraint mutation_context_route_check;
alter table private.mutation_context add constraint mutation_context_route_check
 check(route in ('member','bootstrap','invitation','clock','correction_submit','correction_decide'));

create table public.correction_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid not null, submitted_by_membership_id uuid not null,
 base_version bigint not null check(base_version>=0),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 proposal jsonb not null check(jsonb_typeof(proposal)='array' and octet_length(proposal::text)<=65536),
 created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,employee_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,submitted_by_membership_id) references public.memberships(organization_id,id) on delete restrict
);
create table public.correction_decisions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 request_id uuid not null, decision text not null check(decision in ('APPROVE','REJECT')),
 actor_membership_id uuid not null, reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null, unique(organization_id,id), unique(organization_id,employee_id,id),
 unique(organization_id,request_id),
 foreign key(organization_id,employee_id,request_id) references public.correction_requests(organization_id,employee_id,id) on delete restrict,
 foreign key(organization_id,actor_membership_id) references public.memberships(organization_id,id) on delete restrict
);
-- An immutable event sequence is a high-water mark, not the length of the effective
-- timeline: VOID may leave it empty and ADD may create a timeline without originals.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='private.employee_state'::regclass
 and contype='c' and pg_get_constraintdef(oid) like '%last_event_at%'
 loop execute format('alter table private.employee_state drop constraint %I',c.conname); end loop;
end $$;
alter table public.time_events add unique(organization_id,employee_id,id);
create table public.event_adjustments (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, employee_id uuid not null,
 decision_id uuid not null, target_event_id uuid, supersedes_adjustment_id uuid,
 operation text not null check(operation in ('ADD','REPLACE','VOID')),
 effective_at timestamptz, event_type public.time_action, session_id uuid not null,
 ordinal bigint, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,employee_id,id),
 foreign key(organization_id,employee_id,decision_id) references public.correction_decisions(organization_id,employee_id,id) on delete restrict,
 foreign key(organization_id,employee_id,target_event_id) references public.time_events(organization_id,employee_id,id) on delete restrict,
 foreign key(organization_id,employee_id,supersedes_adjustment_id) references public.event_adjustments(organization_id,employee_id,id) on delete restrict,
 foreign key(organization_id,employee_id,session_id) references public.work_sessions(organization_id,employee_id,id) on delete restrict,
 check((operation='ADD' and target_event_id is null and supersedes_adjustment_id is null)
 or (operation<>'ADD' and (target_event_id is not null or supersedes_adjustment_id is not null))),
 check((operation='VOID' and effective_at is null and event_type is null and ordinal is null)
 or (operation<>'VOID' and effective_at is not null and isfinite(effective_at) and event_type is not null and ordinal is not null and ordinal>0))
);
create unique index adjustment_successor on public.event_adjustments(organization_id,supersedes_adjustment_id) where supersedes_adjustment_id is not null;
create unique index adjustment_first on public.event_adjustments(organization_id,target_event_id) where target_event_id is not null and supersedes_adjustment_id is null;
create index requests_employee on public.correction_requests(organization_id,employee_id,created_at);
create index adjustments_employee on public.event_adjustments(organization_id,employee_id,created_at);

do $$ declare t text; begin
 foreach t in array array['correction_requests','correction_decisions','event_adjustments'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant select,insert on public.%I to fichaje_correction',t);
  execute format('create policy own_read on public.%I for select to authenticated using(private.current_role(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=%I.organization_id and e.id=%I.employee_id))',t,t,t);
  execute format('create trigger immutable before update or delete or truncate on public.%I for each statement execute function private.immutable_record()',t);
 end loop;
end $$;
-- Guard only validates identity and independence; no correction write grants.
grant select on public.correction_requests to fichaje_guard;
create policy guard_read on public.correction_requests for select to fichaje_guard using(true);
create function private.correction_access(p_org uuid,p_employee uuid,p_request uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; role public.member_role; affected uuid; requester uuid;
begin
 role:=private.current_role(p_org);
 if role is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select id into actor from public.memberships where organization_id=p_org and auth_user_id=private.request_uid() and active;
 select membership_id into affected from public.employees where organization_id=p_org and id=p_employee;
 if not FOUND or (role='EMPLOYEE' and affected is distinct from actor) then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_request is not null then
  select submitted_by_membership_id into requester from public.correction_requests
  where organization_id=p_org and employee_id=p_employee and id=p_request;
  if not FOUND or role not in ('OWNER','ADMIN') or actor=requester or actor=affected then
   raise exception using errcode='42501',message='FORBIDDEN'; end if;
 end if;
 return actor;
end $$;
alter function private.correction_access(uuid,uuid,uuid) owner to fichaje_guard;
revoke all on function private.correction_access(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.correction_access(uuid,uuid,uuid) to fichaje_correction;
create function private.correction_scope(p_org uuid,p_employee uuid,p_request uuid default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.correction_access(p_org,p_employee,p_request);
 perform private.bind_context(p_org,case when p_request is null then 'correction_submit' else 'correction_decide' end,p_employee);
end $$;
alter function private.correction_scope(uuid,uuid,uuid) owner to fichaje_guard;
revoke all on function private.correction_scope(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.correction_scope(uuid,uuid,uuid) to fichaje_correction;
-- Request resolution returns only an authorized subject, never an arbitrary tenant row.
create function private.correction_subject(p_org uuid,p_request uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare e uuid;
begin
 select employee_id into e from public.correction_requests where organization_id=p_org and id=p_request;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.correction_access(p_org,e,p_request);
 return e;
end $$;
alter function private.correction_subject(uuid,uuid) owner to fichaje_guard;
revoke all on function private.correction_subject(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.correction_subject(uuid,uuid) to fichaje_correction;
revoke create on schema private from fichaje_guard;
grant execute on function private.request_uid(),private.current_role(uuid),private.scoped_tenant(text),private.scoped_subject(text),private.replay(uuid,uuid,text,jsonb) to fichaje_correction;

create function private.correction_scoped(p_org uuid,p_employee uuid) returns boolean
language sql stable set search_path='' as $$
 select (p_org=private.scoped_tenant('correction_submit') and p_employee=private.scoped_subject('correction_submit'))
 or (p_org=private.scoped_tenant('correction_decide') and p_employee=private.scoped_subject('correction_decide'))
$$;
revoke all on function private.correction_scoped(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.correction_scoped(uuid,uuid) to fichaje_correction;
grant select,update(id) on public.organizations to fichaje_correction;
create policy correction_lock on public.organizations to fichaje_correction
 using(id=private.scoped_tenant('correction_submit') or id=private.scoped_tenant('correction_decide'))
 with check(id=private.scoped_tenant('correction_submit') or id=private.scoped_tenant('correction_decide'));
grant select on public.work_sessions,public.time_events,private.employee_state,public.work_policies,public.employee_policy_assignments to fichaje_correction;
grant insert on public.work_sessions,public.audit_log,private.idempotency_records to fichaje_correction;
grant select on private.idempotency_records to fichaje_correction;
grant update on private.employee_state to fichaje_correction;
do $$ declare t text; begin
 foreach t in array array['public.work_sessions','public.time_events','private.employee_state','public.employee_policy_assignments','public.correction_requests','public.correction_decisions','public.event_adjustments'] loop
  execute format('create policy correction_read on %s for select to fichaje_correction using(private.correction_scoped(organization_id,employee_id))',t);
 end loop;
 foreach t in array array['public.work_sessions','public.event_adjustments'] loop
  execute format('create policy correction_insert on %s for insert to fichaje_correction with check(organization_id=private.scoped_tenant(''correction_decide'') and employee_id=private.scoped_subject(''correction_decide''))',t);
 end loop;
end $$;
create policy correction_decision_insert on public.correction_decisions for insert to fichaje_correction
 with check(organization_id=private.scoped_tenant('correction_decide') and employee_id=private.scoped_subject('correction_decide')
 and actor_membership_id=private.correction_access(organization_id,employee_id,request_id));
create policy correction_submit on public.correction_requests for insert to fichaje_correction
 with check(organization_id=private.scoped_tenant('correction_submit') and employee_id=private.scoped_subject('correction_submit')
 and submitted_by_membership_id=private.correction_access(organization_id,employee_id));
create policy correction_state on private.employee_state for update to fichaje_correction
 using(organization_id=private.scoped_tenant('correction_decide') and employee_id=private.scoped_subject('correction_decide'))
 with check(organization_id=private.scoped_tenant('correction_decide') and employee_id=private.scoped_subject('correction_decide'));
-- SELECT FOR UPDATE requires an UPDATE policy even on submission. Lock via the
-- tenant row for submit; only approval locks/writes the employee projection.
create policy correction_policy on public.work_policies for select to fichaje_correction
 using(organization_id=private.scoped_tenant('correction_submit') or organization_id=private.scoped_tenant('correction_decide'));
create policy correction_receipt on private.idempotency_records to fichaje_correction
 using(principal_kind='USER' and principal_id=private.request_uid() and
 ((operation='submit_correction' and organization_id=private.scoped_tenant('correction_submit')) or
 (operation='decide_correction' and organization_id=private.scoped_tenant('correction_decide'))))
 with check(principal_kind='USER' and principal_id=private.request_uid() and
 ((operation='submit_correction' and organization_id=private.scoped_tenant('correction_submit')) or
 (operation='decide_correction' and organization_id=private.scoped_tenant('correction_decide'))));
create policy correction_audit on public.audit_log for insert to fichaje_correction
 with check(actor_kind='USER' and actor_id=private.request_uid() and
 ((action='submit_correction' and entity_type='correction_requests' and organization_id=private.scoped_tenant('correction_submit') and employee_id=private.scoped_subject('correction_submit')) or
 (action='decide_correction' and entity_type='correction_decisions' and organization_id=private.scoped_tenant('correction_decide') and employee_id=private.scoped_subject('correction_decide'))));

-- Security invoker: all inputs remain subject to the caller's tenant/employee RLS.
-- Cutoff filters both originals and adjustments; source and original timestamp
-- stay distinct from proposed effective time. A leaf VOID removes only that item.
create function private.effective_timeline(p_org uuid,p_employee uuid,p_cutoff timestamptz default 'infinity')
returns table(event_id uuid,adjustment_id uuid,session_id uuid,event_type public.time_action,
 server_at timestamptz,effective_at timestamptz,ordinal bigint,source text,actor_membership_id uuid)
language sql stable set search_path='' as $$
 with a as (select * from public.event_adjustments where organization_id=p_org and employee_id=p_employee and created_at<=p_cutoff)
 select e.id,null::uuid,e.session_id,e.event_type,e.server_at,e.server_at,e.sequence,e.source,e.actor_membership_id
 from public.time_events e where e.organization_id=p_org and e.employee_id=p_employee and e.server_at<=p_cutoff
 and not exists(select 1 from a where target_event_id=e.id)
 union all
 select a.target_event_id,a.id,a.session_id,a.event_type,e.server_at,a.effective_at,a.ordinal,'CORRECTION',d.actor_membership_id
 from a join public.correction_decisions d on d.organization_id=a.organization_id and d.id=a.decision_id
 left join public.time_events e on e.organization_id=a.organization_id and e.id=a.target_event_id
 where a.operation<>'VOID' and not exists(select 1 from a successor where successor.supersedes_adjustment_id=a.id)
$$;
revoke all on function private.effective_timeline(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.effective_timeline(uuid,uuid,timestamptz) to fichaje_correction;

-- Pure validation over the real persisted candidate (rolled back on any error).
create function private.validate_timeline(p_org uuid,p_employee uuid,p_now timestamptz) returns jsonb
language plpgsql set search_path='' as $$
declare x record; state public.clock_state:='OUT'; session uuid; seen uuid[]:='{}'; last_at timestamptz;
begin
 if exists(select 1 from private.effective_timeline(p_org,p_employee) group by effective_at,ordinal having count(*)>1)
 then raise exception using errcode='22023',message='INVALID_ORDINAL'; end if;
 for x in select * from private.effective_timeline(p_org,p_employee) order by effective_at,ordinal loop
  if not isfinite(x.effective_at) or x.effective_at>p_now then raise exception using errcode='22023',message='FUTURE_TIME'; end if;
  if x.event_type='CLOCK_IN' then
   if state<>'OUT' or x.session_id=any(seen) then raise exception using errcode='22023',message='INVALID_TIMELINE'; end if;
   session:=x.session_id; seen:=array_append(seen,session); state:='WORKING';
  else
   if session is distinct from x.session_id or state='OUT' then raise exception using errcode='22023',message='INVALID_TIMELINE'; end if;
   if x.event_type='BREAK_START' and state='WORKING' then state:='PAUSED';
   elsif x.event_type='BREAK_END' and state='PAUSED' then state:='WORKING';
   elsif x.event_type='CLOCK_OUT' and state in ('WORKING','PAUSED') then state:='OUT'; session:=null;
   else raise exception using errcode='22023',message='INVALID_TIMELINE'; end if;
  end if;
  last_at:=x.effective_at;
 end loop;
 return jsonb_build_object('state',state,'open_session_id',session,'last_event_at',last_at);
end $$;
revoke all on function private.validate_timeline(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.validate_timeline(uuid,uuid,timestamptz) to fichaje_correction;

-- Validate strict JSON and all references at submission AND after the approval lock.
create function private.validate_operations(p_org uuid,p_employee uuid,p_ops jsonb,p_now timestamptz) returns void
language plpgsql set search_path='' as $$
declare x jsonb; op text; target uuid; previous uuid; session uuid; at_time timestamptz;
 prior public.event_adjustments; original public.time_events; zone text;
begin
 if p_ops is null or jsonb_typeof(p_ops)<>'array' or octet_length(p_ops::text)>65536 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if jsonb_array_length(p_ops) not between 1 and 100 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 for x in select value from jsonb_array_elements(p_ops) loop
  if jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in
   ('operation','target_event_id','supersedes_adjustment_id','session_id','effective_at','event_type','ordinal','timezone'))
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  op:=x->>'operation'; target:=(x->>'target_event_id')::uuid; previous:=(x->>'supersedes_adjustment_id')::uuid; session:=(x->>'session_id')::uuid;
  if op is null or op not in ('ADD','REPLACE','VOID') or session is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  if op='ADD' then
   if target is not null or previous is not null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  else
   if target is null and previous is null then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
   if target is not null then
    select * into original from public.time_events where organization_id=p_org and employee_id=p_employee and id=target;
    if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
   end if;
   if previous is not null then
    select * into prior from public.event_adjustments where organization_id=p_org and employee_id=p_employee and id=previous;
    if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
    if prior.target_event_id is distinct from target or exists(select 1 from public.event_adjustments where organization_id=p_org and supersedes_adjustment_id=previous)
    then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
   elsif exists(select 1 from public.event_adjustments where organization_id=p_org and target_event_id=target) then
    raise exception using errcode='40001',message='VERSION_CONFLICT';
   end if;
  end if;
  if op='VOID' then
   if x->>'effective_at' is not null or x->>'event_type' is not null or x->>'ordinal' is not null
    or session is distinct from (case when previous is null then original.session_id else prior.session_id end)
   then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  else
   if x->>'event_type' is null or x->>'event_type' not in ('CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT')
    or jsonb_typeof(x->'ordinal') is distinct from 'number' or (x->>'ordinal') !~ '^[1-9][0-9]*$'
    or (x->>'ordinal')::bigint<=0 or x->>'effective_at' is null
    or (x->>'effective_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
   then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
   at_time:=(x->>'effective_at')::timestamptz;
   if not isfinite(at_time) or at_time>p_now then raise exception using errcode='22023',message='FUTURE_TIME'; end if;
  end if;
  select timezone into zone from public.work_sessions where organization_id=p_org and employee_id=p_employee and id=session;
  if not FOUND then
   -- Only a proposed ADD CLOCK_IN can introduce a session. Other operations in
   -- the same atomic proposal may refer to it; arbitrary foreign IDs cannot.
   if not exists(select 1 from jsonb_array_elements(p_ops) v where v->>'operation'='ADD' and v->>'event_type'='CLOCK_IN' and v->>'session_id'=session::text)
   then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  elsif op<>'VOID' and (x->>'timezone') is distinct from zone then
   raise exception using errcode='22023',message='INVALID_TIMEZONE';
  end if;
  if op<>'VOID' and (x->>'timezone' is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=x->>'timezone'))
  then raise exception using errcode='22023',message='INVALID_TIMEZONE'; end if;
 end loop;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
 raise exception using errcode='22023',message='INVALID_INPUT';
end $$;
revoke all on function private.validate_operations(uuid,uuid,jsonb,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.validate_operations(uuid,uuid,jsonb,timestamptz) to fichaje_correction;

create function private.correction_receipt(p_org uuid,p_employee uuid,p_key uuid,p_op text,p_payload jsonb,p_response jsonb,p_entity text,p_id uuid,p_time timestamptz,p_details jsonb)
returns jsonb language plpgsql set search_path='' as $$
begin
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id,server_at,safe_details)
 values(p_org,'USER',private.request_uid(),p_employee,p_op,p_entity,p_id,p_key,p_time,p_details);
 insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response,created_at)
 values(p_org,'USER',private.request_uid(),p_op,p_key,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'),p_response,p_time);
 return p_response;
end $$;
revoke all on function private.correction_receipt(uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.correction_receipt(uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,timestamptz,jsonb) to fichaje_correction;

create function public.submit_correction(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,p_base_version bigint,p_reason text,p_operations jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; s private.employee_state; r jsonb; v_id uuid:=gen_random_uuid(); t timestamptz;
 payload jsonb:=jsonb_build_array(p_employee_id,p_base_version,p_reason,p_operations);
begin
 perform private.correction_scope(p_organization_id,p_employee_id);
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 actor:=private.correction_access(p_organization_id,p_employee_id);
 r:=private.replay(p_organization_id,p_request_id,'submit_correction',payload);
 if r is not null then return r; end if;
 if p_base_version is null or p_base_version<0 or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into strict s from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id;
 if s.version<>p_base_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 t:=clock_timestamp();
 perform private.validate_operations(p_organization_id,p_employee_id,p_operations,t);
 insert into public.correction_requests(id,organization_id,employee_id,submitted_by_membership_id,base_version,reason,proposal,created_at)
 values(v_id,p_organization_id,p_employee_id,actor,p_base_version,btrim(p_reason),p_operations,t);
 r:=jsonb_build_object('correction_request_id',v_id,'request_id',p_request_id,'base_version',s.version);
 return private.correction_receipt(p_organization_id,p_employee_id,p_request_id,'submit_correction',payload,r,'correction_requests',v_id,t,
 jsonb_build_object('base_version',s.version,'operations',jsonb_array_length(p_operations),'submitted_by_membership_id',actor));
end $$;
alter function public.submit_correction(uuid,uuid,uuid,bigint,text,jsonb) owner to fichaje_correction;
revoke all on function public.submit_correction(uuid,uuid,uuid,bigint,text,jsonb) from public,anon,service_role;
grant execute on function public.submit_correction(uuid,uuid,uuid,bigint,text,jsonb) to authenticated;

create function public.decide_correction(p_organization_id uuid,p_request_id uuid,p_correction_request_id uuid,p_decision text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee uuid; actor uuid; s private.employee_state; q public.correction_requests; r jsonb;
 v_id uuid:=gen_random_uuid(); t timestamptz; x jsonb; session uuid; policy public.work_policies; projection jsonb; ids uuid[]:='{}'; adjustment uuid;
 payload jsonb:=jsonb_build_array(p_correction_request_id,p_decision,p_reason);
begin
 employee:=private.correction_subject(p_organization_id,p_correction_request_id);
 perform private.correction_scope(p_organization_id,employee,p_correction_request_id);
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 actor:=private.correction_access(p_organization_id,employee,p_correction_request_id);
 select * into strict s from private.employee_state where organization_id=p_organization_id and employee_id=employee for update;
 r:=private.replay(p_organization_id,p_request_id,'decide_correction',payload);
 if r is not null then return r; end if;
 if p_decision is null or p_decision not in ('APPROVE','REJECT') or p_reason is null or length(btrim(p_reason)) not between 1 and 1000
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into strict q from public.correction_requests where organization_id=p_organization_id and id=p_correction_request_id;
 if exists(select 1 from public.correction_decisions where organization_id=p_organization_id and request_id=q.id)
 then raise exception using errcode='40001',message='ALREADY_DECIDED'; end if;
 if q.base_version<>s.version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 t:=clock_timestamp();
 insert into public.correction_decisions(id,organization_id,employee_id,request_id,decision,actor_membership_id,reason,created_at)
 values(v_id,p_organization_id,employee,q.id,p_decision,actor,btrim(p_reason),t);
 if p_decision='APPROVE' then
  perform private.validate_operations(p_organization_id,employee,q.proposal,t);
  -- Create only sessions introduced by ADD CLOCK_IN; pin policy applicable at the
  -- proposed entry, never silently adopt today's policy for historical work.
  for x in select value from jsonb_array_elements(q.proposal) where value->>'operation'='ADD' and value->>'event_type'='CLOCK_IN' loop
   session:=(x->>'session_id')::uuid;
   if not exists(select 1 from public.work_sessions where organization_id=p_organization_id and employee_id=employee and work_sessions.id=session) then
    select p.* into policy from public.employee_policy_assignments a join public.work_policies p on p.organization_id=a.organization_id and p.id=a.policy_id
    where a.organization_id=p_organization_id and a.employee_id=employee and a.effective_from<=(x->>'effective_at')::timestamptz and p.valid_from<=(x->>'effective_at')::timestamptz
    order by a.effective_from desc limit 1;
    if not FOUND then raise exception using errcode='22023',message='POLICY_REQUIRED'; end if;
    if policy.timezone is distinct from x->>'timezone' then raise exception using errcode='22023',message='INVALID_TIMEZONE'; end if;
    begin
     insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at) values(session,p_organization_id,employee,policy.id,policy.timezone,t);
    exception when unique_violation then raise exception using errcode='42501',message='FORBIDDEN'; end;
   end if;
  end loop;
  -- Check newly introduced sessions' zones too.
  perform private.validate_operations(p_organization_id,employee,q.proposal,t);
  for x in select value from jsonb_array_elements(q.proposal) loop
   adjustment:=gen_random_uuid();
   insert into public.event_adjustments(id,organization_id,employee_id,decision_id,target_event_id,supersedes_adjustment_id,operation,effective_at,event_type,session_id,ordinal,created_at)
   values(adjustment,p_organization_id,employee,v_id,(x->>'target_event_id')::uuid,(x->>'supersedes_adjustment_id')::uuid,x->>'operation',
    (x->>'effective_at')::timestamptz,(x->>'event_type')::public.time_action,(x->>'session_id')::uuid,(x->>'ordinal')::bigint,t);
   ids:=array_append(ids,adjustment);
  end loop;
  projection:=private.validate_timeline(p_organization_id,employee,t);
  update private.employee_state set state=(projection->>'state')::public.clock_state,open_session_id=(projection->>'open_session_id')::uuid,
   last_event_at=(projection->>'last_event_at')::timestamptz,version=s.version+1
   where organization_id=p_organization_id and employee_id=employee;
 end if;
 r:=jsonb_build_object('decision_id',v_id,'correction_request_id',q.id,'decision',p_decision,'version',s.version+case when p_decision='APPROVE' then 1 else 0 end,'adjustment_ids',ids,'request_id',p_request_id);
 return private.correction_receipt(p_organization_id,employee,p_request_id,'decide_correction',payload,r,'correction_decisions',v_id,t,
 jsonb_build_object('correction_request_id',q.id,'decision',p_decision,'actor_membership_id',actor,'adjustment_ids',ids,
 'before',jsonb_build_object('state',s.state,'version',s.version,'open_session_id',s.open_session_id,'last_event_at',s.last_event_at),
 'after',case when p_decision='APPROVE' then projection||jsonb_build_object('version',s.version+1) else jsonb_build_object('state',s.state,'version',s.version,'open_session_id',s.open_session_id,'last_event_at',s.last_event_at) end));
exception when unique_violation then raise exception using errcode='40001',message='VERSION_CONFLICT';
end $$;
alter function public.decide_correction(uuid,uuid,uuid,text,text) owner to fichaje_correction;
revoke all on function public.decide_correction(uuid,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.decide_correction(uuid,uuid,uuid,text,text) to authenticated;
-- Dedicated read-only owner, with the same own/manager RLS as authenticated.
grant select on public.time_events,public.correction_decisions,public.event_adjustments to fichaje_state_reader;
do $$ declare t text; begin
 foreach t in array array['time_events','correction_decisions','event_adjustments'] loop
  execute format('create policy timeline_read on public.%I for select to fichaje_state_reader using(private.current_role(organization_id) is not null and exists(select 1 from public.employees e where e.organization_id=%I.organization_id and e.id=%I.employee_id))',t,t,t);
 end loop;
end $$;
grant execute on function private.effective_timeline(uuid,uuid,timestamptz) to fichaje_state_reader;
grant create on schema public to fichaje_state_reader;
create function public.get_effective_timeline(p_organization_id uuid,p_employee_id uuid,p_cutoff timestamptz default 'infinity')
returns table(event_id uuid,adjustment_id uuid,session_id uuid,event_type public.time_action,server_at timestamptz,effective_at timestamptz,ordinal bigint,source text,actor_membership_id uuid)
language sql stable security definer set search_path='' as $$
 select * from private.effective_timeline(p_organization_id,p_employee_id,p_cutoff) order by effective_at,ordinal
$$;
alter function public.get_effective_timeline(uuid,uuid,timestamptz) owner to fichaje_state_reader;
revoke all on function public.get_effective_timeline(uuid,uuid,timestamptz) from public,anon,service_role;
grant execute on function public.get_effective_timeline(uuid,uuid,timestamptz) to authenticated;
revoke create on schema public from fichaje_state_reader;
revoke create on schema public,private from fichaje_correction;

-- Minimal H2 compatibility change: retain original server clock regression guard
-- independently of the reconstructed effective timeline. No permission changes.
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
