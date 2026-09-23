-- H5: private materialized evidence, classifications and retention metadata.
-- No client or service_role receives table access or purge authority.
create role fichaje_report nologin noinherit nobypassrls;
grant fichaje_report to postgres;
grant usage,create on schema public,private to fichaje_report;
alter table private.mutation_context drop constraint mutation_context_route_check;
alter table private.mutation_context add constraint mutation_context_route_check
 check(route in ('member','bootstrap','invitation','clock','correction_submit','correction_decide','report'));

create table public.hour_classifications (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid not null, local_month date not null check(extract(day from local_month)=1),
 previous_id uuid, regular_seconds bigint not null check(regular_seconds>=0),
 complementary_seconds bigint not null check(complementary_seconds>=0),
 overtime_seconds bigint not null check(overtime_seconds>=0),
 basis_version bigint not null check(basis_version>=0),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 actor_membership_id uuid not null, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,employee_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,actor_membership_id) references public.memberships(organization_id,id) on delete restrict,
 foreign key(organization_id,employee_id,previous_id)
  references public.hour_classifications(organization_id,employee_id,id) on delete restrict
);
create unique index hour_classification_successor on public.hour_classifications(organization_id,previous_id)
 where previous_id is not null;
create unique index hour_classification_first on public.hour_classifications(organization_id,employee_id,local_month)
 where previous_id is null;
create index hour_classification_month on public.hour_classifications(organization_id,employee_id,local_month,created_at);
alter table public.hour_classifications enable row level security;
alter table public.hour_classifications force row level security;
revoke all on public.hour_classifications from public,anon,authenticated,service_role;
grant select on public.hour_classifications to authenticated;
create policy classification_read on public.hour_classifications for select to authenticated
 using(private.current_role(organization_id) is not null and exists
  (select 1 from public.employees e where e.organization_id=hour_classifications.organization_id and e.id=hour_classifications.employee_id));
create trigger classification_immutable before update or delete or truncate on public.hour_classifications
 for each statement execute function private.immutable_record();

create table private.export_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid, requested_by uuid not null, filters jsonb not null,
 cutoff_at timestamptz not null, status text not null check(status in ('PENDING','READY','FAILED','EXPIRED')),
 schema_version integer not null check(schema_version>0), checksum text, object_path text,
 expires_at timestamptz not null, snapshot jsonb not null,
 request_id uuid not null, created_at timestamptz not null,
 unique(organization_id,id), unique(organization_id,requested_by,request_id),
 foreign key(organization_id) references public.organizations(id) on delete restrict,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,requested_by) references public.memberships(organization_id,id) on delete restrict,
 check(expires_at<=created_at+interval '24 hours')
);
create index export_expiry on private.export_jobs(expires_at);
create table private.legal_holds (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 employee_id uuid, scope text not null check(scope in ('ORGANIZATION','EMPLOYEE')),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 authorized_by text not null check(length(btrim(authorized_by)) between 1 and 200),
 created_at timestamptz not null default clock_timestamp(), release_of uuid,
 unique(organization_id,id), unique(organization_id,employee_id,id),
 foreign key(organization_id) references public.organizations(id) on delete restrict,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,release_of) references private.legal_holds(organization_id,id) on delete restrict,
 check((scope='ORGANIZATION' and employee_id is null) or (scope='EMPLOYEE' and employee_id is not null))
);
create unique index legal_hold_release_once on private.legal_holds(organization_id,release_of) where release_of is not null;
create table private.retention_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 cutoff timestamptz not null, authorization_ref text not null check(length(btrim(authorization_ref)) between 1 and 200),
 counts jsonb not null, digest text not null check(digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 unique(organization_id,id), foreign key(organization_id) references public.organizations(id) on delete restrict
);
do $$ declare t text; begin
 foreach t in array array['export_jobs','legal_holds','retention_runs'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('alter table private.%I force row level security',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
create trigger hold_immutable before update or delete or truncate on private.legal_holds
 for each statement execute function private.immutable_record();
create trigger retention_immutable before update or delete or truncate on private.retention_runs
 for each statement execute function private.immutable_record();

-- Only the guard can bind a tenant and an authorized subject. The reporter has
-- no permission to forge a transaction capability or mutate H1-H4 records.
grant select on public.employees,public.memberships to fichaje_guard;
create function private.report_scope(p_org uuid,p_employee uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_role public.member_role; v_actor uuid; v_employee uuid;
begin
 v_role:=private.current_role(p_org);
 if v_role is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 select id into v_actor from public.memberships where organization_id=p_org
  and auth_user_id=private.request_uid() and active;
 if p_employee is null then
  if v_role not in ('OWNER','ADMIN') then
   select id into v_employee from public.employees where organization_id=p_org and membership_id=v_actor;
  end if;
 else
  select id into v_employee from public.employees where organization_id=p_org and id=p_employee
   and (v_role in ('OWNER','ADMIN') or membership_id=v_actor);
 end if;
 if (p_employee is not null and v_employee is null) or
    (p_employee is null and v_role='EMPLOYEE' and v_employee is null) then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 perform private.bind_context(p_org,'report',v_employee);
 return v_actor;
end $$;
alter function private.report_scope(uuid,uuid) owner to fichaje_guard;
revoke all on function private.report_scope(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.report_scope(uuid,uuid) to fichaje_report;
revoke create on schema private from fichaje_guard;
grant execute on function private.scoped_tenant(text),private.scoped_subject(text),private.request_uid(),private.current_role(uuid)
 to fichaje_report;
grant select on public.employees,public.memberships,public.work_sessions,public.work_policies,
 public.time_events,public.correction_requests,public.correction_decisions,public.event_adjustments,
 public.hour_classifications to fichaje_report;
grant select,insert on private.export_jobs to fichaje_report;
grant insert on public.hour_classifications,public.audit_log to fichaje_report;
create policy report_jobs on private.export_jobs to fichaje_report
 using(organization_id=private.scoped_tenant('report') and requested_by in
  (select id from public.memberships where organization_id=private.scoped_tenant('report') and auth_user_id=private.request_uid()))
 with check(organization_id=private.scoped_tenant('report') and requested_by in
  (select id from public.memberships where organization_id=private.scoped_tenant('report') and auth_user_id=private.request_uid()));
do $$ declare t text; begin
 foreach t in array array['employees','memberships','work_sessions','work_policies','time_events',
  'correction_requests','correction_decisions','event_adjustments','hour_classifications'] loop
  execute format('create policy report_read on public.%I for select to fichaje_report using(organization_id=private.scoped_tenant(''report''))',t);
 end loop;
end $$;
create policy report_classification_insert on public.hour_classifications for insert to fichaje_report
 with check(organization_id=private.scoped_tenant('report') and employee_id=private.scoped_subject('report')
  and actor_membership_id in (select id from public.memberships where organization_id=private.scoped_tenant('report')
  and auth_user_id=private.request_uid() and role in ('OWNER','ADMIN') and active));
create policy report_audit_insert on public.audit_log for insert to fichaje_report
 with check(organization_id=private.scoped_tenant('report') and actor_kind='USER'
  and actor_id=private.request_uid() and action in ('request_export','classify_hours','record_delivery'));

-- One SQL statement materializes the entire evidence set. Its MVCC snapshot
-- cannot mix a correction committed while the statement is running.
create function private.evidence_snapshot(p_org uuid,p_employee uuid,p_start date,p_end date,p_zone text,p_cutoff timestamptz)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('schema_version',1,'organization_id',p_org,'employee_id',p_employee,
 'local_start',p_start,'local_end',p_end,'timezone',p_zone,'cutoff_at',p_cutoff,
 'employees',coalesce((select jsonb_agg(jsonb_build_object(
  'id',e.id,'code',e.code,'display_name',e.display_name,'sessions',coalesce((select jsonb_agg(jsonb_build_object(
   'id',s.id,'timezone',s.timezone,'policy',to_jsonb(w),
   'originals',coalesce((select jsonb_agg(to_jsonb(t) order by t.sequence) from public.time_events t
    where t.organization_id=p_org and t.employee_id=e.id and t.session_id=s.id and t.server_at<=p_cutoff),'[]'::jsonb),
   'adjustments',coalesce((select jsonb_agg(jsonb_build_object('adjustment',to_jsonb(a),'decision',to_jsonb(d),
    'request',to_jsonb(r)) order by a.created_at,a.id) from public.event_adjustments a
    join public.correction_decisions d on d.organization_id=a.organization_id and d.id=a.decision_id
    join public.correction_requests r on r.organization_id=d.organization_id and r.id=d.request_id
    where a.organization_id=p_org and a.employee_id=e.id and a.session_id=s.id and a.created_at<=p_cutoff),'[]'::jsonb),
   'effective',coalesce((select jsonb_agg(to_jsonb(x) order by x.effective_at,x.ordinal)
    from private.effective_timeline(p_org,e.id,p_cutoff) x where x.session_id=s.id),'[]'::jsonb)
  ) order by s.created_at,s.id) from public.work_sessions s
   join public.work_policies w on w.organization_id=s.organization_id and w.id=s.policy_id
   left join public.time_events entry on entry.organization_id=s.organization_id and entry.session_id=s.id
    and entry.event_type='CLOCK_IN' and entry.server_at<=p_cutoff
   where s.organization_id=p_org and s.employee_id=e.id and s.created_at<=p_cutoff
    and ((coalesce(entry.server_at,s.created_at) at time zone p_zone)::date between p_start and p_end)
  ),'[]'::jsonb),
  'classifications',coalesce((select jsonb_agg(to_jsonb(c) order by c.local_month,c.created_at,c.id)
   from public.hour_classifications c where c.organization_id=p_org and c.employee_id=e.id
    and c.local_month between date_trunc('month',p_start::timestamp)::date and p_end and c.created_at<=p_cutoff),'[]'::jsonb)
 ) order by e.id) from public.employees e where e.organization_id=p_org
  and (p_employee is null or e.id=p_employee)),'[]'::jsonb))
$$;
revoke all on function private.evidence_snapshot(uuid,uuid,date,date,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.evidence_snapshot(uuid,uuid,date,date,text,timestamptz) to fichaje_report;
grant execute on function private.effective_timeline(uuid,uuid,timestamptz) to fichaje_report;

create function public.request_export(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,
 p_start date,p_end date,p_timezone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; j private.export_jobs; now_at timestamptz; existing private.export_jobs;
begin
 actor:=private.report_scope(p_organization_id,p_employee_id);
 select * into existing from private.export_jobs where organization_id=p_organization_id
  and requested_by=actor and request_id=p_request_id;
 if FOUND then
  if existing.filters<>jsonb_build_array(p_employee_id,p_start,p_end,p_timezone) then
   raise exception using errcode='22023',message='IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('job_id',existing.id,'cutoff_at',existing.cutoff_at,'expires_at',existing.expires_at);
 end if;
 if p_request_id is null or p_start is null or p_end is null or p_end<p_start
  or p_end>p_start+interval '366 days' or p_timezone not in ('Europe/Madrid','Atlantic/Canary')
 then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 now_at:=clock_timestamp();
 insert into private.export_jobs(organization_id,employee_id,requested_by,filters,cutoff_at,status,
  schema_version,expires_at,snapshot,request_id,created_at)
 values(p_organization_id,p_employee_id,actor,jsonb_build_array(p_employee_id,p_start,p_end,p_timezone),
  now_at,'PENDING',1,now_at+interval '24 hours',
  private.evidence_snapshot(p_organization_id,private.scoped_subject('report'),p_start,p_end,p_timezone,now_at),
  p_request_id,now_at) returning * into j;
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,
  request_id,server_at,safe_details) values(p_organization_id,'USER',private.request_uid(),p_employee_id,
  'request_export','export_jobs',j.id,p_request_id,now_at,jsonb_build_object('start',p_start,'end',p_end));
 return jsonb_build_object('job_id',j.id,'cutoff_at',j.cutoff_at,'expires_at',j.expires_at);
end $$;
alter function public.request_export(uuid,uuid,uuid,date,date,text) owner to fichaje_report;
revoke all on function public.request_export(uuid,uuid,uuid,date,date,text) from public,anon,service_role;
grant execute on function public.request_export(uuid,uuid,uuid,date,date,text) to authenticated;

create function public.get_own_evidence(p_organization_id uuid,p_start date,p_end date,p_timezone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; subject uuid; t timestamptz;
begin
 actor:=private.report_scope(p_organization_id,null);
 subject:=private.scoped_subject('report');
 if p_start is null or p_end is null or p_end<p_start or p_end>p_start+interval '31 days'
  or p_timezone not in ('Europe/Madrid','Atlantic/Canary') then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 if subject is null then raise exception using errcode='42501',message='FORBIDDEN'; end if;
 t:=clock_timestamp();
 return private.evidence_snapshot(p_organization_id,subject,p_start,p_end,p_timezone,t);
end $$;
alter function public.get_own_evidence(uuid,date,date,text) owner to fichaje_report;
revoke all on function public.get_own_evidence(uuid,date,date,text) from public,anon,service_role;
grant execute on function public.get_own_evidence(uuid,date,date,text) to authenticated;
revoke create on schema public,private from fichaje_report;

-- Classify only a closed, current basis. A manager supplies the categories;
-- exceeding a contractual schedule never creates overtime automatically.
grant select on private.employee_state to fichaje_report;
create policy report_state_read on private.employee_state for select to fichaje_report
 using(organization_id=private.scoped_tenant('report') and employee_id=private.scoped_subject('report'));
create function private.computable_month(p_org uuid,p_employee uuid,p_month date,p_cutoff timestamptz)
returns table(computable_seconds bigint,open_sessions bigint)
language sql stable set search_path='' as $$
 with timeline as (
  select x.session_id,x.event_type,x.effective_at,
   lead(x.effective_at) over(partition by x.session_id order by x.effective_at,x.ordinal) as next_at,
   first_value(x.effective_at) over(partition by x.session_id order by x.effective_at,x.ordinal) as entry_at,
   first_value(x.event_type) over(partition by x.session_id order by x.effective_at,x.ordinal) as first_type
  from private.effective_timeline(p_org,p_employee,p_cutoff) x
 ), scoped as (
  select t.*,p.break_counts_as_work from timeline t
  join public.work_sessions s on s.organization_id=p_org and s.id=t.session_id and s.employee_id=p_employee
  join public.work_policies p on p.organization_id=s.organization_id and p.id=s.policy_id
  where (t.entry_at at time zone s.timezone)::date>=p_month
   and (t.entry_at at time zone s.timezone)::date<(p_month+interval '1 month')::date
 )
 select coalesce(round(sum(case when event_type in ('CLOCK_IN','BREAK_END') or
  (event_type='BREAK_START' and break_counts_as_work) then
  extract(epoch from next_at-effective_at) else 0 end))::bigint,0),
 coalesce(count(distinct session_id) filter (where next_at is null and event_type<>'CLOCK_OUT'),0)
 from scoped where first_type='CLOCK_IN'
$$;
revoke all on function private.computable_month(uuid,uuid,date,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.computable_month(uuid,uuid,date,timestamptz) to fichaje_report;
grant create on schema public to fichaje_report;
create function public.classify_hours(p_organization_id uuid,p_request_id uuid,p_employee_id uuid,
 p_local_month date,p_previous_id uuid,p_basis_version bigint,p_regular_seconds bigint,
 p_complementary_seconds bigint,p_overtime_seconds bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; previous public.hour_classifications; computed record; current_version bigint;
 new_id uuid; t timestamptz;
begin
 actor:=private.report_scope(p_organization_id,p_employee_id);
 if private.current_role(p_organization_id) not in ('OWNER','ADMIN') then
  raise exception using errcode='42501',message='FORBIDDEN'; end if;
 if p_request_id is null or p_employee_id is null or p_local_month is null or extract(day from p_local_month)<>1
  or p_local_month>=date_trunc('month',clock_timestamp())::date or
  p_regular_seconds is null or p_complementary_seconds is null or p_overtime_seconds is null or
  least(p_regular_seconds,p_complementary_seconds,p_overtime_seconds)<0 or
  length(btrim(coalesce(p_reason,''))) not between 1 and 1000 then
  raise exception using errcode='22023',message='INVALID_INPUT'; end if;
 -- Same employee lock namespace for concurrent classifications; unique indexes
 -- additionally enforce one initial entry and one successor per revision.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text||p_employee_id::text||p_local_month::text,0));
 select version into current_version from private.employee_state where organization_id=p_organization_id and employee_id=p_employee_id;
 if current_version is distinct from p_basis_version then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 select * into computed from private.computable_month(p_organization_id,p_employee_id,p_local_month,clock_timestamp());
 if computed.open_sessions>0 then raise exception using errcode='22023',message='INCOMPLETE_PERIOD'; end if;
 if p_regular_seconds+p_complementary_seconds+p_overtime_seconds<>computed.computable_seconds then
  raise exception using errcode='22023',message='HOURS_MISMATCH'; end if;
 select * into previous from public.hour_classifications where organization_id=p_organization_id
  and employee_id=p_employee_id and local_month=p_local_month
  and not exists(select 1 from public.hour_classifications successor where successor.organization_id=p_organization_id
  and successor.previous_id=hour_classifications.id) order by created_at desc limit 1;
 if previous.id is distinct from p_previous_id then raise exception using errcode='40001',message='VERSION_CONFLICT'; end if;
 t:=clock_timestamp();
 insert into public.hour_classifications(organization_id,employee_id,local_month,previous_id,
  regular_seconds,complementary_seconds,overtime_seconds,basis_version,reason,actor_membership_id,created_at)
 values(p_organization_id,p_employee_id,p_local_month,p_previous_id,p_regular_seconds,
  p_complementary_seconds,p_overtime_seconds,p_basis_version,p_reason,actor,t) returning id into new_id;
 insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,
  request_id,server_at,safe_details) values(p_organization_id,'USER',private.request_uid(),p_employee_id,
  'classify_hours','hour_classifications',new_id,p_request_id,t,jsonb_build_object('basis_version',p_basis_version));
 return jsonb_build_object('id',new_id,'basis_version',p_basis_version,'computable_seconds',computed.computable_seconds);
end $$;
alter function public.classify_hours(uuid,uuid,uuid,date,uuid,bigint,bigint,bigint,bigint,text) owner to fichaje_report;
revoke all on function public.classify_hours(uuid,uuid,uuid,date,uuid,bigint,bigint,bigint,bigint,text)
 from public,anon,service_role;
grant execute on function public.classify_hours(uuid,uuid,uuid,date,uuid,bigint,bigint,bigint,bigint,text)
 to authenticated;
revoke create on schema public from fichaje_report;
