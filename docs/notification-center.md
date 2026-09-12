# 统一消息通知中心说明

> 本文梳理 OPERP 消息通知中心的完整实现：数据库侧（`supabase/tables/deploy_31_notifications.sql`）与前端侧（`src/components/NotificationBell.tsx`）。覆盖审批待办/审批结果、库存预警、订单延期预警、MRP 任务完成四类通知。

## 1. 架构总览

核心思路是**通知模型与通知来源解耦**：所有来源（触发器、定时扫描、未来的 AI 调用）统一通过 `notify_push()` 写入同一张 `sys_notifications` 表，前端只订阅这一张表。新增通知类型时只加"生产者"，中枢与前端不动。

```text
审批流推进                    pg_cron 定时扫描                MRP 状态变更
wf_process_instances          check_inventory_warnings()      erp_mrp_plans
      │                             │                            │
      ▼                             ▼                            ▼
wf_notify_on_instance_change  check_order_delay_warnings()  mrp_notify_on_status_change
      │                             │                            │
      └─────────────────────────────┼─────────────────────────────┘
                                    ▼
                       notify_push()（统一入口 RPC）
                       ├─ 解析收件人：user_id 数组 + 角色码
                       ├─ 角色无用户时降级 super_admin
                       ├─ dedup_key 按收件人 24h 去重
                       └─ 写入 sys_notifications（带 link_path）
                                    │
                                    ▼
                       Supabase Realtime（publication 已包含该表）
                                    │  INSERT 事件，filter recipient_user_id=当前用户
                                    ▼
                       前端 NotificationBell（ProLayout 头部）
                       ├─ 未读数 Badge
                       ├─ 右下角即时提示
                       ├─ 弹层列表（按类型 Tab、严重度着色）
                       └─ 点击跳转单据页 / 标记已读
```

不引入任何新后端服务：触发器与扫描函数全部在 Postgres 内完成，实时推送复用 Supabase Realtime。

## 2. 数据库对象（deploy_31_notifications.sql）

### 2.1 sys_notifications 表

| 字段 | 类型 | 说明 |
|---|---|---|
| `recipient_user_id` | INTEGER NOT NULL | 收件人（`sys_users.id`） |
| `recipient_role_code` | VARCHAR(100) | 派发时依据的角色码（点对点通知为 NULL），供后续做角色订阅配置 |
| `notification_type` | VARCHAR(50) | 通知类型：`approval_pending` / `approval_result` / `inventory_warning` / `order_delay` / `task_completed` |
| `severity` | VARCHAR(20) | 严重度：`info` / `warning` / `critical` |
| `title` / `content` | VARCHAR(200) / TEXT | 标题与正文 |
| `source_type` | VARCHAR(50) | 来源单据类型（`purchase_order`、`product`、`mrp_plan` 等） |
| `source_id` / `source_no` | INTEGER / VARCHAR(100) | 来源单据 ID 与单号 |
| `link_path` | VARCHAR(255) | 前端跳转路径，由 `notify_link_path()` 自动映射 |
| `dedup_key` | VARCHAR(200) | 去重键（实际存储为 `dedup_key:收件人ID`） |
| `is_read` / `read_at` | BOOLEAN / TIMESTAMPTZ | 已读状态与时间 |

索引：`(recipient_user_id, is_read, created_at DESC)` 供未读数与列表查询；`(dedup_key, created_at)` 供去重判断。

### 2.2 RLS 策略

- `authenticated` 仅有 `SELECT` + `UPDATE` 权限，**无 INSERT/DELETE**——通知只能经 `notify_push()` 产生。
- `SELECT`/`UPDATE` 策略均为 `recipient_user_id = current_sys_user_id()`（复用 deploy_02 的函数，按 `auth.uid() → sys_users.auth_id` 解析），用户只能看到和操作自己的通知。

### 2.3 notify_push() 统一入口

```text
notify_push(
  p_notification_type,   -- 必填
  p_severity,            -- 默认 'info'
  p_title, p_content,
  p_source_type, p_source_id, p_source_no, p_link_path,
  p_dedup_key,           -- 非空时启用去重
  p_recipient_user_ids,  -- INTEGER[]，点对点收件人
  p_recipient_role_code, -- 角色码，面向角色派发
  p_dedup_window_hours   -- 默认 24
) RETURNS INTEGER        -- 实际插入条数
```

关键行为：

1. **收件人双通道合并**：`p_recipient_user_ids` 与 `p_recipient_role_code` 可同时使用，取并集去重。
2. **角色解析**：按 `sys_user_roles → sys_roles(role_code) → sys_users(status='1')` 查角色下所有有效用户。
3. **降级兜底**：目标角色下无有效用户时，自动改派 `super_admin` 角色下用户（`super_admin` 本身无用户时不降级，返回 0）。
4. **防骚扰去重**：`p_dedup_key` 非空时，同一收件人在 `p_dedup_window_hours` 窗口内同 key 不重复插入（预警类每小时扫描不刷屏的关键）。
5. `SECURITY DEFINER`，触发器与外部服务（ai-server 持 service role）均可直接调用。

### 2.4 审批流触发器（trg_wf_notify）

挂载于 `wf_process_instances` 的 `AFTER INSERT OR UPDATE`，三个时点：

| 时点 | 条件 | 通知对象 | 类型/严重度 |
|---|---|---|---|
| 到达新审批节点 | `status='pending'` 且（INSERT 或 `current_node_id` 变化） | 节点审批人：`approver_mode='user'` 直发本人；`='role'` 发给角色下全部用户 | `approval_pending` / warning |
| 驳回/撤回 | `pending → draft` | 发起人 `started_by`（操作者本人除外） | `approval_result` / critical |
| 全部通过 | `pending → approved` | 发起人（操作者本人除外） | `approval_result` / info |

单据保存时 `workflow_upsert_instance` 创建 draft 实例（`current_node_id` 为 NULL），提交审批时 UPDATE 填入起始节点——`current_node_id IS DISTINCT FROM` 成立，触发器必然触发。通知在**同一事务内**写入，提交成功即通知落库，与前端按钮还是 AI 调 RPC 无关。

### 2.5 MRP 完成触发器（trg_mrp_notify）

挂载于 `erp_mrp_plans` 的 `AFTER UPDATE`：状态变为 `completed` 时，向 `mrp_manager` 角色推送 `task_completed` 通知（无该角色用户时自动降级 super_admin）。

> 注意：当前 `handleRunMrp` 仅将计划置为 `running`，尚无真正运算逻辑。将来无论运算落在 RPC、ai-server 还是 Edge Function，完成时把状态置为 `completed` 通知即自动生效，无需改通知侧代码。

### 2.6 预警扫描函数（pg_cron 调度）

| 函数 | 扫描逻辑 | 派发角色 | 去重 |
|---|---|---|---|
| `check_inventory_warnings()` | `erp_inventory` 现存量合计 vs `erp_products` 阈值：`< min_stock` → critical，`< safety_stock` → warning | `inventory_manager` | `inv-warn:产品ID:严重度`，24h |
| `check_order_delay_warnings()` | 采购：交期已过且收货 < 订购；销售：交期已过未完结。超 7 天升 critical | `inventory_manager` | `po-delay:订单ID` / `so-delay:订单ID`，24h |

调度（`cron.schedule`）：

- `erp-inventory-warning`：`15 8-18 * * *`（每天 8:15–18:15 每小时一次）
- `erp-order-delay`：`30 8 * * *`（每天 8:30 一次）

脚本对 `pg_cron` 扩展缺失做了容错：未启用时跳过调度并 NOTICE 提示，需到 Dashboard → Database → Extensions 手动启用后重跑末段。

### 2.7 Realtime

脚本将 `sys_notifications` 加入 `supabase_realtime` publication（RLS 对 Realtime 同样生效，收不到他人通知）。若环境不允许自动 ALTER PUBLICATION，会在 NOTICE 中提示到 Dashboard 手动开启该表的 Realtime。

### 2.8 source_type → 前端路由映射（notify_link_path）

| source_type | 路由 |
|---|---|
| `purchase_order` / `purchase_receipt` | `/inventory/purchase` / `/inventory/purchase-receipts` |
| `sales_order` / `sales_delivery` | `/inventory/sales` / `/inventory/sales-deliveries` |
| `voucher` | `/finance/vouchers` |
| `stock_adjustment` / `stock_count` / `inventory_transfer` | `/inventory/stock-adjustments` / `/inventory/stock-counts` / `/inventory/transfers` |
| `product` | `/inventory/products` |
| `production_order` / `mrp_plan` | `/mrp/production` / `/mrp/plans` |

新增单据类型时在 `notify_link_path()` 的 CASE 中补一行即可（注意该函数为 `IMMUTABLE`，修改后需 `CREATE OR REPLACE`）。

## 3. 前端（NotificationBell.tsx）

挂载于 `ProLayout` 头部 `actionsRender` 首位（`src/components/ProLayout.tsx`），登录后自动生效。

- **数据加载**：按 `user.profile.id`（`sys_users.id`）查询本人未删除通知，最多缓存 50 条（`PAGE_SIZE`）。
- **实时订阅**：`supabase.channel().on('postgres_changes', { event: 'INSERT', filter: 'recipient_user_id=eq.<userId>' })`，新通知到达时：列表前插、未读数 +1、antd `Notification` 右下角即时提示。
- **弹层列表**：按类型 Tab 筛选（全部/审批/预警/任务），严重度着色（critical 红 / warning 橙 / info 蓝），显示相对时间。
- **已读操作**：单条点击即标记已读并按 `link_path` 跳转单据页；「全部已读」批量 UPDATE。
- 文案在 `src/locales/zh-CN.ts` / `en-US.ts` 的 `notification.*` 键下（共 18 条）。

## 4. 部署与验证

部署顺序：`deploy_31_notifications.sql` 依赖 `deploy_01`（sys_users/sys_roles）、`deploy_02`（current_sys_user_id）、`deploy_14`（wf_* 表），已追加进 `000_run_all_in_order.psql.sql`。脚本幂等（`CREATE OR REPLACE` / `DROP TRIGGER IF EXISTS`），可整体重跑。

验证路径：

1. 提交任意单据审批 → 审批人铃铛未读 +1、右下角即时提示。
2. 手动触发预警扫描：`SELECT public.check_inventory_warnings();` / `SELECT public.check_order_delay_warnings();`（SQL Editor）。
3. 查看通知落库：`SELECT id, recipient_user_id, notification_type, title, created_at FROM public.sys_notifications ORDER BY id DESC LIMIT 10;`

## 5. 运维排障手册（实际踩坑记录）

按"通知没收到"的排查顺序：

| 步骤 | 检查 | 常见问题 |
|---|---|---|
| 1 | 通知是否落库 | `sys_notifications` 无记录 → 收件人解析为空或触发器未触发 |
| 2 | 收件人是否正确 | `recipient_user_id` 与登录用户 `sys_users.id` 不符 → 审批节点配的角色/用户与预期不一致，或目标角色下无有效用户触发了降级 |
| 3 | 角色成员映射 | super_admin 角色成员以 `sys_user_roles` 为准——**在角色管理页给用户分配角色，登录账号"看起来是管理员"不等于挂了角色** |
| 4 | 触发器状态 | `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='public.wf_process_instances'::regclass AND NOT tgisinternal;`，`'O'` 为正常 |
| 5 | Realtime | 表是否在 `supabase_realtime` publication 中；不影响刷新后显示，只影响实时推送 |

两条硬约束：

- **PostgreSQL 函数参数规则**：一旦某参数带 DEFAULT，其后所有参数必须也带 DEFAULT（错误码 42P13）。`notify_push` 的 `p_title` 因此补了 `DEFAULT NULL`。
- **管理操作必须用有权限的角色**：Supabase Studio SQL Editor 以 `postgres` 运行可执行全部脚本；外部数据库客户端若用 **anon key 连接**（`current_user = anon`）会报 `must be owner of table`，且此时查到的系统状态不可信。外部工具请使用 Database Settings 中 postgres 用户的连接串。

## 6. 二期扩展方向

- **用户订阅配置**：按 `notification_type` 开关（表结构已预留 `recipient_role_code`，可加 `sys_notification_subscriptions` 表在 `notify_push` 出口过滤）。
- **离线推送渠道**：`pg_net` / Database Webhook 调 Edge Function 发邮件或企业微信，挂在 `sys_notifications` 触发器之后即可，现有链路不动。
