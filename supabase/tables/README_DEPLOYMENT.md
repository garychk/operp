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
