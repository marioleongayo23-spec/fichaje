-- H17: Bind an EMPLOYEE invitation to exactly one pre-existing tenant employee.
-- No unverified identity, caller-selected employee on acceptance, or email exposure.
alter table private.invitations
  add column employee_id uuid,
  add constraint invitation_employee_same_tenant
    foreign key (organization_id,employee_id)
    references public.employees(organization_id,id) on delete restrict,
  add constraint invitation_employee_role
    check (employee_id is null or role='EMPLOYEE');
create index invitation_employee_pending on private.invitations(organization_id,employee_id)
  where employee_id is not null and accepted_by is null;

-- The acceptor is a NOLOGIN, NOINHERIT, non-BYPASSRLS role. Allow only
-- linking/version columns; the security guard must first bind an invitation
-- scope with a verified matching email and a valid, unused token.
grant select on public.employees to fichaje_acceptor;
grant update(membership_id,version) on public.employees to fichaje_acceptor;

create policy invited_employee_read on public.employees for select to fichaje_acceptor
using (
  organization_id=private.scoped_tenant('invitation')
  and id=(select i.employee_id from private.invitations i
          where i.organization_id=employees.organization_id
            and i.id=private.scoped_subject('invitation')
            and i.accepted_by=private.request_uid()
            and i.role='EMPLOYEE')
);

create policy invited_employee_update on public.employees for update to fichaje_acceptor
using (
  organization_id=private.scoped_tenant('invitation')
  and membership_id is null and active
  and id=(select i.employee_id from private.invitations i
          where i.organization_id=employees.organization_id
            and i.id=private.scoped_subject('invitation')
            and i.accepted_by=private.request_uid()
            and i.role='EMPLOYEE')
)
with check (
  organization_id=private.scoped_tenant('invitation')
  and active
  and id=(select i.employee_id from private.invitations i
          where i.organization_id=employees.organization_id
            and i.id=private.scoped_subject('invitation')
            and i.accepted_by=private.request_uid()
            and i.role='EMPLOYEE')
  and exists(select 1 from public.memberships m
             where m.organization_id=employees.organization_id
               and m.id=employees.membership_id
               and m.auth_user_id=private.request_uid()
               and m.active and m.role='EMPLOYEE')
);

-- Only OWNER/ADMIN may select the target. The old create_invitation RPC is
-- unchanged for generic ADMIN/EMPLOYEE invites and all existing integrations.
create function public.create_employee_invitation(
  p_organization_id uuid,p_request_id uuid,p_employee_id uuid,
  p_email text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_result jsonb; v_id uuid; v_actor uuid;
 v_payload jsonb:=jsonb_build_array(p_employee_id,p_email,p_token_hash);
begin
 v_role:=private.authorize(p_organization_id);
 if v_role not in ('OWNER','ADMIN') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'create_employee_invitation',v_payload);
 if v_result is not null then return v_result; end if;
 if p_request_id is null or p_employee_id is null or p_email is null
   or length(p_email) not between 3 and 254 or p_email<>lower(btrim(p_email))
   or position('@' in p_email)<2 or p_token_hash is null
   or p_token_hash !~ '^[0-9a-f]{64}$'
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if not exists(select 1 from public.employees e
               where e.organization_id=p_organization_id and e.id=p_employee_id
                 and e.active and e.membership_id is null)
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select id into v_actor from public.memberships
 where organization_id=p_organization_id and auth_user_id=private.request_uid();
 insert into private.invitations(organization_id,email,role,token_hash,created_by,employee_id)
 values(p_organization_id,p_email,'EMPLOYEE',p_token_hash,v_actor,p_employee_id)
 returning id into v_id;
 return private.receipt(p_organization_id,p_request_id,'create_employee_invitation',
   v_payload,jsonb_build_object('id',v_id),'invitations',v_id,
   jsonb_build_object('before',null,'after',jsonb_build_object('role','EMPLOYEE','employee_id',p_employee_id)));
exception when unique_violation then raise exception using errcode='22023',message='INVALID_INPUT';
end $$;
alter function public.create_employee_invitation(uuid,uuid,uuid,text,text) owner to fichaje_writer;
revoke all on function public.create_employee_invitation(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.create_employee_invitation(uuid,uuid,uuid,text,text) to authenticated;

-- All membership and employee-link writes are a single Postgres transaction.
-- Target employee comes ONLY from an issuer-authored private invitation.
create or replace function public.accept_invitation(p_organization_id uuid,p_request_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_inv private.invitations; v_email text; v_id uuid; v_result jsonb; v_payload jsonb;
 v_employee public.employees; v_response jsonb;
begin
 if private.request_uid() is null then raise exception using errcode='42501',message='UNAUTHENTICATED'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.invitation_scope(p_organization_id,p_token);
 v_payload:=jsonb_build_array(encode(sha256(convert_to(p_token,'UTF8')),'hex'));
 select * into v_inv from private.invitations where organization_id=p_organization_id and token_hash=v_payload->>0;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform 1 from public.organizations where id=p_organization_id and status='ACTIVE' for update;
 if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_email:=private.verified_auth_email(private.request_uid());
 if v_email is null or v_email<>v_inv.email then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select * into v_inv from private.invitations where id=v_inv.id and organization_id=p_organization_id;
 if v_inv.accepted_by is not null then
  if v_inv.accepted_by<>private.request_uid() or private.current_role(p_organization_id) is null
  then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  v_result:=private.replay(p_organization_id,p_request_id,'accept_invitation',v_payload);
  if v_result is not null then return v_result; end if;
  raise exception using errcode='42501',message='FORBIDDEN';
 end if;
 if v_inv.expires_at<=clock_timestamp() or not exists(select 1 from public.memberships
  where organization_id=p_organization_id and id=v_inv.created_by and active
  and (role='OWNER' or (role='ADMIN' and v_inv.role='EMPLOYEE')))
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 v_result:=private.replay(p_organization_id,p_request_id,'accept_invitation',v_payload);
 if v_result is not null then return v_result; end if;
 if exists(select 1 from public.memberships where organization_id=p_organization_id and auth_user_id=private.request_uid())
 then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 insert into public.memberships(organization_id,auth_user_id,role)
 values(p_organization_id,private.request_uid(),v_inv.role) returning id into v_id;
 update private.invitations set accepted_by=private.request_uid()
 where id=v_inv.id and organization_id=p_organization_id;
 v_response:=jsonb_build_object('id',v_id,'version',1);
 if v_inv.employee_id is not null then
  if v_inv.role<>'EMPLOYEE' then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  update public.employees set membership_id=v_id,version=version+1
  where organization_id=p_organization_id and id=v_inv.employee_id
    and membership_id is null and active
  returning * into v_employee;
  if not FOUND then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id,safe_details)
  values(p_organization_id,'USER',private.request_uid(),v_employee.id,
    'accept_employee_link','employees',v_employee.id,p_request_id,
    jsonb_build_object('before',jsonb_build_object('membership_id',null,'version',v_employee.version-1),
                       'after',jsonb_build_object('membership_id',v_id,'version',v_employee.version)));
  v_response:=v_response||jsonb_build_object('employee_id',v_employee.id);
 end if;
 return private.receipt(p_organization_id,p_request_id,'accept_invitation',v_payload,v_response,
  'memberships',v_id,jsonb_build_object('before',null,'after',jsonb_build_object('role',v_inv.role,'active',true,'version',1)));
end $$;
alter function public.accept_invitation(uuid,uuid,text) owner to fichaje_acceptor;
revoke all on function public.accept_invitation(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.accept_invitation(uuid,uuid,text) to authenticated;
