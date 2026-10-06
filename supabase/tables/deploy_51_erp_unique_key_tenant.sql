-- ============================================================================
-- deploy_51: 业务唯一键分租户（把跨租户唯一改成「租户内唯一」）
-- ============================================================================
--
-- 背景
-- ----
-- deploy_41 给 59 张 erp_* 表加了 tenant_id 列并装了 RLS，但**没有动唯一键**，
-- 第 10 节只打印了一份 NOTICE 清单让人工处理。结果所有业务编码仍然是全表唯一：
--
--   租户 A 建了编码 COUNT 的计量单位分组 -> 租户 B 再建 COUNT 就报
--   duplicate key value violates unique constraint
--   "erp_uom_groups_s_539dcf81_b_code_key"
--
-- 客户编号、物料编码、仓库编码、会计期间、单据号……凡是带 UNIQUE 的业务字段，
-- 现在全都跨租户冲突。RLS 只能管「看得见看不见」，管不了「能不能重名」。
--
-- 目标
-- ----
--   把 UNIQUE(code)          ->  UNIQUE(tenant_id, code)
--   把 UNIQUE(a, b)          ->  UNIQUE(tenant_id, a, b)
--
--   同租户内照旧唯一，不同租户之间可以重名。
--
-- 适用范围（自动判定，不写死表名）
-- ------------------------------
--   只有「tenant_id 列存在且 NOT NULL」的表才处理 —— 也就是 fail-closed 语义的表
--   （59 张 erp_*、wf_process_instances / wf_process_actions）。
--
--   deploy_48 那批平台元数据表（菜单/角色/字典/DocType...）的 tenant_id 是**可空**的
--   （NULL = 平台基线），会被这个条件自动排除。它们用的是 deploy_48 里
--   「基线部分索引 + 租户部分索引」的另一套方案，不能套用这里的做法 ——
--   直接加 tenant_id 进唯一键会让所有基线行之间失去唯一性。
--
--   sys_users.username 也在 deploy_50 里按另一套方案处理过了（两条部分索引），
--   这里同样会被跳过（tenant_id 可空），不会重复改造。
--
-- 跳过规则（遇到就 RAISE WARNING，不中断整个脚本）
-- ------------------------------------------------
--   1) 被外键引用的唯一键。
--      Postgres 的 DROP CONSTRAINT 遇到 FK 依赖会直接报
--        2BP01: cannot drop constraint ... because other objects depend on it
--      （deploy_48 第一次执行就栽在这上面）。先建新索引也绕不过：FK 要求被引用列集合上
--      存在一个「列集合恰好相等」的唯一索引，(tenant_id, code) ≠ (code)，旧的照样卸不掉。
--      这类键只能人工：先删 FK -> 改索引 -> 重建 FK，或者接受它保持全表唯一。
--   2) 部分索引 / 表达式索引 —— 无法机械改写，留给人工。
--   3) 同租户内已经存在重复值 —— 加上 tenant_id 后反而会撞，改之前必须先清洗脏数据。
--      脚本只报告不删除任何数据。
--   4) 其它任何意外错误 —— 每个索引都在自己的子事务里处理，出错只跳过那一个，
--      并收回本次已建的新索引，不会让整批失败，也不会留下「新旧并存」的半改状态。
--   5) **显式跳过名单 v_skip_tables** —— 语义已经被「带库位维度 / 表达式的部分索引」
--      覆盖的表，机械套一层 (tenant_id, 原列) 会造出语义更弱的重复键。
--      当前名单：erp_inventory_s_539dcf81_b
--        （deploy_01 内联 UNIQUE(product_id, warehouse_id, batch_no) 在这里会被
--         改成不含 location_id 的键 → 同仓同批次两个库位直接 23505；
--         deploy_85 已把库存唯一键合并为 uq_erp_inventory_active_stock_t。）
--      新增跳过项时必须在该处写清理由，不要只加表名。
--
-- 安全顺序
-- --------
--   先 CREATE 新索引，成功后再 DROP 旧的。
--   反过来的话，一旦 ADD 失败就既没新索引也没旧索引。
--
-- 如何执行
-- --------
--   BEGIN;  ...（本文件内容）...  ROLLBACK;   -- 干跑，只看 NOTICE/WARNING
--   确认清单无误后把 ROLLBACK 换成 COMMIT 再跑一次。
--   强烈建议包在事务里：万一某条失败，整批回滚，不会留下半改状态。
--
-- 幂等性
-- ------
--   可重复执行。已经含 tenant_id 的唯一键会被 WHERE 条件排除，不会重复创建。
-- ============================================================================


-- ============================================================================
-- 1. 改造前：列出将要处理的唯一键（干跑时看这一份）
-- ============================================================================
DO $$
DECLARE
    idx_item RECORD;
    v_count  INTEGER := 0;
    -- 与第 2 节保持同一份跳过名单（理由见第 2 节注释）
    v_skip_tables TEXT[] := ARRAY['erp_inventory_s_539dcf81_b'];
BEGIN
    RAISE NOTICE '--- 显式跳过名单（不参与改造）: % ---', array_to_string(v_skip_tables, ', ');
    RAISE NOTICE '--- 待改造的跨租户唯一键清单 ---';
    FOR idx_item IN
        SELECT
            t.relname                      AS table_name,
            i.relname                      AS index_name,
            pg_get_indexdef(ix.indexrelid) AS definition
        FROM pg_index ix
        JOIN pg_class t     ON t.oid = ix.indrelid
        JOIN pg_class i     ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND ix.indisunique
          AND NOT ix.indisprimary
          AND ix.indpred IS NULL                                  -- 排除部分索引
          AND ix.indkey::text !~ '(^| )0( |$)'                    -- 排除表达式索引
          AND pg_get_indexdef(ix.indexrelid) NOT ILIKE '%tenant_id%'
          AND t.relname <> ALL (v_skip_tables)
          AND EXISTS (                                            -- 只处理 fail-closed 表
                SELECT 1 FROM pg_attribute at
                WHERE at.attrelid = t.oid
                  AND at.attname  = 'tenant_id'
                  AND at.attnotnull
          )
        ORDER BY t.relname, i.relname
    LOOP
        v_count := v_count + 1;
        RAISE NOTICE '% | % | %', idx_item.table_name, idx_item.index_name, idx_item.definition;
    END LOOP;
    RAISE NOTICE '--- 清单结束，共 % 个 ---', v_count;
END $$;


-- ============================================================================
-- 2. 执行改造
-- ============================================================================
DO $$
DECLARE
    idx_item   RECORD;
    v_cols     TEXT;
    v_key_nums INT2[];
    v_new_name TEXT;
    v_dup      BIGINT;
    v_conname  TEXT;
    v_done     INTEGER := 0;
    v_skipped  INTEGER := 0;
    v_created  BOOLEAN;
    -- 显式跳过名单：这些表「同一组业务列」的唯一性已经由带库位维度 / 表达式的
    -- 部分索引承担，机械地再套一层 (tenant_id, 原列) 会造出一个语义更弱的
    -- 重复键，反而把部分索引允许的行组合挡掉。
    --
    -- erp_inventory：deploy_01 内联 UNIQUE(product_id, warehouse_id, batch_no)
    --   在这里会被改造成 (tenant_id, product_id, warehouse_id, batch_no)，
    --   不含 location_id → 同一仓库同一批次放两个库位直接 23505，
    --   而 deploy_25/34 补的 v2 部分索引本来是允许的。
    --   deploy_85 已把两者合并为 uq_erp_inventory_active_stock_t，
    --   这里必须跳过，否则任何一次「deploy_01 → deploy_51」的新建库都会把缺陷带回来。
    v_skip_tables TEXT[] := ARRAY['erp_inventory_s_539dcf81_b'];
BEGIN
    FOR idx_item IN
        SELECT
            t.relname    AS table_name,
            i.relname    AS index_name,
            ix.indexrelid,
            ix.indrelid,
            ix.indkey,
            ix.indnkeyatts
        FROM pg_index ix
        JOIN pg_class t     ON t.oid = ix.indrelid
        JOIN pg_class i     ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND ix.indisunique
          AND NOT ix.indisprimary
          AND ix.indpred IS NULL
          AND ix.indkey::text !~ '(^| )0( |$)'
          AND pg_get_indexdef(ix.indexrelid) NOT ILIKE '%tenant_id%'
          AND t.relname <> ALL (v_skip_tables)
          AND EXISTS (
                SELECT 1 FROM pg_attribute at
                WHERE at.attrelid = t.oid
                  AND at.attname  = 'tenant_id'
                  AND at.attnotnull
          )
        ORDER BY t.relname, i.relname
    LOOP
        -- 每个索引一个子事务：单条失败只跳过它，不让整批回滚。
        -- 失败时若新索引已建好会一并收回，保证脚本可以反复重跑。
        v_created := FALSE;
        BEGIN
        -- 索引键列的 attnum 数组（按索引内顺序；排除 INCLUDE 附带列）
        -- 注意 pg_index.indkey 的类型是 int2vector，不是数组，不能直接跟
        -- pg_constraint.confkey（smallint[]）比较，必须先转成 int2[]。
        SELECT array_agg(k.attnum ORDER BY k.ord)
        INTO v_key_nums
        FROM unnest(string_to_array(idx_item.indkey::text, ' ')::int2[])
             WITH ORDINALITY AS k(attnum, ord)
        WHERE k.ord <= idx_item.indnkeyatts;

        -- 索引列名（按索引内顺序）
        SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
        INTO v_cols
        FROM unnest(v_key_nums) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = idx_item.indrelid AND a.attnum = k.attnum;

        IF v_cols IS NULL OR v_cols = '' THEN
            RAISE WARNING '[skip] %.% 无法解析索引列', idx_item.table_name, idx_item.index_name;
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        -- a) 被外键引用的唯一键一律跳过。
        --    Postgres 的 DROP CONSTRAINT 遇到 FK 依赖会直接报
        --      2BP01: cannot drop constraint ... because other objects depend on it
        --    （deploy_48 第一次执行就栽在这里）。
        --    先建新索引也没用：FK 要求被引用的列集合上存在一个「列集合恰好相等」的
        --    唯一索引，(tenant_id, code) 不等于 (code)，旧的照样卸不掉。
        --    这类键只能人工处理：先删 FK -> 改索引 -> 重建 FK，或者干脆接受它全表唯一。
        --
        --    判断方式用 pg_depend 而不是猜：FK 真正依赖的对象是**索引**（2BP01 的报错
        --    详情就是 "constraint xxx depends on index yyy"），记录是
        --      classid=pg_constraint(被依赖方是 FK 约束), refclassid=pg_class, refobjid=索引oid
        --    第二条件是兜底：PG 允许被引用的列只是索引键列的一个子集，那种情况下
        --    DROP 同样会失败，靠 confkey <@ 键列数组一并拦下来。
        IF EXISTS (
            SELECT 1
            FROM pg_depend d
            JOIN pg_constraint fk ON fk.oid = d.objid AND fk.contype = 'f'
            WHERE d.classid    = 'pg_constraint'::regclass
              AND d.refclassid = 'pg_class'::regclass
              AND d.refobjid   = idx_item.indexrelid
        ) OR EXISTS (
            SELECT 1
            FROM pg_constraint fk
            WHERE fk.contype   = 'f'
              AND fk.confrelid = idx_item.indrelid
              AND fk.confkey   <@ v_key_nums     -- smallint[] <@ int2[]，同类型，不会有类型问题
        ) THEN
            RAISE WARNING '[skip] %.% 被外键引用，无法自动改造（需人工: 删FK->改索引->建FK）: (%)',
                idx_item.table_name, idx_item.index_name, v_cols;
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        -- b) 同租户内重复检测：加了 tenant_id 反而会撞的情况，必须先清洗数据
        EXECUTE format(
            'SELECT count(*) FROM (SELECT 1 FROM public.%I '
            'WHERE tenant_id IS NOT NULL GROUP BY tenant_id, %s HAVING count(*) > 1) x',
            idx_item.table_name, v_cols
        ) INTO v_dup;

        IF v_dup > 0 THEN
            RAISE WARNING '[skip] %.% 同租户内已有 % 组重复值，需先清洗: (%s)',
                idx_item.table_name, idx_item.index_name, v_dup, v_cols;
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        -- c) 新索引名：表名截断 + 列集合哈希，控制在 63 字符内且不撞名
        v_new_name := 'uq_' || left(idx_item.table_name, 24)
                      || '_t_' || substr(md5(idx_item.table_name || v_cols), 1, 10);

        -- d) 先建新的。名字已存在说明上次跑到这里断过，直接复用，不重复建。
        IF EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = v_new_name
        ) THEN
            RAISE NOTICE '[reuse] %.% 新索引 % 已存在，直接复用',
                idx_item.table_name, idx_item.index_name, v_new_name;
        ELSE
            EXECUTE format(
                'CREATE UNIQUE INDEX %I ON public.%I (tenant_id, %s)',
                v_new_name, idx_item.table_name, v_cols
            );
            v_created := TRUE;
        END IF;

        -- e) 再删旧的：唯一约束要先 DROP CONSTRAINT，纯索引才 DROP INDEX
        SELECT c.conname INTO v_conname
        FROM pg_constraint c
        WHERE c.contype = 'u'
          AND c.conrelid = idx_item.indrelid
          AND c.conindid = idx_item.indexrelid;

        IF v_conname IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE public.%I DROP CONSTRAINT %I',
                idx_item.table_name, v_conname
            );
        ELSE
            EXECUTE format('DROP INDEX public.%I', idx_item.index_name);
        END IF;

        v_done := v_done + 1;
        RAISE NOTICE '[ok] %.% -> UNIQUE (tenant_id, %)',
            idx_item.table_name, idx_item.index_name, v_cols;

        EXCEPTION WHEN OTHERS THEN
            -- 收回本次新建的索引，避免留下「新旧并存」的半改状态
            IF v_created THEN
                BEGIN
                    EXECUTE format('DROP INDEX IF EXISTS public.%I', v_new_name);
                EXCEPTION WHEN OTHERS THEN NULL;   -- 兜底失败也别再抛
                END;
            END IF;
            v_skipped := v_skipped + 1;
            RAISE WARNING '[skip] %.% 处理失败，已跳过并回滚该条: % (SQLSTATE %)',
                idx_item.table_name, idx_item.index_name, SQLERRM, SQLSTATE;
        END;
    END LOOP;

    RAISE NOTICE '=== 改造完成：成功 % 个，跳过 % 个 ===', v_done, v_skipped;
END $$;


-- ============================================================================
-- 3. 自检：改造后仍跨租户唯一的键（正常情况下应为空）
-- ============================================================================
DO $$
DECLARE
    idx_item RECORD;
    v_left   INTEGER := 0;
    -- 与第 2 节保持同一份跳过名单（理由见第 2 节注释）
    v_skip_tables TEXT[] := ARRAY['erp_inventory_s_539dcf81_b'];
BEGIN
    RAISE NOTICE '--- 改造后仍跨租户唯一的键 ---';
    FOR idx_item IN
        SELECT
            t.relname                      AS table_name,
            i.relname                      AS index_name,
            pg_get_indexdef(ix.indexrelid) AS definition
        FROM pg_index ix
        JOIN pg_class t     ON t.oid = ix.indrelid
        JOIN pg_class i     ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND ix.indisunique
          AND NOT ix.indisprimary
          AND ix.indpred IS NULL
          AND ix.indkey::text !~ '(^| )0( |$)'
          AND pg_get_indexdef(ix.indexrelid) NOT ILIKE '%tenant_id%'
          AND t.relname <> ALL (v_skip_tables)
          AND EXISTS (
                SELECT 1 FROM pg_attribute at
                WHERE at.attrelid = t.oid
                  AND at.attname  = 'tenant_id'
                  AND at.attnotnull
          )
        ORDER BY t.relname, i.relname
    LOOP
        v_left := v_left + 1;
        RAISE NOTICE '仍需处理 | % | % | %',
            idx_item.table_name, idx_item.index_name, idx_item.definition;
    END LOOP;

    IF v_left = 0 THEN
        RAISE NOTICE '--- 全部业务唯一键已分租户 ---';
    ELSE
        RAISE WARNING '--- 仍有 % 个跨租户唯一键，见上面的 WARNING ---', v_left;
    END IF;
END $$;

-- 索引变化不影响 PostgREST 的表结构缓存，但保险起见刷一次，
-- 避免旧的 schema cache 里还记着已被 DROP 的约束名。
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- ROLLBACK 说明
-- -------------
-- 本脚本没有自动回滚段：被 DROP 的旧唯一约束名是数据库按
--   <表名>_<列名>_key 规则自动生成的，重建只需照抄第 1 节 NOTICE 里的 definition：
--
--   ALTER TABLE public.<表名> ADD CONSTRAINT <约束名> UNIQUE (<列>);
--
-- 第 1 节干跑时那份 NOTICE 清单就是回滚清单，执行前先存一份。
--
-- 已知副作用
-- ----------
-- 1) 基于这些列的 upsert(onConflict) 会失效：PostgREST 现在能匹配到
--    (tenant_id, code) 而不是 (code)。前端已核查，erp_* 表没有用到 onConflict，
--    唯一受影响的是 sys_forms（deploy_48 里已改成先查后写）。
-- 2) 跨租户可以重名了 —— 这是本脚本的目的。如果某个编码业务上本就该全局唯一
--    （目前没有这种情况），需要单独保留全表唯一。
-- 3) 软删除（is_deleted='y'）的行仍占着唯一值：删掉再建同名照样冲突。
--    这是改造前就存在的行为，本脚本没有改变它。
-- ============================================================================
