# 数据库 RPC vs ai-server 直查 —— 边界规则

本文回答一个高频疑问：**ai-server 端既然能做查询、分析、统计，为什么有些地方还要走数据库端的 RPC（`supabase.rpc(...)`）？** 并给出可执行的决策规则，供后续新增功能时判断「该写库内 RPC 还是该在 ai-server 里直查」。

> 适用范围：ai-server（`ai-server/src/`）与 PostgreSQL（`supabase/tables/`）之间的数据访问分工。前端直连 PostgREST 不在此列。

---

## 1. 一句话结论

> **数据「读出来分析」→ ai-server 用普通 `.select()`；**
> **数据「要改、要跨表联动、要过权限、要在数据旁算」→ 数据库 RPC。**

判断标准不是「能不能查」，而是「这个操作离开了数据库的**事务 / RLS / 索引 / 数据本地性**之后，还能不能保证正确」。RPC 的价值几乎全部来自这四件事，而不是「查询统计」本身。

---

## 2. 决策流程图

```
                        开始：ai-server 需要访问数据
                                  │
                                  ▼
                    ┌─ 这个操作是「写」还是「读」？ ─┐
                    │                              │
                    ▼ 写                           ▼ 读
        ┌── 是否涉及多表联动 / 取号 / 台账？        ┌─ 结果集是否需要「数据本地」能力？
        │                                          │
        │ 是 ──────────────► 数据库 RPC            │  · 向量检索（pgvector <=>）
        │                                          │  · 需要 DB 自省（schema/索引）
        │ 否（单表 insert/update）                  │  · 需要库内身份（current_tenant_id）
        │                                          │    ────► 数据库 RPC
        │  · 需要 RLS/取号/触发器按真实租户生效？     │
        │    ──是──► 数据库 RPC                     │  其余（普通联表、聚合、统计）
        │                                          │    ────► ai-server 直查 .select()
        │  · 需要事务原子性（一损俱损）？              │
        │    ──是──► 数据库 RPC                     │
        │                                          │
        │  都不是 → ai-server 直查 + service_role      │
        │          显式带 tenant_id                  │
        └──────────────────────────────────────────┘
```

---

## 3. 数据库 RPC 的四类场景

从当前代码里 `supabase.rpc(...)` 的实际调用看，RPC 几乎都不是「查询统计」，而是下面四类**必须留在库内**的操作。

### 3.1 写操作的事务原子性 + 多表一致性

业务写操作是「一损俱损」的，只有 `BEGIN…COMMIT` 能保证原子性。拆成 ai-server 里的多条语句，中途失败就会留半套数据。

| RPC | 为什么不能拆成 ai-server 多条语句 |
|---|---|
| `service_run_fx_revaluation` / `service_reverse_fx_revaluation` / `service_settle_ar_ap` | 调汇、结算要在一个事务里写多张核算表并生成凭证 |
| `service_ai_create_document` / `post_document` / `reverse_document` | 建单要同事务取号、写台账、联动库存/应付 |
| `doc_flow_ledger_convert` / `explode_production_order_bom` | 下推、BOM 展开是多表联动 + 累计校验，靠事务兜并发 |

### 3.2 身份 / 权限约束只能由数据库自己解决

ai-server 用 **service_role 连接，绕过 RLS**。RPC 内部用 `set_config` 注入 `app.tenant_id` + `jwt claims`，`current_tenant_id()` / RLS / 取号函数 / 触发器才能按真实租户工作（见 `ai-server/src/services/documentActions.ts` 头注释）。

### 3.3 计算必须在数据旁边做（数据本地性）

`match_ai_knowledge_chunks_for_tenant` 是 **pgvector 向量相似度检索**——embedding 在库里，`<=>` 距离算子也在库里，不可能把百万级向量拉到 ai-server 再算余弦距离。

### 3.4 只读但需要「库内自省视角」

`ai_entity_catalog` / `baq_catalog` / `execute_ai_analysis` 是「把 SQL 交给 DB 执行」——schema（表结构、列名、唯一索引）的真相在 DB，不在 ai-server 内存里。

---

## 4. ai-server 直查的适用场景

符合以下特征就用 ai-server 里的 `supabase.from(...).select(...)` 直查：

- **纯读**：普通联表、过滤、聚合、统计；
- **结果可以整体拉出再处理**：不依赖库内函数/算子；
- **业务逻辑在 TS 侧更好写、更好测**：如 RCCP 的「日产能 × 工作日数」这种可纯 TS 推导的计算（`ai-server/src/services/mpsService.ts` 的 `computeRccp`）。

⚠️ 直查铁律（service_role 绕过 RLS）：**每一次查询、每一笔写入都显式带 `tenant_id`**，否则会串租户（见 `mpsService.ts` 头注释「两条铁律」）。

---

## 5. 边界速查表

| 判断维度 | 数据库 RPC | ai-server 直查 |
|---|---|---|
| 多表联动写 / 取号 / 台账 | ✅ 必须 | ❌ 拆散会失原子性 |
| 需要 RLS / `current_tenant_id()` / 触发器 | ✅ 必须 | ❌ service_role 拿不到租户上下文 |
| 向量检索 / 库内算子 | ✅ 数据本地 | ❌ 拉出来算不现实 |
| DB 自省（schema / 唯一索引） | ✅ 库内视角 | ❌ ai-server 不知道 schema |
| 普通读 / 联表 / 聚合 / 统计 | ⚠️ 可选但没必要 | ✅ 首选 |
| 纯 TS 可推导的计算 | ❌ 硬塞 SQL 反而难维护 | ✅ 首选 |

---

## 6. 反例：帮你记住边界

`execute_ai_analysis` 看似是「查询」，其实是「ai-server 把不确定的 SQL 交给 DB 跑」——因为 schema 的真相在 DB，不在 ai-server 内存里。判断它是不是「读」，要看它读的是「业务数据」还是「数据库自身的元数据」。

另一个反例：RCCP 的月产能是「读工作中心 + 班次 + 日历三张表后纯 TS 计算」，所以落在 ai-server 里直查（`.select()`）；而调汇、建单、过账这些「写」动作，天生属于 RPC。

---

## 7. 维护约定

- 本文件是「分工」的权威说明，新增数据访问逻辑前先对照第 5 节速查表。
- 若发现新的边界情形（例如某类操作既非纯读又非纯写），回到第 1 节的原则判断，并把结论补进本文。
- 相关既有实现参考：
  - 库内 RPC 写操作：`supabase/tables/deploy_83_*`（单据 RPC）、`deploy_17_voucher_posting_rpc.sql`（过账）、`deploy_34_*`（出入库过账）
  - ai-server 直查读：`ai-server/src/services/mpsService.ts`、`mrpService.ts`
  - 身份注入：`ai-server/src/services/documentActions.ts`
