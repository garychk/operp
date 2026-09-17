# OPERP SaaS 化改造评估

> 评估时间：2026-09-16
> 评估范围：`D:\Projects\supabase-erp`（前端 SPA + Supabase + ai-server）
> 结论：**当前系统是单租户 ERP，不具备任何多租户能力。**

---

## 一、总体判定

项目虽然是一个功能相对完整的 ERP（财务 / 进销存 / MRP / 系统管理 + AI 对话 + BAQ + 页面设计器），
但从 SaaS 的角度看，它目前是「一套代码 + 一个 Supabase 实例 + 一个客户的自建系统」。

关键证据：

| 检查项 | 现状 | 是否阻断 SaaS |
|--------|------|--------------|
| 租户隔离（RLS） | 按角色授权，**无租户维度** | 是（P0） |
| 租户标识字段 | 80 张表有 `corp_id`，但**全表 NULL** | 是（P0） |
| AI 服务端鉴权 | ai-server **零鉴权** + service_role 全权访问 | 是（P0） |
| 套餐 / 订阅 / 配额 / 计费 | 全仓零实现 | 是（P1） |
| 注册即建租户 | 无租户开通流程 | 是（P0） |
| 构建期配置注入 | `VITE_*` 烧进 bundle | 是（P1） |

`tenant`、`subscription`、`plan`、`billing`、`quota`、`invite` 在项目全仓（含 `src/`、`supabase/`、`ai-server/src/`）**零命中**。

---

## 二、P0 阻断级问题（接第二个客户之前必须解决）

### 1. 数据隔离层不存在 —— 这是最致命的一条

`supabase/tables/deploy_02_permissions_core.sql`

- `install_role_table_rls()`（L220-277）为每张表生成 4 条策略，
  `USING` / `WITH CHECK` 条件**恒为** `public.has_table_permission(<table>, <action>)`，**没有任何 corp_id 或租户过滤**。
- `has_table_permission()`（L167-218）只判断角色是否拥有该表的 select/insert/update/delete 权限，
  且 `super_admin` 角色在 L182-193 **直接 `RETURN TRUE`**。
- `deploy_04_apply_erp_table_rls.sql` 对 `sys_tables` 中所有 `erp\_%` 表循环执行该函数，
  等于给全部 ERP 业务表装上了「只要角色对，就能读写全表」的策略。

**后果**：任何登录用户，只要其角色具备表权限，即可跨租户读写全部数据。
放第二个客户进去 = 数据互相可见。

**改造要点**

1. 新增 `tenants` 表（或复用并重构 `erp_companies`，后者目前是**未被引用的死表**）。
2. 新增 `SECURITY DEFINER` 函数 `current_tenant_id()`，从 JWT `app_metadata.tenant_id`
   或 `sys_users.tenant_id` 取值（目前 `sys_users` 上没有 tenant 字段）。
3. 重写 `install_role_table_rls()`，策略条件改为：

   ```sql
   public.has_table_permission('table', 'select')
   AND corp_id = public.current_tenant_id()
   ```

   并对全部 ~80 张含 `corp_id` 的表重新执行一次策略生成（必须写成 `deploy_36_tenancy.sql`，
   现有 35 个脚本是累积执行的）。
4. `super_admin` 必须拆成 `platform_admin`（平台运营）与 `tenant_admin`（租户管理员），
   否则平台运营能看到所有客户数据 —— 这既是安全问题，也是签合同时的合规雷。

### 2. `corp_id` 是死列，从未被写入

- `src/types/database.ts` 中所有 Insert 类型都写成 `Omit<..., 'corp_id' | 'emp_id' | ...>`。
- `deploy_01_schema_and_seed.sql` 的种子数据也不插入 `corp_id`。
- 前端除类型定义和 `system/DocFlowConfig.tsx` 的列排除清单外，无任何地方读写 `corp_id`。

**改造要点**：不要试图改 70+ 个页面的调用点（成本失控且必然漏）。
正确做法是加**触发器兜底**：

```sql
BEFORE INSERT ON <每条业务表>
FOR EACH ROW EXECUTE FUNCTION set_row_tenant();  -- NEW.corp_id := current_tenant_id()
```

同时对存量数据做一次性回填（建默认租户 + `UPDATE ... SET corp_id = <default>`）。

### 3. ai-server 完全裸奔

`ai-server/src/app.ts`

```ts
app.use("/api/health", healthRouter);
app.use("/api/ai", aiRouter);      // ← 无任何鉴权中间件
```

- `ai-server/src/config/supabase.ts:4` 使用 `SUPABASE_SERVICE_ROLE_KEY` 建 client，**直接 bypass RLS**。
- 全 `ai-server/src` 搜索 `Authorization | Bearer | jwt | getUser` 零命中（唯一命中的是发给 LLM 的 key）。
- 暴露的 API：`GET /api/health`、`POST /api/ai/chat`（SSE）、`POST /api/ai/knowledge/reindex`。
- 请求体只有 `session_id / user_id / text / skill`，**不感知租户**。

**后果**：任何人可直接调用接口读取任意租户数据，并消耗你的 LLM 额度。

**改造要点**

1. 加 JWT 校验中间件：`supabase.auth.getUser(token)`。
2. 租户上下文**只从 JWT 取**，绝不能信任请求体里传来的 tenant。
3. 优先改为「带用户 Authorization 头的 anon client」，让查询走 RLS；
   确需 service_role 的后台任务（如 reindex）单独拆出来，限定只有平台侧可调用。
4. `/api/ai/knowledge/reindex` 应改为内部管理接口。

### 4. AI 配置是全局单例

- `sys_config.category_code` 在 `deploy_07_system_config.sql:8` 上是 **`UNIQUE`**。
- ai-server 从 `category_code = 'ai'` 读单条全局配置 → 所有租户共用同一个模型和同一把 API Key。

**改造要点**：`sys_config` 增加 `tenant_id`，唯一键改为 `(tenant_id, category_code)`；
同时用 `NULL` tenant_id 表示平台级默认配置（可被租户覆盖）。

### 5. 注册 = 拿账号，不是「开通租户」

`src/pages/Login.tsx:101` 直接调 `supabase.auth.signUp`，
`src/contexts/AuthContext.tsx:87` 随即自动 upsert 一条 `sys_users` 记录。

**后果**：A 公司员工注册后，立刻可以看到 B 公司的全部数据。

**改造要点**：拆分为完整开通流程 ——
创建租户 → 初始化租户种子数据（会计科目体系、仓库、单据类型、会计期间、工作流模板、默认角色菜单）
→ 创建 owner 用户 → 邀请成员加入（invite）。

---

## 三、P1 商业化必备

### 6. 套餐 / 订阅 / 配额 / 计费

目前零实现。至少需要：

- 数据模型：`plans`、`subscriptions`、`subscription_items`、`usage_records`、`invoices`
- 计量维度：用户数、单据数、SKU 数、AI tokens、存储空间、API 调用次数
- 拦截点：配额超限的中间件（前端提示 + 服务端硬拦截，服务端拦截才是权威）

### 7. 构建期配置注入 → 运行时注入

根 `Dockerfile` 把 `VITE_SUPABASE_URL` 等作为 `ARG` **在构建期烧进 bundle**。
多租户若采用「一套代码 + 多域名」，必须改成运行时注入（`/config.js` 或边缘 SSR 注入），
否则每个租户都要单独构建一个镜像。

### 8. 租户路由选型

需要先定下来，因为它反向影响 Types、Auth 和所有查询写法：

- 子域名路由：`tenantA.yourdomain.com`（客户感受更像 SaaS，需要通配证书）
- 统一域名 + 登录后选择/切换组织（改造量小）

---

## 四、P2 运营与合规

### 9. 唯一键必须加租户维度（容易漏）

`deploy_01_schema_and_seed.sql` 中有 **约 28 个全局唯一约束**，例如：

| 行号 | 约束 |
|------|------|
| L193 / L247 / L268 / L295 / L470 / L530 / L544 / L595 / L827 / L845 | `code VARCHAR(50) UNIQUE`（公司/部门/客户/供应商/物料/仓库/科目等） |
| L487 | `asset_no UNIQUE` |
| L654 / L739 | `order_no UNIQUE`（采购单/销售单） |
| L701 / L786 | `receipt_no / delivery_no UNIQUE` |
| L864 / L902 / L940 / L979 / L1023 / L1058 / L1080 | `bom_no / routing_no / plan_no / order_no / issue_no / report_no / receipt_no UNIQUE` |
| L18 / L35 / L110 | `username / role_code / category_code UNIQUE` |

共享库方案下，这些**全部必须改为 `(corp_id, xxx)` 复合唯一**，
否则租户 A 建了物料编码 `P001`，租户 B 就永远建不了。

另外注意：单据编号生成器 `src/utils/documentNaming.ts` 与 `deploy_32_document_naming.sql`
需要改造为按租户取号，避免序列号跨租户打架。

### 10. 数据导出 / 注销 / 保留策略

多租户后要支持按租户导出与彻底删除（对应《个人信息保护法》的删除权）。
现在只有软删除 `is_deleted`，没有租户级导出/清理能力。

### 11. 审计日志隔离

`sys_logs` 目前也是按角色 RLS 控制，多租户后会串日志。需加 `corp_id` 并按租户隔离。

### 12. 清理遗留物（顺手做）

- `bcryptjs` 是**死依赖**（在 `package.json` dependencies 里，全仓零引用）。
- 真实登录已走 `supabase.auth.signInWithPassword`（`AuthContext.tsx:217`）。
- 但 `sys_users.password_hash` 字段仍在，且被写成占位串
  `'$supabase_auth$'`（`AuthContext.tsx:95`）和 `'$2a$10$using_supabase_auth'`（`pages/system/Users.tsx:296`）。
  多租户安全审计时这是明显的混淆点，建议一并清理。

---

## 五、隔离方案选型建议

| 方案 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| **共享库 + RLS（推荐起步）** | 改造成本最小，复用现有 80 张表，一次迁移生效 | RLS 写错一次就是全局泄露，需要回归测试兜底 | 中小客户、标准化 SaaS |
| 库级隔离（schema per tenant） | 隔离较强，单租户可单独导出 | 迁移要跑 N 遍，连接池和运维复杂度上升 | 中大客户 |
| Supabase 多 project / 实例隔离 | 隔离最强，故障域隔离好 | 成本随租户线性增长，发布要做 N 次 | 大客户私有化 |

**推荐路径**：起步走「共享库 + 强 RLS」，同时保留一套「独立部署」的交付形态给大客户 ——
`docker-compose.yml` 现在只有 `nginx` + `ai-server` 两个服务，
做成单租户独立部署映像的成本本来就不高。

---

## 六、实施路线图

| 阶段 | 内容 | 产出物 |
|------|------|--------|
| **阶段 0** 模型设计 | 确定隔离方案、租户路由方式、`tenants` 表设计 | 数据模型 DDL + 决策记录 |
| **阶段 1** 数据面隔离 | `tenants` 表、`current_tenant_id()`、重写 RLS 生成器、回填 `corp_id`、触发器兜底、**跨租户越权回归测试用例** | `deploy_36_tenancy.sql` + 回归脚本 |
| **阶段 2** 身份面 | 注册改为「开通租户」、成员邀请、`platform_admin` / `tenant_admin` 角色分层 | 租户开通流程 + 邀请机制 |
| **阶段 3** 服务面 | ai-server JWT 鉴权、租户上下文注入、LLM 用量计量 | 鉴权中间件 + usage 埋点 |
| **阶段 4** 商业面 | 套餐、订阅、配额、计费、超限拦截 | 计费子系统 |
| **阶段 5** 交付面 | 运行时配置注入、域名路由、自助开通/导出/注销、私有化通道 | 部署流水线 |

---

## 七、最重要的结论

> **在阶段 1 完成并通过跨租户越权回归测试之前，不要把这套系统对外放第二个客户。**

所有 P0 问题里，第 1 条（RLS 无租户维度）是唯一「一旦泄露不可逆」的。
其余都属于功能缺失，最多影响商业化；唯独数据隔离出问题，是法律和信任层面的事故。

建议把「跨租户越权回归测试」做成 CI 门禁：
用两个不同租户的账号，对同一批表各跑一遍 select / insert / update / delete，
断言互相不可见 —— 这张网必须有，否则未来每加一张新表都可能漏装tenant策略。
