-- ============================================================================
-- deploy_48: 平台元数据（角色/菜单/字典/系统设置/DocType/单据转换/页面设计/
--             知识库/工作流定义/通知）租户隔离
--
-- 依赖：deploy_41（sys_tenants + current_tenant_id()）
--      deploy_42 负责 sys_baq_queries + sys_ai_chat_memory（本脚本不再重复处理，
--      只补 BAQ 编码的唯一键改造）
--
-- 隔离模型：平台基线 + 租户私有
--   tenant_id IS NULL        -> 平台全局基线，所有租户可见
--   tenant_id = <租户 id>    -> 租户私有，仅该租户可见
--
--   与 deploy_41 给 erp_* 用的 fail-closed（NULL 一律不可见）不同：
--   这些表是元数据，不是业务数据。存量数据全部来自单一租户，若按 erp 的做法
--   回填成 tenant 1，第二个租户登录后菜单/角色/字典/DocType 会是空的，系统直接
--   不可用。所以存量保持 NULL 当基线，新写入的由 DEFAULT current_tenant_id()
--   自动归属当前租户 —— 前端 insert 无需改动。
--
--   基线能不能改，按表的性质分两类（第 6 节）：
--     元数据（菜单/角色/字典/DocType/工作流定义）：允许改。存量全是基线行，
--       收紧成只读的话现在连菜单都改不了。这是「租户间隐含信任」模型。
--     用户数据（通知/知识库/页面设计/单据转换记录/系统设置私有副本）：不允许。
--       基线对这些表毫无意义，允许写基线等于能发全员可见的通知。
--   两者都只受「原来有没有该表的写权限」约束（has_table_permission），
--   租户范围是在此之上叠加的收窄，不是替代。
--
-- 执行方式（建议先在事务里干跑）：
--   BEGIN;
--   \i deploy_48_platform_metadata_tenant.sql
--   -- 检查 NOTICE 输出，确认每个表都处理到、自检无异常
--   ROLLBACK;   -- 确认无误后改成 COMMIT 再跑一次
-- ============================================================================


-- ============================================================================
-- 1. 租户可见性/可写性判定
--
--   单独抽成函数，避免 24 张表的策略里重复写同一段谓词。
--   策略里存的是表达式文本，改这两个函数等于一次性改全部策略，不需要重刷。
--
--   读：基线(NULL) 或 自己租户 或 超管
--   写：普通用户只能写自己租户的行 —— 否则任何人都写 NULL，基线会被污染。
--       超管放行，用于维护基线。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tenant_scope_visible(p_tenant_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_tenant_id IS NULL
      OR p_tenant_id = public.current_tenant_id()
      OR public.current_user_is_super_admin();
$$;

-- p_baseline_writable 决定基线行（tenant_id IS NULL）能不能被改。
--
--   元数据表传 TRUE：菜单、角色、字典、DocType、工作流定义这些存量数据全是
--   基线行，收紧成只读的话现在连菜单都改不了；而第二个租户要靠这些基线才能
--   开箱可用，所以不能回填给某个租户。代价是多租户规模化后，有维护权限的
--   管理员改动的是共享基线 —— 属于「租户间隐含信任」模型。真要收紧时把
--   第 6 节对应表的参数改成 FALSE 重跑即可。
--
--   用户数据/业务数据表传 FALSE：通知、知识库、页面设计、单据转换记录。
--   基线对这些表毫无意义，一旦允许写基线就等于可以发全员可见的通知、
--   把私有知识库推给所有人。
CREATE OR REPLACE FUNCTION public.tenant_scope_writable(
    p_tenant_id BIGINT,
    p_baseline_writable BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN public.current_user_is_super_admin() THEN TRUE
    WHEN p_tenant_id IS NOT NULL THEN p_tenant_id = public.current_tenant_id()
    ELSE COALESCE(p_baseline_writable, FALSE)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.tenant_scope_visible(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_scope_writable(BIGINT, BOOLEAN) TO authenticated;


-- ============================================================================
-- 2. 通用安装函数：给一张表装租户范围
--
--    三条注意：
--    a) 用 RESTRICTIVE 而不是 permissive。表上原有的策略（角色权限、菜单状态等）
--       是 permissive，是 OR 叠加；只有 RESTRICTIVE 才是 AND，才能在不破坏原有
--       权限语义的前提下收窄租户范围。
--    b) 若某张表一个 permissive 策略都没有，RESTRICTIVE 会让整表读不到
--       （RLS 要求至少一条 permissive 通过）。所以先补一条兜底 permissive，
--       保持改造前的可见性，再让 restrictive 收租户。
--    c) FOR ALL 覆盖增删改查，DELETE 必须包含 —— 漏了就能跨租户删基线数据。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.install_tenant_scope(
    target_table_name TEXT,
    baseline_writable BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    writable_flag TEXT := CASE WHEN COALESCE(baseline_writable, FALSE) THEN 'TRUE' ELSE 'FALSE' END;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name = target_table_name
    ) THEN
        RAISE EXCEPTION 'public.% does not exist', target_table_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = target_table_name
          AND column_name = 'tenant_id'
    ) THEN
        RAISE EXCEPTION 'public.% has no tenant_id column', target_table_name;
    END IF;

    -- b) 兜底 permissive
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = target_table_name
          AND permissive = 'PERMISSIVE'
    ) THEN
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE)',
            'tenant_base_' || target_table_name, target_table_name);
        RAISE NOTICE '  added fallback permissive policy on %', target_table_name;
    END IF;

    -- a) + c) 收窄租户范围。注意 writable 的第二个参数在策略里是写死的常量，
    --    改这个开关需要重跑 install_tenant_scope，不能只改函数。
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_scope_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.tenant_scope_visible(tenant_id)) WITH CHECK (public.tenant_scope_writable(tenant_id, %s))',
        'tenant_scope_' || target_table_name, target_table_name, writable_flag);
END;
$$;


-- ============================================================================
-- 3. 24 张表加 tenant_id 列
--
--    顺序：加可空列 -> 回填 -> 设 DEFAULT。
--    不要一步 ADD COLUMN ... DEFAULT current_tenant_id()：PG 会给存量行填上
--    迁移会话解析出的租户（service_role 下为 NULL），结果不可控；这里让回填
--    逻辑显式决定每行归属。
-- ============================================================================

DO $$
DECLARE
    target_tables TEXT[] := ARRAY[
        -- 平台基线（存量保持 NULL，所有租户共享）
        'sys_roles',
        'sys_menus',
        'sys_config',
        'sys_dict_types',
        'sys_document_types',
        'sys_inventory_transaction_types',
        'sys_document_transaction_types',
        'doc_flow_rules',
        'doc_flow_source_meta',
        'doc_flow_doc_meta',
        'wf_process_definitions',
        -- 父子联动（租户跟随父行）
        'sys_role_menus',
        'sys_user_roles',
        'sys_role_table_permissions',
        'sys_dict_items',
        'sys_document_type_fields',
        'doc_flow_field_maps',
        'wf_process_nodes',
        'sys_ai_knowledge_chunks',
        -- 租户内容（存量回填到默认租户）
        'sys_ai_knowledge_docs',
        'sys_custom_pages',
        'sys_forms',
        'doc_flow_transfers',
        -- 用户级数据（按接收人回填）
        'sys_notifications'
    ];
    table_item TEXT;
BEGIN
    FOREACH table_item IN ARRAY target_tables
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = table_item
              AND column_name = 'tenant_id'
        ) THEN
            EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id BIGINT', table_item);
        END IF;

        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
            table_item, 'fk_' || table_item || '_tenant');
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants(id) ON DELETE RESTRICT',
            table_item, 'fk_' || table_item || '_tenant');

        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
            'idx_' || table_item || '_tenant_id', table_item);
    END LOOP;

    RAISE NOTICE 'tenant_id 列已就绪：% 张表', array_length(target_tables, 1);
END $$;


-- ============================================================================
-- 4. 回填
--
--    4.1 父子联动表：继承父行的租户。父行是基线(NULL) 则子行也是 NULL，
--        父行是租户私有则子行跟过去 —— 一行 SQL 同时处理两种情况，不需要
--        先判断父行归属。
--    4.2 租户内容表：存量都是默认租户在用，回填到 default。
--    4.3 通知：按接收人所属用户回填。
--    4.4 基线表：不动。存量保持 NULL 即基线。
-- ============================================================================

-- 4.1 父子联动
UPDATE public.sys_role_menus rm
SET tenant_id = r.tenant_id
FROM public.sys_roles r
WHERE rm.tenant_id IS NULL
  AND r.id = rm.role_id;

UPDATE public.sys_user_roles ur
SET tenant_id = u.tenant_id
FROM public.sys_users u
WHERE ur.tenant_id IS NULL
  AND u.id = ur.user_id;

UPDATE public.sys_role_table_permissions rtp
SET tenant_id = r.tenant_id
FROM public.sys_roles r
WHERE rtp.tenant_id IS NULL
  AND r.id = rtp.role_id;

UPDATE public.sys_dict_items di
SET tenant_id = dt.tenant_id
FROM public.sys_dict_types dt
WHERE di.tenant_id IS NULL
  AND dt.id = di.type_id;

UPDATE public.sys_document_type_fields dtf
SET tenant_id = dt.tenant_id
FROM public.sys_document_types dt
WHERE dtf.tenant_id IS NULL
  AND dt.id = dtf.document_type_id;

UPDATE public.sys_document_transaction_types dtt
SET tenant_id = dt.tenant_id
FROM public.sys_document_types dt
WHERE dtt.tenant_id IS NULL
  AND dt.id = dtt.document_type_id;

UPDATE public.doc_flow_field_maps fm
SET tenant_id = r.tenant_id
FROM public.doc_flow_rules r
WHERE fm.tenant_id IS NULL
  AND r.id = fm.rule_id;

UPDATE public.wf_process_nodes pn
SET tenant_id = pd.tenant_id
FROM public.wf_process_definitions pd
WHERE pn.tenant_id IS NULL
  AND pd.id = pn.process_id;

UPDATE public.sys_ai_knowledge_chunks kc
SET tenant_id = kd.tenant_id
FROM public.sys_ai_knowledge_docs kd
WHERE kc.tenant_id IS NULL
  AND kd.id = kc.doc_id;


-- 4.2 租户内容：回填到默认租户
DO $$
DECLARE
    default_tenant_id BIGINT;
BEGIN
    SELECT id INTO default_tenant_id
    FROM public.sys_tenants
    WHERE code = 'default'
    ORDER BY id
    LIMIT 1;

    IF default_tenant_id IS NULL THEN
        SELECT id INTO default_tenant_id FROM public.sys_tenants ORDER BY id LIMIT 1;
    END IF;

    IF default_tenant_id IS NULL THEN
        RAISE EXCEPTION 'sys_tenants 为空，请先执行 deploy_41';
    END IF;

    UPDATE public.sys_ai_knowledge_docs SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
    UPDATE public.sys_custom_pages      SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;
    UPDATE public.sys_forms             SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;

    -- 单据转换记录：优先跟随规则，规则被删或为空则落到默认租户。
    -- 它是运行数据不是元数据，不该当基线共享。
    UPDATE public.doc_flow_transfers t
    SET tenant_id = COALESCE(r.tenant_id, default_tenant_id)
    FROM public.doc_flow_rules r
    WHERE t.tenant_id IS NULL
      AND r.id = t.rule_id;

    UPDATE public.doc_flow_transfers
    SET tenant_id = default_tenant_id
    WHERE tenant_id IS NULL;

    RAISE NOTICE '租户内容已回填到 tenant %', default_tenant_id;
END $$;


-- 4.3 通知按接收人回填
DO $$
DECLARE
    default_tenant_id BIGINT;
BEGIN
    SELECT id INTO default_tenant_id FROM public.sys_tenants WHERE code = 'default' ORDER BY id LIMIT 1;

    UPDATE public.sys_notifications n
    SET tenant_id = u.tenant_id
    FROM public.sys_users u
    WHERE n.tenant_id IS NULL
      AND u.id = n.recipient_user_id
      AND u.tenant_id IS NOT NULL;

    IF default_tenant_id IS NOT NULL THEN
        UPDATE public.sys_notifications
        SET tenant_id = default_tenant_id
        WHERE tenant_id IS NULL;
    END IF;
END $$;


-- 通知是纯用户数据，没有「平台基线通知」这个概念，不能靠调用方自觉带 tenant_id。
-- 系统侧发通知（后台任务、definer 函数）时往往没有 JWT，列的 DEFAULT
-- current_tenant_id() 会解析成 NULL，一行 NULL 就是对所有租户可见。
-- 用触发器从接收人反推归属，兜住这条路。
CREATE OR REPLACE FUNCTION public.sys_notifications_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.tenant_id IS NULL AND NEW.recipient_user_id IS NOT NULL THEN
        SELECT u.tenant_id INTO NEW.tenant_id
        FROM public.sys_users u
        WHERE u.id = NEW.recipient_user_id
        LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sys_notifications_tenant ON public.sys_notifications;
CREATE TRIGGER trg_sys_notifications_tenant
BEFORE INSERT ON public.sys_notifications
FOR EACH ROW
EXECUTE FUNCTION public.sys_notifications_set_tenant();


-- 4.4 设 DEFAULT：新行自动归属当前租户
DO $$
DECLARE
    target_tables TEXT[] := ARRAY[
        'sys_roles', 'sys_menus', 'sys_config', 'sys_dict_types', 'sys_dict_items',
        'sys_document_types', 'sys_document_type_fields', 'sys_document_transaction_types',
        'sys_inventory_transaction_types', 'doc_flow_rules', 'doc_flow_field_maps',
        'doc_flow_source_meta', 'doc_flow_doc_meta', 'doc_flow_transfers',
        'wf_process_definitions', 'wf_process_nodes',
        'sys_ai_knowledge_docs', 'sys_ai_knowledge_chunks',
        'sys_custom_pages', 'sys_forms', 'sys_notifications',
        'sys_role_menus', 'sys_user_roles', 'sys_role_table_permissions'
    ];
    table_item TEXT;
BEGIN
    FOREACH table_item IN ARRAY target_tables
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id()',
            table_item);
    END LOOP;
END $$;


-- deploy_42 给 sys_baq_queries / sys_ai_chat_memory 加列时没有设 DEFAULT，
-- 前端新建 BAQ 时 tenant_id 会落空，被 deploy_42 的 fail-closed 策略拒掉。
-- 这里补上（BAQ 是租户私有资产，不适用本脚本的基线共享语义）。
DO $$
DECLARE
    table_item TEXT;
BEGIN
    FOREACH table_item IN ARRAY ARRAY['sys_baq_queries', 'sys_ai_chat_memory']
    LOOP
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = table_item
              AND column_name = 'tenant_id'
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id()',
                table_item);
            RAISE NOTICE '% : DEFAULT 已补齐', table_item;
        ELSE
            RAISE NOTICE '% : 尚无 tenant_id，请先执行 deploy_42', table_item;
        END IF;
    END LOOP;
END $$;


-- ============================================================================
-- 5. 唯一键改造：从「全局唯一」改成「基线内唯一 + 租户内唯一」
--
--    Postgres 的 UNIQUE 对 NULL 不去重，所以不能简单改成 UNIQUE(tenant_id, code)
--    —— 那样基线行（tenant_id IS NULL）之间的重复就没人管了。
--    用两条部分索引分别约束：
--      WHERE tenant_id IS NULL     -> 基线内 code 唯一
--      WHERE tenant_id IS NOT NULL -> 同一租户内 code 唯一
--    已知例外（下面 rewrite_list 里已排除，函数里也有运行时兜底）：
--      sys_document_types.document_type
--      sys_inventory_transaction_types.code
--    这两个被其它表的外键引用（doc_flow_* 引用 document_type、
--    sys_document_transaction_types 引用 transaction types 的 code）。
--    Postgres 的外键只能依赖「完整」的唯一索引，部分索引（带 WHERE）满足不了它，
--    所以这两个键必须保持全表唯一 —— 否则 DROP 时会报 2BP01 依赖错误。
--    它们本质是「模式级编码」（document_type 还决定物理表名），全表唯一本就是对的：
--    租户仍可建私有 DocType（tenant_id 非空的私有行），只是编码不能与别人撞。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.convert_unique_to_tenant_scoped(
    target_table_name TEXT,
    unique_column TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    constraint_item RECORD;
    dropped_count INTEGER := 0;
    dependent_fks TEXT;
BEGIN
    -- 前置检查：这个唯一键是否被别的表当外键引用。
    -- Postgres 的 FK 只能依赖「完整」唯一索引，部分索引（WHERE tenant_id IS ...）
    -- 满足不了它，直接 DROP 会报 2BP01 cannot drop because other objects depend on it。
    -- 遇到就跳过改造并保持全表唯一，只告警不中断，避免整个脚本半途失败。
    SELECT string_agg(
               format('%I.%I', fk_rel.relname, fk_cons.conname), ', ' ORDER BY fk_rel.relname
           )
    INTO dependent_fks
    FROM pg_constraint uq_cons
    JOIN pg_constraint fk_cons
      ON fk_cons.contype = 'f'
     AND fk_cons.confrelid = uq_cons.conrelid
     AND fk_cons.confkey = uq_cons.conkey
    JOIN pg_class fk_rel ON fk_rel.oid = fk_cons.conrelid
    WHERE uq_cons.conrelid = format('public.%I', target_table_name)::regclass
      AND uq_cons.contype = 'u'
      AND pg_get_constraintdef(uq_cons.oid) LIKE '%(' || unique_column || ')%';

    IF dependent_fks IS NOT NULL THEN
        RAISE WARNING '跳过 %.% 的唯一键改造：它被外键依赖（%），FK 无法依赖部分索引，保持全表唯一',
            target_table_name, unique_column, dependent_fks;
        RETURN;
    END IF;

    -- 删掉涉及该列的唯一约束（列名不写死，避免版本间命名漂移）
    FOR constraint_item IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = format('public.%I', target_table_name)::regclass
          AND c.contype = 'u'
          AND pg_get_constraintdef(c.oid) LIKE '%(' || unique_column || ')%'
    LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
            target_table_name, constraint_item.conname);
        dropped_count := dropped_count + 1;
    END LOOP;

    -- 唯一索引形式的（CREATE UNIQUE INDEX 不是约束）也一并处理
    EXECUTE format('DROP INDEX IF EXISTS public.%I',
        'uq_' || target_table_name || '_' || unique_column || '_global');
    EXECUTE format('DROP INDEX IF EXISTS public.%I',
        'uq_' || target_table_name || '_' || unique_column || '_tenant');

    EXECUTE format(
        'CREATE UNIQUE INDEX %I ON public.%I (%I) WHERE tenant_id IS NULL',
        'uq_' || target_table_name || '_' || unique_column || '_global',
        target_table_name, unique_column);
    EXECUTE format(
        'CREATE UNIQUE INDEX %I ON public.%I (tenant_id, %I) WHERE tenant_id IS NOT NULL',
        'uq_' || target_table_name || '_' || unique_column || '_tenant',
        target_table_name, unique_column);

    RAISE NOTICE '唯一键改造 %：删除 % 条旧约束，新建基线/租户双索引（列 %）',
        target_table_name, dropped_count, unique_column;
END;
$$;

DO $$
DECLARE
    rewrite_list TEXT[][] := ARRAY[
        ARRAY['sys_roles', 'role_code'],
        ARRAY['sys_config', 'category_code'],
        ARRAY['sys_dict_types', 'code'],
        ARRAY['doc_flow_rules', 'rule_code'],
        ARRAY['sys_custom_pages', 'slug'],
        ARRAY['wf_process_definitions', 'process_code']
    ];
    item TEXT[];
BEGIN
    FOREACH item SLICE 1 IN ARRAY rewrite_list
    LOOP
        PERFORM public.convert_unique_to_tenant_scoped(item[1], item[2]);
    END LOOP;
END $$;

-- sys_forms 有两个唯一键
DO $$
BEGIN
    PERFORM public.convert_unique_to_tenant_scoped('sys_forms', 'table_name');
    PERFORM public.convert_unique_to_tenant_scoped('sys_forms', 'form_name');
END $$;

-- sys_baq_queries 的租户隔离由 deploy_42 负责（BAQ 是租户私有资产，不走基线共享），
-- 但 deploy_42 没动编码唯一键，这里补上。列不存在时跳过，说明 deploy_42 还没跑。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sys_baq_queries'
          AND column_name = 'tenant_id'
    ) THEN
        PERFORM public.convert_unique_to_tenant_scoped('sys_baq_queries', 'code');
    ELSE
        RAISE WARNING 'sys_baq_queries 还没有 tenant_id，请先执行 deploy_42，再单独跑本节';
    END IF;
END $$;


-- ============================================================================
-- 6. 装租户策略
-- ============================================================================

DO $$
DECLARE
    -- 元数据：共享基线，有该表维护权限即可改基线（详见第 1 节的说明）
    baseline_writable_tables TEXT[] := ARRAY[
        'sys_roles', 'sys_menus', 'sys_dict_types', 'sys_dict_items',
        'sys_document_types', 'sys_document_type_fields',
        'sys_document_transaction_types', 'sys_inventory_transaction_types',
        'doc_flow_rules', 'doc_flow_field_maps', 'doc_flow_source_meta',
        'doc_flow_doc_meta', 'wf_process_definitions', 'wf_process_nodes',
        'sys_role_menus', 'sys_user_roles', 'sys_role_table_permissions'
    ];
    -- 用户/业务数据：只认自己的租户，基线一律不可写。
    -- sys_config 也在这里：它的私有副本由 save_tenant_config() 生成，
    -- 不允许直接改基线行。
    private_only_tables TEXT[] := ARRAY[
        'sys_config', 'sys_notifications', 'doc_flow_transfers',
        'sys_ai_knowledge_docs', 'sys_ai_knowledge_chunks',
        'sys_custom_pages', 'sys_forms'
    ];
    table_item TEXT;
BEGIN
    FOREACH table_item IN ARRAY baseline_writable_tables
    LOOP
        PERFORM public.install_tenant_scope(table_item, TRUE);
        RAISE NOTICE 'tenant scope installed (baseline writable): %', table_item;
    END LOOP;

    FOREACH table_item IN ARRAY private_only_tables
    LOOP
        PERFORM public.install_tenant_scope(table_item, FALSE);
        RAISE NOTICE 'tenant scope installed (private only): %', table_item;
    END LOOP;
END $$;


-- ============================================================================
-- 7. 系统设置「覆盖优先」视图 + 保存 RPC
--
--    基线共享带来的唯一副作用：同一 category_code 可能同时存在基线行和租户
--    私有行，前端 .eq('category_code', x).single() 会拿到 2 行直接报错。
--    用视图做覆盖：有私有行就用私有的，没有就退回基线 —— 永远单行。
--
--    security_invoker = true 必须带：否则视图以 owner 身份运行，绕开 sys_config
--    自己的 RLS，租户能看到别的租户的私有配置。
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
         (c.tenant_id IS NULL) ASC,   -- 私有行优先于基线行
         c.id DESC;

GRANT SELECT ON public.vw_sys_config_effective TO authenticated;

COMMENT ON VIEW public.vw_sys_config_effective IS
  '系统设置（租户私有行覆盖平台基线行），前端请读这个视图而不是 sys_config 原表';


-- 保存：有私有行就更新，没有就插入一条私有的。
-- 普通用户只能写自己租户；超管可以写基线（tenant_id = NULL）由 SQL 直接操作，
-- 这里不开放，避免前台一个误操作污染全局基线。
CREATE OR REPLACE FUNCTION public.save_tenant_config(
    p_category_code TEXT,
    p_config_json JSONB,
    p_category_name TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_sort_order INTEGER DEFAULT NULL,
    p_status CHAR(1) DEFAULT NULL
)
RETURNS public.sys_config
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id BIGINT := public.current_tenant_id();
    v_row public.sys_config;
BEGIN
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION '当前用户没有租户上下文，无法保存系统设置';
    END IF;

    UPDATE public.sys_config
    SET config_json   = p_config_json,
        category_name = COALESCE(p_category_name, category_name),
        description   = COALESCE(p_description, description),
        sort_order    = COALESCE(p_sort_order, sort_order),
        status        = COALESCE(p_status, status),
        updated_at    = NOW()
    WHERE category_code = p_category_code
      AND tenant_id = v_tenant_id
      AND is_deleted = 'n'
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        -- 基线行作为模板：名称/描述/排序/状态都沿用，只有内容被覆盖
        INSERT INTO public.sys_config (
            category_code, category_name, config_json, description, sort_order, status, tenant_id
        )
        SELECT p_category_code,
               COALESCE(p_category_name, b.category_name, p_category_code),
               p_config_json,
               COALESCE(p_description, b.description),
               COALESCE(p_sort_order, b.sort_order, 0),
               COALESCE(p_status, b.status, '1'),
               v_tenant_id
        FROM (
            SELECT category_name, description, sort_order, status
            FROM public.sys_config
            WHERE category_code = p_category_code AND tenant_id IS NULL AND is_deleted = 'n'
            LIMIT 1
        ) b
        RETURNING * INTO v_row;

        IF NOT FOUND THEN
            INSERT INTO public.sys_config (
                category_code, category_name, config_json, description, sort_order, status, tenant_id
            ) VALUES (
                p_category_code,
                COALESCE(p_category_name, p_category_code),
                p_config_json,
                p_description,
                COALESCE(p_sort_order, 0),
                COALESCE(p_status, '1'),
                v_tenant_id
            )
            RETURNING * INTO v_row;
        END IF;
    END IF;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_tenant_config(TEXT, JSONB, TEXT, TEXT, INTEGER, CHAR) TO authenticated;

COMMENT ON FUNCTION public.save_tenant_config(TEXT, JSONB, TEXT, TEXT, INTEGER, CHAR) IS
  '保存当前租户的系统设置：有私有行则更新，无则基于基线行创建一条私有副本';


-- 读取端：ai-server 用 service_role 直连，没有 JWT，视图里的 current_tenant_id()
-- 解析不出租户，只能看到基线行。所以给它一个显式传租户的读函数。
-- 传了租户就「私有优先、回退基线」；没传就只返回基线。
CREATE OR REPLACE FUNCTION public.get_tenant_config(
    p_category_code TEXT,
    p_tenant_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
    v_config JSONB;
BEGIN
    IF v_tenant_id IS NOT NULL THEN
        SELECT c.config_json INTO v_config
        FROM public.sys_config c
        WHERE c.category_code = p_category_code
          AND c.tenant_id = v_tenant_id
          AND c.is_deleted = 'n'
        LIMIT 1;

        IF v_config IS NOT NULL THEN
            RETURN v_config;
        END IF;
    END IF;

    SELECT c.config_json INTO v_config
    FROM public.sys_config c
    WHERE c.category_code = p_category_code
      AND c.tenant_id IS NULL
      AND c.is_deleted = 'n'
    LIMIT 1;

    RETURN v_config;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_config(TEXT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_config(TEXT, BIGINT) TO service_role;

COMMENT ON FUNCTION public.get_tenant_config(TEXT, BIGINT) IS
  '读取系统配置：租户私有行优先，没有则回退平台基线行。ai-server 等无 JWT 上下文的调用方显式传 p_tenant_id';


-- 向量检索也是 SECURITY DEFINER，会把所有租户的知识一起召回。
-- 用独立函数名而不是同名重载：PostgREST 对重载支持不牢靠，同名会 ambiguous。
-- p_tenant_id 为 NULL 且当前会话也没有租户时，条件退化成「只返回基线」，
-- 不会退化成「返回全部」。
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks_for_tenant(
  query_embedding extensions.vector(768),
  match_threshold FLOAT DEFAULT 0.25,
  match_count INT DEFAULT 8,
  p_tenant_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  chunk_id BIGINT,
  doc_id BIGINT,
  title VARCHAR,
  content TEXT,
  category VARCHAR,
  source_type VARCHAR,
  source_ref TEXT,
  similarity FLOAT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    c.id,
    d.id,
    d.title,
    c.content,
    d.category,
    d.source_type,
    d.source_ref,
    1 - (
      c.embedding OPERATOR(extensions.<=>) query_embedding
    ) AS similarity
  FROM public.sys_ai_knowledge_chunks c
  JOIN public.sys_ai_knowledge_docs d ON d.id = c.doc_id
  WHERE d.is_active = TRUE
    AND c.embedding IS NOT NULL
    AND (
      d.tenant_id IS NULL
      OR d.tenant_id = COALESCE(p_tenant_id, public.current_tenant_id())
    )
    AND (
      c.tenant_id IS NULL
      OR c.tenant_id = COALESCE(p_tenant_id, public.current_tenant_id())
    )
    AND 1 - (
      c.embedding OPERATOR(extensions.<=>) query_embedding
    ) >= match_threshold
  ORDER BY c.embedding OPERATOR(extensions.<=>) query_embedding
  LIMIT LEAST(match_count, 20);
$$;

GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_chunks_for_tenant(
  extensions.vector(768), FLOAT, INT, BIGINT
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_chunks_for_tenant(
  extensions.vector(768), FLOAT, INT, BIGINT
) TO service_role;


-- ============================================================================
-- 8. 加固 SECURITY DEFINER 函数
--
--    这一节是整个脚本最容易被忽略、但漏了就前功尽弃的地方：
--    SECURITY DEFINER 函数以 owner 身份执行，绕过所有 RLS。下面几个函数直接
--    查 sys_menus / sys_role_menus / sys_role_table_permissions，装上租户策略
--    后它们照样能读到别的租户的行 —— RLS 对它们无效。
--
--    典型泄漏路径：租户 A 新建一条私有菜单（tenant_id = A），并把它挂到
--    基线角色 operator 上（绑定行本身是基线，对所有租户可见）。租户 B 的
--    operator 用户调 current_user_menu_paths() 时，definer 绕开 RLS，会把租户
--    A 的私有菜单路径判给他。所以谓词必须写进函数体。
--
--    复用 tenant_scope_visible()：基线(NULL) 可见、自己租户可见、超管全放开。
-- ============================================================================

-- 8.1 菜单路径
CREATE OR REPLACE FUNCTION public.current_user_menu_paths()
RETURNS TABLE(path TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH current_roles AS (
    SELECT DISTINCT ur.role_id
    FROM public.sys_users u
    JOIN public.sys_user_roles ur ON ur.user_id = u.id
    WHERE u.auth_id = auth.uid()
      AND u.is_deleted = 'n'
      AND u.status = '1'
      AND ur.is_deleted = 'n'
      AND ur.role_id IS NOT NULL
      AND public.tenant_scope_visible(ur.tenant_id)
  )
  SELECT DISTINCT m.path::TEXT
  FROM current_roles cr
  JOIN public.sys_roles r ON r.id = cr.role_id
  JOIN public.sys_role_menus rm ON rm.role_id = r.id
  JOIN public.sys_menus m ON m.id = rm.menu_id
  WHERE r.is_deleted = 'n'
    AND r.status = '1'
    AND rm.is_deleted = 'n'
    AND m.is_deleted = 'n'
    AND m.status = '1'
    AND m.path IS NOT NULL
    AND m.path <> ''
    AND public.tenant_scope_visible(r.tenant_id)
    AND public.tenant_scope_visible(rm.tenant_id)
    AND public.tenant_scope_visible(m.tenant_id);
$$;

GRANT EXECUTE ON FUNCTION public.current_user_menu_paths() TO authenticated;


-- 8.2 角色代码
CREATE OR REPLACE FUNCTION public.current_user_role_codes()
RETURNS TABLE(role_code TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT r.role_code::TEXT
  FROM public.sys_users u
  JOIN public.sys_user_roles ur ON ur.user_id = u.id
  JOIN public.sys_roles r ON r.id = ur.role_id
  WHERE u.auth_id = auth.uid()
    AND u.is_deleted = 'n'
    AND u.status = '1'
    AND ur.is_deleted = 'n'
    AND r.is_deleted = 'n'
    AND r.status = '1'
    AND public.tenant_scope_visible(ur.tenant_id)
    AND public.tenant_scope_visible(r.tenant_id);
$$;

GRANT EXECUTE ON FUNCTION public.current_user_role_codes() TO authenticated;


-- 8.3 表权限判定
--
--    注意：这个函数被几乎所有 RLS 策略调用，重写时只加租户谓词，
--    其余判定逻辑逐字保持 deploy_02 的原样。
CREATE OR REPLACE FUNCTION public.has_table_permission(target_table_name TEXT, action_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id INTEGER;
BEGIN
  current_user_id := public.current_sys_user_id();

  IF current_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND r.role_code = 'super_admin'
      AND public.tenant_scope_visible(ur.tenant_id)
      AND public.tenant_scope_visible(r.tenant_id)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    JOIN public.sys_role_table_permissions rp ON rp.role_id = r.id
    JOIN public.sys_tables t ON t.id = rp.table_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND rp.is_deleted = 'n'
      AND t.is_deleted = 'n'
      AND t.status = '1'
      AND t.table_name = target_table_name
      AND public.tenant_scope_visible(ur.tenant_id)
      AND public.tenant_scope_visible(r.tenant_id)
      AND public.tenant_scope_visible(rp.tenant_id)
      AND CASE action_name
        WHEN 'select' THEN rp.can_select
        WHEN 'insert' THEN rp.can_insert
        WHEN 'update' THEN rp.can_update
        WHEN 'delete' THEN rp.can_delete
        ELSE FALSE
      END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_table_permission(TEXT, TEXT) TO authenticated;


-- 重要：install_role_table_rls() 被 deploy_41 改成了「有 tenant_id 列就加
-- fail-closed 谓词 tenant_id = current_tenant_id()」。它对 erp_* 是对的，
-- 但对本脚本这批基线共享表是错的 —— 会把基线行（NULL）全部挡掉。
-- 因此这批表一律不要重跑 install_role_table_rls，租户范围只由
-- tenant_scope_* 策略负责。deploy_07 / deploy_11 里对 sys_config / sys_forms
-- 的调用若被重跑，需要再执行一遍本节脚本恢复。


-- ============================================================================
-- 9. 自检
-- ============================================================================

DO $$
DECLARE
    table_item TEXT;
    null_count BIGINT;
    private_count BIGINT;
    policy_count INTEGER;
    target_tables TEXT[] := ARRAY[
        'sys_roles', 'sys_menus', 'sys_config', 'sys_dict_types', 'sys_dict_items',
        'sys_document_types', 'sys_document_type_fields', 'sys_document_transaction_types',
        'sys_inventory_transaction_types', 'doc_flow_rules', 'doc_flow_field_maps',
        'doc_flow_source_meta', 'doc_flow_doc_meta', 'doc_flow_transfers',
        'wf_process_definitions', 'wf_process_nodes',
        'sys_ai_knowledge_docs', 'sys_ai_knowledge_chunks',
        'sys_custom_pages', 'sys_forms', 'sys_notifications',
        'sys_role_menus', 'sys_user_roles', 'sys_role_table_permissions'
    ];
BEGIN
    RAISE NOTICE '--- 表 / 基线(NULL) / 私有 / RESTRICTIVE 策略 ---';
    FOREACH table_item IN ARRAY target_tables
    LOOP
        EXECUTE format('SELECT count(*) FILTER (WHERE tenant_id IS NULL), count(*) FILTER (WHERE tenant_id IS NOT NULL) FROM public.%I', table_item)
        INTO null_count, private_count;

        SELECT count(*) INTO policy_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = table_item
          AND policyname = 'tenant_scope_' || table_item
          AND permissive = 'RESTRICTIVE';

        IF policy_count = 0 THEN
            RAISE WARNING '% : 缺少 tenant_scope 策略！', table_item;
        END IF;

        RAISE NOTICE '% : baseline=% private=% policy=%',
            table_item, null_count, private_count, policy_count;
    END LOOP;
END $$;


-- 权限提示：super_admin 角色是基线行，所有租户都能看到并赋给用户。
-- 一旦某个租户的用户拿到 super_admin，他就是全局超管，能看到所有租户的数据。
-- 这是「角色基线共享」必须接受的代价，请在开通租户时不要授予 super_admin。
DO $$
BEGIN
    RAISE WARNING '注意：sys_roles 中的 super_admin 是平台基线角色（tenant_id IS NULL），';
    RAISE WARNING '任何租户的管理员都能把它赋给自己的用户，从而成为可跨租户查看的全局超管。';
    RAISE WARNING '开通租户时请只授予业务角色；确需平台级超管的账号请留在默认租户。';
END $$;


-- 新视图和 RPC 需要 PostgREST 重载 schema 才能暴露
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 回滚（仅在需要撤销时手动执行）
--
-- DO $$
-- DECLARE
--     t TEXT;
--     target_tables TEXT[] := ARRAY[ ... 同第 6 节清单 ... ];
-- BEGIN
--     DROP VIEW IF EXISTS public.vw_sys_config_effective;
--     DROP FUNCTION IF EXISTS public.save_tenant_config(TEXT, JSONB, TEXT, TEXT, INTEGER, CHAR);
--     FOREACH t IN ARRAY target_tables LOOP
--         EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_scope_' || t, t);
--         EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_base_' || t, t);
--         EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP DEFAULT', t);
--         EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, 'fk_' || t || '_tenant');
--         EXECUTE format('DROP INDEX IF EXISTS public.%I', 'idx_' || t || '_tenant_id');
--         EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tenant_id', t);
--     END LOOP;
-- END $$;
-- 唯一键需要手工重建：ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (列名);
-- 第 5 节改造过的键：role_code / category_code / dict_types.code / rule_code /
--   custom_pages.slug / process_code / forms.table_name / forms.form_name / baq.code
-- 未改造、一直保持全表唯一的键（被外键依赖）：
--   sys_document_types.document_type、sys_inventory_transaction_types.code
-- ============================================================================
