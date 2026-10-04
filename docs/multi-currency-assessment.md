# 多币别（Multi-Currency）支持改造 — 评估与落地总结

> 评估对象：`supabase-erp` 全栈（`supabase/tables` 部署脚本 + `src` 前端 + `ai-server`）
> 原评估时间：2026-10-03 ｜ **第 1~3 期已于 2026-10-03 当天全部落地**，本文档已由「改造前评估」改写为「落地总结」
> 配套细节手册：`.workbuddy/memory/ARCHITECTURE.md` 第八节

## 一、结论（更新）

**多币别改造第 1~3 期已完成，主数据 → 单据 → 库存成本 → 财务凭证 → 报表 → UI 整条链路已打通，账务层面闭环。**

- 改造范围：`deploy_65` ~ `deploy_78` 共 12 个部署脚本（当前 `000_run_all` 共 82 步，编号至 deploy_80）+ 前端三个公共模块 + ai-server 财务入口。
- 四个核心设计决策已全部拍板并实现（见 §二）。
- 端到端验证已走真实写入路径（HTTP 打 ai-server:3001）：外币应付 1000 USD @7.2 → 期末调汇 → 反向恢复 → 核销 300 USD @7.15，汇兑损益、凭证、试算平衡、跨租户 403 全部符合预期。
- **尚未做的**（第 4 期可选增强 + 少量收尾）见 §五。

---

## 二、已拍板的 4 个设计决策（全期一致）

| # | 决策 | 结论（已实现） |
|---|---|---|
| 1 | 双金额 vs 单金额+汇率反算 | **原币金额 + 本位币金额双列，汇率冻结在单据上**。逐行四舍五入差额由表头吸收 |
| 2 | 库存成本口径 | **库存一律本位币**；采购入库过账时折汇入库存与流水 |
| 3 | 汇率口径 | 方向写死 **`1 外币 = rate 本位币`**（只此一种口径，反向折算写 1/rate）；类型 `spot\|monthly\|custom`；精度 `NUMERIC(18,8)` |
| 4 | 汇兑损益确认时点 | **核销差额 + 期末调汇均已实现**（第 3 期） |

---

## 三、分期落地情况

### 第 1 期 · 骨架（deploy_65 / 66 / 67）

| 交付物 | 内容 |
|---|---|
| `deploy_65_currency_master.sql` | `erp_currencies_s_539dcf81_b` + `erp_exchange_rates_s_539dcf81_b` 主数据表；`current_base_currency()` / `get_exchange_rate()` / `seed_tenant_currencies()` / `set_base_currency()`；删除保护触发器；权限基线 + fail-loud 自检 |
| `deploy_66_currency_menu.sql` | 菜单 `/system/currencies`（基线三步：菜单行 + 角色授权 + clone） |
| `deploy_67_currency_tenant_scope.sql` | 修复超管跨租户可见：两张表补 **RESTRICTIVE** 策略 `tenant_scope_*`（PERMISSIVE 的 OR 分支短路 tenant_id 侧，超管能静默改到别人租户的币别） |
| 前端 | `src/utils/money.ts`（`formatMoney` / `formatRate` / `resolveCurrencyMeta` / `loadCurrencyRegistry` / `useCurrencyRegistry` 等）、`src/components/MoneyInput.tsx`、`src/pages/system/Currencies.tsx`（币别 + 汇率双 Tab）；全站替换硬编码 `¥` |

**关键设计**：

- 币别/汇率是**租户业务数据**（`tenant_id DEFAULT current_tenant_id()` + `install_role_table_rls()`），**不走**基线-副本模型；但新租户播种靠 `sys_tenants` 上的独立触发器 `trg_sys_tenants_seed_currencies`（6 币种 CNY/USD/EUR/HKD/JPY/GBP，失败仅 WARNING）。
- `current_base_currency()` 四级回退：本租户 `erp_currencies.is_base` → 本租户 `sys_config.finance.baseCurrency` → 基线同名配置 → `'CNY'`。
- `get_exchange_rate()` 取「生效日 <= p_date」最新一条；**无有效汇率返回 NULL（fail-loud），调用方禁止 `COALESCE(...,1)` 兜底**。
- `set_base_currency()` 先全清再置位（部分唯一索引 `uq_erp_currencies_one_base` 的坑），同步写 `sys_config.finance.baseCurrency` 消双真相源；**切换本位币不重算历史单据/库存/凭证**。

### 第 2 期 · 单据 + 成本（deploy_68 / 69）

- **deploy_68**：单据头/明细补 `currency` / `exchange_rate` / `base_amount`（`base_*` 走「NULL 闸门」回填：加列不给 DEFAULT → 回填 → 再置 NOT NULL + DEFAULT）。
- **deploy_69**：`post_stock_document` 入库成本折本位币；AR/AP 继承来源单据币种；**新增 SO/销售出货过账自动生成应收**（改造前销售出货不生成应收，币种无处继承）。
- 前端：SO/PO 币种下拉改读 `erp_currencies` 主数据；选中外币显示汇率（默认当日即期、可覆盖）+「折合本位币」预览；明细行 `Form.useWatch('currency', form)` 跟随表头。

### 第 3 期 · 财务（deploy_71 ~ 78 + ai-server）

| 脚本 | 内容 |
|---|---|
| `deploy_71` | 必备科目按租户补齐（**新增 6603 财务费用—汇兑损益**）+ `finance_subject_id_for(codes, tenant_id)` |
| `deploy_72` | 双金额列：`vouchers(currency, exchange_rate)`；`voucher_details` / `gl_entries` `(currency, exchange_rate, debit_fc, credit_fc)`；AR/AP `(base_paid_amount, base_balance)`；`erp_ar_ap_settlements(settlement_rate, base_amount, book_base_amount, fx_gain_loss)` + 6 条 CHECK |
| `deploy_73` | 重写 `post_voucher_document`（透传双金额 + 自洽校验）；**重写 `settle_ar_ap`（DROP 旧签名 + 新增第 8 参数 `p_settlement_rate`）** |
| `deploy_74` | `erp_fx_revaluation_s_539dcf81_b` + `run_fx_revaluation` / `reverse_fx_revaluation`（期末调汇） |
| `deploy_75` | 聚合视图加 `tenant_id` 维度；`vw_erp_ledger_detail` 追加 5 列；新建 `vw_erp_ar_ap_open` |
| `deploy_76` | service_role 财务入口（`service_finance_identity` 同事务注入身份 + 3 个 `service_*` 包装） |
| `deploy_77` | 原币发生额视图 `vw_erp_trial_balance_fc` / `vw_erp_gl_balance_fc` |
| `deploy_78` | **AR/AP `base_balance` 写入守卫**触发器 `trg_sync_ar_ap_base_amount` + 历史行补齐 |

**前端改动**：凭证头 + 分录行可选币种（原币借/贷 + 本位币借/贷 四列）；应收/应付表单加币种 + 汇率，列表加原币/本位币余额列（差额标「已调汇」）；核销独立 Modal（外币多「核销汇率」+ 当场显示预计汇兑损益）；试算平衡/科目余额/总账加 `Segmented` 口径切换（本位币 / 按币种）。

**ai-server**：`src/api/finance.routes.ts` 财务入口（`/api/finance/fx-open`、`/fx-revaluation/{run,reverse}`、`/settlement/run` 等），角色白名单收在 `roleGuard.ts`；错误提取统一走 `services/errors.ts` 的 `extractErrorMessage()`（PostgREST 错误不是 `Error` 实例，否则 409/422 映射全部退化 500）。

---

## 四、核心约定（改金额/财务代码前必读的铁律）

1. **`debit_amount` / `credit_amount` 恒为「本位币」**；原币在同行 `debit_fc` / `credit_fc`，`currency IS NULL` = 本位币行。
2. **`fx_gain_loss` = 6603 的净借方**：正 = 损失、负 = 收益。应付 `fx = 核销本位币 − 账面本位币`；应收反向；调汇 `fx = Σ应付重估差 − Σ应收重估差`。
3. **调汇会改写 `base_balance`** → 核销必须按当前账面比率冲减：`book_base_amount = ROUND(base_balance × amount / balance, 2)`。两者配套，改一个必须改另一个。
4. **AR/AP 的 `base_amount` / `base_balance` 一律交给 `trg_sync_ar_ap_base_amount` 触发器**，前端/服务端**不要自己算**（列有 `DEFAULT 0`，漏写会凭空产生巨额汇兑收益且不报错）。
5. **`settle_ar_ap` 是 8 参**，本位币核销第 8 参传 `null`。
6. **全站金额展示一律走 `money.ts`**；`MoneyInput` 取代 `prefix="¥"`；行上有 currency 按行币种，否则本位币；币种名走 `currencyLabel()`。
7. **报表口径**：本位币口径看 `vw_erp_trial_balance` / `vw_erp_subject_balance` / `vw_erp_gl_balance`；币种口径看 `*_fc` 视图（只含 `currency IS NOT NULL`，**其 `fc_diff` 天生不为零，不能据此判断试算不平衡**）。
8. service_role 经 PostgREST 时 `current_tenant_id()` 恒 NULL → 财务 RPC 走 `service_*` 包装注入身份，别在 TS 里另写一套租户逻辑。

---

## 五、遗留与第 4 期（可选增强）

| 项 | 现状 |
|---|---|
| **期末调汇前端页面** | 无；只能走 `run_fx_revaluation` / `reverse_fx_revaluation` RPC 或 `POST /api/finance/fx-revaluation/{run,reverse}`。要做界面需重走菜单三步 + 路由 + `ProLayout` 映射 + `menu.*` 键 |
| **设置页 `baseCurrency` 配置** | 仍是自由文本框，改了不生效（`current_base_currency()` 先读 `erp_currencies.is_base`）—— 既有问题；收口需改只读或接 `set_base_currency()` RPC |
| 客户/供应商结算币别 | 未加 `settlement_currency` 列（第 4 期定价增强的一部分） |
| 物料定价多币别 | `purchase_price`/`sale_price` 仍一律本位币口径 |
| 汇率自动取数 | 无外部汇率源接入，手工维护 |
| MRP/成本多币别口径 | 一律本位币（有意的口径选择，非缺陷） |

---

## 六、落地过程中验证过的坑（对后续改造仍有参考价值）

1. **冒烟测试必须打真实写入路径**：`base_balance` 隐患当时冒烟全绿，是因为测试数据手工 INSERT 显式带了值，真实路径（deploy_69 自动生成 + 财务页手工新增）全都落到 0。手工 INSERT 会掩盖「默认值掩盖缺失赋值」整类 bug。
2. **`CREATE OR REPLACE FUNCTION` 不能改参数列表**：`settle_ar_ap` 加第 8 参必须 DROP 旧签名再 CREATE + 重建 GRANT + 同步所有调用方，否则旧调用静默命中旧函数。
3. **容器给新函数白送 anon/authenticated 的 EXECUTE**：`REVOKE ... FROM PUBLIC` 拦不住，必须 `FROM PUBLIC, anon, authenticated`；同理新表自动获 `arwdDxtm`，列级 GRANT 收窄前必须先 `REVOKE ALL ON 表`。
4. **PERMISSIVE RLS 的 super_admin 分支不限 tenant_id** → 超管跨租户可见/可改，需补 RESTRICTIVE 策略（deploy_67 模板）；加之前确认写该表的函数都是 SECURITY DEFINER 且 owner=postgres。
5. **PostgREST 错误是普通对象不是 `Error`** → 统一用 `extractErrorMessage()`，否则 409/422 全退化 500。
6. 部署脚本仍需同步两处（`000_run_all.local.sh` ORDER 数组 + `000_run_all_in_order.psql.sql`）；`supabase db reset` 与部署绑同一条命令。

---

## 附：关键位置索引（更新）

```
主数据表/函数   supabase/tables/deploy_65_currency_master.sql
币别菜单        supabase/tables/deploy_66_currency_menu.sql
租户可见性修复  supabase/tables/deploy_67_currency_tenant_scope.sql
单据双金额列    supabase/tables/deploy_68_document_currency_columns.sql
入库折汇/应收生成 supabase/tables/deploy_69_post_stock_base_currency.sql
6603 科目       supabase/tables/deploy_71_finance_fx_subject.sql
财务双金额列    supabase/tables/deploy_72_finance_double_amount_columns.sql
凭证过账/核销重写 supabase/tables/deploy_73_finance_fx_settlement.sql
期末调汇        supabase/tables/deploy_74_finance_fx_revaluation.sql
报表视图        supabase/tables/deploy_75_finance_report_currency_views.sql
                supabase/tables/deploy_77_finance_report_currency_dimension.sql
service 入口    supabase/tables/deploy_76_service_role_finance_identity.sql
base_balance 守卫 supabase/tables/deploy_78_ar_ap_base_balance_guard.sql
前端金额工具    src/utils/money.ts ｜ src/components/MoneyInput.tsx
币别管理页      src/pages/system/Currencies.tsx
AI 财务入口     ai-server/src/api/finance.routes.ts
细节手册        .workbuddy/memory/ARCHITECTURE.md 第八节
```
