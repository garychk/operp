-- add super_admin role. garychk@163.com change your email here

update public.sys_users u
set auth_id = au.id
from auth.users au
where au.email = 'garychk@163.com'
  and u.email = 'garychk@163.com';

insert into public.sys_user_roles (user_id, role_id, is_deleted)
select u.id, r.id, 'n'
from public.sys_users u
join public.sys_roles r on r.role_code = 'super_admin'
where u.email = 'garychk@163.com'
on conflict (user_id, role_id) do update
set is_deleted = 'n';

