-- Store per-business-form settings such as print templates and UI configuration.
CREATE TABLE IF NOT EXISTS public.sys_forms (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    table_name VARCHAR(128) NOT NULL UNIQUE,
    form_name VARCHAR(128) NOT NULL UNIQUE,
    description TEXT,
    print_template_json TEXT,
    form_config JSONB DEFAULT '{}'::jsonb,
    status CHAR(1) DEFAULT '1',
    sort_order INTEGER DEFAULT 0,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_forms_table_name
  ON public.sys_forms(table_name);

CREATE INDEX IF NOT EXISTS idx_sys_forms_form_name
  ON public.sys_forms(form_name);

CREATE INDEX IF NOT EXISTS idx_sys_forms_form_config_gin
  ON public.sys_forms USING gin (form_config);
