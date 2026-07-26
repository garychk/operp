-- Add system configuration storage and menu entry.
-- Safe to run on an existing database.

CREATE TABLE IF NOT EXISTS public.sys_config (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    category_code VARCHAR(100) NOT NULL UNIQUE,
    category_name VARCHAR(100) NOT NULL,
    config_json JSONB DEFAULT '{}'::jsonb,
    description TEXT,
    status CHAR(1) DEFAULT '1',
    sort_order INTEGER DEFAULT 0,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_config_category_code
  ON public.sys_config(category_code);

CREATE INDEX IF NOT EXISTS idx_sys_config_config_json_gin
  ON public.sys_config USING gin (config_json);

INSERT INTO public.sys_config (category_code, category_name, config_json, description, sort_order, status)
VALUES
('basic', '基础设置', '{"companyName":"Supabase ERP","companyCode":"ERP","timezone":"Asia/Shanghai","language":"zh-CN","dateFormat":"YYYY-MM-DD","documentNoPrefix":"ERP","enableOperationLog":true}'::jsonb, '企业资料、默认语言、时区和单据号规则等全局基础参数。', 1, '1'),
('finance', '财务设置', '{"baseCurrency":"CNY","defaultTaxRate":13,"accountingYearStartMonth":1,"voucherAutoPost":false,"allowBackdatedVoucher":false,"amountPrecision":2}'::jsonb, '本位币、税率、会计期间和凭证过账控制。', 2, '1'),
('manufacturing', '制造设置', '{"mrpPlanningHorizonDays":30,"defaultLeadTimeDays":7,"allowBomVersionOverlap":false,"requireRoutingForProduction":true,"autoReserveMaterials":false,"scrapRatePrecision":4}'::jsonb, 'MRP、BOM、工艺路线和生产订单的默认行为。', 3, '1'),
('quality', '检验设置', '{"incomingInspectionEnabled":true,"productionInspectionEnabled":true,"outgoingInspectionEnabled":false,"defaultSamplingRate":10,"blockUnqualifiedStock":true,"autoCreateInspectionTask":true}'::jsonb, '来料、生产和出货检验策略。', 4, '1'),
('ai', 'AI设置', '{"enabled":true,"providers":[{"id":"ollama","name":"Ollama 本地","endpoint":"http://localhost:11434/api/chat","model":"qwen2.5","apiType":"ollama"},{"id":"demo","name":"演示模式","endpoint":"","model":"demo","apiType":"proxy"}],"activeProviderId":"ollama","temperature":0.3,"redactSensitiveData":true,"maxContextMessages":12}'::jsonb, 'AI 助手、模型和生成参数。密钥建议放在服务端环境变量。', 5, '1')
ON CONFLICT (category_code) DO UPDATE SET
    category_name = EXCLUDED.category_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    is_deleted = 'n',
    updated_at = NOW();

UPDATE public.sys_config
SET config_json = '{"enabled":true,"providers":[{"id":"ollama","name":"Ollama 本地","endpoint":"http://localhost:11434/api/chat","model":"qwen2.5","apiType":"ollama"},{"id":"demo","name":"演示模式","endpoint":"","model":"demo","apiType":"proxy"}],"activeProviderId":"ollama","temperature":0.3,"redactSensitiveData":true,"maxContextMessages":12}'::jsonb,
    updated_at = NOW()
WHERE category_code = 'ai'
  AND is_deleted = 'n'
  AND NOT (config_json ? 'providers');

INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status)
SELECT parent.id, '系统设置', 'setting', 'C', 'SettingOutlined', '/system/settings', './pages/system/Settings', 4, '1'
FROM public.sys_menus parent
WHERE parent.menu_code = 'system'
  AND parent.is_deleted = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_menus menu WHERE menu.menu_code = 'setting' AND menu.is_deleted = 'n'
  );

INSERT INTO public.sys_role_menus (role_id, menu_id)
SELECT role.id, menu.id
FROM public.sys_roles role
JOIN public.sys_menus menu ON menu.menu_code = 'setting'
WHERE role.role_code = 'super_admin'
  AND NOT EXISTS (
    SELECT 1
    FROM public.sys_role_menus role_menu
    WHERE role_menu.role_id = role.id
      AND role_menu.menu_id = menu.id
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_config TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_config_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_config');
