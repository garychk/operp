# OPERP 数据库初始部署说明

本文档用于实施人员在新 Supabase 项目中初始化 ERP 数据库、权限、RLS 策略和基础数据。

## 推荐执行脚本

实施人员需要按编号顺序执行所有 deploy_*.sql 脚本。核心初始化与本次库存事务升级包括：

1. `deploy_01_schema_and_seed.sql`
2. `deploy_02_permissions_core.sql`
3. `deploy_03_system_rls_and_menu_permissions.sql`
4. `deploy_04_apply_erp_table_rls.sql`
5. `deploy_05_auth_super_admin.sql`
6. `deploy_06_payables_source_fields.sql`
7. `deploy_07_system_config.sql`
8. 继续执行 `deploy_08` 至 `deploy_12`
9. `deploy_13_stock_posting_rpc.sql`

推荐在 Supabase Dashboard 的 SQL Editor 中逐个打开执行。每个脚本执行成功后，再执行下一个。

如果使用 `psql` 或 Supabase CLI，可以执行同目录下的 `000_run_all_in_order.psql.sql`。注意：`\i` 是 psql 元命令，不能直接粘贴到 Supabase SQL Editor。

## 脚本说明

### 1. `deploy_01_schema_and_seed.sql`

创建基础表、业务表、存储桶，并写入初始系统数据。

包含内容：

- 系统管理表：`sys_users`、`sys_roles`、`sys_user_roles`、`sys_menus`、`sys_role_menus`、`sys_logs`
- ERP 业务表：基础资料、财务、进销存、生产 MRP
- `sys_logs.params` 调整为 `jsonb`
- `sys_users.auth_id`，用于绑定 Supabase Auth 用户
- `sys_forms` 表
- `sys_config` 表，用于按分类保存 JSON 系统设置
- `avatars` Storage Bucket 和头像上传策略
- 初始角色、用户、系统管理菜单、超级管理员菜单授权

### 2. `deploy_02_permissions_core.sql`

创建权限基础能力。

包含内容：

- 给 `authenticated` 授予系统管理表基础权限
- `sys_roles` RLS 策略
- 表权限框架：`sys_tables`、`sys_role_table_permissions`
- 权限函数：`current_sys_user_id()`、`has_table_permission()`、`install_role_table_rls()`

### 3. `deploy_03_system_rls_and_menu_permissions.sql`

配置系统表 RLS、菜单权限 RPC、用户角色和角色菜单关联表策略。

包含内容：

- `sys_logs` 表权限 RLS
- `sys_users` 自身资料读取/维护策略
- `sys_menus` 表权限 RLS
- 登录用户读取启用菜单定义策略
- `current_user_menu_paths()`：当前用户可见菜单路径
- `current_user_is_super_admin()`：当前用户是否超级管理员
- `sys_role_menus` 维护策略
- `sys_user_roles` 维护策略

### 4. `deploy_04_apply_erp_table_rls.sql`

对所有 `erp_%` 业务表应用数据驱动的角色表权限 RLS。

执行后，ERP 业务表访问由 `角色管理 -> 权限 -> 表权限` 中的配置决定。超级管理员默认拥有全部表权限。

### 5. `deploy_05_auth_super_admin.sql`

为新 Supabase 项目提供首次 Auth 绑定用户的超级管理员 bootstrap 逻辑。

- 通过 `sys_users.auth_id` 的首次绑定触发
- 当当前库里只有 1 个已绑定 Auth 的用户时，自动给该用户分配 `super_admin`
- 逻辑为通用初始化，不依赖固定邮箱

### 6. `deploy_06_payables_source_fields.sql`

补充应付账款来源单据字段。

### 7. `deploy_07_system_config.sql`

创建 `sys_config` 系统设置表、初始化基础/财务/制造/检验/AI 设置，新增“系统设置”菜单并应用表权限 RLS。

### 13. `deploy_13_stock_posting_rpc.sql`

将采购入库和销售出货的过账、反过账迁移为 PostgreSQL 事务 RPC。

包含内容：

- `post_stock_document()`、`reverse_stock_document()`
- 单据、库存和应付记录行锁
- 库存键事务级 advisory lock
- 过账和反过账幂等键
- 有效库存、库存流水和采购应付唯一约束
- 采购入库应付生成与反过账校验

已有数据库升级时可以单独执行此脚本。若历史数据存在重复有效库存或重复采购入库应付，脚本会中止并提示先清理数据。

## 部署后必须配置

1. 创建 Supabase Auth 登录账号。

   前端登录使用 Supabase Auth，不直接使用 `sys_users.password_hash`。

   建议在 Supabase Authentication 中创建管理员账号，例如：

   - Email: `admin@erp.com`
   - Password: 按实施现场要求设置

2. 绑定 Auth 用户与 `sys_users`。

   程序登录时会尝试按邮箱自动绑定 `sys_users.auth_id`。也可以手工绑定：

   ```sql
   update public.sys_users
   set auth_id = '<auth.users.id>'
   where email = 'admin@erp.com';
   ```

3. 确认管理员用户已绑定超级管理员角色。

   ```sql
   select u.id, u.username, u.email, r.role_code, r.role_name
   from public.sys_users u
   join public.sys_user_roles ur on ur.user_id = u.id
   join public.sys_roles r on r.id = ur.role_id
   where u.email = 'admin@erp.com';
   ```

   结果中应包含 `super_admin`。

4. 补齐业务菜单。

   初始脚本只写入系统管理菜单。财务、进销存、MRP 菜单需要在“菜单管理”中维护，或由实施数据脚本补充。

5. 给普通角色授权。

   在系统中进入：

   - `角色管理 -> 权限 -> 菜单权限`
   - `角色管理 -> 权限 -> 表权限`

   分别配置用户可见菜单和可访问的数据表权限。

## 目录结构

当前目录只保留实施需要的合并部署脚本：

- `deploy_01_schema_and_seed.sql`
- `deploy_02_permissions_core.sql`
- `deploy_03_system_rls_and_menu_permissions.sql`
- `deploy_04_apply_erp_table_rls.sql`
- `deploy_05_auth_super_admin.sql`
- `deploy_06_payables_source_fields.sql`
- `deploy_07_system_config.sql`
- `000_run_all_in_order.psql.sql`
- `README_DEPLOYMENT.md`

## 注意事项

- 建议在空库执行初始部署。
- 不要重复执行包含初始 `INSERT` 数据的脚本，避免唯一约束冲突。
- 如果需要重复部署，请先确认目标库中没有同名角色、用户、菜单编码。
- `deploy_04_apply_erp_table_rls.sql` 建议在基础权限脚本之后执行，避免 ERP 业务表 RLS 过早开启影响初始化。
- `deploy_07_system_config.sql` 用于新增系统设置，已有库升级时也可以单独执行。

## 单据统一编号（deploy_32_document_naming.sql）

已有库升级时可单独执行。该脚本启用基于 `sys_document_types.naming_rule` 的统一单号生成：

- 新增计数表 `sys_document_naming_counters`（document_type + period_key 记录流水号，仅通过 RPC 写入）。
- 新增 RPC `generate_document_no(p_document_type, p_date)`：按命名规则（`{YYYY}` `{YY}` `{MM}` `{DD}` `{####}` 等占位符）原子生成下一单号，例如 `PO{YYYY}{####}` → `PO20260001`。规则中出现 `{DD}` 时按日重置流水，`{MM}` 按月，否则按年。
- 补充注册 DocType：`production_order`、`material_issue`、`mrp_plan`、`bom`、`routing`。
- 辅助 RPC `reset_document_no_counter(p_document_type, p_period_key)` 用于测试环境重置计数器。

前端所有单据页面（采购/销售订单、出入库、调拨、盘点、调整、凭证、生产订单、领料、MRP 计划）与 AI 新建单据均改为调用该 RPC 取号；RPC 不可用时自动回退为旧的时间戳单号。注意：打开新增表单即占号，用户放弃保存会产生空号（与 ERPNext 行为一致）。

## 库存业务流水类型 DocType 化（deploy_40_inventory_transaction_types.sql）

已有库升级时可单独执行（需在 `deploy_24` / `deploy_34` 之后）。

背景：`erp_inventory_transactions.transaction_type` 之前只是 `VARCHAR(50)`，枚举硬编码在前端
`src/constants/inventoryTransactionTypes.ts`，过账 RPC 里直接写字面量，新增业务类型要改三处。

脚本内容：

- 新增 `sys_inventory_transaction_types`：业务类型字典（code / name / direction / affects_stock / name_en），
  也是前端下拉与标签的数据源，种子 20 条标准类型。
- 新增 `sys_document_transaction_types`：DocType × 业务类型映射（direction / is_default / condition_note），
  唯一约束 `(document_type_id, transaction_type_code)`。一个 DocType 可映射多条（调拨出/入、盘点盈/亏）。
- 新增 RPC `resolve_inventory_transaction_type(p_document_type, p_direction)`：`SECURITY DEFINER`，
  按方向解析；查不到时回落到内置默认值，配置缺失不会导致过账失败。
- 过账写入点改为调用该 RPC：`deploy_34`（采购入库/销售出货）、`deploy_24`（调拨出/入、盘点、调整）。
- 回填历史数据：`transfer_out/transfer_in` → `inventory_transfer_out/in`，`inbound/outbound` →
  `purchase_receipt_in/sales_delivery_out`。

配置入口：系统 → DocType Builder，打开某个 DocType 后的「业务流水类型」页签可增删关联、指定默认类型与触发条件；
也可在该页签直接新建业务类型字典条目。

## 多租户改造脚本（deploy_41 起）

已有库升级，按以下顺序单独执行（都建议在 `BEGIN; ... ROLLBACK;` 里先干跑一遍看 NOTICE）：

| 脚本 | 内容 | 隔离模型 |
|---|---|---|
| `deploy_41_tenant_isolation.sql` | `sys_tenants`、`sys_users.tenant_id`、`current_tenant_id()`、59 张 `erp_*` 表加列 + RLS | fail-closed：NULL 一律不可见 |
| `deploy_42_ai_tenant.sql` | `sys_baq_queries` / `sys_ai_chat_memory`、`execute_ai_analysis_for_tenant()` | 租户私有 |
| `deploy_43_custom_access_token_hook.sql` | GoTrue Custom Access Token Hook，把 tenant_id 写进 JWT | — |
| `deploy_44_tenant_menu.sql` | 租户管理菜单与授权 | — |
| `deploy_45_sys_logs_tenant.sql` | `sys_logs` 隔离 | fail-soft（可空，不因解析失败丢日志） |
| `deploy_46_ai_chat_tenant.sql` | AI 会话与消息隔离 | 租户私有 |
| `deploy_47_naming_counter_tenant.sql` | 单号计数器按租户独立（改主键，会锁表，单独跑） | 租户私有 |
| `deploy_48_platform_metadata_tenant.sql` | 角色/菜单/系统设置/字典/DocType/单据转换/页面设计/知识库/工作流定义/通知共 24 张表 | **平台基线（NULL）+ 租户私有** |
| `deploy_49_workflow_runtime_tenant.sql` | `wf_process_instances` / `wf_process_actions` | fail-closed（含 `document_no`，属业务运行数据） |
| `deploy_50_tenant_signup.sql` | 租户自助注册链路：`tenant_admin` 基线角色、`bootstrap_tenant()`、`sys_users.username` 改租户内唯一 | — |

### deploy_48 的隔离模型

与 `erp_*` 的 fail-closed 不同，平台元数据采用「基线共享」：`tenant_id IS NULL` 是平台基线，
所有租户可见；`tenant_id = 租户` 是租户私有。存量数据保持 NULL 当基线 —— 若回填给默认租户，
第二个租户登录后菜单/角色/字典/DocType 会是空的，系统直接不可用。

基线能否修改按表分两类：

- **可改基线**：菜单、角色、字典、DocType、单据转换规则、工作流定义。有该表的写权限即可改。
  代价是多租户规模化后，任一有权限的管理员改的是共享基线（租户间隐含信任）。
  要收紧就把第 6 节对应表从 `baseline_writable_tables` 挪到 `private_only_tables` 重跑。
- **不可改基线**：系统设置、通知、知识库、页面设计、单据转换记录。基线对这些表没有意义，
  允许写基线等于能发全员可见的通知。

配套改动：

- 系统设置新增覆盖视图 `vw_sys_config_effective`（私有行覆盖基线行，永远单行）与
  RPC `save_tenant_config()` / `get_tenant_config()`。前端读视图、存 RPC，
  ai-server 用 `get_tenant_config(p_tenant_id)` 显式传租户。
- 向量检索新增 `match_ai_knowledge_chunks_for_tenant(..., p_tenant_id)`；
  原 `match_ai_knowledge_chunks` 是 `SECURITY DEFINER`，会把所有租户的知识一起召回。
- `current_user_menu_paths()` / `current_user_role_codes()` / `has_table_permission()`
  三个 `SECURITY DEFINER` 函数内部补了租户谓词 —— RLS 管不到 definer 函数，漏了等于没隔离。
- 唯一键从全局唯一改成「基线内唯一 + 租户内唯一」两条部分索引。因此 `sys_forms` 的
  `upsert(onConflict: form_name)` 失效，改为先查后写（`SupaModal.tsx`）。

### deploy_50：租户自助注册

开通流程：登录页「注册租户」→ 填租户名称/编码 + 管理员信息 + 邮箱/密码 →
建 auth 账号 → `bootstrap_tenant()` 建租户、在该租户下建默认管理员、赋 `tenant_admin` 角色 →
刷新 token → 登录进自己的租户 → 在「用户管理」里加人。

为什么建租户必须走 `bootstrap_tenant()`（`SECURITY DEFINER`）：
`sys_tenants` 的 INSERT 策略是 `WITH CHECK (current_user_is_super_admin())`，
刚注册的账号没有任何角色，直接插表会被 RLS 拒掉。

函数内的四道校验（definer 等于临时提权，不能信任入参）：

1. `auth.uid()` 必须存在 —— 只认真实登录会话，不给 `anon` 授权
2. 该 auth_id 若已绑定 `sys_users` 且 `tenant_id` 非空 → 拒绝。一个 auth 账号只能开一个租户，
   想开第二个必须再注册一个 auth 账号（受 GoTrue 邮箱唯一性约束），不能靠反复调 RPC 刷库
3. 租户编码白名单 `^[a-z][a-z0-9_-]{1,30}$` + 占用检查
4. 管理员邮箱只从 JWT 取，不接受入参 —— 否则可以拿别人的邮箱建管理员

**竞态兜底（重要）**：`signUp` 后 `AuthProvider` 的 `onAuthStateChange` 会立刻跑
`loadAppUser()`，它发现没有 profile 就自动建一条 `tenant_id` 为空的记录，可能抢在
`bootstrap_tenant()` 之前落库。所以函数遇到「已绑定但 `tenant_id` 为空」时不报错，
而是把这条空租户 profile 收编进新租户。副作用是好处：存量里 `tenant_id` 为空的老账号
登录后也能自助开通租户补上归属。

**`sys_users.username` 改成租户内唯一**：原来是 `NOT NULL UNIQUE`（全表唯一），
多租户下两个租户都想要叫 `admin` 的管理员会直接撞约束。已确认没有外键引用
`sys_users(username)`（只有 `sys_user_roles.user_id` 引 id），所以拆成两条部分索引：
`UNIQUE(username) WHERE tenant_id IS NULL` + `UNIQUE(tenant_id, username) WHERE tenant_id IS NOT NULL`。
`email` 不设唯一 —— GoTrue 层一个邮箱本来就只能有一个 auth 账号。

`tenant_admin`（租户管理员）是新建的**基线角色**，不是 `super_admin`：
`super_admin` 一旦赋出去，`current_user_is_super_admin()` 为真会让 RLS 的租户谓词整体放行，
等于发出一张能看全部租户数据的全局通行证。`tenant_admin` 的菜单以 `finance_manager` 为模板
（实测已覆盖除 `/system/tenants` 外的全部系统菜单和 38 条业务菜单），
再补 `/system` 父节点；表权限同样复制模板 89 条，并把系统管理相关表提到全权限。

### 配套：create-tenant-user（Edge Function）

位置 `supabase/functions/create-tenant-user/index.ts`，需单独部署：

```bash
supabase functions deploy create-tenant-user
```

租户内新建用户走它而不是浏览器端 `signUp`，原因：

- `signUp` 会把当前管理员的会话顶掉，只能靠 `setSession` 恢复
- 邮箱已注册时 Supabase 返回一个「混淆的」user（`identities` 为空数组），
  拿它建出的 `sys_users` 永远登不上且无任何报错
- `signUp` 只能给自己建，没法顺手写对 `tenant_id` 和角色

实现要点：校验调用方 token → 用**调用方 token** 跑 `current_user_is_super_admin()`
（该函数依赖 `auth.uid()`，用 service_role 调会恒为 false）→ 用 service_role 反查调用方租户 →
非超管只能用自己租户、且不能赋 `super_admin` → admin API 建号（`email_confirm: true`）→
插 `sys_users`（**显式带 tenant_id**，service_role 下 DEFAULT 会解析成 NULL）→ 赋角色 →
任一步失败回滚 auth 账号。

未部署时前端自动回退到浏览器端 `signUp`（`Users.tsx`），所以不部署也能用，
只是拿不到上面那三个好处。
