-- Supabase ERP consolidated deployment script
-- Generated from smaller migration scripts for implementation convenience.
-- Source files:
--   supabase\tables\system_management_20240331.sql
--   supabase\tables\001_erp_system_schema_a7x9m2p.sql
--   supabase\tables\002_alter_sys_logs_params_jsonb.sql
--   supabase\tables\003_create_sys_forms.sql
--   supabase\tables\004_create_avatar_storage_bucket.sql


-- ============================================================
-- Begin: supabase\tables\system_management_20240331.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sys_users (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    real_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    avatar_url TEXT,
    status CHAR(1) DEFAULT '1',
    last_login_at TIMESTAMP WITH TIME ZONE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_roles (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    role_code VARCHAR(100) NOT NULL UNIQUE,
    role_name VARCHAR(100) NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    status CHAR(1) DEFAULT '1',
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_user_roles (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    user_id INTEGER NOT NULL REFERENCES public.sys_users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES public.sys_roles(id) ON DELETE CASCADE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.sys_menus (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    parent_id INTEGER DEFAULT 0,
    menu_name VARCHAR(100) NOT NULL,
    menu_code VARCHAR(100),
    menu_type CHAR(1) DEFAULT 'M',
    icon VARCHAR(100),
    path VARCHAR(255),
    component VARCHAR(255),
    sort_order INTEGER DEFAULT 0,
    status CHAR(1) DEFAULT '1',
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_role_menus (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    role_id INTEGER NOT NULL REFERENCES public.sys_roles(id) ON DELETE CASCADE,
    menu_id INTEGER NOT NULL REFERENCES public.sys_menus(id) ON DELETE CASCADE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS public.sys_logs (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    user_id INTEGER REFERENCES public.sys_users(id),
    username VARCHAR(100),
    operation VARCHAR(100) NOT NULL,
    method VARCHAR(255),
    params TEXT,
    ip VARCHAR(50),
    user_agent TEXT,
    execute_time INTEGER,
    status CHAR(1) DEFAULT '1',
    error_msg TEXT,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
INSERT INTO public.sys_users (username, password_hash, real_name, email, phone, status) VALUES
('admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '系统管理员', 'admin@erp.com', '13800138000', '1'),
('zhangsan', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '张三', 'zhangsan@erp.com', '13800138001', '1'),
('lisi', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iAt6Z5EO', '李四', 'lisi@erp.com', '13800138002', '1');

INSERT INTO public.sys_roles (role_code, role_name, description, sort_order, status) VALUES
('super_admin', '超级管理员', '拥有所有权限', 1, '1'),
('finance_manager', '财务经理', '财务管理权限', 2, '1'),
('inventory_manager', '仓库管理员', '进销存管理权限', 3, '1'),
('mrp_manager', '生产主管', 'MRP管理权限', 4, '1'),
('operator', '普通操作员', '基本操作权限', 5, '1');

INSERT INTO public.sys_user_roles (user_id, role_id) VALUES
(1, 1),
(2, 2),
(2, 3),
(3, 5);

INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status) VALUES
(0, '系统管理', 'system', 'M', 'SettingOutlined', '/system', NULL, 100, '1'),
(1, '用户管理', 'user', 'C', 'TeamOutlined', '/system/users', './pages/system/Users', 1, '1'),
(1, '角色管理', 'role', 'C', 'SafetyOutlined', '/system/roles', './pages/system/Roles', 2, '1'),
(1, '菜单管理', 'menu', 'C', 'MenuOutlined', '/system/menus', './pages/system/Menus', 3, '1'),
(1, '系统设置', 'setting', 'C', 'SettingOutlined', '/system/settings', './pages/system/Settings', 4, '1'),
(1, '系统日志', 'log', 'C', 'FileTextOutlined', '/system/logs', './pages/system/Logs', 5, '1');

INSERT INTO public.sys_role_menus (role_id, menu_id) VALUES
(1, 1),
(1, 2),
(1, 3),
(1, 4),
(1, 5),
(1, 6);
INSERT INTO public.sys_config (category_code, category_name, config_json, description, sort_order, status) VALUES
('basic', '基础设置', '{"companyName":"Supabase ERP","companyCode":"ERP","timezone":"Asia/Shanghai","language":"zh-CN","dateFormat":"YYYY-MM-DD","documentNoPrefix":"ERP","enableOperationLog":true}'::jsonb, '企业资料、默认语言、时区和单据号规则等全局基础参数。', 1, '1'),
('finance', '财务设置', '{"baseCurrency":"CNY","defaultTaxRate":13,"accountingYearStartMonth":1,"voucherAutoPost":false,"allowBackdatedVoucher":false,"amountPrecision":2}'::jsonb, '本位币、税率、会计期间和凭证过账控制。', 2, '1'),
('manufacturing', '制造设置', '{"mrpPlanningHorizonDays":30,"defaultLeadTimeDays":7,"allowBomVersionOverlap":false,"requireRoutingForProduction":true,"autoReserveMaterials":false,"scrapRatePrecision":4}'::jsonb, 'MRP、BOM、工艺路线和生产订单的默认行为。', 3, '1'),
('quality', '检验设置', '{"incomingInspectionEnabled":true,"productionInspectionEnabled":true,"outgoingInspectionEnabled":false,"defaultSamplingRate":10,"blockUnqualifiedStock":true,"autoCreateInspectionTask":true}'::jsonb, '来料、生产和出货检验策略。', 4, '1'),
('ai', 'AI设置', '{"enabled":true,"providers":[{"id":"ollama","name":"Ollama 本地","endpoint":"http://localhost:11434/api/chat","model":"qwen2.5","apiType":"ollama"},{"id":"demo","name":"演示模式","endpoint":"","model":"demo","apiType":"proxy"}],"activeProviderId":"ollama","temperature":0.3,"redactSensitiveData":true,"maxContextMessages":12}'::jsonb, 'AI 助手、模型和生成参数。密钥建议放在服务端环境变量。', 5, '1');
INSERT INTO public.sys_logs (user_id, username, operation, method, params, ip, status, created_at) VALUES
(1, 'admin', '用户登录', 'POST /api/login', '{"username":"admin"}', '192.168.1.100', '1', NOW() - INTERVAL '1 hour'),
(1, 'admin', '创建用户', 'POST /api/users', '{"username":"zhangsan"}', '192.168.1.100', '1', NOW() - INTERVAL '30 minutes'),
(2, 'zhangsan', '用户登录', 'POST /api/login', '{"username":"zhangsan"}', '192.168.1.101', '1', NOW() - INTERVAL '20 minutes'),
(2, 'zhangsan', '查询库存', 'GET /api/inventory', '{}', '192.168.1.101', '1', NOW() - INTERVAL '10 minutes');

-- ============================================================
-- End: supabase\tables\system_management_20240331.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\001_erp_system_schema_a7x9m2p.sql
-- ============================================================
-- ERP 系统数据库表结构
-- 包含财务管理、进销存管理、生产制造 MRP 三大核心模块

-- ============================================
-- 基础数据表
-- ============================================

-- 公司/组织信息表
CREATE TABLE IF NOT EXISTS public.erp_companies_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    short_name VARCHAR(100),
    address TEXT,
    phone VARCHAR(50),
    email VARCHAR(100),
    tax_no VARCHAR(50),
    bank_name VARCHAR(200),
    bank_account VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active'
);

-- 部门表
CREATE TABLE IF NOT EXISTS public.erp_departments_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    parent_id INTEGER REFERENCES public.erp_departments_s_539dcf81_b(id),
    manager_id INTEGER,
    company_id INTEGER REFERENCES public.erp_companies_s_539dcf81_b(id),
    status VARCHAR(20) DEFAULT 'active'
);

-- 员工表
CREATE TABLE IF NOT EXISTS public.erp_employees_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    department_id INTEGER REFERENCES public.erp_departments_s_539dcf81_b(id),
    position VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(100),
    entry_date DATE,
    status VARCHAR(20) DEFAULT 'active'
);

-- 客户表
CREATE TABLE IF NOT EXISTS public.erp_customers_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    short_name VARCHAR(100),
    type VARCHAR(50),
    level VARCHAR(20),
    credit_limit DECIMAL(18, 2) DEFAULT 0,
    contact_name VARCHAR(100),
    contact_phone VARCHAR(50),
    address TEXT,
    tax_no VARCHAR(50),
    status VARCHAR(20) DEFAULT 'active'
);

-- 供应商表
CREATE TABLE IF NOT EXISTS public.erp_suppliers_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    short_name VARCHAR(100),
    type VARCHAR(50),
    level VARCHAR(20),
    credit_limit DECIMAL(18, 2) DEFAULT 0,
    contact_name VARCHAR(100),
    contact_phone VARCHAR(50),
    address TEXT,
    tax_no VARCHAR(50),
    bank_name VARCHAR(200),
    bank_account VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active'
);

-- ============================================
-- 财务模块表
-- ============================================

-- 会计科目表
CREATE TABLE IF NOT EXISTS public.erp_account_subjects_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    parent_id INTEGER REFERENCES public.erp_account_subjects_s_539dcf81_b(id),
    level INTEGER DEFAULT 1,
    category VARCHAR(50),
    direction VARCHAR(10),
    is_cash_account BOOLEAN DEFAULT FALSE,
    is_bank_account BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'active'
);

-- 会计期间表
CREATE TABLE IF NOT EXISTS public.erp_accounting_periods_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    closed_at TIMESTAMP
);

-- 凭证表
CREATE TABLE IF NOT EXISTS public.erp_vouchers_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    voucher_no VARCHAR(50) NOT NULL,
    voucher_date DATE NOT NULL,
    period_id INTEGER REFERENCES public.erp_accounting_periods_s_539dcf81_b(id),
    type VARCHAR(50),
    source_doc_no VARCHAR(50),
    total_amount DECIMAL(18, 2) DEFAULT 0,
    attachment_count INTEGER DEFAULT 0,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    posted_at TIMESTAMP,
    posted_by INTEGER
);

-- 凭证明细表
CREATE TABLE IF NOT EXISTS public.erp_voucher_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    voucher_id INTEGER REFERENCES public.erp_vouchers_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    subject_id INTEGER REFERENCES public.erp_account_subjects_s_539dcf81_b(id),
    summary TEXT,
    debit_amount DECIMAL(18, 2) DEFAULT 0,
    credit_amount DECIMAL(18, 2) DEFAULT 0,
    auxiliary_type VARCHAR(50),
    auxiliary_id INTEGER
);

-- 总账余额表
CREATE TABLE IF NOT EXISTS public.erp_general_ledger_balances_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    subject_id INTEGER REFERENCES public.erp_account_subjects_s_539dcf81_b(id),
    period_id INTEGER REFERENCES public.erp_accounting_periods_s_539dcf81_b(id),
    opening_balance DECIMAL(18, 2) DEFAULT 0,
    opening_balance_dc VARCHAR(10),
    current_period_debit DECIMAL(18, 2) DEFAULT 0,
    current_period_credit DECIMAL(18, 2) DEFAULT 0,
    ending_balance DECIMAL(18, 2) DEFAULT 0,
    ending_balance_dc VARCHAR(10)
);

-- 应收账款表
CREATE TABLE IF NOT EXISTS public.erp_receivables_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    customer_id INTEGER REFERENCES public.erp_customers_s_539dcf81_b(id),
    doc_type VARCHAR(50),
    doc_no VARCHAR(50) NOT NULL,
    doc_date DATE NOT NULL,
    due_date DATE,
    amount DECIMAL(18, 2) DEFAULT 0,
    paid_amount DECIMAL(18, 2) DEFAULT 0,
    balance DECIMAL(18, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'CNY',
    exchange_rate DECIMAL(10, 6) DEFAULT 1,
    status VARCHAR(20) DEFAULT 'open',
    remark TEXT
);

-- 应付账款表
CREATE TABLE IF NOT EXISTS public.erp_payables_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    supplier_id INTEGER REFERENCES public.erp_suppliers_s_539dcf81_b(id),
    doc_type VARCHAR(50),
    doc_no VARCHAR(50) NOT NULL,
    source_type VARCHAR(50),
    source_id INTEGER,
    source_no VARCHAR(50),
    doc_date DATE NOT NULL,
    due_date DATE,
    amount DECIMAL(18, 2) DEFAULT 0,
    paid_amount DECIMAL(18, 2) DEFAULT 0,
    balance DECIMAL(18, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'CNY',
    exchange_rate DECIMAL(10, 6) DEFAULT 1,
    status VARCHAR(20) DEFAULT 'open',
    remark TEXT
);

-- 固定资产类别表
CREATE TABLE IF NOT EXISTS public.erp_asset_categories_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    parent_id INTEGER REFERENCES public.erp_asset_categories_s_539dcf81_b(id),
    depreciation_method VARCHAR(50),
    useful_life_months INTEGER,
    residual_rate DECIMAL(5, 4) DEFAULT 0.05,
    subject_id INTEGER REFERENCES public.erp_account_subjects_s_539dcf81_b(id)
);

-- 固定资产表
CREATE TABLE IF NOT EXISTS public.erp_fixed_assets_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    asset_no VARCHAR(50) NOT NULL UNIQUE,
    asset_name VARCHAR(200) NOT NULL,
    category_id INTEGER REFERENCES public.erp_asset_categories_s_539dcf81_b(id),
    model VARCHAR(100),
    quantity INTEGER DEFAULT 1,
    unit VARCHAR(20),
    purchase_date DATE,
    purchase_price DECIMAL(18, 2) DEFAULT 0,
    original_value DECIMAL(18, 2) DEFAULT 0,
    accumulated_depreciation DECIMAL(18, 2) DEFAULT 0,
    net_value DECIMAL(18, 2) DEFAULT 0,
    depreciation_method VARCHAR(50),
    useful_life_months INTEGER,
    residual_rate DECIMAL(5, 4) DEFAULT 0.05,
    location VARCHAR(200),
    custodian_id INTEGER REFERENCES public.erp_employees_s_539dcf81_b(id),
    status VARCHAR(20) DEFAULT 'in_use'
);

-- 折旧记录表
CREATE TABLE IF NOT EXISTS public.erp_depreciation_records_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    asset_id INTEGER REFERENCES public.erp_fixed_assets_s_539dcf81_b(id),
    period_id INTEGER REFERENCES public.erp_accounting_periods_s_539dcf81_b(id),
    depreciation_amount DECIMAL(18, 2) DEFAULT 0,
    accumulated_depreciation DECIMAL(18, 2) DEFAULT 0,
    net_value DECIMAL(18, 2) DEFAULT 0,
    voucher_id INTEGER REFERENCES public.erp_vouchers_s_539dcf81_b(id)
);

-- 物料类别表
CREATE TABLE IF NOT EXISTS public.erp_product_categories_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    parent_id INTEGER REFERENCES public.erp_product_categories_s_539dcf81_b(id),
    type VARCHAR(50)
);

-- 物料/产品表
CREATE TABLE IF NOT EXISTS public.erp_products_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    short_name VARCHAR(100),
    category_id INTEGER REFERENCES public.erp_product_categories_s_539dcf81_b(id),
    specification TEXT,
    unit VARCHAR(20),
    barcode VARCHAR(50),
    purchase_price DECIMAL(18, 4) DEFAULT 0,
    sale_price DECIMAL(18, 4) DEFAULT 0,
    cost_price DECIMAL(18, 4) DEFAULT 0,
    safety_stock DECIMAL(18, 4) DEFAULT 0,
    max_stock DECIMAL(18, 4) DEFAULT 0,
    min_stock DECIMAL(18, 4) DEFAULT 0,
    is_purchased BOOLEAN DEFAULT TRUE,
    is_sold BOOLEAN DEFAULT TRUE,
    is_manufactured BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'active'
);

-- 成本核算表
CREATE TABLE IF NOT EXISTS public.erp_cost_calculations_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    period_id INTEGER REFERENCES public.erp_accounting_periods_s_539dcf81_b(id),
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    beginning_wip DECIMAL(18, 2) DEFAULT 0,
    current_material DECIMAL(18, 2) DEFAULT 0,
    current_labor DECIMAL(18, 2) DEFAULT 0,
    current_overhead DECIMAL(18, 2) DEFAULT 0,
    total_cost DECIMAL(18, 2) DEFAULT 0,
    finished_quantity INTEGER DEFAULT 0,
    unit_cost DECIMAL(18, 4) DEFAULT 0,
    ending_wip DECIMAL(18, 2) DEFAULT 0
);

-- ============================================
-- 进销存模块表
-- ============================================

-- 仓库表
CREATE TABLE IF NOT EXISTS public.erp_warehouses_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    location TEXT,
    manager_id INTEGER REFERENCES public.erp_employees_s_539dcf81_b(id),
    is_negative_stock_allowed BOOLEAN DEFAULT FALSE,
    status VARCHAR(20) DEFAULT 'active'
);

-- 库存表
CREATE TABLE IF NOT EXISTS public.erp_inventory_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    available_quantity DECIMAL(18, 4) DEFAULT 0,
    locked_quantity DECIMAL(18, 4) DEFAULT 0,
    unit_cost DECIMAL(18, 4) DEFAULT 0,
    total_cost DECIMAL(18, 2) DEFAULT 0,
    batch_no VARCHAR(50),
    expiry_date DATE,
    UNIQUE(product_id, warehouse_id, batch_no)
);

-- 库存流水表
CREATE TABLE IF NOT EXISTS public.erp_inventory_transactions_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    transaction_no VARCHAR(50) NOT NULL,
    transaction_type VARCHAR(50) NOT NULL,
    transaction_date DATE NOT NULL,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    batch_no VARCHAR(50),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_cost DECIMAL(18, 4) DEFAULT 0,
    total_cost DECIMAL(18, 2) DEFAULT 0,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    remark TEXT
);

-- 采购订单表
CREATE TABLE IF NOT EXISTS public.erp_purchase_orders_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_no VARCHAR(50) NOT NULL UNIQUE,
    order_date DATE NOT NULL,
    supplier_id INTEGER REFERENCES public.erp_suppliers_s_539dcf81_b(id),
    delivery_date DATE,
    total_amount DECIMAL(18, 2) DEFAULT 0,
    tax_amount DECIMAL(18, 2) DEFAULT 0,
    discount_amount DECIMAL(18, 2) DEFAULT 0,
    payable_amount DECIMAL(18, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'CNY',
    exchange_rate DECIMAL(10, 6) DEFAULT 1,
    delivery_address TEXT,
    contact_person VARCHAR(100),
    contact_phone VARCHAR(50),
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    approved_at TIMESTAMP,
    approved_by INTEGER
);

-- 采购订单明细表
CREATE TABLE IF NOT EXISTS public.erp_purchase_order_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_id INTEGER REFERENCES public.erp_purchase_orders_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_price DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    tax_rate DECIMAL(5, 2) DEFAULT 0,
    tax_amount DECIMAL(18, 2) DEFAULT 0,
    received_quantity DECIMAL(18, 4) DEFAULT 0,
    remark TEXT
);

-- 采购入库单表
CREATE TABLE IF NOT EXISTS public.erp_purchase_receipts_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    receipt_no VARCHAR(50) NOT NULL UNIQUE,
    receipt_date DATE NOT NULL,
    order_id INTEGER REFERENCES public.erp_purchase_orders_s_539dcf81_b(id),
    supplier_id INTEGER REFERENCES public.erp_suppliers_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    total_amount DECIMAL(18, 2) DEFAULT 0,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- 采购入库明细表
CREATE TABLE IF NOT EXISTS public.erp_purchase_receipt_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    receipt_id INTEGER REFERENCES public.erp_purchase_receipts_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    order_detail_id INTEGER REFERENCES public.erp_purchase_order_details_s_539dcf81_b(id),
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_price DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    batch_no VARCHAR(50),
    expiry_date DATE,
    remark TEXT
);

-- 销售订单表
CREATE TABLE IF NOT EXISTS public.erp_sales_orders_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_no VARCHAR(50) NOT NULL UNIQUE,
    order_date DATE NOT NULL,
    customer_id INTEGER REFERENCES public.erp_customers_s_539dcf81_b(id),
    delivery_date DATE,
    total_amount DECIMAL(18, 2) DEFAULT 0,
    tax_amount DECIMAL(18, 2) DEFAULT 0,
    discount_amount DECIMAL(18, 2) DEFAULT 0,
    receivable_amount DECIMAL(18, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'CNY',
    exchange_rate DECIMAL(10, 6) DEFAULT 1,
    delivery_address TEXT,
    contact_person VARCHAR(100),
    contact_phone VARCHAR(50),
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    approved_at TIMESTAMP,
    approved_by INTEGER
);

-- 销售订单明细表
CREATE TABLE IF NOT EXISTS public.erp_sales_order_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_id INTEGER REFERENCES public.erp_sales_orders_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_price DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    tax_rate DECIMAL(5, 2) DEFAULT 0,
    tax_amount DECIMAL(18, 2) DEFAULT 0,
    delivered_quantity DECIMAL(18, 4) DEFAULT 0,
    remark TEXT
);

-- 销售出库单表
CREATE TABLE IF NOT EXISTS public.erp_sales_deliveries_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    delivery_no VARCHAR(50) NOT NULL UNIQUE,
    delivery_date DATE NOT NULL,
    order_id INTEGER REFERENCES public.erp_sales_orders_s_539dcf81_b(id),
    customer_id INTEGER REFERENCES public.erp_customers_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    total_amount DECIMAL(18, 2) DEFAULT 0,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- 销售出库明细表
CREATE TABLE IF NOT EXISTS public.erp_sales_delivery_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    delivery_id INTEGER REFERENCES public.erp_sales_deliveries_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    order_detail_id INTEGER REFERENCES public.erp_sales_order_details_s_539dcf81_b(id),
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_price DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    batch_no VARCHAR(50),
    remark TEXT
);

-- ============================================
-- MRP 生产制造模块表
-- ============================================

-- 工作中心表
CREATE TABLE IF NOT EXISTS public.erp_work_centers_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50),
    department_id INTEGER REFERENCES public.erp_departments_s_539dcf81_b(id),
    capacity_per_day DECIMAL(10, 2) DEFAULT 0,
    labor_rate DECIMAL(18, 4) DEFAULT 0,
    overhead_rate DECIMAL(18, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active'
);

-- 工序表
CREATE TABLE IF NOT EXISTS public.erp_operations_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    work_center_id INTEGER REFERENCES public.erp_work_centers_s_539dcf81_b(id),
    standard_hours DECIMAL(10, 2) DEFAULT 0,
    setup_hours DECIMAL(10, 2) DEFAULT 0,
    labor_rate DECIMAL(18, 4) DEFAULT 0,
    overhead_rate DECIMAL(18, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active'
);

-- BOM 表（物料清单）
CREATE TABLE IF NOT EXISTS public.erp_boms_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    bom_no VARCHAR(50) NOT NULL UNIQUE,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    version VARCHAR(20) DEFAULT '1.0',
    quantity DECIMAL(18, 4) DEFAULT 1,
    unit VARCHAR(20),
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    effective_date DATE,
    expiry_date DATE,
    remark TEXT
);

-- BOM 明细表
CREATE TABLE IF NOT EXISTS public.erp_bom_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    bom_id INTEGER REFERENCES public.erp_boms_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    material_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 6) DEFAULT 0,
    unit VARCHAR(20),
    loss_rate DECIMAL(5, 4) DEFAULT 0,
    operation_id INTEGER REFERENCES public.erp_operations_s_539dcf81_b(id),
    remark TEXT
);

-- 工艺路线表
CREATE TABLE IF NOT EXISTS public.erp_routing_operations_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    routing_no VARCHAR(50) NOT NULL UNIQUE,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    version VARCHAR(20) DEFAULT '1.0',
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    effective_date DATE,
    expiry_date DATE,
    total_standard_hours DECIMAL(10, 2) DEFAULT 0,
    remark TEXT
);

-- 工艺路线工序表
CREATE TABLE IF NOT EXISTS public.erp_routing_operation_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    routing_id INTEGER REFERENCES public.erp_routing_operations_s_539dcf81_b(id) ON DELETE CASCADE,
    operation_id INTEGER REFERENCES public.erp_operations_s_539dcf81_b(id),
    sequence_no INTEGER NOT NULL,
    standard_hours DECIMAL(10, 2) DEFAULT 0,
    setup_hours DECIMAL(10, 2) DEFAULT 0,
    labor_rate DECIMAL(18, 4) DEFAULT 0,
    overhead_rate DECIMAL(18, 4) DEFAULT 0,
    next_operation_id INTEGER REFERENCES public.erp_operations_s_539dcf81_b(id),
    is_inspection_required BOOLEAN DEFAULT FALSE
);

-- 物料需求计划表
CREATE TABLE IF NOT EXISTS public.erp_mrp_plans_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    plan_no VARCHAR(50) NOT NULL UNIQUE,
    plan_date DATE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    plan_type VARCHAR(50),
    status VARCHAR(20) DEFAULT 'draft',
    remark TEXT
);

-- MRP 需求明细表
CREATE TABLE IF NOT EXISTS public.erp_mrp_requirements_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    plan_id INTEGER REFERENCES public.erp_mrp_plans_s_539dcf81_b(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    requirement_date DATE NOT NULL,
    gross_requirement DECIMAL(18, 4) DEFAULT 0,
    scheduled_receipts DECIMAL(18, 4) DEFAULT 0,
    projected_on_hand DECIMAL(18, 4) DEFAULT 0,
    net_requirement DECIMAL(18, 4) DEFAULT 0,
    planned_order_receipt DECIMAL(18, 4) DEFAULT 0,
    planned_order_release DECIMAL(18, 4) DEFAULT 0,
    order_release_date DATE,
    source_type VARCHAR(50),
    source_id INTEGER
);

-- 生产订单表
CREATE TABLE IF NOT EXISTS public.erp_production_orders_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_no VARCHAR(50) NOT NULL UNIQUE,
    order_date DATE NOT NULL,
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    bom_id INTEGER REFERENCES public.erp_boms_s_539dcf81_b(id),
    routing_id INTEGER REFERENCES public.erp_routing_operations_s_539dcf81_b(id),
    planned_quantity DECIMAL(18, 4) DEFAULT 0,
    completed_quantity DECIMAL(18, 4) DEFAULT 0,
    scrapped_quantity DECIMAL(18, 4) DEFAULT 0,
    planned_start_date DATE,
    planned_end_date DATE,
    actual_start_date DATE,
    actual_end_date DATE,
    work_center_id INTEGER REFERENCES public.erp_work_centers_s_539dcf81_b(id),
    priority INTEGER DEFAULT 5,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- 生产订单明细表
CREATE TABLE IF NOT EXISTS public.erp_production_order_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    order_id INTEGER REFERENCES public.erp_production_orders_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    material_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    planned_quantity DECIMAL(18, 4) DEFAULT 0,
    issued_quantity DECIMAL(18, 4) DEFAULT 0,
    unit VARCHAR(20),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    remark TEXT
);

-- 生产领料单表
CREATE TABLE IF NOT EXISTS public.erp_material_issues_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    issue_no VARCHAR(50) NOT NULL UNIQUE,
    issue_date DATE NOT NULL,
    production_order_id INTEGER REFERENCES public.erp_production_orders_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    total_amount DECIMAL(18, 2) DEFAULT 0,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- 生产领料明细表
CREATE TABLE IF NOT EXISTS public.erp_material_issue_details_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    issue_id INTEGER REFERENCES public.erp_material_issues_s_539dcf81_b(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    material_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_cost DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    batch_no VARCHAR(50),
    remark TEXT
);

-- 生产报工表
CREATE TABLE IF NOT EXISTS public.erp_production_reports_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    report_no VARCHAR(50) NOT NULL UNIQUE,
    report_date DATE NOT NULL,
    production_order_id INTEGER REFERENCES public.erp_production_orders_s_539dcf81_b(id),
    operation_id INTEGER REFERENCES public.erp_operations_s_539dcf81_b(id),
    completed_quantity DECIMAL(18, 4) DEFAULT 0,
    scrapped_quantity DECIMAL(18, 4) DEFAULT 0,
    labor_hours DECIMAL(10, 2) DEFAULT 0,
    machine_hours DECIMAL(10, 2) DEFAULT 0,
    work_center_id INTEGER REFERENCES public.erp_work_centers_s_539dcf81_b(id),
    operator_id INTEGER REFERENCES public.erp_employees_s_539dcf81_b(id),
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- 生产入库单表
CREATE TABLE IF NOT EXISTS public.erp_production_receipts_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    receipt_no VARCHAR(50) NOT NULL UNIQUE,
    receipt_date DATE NOT NULL,
    production_order_id INTEGER REFERENCES public.erp_production_orders_s_539dcf81_b(id),
    product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
    warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
    quantity DECIMAL(18, 4) DEFAULT 0,
    unit_cost DECIMAL(18, 4) DEFAULT 0,
    amount DECIMAL(18, 2) DEFAULT 0,
    batch_no VARCHAR(50),
    quality_status VARCHAR(20) DEFAULT 'qualified',
    remark TEXT,
    status VARCHAR(20) DEFAULT 'draft'
);

-- ============================================================
-- End: supabase\tables\001_erp_system_schema_a7x9m2p.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\002_alter_sys_logs_params_jsonb.sql
-- ============================================================
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

-- ============================================================
-- End: supabase\tables\002_alter_sys_logs_params_jsonb.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\003_create_sys_forms.sql
-- ============================================================
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_forms_table_name
  ON public.sys_forms(table_name);

CREATE INDEX IF NOT EXISTS idx_sys_forms_form_name
  ON public.sys_forms(form_name);

CREATE INDEX IF NOT EXISTS idx_sys_forms_form_config_gin
  ON public.sys_forms USING gin (form_config);

-- ============================================================
-- End: supabase\tables\003_create_sys_forms.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\004_create_avatar_storage_bucket.sql
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'avatars',
    'avatars',
    true,
    2097152,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read avatars" ON storage.objects;
CREATE POLICY "Public read avatars"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Authenticated users upload avatars" ON storage.objects;
CREATE POLICY "Authenticated users upload avatars"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Authenticated users update avatars" ON storage.objects;
CREATE POLICY "Authenticated users update avatars"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'avatars')
WITH CHECK (bucket_id = 'avatars');

-- ============================================================
-- End: supabase\tables\004_create_avatar_storage_bucket.sql
-- ============================================================


