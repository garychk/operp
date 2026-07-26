-- Bootstrap the first Auth-bound user as super_admin in a fresh Supabase project.
-- This is meant for the first real login/registration after initialization.

create or replace function public.bootstrap_first_auth_user_super_admin()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  linked_auth_user_count integer;
  super_admin_role_id integer;
begin
  if coalesce(new.auth_id, old.auth_id) is null then
    return new;
  end if;

  select count(*)
    into linked_auth_user_count
  from public.sys_users
  where auth_id is not null;

  if linked_auth_user_count <> 1 then
    return new;
  end if;

  select id
    into super_admin_role_id
  from public.sys_roles
  where role_code = 'super_admin'
    and is_deleted = 'n'
  limit 1;

  if super_admin_role_id is null then
    raise exception 'super_admin role not found';
  end if;

  insert into public.sys_user_roles (user_id, role_id, is_deleted)
  values (new.id, super_admin_role_id, 'n')
  on conflict (user_id, role_id) do update
  set is_deleted = 'n';

  return new;
end;
$$;

drop trigger if exists trg_bootstrap_first_auth_user_super_admin on public.sys_users;
create trigger trg_bootstrap_first_auth_user_super_admin
after insert or update of auth_id on public.sys_users
for each row
execute function public.bootstrap_first_auth_user_super_admin();
