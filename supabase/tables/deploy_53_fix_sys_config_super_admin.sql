-- ============================================================================
-- deploy_53  修复：超管在「系统设置 → 基础设置」保存后值被回滚（改不动）
--
-- 【现象】
--   超级管理员打开 系统设置 → 基础设置，改完点保存，提示"保存成功"，
--   刷新/重新拉取后值又变回去。AI 设置同症状；但制造设置反而能正常保存。
--
-- 【根因】vw_sys_config_effective 的可见范围放得太宽，且去重排序缺了
--        「本人租户优先」这一级。三个环节叠加：
--
--   a) 视图 WHERE 里有 OR current_user_is_super_admin()；
--      sys_config 的 RLS 走 tenant_scope_visible()，超管分支同样是全放开。
--      两处叠加 -> 超管能看到【所有租户】的私有配置行（不止基线和自己的）。
--
--   b) 去重排序是
--        ORDER BY category_code, (tenant_id IS NULL) ASC, id DESC
--      这条排序只在「基线 vs 私有」之间二选一。一旦多个租户都有私有行，
--      私有行之间全靠 id DESC 决胜 —— 超管看到的是 id 最大的那条，
--      也就是【最后建的那个租户】的配置，而不是他自己所在租户的。
--
--   c) 保存 RPC save_tenant_config() 写的是 current_tenant_id()（超管=租户1）。
--      读到的行 ≠ 写入的行 -> fetchConfigs() 重新拉回来又被别人的数据覆盖
--      -> 界面表现为「改不了」。
--
-- 【佐证】（出事时的真实数据）
--   basic 有 4 个租户的私有行 id=404(t2)/405(t1)/408(t3)/409(t4)
--     -> 超管看到 id 最大的 409（租户4 恩智普），改动却写进 405（自己）
--   manufacturing 只有租户1 的私有行 id=412
--     -> 读到的就是自己的，所以能正常保存（scrapRatePrecision 已是改过的 6）
--
-- 【修复】排序改成三级优先级：本人租户 > 平台基线 > 其它租户。
--       读写永远落在同一行上，超管行为与普通租户一致。
--
-- 【副作用】无。普通租户读到的行完全不变；ai-server 走 get_tenant_config()
--       显式传租户，不走这个视图。
-- ============================================================================


-- ============================================================================
-- 1. 重建「覆盖优先」视图：二级排序 -> 三级优先级
-- ============================================================================

CREATE OR REPLACE VIEW public.vw_sys_config_effective
WITH (security_invoker = true) AS
SELECT DISTINCT ON (c.category_code)
       c.id,
       c.corp_id,
       c.emp_id,
       c.category_code,
       c.category_name,
       c.config_json,
       c.description,
       c.status,
       c.sort_order,
       c.is_deleted,
       c.created_at,
       c.updated_at,
       c.tenant_id
FROM public.sys_config c
WHERE c.is_deleted = 'n'
  AND (
        c.tenant_id IS NULL
     OR c.tenant_id = public.current_tenant_id()
     OR public.current_user_is_super_admin()
  )
ORDER BY c.category_code,
         -- 优先级 0：本人租户的私有行 —— 最高。
         --   不加这一级的话，超管会因为上面的 super_admin 分支看到全租户的行，
         --   多个私有行之间只剩 id DESC 决胜，读到别人的配置，
         --   而 save_tenant_config() 写的是自己的 tenant_id，读写错位。
         --   current_tenant_id() 为 NULL（service_role / 无 JWT）时本条件恒假，
         --   退化为原来的「基线 > 私有」。
         -- 优先级 1：平台基线
         -- 优先级 2：其它租户的私有行 —— 只为超管保留查错/排障的可见性，
         --   正常情况下轮不到它。
         CASE
           WHEN c.tenant_id = public.current_tenant_id() THEN 0
           WHEN c.tenant_id IS NULL THEN 1
           ELSE 2
         END,
         c.id DESC;

GRANT SELECT ON public.vw_sys_config_effective TO authenticated;

COMMENT ON VIEW public.vw_sys_config_effective IS
  '系统设置（本人租户私有行 > 平台基线行 > 其它租户行），前端请读这个视图而不是 sys_config 原表';


-- ============================================================================
-- 2.（可选，推荐）收紧 sys_config 的读范围：超管也不看别的租户的私有行
--
--    第 1 节只让 super_admin 不再【抢到】别人的行，但他依然【读到】别人的行。
--    sys_config 属于「私有数据表」（deploy_48 里 private_only 那一组），
--    而 AI 设置的 config_json 里存着各租户大模型服务商的 **apiKey 明文**，
--    让超管账号能横向读走，属于实质性信息泄露。
--
--    这里把通用策略 tenant_scope_visible() 换成显式谓词，
--    只放行「基线 + 本人租户」两条，超管也不例外。
--
--    保留 WITH CHECK = tenant_scope_writable(tenant_id, FALSE)：
--    超管仍然可以直接改基线行（用于修全局默认值），写能力不受影响。
--
--    注意执行顺序：本脚本必须在 deploy_48 之后跑。
--    若之后重跑 deploy_48 第 6 节，会覆盖回宽策略，需要把本节再跑一遍。
-- ============================================================================

DROP POLICY IF EXISTS tenant_scope_sys_config ON public.sys_config;

CREATE POLICY tenant_scope_sys_config ON public.sys_config
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
      tenant_id IS NULL
   OR tenant_id = public.current_tenant_id()
  )
  WITH CHECK (public.tenant_scope_writable(tenant_id, FALSE));


-- ============================================================================
-- 3. 让 PostgREST 重载 schema
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 自检（在 Supabase Studio 里单独跑，应为全部 TRUE）
--
--   -- 1) 视图的新优先级表达式生效：每个 category_code 只有一行，
--   --    且 basic 取到的是超管自己租户(1)的 id=405，而不是 id 最大的 409
--   SELECT category_code, id, tenant_id
--   FROM public.vw_sys_config_effective
--   ORDER BY sort_order;
--
--   -- 2) 第 2 节是否装成功
--   SELECT policyname, cmd, permissive, qual, with_check
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename='sys_config';
--   -- tenant_scope_sys_config 的 qual 里不应出现 current_user_is_super_admin()
-- ============================================================================
