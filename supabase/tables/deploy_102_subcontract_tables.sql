-- ============================================================================
-- P2-10：委外/外协全流程（表 + 单据类型 + 交易类型 + 科目 + 菜单）
-- ============================================================================
--
-- 差距清单 A4：改造前全库搜「委外 / 外协 / subcontract / outsourc」**0 命中** ——
-- 有外协工序的制造业客户无法上线：料发出去没有账，加工回来也无从核销。
--
-- 本文件负责「有单据」这一半，过账逻辑在 deploy_103。
--
-- 业务链路（标准委外四段）
-- ----------------------
--   ① 委外订单 subcontract_order    —— 向供应商下达加工要约，按 BOM 展开应发料
--   ② 委外发料 subcontract_issue    —— 把原材料发给供应商（库存 出库）
--   ③ 委外入库 subcontract_receipt  —— 供应商交回成品（库存 入库），同时核销应发料并确认加工费应付
--   ④ 委外结算 subcontract_settlement —— 与供应商对账（发票金额 vs 系统金额），差异单列
--
-- 会计口径（企业会计准则）
-- ------------------------
--   发料：借 委托加工物资(1408) / 贷 原材料(1403)
--   入库：借 库存商品(1405)【材料 + 加工费】
--         贷 委托加工物资(1408)【材料成本】
--         贷 应付账款(2202)     【加工费】
--   发料与入库相抵后 1408 余额归零；库存金额（含加工费）与 1405 科目余额一致。
--
-- 为什么加工费要单独成一条流水腿（关键设计）
-- ------------------------------------------
--   `inventory_sync_voucher` 只能按「交易类型 → (存货科目, 对方科目)」出两行分录，
--   一张单据里表达不了「贷 1408 材料 + 贷 2202 加工费」这种**两个对方科目**的分录。
--   解法：委外入库写两条流水腿（`reference_type` 相同、`transaction_type` 不同）：
--     · subcontract_receipt_in  数量 +N，金额 = 材料成本   → 分组① 借 1405 / 贷 1408
--     · subcontract_fee_in      数量  0，金额 = 加工费     → 分组② 借 1405 / 贷 2202
--   两条腿落在**同一张凭证**里，合计四行、借贷天然平衡。加工费腿在字典里
--   `affects_stock = FALSE`（不移动库存），数量为 0 所以不影响任何数量口径。
--
--   库存行的金额仍由 `inventory_apply_move` **一次性**按 材料 + 加工费 写入，
--   所以「库存表金额 == 1405 科目余额」依旧成立，且唯一入口铁律不被破坏。
--
--   ⚠️ 副作用：deploy_96 的 `vw_erp_inventory_summary.in_amount` 原本用
--   `quantity > 0` 判定，会漏掉数量为 0 的加工费腿 → 已在 deploy_103 改为按金额符号判定。
--
-- 命名/路由约定
-- -------------
--   subcontract_order  SCO{YYYY}{####}   /mrp/subcontract-orders
--   subcontract_issue  SCI{YYYY}{####}   /mrp/subcontract-issues
--   subcontract_receipt SCR{YYYY}{####}  /mrp/subcontract-receipts
--   subcontract_settlement SCS{YYYY}{####} /mrp/subcontract-settlements
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（主数据）、deploy_40（交易类型字典）、deploy_66（菜单三步法）、
--       deploy_88（库存状态/唯一入口）、deploy_87（凭证科目映射）。
-- ============================================================================


-- ============================================================================
-- 1. 委外订单主表
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_subcontract_orders_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_no VARCHAR(50) NOT NULL,
  order_date DATE NOT NULL,
  supplier_id INTEGER NOT NULL,
  -- 加工后交回的成品/半成品；BOM 由 bom_id 指定（不指定则取该物料默认生效 BOM）
  product_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,      -- 加工费单价（本币）
  amount NUMERIC NOT NULL DEFAULT 0,          -- 加工费合计 = quantity × unit_price
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  exchange_rate NUMERIC NOT NULL DEFAULT 1,
  base_amount NUMERIC NOT NULL DEFAULT 0,
  warehouse_id INTEGER,                       -- 收料仓（入库单默认带出）
  location_id INTEGER,
  bom_id INTEGER,
  required_date DATE,
  -- 跟踪列：出/入库与结算的累计，由 deploy_103 的过账 RPC 维护
  issued_quantity NUMERIC NOT NULL DEFAULT 0,
  received_quantity NUMERIC NOT NULL DEFAULT 0,
  settled_quantity NUMERIC NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  released_at TIMESTAMPTZ,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_orders_tenant
  ON public.erp_subcontract_orders_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_orders_date
  ON public.erp_subcontract_orders_s_539dcf81_b (tenant_id, order_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_orders_supplier
  ON public.erp_subcontract_orders_s_539dcf81_b (tenant_id, supplier_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_orders_no
  ON public.erp_subcontract_orders_s_539dcf81_b (tenant_id, order_no)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 2. 委外订单 · 应发料明细（BOM 展开结果 + 发料/核销跟踪）
-- ============================================================================
-- 为什么不每次从 BOM 现算：应发量允许人工调整（有损耗、有替代料），而且必须有一个
-- 稳定的落库位置来累计「已发 / 已核销」—— 否则超发、漏核销都无从校验。
CREATE TABLE IF NOT EXISTS public.erp_subcontract_order_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_id INTEGER NOT NULL REFERENCES public.erp_subcontract_orders_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  required_quantity NUMERIC NOT NULL DEFAULT 0,   -- 应发量（BOM 用量 × 订单量 ÷ BOM 基准量 × (1+损耗)）
  issued_quantity NUMERIC NOT NULL DEFAULT 0,     -- 累计已发（数量）
  issued_amount NUMERIC NOT NULL DEFAULT 0,       -- 累计已发（金额，本位币）—— 核销单价 = issued_amount / issued_quantity
  consumed_quantity NUMERIC NOT NULL DEFAULT 0,   -- 累计已核销（数量，被委外入库按 BOM 倒扣）
  consumed_amount NUMERIC NOT NULL DEFAULT 0,     -- 累计已核销（金额）
  unit_cost NUMERIC NOT NULL DEFAULT 0,           -- 加权平均单价（发料过账时刷新，仅供页面展示）
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

-- 已建库的补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
ALTER TABLE public.erp_subcontract_order_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS issued_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE public.erp_subcontract_order_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS consumed_amount NUMERIC NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_order_details_order
  ON public.erp_subcontract_order_details_s_539dcf81_b (order_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_order_details_material
  ON public.erp_subcontract_order_details_s_539dcf81_b (tenant_id, material_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_order_details_line
  ON public.erp_subcontract_order_details_s_539dcf81_b (order_id, line_no)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 3. 委外发料单（主表 + 明细）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_subcontract_issues_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issue_no VARCHAR(50) NOT NULL,
  issue_date DATE NOT NULL,
  supplier_id INTEGER NOT NULL,
  order_id INTEGER REFERENCES public.erp_subcontract_orders_s_539dcf81_b(id),
  warehouse_id INTEGER NOT NULL,
  location_id INTEGER,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_issues_tenant
  ON public.erp_subcontract_issues_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_issues_date
  ON public.erp_subcontract_issues_s_539dcf81_b (tenant_id, issue_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_issues_order
  ON public.erp_subcontract_issues_s_539dcf81_b (order_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_issues_no
  ON public.erp_subcontract_issues_s_539dcf81_b (tenant_id, issue_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_issues_posting_key
  ON public.erp_subcontract_issues_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_issues_reversal_key
  ON public.erp_subcontract_issues_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_subcontract_issue_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issue_id INTEGER NOT NULL REFERENCES public.erp_subcontract_issues_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  order_detail_id INTEGER REFERENCES public.erp_subcontract_order_details_s_539dcf81_b(id),
  material_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  batch_no VARCHAR(100),
  location_id INTEGER,
  expiry_date DATE,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_issue_details_issue
  ON public.erp_subcontract_issue_details_s_539dcf81_b (issue_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_issue_details_material
  ON public.erp_subcontract_issue_details_s_539dcf81_b (tenant_id, material_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_issue_details_line
  ON public.erp_subcontract_issue_details_s_539dcf81_b (issue_id, line_no)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 4. 委外入库单
-- ============================================================================
-- 一单一个成品行（对齐 erp_production_receipts 的做法：主表即明细行）。
-- `material_cost` 与 `processing_fee` 分开存：过账时要写两条流水腿，也要能反查。
CREATE TABLE IF NOT EXISTS public.erp_subcontract_receipts_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_no VARCHAR(50) NOT NULL,
  receipt_date DATE NOT NULL,
  supplier_id INTEGER NOT NULL,
  order_id INTEGER REFERENCES public.erp_subcontract_orders_s_539dcf81_b(id),
  product_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  -- 加工费总额（本币）：入库时确认，同时挂应付
  processing_fee NUMERIC NOT NULL DEFAULT 0,
  -- 核销掉的材料成本（= 本次消耗的应发料 × 其移动加权单价）
  material_cost NUMERIC NOT NULL DEFAULT 0,
  -- 本次核销的逐条明细 [{"order_detail_id":…,"quantity":…,"amount":…}]
  -- 反过账要按原样退回，重新按 BOM 倒算会因「多次入库 / 改过订单量」而漂移，所以落库。
  consumed_materials JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- 入库总成本 = material_cost + processing_fee；库存行 unit_cost = 本值 ÷ quantity
  total_cost NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  exchange_rate NUMERIC NOT NULL DEFAULT 1,
  base_amount NUMERIC NOT NULL DEFAULT 0,
  warehouse_id INTEGER NOT NULL,
  location_id INTEGER,
  batch_no VARCHAR(100),
  expiry_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_receipts_tenant
  ON public.erp_subcontract_receipts_s_539dcf81_b (tenant_id);CREATE INDEX IF NOT EXISTS idx_erp_subcontract_receipts_date
  ON public.erp_subcontract_receipts_s_539dcf81_b (tenant_id, receipt_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_receipts_order
  ON public.erp_subcontract_receipts_s_539dcf81_b (order_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_receipts_no
  ON public.erp_subcontract_receipts_s_539dcf81_b (tenant_id, receipt_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_receipts_posting_key
  ON public.erp_subcontract_receipts_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_receipts_reversal_key
  ON public.erp_subcontract_receipts_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- 已建库的补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
ALTER TABLE public.erp_subcontract_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS consumed_materials JSONB NOT NULL DEFAULT '[]'::JSONB;


-- ============================================================================
-- 5. 委外结算单（供应商对账）
-- ============================================================================
-- 定位：加工费应付在**入库时**已经确认（凭证 + erp_payables），结算单不重复计价，
-- 只做「与供应商核对发票金额」这件事，把差异显式记下来供财务处理。
-- status: draft / confirmed / cancelled
CREATE TABLE IF NOT EXISTS public.erp_subcontract_settlements_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settlement_no VARCHAR(50) NOT NULL,
  settlement_date DATE NOT NULL,
  supplier_id INTEGER NOT NULL,
  order_id INTEGER REFERENCES public.erp_subcontract_orders_s_539dcf81_b(id),
  -- 本次结算数量与系统加工费（按已入库未结算部分自动带出，允许人工改）
  quantity NUMERIC NOT NULL DEFAULT 0,
  processing_fee_amount NUMERIC NOT NULL DEFAULT 0,
  -- 供应商发票金额与差异（variance = invoiced - system）
  invoiced_amount NUMERIC NOT NULL DEFAULT 0,
  variance_amount NUMERIC NOT NULL DEFAULT 0,
  invoice_no VARCHAR(64),
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  exchange_rate NUMERIC NOT NULL DEFAULT 1,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  confirm_idempotency_key UUID,
  confirmed_at TIMESTAMPTZ,
  confirmed_by INTEGER,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

ALTER TABLE public.erp_subcontract_settlements_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS confirm_idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_settlements_confirm_key
  ON public.erp_subcontract_settlements_s_539dcf81_b (confirm_idempotency_key)
  WHERE confirm_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_erp_subcontract_settlements_tenant
  ON public.erp_subcontract_settlements_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_settlements_supplier
  ON public.erp_subcontract_settlements_s_539dcf81_b (tenant_id, supplier_id, settlement_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_subcontract_settlements_order
  ON public.erp_subcontract_settlements_s_539dcf81_b (order_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_subcontract_settlements_no
  ON public.erp_subcontract_settlements_s_539dcf81_b (tenant_id, settlement_no)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 6. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_orders_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_orders_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_order_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_order_details_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_issues_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_issues_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_issue_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_issue_details_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_receipts_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_receipts_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_subcontract_settlements_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_subcontract_settlements_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_subcontract_orders_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_subcontract_order_details_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_subcontract_issues_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_subcontract_issue_details_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_subcontract_receipts_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_subcontract_settlements_s_539dcf81_b');
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 7. 应付：加工费应付要能按单据反查 + 防重复过账
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_payables_active_subcontract_receipt
  ON public.erp_payables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n' AND source_type = 'subcontract_receipt' AND source_id IS NOT NULL;


-- ============================================================================
-- 8. 单据类型（generate_document_no 靠它取 naming_rule）
--    sys_document_types.document_type 是全表唯一（被外键引用），可写 ON CONFLICT
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('subcontract_order', '委外订单', 'id', 'mrp', '/mrp/subcontract-orders',
   'erp_subcontract_orders_s_539dcf81_b', 'SCO{YYYY}{####}', TRUE, '1', 69, 'n'),
  ('subcontract_issue', '委外发料单', 'id', 'mrp', '/mrp/subcontract-issues',
   'erp_subcontract_issues_s_539dcf81_b', 'SCI{YYYY}{####}', TRUE, '1', 70, 'n'),
  ('subcontract_receipt', '委外入库单', 'id', 'mrp', '/mrp/subcontract-receipts',
   'erp_subcontract_receipts_s_539dcf81_b', 'SCR{YYYY}{####}', TRUE, '1', 71, 'n'),
  ('subcontract_settlement', '委外结算单', 'id', 'mrp', '/mrp/subcontract-settlements',
   'erp_subcontract_settlements_s_539dcf81_b', 'SCS{YYYY}{####}', TRUE, '1', 72, 'n')
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  is_deleted    = 'n',
  updated_at    = NOW();


-- ============================================================================
-- 9. 交易类型字典（sys_inventory_transaction_types）
--    code 全表唯一（被 sys_document_transaction_types 外键引用，不能改成分租户唯一）
-- ============================================================================
INSERT INTO public.sys_inventory_transaction_types (
  code, name, name_en, direction, affects_stock, description, status, sort_order, is_deleted
)
VALUES
  ('subcontract_issue_out', '委外发料出库', 'Subcontract Issue Out', 'out', TRUE,
   '把原材料发给委外供应商：借 委托加工物资 / 贷 原材料', '1', 220, 'n'),
  ('subcontract_receipt_in', '委外入库', 'Subcontract Receipt In', 'in', TRUE,
   '委外成品交回入库（材料成本部分）：借 库存商品 / 贷 委托加工物资', '1', 221, 'n'),
  ('subcontract_fee_in', '委外加工费', 'Subcontract Processing Fee', 'in', FALSE,
   '纯金额腿（数量 0）：把加工费资本化进存货并挂应付 —— 借 库存商品 / 贷 应付账款', '1', 222, 'n')
ON CONFLICT (code) DO UPDATE SET
  name         = EXCLUDED.name,
  name_en      = EXCLUDED.name_en,
  direction    = EXCLUDED.direction,
  affects_stock = EXCLUDED.affects_stock,
  description  = EXCLUDED.description,
  status       = EXCLUDED.status,
  is_deleted   = 'n',
  updated_at   = NOW();

-- 单据类型 → 交易类型映射
--
-- ⚠️ 只给**会写库存流水**的单据建映射：`transaction_type_code` 是 NOT NULL 且被外键引用，
--    委外订单 / 委外结算单不过库存、不写流水，因此**不能**建映射行（写 NULL 会直接报错）。
--    `resolve_inventory_transaction_type()` 也不会为它们被调用。
--
-- subcontract_receipt 有两条腿，但唯一索引
-- `uq_sys_document_transaction_types_default (document_type_id, direction) WHERE is_default`
-- 要求同一 (单据类型, 方向) 只能有一条默认 —— 所以主腿 is_default = TRUE、加工费腿 FALSE，
-- resolve_inventory_transaction_type('subcontract_receipt','in') 会**稳定**命中主腿。
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default,
   condition_note, sort_order, status, is_deleted, tenant_id)
SELECT d.id, x.code, x.direction, x.is_default, x.note, x.sort_order, '1', 'n', NULL
FROM public.sys_document_types d
JOIN (VALUES
  ('subcontract_issue',    'subcontract_issue_out', 'out', TRUE,  '委外发料出库',           10),
  ('subcontract_receipt',  'subcontract_receipt_in','in',  TRUE,  '委外入库（材料成本腿）', 10),
  ('subcontract_receipt',  'subcontract_fee_in',    'in',  FALSE, '委外加工费（金额腿）',   11)
) AS x(doc_type, code, direction, is_default, note, sort_order)
  ON d.document_type = x.doc_type AND d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction      = EXCLUDED.direction,
  is_default     = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note,
  sort_order     = EXCLUDED.sort_order,
  status         = '1',
  is_deleted     = 'n',
  updated_at     = NOW();


-- ============================================================================
-- 10. 会计科目 + 凭证科目映射
--     1408 委托加工物资是新科目；2202 应付账款这里**必须一起兜底** ——
--     deploy_87 的补种清单里没有 2202（它假设「应付账款」本来就存在），
--     但 2202 只随最初那批科目落在租户 1 上。用 bootstrap_tenant() 后来建的租户
--     （例如 operp）**没有 2202** → 采购入库 / 委外入库的凭证会以
--     subject_not_found 静默跳过（只 WARNING 不报错，很难发现）。
--     统一用 WHERE NOT EXISTS 兜底，不覆盖任何已存在的科目。
-- ============================================================================
INSERT INTO public.erp_account_subjects_s_539dcf81_b (
    code, name, level, category, direction, status, is_deleted, tenant_id
)
SELECT v.code, v.name, 1, v.category, v.direction, 'active', 'n', t.id
  FROM sys_tenants t
 CROSS JOIN (VALUES
    ('1408', '委托加工物资', 'asset',   'debit'),
    ('2202', '应付账款',     'liability', 'credit')
 ) AS v(code, name, category, direction)
 WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_account_subjects_s_539dcf81_b s
     WHERE s.tenant_id = t.id AND s.code = v.code AND s.is_deleted = 'n'
 );

INSERT INTO public.erp_inventory_subject_map_s_539dcf81_b (
    tenant_id, source_type, transaction_type_code,
    stock_subject_code, counter_subject_code, generate_voucher, remark
)
SELECT t.id, v.source_type, v.txn_code,
       v.stock_subject, v.counter_subject, v.generate_voucher, v.remark
  FROM sys_tenants t
 CROSS JOIN (VALUES
    ('subcontract_issue',   'subcontract_issue_out',  '1403', '1408', TRUE,
     '委外发料：借 委托加工物资 / 贷 原材料'),
    ('subcontract_receipt', 'subcontract_receipt_in', '1405', '1408', TRUE,
     '委外入库（材料腿）：借 库存商品 / 贷 委托加工物资'),
    ('subcontract_receipt', 'subcontract_fee_in',     '1405', '2202', TRUE,
     '委外加工费：借 库存商品 / 贷 应付账款')
 ) AS v(source_type, txn_code, stock_subject, counter_subject, generate_voucher, remark)
 WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_subject_map_s_539dcf81_b m
     WHERE m.tenant_id = t.id
       AND m.source_type = v.source_type
       AND m.transaction_type_code = v.txn_code
       AND m.is_deleted = 'n'
 );


-- ============================================================================
-- 11. 菜单（照 deploy_66 三步法：基线 → 基线角色授权 → 已物化租户补差）
--     挂在「生产制造(mrp)」下 —— 委外是生产外协，与生产订单/领料同域。
-- ============================================================================
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'mrp'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  v.menu_name, v.menu_code, 'C', v.icon, v.path, v.component, v.sort_order, '1', 'n', NULL
FROM (VALUES
  ('委外订单',   'mrp_subcontract-orders',       'FileTextOutlined',   '/mrp/subcontract-orders',       './pages/mrp/SubcontractOrders',       70),
  ('委外发料',   'mrp_subcontract-issues',       'TruckOutlined',      '/mrp/subcontract-issues',       './pages/mrp/SubcontractIssues',       71),
  ('委外入库',   'mrp_subcontract-receipts',     'ImportOutlined',     '/mrp/subcontract-receipts',     './pages/mrp/SubcontractReceipts',     72),
  ('委外结算',   'mrp_subcontract-settlements',  'CalculatorOutlined', '/mrp/subcontract-settlements',  './pages/mrp/SubcontractSettlements',  73)
) AS v(menu_name, menu_code, icon, path, component, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = v.menu_code
);

INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code IN ('mrp_subcontract-orders', 'mrp_subcontract-issues',
                      'mrp_subcontract-receipts', 'mrp_subcontract-settlements')
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;


-- ============================================================================
-- 12. 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n INTEGER;
  v_tenant RECORD;
  v_tbl    RECORD;
  v_menu CONSTANT TEXT[] := ARRAY[
    'mrp_subcontract-orders', 'mrp_subcontract-issues',
    'mrp_subcontract-receipts', 'mrp_subcontract-settlements'];
BEGIN
  -- 12.1 六张表
  FOR v_tbl IN
    SELECT * FROM unnest(ARRAY[
      'erp_subcontract_orders_s_539dcf81_b',
      'erp_subcontract_order_details_s_539dcf81_b',
      'erp_subcontract_issues_s_539dcf81_b',
      'erp_subcontract_issue_details_s_539dcf81_b',
      'erp_subcontract_receipts_s_539dcf81_b',
      'erp_subcontract_settlements_s_539dcf81_b']) AS t(name)
  LOOP
    IF to_regclass('public.' || v_tbl.name) IS NULL THEN
      v_missing := v_missing || format('表 %s 未建立;', v_tbl.name);
    END IF;

    -- RLS 策略必须逐表到位：缺一张，ai-server（service_role）之外的调用方就能越权读
    SELECT count(*) INTO v_n FROM pg_policies WHERE tablename = v_tbl.name;
    IF v_n < 4 THEN
      v_missing := v_missing || format('表 %s 的 RLS 策略不足（% < 4）;', v_tbl.name, v_n);
    END IF;
  END LOOP;

  -- 12.2 每张表必须有 tenant_id 且 NOT NULL 带默认（fail-closed 的前提）
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name LIKE 'erp_subcontract_%'
     AND column_name = 'tenant_id' AND is_nullable = 'NO' AND column_default IS NOT NULL;
  IF v_n <> 6 THEN
    v_missing := v_missing || format('委外表 tenant_id 定义不完整（% <> 6）;', v_n);
  END IF;

  -- 12.4 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE document_type IN ('subcontract_order', 'subcontract_issue',
                           'subcontract_receipt', 'subcontract_settlement')
     AND is_deleted = 'n' AND status = '1';
  IF v_n <> 4 THEN
    v_missing := v_missing || format('委外 DocType 缺失（% <> 4）;', v_n);
  END IF;

  -- 12.5 交易类型字典（含 affects_stock 语义）
  SELECT count(*) INTO v_n FROM public.sys_inventory_transaction_types
   WHERE code = 'subcontract_issue_out' AND direction = 'out' AND affects_stock AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'subcontract_issue_out 定义不符;'; END IF;

  SELECT count(*) INTO v_n FROM public.sys_inventory_transaction_types
   WHERE code = 'subcontract_receipt_in' AND direction = 'in' AND affects_stock AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'subcontract_receipt_in 定义不符;'; END IF;

  -- 加工费腿必须 affects_stock = FALSE（否则会变成一次真实的库存移动）
  SELECT count(*) INTO v_n FROM public.sys_inventory_transaction_types
   WHERE code = 'subcontract_fee_in' AND direction = 'in' AND NOT affects_stock AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'subcontract_fee_in 未标 affects_stock=FALSE;'; END IF;

  -- 12.6 只有一条 is_default 的入库腿，否则 resolve_inventory_transaction_type 会漂移
  SELECT count(*) INTO v_n
    FROM public.sys_document_transaction_types m
    JOIN public.sys_document_types d ON d.id = m.document_type_id
   WHERE d.document_type = 'subcontract_receipt' AND m.direction = 'in'
     AND m.is_default AND m.is_deleted = 'n';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('subcontract_receipt 默认入库腿不唯一（% <> 1）;', v_n);
  END IF;

  -- 12.7 科目 1408 / 2202 + 映射（每个租户一份）
  FOR v_tenant IN SELECT t.id FROM public.sys_tenants t WHERE COALESCE(t.is_deleted,'n') = 'n'
  LOOP
    SELECT count(*) INTO v_n FROM public.erp_account_subjects_s_539dcf81_b
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n'
       AND code IN ('1408', '2202');
    IF v_n <> 2 THEN
      v_missing := v_missing || format(
        '租户%s缺科目（1408 委托加工物资 / 2202 应付账款，实到 %s/2）;', v_tenant.id, v_n);
    END IF;

    SELECT count(*) INTO v_n FROM public.erp_inventory_subject_map_s_539dcf81_b
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n'
       AND (source_type, transaction_type_code) IN (
             ('subcontract_issue',   'subcontract_issue_out'),
             ('subcontract_receipt', 'subcontract_receipt_in'),
             ('subcontract_receipt', 'subcontract_fee_in'));
    IF v_n <> 3 THEN
      v_missing := v_missing || format('租户%s委外科目映射缺失（% <> 3）;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  -- 12.8 菜单基线 + 授权
  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND menu_code = ANY (v_menu)
     AND COALESCE(is_deleted, 'n') = 'n';
  IF v_n <> 4 THEN
    v_missing := v_missing || format('委外基线菜单缺失（% <> 4）;', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_roles r ON r.id = rm.role_id
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE r.tenant_id IS NULL AND rm.tenant_id IS NULL
     AND m.menu_code = ANY (v_menu)
     AND COALESCE(rm.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager', 'inventory_manager');
  IF v_n < 16 THEN
    v_missing := v_missing || format('委外菜单基线授权不足（% < 16）;', v_n);
  END IF;

  -- 12.9 已物化租户的菜单副本
  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n FROM public.sys_menus m
     WHERE m.tenant_id = v_tenant.id AND m.menu_code = ANY (v_menu)
       AND COALESCE(m.is_deleted, 'n') = 'n';
    IF v_n <> 4 THEN
      v_missing := v_missing || format('租户%s委外菜单副本缺失（% <> 4）;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_102 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_102 OK：委外 6 表 / 4 DocType / 3 交易类型 / 1408 科目 / 4 菜单 齐备';
END;
$$;
