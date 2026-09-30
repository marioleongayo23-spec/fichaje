-- H7 final product: authorize server-side package generation for an export
-- requested by the current authenticated membership. Rendering/upload stays in
-- the server-only export-link function; no snapshot or storage credential is
-- exposed to the browser.

grant create on schema public to fichaje_report;
create function public.authorize_export_generation(p_organization_id uuid,p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid; j private.export_jobs;
begin
 actor:=private.report_scope(p_organization_id,null);
 select * into j from private.export_jobs
 where organization_id=p_organization_id and id=p_job_id and requested_by=actor;
 if not found or j.status not in ('PENDING','READY') or j.expires_at<=clock_timestamp() then
  raise exception using errcode='42501',message='FORBIDDEN';
 end if;
 return jsonb_build_object('status',j.status);
end $$;
alter function public.authorize_export_generation(uuid,uuid) owner to fichaje_report;
revoke all on function public.authorize_export_generation(uuid,uuid) from public,anon,service_role;
grant execute on function public.authorize_export_generation(uuid,uuid) to authenticated;
revoke create on schema public from fichaje_report;
