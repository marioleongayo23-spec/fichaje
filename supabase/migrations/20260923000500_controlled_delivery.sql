-- A manager records a controlled handoff, not an account for the recipient.
-- The recipient never receives a database role or a permanent Storage grant.
create table private.evidence_deliveries (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid, export_job_id uuid not null, actor_membership_id uuid not null,
 recipient_kind text not null check(recipient_kind in ('REPRESENTATIVE','INSPECTION')),
 receipt_ref text not null check(length(btrim(receipt_ref)) between 1 and 200),
 purpose text not null check(length(btrim(purpose)) between 1 and 1000),
 local_start date not null, local_end date not null, timezone text not null,
 object_digest text not null check(object_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id),unique(organization_id,export_job_id,receipt_ref),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,actor_membership_id) references public.memberships(organization_id,id) on delete restrict
);
alter table private.evidence_deliveries enable row level security;
alter table private.evidence_deliveries force row level security;
revoke all on private.evidence_deliveries from public,anon,authenticated,service_role;
grant select,insert on private.evidence_deliveries to fichaje_report;
create policy report_delivery on private.evidence_deliveries to fichaje_report
 using(organization_id=private.scoped_tenant('report'))
 with check(organization_id=private.scoped_tenant('report'));
create trigger immutable before update or delete or truncate on private.evidence_deliveries
 for each statement execute function private.immutable_record();

grant create on schema public to fichaje_report;
create function public.record_evidence_delivery(p_org uuid,p_job uuid,p_recipient_kind text,
 p_receipt_ref text,p_purpose text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid; j private.export_jobs; prior private.evidence_deliveries; d uuid; t timestamptz;
begin
 actor:=private.report_scope(p_org,null);
 if private.current_role(p_org) not in ('OWNER','ADMIN') then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_recipient_kind not in ('REPRESENTATIVE','INSPECTION') or
  length(btrim(coalesce(p_receipt_ref,''))) not between 1 and 200 or
  length(btrim(coalesce(p_purpose,''))) not between 1 and 1000 then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 select * into j from private.export_jobs where organization_id=p_org and id=p_job
  and requested_by=actor and status='READY' and expires_at>clock_timestamp();
 if not found or j.checksum is null or j.object_path is null then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text||p_job::text||p_receipt_ref,17));
 select * into prior from private.evidence_deliveries where organization_id=p_org
  and export_job_id=p_job and receipt_ref=p_receipt_ref;
 if found then
  if prior.recipient_kind is distinct from p_recipient_kind or prior.purpose is distinct from p_purpose then
   raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  return prior.id;
 end if;
 t:=clock_timestamp();
 insert into private.evidence_deliveries(organization_id,employee_id,export_job_id,
  actor_membership_id,recipient_kind,receipt_ref,purpose,local_start,local_end,timezone,
  object_digest,created_at) values(p_org,j.employee_id,j.id,actor,p_recipient_kind,
  p_receipt_ref,p_purpose,(j.filters->>1)::date,(j.filters->>2)::date,
  j.filters->>3,j.checksum,t) returning id into d;
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,
  action,entity_type,entity_id,request_id,server_at,safe_details)
 values(p_org,'USER',private.request_uid(),j.employee_id,'record_delivery',
  'evidence_deliveries',d,gen_random_uuid(),t,jsonb_build_object(
   'recipient_kind',p_recipient_kind,'scope_start',j.filters->>1,
   'scope_end',j.filters->>2,'receipt_ref',p_receipt_ref));
 return d;
end $$;
alter function public.record_evidence_delivery(uuid,uuid,text,text,text) owner to fichaje_report;
revoke all on function public.record_evidence_delivery(uuid,uuid,text,text,text)
 from public,anon,service_role;
grant execute on function public.record_evidence_delivery(uuid,uuid,text,text,text) to authenticated;
revoke create on schema public from fichaje_report;
