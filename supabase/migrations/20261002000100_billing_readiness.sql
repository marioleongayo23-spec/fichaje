-- STRIPE-READY-01: billing state and durable seat-sync outbox.
-- No Stripe secret, network I/O, payment enforcement or customer data is introduced here.
-- The labour transaction only records desired seat quantity; an external server worker
-- will later synchronize Stripe and ACK the exact outbox revision.

do $$ begin
  if not exists(select 1 from pg_roles where rolname='fichaje_billing') then
    create role fichaje_billing nologin noinherit;
  end if;
end $$;
do $$ begin
  if exists(
    select 1 from pg_roles where rolname='fichaje_billing'
    and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls)
  ) then raise exception 'UNSAFE_TECHNICAL_ROLE'; end if;
end $$;
grant fichaje_billing to postgres;
grant usage on schema public,private to fichaje_billing;

create table private.billing_accounts (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_employee_item_id text unique,
  status text not null default 'NOT_CONFIGURED'
    check(status in ('NOT_CONFIGURED','CHECKOUT_PENDING','INCOMPLETE','INCOMPLETE_EXPIRED','TRIALING','ACTIVE','PAST_DUE','PAUSED','UNPAID','CANCELED')),
  seat_quantity integer not null default 0 check(seat_quantity>=0),
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  last_event_created bigint not null default 0 check(last_event_created>=0),
  last_event_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(stripe_customer_id is null or (length(stripe_customer_id) between 5 and 255 and stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')),
  check(stripe_subscription_id is null or (length(stripe_subscription_id) between 5 and 255 and stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')),
  check(stripe_employee_item_id is null or (length(stripe_employee_item_id) between 4 and 255 and stripe_employee_item_id ~ '^si_[A-Za-z0-9]+$')),
  check(last_event_id is null or (length(last_event_id) between 5 and 255 and last_event_id ~ '^evt_[A-Za-z0-9]+$'))
);
alter table private.billing_accounts enable row level security;
alter table private.billing_accounts force row level security;

create table private.billing_events (
  stripe_event_id text primary key
    check(length(stripe_event_id) between 5 and 255 and stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null check(length(event_type) between 1 and 120),
  event_created bigint not null check(event_created>=0),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  processed_at timestamptz not null default clock_timestamp()
);
alter table private.billing_events enable row level security;
alter table private.billing_events force row level security;

create table private.billing_seat_outbox (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  desired_quantity integer not null check(desired_quantity>=0),
  revision bigint not null default 1 check(revision>0),
  updated_at timestamptz not null default clock_timestamp()
);
alter table private.billing_seat_outbox enable row level security;
alter table private.billing_seat_outbox force row level security;

revoke all on private.billing_accounts,private.billing_events,private.billing_seat_outbox
  from public,anon,authenticated,service_role;
grant select,insert,update on private.billing_accounts to fichaje_billing;
grant select,insert on private.billing_events to fichaje_billing;
grant select,insert,update,delete on private.billing_seat_outbox to fichaje_billing;
grant select on public.organizations,public.employees to fichaje_billing;
grant execute on function private.request_uid(),private.current_role(uuid) to fichaje_billing;

create policy billing_account_technical on private.billing_accounts
  for all to fichaje_billing using(true) with check(true);
create policy billing_event_technical on private.billing_events
  for all to fichaje_billing using(true) with check(true);
create policy billing_outbox_technical on private.billing_seat_outbox
  for all to fichaje_billing using(true) with check(true);
create policy billing_org_read on public.organizations
  for select to fichaje_billing using(true);
create policy billing_employee_read on public.employees
  for select to fichaje_billing using(true);

-- Owner-visible summary contains no Stripe IDs.
create function public.get_billing_summary(p_organization_id uuid)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_role public.member_role;
  v_active integer;
  v_account private.billing_accounts;
  v_outbox private.billing_seat_outbox;
begin
  if p_organization_id is null or private.request_uid() is null then
    raise exception using errcode='42501',message='UNAUTHENTICATED';
  end if;
  v_role:=private.current_role(p_organization_id);
  if v_role is distinct from 'OWNER'::public.member_role then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if not exists(select 1 from public.organizations where id=p_organization_id and status='ACTIVE') then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;

  select count(*)::integer into v_active
    from public.employees where organization_id=p_organization_id and active;
  select * into v_account from private.billing_accounts where organization_id=p_organization_id;
  select * into v_outbox from private.billing_seat_outbox where organization_id=p_organization_id;

  return jsonb_build_object(
    'status',coalesce(v_account.status,'NOT_CONFIGURED'),
    'active_employees',v_active,
    'stripe_seat_quantity',coalesce(v_account.seat_quantity,0),
    'seat_sync_pending',v_outbox.organization_id is not null,
    'cancel_at_period_end',coalesce(v_account.cancel_at_period_end,false),
    'current_period_end',v_account.current_period_end
  );
end $$;
grant create on schema public to fichaje_billing;
alter function public.get_billing_summary(uuid) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.get_billing_summary(uuid) from public,anon,service_role;
grant execute on function public.get_billing_summary(uuid) to authenticated;

-- Server-only context. The billing Edge Function must authorize the human OWNER
-- first with get_billing_summary under the user's JWT, then use this service RPC.
create function public.billing_server_context(p_organization_id uuid)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_org_status text;
  v_active integer;
  v_account private.billing_accounts;
  v_outbox private.billing_seat_outbox;
begin
  if p_organization_id is null then
    raise exception using errcode='22023',message='INVALID_INPUT';
  end if;
  select status into v_org_status from public.organizations where id=p_organization_id;
  if not found then raise exception using errcode='22023',message='ORGANIZATION_NOT_FOUND'; end if;
  select count(*)::integer into v_active
    from public.employees where organization_id=p_organization_id and active;
  select * into v_account from private.billing_accounts where organization_id=p_organization_id;
  select * into v_outbox from private.billing_seat_outbox where organization_id=p_organization_id;
  return jsonb_build_object(
    'organization_status',v_org_status,
    'active_employees',v_active,
    'stripe_customer_id',v_account.stripe_customer_id,
    'stripe_subscription_id',v_account.stripe_subscription_id,
    'stripe_employee_item_id',v_account.stripe_employee_item_id,
    'billing_status',coalesce(v_account.status,'NOT_CONFIGURED'),
    'stripe_seat_quantity',coalesce(v_account.seat_quantity,0),
    'desired_seat_quantity',coalesce(v_outbox.desired_quantity,v_active),
    'seat_revision',v_outbox.revision
  );
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_server_context(uuid) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_server_context(uuid) from public,anon,authenticated;
grant execute on function public.billing_server_context(uuid) to service_role;

create function public.billing_attach_customer(p_organization_id uuid,p_stripe_customer_id text)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare v private.billing_accounts;
begin
  if p_organization_id is null or p_stripe_customer_id is null
    or length(p_stripe_customer_id) not between 5 and 255
    or p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  if not exists(select 1 from public.organizations where id=p_organization_id) then
    raise exception using errcode='22023',message='ORGANIZATION_NOT_FOUND';
  end if;
  begin
    insert into private.billing_accounts(organization_id,stripe_customer_id)
    values(p_organization_id,p_stripe_customer_id)
    on conflict(organization_id) do update
      set stripe_customer_id=excluded.stripe_customer_id,
          updated_at=clock_timestamp()
      where private.billing_accounts.stripe_customer_id is null
         or private.billing_accounts.stripe_customer_id=excluded.stripe_customer_id
    returning * into v;
  exception when unique_violation then
    raise exception using errcode='22023',message='STRIPE_CUSTOMER_CONFLICT';
  end;
  if v.organization_id is null then
    raise exception using errcode='22023',message='STRIPE_CUSTOMER_CONFLICT';
  end if;
  return jsonb_build_object('organization_id',v.organization_id,'attached',true);
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_attach_customer(uuid,text) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_attach_customer(uuid,text) from public,anon,authenticated;
grant execute on function public.billing_attach_customer(uuid,text) to service_role;

-- Webhook handlers retrieve the current subscription snapshot from Stripe after
-- verifying the event signature. Therefore out-of-order webhooks converge on
-- current Stripe state instead of trusting stale event payload state.
create function public.billing_record_subscription_snapshot(
  p_event_id text,p_event_type text,p_event_created bigint,p_organization_id uuid,
  p_stripe_customer_id text,p_stripe_subscription_id text,p_stripe_employee_item_id text,
  p_status text,p_seat_quantity integer,p_cancel_at_period_end boolean,p_current_period_end timestamptz
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_account private.billing_accounts;
  v_inserted text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_event_type is null or length(p_event_type) not between 1 and 120
    or p_event_created is null or p_event_created<0
    or p_organization_id is null
    or p_stripe_customer_id is null or p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or p_stripe_subscription_id is null or p_stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    or p_stripe_employee_item_id is null or p_stripe_employee_item_id !~ '^si_[A-Za-z0-9]+$'
    or p_status not in ('INCOMPLETE','INCOMPLETE_EXPIRED','TRIALING','ACTIVE','PAST_DUE','PAUSED','UNPAID','CANCELED')
    or p_seat_quantity is null or p_seat_quantity<0
    or p_cancel_at_period_end is null
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;

  select * into v_account
    from private.billing_accounts
    where organization_id=p_organization_id
    for update;
  if not found or v_account.stripe_customer_id is distinct from p_stripe_customer_id then
    raise exception using errcode='42501',message='STRIPE_MAPPING_MISMATCH';
  end if;
  if v_account.stripe_subscription_id is not null
    and v_account.stripe_subscription_id<>p_stripe_subscription_id then
    raise exception using errcode='42501',message='STRIPE_MAPPING_MISMATCH';
  end if;

  insert into private.billing_events(stripe_event_id,event_type,event_created,organization_id)
  values(p_event_id,p_event_type,p_event_created,p_organization_id)
  on conflict(stripe_event_id) do nothing
  returning stripe_event_id into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied',false,'duplicate',true);
  end if;

  update private.billing_accounts
     set stripe_subscription_id=p_stripe_subscription_id,
         stripe_employee_item_id=p_stripe_employee_item_id,
         status=p_status,
         seat_quantity=p_seat_quantity,
         cancel_at_period_end=p_cancel_at_period_end,
         current_period_end=p_current_period_end,
         last_event_created=greatest(last_event_created,p_event_created),
         last_event_id=p_event_id,
         updated_at=clock_timestamp()
   where organization_id=p_organization_id;

  return jsonb_build_object('applied',true,'duplicate',false);
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz)
  from public,anon,authenticated;
grant execute on function public.billing_record_subscription_snapshot(text,text,bigint,uuid,text,text,text,text,integer,boolean,timestamptz)
  to service_role;

create function public.billing_ack_seat_sync(p_organization_id uuid,p_revision bigint,p_quantity integer)
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_deleted bigint;
  v_pending boolean;
begin
  if p_organization_id is null or p_revision is null or p_revision<1
    or p_quantity is null or p_quantity<0
  then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  if not exists(select 1 from private.billing_accounts where organization_id=p_organization_id) then
    raise exception using errcode='22023',message='BILLING_NOT_CONFIGURED';
  end if;

  update private.billing_accounts
     set seat_quantity=p_quantity,updated_at=clock_timestamp()
   where organization_id=p_organization_id;

  delete from private.billing_seat_outbox
   where organization_id=p_organization_id and revision=p_revision;
  get diagnostics v_deleted=row_count;
  select exists(select 1 from private.billing_seat_outbox where organization_id=p_organization_id) into v_pending;
  return jsonb_build_object('acked',v_deleted=1,'pending',v_pending);
end $$;
grant create on schema public to fichaje_billing;
alter function public.billing_ack_seat_sync(uuid,bigint,integer) owner to fichaje_billing;
revoke create on schema public from fichaje_billing;
revoke all on function public.billing_ack_seat_sync(uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.billing_ack_seat_sync(uuid,bigint,integer) to service_role;

-- Durable, transaction-local seat intent. No HTTP call happens in this trigger.
create function private.billing_queue_seat_sync()
returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_org uuid:=coalesce(new.organization_id,old.organization_id);
  v_quantity integer;
begin
  if tg_op='UPDATE' and new.organization_id=old.organization_id and new.active is not distinct from old.active then
    return new;
  end if;
  select count(*)::integer into v_quantity
    from public.employees where organization_id=v_org and active;
  insert into private.billing_seat_outbox(organization_id,desired_quantity)
  values(v_org,v_quantity)
  on conflict(organization_id) do update
    set desired_quantity=excluded.desired_quantity,
        revision=private.billing_seat_outbox.revision+1,
        updated_at=clock_timestamp();
  return coalesce(new,old);
end $$;
grant create on schema private to fichaje_billing;
alter function private.billing_queue_seat_sync() owner to fichaje_billing;
revoke create on schema private from fichaje_billing;
revoke all on function private.billing_queue_seat_sync() from public,anon,authenticated,service_role;

create trigger billing_employee_seat_sync
after insert or update or delete on public.employees
for each row execute function private.billing_queue_seat_sync();

-- Existing tenants receive a deterministic initial desired quantity.
insert into private.billing_seat_outbox(organization_id,desired_quantity)
select o.id,count(e.id) filter(where e.active)::integer
from public.organizations o
left join public.employees e on e.organization_id=o.id
group by o.id
on conflict(organization_id) do nothing;
