-- ============================================================================
-- deploy_87_inventory_gl_linkage.sql
--
-- P0-3：库存过账不生成会计凭证 —— 存货明细账与总账之间没有任何勾稽关系。
--
-- 修复前的现状
--   post_stock_document / post_inventory_document / post_production_document
--   只写 erp_inventory_transactions，从不生成 erp_vouchers / erp_gl_entries。
--   结果：库存金额的一切变动（采购入库、销售成本结转、生产领料、完工入库、
--   盘盈盘亏、库存调整）在存货科目上完全不可见，试算平衡表 / 明细账 / 资产负债表
--   永远看不到存货。这正是「离标准 ERP 的差距」评估里的第一条 P0。
--
-- 本脚本做三件事
--   1) 建 erp_inventory_subject_map_s_539dcf81_b：交易类型 → 存货科目 / 对方科目
--      的映射表（按租户可覆盖；表为空时用内置标准科目兜底）。
--   2) 提供两个 SECURITY DEFINER 助手：
--        inventory_sync_voucher()  —— 按单据的活跃流水聚合，生成并过账凭证
--        inventory_void_voucher()  —— 单据反过账时作废对应凭证
--   3) 用 CREATE OR REPLACE 重定义 6 个过账 / 反过账 RPC，在尾部接上这两个助手。
--      （deploy_24 / deploy_58 / deploy_69 里的旧定义在本脚本运行后即被覆盖，
--        所以本文件必须排在它们之后 —— 编号 87 > 69 已保证顺序。）
--
-- 关键设计取舍（改动前务必读完）
--
--   a. **不阻断库存过账**。缺科目、缺会计期间、期间未启用 / 已关闭 / 已锁定、
--      乃至凭证过账本身报错 —— 一律 RAISE WARNING，把原因放回返回值
--      的 `voucher` 字段，库存过账照常成功。
--      理由：本脚本之前库存过账根本没有「会计期间」概念。若现在改成硬阻断，
--      月结后（期间已关闭）仓库会完全无法收发货 —— 比「无勾稽」更严重的生产事故。
--      为免变成静默跳过，原因必须回传到前端（三个库存页的 Toast 已接）。
--
--   b. **金额一律本位币**。erp_inventory_transactions.total_cost 已是本位币口径
--      （deploy_69 冻结汇率后折算），所以凭证行 currency = NULL、exchange_rate = 1，
--      不做二次折算。erp_voucher_details.exchange_rate 有 CHECK (> 0)，不能写 0。
--
--   c. **方向由流水净额符号决定**，不由配置决定。净额 > 0 = 存货增加 →
--      借存货 / 贷对方；净额 < 0 = 存货减少 → 借对方 / 贷存货。
--      这样映射表里不可能写出与数据自相矛盾的方向。
--
--   d. **内部调拨不生成凭证**（inventory_transfer_in / inventory_transfer_out）。
--      同一法人主体内仓库间移动不改变资产负债，标准做法不进总账。
--      映射表里 generate_voucher = FALSE，内置兜底同样是 FALSE。
--
--   e. **一张单据一张凭证**。多交易类型（当前实现不会出现，但保留能力）会合并成
--      一张多分录凭证，借贷天然平衡。
--
--   f. 凭证 type 写 'general'（记账凭证）。erp_vouchers.type 前端只认
--      general / receipt / payment / transfer，写别的值表格里会裸露英文码。
--
-- 幂等
--   erp_vouchers 新增 inventory_source_type / inventory_source_id 两列 + 部分唯一
--   索引，做到「单据 ↔ 凭证」一一对应且可反查。重复调用不会生成第二张凭证。
-- ============================================================================


-- ============================================
-- 1. 科目映射表（按租户，fail-closed）
-- ============================================
-- 为什么是 erp_ 而不是 sys_：
--   它引用的是「本租户的科目表」（每个租户的会计科目体系不同），属于租户运行数据，
--   不具备平台基线语义，所以走 fail-closed（tenant_id NOT NULL + RLS），
--   而不是 sys_ 那套「基线可共享 + 租户可覆盖」的模板机制。
CREATE TABLE IF NOT EXISTS public.erp_inventory_subject_map_s_539dcf81_b (
    id                    SERIAL PRIMARY KEY,
    tenant_id             BIGINT       NOT NULL DEFAULT current_tenant_id(),
    corp_id               VARCHAR(128),
    emp_id                VARCHAR(128),
    is_deleted            CHAR(1)      NOT NULL DEFAULT 'n',
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    source_type           VARCHAR(64)  NOT NULL,   -- 过账 RPC 的 p_document_type
    transaction_type_code VARCHAR(64)  NOT NULL,   -- resolve_inventory_transaction_type(...) 的结果

    -- 存货侧科目：净额 > 0 时借记，净额 < 0 时贷记
    stock_subject_code    VARCHAR(32),
    -- 对方科目：方向上永远与存货侧相反
    counter_subject_code  VARCHAR(32),
    -- FALSE = 该交易类型不进总账（内部调拨）。TRUE 但科目为空 = 配置残缺，会告警跳过。
    generate_voucher      BOOLEAN      NOT NULL DEFAULT TRUE,

    remark                VARCHAR(255)
);

-- 唯一键带 tenant_id 在前 —— 与 deploy_51 的自动改写口径一致，
-- 避免本表再被 deploy_51 二次改写时产生第二个等价唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_subject_map_tenant_code
  ON public.erp_inventory_subject_map_s_539dcf81_b(tenant_id, source_type, transaction_type_code)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_inventory_subject_map_tenant
  ON public.erp_inventory_subject_map_s_539dcf81_b(tenant_id)
  WHERE is_deleted = 'n';

SELECT public.install_role_table_rls('erp_inventory_subject_map_s_539dcf81_b');

-- ============================================
-- 1b. erp_vouchers：单据反查列 + 一一对应唯一索引
-- ============================================
-- 不塞进 remark / source_doc_no 做「弱关联」：那样既不能加唯一约束，
-- 也无法支撑「这张入库单生成了哪张凭证」这种必查。显式两列最省事。
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS inventory_source_type VARCHAR(64);
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS inventory_source_id   INTEGER;

-- 一张单据一张活跃凭证。is_deleted = 'n' 让作废后的凭证不挡重新过账。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_vouchers_inventory_source
  ON public.erp_vouchers_s_539dcf81_b(tenant_id, inventory_source_type, inventory_source_id)
  WHERE inventory_source_type IS NOT NULL AND is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_vouchers_inventory_source
  ON public.erp_vouchers_s_539dcf81_b(inventory_source_type, inventory_source_id)
  WHERE is_deleted = 'n';

-- ============================================
-- 2. 播种标准映射（每个已有租户一份）
-- ============================================
-- 用 INSERT..WHERE NOT EXISTS 而不是 ON CONFLICT：
-- 不依赖任何唯一索引的存在（deploy_51 在全新环境里的改写顺序不该被本脚本假设）。
INSERT INTO public.erp_inventory_subject_map_s_539dcf81_b (
    tenant_id, source_type, transaction_type_code,
    stock_subject_code, counter_subject_code, generate_voucher, remark
)
SELECT t.id, v.source_type, v.txn_code,
       v.stock_subject, v.counter_subject, v.generate_voucher, v.remark
  FROM sys_tenants t
 CROSS JOIN (VALUES
    ('purchase_receipt',  'purchase_receipt_in',   '1405', '2202', TRUE,  '采购入库：借 库存商品 / 贷 应付账款'),
    ('sales_delivery',    'sales_delivery_out',    '1405', '6401', TRUE,  '销售出货：借 主营业务成本 / 贷 库存商品'),
    ('material_issue',    'material_issue_out',    '1403', '5001', TRUE,  '生产领料：借 生产成本 / 贷 原材料'),
    ('material_issue',    'material_return_in',    '1403', '5001', TRUE,  '生产退料：借 原材料 / 贷 生产成本'),
    ('production_receipt','production_receipt_in', '1405', '5001', TRUE,  '完工入库：借 库存商品 / 贷 生产成本'),
    ('stock_count',       'stock_count_increase',  '1405', '1901', TRUE,  '盘盈：借 库存商品 / 贷 待处理财产损溢'),
    ('stock_count',       'stock_count_decrease',  '1405', '1901', TRUE,  '盘亏：借 待处理财产损溢 / 贷 库存商品'),
    ('stock_adjustment',  'stock_adjust_in',       '1405', '1901', TRUE,  '调整增加：借 库存商品 / 贷 待处理财产损溢'),
    ('stock_adjustment',  'stock_adjust_out',      '1405', '1901', TRUE,  '调整减少：借 待处理财产损溢 / 贷 库存商品'),
    ('inventory_transfer','inventory_transfer_out', NULL,   NULL,   FALSE, '内部调拨：不生成凭证（同一主体内移动）'),
    ('inventory_transfer','inventory_transfer_in',  NULL,   NULL,   FALSE, '内部调拨：不生成凭证（同一主体内移动）')
 ) AS v(source_type, txn_code, stock_subject, counter_subject, generate_voucher, remark)
 WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_subject_map_s_539dcf81_b m
     WHERE m.tenant_id = t.id
       AND m.source_type = v.source_type
       AND m.transaction_type_code = v.txn_code
       AND m.is_deleted = 'n'
 );

-- ============================================
-- 3. 补种标准会计科目（每个已有租户一份，缺什么补什么）
-- ============================================
-- 为什么本脚本要管科目：生产库里 erp_account_subjects 只有 8 个科目
-- （1001/1002/1122/1602/2202/6601/6602/6603），**没有存货、没有主营业务成本、
-- 没有生产成本**。不补的话库存过账永远算不出科目 → 永远跳过凭证 → 本 P0 白修。
-- 这是「让功能开箱可用」的最小数据补齐，不覆盖任何已存在的科目。
INSERT INTO public.erp_account_subjects_s_539dcf81_b (
    code, name, level, category, direction, status, is_deleted, tenant_id
)
SELECT v.code, v.name, 1, v.category, v.direction, 'active', 'n', t.id
  FROM sys_tenants t
 CROSS JOIN (VALUES
    ('1403', '原材料',          'asset',   'debit'),
    ('1405', '库存商品',        'asset',   'debit'),
    ('1901', '待处理财产损溢',  'asset',   'debit'),
    ('5001', '生产成本',        'expense', 'debit'),
    ('6401', '主营业务成本',    'expense', 'debit'),
    ('6001', '主营业务收入',    'revenue', 'credit')
 ) AS v(code, name, category, direction)
 WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_account_subjects_s_539dcf81_b s
     WHERE s.tenant_id = t.id AND s.code = v.code AND s.is_deleted = 'n'
 );


-- ============================================
-- 4. 助手一：单据 → 流水 reference_type 集合
-- ============================================
-- 调拨单的两条腿写的是字面量 'inventory_transfer_out' / 'inventory_transfer_in'
-- （deploy_24 起就是这样），而单头类型是 'inventory_transfer'。
-- 所有按单据找流水的地方都要用这个集合，别再各写一遍。
CREATE OR REPLACE FUNCTION public.inventory_document_ref_types(p_source_type TEXT)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE p_source_type
           WHEN 'inventory_transfer'
             THEN ARRAY['inventory_transfer', 'inventory_transfer_in', 'inventory_transfer_out']
           ELSE ARRAY[p_source_type]
         END;
$function$;


-- ============================================
-- 5. 助手二：查一条映射规则（租户配置优先，内置标准科目兜底）
-- ============================================
CREATE OR REPLACE FUNCTION public.inventory_voucher_plan(
    p_source_type           TEXT,
    p_transaction_type_code TEXT,
    p_tenant_id             BIGINT
) RETURNS TABLE (
    stock_subject_code   TEXT,
    counter_subject_code TEXT,
    generate_voucher     BOOLEAN
)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_stock   TEXT;
  v_counter TEXT;
  v_gen     BOOLEAN;
BEGIN
  -- ① 租户配置
  SELECT m.stock_subject_code, m.counter_subject_code, m.generate_voucher
    INTO v_stock, v_counter, v_gen
    FROM public.erp_inventory_subject_map_s_539dcf81_b m
   WHERE m.is_deleted = 'n'
     AND m.source_type = p_source_type
     AND m.transaction_type_code = p_transaction_type_code
     AND (p_tenant_id IS NULL OR m.tenant_id = p_tenant_id)
   ORDER BY m.id
   LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_stock, v_counter, COALESCE(v_gen, TRUE);
    RETURN;
  END IF;

  -- ② 内置兜底：企业会计准则常用科目。映射表为空（新租户、老环境）也能出凭证。
  IF p_transaction_type_code = 'purchase_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '2202'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'sales_delivery_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '6401'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'material_issue_out' THEN
    RETURN QUERY SELECT '1403'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'material_return_in' THEN
    RETURN QUERY SELECT '1403'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'production_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_count_increase' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_count_decrease' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_adjust_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_adjust_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  END IF;

  -- ③ 其余（内部调拨两条腿、领料/退料以外的中立类型）一律不进总账
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, FALSE;
END;
$function$;


-- ============================================
-- 6. 助手三：生成并过账库存凭证
-- ============================================
-- 参数
--   p_source_type   业务单据类型（purchase_receipt / sales_delivery / ...）
--   p_source_id     单据主键
--   p_document_no   单据编号（写进 voucher_no / source_doc_no，便于反查）
--   p_document_date 单据日期（决定会计期间）
--   p_tenant_id     可空。为空时从流水行推导 —— 这样调用方不必改自己的 SELECT 列表。
--   p_remark        凭证摘要前缀
--
-- 返回值永远是 jsonb（不抛异常），至少含：
--   ok / generated / skipped_reason / voucher_id / voucher_no / debit_total / line_count
CREATE OR REPLACE FUNCTION public.inventory_sync_voucher(
    p_source_type   TEXT,
    p_source_id     INTEGER,
    p_document_no   TEXT,
    p_document_date DATE,
    p_tenant_id     BIGINT DEFAULT NULL,
    p_remark        TEXT   DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ref_types   TEXT[];
  v_tenant      BIGINT;
  v_date        DATE;
  v_period      RECORD;
  v_existing    RECORD;
  v_group       RECORD;
  v_plan        RECORD;
  v_voucher_id  INTEGER;
  v_voucher_no  TEXT;
  v_line_no     INTEGER := 0;
  v_amount      NUMERIC;
  v_debit_total NUMERIC := 0;
  v_stock_id    INTEGER;
  v_counter_id  INTEGER;
  v_summary     TEXT;
  v_skipped     TEXT;
  v_pending     INTEGER := 0;
  v_result      JSONB;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL OR p_source_id <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'generated', FALSE,
                              'skipped_reason', 'invalid_arguments');
  END IF;

  v_ref_types := public.inventory_document_ref_types(p_source_type);

  -- ---- 租户：显式传入优先，否则从流水推导（流水行一定带 tenant_id）--------
  v_tenant := p_tenant_id;
  IF v_tenant IS NULL THEN
    SELECT MIN(t.tenant_id) INTO v_tenant
      FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = ANY (v_ref_types)
       AND t.reference_id = p_source_id
       AND t.is_deleted = 'n';
  END IF;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'no_inventory_transactions');
  END IF;

  -- ---- 幂等：本单据已有活跃凭证吗？--------------------------------------
  SELECT v.id, v.voucher_no, v.status
    INTO v_existing
    FROM public.erp_vouchers_s_539dcf81_b v
   WHERE v.tenant_id = v_tenant
     AND v.inventory_source_type = p_source_type
     AND v.inventory_source_id = p_source_id
     AND v.is_deleted = 'n'
   LIMIT 1;

  IF FOUND THEN
    IF v_existing.status = 'posted' THEN
      RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
        'skipped_reason', 'voucher_already_posted',
        'voucher_id', v_existing.id, 'voucher_no', v_existing.voucher_no);
    END IF;
    -- 草稿 / 已作废：清掉重来（重新过账场景）
    UPDATE public.erp_voucher_details_s_539dcf81_b
       SET is_deleted = 'y', updated_at = NOW()
     WHERE voucher_id = v_existing.id AND is_deleted = 'n';
    UPDATE public.erp_vouchers_s_539dcf81_b
       SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
     WHERE id = v_existing.id;
  END IF;

  -- ---- 先算有几组需要进总账；不需要就别去烦会计期间 ----------------------
  SELECT COUNT(*) INTO v_pending
    FROM (
      SELECT DISTINCT t.transaction_type AS code
        FROM public.erp_inventory_transactions_s_539dcf81_b t
       WHERE t.reference_type = ANY (v_ref_types)
         AND t.reference_id = p_source_id
         AND t.tenant_id = v_tenant
         AND t.is_deleted = 'n'
    ) g
   CROSS JOIN LATERAL public.inventory_voucher_plan(p_source_type, g.code, v_tenant) pl
   WHERE pl.generate_voucher IS TRUE;

  IF COALESCE(v_pending, 0) = 0 THEN
    -- 内部调拨走这里：这是**预期**结果，不是错误
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'no_voucher_required',
                              'document_no', p_document_no);
  END IF;

  -- ---- 会计期间 ----------------------------------------------------------
  v_date := COALESCE(p_document_date, CURRENT_DATE);
  SELECT p.id, p.is_enabled, p.is_closed, p.is_locked, p.year, p.month
    INTO v_period
    FROM public.erp_accounting_periods_s_539dcf81_b p
   WHERE p.is_deleted = 'n'
     AND p.tenant_id = v_tenant
     AND v_date BETWEEN p.start_date AND p.end_date
   ORDER BY p.id
   LIMIT 1;

  IF NOT FOUND THEN
    v_skipped := 'no_accounting_period';
  ELSIF NOT COALESCE(v_period.is_enabled, FALSE) THEN
    v_skipped := 'period_not_enabled';
  ELSIF COALESCE(v_period.is_closed, FALSE) THEN
    v_skipped := 'period_closed';
  ELSIF COALESCE(v_period.is_locked, FALSE) THEN
    v_skipped := 'period_locked';
  END IF;

  IF v_skipped IS NOT NULL THEN
    RAISE WARNING '库存凭证未生成（% %，单据日期 %）：%，请到「会计期间」处理后再反过账重过账',
      p_source_type, p_document_no, v_date, v_skipped;
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', v_skipped,
                              'document_date', v_date,
                              'document_no', p_document_no);
  END IF;

  -- ---- 建凭证头 ----------------------------------------------------------
  v_voucher_no := LEFT(format('IV-%s', COALESCE(p_document_no, p_source_id::TEXT)), 60);

  INSERT INTO public.erp_vouchers_s_539dcf81_b (
    is_deleted, voucher_no, voucher_date, period_id, type, source_doc_no,
    total_amount, remark, status, currency, exchange_rate, tenant_id,
    inventory_source_type, inventory_source_id, created_at, updated_at
  ) VALUES (
    'n', v_voucher_no, v_date, v_period.id, 'general', p_document_no,
    0, COALESCE(p_remark, format('%s %s 自动生成', p_source_type, p_document_no)),
    'draft', NULL, 1, v_tenant,
    p_source_type, p_source_id, NOW(), NOW()
  ) RETURNING id INTO v_voucher_id;

  -- ---- 按交易类型聚合流水，逐组出两行分录 --------------------------------
  FOR v_group IN
    SELECT t.transaction_type AS code,
           SUM(COALESCE(t.total_cost, 0)) AS net_cost
      FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = ANY (v_ref_types)
       AND t.reference_id = p_source_id
       AND t.tenant_id = v_tenant
       AND t.is_deleted = 'n'
     GROUP BY t.transaction_type
     ORDER BY t.transaction_type
  LOOP
    SELECT * INTO v_plan
      FROM public.inventory_voucher_plan(p_source_type, v_group.code, v_tenant);

    CONTINUE WHEN NOT COALESCE(v_plan.generate_voucher, FALSE);

    v_amount := ROUND(ABS(COALESCE(v_group.net_cost, 0)), 2);
    CONTINUE WHEN v_amount <= 0;                       -- 零金额行不进凭证

    v_stock_id   := public.finance_subject_id_for(ARRAY[v_plan.stock_subject_code], v_tenant);
    v_counter_id := public.finance_subject_id_for(ARRAY[v_plan.counter_subject_code], v_tenant);

    IF v_stock_id IS NULL OR v_counter_id IS NULL THEN
      RAISE WARNING
        '库存凭证未生成（% %）：交易类型 % 的科目 % / % 在租户 % 下不存在',
        p_source_type, p_document_no, v_group.code,
        COALESCE(v_plan.stock_subject_code, '<未配置>'),
        COALESCE(v_plan.counter_subject_code, '<未配置>'), v_tenant;
      UPDATE public.erp_voucher_details_s_539dcf81_b
         SET is_deleted = 'y', updated_at = NOW()
       WHERE voucher_id = v_voucher_id AND is_deleted = 'n';
      UPDATE public.erp_vouchers_s_539dcf81_b
         SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
       WHERE id = v_voucher_id;
      RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                                'skipped_reason', 'subject_not_found',
                                'transaction_type', v_group.code,
                                'document_no', p_document_no);
    END IF;

    v_summary := format('%s %s', COALESCE(p_remark, p_source_type), COALESCE(p_document_no, ''));

    -- 净额 > 0：存货增加 → 借存货 / 贷对方
    -- 净额 < 0：存货减少 → 借对方 / 贷存货
    IF COALESCE(v_group.net_cost, 0) > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_stock_id, v_summary,
        v_amount, 0, NULL, 1, v_amount, 0, v_tenant, NOW(), NOW());
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_counter_id, v_summary,
        0, v_amount, NULL, 1, 0, v_amount, v_tenant, NOW(), NOW());
      v_debit_total := v_debit_total + v_amount;
    ELSE
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_counter_id, v_summary,
        v_amount, 0, NULL, 1, v_amount, 0, v_tenant, NOW(), NOW());
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_stock_id, v_summary,
        0, v_amount, NULL, 1, 0, v_amount, v_tenant, NOW(), NOW());
      v_debit_total := v_debit_total + v_amount;
    END IF;
  END LOOP;

  IF v_line_no = 0 THEN
    UPDATE public.erp_vouchers_s_539dcf81_b
       SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
     WHERE id = v_voucher_id;
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'zero_amount',
                              'document_no', p_document_no);
  END IF;

  UPDATE public.erp_vouchers_s_539dcf81_b
     SET total_amount = v_debit_total, updated_at = NOW()
   WHERE id = v_voucher_id;

  -- ---- 过账 --------------------------------------------------------------
  -- 单独兜异常：凭证侧的失败绝不能把库存过账一起回滚掉（见文件头设计取舍 a）。
  BEGIN
    v_result := public.post_voucher_document(v_voucher_id, gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '库存凭证过账失败（% %，凭证 %）: %',
      p_source_type, p_document_no, v_voucher_no, SQLERRM;
    RETURN jsonb_build_object('ok', FALSE, 'generated', TRUE,
                              'skipped_reason', 'voucher_post_failed',
                              'voucher_id', v_voucher_id,
                              'voucher_no', v_voucher_no,
                              'error', SQLERRM,
                              'document_no', p_document_no);
  END;

  RETURN jsonb_build_object(
    'ok', TRUE, 'generated', TRUE,
    'voucher_id', v_voucher_id, 'voucher_no', v_voucher_no,
    'status', COALESCE(v_result->>'status', 'posted'),
    'debit_total', v_debit_total, 'line_count', v_line_no,
    'period_id', v_period.id, 'document_no', p_document_no);
END;
$function$;


-- ============================================
-- 7. 助手四：作废单据对应的库存凭证
-- ============================================
-- 与 sync 相反：单据反过账时调用。找不到凭证 = 正常（本来就没生成过），返回 found=FALSE。
-- 凭证侧任何失败都只告警 + 返回错误，不回滚库存反过账（否则月结期间无法反过账）。
CREATE OR REPLACE FUNCTION public.inventory_void_voucher(
    p_source_type TEXT,
    p_source_id   INTEGER,
    p_tenant_id   BIGINT DEFAULT NULL,
    p_idempotency_key UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_voucher RECORD;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL OR p_source_id <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'found', FALSE,
                              'skipped_reason', 'invalid_arguments');
  END IF;

  SELECT v.id, v.voucher_no, v.status
    INTO v_voucher
    FROM public.erp_vouchers_s_539dcf81_b v
   WHERE v.inventory_source_type = p_source_type
     AND v.inventory_source_id = p_source_id
     AND v.is_deleted = 'n'
     AND (p_tenant_id IS NULL OR v.tenant_id = p_tenant_id)
   ORDER BY v.id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', TRUE, 'found', FALSE,
                              'skipped_reason', 'no_voucher');
  END IF;

  IF v_voucher.status = 'posted' THEN
    BEGIN
      PERFORM public.reverse_voucher_document(
        v_voucher.id, COALESCE(p_idempotency_key, gen_random_uuid()));
    EXCEPTION WHEN OTHERS THEN
      -- 总账行删不掉（期间已锁定 / 已关闭）→ 保留凭证原样，等人工处理。
      -- 不软删凭证，避免留下「凭证没了但总账行还在」的孤儿分录。
      RAISE WARNING '库存凭证作废失败（% %，凭证 %）: %',
        p_source_type, p_source_id, v_voucher.voucher_no, SQLERRM;
      RETURN jsonb_build_object('ok', FALSE, 'found', TRUE, 'voided', FALSE,
                                'skipped_reason', 'voucher_reverse_failed',
                                'voucher_id', v_voucher.id,
                                'voucher_no', v_voucher.voucher_no,
                                'error', SQLERRM);
    END;
  END IF;

  UPDATE public.erp_voucher_details_s_539dcf81_b
     SET is_deleted = 'y', updated_at = NOW()
   WHERE voucher_id = v_voucher.id AND is_deleted = 'n';

  UPDATE public.erp_vouchers_s_539dcf81_b
     SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
   WHERE id = v_voucher.id;

  RETURN jsonb_build_object('ok', TRUE, 'found', TRUE, 'voided', TRUE,
                            'voucher_id', v_voucher.id,
                            'voucher_no', v_voucher.voucher_no);
END;
$function$;


-- ============================================
-- 8. 授权（过账 RPC 是 INVOKER，内部调用这两个助手需要调用方有 EXECUTE）
-- ============================================
GRANT EXECUTE ON FUNCTION public.inventory_document_ref_types(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_voucher_plan(TEXT, TEXT, BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_sync_voucher(TEXT, INTEGER, TEXT, DATE, BIGINT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_void_voucher(TEXT, INTEGER, BIGINT, UUID) TO anon, authenticated, service_role;

-- ============================================================================
-- deploy_87_inventory_gl_linkage.sql  —— 第 2 / 3 部分：6 个 RPC 的新定义
--
-- 下面 6 个 CREATE OR REPLACE 函数体是从线上库 pg_get_functiondef 原样导出的，
-- 相对旧定义的**唯一**改动是：DECLARE 段多了一个 v_voucher_result 变量，
-- 以及在结尾 RETURN 之前插入了一次助手调用。
--
-- **本文件是这 6 个函数的最新定义来源**：deploy_24 / deploy_58 / deploy_69 /
-- deploy_86 里的旧定义已被本文件覆盖（编号 87 排在它们之后，执行顺序保证生效）。
-- 要改它们就改本文件，别再回改那四份 —— 改了不会有任何效果。
--
-- 覆盖关系：
--   post_stock_document         <- deploy_69 覆盖 deploy_13
--   reverse_stock_document      <- deploy_69
--   post_inventory_document     <- deploy_24
--   reverse_inventory_document  <- deploy_86
--   post_production_document    <- deploy_58 覆盖 deploy_56
--   reverse_production_document <- deploy_56
-- ============================================================================


-- ============================================
-- 9. 重定义 6 个过账 / 反过账 RPC（尾部接上凭证助手）
-- ============================================


-- ---- post_stock_document ----
CREATE OR REPLACE FUNCTION public.post_stock_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC; v_location_id INTEGER;
  allow_negative BOOLEAN; normalized_batch TEXT; v_transaction_no TEXT;
  v_exchange_rate NUMERIC; v_base_total NUMERIC;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no,
      x.receipt_date AS document_date, x.supplier_id,
      NULL::INTEGER AS customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no,
      x.delivery_date AS document_date, NULL::INTEGER AS supplier_id,
      x.customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Stock document has no warehouse' USING ERRCODE = '23502';
  END IF;

  -- 冻结汇率。NULL 或 0 一律按 1 处理 —— 否则折本位币会把金额乘成 0 而静默清零。
  v_exchange_rate := COALESCE(NULLIF(h.exchange_rate, 0), 1);
  v_base_total := ROUND(COALESCE(h.total_amount, 0) * v_exchange_rate, 2);

  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id
      AND t.tenant_id = h.tenant_id
      AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    PERFORM x.id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    WHERE x.receipt_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  ELSE
    PERFORM x.id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    WHERE x.delivery_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id
    AND w.tenant_id = h.tenant_id
    AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  FOR d IN
    SELECT x.id AS detail_id, x.product_id, x.quantity,
      x.unit_price AS receipt_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no, x.expiry_date,
      x.location_id AS detail_location_id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE,
      x.location_id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'sales_delivery'
      AND x.delivery_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    -- 明细库位优先，回退到主表默认库位
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    -- 库位必须属于本单仓库（若指定了库位）
    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id
        AND b.warehouse_id = h.warehouse_id
        AND b.tenant_id = h.tenant_id
        AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', d.product_id, h.warehouse_id,
        COALESCE(v_location_id, 0), COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = d.product_id
      AND x.warehouse_id = h.warehouse_id
      AND x.tenant_id = h.tenant_id
      AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF FOUND THEN
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      inventory_unit_cost := COALESCE(i.unit_cost, 0);
    ELSE
      old_qty := 0; old_available := 0; old_cost := 0;
      inventory_unit_cost := 0;
    END IF;

    IF p_document_type = 'purchase_receipt' THEN
      -- 入库成本：单据单价是原币 → **先折本位币**再进库存。
      -- 后两个兜底（物料价、既有库存单价）本来就是本位币口径，不再折汇。
      v_unit_cost := COALESCE(
        NULLIF(d.receipt_unit_cost, 0) * v_exchange_rate,
        NULLIF(d.product_unit_cost, 0),
        NULLIF(inventory_unit_cost, 0), 0);
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
    ELSE
      -- 出库成本：取移动加权（已是本位币），与单据币种无关
      v_unit_cost := COALESCE(NULLIF(inventory_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
    END IF;
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Insufficient stock for product %, warehouse %, location %: available %, requested %',
        d.product_id, h.warehouse_id, COALESCE(v_location_id, 0),
        old_available, d.quantity
        USING ERRCODE = '23514';
    END IF;

    IF i.id IS NULL THEN
      INSERT INTO public.erp_inventory_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
        quantity, available_quantity, locked_quantity, unit_cost,
        total_cost, batch_no, expiry_date, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
        v_location_id,
        new_qty, new_available, 0,
        CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
        new_cost, normalized_batch, d.expiry_date, h.tenant_id
      ) RETURNING * INTO i;
    ELSE
      UPDATE public.erp_inventory_s_539dcf81_b
      SET quantity = new_qty, available_quantity = new_available,
          unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost
                           ELSE ABS(new_cost / new_qty) END,
          total_cost = new_cost,
          expiry_date = COALESCE(d.expiry_date, expiry_date),
          updated_at = NOW()
      WHERE id = i.id;
    END IF;

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(
        p_document_type,
        CASE WHEN p_document_type = 'purchase_receipt' THEN 'in' ELSE 'out' END),
      h.document_date, d.product_id, h.warehouse_id, v_location_id, normalized_batch,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity ELSE -d.quantity END,
      v_unit_cost,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity * v_unit_cost ELSE -(d.quantity * v_unit_cost) END,
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN format('采购入库单 %s 过账', h.document_no)
           ELSE format('销售出货单 %s 过账', h.document_no) END,
      h.tenant_id
    );
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'Stock document has no active details'
      USING ERRCODE = '23514';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    IF h.supplier_id IS NULL OR COALESCE(h.total_amount, 0) <= 0 THEN
      RAISE EXCEPTION 'Purchase receipt requires supplier and positive amount'
        USING ERRCODE = '23514';
    END IF;
    -- 应付：原币金额进 amount/balance，币种与汇率从入库单继承（此前硬编码 'CNY', 1）
    INSERT INTO public.erp_payables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, supplier_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date, amount,
      paid_amount, balance, currency, exchange_rate, base_amount,
      status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.supplier_id, 'purchase_receipt',
      h.document_no, 'purchase_receipt', p_document_id, h.document_no,
      h.document_date, h.document_date, h.total_amount, 0, h.total_amount,
      h.currency, v_exchange_rate, v_base_total,
      'open',
      format('采购入库单 %s 过账自动生成', h.document_no), h.tenant_id
    )
    ON CONFLICT (tenant_id, source_type, source_id)
      WHERE is_deleted = 'n' AND source_type = 'purchase_receipt'
        AND source_id IS NOT NULL
    DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase receipt already has an active payable'
        USING ERRCODE = '23505';
    END IF;
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    -- 应收：**本期新增**。此前销售出货只改状态、不生成应收，导致应收只能
    -- 财务页手工录入，币种没有来源可继承。这里与采购入库生成应付完全对称。
    IF h.customer_id IS NULL OR COALESCE(h.total_amount, 0) <= 0 THEN
      RAISE EXCEPTION 'Sales delivery requires customer and positive amount'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.erp_receivables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, customer_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date,
      amount, paid_amount, balance, currency, exchange_rate, base_amount,
      status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.customer_id, 'sales_delivery',
      h.document_no, 'sales_delivery', p_document_id, h.document_no,
      h.document_date, h.document_date,
      h.total_amount, 0, h.total_amount,
      h.currency, v_exchange_rate, v_base_total,
      'open',
      format('销售出货单 %s 过账自动生成', h.document_no), h.tenant_id
    )
    ON CONFLICT (tenant_id, source_type, source_id)
      WHERE is_deleted = 'n' AND source_type = 'sales_delivery'
        AND source_id IS NOT NULL
    DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sales delivery already has an active receivable'
        USING ERRCODE = '23505';
    END IF;
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87）--------------------------------------
  -- 单头已置 posted、流水已落库，此处生成并过账会计凭证。
  -- 失败只告警不阻断，原因回传到返回值的 voucher 字段（见 deploy_87 文件头）。
  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => CASE WHEN p_document_type = 'purchase_receipt'
                            THEN format('采购入库单 %s', h.document_no)
                            ELSE format('销售出货单 %s', h.document_no) END);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'currency', h.currency, 'exchange_rate', v_exchange_rate,
    'base_total_amount', v_base_total,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ---- reverse_stock_document ----
CREATE OR REPLACE FUNCTION public.reverse_stock_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; t RECORD; i RECORD; ar_ap RECORD;
  allow_negative BOOLEAN; normalized_batch TEXT;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC; line_count INTEGER := 0;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.total_amount,
      x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no, x.total_amount,
      x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- 已核销/已收付的往来单据不允许反过账（采购→应付，销售→应收）
  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.* INTO ar_ap FROM public.erp_payables_s_539dcf81_b x
    WHERE x.source_type = 'purchase_receipt'
      AND x.source_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated payable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) > 0
       OR ABS(COALESCE(ar_ap.balance, 0) -
              COALESCE(h.total_amount, 0)) >= 0.005 THEN
      RAISE EXCEPTION 'Payable was paid or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT x.* INTO ar_ap FROM public.erp_receivables_s_539dcf81_b x
    WHERE x.source_type = 'sales_delivery'
      AND x.source_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated receivable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) > 0
       OR ABS(COALESCE(ar_ap.balance, 0) -
              COALESCE(h.total_amount, 0)) >= 0.005 THEN
      RAISE EXCEPTION 'Receivable was collected or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id,
             COALESCE(x.location_id, 0), x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(t.location_id, 0), COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id
      AND x.warehouse_id = t.warehouse_id
      AND x.tenant_id = t.tenant_id
      AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory missing for transaction %, product %, warehouse %, location %',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0)
        USING ERRCODE = 'P0002';
    END IF;

    -- 按流水行自身的成本反向加减 → 天然按原始汇率回冲，无需再折汇
    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_available := COALESCE(i.available_quantity, 0) -
      COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
      INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
      WHERE w.id = t.warehouse_id
        AND w.tenant_id = t.tenant_id
        AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION 'Cannot reverse: stock was consumed for product %, warehouse %, location %',
        t.product_id, t.warehouse_id, COALESCE(t.location_id, 0) USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(t.unit_cost, i.unit_cost, 0)
      ELSE ABS(new_cost / new_qty)
    END;
    UPDATE public.erp_inventory_s_539dcf81_b
    SET quantity = new_qty, available_quantity = new_available,
        unit_cost = restored_unit_cost, total_cost = new_cost,
        updated_at = NOW()
    WHERE id = i.id;
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id
    AND tenant_id = h.tenant_id
    AND is_deleted = 'n';

  IF p_document_type = 'purchase_receipt' THEN
    UPDATE public.erp_payables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_receivables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 作废对应库存凭证（deploy_87）--------------------------------------
  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ---- post_inventory_document ----
CREATE OR REPLACE FUNCTION public.post_inventory_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; normalized_batch TEXT; allow_negative BOOLEAN;
  v_voucher_result JSONB; v_document_no TEXT; v_document_date DATE;
BEGIN
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_adjustment' THEN
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type USING ERRCODE = '22023';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %', COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    IF h.from_warehouse_id IS NULL OR h.to_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'Transfer requires both warehouses' USING ERRCODE = '23502';
    END IF;
    IF h.from_warehouse_id = h.to_warehouse_id THEN
      RAISE EXCEPTION 'Transfer warehouses must be different' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    FOR d IN SELECT * FROM public.erp_inventory_transfer_details_s_539dcf81_b WHERE transfer_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
      WHERE x.product_id = d.product_id AND x.warehouse_id = h.from_warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.from_location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      IF NOT FOUND OR COALESCE(i.available_quantity, 0) < d.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for transfer line %, product %', d.line_no, d.product_id USING ERRCODE = '23514';
      END IF;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
      UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), public.resolve_inventory_transaction_type(p_document_type, 'out'), h.transfer_date, d.product_id, h.from_warehouse_id, COALESCE(d.from_location_id, h.from_location_id), normalized_batch, -d.quantity, v_unit_cost, -(d.quantity * v_unit_cost), 'inventory_transfer_out', p_document_id, d.id, p_idempotency_key, '库存调拨出库');

      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.to_warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.to_location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      IF FOUND THEN
        old_qty := COALESCE(i.quantity, 0);
        old_available := COALESCE(i.available_quantity, 0);
        old_cost := COALESCE(i.total_cost, 0);
      ELSE
        old_qty := 0; old_available := 0; old_cost := 0;
      END IF;
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.to_warehouse_id, COALESCE(d.to_location_id, h.to_location_id), new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0') || 'T', 50), public.resolve_inventory_transaction_type(p_document_type, 'in'), h.transfer_date, d.product_id, h.to_warehouse_id, COALESCE(d.to_location_id, h.to_location_id), normalized_batch, d.quantity, v_unit_cost, d.quantity * v_unit_cost, 'inventory_transfer_in', p_document_id, d.id, p_idempotency_key, '库存调拨入库');
    END LOOP;
    UPDATE public.erp_inventory_transfers_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    FOR d IN SELECT * FROM public.erp_stock_count_details_s_539dcf81_b WHERE count_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      new_qty := COALESCE(d.counted_quantity, 0);
      new_available := new_qty;
      new_cost := new_qty * v_unit_cost;
      IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
        RAISE EXCEPTION 'Count result cannot be negative' USING ERRCODE = '23514';
      END IF;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / NULLIF(new_qty, 0)) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id, h.location_id, new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), public.resolve_inventory_transaction_type(p_document_type, CASE WHEN new_qty >= old_qty THEN 'in' ELSE 'out' END), h.count_date, d.product_id, h.warehouse_id, COALESCE(d.location_id, h.location_id), normalized_batch, new_qty - old_qty, v_unit_cost, (new_qty - old_qty) * v_unit_cost, p_document_type, p_document_id, d.id, p_idempotency_key, '库存盘点差异');
    END LOOP;
    UPDATE public.erp_stock_counts_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  ELSE
    FOR d IN SELECT * FROM public.erp_stock_adjustment_details_s_539dcf81_b WHERE adjust_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      IF d.direction = 'out' THEN
        new_qty := old_qty - d.quantity;
        new_available := old_available - d.quantity;
        new_cost := old_cost - d.quantity * v_unit_cost;
        IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
          RAISE EXCEPTION 'Insufficient stock for adjustment line %', d.line_no USING ERRCODE = '23514';
        END IF;
      ELSE
        new_qty := old_qty + d.quantity;
        new_available := old_available + d.quantity;
        new_cost := old_cost + d.quantity * v_unit_cost;
      END IF;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id, h.location_id, new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), public.resolve_inventory_transaction_type(p_document_type, CASE WHEN d.direction = 'out' THEN 'out' ELSE 'in' END), h.adjust_date, d.product_id, h.warehouse_id, COALESCE(d.location_id, h.location_id), normalized_batch, CASE WHEN d.direction = 'out' THEN -d.quantity ELSE d.quantity END, v_unit_cost, CASE WHEN d.direction = 'out' THEN -(d.quantity * v_unit_cost) ELSE d.quantity * v_unit_cost END, p_document_type, p_document_id, d.id, p_idempotency_key, '库存调整');
    END LOOP;
    UPDATE public.erp_stock_adjustments_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  END IF;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'No detail rows found for document' USING ERRCODE = 'P0002';
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87）--------------------------------------
  -- h 是 SELECT *，三种单据的编号 / 日期列名各不相同，这里显式分派。
  -- （plpgsql 的 IF 分支是惰性求值，不会去取不存在的 record 字段。）
  IF p_document_type = 'inventory_transfer' THEN
    v_document_no := h.transfer_no;  v_document_date := h.transfer_date;
  ELSIF p_document_type = 'stock_count' THEN
    v_document_no := h.count_no;     v_document_date := h.count_date;
  ELSE
    v_document_no := h.adjust_no;    v_document_date := h.adjust_date;
  END IF;

  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => v_document_no,
    p_document_date => v_document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => CASE p_document_type
                         WHEN 'inventory_transfer' THEN format('库存调拨单 %s', v_document_no)
                         WHEN 'stock_count'        THEN format('库存盘点单 %s', v_document_no)
                         ELSE format('库存调整单 %s', v_document_no) END);

  RETURN jsonb_build_object('ok', TRUE, 'document_type', p_document_type,
    'document_id', p_document_id, 'status', 'posted', 'line_count', line_count,
    'voucher', v_voucher_result);
END;
$function$;


-- ---- reverse_inventory_document ----
CREATE OR REPLACE FUNCTION public.reverse_inventory_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; t RECORD; i RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC;
  normalized_batch TEXT;
  allow_negative BOOLEAN;
  v_ref_types TEXT[];
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('inventory_transfer', 'stock_count', 'stock_adjustment') THEN
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- ---- 锁单据头 ----------------------------------------------------------
  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- ---- 幂等：同一冲销键重复调用 ------------------------------------------
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- ---- 流水 reference_type 匹配集合 --------------------------------------
  -- 调拨单两条腿写的是 'inventory_transfer_out' / 'inventory_transfer_in'
  -- 字面量（deploy_24 第 216 / 240 行），兼容两种写法。
  v_ref_types := CASE p_document_type
    WHEN 'inventory_transfer'
      THEN ARRAY['inventory_transfer', 'inventory_transfer_in', 'inventory_transfer_out']
    ELSE ARRAY[p_document_type]
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'No active inventory transactions found for % #% — 单据状态是 posted 但没有对应流水，请人工核对',
      p_document_type, p_document_id USING ERRCODE = 'P0002';
  END IF;

  -- ---- 逐条冲销 ----------------------------------------------------------
  FOR t IN
    SELECT x.*
      FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id,
              x.location_id NULLS FIRST, x.batch_no NULLS FIRST, x.id
     FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i
      FROM public.erp_inventory_s_539dcf81_b x
     WHERE x.product_id = t.product_id
       AND x.warehouse_id = t.warehouse_id
       AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
       AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
           COALESCE(normalized_batch, '')
       AND x.is_deleted = 'n'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Inventory row missing for transaction % (product %, warehouse %, location %, batch %)',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0),
        COALESCE(normalized_batch, '<none>') USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
      INTO allow_negative
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = t.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;

    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);

    -- 盘点过账时把 available 拉平成了实盘数量（deploy_24 的 new_available := new_qty），
    -- 冲销要按同一规则还原；调拨 / 调整是 available 与 quantity 同增同减，逐条减回去即可。
    IF p_document_type = 'stock_count' THEN
      new_available := new_qty;
    ELSE
      new_available := COALESCE(i.available_quantity, 0) - COALESCE(t.quantity, 0);
    END IF;

    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Cannot reverse % #%: 物料 % 在仓库 % 的库存已被后续业务消耗（现有 %，本行需冲 %）',
        p_document_type, p_document_id, t.product_id, t.warehouse_id,
        COALESCE(i.quantity, 0), t.quantity USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(NULLIF(t.unit_cost, 0), NULLIF(i.unit_cost, 0), 0)
      ELSE ABS(new_cost / new_qty)
    END;

    UPDATE public.erp_inventory_s_539dcf81_b
       SET quantity = new_qty,
           available_quantity = new_available,
           unit_cost = restored_unit_cost,
           total_cost = new_cost,
           updated_at = NOW()
     WHERE id = i.id;
  END LOOP;

  -- ---- 软删流水，保留审计痕迹 -------------------------------------------
  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE reference_type = ANY (v_ref_types)
     AND reference_id = p_document_id
     AND is_deleted = 'n';

  -- ---- 单据状态退回「已审核」，可修改后重新过账 ---------------------------
  IF p_document_type = 'inventory_transfer' THEN
    UPDATE public.erp_inventory_transfers_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  ELSIF p_document_type = 'stock_count' THEN
    UPDATE public.erp_stock_counts_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_stock_adjustments_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  END IF;

  -- ---- 作废对应库存凭证（deploy_87）--------------------------------------
  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ---- post_production_document ----
CREATE OR REPLACE FUNCTION public.post_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC; v_location_id INTEGER;
  allow_negative BOOLEAN; normalized_batch TEXT; v_transaction_no TEXT;
  v_direction TEXT; v_is_out BOOLEAN;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- 主表加锁。两张主表都没有库位列，header_location_id 恒为 NULL；
  -- 库位一律来自明细（完工入库单的「明细」就是主表那一行，见下面的 UNION ALL）。
  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.issue_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.amount AS total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF COALESCE(h.status, '') NOT IN ('draft', 'approved', 'issued') THEN
    RAISE EXCEPTION
      'Only draft, approved or issued documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Production document has no warehouse' USING ERRCODE = '23502';
  END IF;
  -- 双保险：主表状态没置 posted 但流水已存在（例如手工改回 draft），一律拒绝。
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  -- 锁明细行，避免并发过账读到改到一半的明细
  IF p_document_type = 'material_issue' THEN
    PERFORM x.id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    WHERE x.issue_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.id FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- 两张单据归一成同一形状的明细流：完工入库单没有明细表，主表即唯一明细行。
  -- detail_location_id 就是本脚本新增的库位来源（deploy_56 时恒为 NULL）。
  FOR d IN
    SELECT x.id AS detail_id, x.material_id AS product_id, x.quantity,
      x.unit_cost AS document_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no,
      NULL::DATE AS expiry_date, x.location_id AS detail_location_id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_issue'
      AND x.issue_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity,
      x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_production_receipts_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'production_receipt' AND x.id = p_document_id
      AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    v_is_out := (p_document_type = 'material_issue');
    v_direction := CASE WHEN v_is_out THEN 'out' ELSE 'in' END;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
        AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', d.product_id, h.warehouse_id,
        COALESCE(v_location_id, 0), COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF FOUND THEN
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      inventory_unit_cost := COALESCE(i.unit_cost, 0);
    ELSE
      old_qty := 0; old_available := 0; old_cost := 0;
      inventory_unit_cost := 0;
    END IF;

    IF v_is_out THEN
      -- 出库：成本取库存移动加权单价（与 deploy_24 调拨出库口径一致）
      v_unit_cost := COALESCE(NULLIF(inventory_unit_cost, 0),
        NULLIF(d.document_unit_cost, 0), NULLIF(d.product_unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
    ELSE
      -- 入库：成本取单据单价（将来由成本卷算写入），再退物料成本价、库存单价
      v_unit_cost := COALESCE(NULLIF(d.document_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), NULLIF(inventory_unit_cost, 0), 0);
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
    END IF;

    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      IF v_is_out AND v_location_id IS NULL THEN
        -- 补库位后这条提示仍有用：明细没指定库位时才可能落到这里
        RAISE EXCEPTION
          'Insufficient warehouse-level stock for product %, warehouse %: available %, requested % (明细未指定库位，只能扣无库位库存行；请给领料明细指定库位，或补建无库位库存)',
          d.product_id, h.warehouse_id, old_available, d.quantity
          USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION
        'Insufficient stock for product %, warehouse %: available %, requested %',
        d.product_id, h.warehouse_id, old_available, d.quantity
        USING ERRCODE = '23514';
    END IF;

    IF i.id IS NULL THEN
      INSERT INTO public.erp_inventory_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
        quantity, available_quantity, locked_quantity, unit_cost,
        total_cost, batch_no, expiry_date
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
        v_location_id,
        new_qty, new_available, 0,
        CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
        new_cost, normalized_batch, d.expiry_date
      ) RETURNING * INTO i;
    ELSE
      UPDATE public.erp_inventory_s_539dcf81_b
      SET quantity = new_qty, available_quantity = new_available,
          unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost
                           ELSE ABS(new_cost / new_qty) END,
          total_cost = new_cost,
          expiry_date = COALESCE(d.expiry_date, expiry_date),
          updated_at = NOW()
      WHERE id = i.id;
    END IF;

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(p_document_type, v_direction),
      h.document_date, d.product_id, h.warehouse_id, v_location_id,
      normalized_batch,
      CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      v_unit_cost,
      CASE WHEN v_is_out THEN -(d.quantity * v_unit_cost)
           ELSE d.quantity * v_unit_cost END,
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      CASE WHEN v_is_out
           THEN format('生产领料单 %s 过账', h.document_no)
           ELSE format('生产完工入库单 %s 过账', h.document_no) END
    );
  END LOOP;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'Production document has no active details'
      USING ERRCODE = '23514';
  END IF;

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87）--------------------------------------
  -- 本函数的 h 里没有 tenant_id（deploy_56/58 的 SELECT 列表没取这一列），
  -- 传 NULL 让助手从流水行自带的 tenant_id 推导，避免为了一个字段去改主表查询。
  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => NULL,
    p_remark        => CASE WHEN p_document_type = 'material_issue'
                            THEN format('生产领料单 %s', h.document_no)
                            ELSE format('生产完工入库单 %s', h.document_no) END);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ---- reverse_production_document ----
CREATE OR REPLACE FUNCTION public.reverse_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; t RECORD; i RECORD;
  allow_negative BOOLEAN; normalized_batch TEXT;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC; line_count INTEGER := 0;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.status,
      x.reversal_idempotency_key
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.status,
      x.reversal_idempotency_key
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'draft' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'draft');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0),
             x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(t.location_id, 0), COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id AND x.warehouse_id = t.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Inventory missing for transaction %, product %, warehouse %, location %',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0)
        USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
    INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
    WHERE w.id = t.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;

    -- 流水里的 quantity / total_cost 带符号：出库为负，入库为正。
    -- 减去流水即「撤销该笔影响」，方向自动正确。
    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_available := COALESCE(i.available_quantity, 0) -
      COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Cannot reverse: stock was consumed for product %, warehouse %',
        t.product_id, t.warehouse_id USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(t.unit_cost, i.unit_cost, 0)
      ELSE ABS(new_cost / new_qty)
    END;
    UPDATE public.erp_inventory_s_539dcf81_b
    SET quantity = new_qty, available_quantity = new_available,
        unit_cost = restored_unit_cost, total_cost = new_cost,
        updated_at = NOW()
    WHERE id = i.id;
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id AND is_deleted = 'n';

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 作废对应库存凭证（deploy_87）--------------------------------------
  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => NULL,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'draft', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;




-- ============================================
-- 10. 自检（fail-loud：任何一条不满足直接让迁移失败）
-- ============================================
DO $check$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_n       INTEGER;
  v_rec     RECORD;
  v_bad     TEXT;
BEGIN
  -- 10.1 表 / 列 / 索引就位
  IF to_regclass('public.erp_inventory_subject_map_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_inventory_subject_map_s_539dcf81_b 表不存在';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_vouchers_s_539dcf81_b' AND column_name = 'inventory_source_type'
  ) THEN
    v_missing := v_missing || 'erp_vouchers.inventory_source_type 不存在';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_vouchers_s_539dcf81_b' AND column_name = 'inventory_source_id'
  ) THEN
    v_missing := v_missing || 'erp_vouchers.inventory_source_id 不存在';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'erp_vouchers_s_539dcf81_b'
       AND indexname = 'uq_erp_vouchers_inventory_source'
  ) THEN
    v_missing := v_missing || 'uq_erp_vouchers_inventory_source 索引不存在';
  END IF;

  -- 10.2 四个助手的签名
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('inventory_document_ref_types', 'p_source_type text'),
      ('inventory_voucher_plan',       'p_source_type text, p_transaction_type_code text, p_tenant_id bigint'),
      ('inventory_sync_voucher',       'p_source_type text, p_source_id integer, p_document_no text, p_document_date date, p_tenant_id bigint, p_remark text'),
      ('inventory_void_voucher',       'p_source_type text, p_source_id integer, p_tenant_id bigint, p_idempotency_key uuid')
    ) AS x(name, args_expected)
  LOOP
    SELECT COUNT(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = v_rec.name;
    IF v_n = 0 THEN
      v_missing := v_missing || format('函数 public.%s 不存在', v_rec.name);
    END IF;
  END LOOP;

  -- 10.3 6 个 RPC 的源文本里必须真的出现了助手调用（防止 CREATE OR REPLACE 被
  --      后续文件再次覆盖、或者本文件被误删）
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('post_stock_document',          'inventory_sync_voucher'),
      ('reverse_stock_document',       'inventory_void_voucher'),
      ('post_inventory_document',      'inventory_sync_voucher'),
      ('reverse_inventory_document',   'inventory_void_voucher'),
      ('post_production_document',     'inventory_sync_voucher'),
      ('reverse_production_document',  'inventory_void_voucher')
    ) AS x(fname, needle)
  LOOP
    SELECT p.prosrc INTO v_bad
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = v_rec.fname;

    IF v_bad IS NULL THEN
      v_missing := v_missing || format('RPC public.%s 不存在', v_rec.fname);
    ELSIF POSITION(v_rec.needle IN v_bad) = 0 THEN
      v_missing := v_missing
        || format('RPC public.%s 未接上 %s（被后面的迁移覆盖了？）', v_rec.fname, v_rec.needle);
    END IF;
  END LOOP;

  -- 10.4 每个租户都应有一套完整映射 + 一套标准科目
  SELECT COUNT(*) INTO v_n FROM sys_tenants t
   WHERE (SELECT COUNT(*) FROM public.erp_inventory_subject_map_s_539dcf81_b m
           WHERE m.tenant_id = t.id AND m.is_deleted = 'n') <> 11;
  IF v_n > 0 THEN
    v_missing := v_missing || format('%s 个租户的科目映射不是 11 条', v_n);
  END IF;

  SELECT COUNT(*) INTO v_n FROM sys_tenants t
   WHERE (SELECT COUNT(*) FROM public.erp_account_subjects_s_539dcf81_b s
           WHERE s.tenant_id = t.id AND s.is_deleted = 'n'
             AND s.code IN ('1403','1405','1901','5001','6401','6001')) <> 6;
  IF v_n > 0 THEN
    v_missing := v_missing || format('%s 个租户缺标准存货 / 成本科目', v_n);
  END IF;

  -- 10.5 内部调拨必须是不进总账的
  SELECT COUNT(*) INTO v_n
    FROM public.erp_inventory_subject_map_s_539dcf81_b m
   WHERE m.is_deleted = 'n' AND m.source_type = 'inventory_transfer'
     AND m.generate_voucher IS TRUE;
  IF v_n > 0 THEN
    v_missing := v_missing || format('%s 条内部调拨映射被标成了要生成凭证', v_n);
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION E'deploy_87 自检失败：\n  - %', array_to_string(v_missing, E'\n  - ')
      USING ERRCODE = 'P0001';
  END IF;

  RAISE NOTICE 'deploy_87 自检通过：科目映射、6 个 RPC 挂钩、凭证唯一索引均就位';
END;
$check$;
