-- ============================================================================
-- P2-11：其他出入库单 + 期初库存录入/导入（表结构与配置）
-- ============================================================================
--
-- 补的是差距评估文档里的两个空洞：
--
--   A5 其他入库/出库缺位
--      此前「赠品 / 样品 / 借出 / 报废 / 损耗」只能借「库存调整」表达，
--      语义混杂：调整单的对方科目固定是 1901 待处理财产损溢，
--      报废进不了 6711 营业外支出、损耗进不了 6602 管理费用，
--      而且没有「用途」字段，报表里分不清一笔减少到底是报废还是借出。
--
--   A6 期初库存无录入通道
--      字典里早就有 opening_balance_in / opening_balance_out 两个交易类型，
--      但**全库没有任何代码路径写它们**（deploy_40 只建了字典行）。
--      新客户开账只能手工一张张敲库存调整单，而且调整单不带「期初」语义，
--      没法在报表里把期初与本期发生额分开。
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. 其他出入库**一张单头**还是两张？
--    合并成一张 `erp_other_stock_documents`，方向放表头 `direction`。
--    理由：这两类单据的字段、页面、过账逻辑完全同构，只有方向与对方科目不同；
--    合表后「其他收发」可以一次查询，编号也共用一条序列。
--    单据类型只注册一个 `other_stock_document`（编号 QT{YYYY}{####}），
--    方向由表头决定 —— 不要在 sys_document_types 里按方向拆两条，
--    否则 resolve_inventory_transaction_type 要按方向猜单据类型，页面也得跟着分叉。
--
-- 2. 业务类型（business_type）→ 交易类型：**这是本单区别于调整单的核心**
--    不同业务类型的对方科目不同，靠 `resolve_other_stock_transaction_type()`
--    （见 deploy_105）把 business_type 映射到 inventory_transaction_type code，
--    再由 `inventory_voucher_plan()` 查科目：
--
--      other_receipt_in  其他入库    借 1405 库存商品 / 贷 1901 待处理财产损溢
--      other_issue_out   其他出库    借 1901 / 贷 1405        （借出、赠出、发出样品）
--      other_loss_out    损耗出库    借 6602 管理费用 / 贷 1405
--      scrap_out         报废出库    借 6711 营业外支出 / 贷 1405（复用 deploy_40 已有类型）
--
--    所以「报废」和「借出」虽然都是出库，在总账上落到不同科目 ——
--    这正是把其他出入库从调整单里拆出来的意义。
--
-- 3. 期初库存**默认不进总账**
--    期初是**余额**不是**本期发生额**：它应该体现在
--    `erp_general_ledger_balances.opening_balance`（由期初建账/期末结转向下期结转），
--    而不是生成一张本期的借贷凭证 —— 生成了反而把「期初」算成了「本期收」。
--    因此 subject_map 里 (opening_balance, opening_balance_in) 的
--    `generate_voucher` 显式写 FALSE，并在页面上把该行显示出来（可见、可改）。
--    注意：FALSE 是**显式配置**，不是「没配所以跳过」——
--    `inventory_sync_voucher` 会回 `skipped_reason = 'no_voucher_required'`，
--    与「配错科目导致 subject_not_found」是两种不同的返回值，验收脚本会分别断言。
--    客户若想把存货期初也同步进总账，把该行 generate_voucher 改成 TRUE
--    并把 counter_subject_code 换成自己的「年初余额」调整科目即可，无需改代码。
--
-- 4. 科目兜底（**这是 P2-10 踩过的坑，必须一起做**）
--    6602 管理费用 / 6711 营业外支出 在库里**缺**：
--      6711 两个租户都没有；6602 只有租户 1 有（租户 3 是 bootstrap_tenant 建的）。
--    deploy_87 的补种清单里没有这两个科目，所以**新租户必然缺**。
--    缺科目的后果是凭证以 subject_not_found **静默跳过**（只 WARNING 不报错），
--    表现为「库存动了、账没动」。这里统一按租户 WHERE NOT EXISTS 兜底。
--
-- 5. 校验前置到表上
--    direction 加 CHECK（新表，没有存量数据压力）；
--    数量/成本的正负由过账 RPC 校验（见 deploy_105），表级只约束方向。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_02（refresh_sys_tables）、deploy_03（菜单权限）、
--       deploy_40（交易类型字典）、deploy_66（菜单三步法）、deploy_87（科目映射表）。
-- ============================================================================


-- ============================================================================
-- 1. 其他出入库单 · 单头
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_other_stock_documents_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  document_no VARCHAR(50) NOT NULL,
  document_date DATE NOT NULL,
  -- in = 其他入库（收），out = 其他出库（发）；明细行方向一律跟表头一致
  direction VARCHAR(10) NOT NULL DEFAULT 'in'
    CHECK (direction IN ('in', 'out')),
  -- 业务类型：gift 赠品 / sample 样品 / lending 借出 / lending_return 借出归还 /
  --           scrap 报废 / loss 损耗 / overturn 盘盈 / other 其他
  -- 决定交易类型 → 决定对方科目，见 deploy_105 的
  -- resolve_other_stock_transaction_type()。未知取值按方向落默认类型（可扩展）。
  business_type VARCHAR(30) NOT NULL DEFAULT 'other',
  warehouse_id INTEGER NOT NULL,
  location_id INTEGER,
  -- 往来对象：赠送给谁 / 借给哪个部门 / 报废责任人。自由文本，不做外键。
  counterparty VARCHAR(200),
  reason TEXT,
  remark TEXT,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_other_stock_docs_tenant
  ON public.erp_other_stock_documents_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_other_stock_docs_date
  ON public.erp_other_stock_documents_s_539dcf81_b (tenant_id, document_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_other_stock_docs_type
  ON public.erp_other_stock_documents_s_539dcf81_b (tenant_id, direction, business_type)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_other_stock_docs_warehouse
  ON public.erp_other_stock_documents_s_539dcf81_b (tenant_id, warehouse_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_other_stock_docs_no
  ON public.erp_other_stock_documents_s_539dcf81_b (tenant_id, document_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_other_stock_docs_posting_key
  ON public.erp_other_stock_documents_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_other_stock_docs_reversal_key
  ON public.erp_other_stock_documents_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;


-- ============================================================================
-- 2. 其他出入库单 · 明细
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_other_stock_document_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  document_id INTEGER NOT NULL
    REFERENCES public.erp_other_stock_documents_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  -- 出库可留 0（过账时取库存现有加权单价）；入库必须 > 0，否则会以 0 成本污染移动加权
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  location_id INTEGER,
  batch_no VARCHAR(100),
  expiry_date DATE,
  -- 出入的状态维度：其他入库可指定落到待检/冻结，其他出库可指定从哪个状态出
  stock_status VARCHAR(30) NOT NULL DEFAULT 'available',
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_other_stock_doc_details_doc
  ON public.erp_other_stock_document_details_s_539dcf81_b (document_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_other_stock_doc_details_product
  ON public.erp_other_stock_document_details_s_539dcf81_b (tenant_id, product_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_other_stock_doc_details_line
  ON public.erp_other_stock_document_details_s_539dcf81_b (document_id, line_no)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 3. 期初库存 · 单头
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_opening_balances_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  document_no VARCHAR(50) NOT NULL,
  document_date DATE NOT NULL,
  warehouse_id INTEGER NOT NULL,
  location_id INTEGER,
  -- 冗余合计，仅供列表展示；过账时以明细为准重算
  total_quantity NUMERIC NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_erp_opening_balances_tenant
  ON public.erp_opening_balances_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_opening_balances_date
  ON public.erp_opening_balances_s_539dcf81_b (tenant_id, document_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_opening_balances_warehouse
  ON public.erp_opening_balances_s_539dcf81_b (tenant_id, warehouse_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balances_no
  ON public.erp_opening_balances_s_539dcf81_b (tenant_id, document_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balances_posting_key
  ON public.erp_opening_balances_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balances_reversal_key
  ON public.erp_opening_balances_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- 同一仓库只允许一份**已过账**的期初：期初只能录一次，
-- 要改先反过账（反过账会把状态退回 approved，唯一索引随之释放）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balances_posted_warehouse
  ON public.erp_opening_balances_s_539dcf81_b (tenant_id, warehouse_id)
  WHERE is_deleted = 'n' AND status = 'posted';


-- ============================================================================
-- 4. 期初库存 · 明细
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_opening_balance_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  document_id INTEGER NOT NULL
    REFERENCES public.erp_opening_balances_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  -- **期初单价必填且必须 > 0**（过账 RPC 强制）：
  -- 期初宁可拦住不给过，也不能以 0 成本开账 —— 0 成本的期初会把该物料
  -- 此后所有出库的移动加权单价一起拉低，且没有任何报错。
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  location_id INTEGER,
  batch_no VARCHAR(100),
  expiry_date DATE,
  stock_status VARCHAR(30) NOT NULL DEFAULT 'available',
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_opening_balance_details_doc
  ON public.erp_opening_balance_details_s_539dcf81_b (document_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_opening_balance_details_product
  ON public.erp_opening_balance_details_s_539dcf81_b (tenant_id, product_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balance_details_line
  ON public.erp_opening_balance_details_s_539dcf81_b (document_id, line_no)
  WHERE is_deleted = 'n';
-- 同一张期初单里同一物料（同库位同批次）只能出现一行：
-- 重复行会把「导入时手工贴了两遍」这种错误直接变成两张库存行的加权，
-- 事后完全看不出来。唯一键是唯一能在写入口拦住它的地方。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_opening_balance_details_product_once
  ON public.erp_opening_balance_details_s_539dcf81_b (
    document_id, product_id,
    COALESCE(location_id, 0), COALESCE(NULLIF(BTRIM(batch_no), ''), ''),
    COALESCE(stock_status, 'available'))
  WHERE is_deleted = 'n';


-- ============================================================================
-- 5. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_other_stock_documents_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_other_stock_documents_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_other_stock_document_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_other_stock_document_details_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_opening_balances_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_opening_balances_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_opening_balance_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_opening_balance_details_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_other_stock_documents_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_other_stock_document_details_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_opening_balances_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_opening_balance_details_s_539dcf81_b');
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 6. 单据类型（generate_document_no 靠它取 naming_rule）
--    sys_document_types.document_type 是全表唯一（被外键引用），可写 ON CONFLICT
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('other_stock_document', '其他出入库单', 'id', 'inventory', '/inventory/other-stock',
   'erp_other_stock_documents_s_539dcf81_b', 'QT{YYYY}{####}', TRUE, '1', 41, 'n'),
  ('opening_balance', '期初库存', 'id', 'inventory', '/inventory/opening-balances',
   'erp_opening_balances_s_539dcf81_b', 'OB{YYYY}{####}', TRUE, '1', 42, 'n')
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  is_deleted    = 'n',
  updated_at    = NOW();


-- ============================================================================
-- 7. 交易类型字典（sys_inventory_transaction_types）
--    code 全表唯一（被 sys_document_transaction_types 外键引用，不能改成分租户唯一）
--    报废复用 deploy_40 已有的 scrap_out，不重复建。
-- ============================================================================
INSERT INTO public.sys_inventory_transaction_types (
  code, name, name_en, direction, affects_stock, description, status, sort_order, is_deleted
)
VALUES
  ('other_receipt_in', '其他入库', 'Other Receipt In', 'in', TRUE,
   '赠品/样品归还/盘盈等非采购入库：借 库存商品 / 贷 待处理财产损溢', '1', 223, 'n'),
  ('other_issue_out', '其他出库', 'Other Issue Out', 'out', TRUE,
   '借出/赠出/发出样品等非销售出库：借 待处理财产损溢 / 贷 库存商品', '1', 224, 'n'),
  ('other_loss_out', '损耗出库', 'Other Loss Out', 'out', TRUE,
   '仓储/运输损耗：借 管理费用 / 贷 库存商品', '1', 225, 'n')
ON CONFLICT (code) DO UPDATE SET
  name          = EXCLUDED.name,
  name_en       = EXCLUDED.name_en,
  direction     = EXCLUDED.direction,
  affects_stock = EXCLUDED.affects_stock,
  description   = EXCLUDED.description,
  status        = EXCLUDED.status,
  sort_order    = EXCLUDED.sort_order,
  is_deleted    = 'n',
  updated_at    = NOW();

-- 单据类型 → 交易类型映射
--
-- ⚠️ `transaction_type_code` 是 NOT NULL 且被外键引用，不能给「不过库存」的单据建空映射行；
--    这里两条单据类型都过库存，可以建。
--
-- ⚠️ 唯一索引 uq_sys_document_transaction_types_default
--    (document_type_id, direction) WHERE is_deleted='n' AND is_default
--    要求同一 (单据类型, 方向) **只能有一条默认**。
--    other_stock_document 的出库方向会按 business_type 走 scrap_out / other_loss_out /
--    other_issue_out 三种类型，这里把它们都登记出来（is_default 只给 other_issue_out），
--    目的是让「单据类型-交易类型」配置页能看见全部合法组合；
--    实际过账由 resolve_other_stock_transaction_type() 按 business_type 决定，
--    这里的默认行是它兜底时的落点。
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default,
   condition_note, sort_order, status, is_deleted, tenant_id)
SELECT d.id, x.code, x.direction, x.is_default, x.note, x.sort_order, '1', 'n', NULL
FROM public.sys_document_types d
JOIN (VALUES
  ('other_stock_document', 'other_receipt_in', 'in',  TRUE,  '其他入库（赠品/归还/盘盈）', 10),
  ('other_stock_document', 'other_issue_out',  'out', TRUE,  '其他出库（借出/赠出/样品）', 10),
  ('other_stock_document', 'scrap_out',        'out', FALSE, '报废出库（business_type=scrap）', 11),
  ('other_stock_document', 'other_loss_out',   'out', FALSE, '损耗出库（business_type=loss）',  12),
  ('opening_balance',      'opening_balance_in','in', TRUE,  '期初入库',                    10)
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
-- 8. 会计科目兜底
--    6602 管理费用、6711 营业外支出：库里缺（6711 两个租户都没有；
--    6602 只有租户 1 有）。deploy_87 的补种清单没包含它们，
--    所以此后 bootstrap_tenant() 建出来的租户**必然**没有 →
--    其他出库/报废的凭证会以 subject_not_found 静默跳过（只有 WARNING）。
--    统一按租户 WHERE NOT EXISTS 兜底，不覆盖任何已存在的科目。
-- ============================================================================
INSERT INTO public.erp_account_subjects_s_539dcf81_b (
    code, name, level, category, direction, status, is_deleted, tenant_id
)
SELECT v.code, v.name, 1, v.category, v.direction, 'active', 'n', t.id
  FROM sys_tenants t
 CROSS JOIN (VALUES
    ('6602', '管理费用',   'expense', 'debit'),
    ('6711', '营业外支出', 'expense', 'debit')
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
    ('other_stock_document', 'other_receipt_in',  '1405', '1901', TRUE,
     '其他入库：借 库存商品 / 贷 待处理财产损溢'),
    ('other_stock_document', 'other_issue_out',   '1405', '1901', TRUE,
     '其他出库：借 待处理财产损溢 / 贷 库存商品'),
    ('other_stock_document', 'other_loss_out',    '1405', '6602', TRUE,
     '损耗出库：借 管理费用 / 贷 库存商品'),
    ('other_stock_document', 'scrap_out',         '1405', '6711', TRUE,
     '报废出库：借 营业外支出 / 贷 库存商品'),
    -- ⚠️ 期初**显式不进总账**：期初是余额不是本期发生额。
    --    这是「有配置且 generate_voucher = FALSE」，不是「没配置」——
    --    inventory_sync_voucher 会回 no_voucher_required，与 subject_not_found 是两回事。
    ('opening_balance',      'opening_balance_in', '1405', '1901', FALSE,
     '期初库存建账：期初是余额而非本期发生额，默认不进总账；需要时把 generate_voucher 打开并改对方科目')
 ) AS v(source_type, txn_code, stock_subject, counter_subject, generate_voucher, remark)
 WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_subject_map_s_539dcf81_b m
     WHERE m.tenant_id = t.id
       AND m.source_type = v.source_type
       AND m.transaction_type_code = v.txn_code
       AND m.is_deleted = 'n'
 );


-- ============================================================================
-- 9. 菜单（照 deploy_66 三步法：基线 → 基线角色授权 → 已物化租户补差）
--    挂在「进销存管理(inventory)」下，排在「存货科目映射」(18) 之后。
-- ============================================================================
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'inventory'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  v.menu_name, v.menu_code, 'C', v.icon, v.path, v.component, v.sort_order, '1', 'n', NULL
FROM (VALUES
  ('其他出入库', 'inventory_other-stock',       'SwapOutlined',     '/inventory/other-stock',       './pages/inventory/OtherStockDocuments', 19),
  ('期初库存',   'inventory_opening-balances',  'DatabaseOutlined', '/inventory/opening-balances',  './pages/inventory/OpeningBalances',     20)
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
  AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code IN ('inventory_other-stock', 'inventory_opening-balances')
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
-- 10. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
  v_tenant  RECORD;
  v_tbl     RECORD;
  v_menu    CONSTANT TEXT[] := ARRAY['inventory_other-stock', 'inventory_opening-balances'];
BEGIN
  -- 10.1 四张表 / RLS / tenant_id NOT NULL / direction CHECK
  FOR v_tbl IN
    SELECT * FROM (VALUES
      ('erp_other_stock_documents_s_539dcf81_b'),
      ('erp_other_stock_document_details_s_539dcf81_b'),
      ('erp_opening_balances_s_539dcf81_b'),
      ('erp_opening_balance_details_s_539dcf81_b')
    ) AS x(name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_tbl.name AND c.relkind = 'r'
    ) THEN
      v_missing := v_missing || format('缺表 %s;', v_tbl.name);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl.name;
    IF COALESCE(v_n, 0) < 4 THEN
      v_missing := v_missing || format('%s 的 RLS 策略只有 %s 条（应 ≥4）;', v_tbl.name, v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_tbl.name
       AND column_name = 'tenant_id' AND is_nullable = 'NO';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('%s 缺 tenant_id NOT NULL;', v_tbl.name);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.erp_other_stock_documents_s_539dcf81_b'::regclass
     AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%direction%';
  IF COALESCE(v_n, 0) = 0 THEN
    v_missing := v_missing || '其他出入库单头缺 direction CHECK 约束;';
  END IF;

  -- 10.2 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE is_deleted = 'n' AND document_type IN ('other_stock_document', 'opening_balance');
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || format('单据类型只到 %s/2（other_stock_document / opening_balance）;', v_n);
  END IF;

  -- 10.3 交易类型
  SELECT count(*) INTO v_n FROM public.sys_inventory_transaction_types
   WHERE is_deleted = 'n'
     AND code IN ('other_receipt_in', 'other_issue_out', 'other_loss_out', 'scrap_out');
  IF COALESCE(v_n, 0) <> 4 THEN
    v_missing := v_missing || format('交易类型只到 %s/4（other_receipt_in/other_issue_out/other_loss_out/scrap_out）;', v_n);
  END IF;

  -- 10.4 同一 (单据类型, 方向) 只能一条默认
  SELECT count(*) INTO v_n
    FROM public.sys_document_transaction_types m
    JOIN public.sys_document_types d ON d.id = m.document_type_id
   WHERE d.document_type = 'other_stock_document'
     AND m.direction = 'out' AND m.is_default AND m.is_deleted = 'n';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || format('other_stock_document/out 的默认交易类型有 %s 条（应恰好 1 条）;', v_n);
  END IF;

  -- 10.5 每个租户：6602 / 6711 科目齐备
  FOR v_tenant IN SELECT id, code FROM public.sys_tenants WHERE COALESCE(is_deleted, 'n') = 'n' LOOP
    SELECT count(*) INTO v_n FROM public.erp_account_subjects_s_539dcf81_b
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n' AND code IN ('6602', '6711');
    IF COALESCE(v_n, 0) <> 2 THEN
      v_missing := v_missing || format('租户%s缺科目（6602 管理费用 / 6711 营业外支出，实到 %s/2）;', v_tenant.id, v_n);
    END IF;

    -- 每个租户 5 条科目映射
    SELECT count(*) INTO v_n FROM public.erp_inventory_subject_map_s_539dcf81_b
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n'
       AND ((source_type = 'other_stock_document'
              AND transaction_type_code IN ('other_receipt_in', 'other_issue_out', 'other_loss_out', 'scrap_out'))
            OR (source_type = 'opening_balance' AND transaction_type_code = 'opening_balance_in'));
    IF COALESCE(v_n, 0) <> 5 THEN
      v_missing := v_missing || format('租户%s的科目映射只有 %s/5 条;', v_tenant.id, v_n);
    END IF;

    -- 期初那一条必须显式 generate_voucher = FALSE
    SELECT count(*) INTO v_n FROM public.erp_inventory_subject_map_s_539dcf81_b
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n'
       AND source_type = 'opening_balance' AND transaction_type_code = 'opening_balance_in'
       AND generate_voucher IS FALSE;
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('租户%s的期初入库未显式配 generate_voucher=FALSE（期初是余额，不该进总账）;', v_tenant.id);
    END IF;
  END LOOP;

  -- 10.6 基线菜单 + 角色授权
  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND is_deleted = 'n' AND menu_code = ANY (v_menu);
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || format('基线菜单只到 %s/2;', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE rm.is_deleted = 'n' AND m.menu_code = ANY (v_menu);
  IF COALESCE(v_n, 0) < 6 THEN
    v_missing := v_missing || format('基线菜单角色授权只有 %s 条（应 ≥6）;', v_n);
  END IF;

  -- 10.7 已物化租户必须有菜单副本（否则该租户看不到入口）
  FOR v_tenant IN
    SELECT id FROM public.sys_tenants
     WHERE COALESCE(is_deleted, 'n') = 'n' AND COALESCE(metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n FROM public.sys_menus
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n' AND menu_code = ANY (v_menu);
    IF COALESCE(v_n, 0) <> 2 THEN
      v_missing := v_missing || format('已物化租户%s的菜单副本只有 %s/2;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_104 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_104 OK：其他出入库 2 表 / 期初 2 表 / 2 DocType / 3 新交易类型 / 6602+6711 科目 / 5 条科目映射 / 2 菜单 齐备';
END;
$$;
