-- ============================================================================
-- deploy_55_mcp_api_keys.sql — MCP 服务凭据（API Key）表
--
-- 背景：MCP 服务（ai-server/src/mcp/）原本靠 .env 里的 MCP_API_KEYS 静态映射表
--       把「凭据 → sys_users.id」绑起来。这套机制能用，但有四个硬伤：
--         1. 无自助 —— 加一个人要手工改 .env、还要懂格式
--         2. 需重启 —— auth.ts 的 credentialCache 是进程内缓存，改完必须重启
--         3. 无吊销 —— 不能单独作废某把 Key，只能删行 + 重启
--         4. 无审计 —— 不知道哪把 Key 何时被谁用过
--       本表把凭据搬到数据库，上述四点一次解决。
--
-- 两个关键设计决策（都不是随手选的）：
--
--   A. 只存 SHA-256 摘要，不存明文。
--      Key 本体是 192 位随机数，不存在字典或彩虹表攻击的空间，
--      所以用不加盐的 SHA-256 就足够 —— 加盐反而会让「按 hash 等值查找」失效，
--      退化成全表扫描逐行比对。
--      代价：生成后必须当次复制走，之后谁也拿不回原文（包括管理员）。
--
--   B. 不走 has_table_permission() 的双层授权模型，只用 user_id 做行级隔离。
--      项目里业务表（erp_* / sys_logs 等）是「表级宽授权 + RESTRICTIVE 租户策略 +
--      PERMISSIVE 角色策略」三层，新增表要补「基线 super_admin 授权」再重跑
--      clone_platform_baseline_to_tenant() 补各租户副本，漏一步前端就整表不可见。
--      API Key 是**个人自服务资源**（纯私有、与角色无关），由角色权限系统托管
--      既无意义也徒增漏授权的风险。因此这里只保留「自己的 Key 自己看得见」这一条，
--      语义更窄、更明确。
--
-- 依赖：deploy_01（sys_users）、deploy_41（current_tenant_id / tenant_scope 系列）
--
-- 执行方式（建议先干跑）：
--   BEGIN;  ... 本文件 ...  ROLLBACK;   -- 看 NOTICE
--   BEGIN;  ... 本文件 ...  COMMIT;     -- 确认后落地
-- ============================================================================


-- ============================================================================
-- 1. 建表
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sys_mcp_api_keys (
    id           BIGSERIAL   PRIMARY KEY,

    -- 归属用户。DEFAULT 让数据库自己从 JWT 反查，前端无需也不应显式传值；
    -- 即使传了，下面 RLS 的 WITH CHECK 也会拦住「替别人写」。
    user_id      INTEGER     NOT NULL DEFAULT public.current_sys_user_id(),

    -- 冗余租户，便于超管排查「某租户下发了哪些 Key」。不参与隔离判定。
    tenant_id    BIGINT      DEFAULT public.current_tenant_id(),

    -- 用途备注，让用户自己区分「家里的 Cursor」「公司 Claude」这类场景
    name         VARCHAR(100) NOT NULL DEFAULT '默认密钥',

    -- 展示用前缀（operp_ + hash 前 8 位），列表里靠它辨识，不含敏感信息
    key_prefix   VARCHAR(24)  NOT NULL,

    -- SHA-256 十六进制摘要。唯一约束防止同一把 Key 被重复登记。
    key_hash     CHAR(64)     NOT NULL,

    -- 审计字段：MCP 服务端每次校验命中后异步回写
    last_used_at TIMESTAMPTZ,

    -- NULL = 永不过期。到期后 auth.ts 直接判为无效，不删除记录（保留审计痕迹）
    expires_at   TIMESTAMPTZ,

    -- 吊销时间。软删除，理由同上：谁在什么时候废掉哪把 Key 是有价值的记录
    revoked_at   TIMESTAMPTZ,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_deleted   CHAR(1)     NOT NULL DEFAULT 'n',

    CONSTRAINT chk_sys_mcp_api_keys_is_deleted CHECK (is_deleted IN ('y', 'n')),
    CONSTRAINT chk_sys_mcp_api_keys_hash_len   CHECK (char_length(key_hash) = 64),
    CONSTRAINT chk_sys_mcp_api_keys_prefix     CHECK (key_prefix LIKE 'operp\_%')
);

-- 用户记录硬删时才级联清 Key（项目里用户是软删，正常不会触发）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_sys_mcp_api_keys_user' AND conrelid = 'public.sys_mcp_api_keys'::regclass
    ) THEN
        ALTER TABLE public.sys_mcp_api_keys
            ADD CONSTRAINT fk_sys_mcp_api_keys_user
            FOREIGN KEY (user_id) REFERENCES public.sys_users (id) ON DELETE CASCADE;
        RAISE NOTICE 'sys_mcp_api_keys: 外键 fk_sys_mcp_api_keys_user 已建立';
    ELSE
        RAISE NOTICE 'sys_mcp_api_keys: 外键已存在，跳过';
    END IF;
END $$;

COMMENT ON TABLE  public.sys_mcp_api_keys            IS 'MCP 服务 API Key。只存 SHA-256 摘要，明文仅在生成时返回一次';
COMMENT ON COLUMN public.sys_mcp_api_keys.key_hash   IS 'SHA-256(key) 十六进制小写。校验时对出示的 Key 现算摘要再等值匹配';
COMMENT ON COLUMN public.sys_mcp_api_keys.key_prefix IS '展示用前缀（operp_ + hash 前 8 位），列表辨识用';
COMMENT ON COLUMN public.sys_mcp_api_keys.expires_at IS 'NULL 表示永不过期；到期即失效但保留记录';
COMMENT ON COLUMN public.sys_mcp_api_keys.revoked_at IS '吊销时间，软删除。非空即失效';


-- ============================================================================
-- 2. 索引
-- ============================================================================

-- 认证热路径：每次 MCP 会话启动都用 key_hash 精确查一行
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_mcp_api_keys_hash
    ON public.sys_mcp_api_keys (key_hash);

-- 「我的密钥」列表页：WHERE user_id = ? AND is_deleted = 'n' ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_sys_mcp_api_keys_user
    ON public.sys_mcp_api_keys (user_id, created_at DESC)
    WHERE is_deleted = 'n';


-- ============================================================================
-- 3. 行级安全
--
--    只有一条 PERMISSIVE 策略，且只对 authenticated 生效：
--      - 未登录（anon）没有任何策略匹配 → 默认拒绝，看不到也写不进
--      - 已登录用户只能读写 user_id = 自己 的行
--      - service_role 绕过 RLS（MCP 服务端用的就是它），能校验任意用户的 Key
--
--    USING 管「能看到/能改哪些行」，WITH CHECK 管「能写成什么样」。
--    后者是防伪造的关键：没有它，用户可以把 user_id 填成别人的 id 来插一行。
-- ============================================================================

ALTER TABLE public.sys_mcp_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_own_mcp_api_keys ON public.sys_mcp_api_keys;
CREATE POLICY user_own_mcp_api_keys
ON public.sys_mcp_api_keys
FOR ALL
TO authenticated
USING (
    user_id = public.current_sys_user_id()
)
WITH CHECK (
    user_id = public.current_sys_user_id()
);

COMMENT ON POLICY user_own_mcp_api_keys ON public.sys_mcp_api_keys IS
    '个人自服务资源：每个用户只能读写自己的 API Key；service_role 绕过以支持 MCP 端校验';


-- ============================================================================
-- 4. 授权
--
--    刻意比项目里其他表更窄：
--      - 不授 anon           —— 匿名请求根本不该碰这张表
--      - 不授 DELETE         —— 用 revoked_at / is_deleted 软删，保住审计链
--      - UPDATE 走列级授权   —— 只允许改备注和吊销状态；
--                               key_hash 被改等于把 Key 指向别人的记录，必须堵死
--
--    ⚠️ 下面这行 REVOKE 不能省。
--    本库对 postgres 配了 ALTER DEFAULT PRIVILEGES，新表一创建就自动获得
--    arwdDxtm（含 UPDATE / DELETE / TRUNCATE）给 anon / authenticated / service_role。
--    PostgreSQL 里表级权限覆盖列级授权 —— 不先把表级 UPDATE 撤掉，
--    后面的列级 GRANT 只是「补充」，一点也收窄不了。
--    （实测：初版漏了这行 REVOKE，authenticated 用户仍能直接 UPDATE key_hash。）
--
--    service_role 故意保留全量权限：MCP 服务端要用它校验任意用户的 Key，
--    并回写 last_used_at。
-- ============================================================================

-- 先撤掉 DEFAULT PRIVILEGES 继承来的宽权限，否则下面的列级授权形同虚设
REVOKE ALL ON public.sys_mcp_api_keys FROM anon, authenticated;

GRANT SELECT, INSERT            ON public.sys_mcp_api_keys TO authenticated;
GRANT UPDATE (name, revoked_at, is_deleted)
                                ON public.sys_mcp_api_keys TO authenticated;
GRANT USAGE ON SEQUENCE public.sys_mcp_api_keys_id_seq TO authenticated;


-- ============================================================================
-- 5. 让 schema 缓存生效
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 6. 自检（单独跑，不要和上面混在一个事务里看结果）
-- ============================================================================

-- 6.1 策略是否生效
-- SELECT policyname, cmd, permissive, roles::text, qual
-- FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sys_mcp_api_keys';

-- 6.2 列级授权是否符合预期（应看到 UPDATE 只覆盖 name/revoked_at/is_deleted）
-- SELECT grantee, privilege_type, column_name
-- FROM information_schema.column_privileges
-- WHERE table_schema = 'public' AND table_name = 'sys_mcp_api_keys'
-- ORDER BY grantee, privilege_type, column_name;

-- 6.3 RLS 是否真的挡住了越权读（以某个真实用户身份模拟）
-- SET LOCAL role authenticated;
-- SET LOCAL request.jwt.claims = '{"sub":"<某个用户的 auth_id>"}';
-- SELECT * FROM public.sys_mcp_api_keys;   -- 应只返回该用户自己的行
-- RESET role;

-- 6.4 回滚
-- DROP TABLE IF EXISTS public.sys_mcp_api_keys;
-- NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 已知边界（不是 bug，但要知道）
-- ============================================================================
-- 1. Key 明文不可找回。用户丢了只能吊销重发，没有「查看原文」这种操作。
-- 2. 授权撤销不即时：客户端里已装好的 Key 只要没被吊销/过期就持续可用，
--    用户离职或转岗时需要管理员主动吊销，这张表提供入口但不主动联动 sys_users.status。
-- 3. 表里没有「谁吊销的」字段。用户只能吊销自己的 Key，归属已由 user_id 确定，
--    要区分「本人吊销」还是「超管吊销」需另加 operated_by 列。
-- 4. 频率不限：last_used_at 每次命中都会回写，高频调用下会产生额外的写放大。
--    当前工具集是只读低频场景，暂不引入节流；若将来出现写入类工具需重新评估。
