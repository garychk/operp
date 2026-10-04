# 订阅计费与收款通道设计方案

> 落地 `saas-transformation-assessment.md` 第 6 项（套餐 / 订阅 / 配额 / 计费）。
> 目标客户：**国内中小企业**。收款通道按此前提设计。
> 状态：**待评审**，评审通过后 DDL 落为 `supabase/tables/deploy_54_subscription.sql`。

---

## 0. 一句话结论

订阅状态机、到期闸门、计费逻辑是**自己的资产**，跟用哪家收钱是解耦的两件事。
先把状态机和闸门做出来（不依赖任何支付渠道就能跑通全流程），通道选好后再插上去。

真正的拦路虎不是代码，是收款通道——尤其是"自动续费"。见第 1 节。

---

## 1. 收款通道方案

### 1.1 先说结论：本期不做自动续费

国内两大渠道的**周期扣款 / 免密代扣**门槛已经高到不适合中小起步项目（截至 2026-09 的规则）：

| 渠道 | 产品 | 主体要求 | 其他硬门槛 |
|---|---|---|---|
| 微信支付 | 委托代扣（自动续费） | **仅企业 / 政府 / 事业单位 / 社会组织**，个体工商户已明确排除 | 近 4 周去重支付用户 ≥300（或 ≥20）；新主体结算周期 T+14；模板另需升级投诉率 ≤0.1% |
| 支付宝 | 周期扣款 / 商家扣款 | 实名认证企业账号，个体工商户不支持 | 注册资本 ≥100 万 ~ 2000 万（产品口径不一）；账号注册满 1 年；近半年月均主动支付用户 ≥300 |
| 两者 | 个人主体 | **连普通支付都难开**，免密支付完全不可申请 | — |

结论：**想要真·自动续费，必须有公司主体，而且光有公司还不够。**

### 1.2 采用：主动续费（推荐起步）

只需要**普通支付**产品，门槛低、几天可开、合规干净：

- 微信支付 **Native 扫码支付**（PC 端扫二维码）
- 支付宝 **当面付 / 电脑网站支付**
- 主体：个体工商户即可（后续升级公司主体无成本）
- 费率：约 0.6%

用户路径：点「续费」→ 生成订单 → 扫码付款 → 回调开通 → 到期前提醒 → 手动再续。

**为什么这对 ERP 反而是更合理的形态：**

- 企业客户本来就要走报销、要发票、要采购审批，自动扣款容易引发争议和退款
- 年付几千块的 B2B 产品，一年提醒一次手动续，流失率远低于 C 端订阅
- 微信代扣的 T+14 结算周期对小团队现金流不友好

### 1.3 大客户对公转账（半自动）

ERP 客户但凡有规模，一定会问"能不能开发票、能不能走对公"。所以这条路必须配：

```
客户申请续费 → 选择"对公转账" → 展示收款账户与订单号
→ 客户转账并上传凭证 → 后台（超管）核对到账 → 人工确认开通
```

零通道成本，也是国内 B2B 软件最主流的收法。需要在订单表里支持 `channel = 'manual'`。

### 1.4 通道抽象层

不要让渠道 SDK 渗进业务代码。定义统一接口，本期实现 `mock` + `wxpay_native`，后续加渠道不动业务：

```ts
interface PaymentProvider {
  readonly channel: string;
  createOrder(input: CreateOrderInput): Promise<{ payUrl: string; qrCode?: string }>;
  verifyNotify(rawBody: string, headers: Record<string, string>): Promise<NotifyPayload>;
  queryOrder(orderNo: string): Promise<{ paid: boolean; tradeNo?: string }>;
}
```

`mock` 通道存在的意义：**让状态机、闸门、回调、前端在没有任何支付资质时就能完整联调。**

### 1.5 不碰的东西

⚠️ **不要用 PayJS / 虎皮椒 / XorPay 等第四方聚合支付。**
门槛确实低，但资金先落第三方账户再结算给你，属于监管口径的"二清"，平台随时可能关停或跑路。
作为备用通道都不建议。

### 1.6 将来升级自动续费的前置条件

当同时满足：公司主体 + 注册资本达标 + 近 4 周去重付费用户 ≥300 + 投诉率达标，
再申请微信委托代扣权限。此时只需在 `sys_tenant_subscriptions` 上加 `auto_renew`、`contract_id` 两列，
并把定时任务从"发提醒"改成"发起扣款"——**业务代码不用改**。

---

## 2. 数据模型

四张新表 + `sys_tenants` 两列冗余。隔离语义按项目既有三套规则归类：

| 表 | 隔离语义 | tenant_id | 理由 |
|---|---|---|---|
| `sys_sub_plans` | **平台基线共享** | 可空 | 套餐是平台元数据，所有租户可见（deploy_48 语义） |
| `sys_tenant_subscriptions` | **fail-closed** | NOT NULL | 租户私有数据 |
| `sys_sub_orders` | **fail-closed** | NOT NULL | 租户私有数据 |
| `sys_sub_payment_events` | 仅 service_role | NOT NULL | 回调幂等日志，前端不需要读 |

### 2.1 sys_sub_plans（套餐）

```sql
CREATE TABLE IF NOT EXISTS public.sys_sub_plans (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT,                      -- NULL = 平台基线
    plan_code        VARCHAR(64)  NOT NULL,
    plan_name        VARCHAR(200) NOT NULL,
    billing_cycle    VARCHAR(16)  NOT NULL DEFAULT 'monthly',  -- monthly/quarterly/yearly
    price_cents      BIGINT       NOT NULL DEFAULT 0,          -- 用分，杜绝浮点
    currency         CHAR(3)      NOT NULL DEFAULT 'CNY',
    trial_days       INT          NOT NULL DEFAULT 14,
    max_users        INT,                         -- NULL = 不限
    max_docs_monthly INT,                         -- NULL = 不限（本期仅记录，不做拦截）
    features         JSONB        NOT NULL DEFAULT '{}',
    sort_order       INT          NOT NULL DEFAULT 0,
    status           CHAR(1)      NOT NULL DEFAULT '1',
    is_deleted       CHAR(1)      NOT NULL DEFAULT 'n',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 平台基线表：两条部分索引（Postgres UNIQUE 对 NULL 不去重，不能只建 (tenant_id, code)）
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_plans_code_base
    ON public.sys_sub_plans (plan_code) WHERE tenant_id IS NULL AND is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_plans_code_tenant
    ON public.sys_sub_plans (tenant_id, plan_code) WHERE tenant_id IS NOT NULL AND is_deleted = 'n';
```

### 2.2 sys_tenant_subscriptions（租户订阅）

```sql
CREATE TABLE IF NOT EXISTS public.sys_tenant_subscriptions (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            BIGINT NOT NULL,
    plan_id              BIGINT,
    status               VARCHAR(24) NOT NULL DEFAULT 'trialing',
        -- trialing | active | past_due | suspended | canceled
    trial_started_at     TIMESTAMPTZ,
    trial_ends_at        TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end   TIMESTAMPTZ,
    grace_ends_at        TIMESTAMPTZ,     -- 宽限期终点，超过即 suspended
    canceled_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_subscription
    ON public.sys_tenant_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_subs_status
    ON public.sys_tenant_subscriptions (status, current_period_end);
```

一个租户一条当前订阅（`UNIQUE(tenant_id)`），历史通过 `sys_sub_orders` 追溯。

### 2.3 sys_sub_orders（订单）

```sql
CREATE TABLE IF NOT EXISTS public.sys_sub_orders (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT NOT NULL,
    order_no         VARCHAR(64)  NOT NULL,        -- 我方订单号，给渠道
    plan_id          BIGINT,
    period_months    INT          NOT NULL DEFAULT 12,
    amount_cents     BIGINT       NOT NULL,
    currency         CHAR(3)      NOT NULL DEFAULT 'CNY',
    channel          VARCHAR(32)  NOT NULL,        -- wxpay_native / alipay / manual / mock
    channel_trade_no VARCHAR(128),                 -- 渠道流水号
    status           VARCHAR(24)  NOT NULL DEFAULT 'pending',
        -- pending | paid | failed | refunded | closed
    pay_url          TEXT,                         -- 二维码内容 / 收银台链接
    paid_at          TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,                  -- 订单超时关闭
    remark           TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_orders_no   ON public.sys_sub_orders (order_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_orders_chan ON public.sys_sub_orders (channel, channel_trade_no)
    WHERE channel_trade_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sub_orders_tenant ON public.sys_sub_orders (tenant_id, created_at DESC);
```

### 2.4 sys_sub_payment_events（回调幂等）

```sql
CREATE TABLE IF NOT EXISTS public.sys_sub_payment_events (
    id             BIGSERIAL PRIMARY KEY,
    event_key      VARCHAR(160) NOT NULL,   -- channel + ':' + channel_trade_no
    tenant_id      BIGINT,
    order_id       BIGINT,
    channel        VARCHAR(32)  NOT NULL,
    payload        JSONB,
    process_result TEXT,
    processed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_payment_events ON public.sys_sub_payment_events (event_key);
```

### 2.5 sys_tenants 冗余列（性能关键）

```sql
ALTER TABLE public.sys_tenants
    ADD COLUMN IF NOT EXISTS sub_status      VARCHAR(24)  NOT NULL DEFAULT 'trialing',
    ADD COLUMN IF NOT EXISTS sub_paid_until  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sub_grace_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sys_tenants_sub_status ON public.sys_tenants (sub_status);
```

**为什么冗余：** `current_tenant_writable()` 会在每一条 erp 表的写操作上执行（236 条策略）。
如果它每次去 join `sys_tenant_subscriptions`，写性能会崩。冗余两列到 `sys_tenants` 后，
函数只需一次带索引的单表点查。冗余列由支付回调和定时任务统一更新，订阅表仍是权威源。

---

## 3. 状态机

```
trialing ──付费──▶ active ──到期未付──▶ past_due ──宽限结束──▶ suspended
    │                                        │                     │
    └────试用到期未付────────────────────────┘                     │
                                                                   │
                            active ◀────────── 补缴恢复 ───────────┘
```

| 状态 | 含义 | 可写 erp_* | 说明 |
|---|---|---|---|
| `trialing` | 试用中 | ✅ | 默认 14 天，注册即进入 |
| `active` | 已付费 | ✅ | 全功能 |
| `past_due` | 宽限期 | ✅ | 默认 7 天，界面持续催付，不建议停写（避免误伤正在走审批的客户） |
| `suspended` | 只读冻结 | ❌ | **仅停写，读与导出始终放行** |
| `canceled` | 已注销 | ❌ | 终态，需人工恢复 |

**关键取舍：`suspended` 只停写不停读。** 企业客户的数据是他的资产，
到期就禁止写入、保留读取和导出就够了，**永远不要自动删除**（见第 8 节）。

---

## 4. 强制点设计（gating）

### 4.1 为什么不能只做前端

系统是 SPA 直连 Supabase，登录用户拿到自己的 token 后可以完全绕过 React 路由和按钮禁用，
直接调 PostgREST 写 `erp_*` 表。**前端拦截只是体验，服务端才是权威。**

三层必须同时存在：

| 层 | 作用 | 能否被绕过 |
|---|---|---|
| RLS 写策略（erp_* 表） | **真正的闸门** | 不能 |
| ai-server 中间件 | 补 service_role 的洞 | 不能 |
| 前端（横幅 + 禁用 + 路由守卫） | 体验与告知 | 能，所以不能单独依赖 |

### 4.2 RLS 改造：改 `install_role_table_rls()`

现有实现（`deploy_41_tenant_isolation.sql:219`）为每张 erp 表生成四条 permissive 策略，
谓词形如：

```
(public.current_user_is_super_admin() OR tenant_id = public.current_tenant_id())
AND public.has_table_permission('表名', 'insert')
```

改造：**只在 INSERT / UPDATE / DELETE 谓词尾部追加写权限谓词，SELECT 谓词不动。**

```sql
-- deploy_41 install_role_table_rls() 内，约 258-265 行
insert_predicate := format(
    '(%s AND public.has_table_permission(%L, %L) AND public.current_tenant_writable())',
    tenant_predicate, target_table_name, 'insert');
update_predicate := format(   -- 同构
    '(%s AND public.has_table_permission(%L, %L) AND public.current_tenant_writable())',
    tenant_predicate, target_table_name, 'update');
delete_predicate := format(   -- 同构
    '(%s AND public.has_table_permission(%L, %L) AND public.current_tenant_writable())',
    tenant_predicate, target_table_name, 'delete');
-- select_predicate 保持原样，不动
```

改完后按 deploy_41 的方式**重跑全表循环**一次，即可重建 236 条策略。
（策略里存的是表达式文本，所以将来调整 `current_tenant_writable()` 内部逻辑无需重刷策略。）

### 4.3 current_tenant_writable()

```sql
CREATE OR REPLACE FUNCTION public.current_tenant_writable()
RETURNS BOOLEAN
LANGUAGE sql
STABLE                      -- 必须，否则每行重算
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        -- 超管豁免：运维需要跨租户可写，不能因为订阅逻辑锁死自己
        public.current_user_is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.sys_tenants t
            WHERE t.id = public.current_tenant_id()
              AND t.is_deleted = 'n'
              AND t.status = '1'
              AND t.sub_status IN ('trialing', 'active', 'past_due')
        );
$$;
```

三个注意点：

1. **必须标 `STABLE`**——否则每行重算一次。
2. **超管豁免必须写在函数内部**，不能指望外层 `tenant_predicate` 的 super_admin 分支，
   因为写权限谓词是独立 AND 上去的。
3. **`current_user_is_super_admin()` 本身要带 `r.tenant_id IS NULL` 判断**（项目既有约定），
   否则租户复制出的本地 super_admin 是一条提权绕过路径。

### 4.4 ai-server 侧校验（补 service_role 的洞）

ai-server 用 service_role 连库，**完全绕过 RLS**（项目既有事实）。
所以 `/api/ai/chat` 的建单工具链路必须在入口加一道：

```ts
// ai-server/src/config/tenantContext.ts 同层，新增 subscriptionGate.ts
export async function assertTenantWritable(tenantId: number): Promise<void> {
  const { data } = await admin
    .from('sys_tenants')
    .select('sub_status, is_deleted, status')
    .eq('id', tenantId)
    .maybeSingle();

  if (!data || data.is_deleted === 'y' || data.status !== '1'
      || !['trialing', 'active', 'past_due'].includes(data.sub_status)) {
    throw new SubscriptionRequiredError('订阅已过期，请续费后继续操作');
  }
}
```

**所有写类 AI 工具调用前必须过这一道**，否则过期租户用对话照样能写数据进库。

### 4.5 前端体验层（不可单独依赖）

- 全局到期横幅：按 `sub_paid_until` 计算剩余天数，T-14/T-7/T-3/T-1 分级提示
- `suspended` 时：表单禁用 + 保存按钮拦截 + 顶部红色提示条 + 续费引导
- 路由守卫：`suspended` 时禁止进入新建/编辑页（纯体验，被绕过也无害因为 RLS 已拦）

---

## 5. 支付回调设计

### 5.1 时序

```
前端                    ai-server                     渠道
  │  POST /billing/orders              │                │
  │ ─────────────────────────────────► │  下单          │
  │                                    │ ─────────────► │
  │                                    │ ◄───────────── │  code_url / qr_code
  │  ◄───────────────────────────────── │                │
  │  （展示二维码，轮询订单状态）        │                │
  │                                    │                │
  │         用户扫码支付                │                │
  │ ──────────────────────────────────────────────────► │
  │                                    │  异步 notify   │
  │                                    │ ◄───────────── │
  │                                    │ 验签 → 幂等 →  │
  │                                    │ 更新订单/订阅/ │
  │                                    │ 冗余列         │
  │  轮询到 paid                       │                │
  │ ◄─────────────────────────────────  │                │
```

### 5.2 回调处理四步（顺序不能变）

1. **验签**——用渠道公钥/APIv3 密钥校验，失败直接 4xx，不写库。
2. **幂等**——`INSERT ... ON CONFLICT (event_key) DO NOTHING RETURNING id`。
   拿不到 id 说明已处理过，直接返回成功（渠道会重发，必须幂等）。
3. **校验金额**——回调金额必须等于订单金额，不相等记异常并告警，不发放权益。
4. **更新**——订单置 `paid` → 延长 `current_period_end` → 状态回 `active`
   → 同步 `sys_tenants.sub_status / sub_paid_until`。3、4 必须在同一事务。

### 5.3 前端不要直连渠道

前端只轮询 `GET /api/billing/orders/:order_no/status`（ai-server 侧查库，必要时反查渠道）。
这样渠道密钥只存在于服务端，也避免前端伪造支付成功。

---

## 6. 定时任务

| 频率 | 任务 | 动作 |
|---|---|---|
| 每小时 | 试用到期扫描 | `trialing AND trial_ends_at < now()` → `past_due`，`grace_ends_at = now() + 7d` |
| 每小时 | 订阅到期扫描 | `active AND current_period_end < now()` → `past_due` |
| 每小时 | 宽限结束扫描 | `past_due AND grace_ends_at < now()` → `suspended` |
| 每日 | 催付提醒 | `past_due` 租户发站内信 + 邮件（T-7 / T-3 / T-1 / T+3） |
| 每日 | 订单超时关闭 | `pending AND expires_at < now()` → `closed` |
| （未来） | 自动续费扣款 | `auto_renew AND current_period_end - 1d < now()` → 发起代扣 |

**所有状态流转后必须同步 `sys_tenants` 冗余列**，否则 RLS 闸门读到的还是旧状态。

实现选择：优先 **pg_cron**（数据库侧，与应用解耦，ai-server 重启不影响）；
无 pg_cron 时用 ai-server 常驻进程内的 node-cron，但要注意开发态 `tsx watch` 会重复注册。

---

## 7. 前端改造清单

| 模块 | 内容 |
|---|---|
| 定价页 `/pricing` | 套餐卡片、周期切换、立即试用 |
| 租户设置 → 订阅与账单 | 当前套餐、到期日、剩余天数、续费按钮、订单历史 |
| 全局到期横幅 | 按剩余天数分级提示，可关闭但每日重现 |
| 只读模式 | 表单禁用 + 保存拦截 + 提示条 |
| 路由守卫 | suspended 拦截编辑页（体验层） |
| 注册流程改造 | 选套餐 → `bootstrap_tenant()` → 自动进入 `trialing` |
| 续费弹窗 | 展示二维码、轮询支付结果、支付成功刷新订阅状态 |

注册流程衔接点：`bootstrap_tenant()`（`deploy_50`）成功后插入一条
`sys_tenant_subscriptions(status='trialing', trial_ends_at = now() + plan.trial_days)`，
并同步 `sys_tenants.sub_status = 'trialing'`。

---

## 8. 防薅与数据保留

### 8.1 试用期防薅

只卡天数的试用期会被无限注册白嫖。至少做三层：

1. **身份校验**：手机号短信验证 / 邮箱验证（Supabase Auth 原生支持）
2. **主体去重**：同一手机号、企业名称、统一社会信用代码只允许一次试用
3. **配额限制**：试用期给单据量上限（如 200 张），超出则引导付费
   ——比卡天数更抗薅，因为薅的成本从"注册"变成"真实使用"

### 8.2 数据保留红线

- `suspended` **只停写，不停读**，导出功能始终可用
- **绝不自动删除租户数据**，哪怕是长期欠费
- 长期欠费的处理方式是归档（迁移到冷存储），且需人工二次确认
- 理由：企业客户的数据是他的资产，删数据既有商业信誉风险也有法律风险

---

## 9. 实施计划

| 阶段 | 内容 | 依赖 | 可独立交付 |
|---|---|---|---|
| 0 | 主体与支付通道申请（个体工商户 + 微信/支付宝普通支付） | 无 | ✅ 可与开发并行 |
| 1 | 数据模型 `deploy_54_subscription.sql` + 状态机 | 无 | ✅ |
| 2 | RLS 闸门 + ai-server 校验中间件 | 阶段 1 | ✅ |
| 3 | 订单与回调（先用 `mock` 通道打通全链路） | 阶段 1 | ✅ |
| 4 | 定时任务 | 阶段 1 | ✅ |
| 5 | 前端（定价页、账单页、横幅、只读模式） | 阶段 1 | ✅ |
| 6 | 接入真实渠道（替换 mock） | 阶段 0 + 3 | — |

**阶段 0 与阶段 1-5 完全并行**：没拿到支付资质也能把整套订阅逻辑做完并验证。

验收标准：用 `mock` 通道跑通
`注册 → 试用 14 天 → 到期进宽限 → 宽限结束冻结（写被 RLS 拒、读仍正常）→ 付费 → 恢复可写`。

---

## 10. 风险与遗留

| 项 | 说明 | 处理 |
|---|---|---|
| **配额计量** | `max_docs_monthly` 本期只记录不拦截 | 表结构已预留，后续加 `usage_records` |
| **发票** | 国内企业客户强需求，微信/支付宝不会帮你开 | 需独立电子发票能力，单独立项 |
| **多租户路由** | 子域名 vs 统一域名未定（assessment 第 8 项） | 影响定价页 URL 与试用入口，建议先定 |
| **构建期配置注入** | `Dockerfile` 把 env 烧进 bundle（assessment 第 7 项） | 多租户部署前需改运行时注入 |
| **国内发票 vs 境外 MoR** | 若将来有海外客户，MoR 开的是境外发票，国内企业无法入账 | 双通道需分开报价与开票 |
| **ai-server 开发态** | `tsx watch` 下定时任务会重复注册 | 用 pg_cron 规避 |
