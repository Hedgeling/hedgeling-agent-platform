-- Draft management is distinct from permission to request/create a job.
insert into permissions(key) values ('jobs.update') on conflict do nothing;
insert into role_permissions(role_id, permission_id)
select r.id,p.id from roles r cross join permissions p
where r.organization_id is null
  and r.key in ('platform_super_admin','organization_owner','localization_manager')
  and p.key='jobs.update'
on conflict do nothing;
