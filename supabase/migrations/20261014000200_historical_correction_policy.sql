-- HITO 18: a historical ADD CLOCK_IN may precede the date that a tenant
-- policy was assigned or even created. A reviewer must explicitly attest a
-- currently assigned policy for that correction; NEVER backdate work_policies
-- or employee_policy_assignments or alter the original time events.
-- Existing 5-argument decide_correction remains the strict/default route.
-- The new RPC has the same tenant-locked independence, audit and replay guards.
create function public.decide_correction_with_policy(p_organization_id uuid,p_request_id uuid,p_correction_request_id uuid,p_decision text,p_reason text,p_historical_policy_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee uuid; actor uuid; s private.employee_state; q public.correction_requests; r jsonb;
 v_id uuid:=gen_random_uuid(); t timestamptz; x jsonb; session uuid; policy public.work_policies; projection jsonb; ids uuid[]:='{}'; adjustment uuid; historical_sessions integer:=0;
 payload jsonb:=case when p_historical_policy_id is null
  then jsonb_build_array(p_correction_request_id,p_decision,p_reason)
  else jsonb_build_array(p_correction_request_id,p_decision,p_reason,p_historical_policy_id) end;
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
    or (p_decision='REJECT' and p_historical_policy_id is not null)
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into strict q from public.correction_requests where organization_id=p_organization_id and id=p_correction_request_id;
 if exists(select 1 from public.correction_decisions where organization_id=p_organization_id and request_id=q.id)
 then raise exception using errcode='PT409',message='ALREADY_DECIDED'; end if;
 if q.base_version<>s.version then raise exception using errcode='PT409',message='VERSION_CONFLICT'; end if;
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
    if not FOUND then
     -- No policy was effective on the proposed historical day. NEVER backdate
     -- tenant policy / assignment. The independent reviewer must explicitly
     -- attest a policy already assigned to this employee, for this request.
     if p_historical_policy_id is null then raise exception using errcode='22023',message='POLICY_REQUIRED'; end if;
     select p.* into policy from public.employee_policy_assignments a
       join public.work_policies p on p.organization_id=a.organization_id and p.id=a.policy_id
       where a.organization_id=p_organization_id and a.employee_id=employee
         and p.id=p_historical_policy_id and a.effective_from<=t and p.valid_from<=t
       order by a.effective_from desc limit 1;
     if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
     historical_sessions:=historical_sessions+1;
    end if;
    if policy.timezone is distinct from x->>'timezone' then raise exception using errcode='22023',message='INVALID_TIMEZONE'; end if;
    begin
     insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at) values(session,p_organization_id,employee,policy.id,policy.timezone,t);
    exception when unique_violation then raise exception using errcode='42501',message='FORBIDDEN'; end;
   end if;
  end loop;
  if p_historical_policy_id is not null and historical_sessions=0 then
    raise exception using errcode='22023',message='POLICY_OVERRIDE_NOT_REQUIRED'; end if;
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
 r:=jsonb_build_object('decision_id',v_id,'correction_request_id',q.id,'decision',p_decision,'version',s.version+case when p_decision='APPROVE' then 1 else 0 end,'adjustment_ids',ids,'request_id',p_request_id,
   'historical_policy_id',case when historical_sessions>0 then p_historical_policy_id else null end);
 return private.correction_receipt(p_organization_id,employee,p_request_id,'decide_correction',payload,r,'correction_decisions',v_id,t,
 jsonb_build_object('correction_request_id',q.id,'decision',p_decision,'actor_membership_id',actor,'adjustment_ids',ids,
 'historical_policy_id',case when historical_sessions>0 then p_historical_policy_id else null end,
 'historical_sessions',historical_sessions,
 'before',jsonb_build_object('state',s.state,'version',s.version,'open_session_id',s.open_session_id,'last_event_at',s.last_event_at),
 'after',case when p_decision='APPROVE' then projection||jsonb_build_object('version',s.version+1) else jsonb_build_object('state',s.state,'version',s.version,'open_session_id',s.open_session_id,'last_event_at',s.last_event_at) end));
exception when unique_violation then raise exception using errcode='PT409',message='VERSION_CONFLICT';
end $$;
-- Transfer to existing least-privilege H3 mutation role. Revoke temporary CREATE.
grant create on schema public to fichaje_correction;
alter function public.decide_correction_with_policy(uuid,uuid,uuid,text,text,uuid) owner to fichaje_correction;
revoke create on schema public from fichaje_correction;
revoke all on function public.decide_correction_with_policy(uuid,uuid,uuid,text,text,uuid) from public,anon,service_role,authenticated;
grant execute on function public.decide_correction_with_policy(uuid,uuid,uuid,text,text,uuid) to authenticated;

-- Preserve all original API signatures and tests, even for callers that still
-- use decide_correction. NULL means there is NO historical exception.
create or replace function public.decide_correction(
  p_organization_id uuid,p_request_id uuid,p_correction_request_id uuid,
  p_decision text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return public.decide_correction_with_policy(
   p_organization_id,p_request_id,p_correction_request_id,p_decision,p_reason,null);
end $$;
-- The original SECURITY DEFINER owner remains fichaje_correction.
revoke all on function public.decide_correction(uuid,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.decide_correction(uuid,uuid,uuid,text,text) to authenticated;
