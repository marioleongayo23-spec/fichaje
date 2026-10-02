-- STRIPE-READY-03: minimal human authorization for deferred seat synchronization.
-- The RPC reveals no billing identifiers and only attests that the current
-- authenticated human may request reconciliation after a committed employee change.

create function public.authorize_billing_sync(p_organization_id uuid)
returns boolean
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role;
begin
  if p_organization_id is null or private.request_uid() is null then
    raise exception using errcode='42501',message='UNAUTHENTICATED';
  end if;
  v_role:=private.current_role(p_organization_id);
  if v_role not in ('OWNER','ADMIN') or v_role is null then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if not exists(select 1 from public.organizations where id=p_organization_id and status='ACTIVE') then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  return true;
end $$;
grant create on schema public to fichaje_billing;
alter function public.authorize_billing_sync(uuid) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.authorize_billing_sync(uuid) from public,anon,service_role;
grant execute on function public.authorize_billing_sync(uuid) to authenticated;
