-- ============================================================================
-- deploy_94 —— 销售退货单状态约束修正（P1 修复）
-- ============================================================================
--
-- 背景（deploy_93 跑验收时暴露的真实缺陷）：
--   `erp_sales_returns_...` 是**先于本次 P1 就存在**的表，自带的
--   `erp_sales_returns_s_539dcf81_b_status_check` 只允许
--       draft / submitted / inspecting / completed / cancelled
--   —— 那是「质检单」语义的取值。deploy_90 给它补了过账字段（posting_idempotency_key
--   / posted_at / reversed_at / 审批字段），但**没有同步放开状态约束**。
--   结果：post_stock_document 在单据尾部 `SET status = 'posted'`、
--   reverse_stock_document `SET status = 'approved'` 都会撞 23514，
--   销售退货整条链路在生产上必然失败。
--
-- 处理：先删旧约束，再按各单据统一的过账生命周期重建（保留旧取值以便向后兼容，
--       避免任何历史数据/查询被误伤）。幂等：IF EXISTS 守卫 + 末尾 fail-loud 自检。
--
-- 注意：`sys_*` / 权限表不在本迁移触碰范围。本文件只动这一条 CHECK。
-- ============================================================================

DO $$
BEGIN
  ALTER TABLE public.erp_sales_returns_s_539dcf81_b
    DROP CONSTRAINT IF EXISTS erp_sales_returns_s_539dcf81_b_status_check;

  ALTER TABLE public.erp_sales_returns_s_539dcf81_b
    ADD CONSTRAINT erp_sales_returns_s_539dcf81_b_status_check
    CHECK (status IN (
      'draft',        -- 草稿
      'submitted',    -- 已提交（旧语义，保留）
      'inspecting',   -- 质检中（旧语义，保留）
      'approved',     -- 已审核 —— post/reverse 的进出状态
      'rejected',     -- 驳回
      'posted',       -- 已过账
      'completed',    -- 已完成（旧语义，保留）
      'cancelled'     -- 已作废
    ));
END;
$$;

-- ---- 自检（fail-loud）------------------------------------------------------
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.erp_sales_returns_s_539dcf81_b'::regclass
     AND conname  = 'erp_sales_returns_s_539dcf81_b_status_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'deploy_94 自检失败：状态约束不存在';
  END IF;
  IF v_def NOT ILIKE '%approved%' OR v_def NOT ILIKE '%posted%' THEN
    RAISE EXCEPTION 'deploy_94 自检失败：状态约束仍未放开 approved/posted —— %', v_def;
  END IF;

  -- 反向确认：post_stock_document / reverse_stock_document 写的就是这两个值
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'post_stock_document'
       AND pronamespace = 'public'::regnamespace
       AND prosrc ILIKE '%erp_sales_returns_s_539dcf81_b%'
       AND prosrc ILIKE '%status = ''posted''%'
  ) THEN
    RAISE EXCEPTION 'deploy_94 自检失败：post_stock_document 未对销售退货置 posted';
  END IF;

  RAISE NOTICE 'deploy_94 OK：销售退货状态约束已放开 approved/posted（P1 修复）';
END;
$$;
