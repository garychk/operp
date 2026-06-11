-- Change sys_logs.params from text to jsonb for structured log filtering.
ALTER TABLE public.sys_logs
  ALTER COLUMN params TYPE jsonb
  USING CASE
    WHEN params IS NULL OR btrim(params) = '' THEN NULL
    ELSE params::jsonb
  END;

CREATE INDEX IF NOT EXISTS idx_sys_logs_params_gin
  ON public.sys_logs USING gin (params);
