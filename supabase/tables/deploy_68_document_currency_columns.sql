-- ============================================================================
-- deploy_68_document_currency_columns.sql
-- 多币别改造 · 第 2 期（单据 + 成本）· 步骤 1/2：单据层币种与本位币金额列
--
-- 背景（第 1 期已完成）：币别 / 汇率主数据（deploy_65）、币别管理页（deploy_66）、
--   租户可见性收敛（deploy_67）、前端 formatMoney / MoneyInput、全站货币符号替换。
--   第 1 期刻意不动金额口径 —— 单据金额仍是单一 CNY。
--
-- 本期（第 2 期）要落地的口径（已拍板）：
--   · 双金额：原币金额 + 本位币金额，汇率冻结在单据上（不随主数据变动）
--   · 库存成本一律本位币 → 采购入库过账时必须折汇（见 deploy_69）
--   · 汇率方向写死：1 外币 = rate 本位币
--
-- 本脚本只做「加列 + 回填」，不改任何既有列语义、不改函数。
--   加列与函数改造拆成两个脚本，是为了让加列这一步可以独立回滚/重跑，
--   且函数重写（deploy_69）依赖本脚本建立的列。
--
-- 口径说明（重要，避免把「没有原币维度」的表也硬加币种）：
--   · erp_material_issues / erp_production_receipts 的金额来自库存移动加权成本，
--     而库存成本按决策「一律本位币」→ 这两张表**没有原币维度**，故不加 currency。
--     强行加一个恒等于本位币的 currency 列只会制造噪音与误导。
--   · 采购入库 / 销售出货有真实原币来源（来自 PO / SO 的 unit_price）→ 加。
--
-- 幂等：全部 ALTER 走 IF NOT EXISTS；回填带 IS DISTINCT FROM 守卫。
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_68] 补齐单据层币种与本位币金额列...'

-- ---------------------------------------------------------------------------
-- 1. 销售订单 / 采购订单：补「本位币金额」三列
--    （currency / exchange_rate 两列 deploy_01 就有，本期不动其类型）
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_sales_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE public.erp_purchase_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

-- 订单明细行同样双金额：行金额 = 数量 x 原币单价，逐行四舍五入折本位币。
-- 明细不存 exchange_rate（汇率是表头属性，冗余存储会有一致性风险）。
ALTER TABLE public.erp_sales_order_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount     NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE public.erp_purchase_order_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount     NUMERIC(18,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. 采购入库单：补币种 + 冻结汇率 + 本位币金额
--    currency / exchange_rate 从来源采购订单继承（deploy_69 补字段映射）
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_purchase_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS currency          VARCHAR(10)    NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS exchange_rate     NUMERIC(18,8)  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS base_total_amount NUMERIC(18,2)  NOT NULL DEFAULT 0;

ALTER TABLE public.erp_purchase_receipt_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount     NUMERIC(18,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. 销售出货单：同上
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_sales_deliveries_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS currency          VARCHAR(10)    NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS exchange_rate     NUMERIC(18,8)  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS base_total_amount NUMERIC(18,2)  NOT NULL DEFAULT 0;

ALTER TABLE public.erp_sales_delivery_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount     NUMERIC(18,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. 应收：补来源单据列（对齐 erp_payables 的 source_type/source_id/source_no）
--    缺口：erp_payables 早有这三列 + 部分唯一索引，应收却没有 ——
--    所以「销售出货自动生成应收」一直无法做幂等（既无法防重，也无法反查）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_receivables_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS source_id   INTEGER,
  ADD COLUMN IF NOT EXISTS source_no   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

-- 部分唯一索引：同一来源单据同租户只能有一条未删除的应收/应付。
-- ⚠️ 必须带 tenant_id：source_id 是各租户自己的 id 序列，两个租户的
--    出货单 id 都从 1 开始，只按 (source_type, source_id) 建唯一索引会互撞。
--    （erp_payables 的同名索引就漏了 tenant_id，在 deploy_69 一并修正）
-- ⚠️ ON CONFLICT 若要命中本索引，必须原样带上 WHERE 谓词（见 deploy_69）。
DROP INDEX IF EXISTS public.uq_erp_receivables_active_sales_delivery;
CREATE UNIQUE INDEX uq_erp_receivables_active_sales_delivery
  ON public.erp_receivables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n'
    AND source_type = 'sales_delivery'
    AND source_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_erp_receivables_source;
CREATE INDEX idx_erp_receivables_source
  ON public.erp_receivables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n';

-- 应付补本位币金额列（原币金额沿用既有 amount）
ALTER TABLE public.erp_payables_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. 汇率正数约束
--    现有 exchange_rate 列是裸 NUMERIC 且默认 1，无任何约束 ——
--    一个 0 或负汇率会让「折本位币」把金额乘以 0 而静默清零。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_sales_orders_s_539dcf81_b'::regclass
      AND conname  = 'chk_so_exchange_rate_positive'
  ) THEN
    ALTER TABLE public.erp_sales_orders_s_539dcf81_b
      ADD CONSTRAINT chk_so_exchange_rate_positive
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_purchase_orders_s_539dcf81_b'::regclass
      AND conname  = 'chk_po_exchange_rate_positive'
  ) THEN
    ALTER TABLE public.erp_purchase_orders_s_539dcf81_b
      ADD CONSTRAINT chk_po_exchange_rate_positive
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_purchase_receipts_s_539dcf81_b'::regclass
      AND conname  = 'chk_pr_exchange_rate_positive'
  ) THEN
    ALTER TABLE public.erp_purchase_receipts_s_539dcf81_b
      ADD CONSTRAINT chk_pr_exchange_rate_positive CHECK (exchange_rate > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.erp_sales_deliveries_s_539dcf81_b'::regclass
      AND conname  = 'chk_sd_exchange_rate_positive'
  ) THEN
    ALTER TABLE public.erp_sales_deliveries_s_539dcf81_b
      ADD CONSTRAINT chk_sd_exchange_rate_positive CHECK (exchange_rate > 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. 历史数据回填
--    口径：存量数据一律认定为「CNY @ 1」（改造前系统只支持人民币，
--    且 exchange_rate 列从无写入路径，全部是默认值 1）。
--    用 IS DISTINCT FROM 守卫，重复执行不会反复写行。
-- ---------------------------------------------------------------------------
UPDATE public.erp_sales_orders_s_539dcf81_b
SET base_total_amount    = ROUND(COALESCE(total_amount, 0)    * COALESCE(NULLIF(exchange_rate, 0), 1), 2),
    base_tax_amount      = ROUND(COALESCE(tax_amount, 0)      * COALESCE(NULLIF(exchange_rate, 0), 1), 2),
    base_discount_amount = ROUND(COALESCE(discount_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND (
    base_total_amount    IS DISTINCT FROM ROUND(COALESCE(total_amount, 0)    * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
    OR base_tax_amount   IS DISTINCT FROM ROUND(COALESCE(tax_amount, 0)      * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
    OR base_discount_amount IS DISTINCT FROM ROUND(COALESCE(discount_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_purchase_orders_s_539dcf81_b
SET base_total_amount    = ROUND(COALESCE(total_amount, 0)    * COALESCE(NULLIF(exchange_rate, 0), 1), 2),
    base_tax_amount      = ROUND(COALESCE(tax_amount, 0)      * COALESCE(NULLIF(exchange_rate, 0), 1), 2),
    base_discount_amount = ROUND(COALESCE(discount_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND (
    base_total_amount    IS DISTINCT FROM ROUND(COALESCE(total_amount, 0)    * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
    OR base_tax_amount   IS DISTINCT FROM ROUND(COALESCE(tax_amount, 0)      * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
    OR base_discount_amount IS DISTINCT FROM ROUND(COALESCE(discount_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_sales_order_details_s_539dcf81_b d
SET base_unit_price = ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(o.exchange_rate, 0), 1), 4),
    base_amount     = ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(o.exchange_rate, 0), 1), 2)
FROM public.erp_sales_orders_s_539dcf81_b o
WHERE o.id = d.order_id AND d.is_deleted = 'n'
  AND (
    d.base_unit_price IS DISTINCT FROM ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(o.exchange_rate, 0), 1), 4)
    OR d.base_amount  IS DISTINCT FROM ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(o.exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_purchase_order_details_s_539dcf81_b d
SET base_unit_price = ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(o.exchange_rate, 0), 1), 4),
    base_amount     = ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(o.exchange_rate, 0), 1), 2)
FROM public.erp_purchase_orders_s_539dcf81_b o
WHERE o.id = d.order_id AND d.is_deleted = 'n'
  AND (
    d.base_unit_price IS DISTINCT FROM ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(o.exchange_rate, 0), 1), 4)
    OR d.base_amount  IS DISTINCT FROM ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(o.exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_purchase_receipts_s_539dcf81_b
SET base_total_amount = ROUND(COALESCE(total_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND base_total_amount IS DISTINCT FROM ROUND(COALESCE(total_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2);

UPDATE public.erp_purchase_receipt_details_s_539dcf81_b d
SET base_unit_price = ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(h.exchange_rate, 0), 1), 4),
    base_amount     = ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(h.exchange_rate, 0), 1), 2)
FROM public.erp_purchase_receipts_s_539dcf81_b h
WHERE h.id = d.receipt_id AND d.is_deleted = 'n'
  AND (
    d.base_unit_price IS DISTINCT FROM ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(h.exchange_rate, 0), 1), 4)
    OR d.base_amount  IS DISTINCT FROM ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(h.exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_sales_deliveries_s_539dcf81_b
SET base_total_amount = ROUND(COALESCE(total_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND base_total_amount IS DISTINCT FROM ROUND(COALESCE(total_amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2);

UPDATE public.erp_sales_delivery_details_s_539dcf81_b d
SET base_unit_price = ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(h.exchange_rate, 0), 1), 4),
    base_amount     = ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(h.exchange_rate, 0), 1), 2)
FROM public.erp_sales_deliveries_s_539dcf81_b h
WHERE h.id = d.delivery_id AND d.is_deleted = 'n'
  AND (
    d.base_unit_price IS DISTINCT FROM ROUND(COALESCE(d.unit_price, 0) * COALESCE(NULLIF(h.exchange_rate, 0), 1), 4)
    OR d.base_amount  IS DISTINCT FROM ROUND(COALESCE(d.amount, 0)     * COALESCE(NULLIF(h.exchange_rate, 0), 1), 2)
  );

UPDATE public.erp_receivables_s_539dcf81_b
SET base_amount = ROUND(COALESCE(amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND base_amount IS DISTINCT FROM ROUND(COALESCE(amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2);

UPDATE public.erp_payables_s_539dcf81_b
SET base_amount = ROUND(COALESCE(amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2)
WHERE is_deleted = 'n'
  AND base_amount IS DISTINCT FROM ROUND(COALESCE(amount, 0) * COALESCE(NULLIF(exchange_rate, 0), 1), 2);

-- ---------------------------------------------------------------------------
-- 7. fail-loud 自检
--    加列是静默操作（IF NOT EXISTS 不报错也不提示），单靠「脚本没报错」
--    无法区分「列已建」与「列被 IF NOT EXISTS 跳过但实际缺失」。
--    这里显式断言关键列全部到位，缺一即整体回滚。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
  v_rate_constraints INTEGER;
BEGIN
  SELECT string_agg(want.table_name || '.' || want.column_name, ', ' ORDER BY want.table_name, want.column_name)
  INTO v_missing
  FROM (
    VALUES
      ('erp_sales_orders_s_539dcf81_b',          'base_total_amount'),
      ('erp_sales_orders_s_539dcf81_b',          'base_tax_amount'),
      ('erp_sales_orders_s_539dcf81_b',          'base_discount_amount'),
      ('erp_purchase_orders_s_539dcf81_b',       'base_total_amount'),
      ('erp_purchase_orders_s_539dcf81_b',       'base_tax_amount'),
      ('erp_purchase_orders_s_539dcf81_b',       'base_discount_amount'),
      ('erp_sales_order_details_s_539dcf81_b',   'base_unit_price'),
      ('erp_sales_order_details_s_539dcf81_b',   'base_amount'),
      ('erp_purchase_order_details_s_539dcf81_b','base_unit_price'),
      ('erp_purchase_order_details_s_539dcf81_b','base_amount'),
      ('erp_purchase_receipts_s_539dcf81_b',     'currency'),
      ('erp_purchase_receipts_s_539dcf81_b',     'exchange_rate'),
      ('erp_purchase_receipts_s_539dcf81_b',     'base_total_amount'),
      ('erp_purchase_receipt_details_s_539dcf81_b','base_unit_price'),
      ('erp_purchase_receipt_details_s_539dcf81_b','base_amount'),
      ('erp_sales_deliveries_s_539dcf81_b',      'currency'),
      ('erp_sales_deliveries_s_539dcf81_b',      'exchange_rate'),
      ('erp_sales_deliveries_s_539dcf81_b',      'base_total_amount'),
      ('erp_sales_delivery_details_s_539dcf81_b','base_unit_price'),
      ('erp_sales_delivery_details_s_539dcf81_b','base_amount'),
      ('erp_receivables_s_539dcf81_b',           'source_type'),
      ('erp_receivables_s_539dcf81_b',           'source_id'),
      ('erp_receivables_s_539dcf81_b',           'source_no'),
      ('erp_receivables_s_539dcf81_b',           'base_amount'),
      ('erp_payables_s_539dcf81_b',              'base_amount')
  ) AS want(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name   = want.table_name
      AND c.column_name  = want.column_name
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '[deploy_68] 自检失败：以下列缺失 → %', v_missing;
  END IF;

  SELECT count(*) INTO v_rate_constraints
  FROM pg_constraint
  WHERE conrelid IN ('public.erp_sales_orders_s_539dcf81_b'::regclass,
                     'public.erp_purchase_orders_s_539dcf81_b'::regclass,
                     'public.erp_purchase_receipts_s_539dcf81_b'::regclass,
                     'public.erp_sales_deliveries_s_539dcf81_b'::regclass)
    AND conname LIKE 'chk_%_exchange_rate_positive';
  IF v_rate_constraints < 4 THEN
    RAISE EXCEPTION
      '[deploy_68] 自检失败：汇率正数约束应有 4 条，实际 % 条', v_rate_constraints;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname  = 'uq_erp_receivables_active_sales_delivery'
  ) THEN
    RAISE EXCEPTION '[deploy_68] 自检失败：应收来源幂等唯一索引未建立';
  END IF;

  RAISE NOTICE '[deploy_68] 自检通过：单据层币种与本位币金额列已就位（汇率约束 % 条）', v_rate_constraints;
END $$;

\echo '[deploy_68] 完成。'
