-- Change sys_logs.params from text to jsonb for structured log filtering.
ALTER TABLE public.sys_logs
  ALTER COLUMN params TYPE jsonb
  USING CASE
    WHEN params IS NULL OR btrim(params) = '' THEN NULL
    ELSE params::jsonb
  END;

CREATE INDEX IF NOT EXISTS idx_sys_logs_params_gin
  ON public.sys_logs USING gin (params);


alter table public.sys_users
add column if not exists auth_id uuid unique references auth.users(id) on delete cascade;

create index if not exists idx_sys_users_auth_id
on public.sys_users(auth_id);