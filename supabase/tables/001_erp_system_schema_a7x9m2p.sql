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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    supplier_id INTEGER REFERENCES public.erp_suppliers_s_539dcf81_b(id),
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

-- 固定资产类别表
CREATE TABLE IF NOT EXISTS public.erp_asset_categories_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
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
