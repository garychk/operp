-- ============================================================================
-- deploy_85: 修复 erp_inventory 上互相冲突的两个唯一键（P0-1）
-- ============================================================================
--
-- 问题
-- ----
-- erp_inventory 上一度同时存在两个唯一索引，语义互相矛盾：
--
--   1) uq_erp_inventory_active_stock_key_v2     （deploy_25 / deploy_34 建）
--        (product_id, warehouse_id, COALESCE(location_id,0), normalized_batch)
--        WHERE is_deleted = 'n'
--        含库位维度，但没有 tenant_id。
--
--   2) uq_erp_inventory_s_539dcf81_t_4eb2af5d4a （deploy_51 自动改造生成）
--        (tenant_id, product_id, warehouse_id, batch_no)
--        有 tenant_id，但**不含 location_id**，而且不是部分索引。
--
--   来源是 deploy_01 建表语句里内联的 UNIQUE(product_id, warehouse_id, batch_no)
--   ——deploy_51 的分租户唯一键改造把它变成 (tenant_id, ..., batch_no)，
--   而 deploy_25/34 为了库位维度另外补的 v2 索引是「部分索引 + 表达式索引」，
--   被 deploy_51 的 WHERE 条件（indpred IS NULL / indkey 无 0）自动排除在外，
--   于是两者并存。
--
-- 后果
-- ----
--   同一租户、同一仓库、同一物料、同一批次放在两个不同库位时：
--     · v2      允许（两个库位是两行）
--     · 索引 2  拒绝 → 23505 duplicate key
--   而 post_stock_document / post_inventory_document / post_production_document
--   全都是按 COALESCE(x.location_id, 0) 精确寻址库存行的 ——
--   也就是**库位级库存存不下第二行**，库位功能「代码支持、数据库不允许」。
--   另外索引 2 用原始 batch_no 比较，NULL 之间互不相等，
--   多条「无批次」的同一物料行反而可以并存，唯一性形同虚设。
--
-- 修法
-- ----
--   两个都删掉，合并成一个「租户内唯一 + 含库位维度 + 批次归一化 + 部分索引」：
--
--     (product_id, warehouse_id, COALESCE(location_id,0), normalized_batch, tenant_id)
--     WHERE is_deleted = 'n'
--
--   列序说明（刻意不按 deploy_51 的「tenant_id 打头」惯例）：
--   库存行的每一次寻址都是
--     product_id = ? AND warehouse_id = ? AND COALESCE(location_id,0) = ?
--     AND COALESCE(normalized_batch) = ?
--   把 tenant_id 放在末尾，这个唯一索引同时就是最热访问路径的索引；
--   打成 tenant_id 打头的话这三列用不上索引前缀，还得再补一个非唯一索引。
--   唯一性语义不受列序影响（5 列都非空，NULL 不会互相规避）。
--
--   同时把 erp_inventory 加进 deploy_51 的跳过名单，避免在任何环境下
--   重新生成那个不含库位的索引（见 deploy_51 第 2/3 节的 v_skip_tables）。
--
-- 幂等性
-- ------
--   可重复执行。已存在的新索引会被跳过，已删掉的旧索引不会报错。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 前置检查：合并后的键要求「租户 + 物料 + 仓库 + 库位 + 批次」在活跃行内唯一
--    存量库若已有重复，必须先人工清洗，绝不静默丢数据。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_dup      INTEGER;
    v_sample   TEXT;
BEGIN
    SELECT count(*), string_agg(sample, ' ; ')
    INTO v_dup, v_sample
    FROM (
        SELECT format('tenant=%s product=%s warehouse=%s location=%s batch=%L x%s',
                      i.tenant_id, i.product_id, i.warehouse_id,
                      COALESCE(i.location_id, 0),
                      COALESCE(NULLIF(BTRIM(i.batch_no), ''), ''),
                      count(*)) AS sample
        FROM public.erp_inventory_s_539dcf81_b i
        WHERE i.is_deleted = 'n'
        GROUP BY i.tenant_id, i.product_id, i.warehouse_id,
                 COALESCE(i.location_id, 0),
                 COALESCE(NULLIF(BTRIM(i.batch_no), ''), '')
        HAVING count(*) > 1
    ) d;

    IF v_dup > 0 THEN
        RAISE EXCEPTION
            'deploy_85 中止：erp_inventory 有 % 组活跃行在新唯一键下会冲突，请先清洗。样例：%',
            v_dup, v_sample
            USING ERRCODE = '23505';
    END IF;

    RAISE NOTICE 'deploy_85 前置检查通过：无重复的活跃库存行';
END $$;


-- ----------------------------------------------------------------------------
-- 2. 删除两个冲突索引
--    已核对：二者均不被任何外键依赖（pg_depend 无记录），可以直接 DROP。
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uq_erp_inventory_active_stock_key_v2;
DROP INDEX IF EXISTS public.uq_erp_inventory_s_539dcf81_t_4eb2af5d4a;
-- deploy_13 时代的更早版本（不含库位），存量库里可能残留，一并清掉
DROP INDEX IF EXISTS public.uq_erp_inventory_active_stock_key;


-- ----------------------------------------------------------------------------
-- 3. 建立唯一的库存行唯一键（同时充当最热访问路径的索引）
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_active_stock_t
  ON public.erp_inventory_s_539dcf81_b (
    product_id,
    warehouse_id,
    COALESCE(location_id, 0),
    (COALESCE(NULLIF(BTRIM(batch_no), ''), '')),
    tenant_id
  ) WHERE is_deleted = 'n';

COMMENT ON INDEX public.uq_erp_inventory_active_stock_t IS
  '库存活跃行唯一键：租户 + 物料 + 仓库 + 库位 + 归一化批次。列序按过账 RPC 的寻址路径排列（product_id/warehouse_id/location/batch 在前），因此该索引同时承担库存行查找。软删除行不参与唯一性。';


-- ----------------------------------------------------------------------------
-- 4. 自检：必须只剩这一个业务唯一键，且它带 tenant_id 与 location_id
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_plain  TEXT;
    v_new    TEXT;
BEGIN
    -- 4a) 除主键外，不允许再有不带 partial 谓词的唯一索引（那是 deploy_51 会扫到的形态）
    SELECT string_agg(i.relname, ', ')
    INTO v_plain
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'erp_inventory_s_539dcf81_b'
      AND ix.indisunique
      AND NOT ix.indisprimary
      AND ix.indpred IS NULL;

    IF v_plain IS NOT NULL THEN
        RAISE EXCEPTION 'deploy_85 自检失败：仍存在普通唯一索引（应为空）: %', v_plain;
    END IF;

    -- 4b) 新索引必须存在
    SELECT pg_get_indexdef(ix.indexrelid)
    INTO v_new
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE n.nspname = 'public'
      AND i.relname = 'uq_erp_inventory_active_stock_t';

    IF v_new IS NULL THEN
        RAISE EXCEPTION 'deploy_85 自检失败：新索引 uq_erp_inventory_active_stock_t 未建立';
    END IF;

    IF v_new NOT ILIKE '%tenant_id%' OR v_new NOT ILIKE '%location_id%' THEN
        RAISE EXCEPTION 'deploy_85 自检失败：新索引缺少 tenant_id 或 location_id: %', v_new;
    END IF;

    RAISE NOTICE 'deploy_85 OK：库存唯一键已合并为 %', v_new;
END $$;

-- 索引变化不影响 PostgREST 的结构缓存，但保险起见刷一次，
-- 避免旧 schema cache 里还记着已被 DROP 的索引。
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 回滚
-- ----
--   DROP INDEX public.uq_erp_inventory_active_stock_t;
--   CREATE UNIQUE INDEX uq_erp_inventory_active_stock_key_v2 ON public.erp_inventory_s_539dcf81_b
--     (product_id, warehouse_id, COALESCE(location_id, 0),
--      (COALESCE(NULLIF(BTRIM(batch_no), ''), ''))) WHERE is_deleted = 'n';
--   CREATE UNIQUE INDEX uq_erp_inventory_s_539dcf81_t_4eb2af5d4a ON public.erp_inventory_s_539dcf81_b
--     (tenant_id, product_id, warehouse_id, batch_no);
--   （回滚会同时恢复「库位存不下第二行」的缺陷，仅用于对比排查。）
--
-- 副作用
-- ------
--   1) 依赖 batch_no 原值的 upsert(onConflict) 本来就用不了（有表达式列），无影响。
--   2) 现在「同物料 + 同仓库 + 同库位 + 无批次」只能有一行活跃记录 —— 这是
--      过账 RPC 一直以来的假设（它按这组条件 FOR UPDATE 取单行），
--      旧索引 2 因为 NULL 不去重反而允许并存，属于隐患，本次一并收紧。
-- ============================================================================
