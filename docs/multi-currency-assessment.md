# 多币别（Multi-Currency）支持改造评估

> 评估对象：`supabase-erp` 全栈（`supabase/tables` 66 步部署脚本 + `src` 前端 + `ai-server`）
> 评估时间：2026-10-03

## 一、结论

**当前不支持多币别。** 现状是「单据上有一个币种下拉框 + 两个从未被写入的列」，属于**半成品外壳**：

- 全库只有 4 张表有 `currency` / `exchange_rate` 字段，且 `exchange_rate` **没有任何一处代码读或写**（除了从 `DEFAULT 1` 继承）。
- 前端 20 个页面里 **约 60 处硬编码 `¥`**，金额一律按人民币渲染。
- 财务报表 / 总账 / 凭证 **完全没有币种概念**，所有 `SUM(amount)` 事实上都在跨币种求和。
- 会计科目表**没有汇兑损益科目**。
- 「财务设置」里的 `baseCurrency` 配置项**全库无人消费**（只有两条种子数据 + 一个前端输入框）。

一句话：**从主数据 → 单据 → 库存成本 → 财务凭证 → 报表 → UI，整条链路都按单一货币（CNY）硬编码，币种下拉框是一个断头路。**

---

## 二、现状盘点

### 2.1 已有的（4 张表）

| 表 | 字段 | 实际行为 |
|---|---|---|
| `erp_sales_orders_s_539dcf81_b` | `currency` / `exchange_rate` | 前端下拉可填币种；`exchange_rate` 无录入控件，恒为 1 |
| `erp_purchase_orders_s_539dcf81_b` | `currency` / `exchange_rate` | 同上 |
| `erp_receivables_s_539dcf81_b` | `currency` / `exchange_rate` | 前端页面**不显示也不填写**，恒为默认值 |
| `erp_payables_s_539dcf81_b` | `currency` / `exchange_rate` | 同上；自动生成时**硬编码 `'CNY', 1`** |

字段定义位置：`supabase/tables/deploy_01_schema_and_seed.sql:467-468`（应收）、`:492-493`（应付）、`:698-699`（采购订单）、`:783-784`（销售订单）。
硬编码位置：`deploy_13_stock_posting_rpc.sql:282`、`deploy_34_outbound_inbound_location.sql:326`（采购入库过账自动生成应付）。

### 2.2 断链点（按数据流）

| 链路环节 | 现状 | 位置 | 缺什么 |
|---|---|---|---|
| **币别主数据** | 不存在 | — | 无币别表、无汇率表；币种是前端硬编码的 3 个 `<Option>` |
| **往来单位** | 客户/供应商无结算币别 | `deploy_01:276-322` | `settlement_currency`、`price_currency` |
| **物料价格** | `purchase_price`/`sale_price`/`cost_price` 无币别标识 | `deploy_01:573-598` | 价格币别（或明确一律本位币） |
| **SO/PO → 出库/入库** | 币种不随流转传递 | `deploy_35_doc_flow_engine.sql:968-990` 的 `doc_flow_field_maps` 里**没有 `currency` 映射** | 字段映射补 `currency` + `exchange_rate` |
| **入库/出库单本身** | 无币种列 | `erp_purchase_receipts`、`erp_sales_deliveries`、`erp_material_issues`、`erp_production_receipts` | `currency` + `exchange_rate` + 本位币金额 |
| **库存成本** | `unit_cost`/`total_cost` 单值，无币种语义 | `erp_inventory`、`erp_inventory_transactions` | 明确为**本位币**口径 + 入库时折汇 |
| **应收应付** | 有列但不写；来源链断 | `deploy_13` / `deploy_34` | 从来源单据继承币种与汇率 |
| **应收账款来源** | **销售出货不自动生成应收**，只能财务页手工建 | `src/pages/finance/Receivables.tsx` | 需先补自动生成，币种才有处继承 |
| **核销** | 直接吃 `p_amount`，直接减 `balance` | `deploy_20_depreciation_and_settlement.sql:126-200` | 核销汇率 + 汇兑损益 + 借贷不平校验 |
| **凭证 / 总账** | 无币种、无双金额 | `erp_vouchers` / `erp_voucher_details` / `erp_gl_entries`（`deploy_01:359-431`） | `currency` + 原币金额 + 本位币金额 |
| **财务报表视图** | 全部 `SUM(debit/credit)` 无币种 | `deploy_18_finance_reporting_views.sql` | 本位币口径 + 原币维度 |
| **会计科目** | 只有 1001/1002/1122/1602/2202/6601/6602 | `deploy_21_finance_required_subjects.sql:18-24` | **缺 6603 财务费用—汇兑损益** |
| **配置** | `finance.baseCurrency` 存在但无人读 | `deploy_01:200` / `deploy_07:28` / `Settings.tsx:115` | 需 `current_base_currency()` 统一取值函数 |
| **前端展示** | ~60 处硬编码 `¥` | 20 个页面（见 §3.5） | 统一 `formatMoney` + `MoneyInput` |
| **AI / MRP 金额** | 硬编码 CNY | `aiCreateTools.ts:193,216`、`entityRegistry.ts:271,282`、`mrpConvertService.ts:339-340` | 由币别主数据/本位币配置驱动 |

---

## 三、改造清单

### 3.1 主数据层（新建 + 加列）

**新建 2 张表**

| 表 | 关键列 | 说明 |
|---|---|---|
| `erp_currencies_s_539dcf81_b` | `code`(USD)、`name`、`symbol`、`decimal_places`、`is_base`、`status` | 币别主数据；建议预置 CNY/USD/EUR/HKD/JPY |
| `erp_exchange_rates_s_539dcf81_b` | `currency_code`、`rate_type`、`effective_date`、`rate`、`source` | 汇率；`UNIQUE(tenant_id, currency_code, rate_type, effective_date)` |

**加列**

- `erp_customers` / `erp_suppliers` → `settlement_currency`、`price_currency`
- `erp_products` → `price_currency`（或明确：物料价格一律本位币，则不加）
- 新增函数 `current_base_currency()`，统一读 `sys_config.finance.baseCurrency`，全库只此一处取值

### 3.2 单据层（补币种 + 汇率 + 本位币金额）

**新增币种列的实体**（当前完全没有）：

`erp_purchase_receipts`(+`_details`)、`erp_sales_deliveries`(+`_details`)、`erp_material_issues`(+`_details`)、
`erp_production_receipts`、`erp_mrp_requirements`、`erp_mrp_plans`、`erp_fixed_assets`、
`erp_depreciation_records`、`erp_ar_ap_settlements`

**已有列但需补本位币金额的实体**：`erp_purchase_orders`、`erp_sales_orders`、`erp_receivables`、`erp_payables`

**每张表建议统一加 3 类列**：

```
currency          VARCHAR(10)   -- 原币
exchange_rate     DECIMAL(10,6) -- 原币→本位币，冻结在单据上（不随主数据变动）
base_total_amount DECIMAL(18,2) -- 本位币金额（表头）
```

> ⚠️ **明细行也必须双金额**：行金额 = 数量 × 原币单价，换算到本位币后**逐行四舍五入**，与表头折算的差额必须由表头吸收（否则借贷不平）。

### 3.3 成本 / 库存层

- **明确口径：库存成本一律本位币**（多币种库存估值与移动加权平均不兼容）。
- `post_stock_document`（`deploy_13` / `deploy_34`）采购入库分支：当前 `v_unit_cost` 直接取单据原币单价 → 需改为 `v_unit_cost * COALESCE(h.exchange_rate, 1)` 后再入库存与流水。
- 销售出货成本取移动加权（已是本位币）→ **无需改**；但生成的应收/凭证要双币记录。
- 生产领料/完工入库同理：物料成本取本位币移动加权。
- `mrpConvertService.ts` / `costRollupService.ts` 一律本位币口径，MRP 采购建议金额 = 数量 × `erp_products.purchase_price`（本位币）。

### 3.4 财务层

| 改造项 | 具体动作 |
|---|---|
| 应收应付继承币种 | 改 `deploy_13:282` / `deploy_34:326` 的硬编码 `'CNY', 1`，改为取来源单据 |
| 补应收自动生成 | SO / 销售出货 → 应收（否则币种无来源；这是既有缺口，建议顺带补） |
| 核销双币 | `settle_ar_ap` 增加核销汇率与核销本位币金额 |
| **汇兑损益** | 核销汇率 ≠ 单据汇率时，差额进 6603；并加借贷平衡校验 |
| 科目补充 | `deploy_21` 补 `6603 财务费用—汇兑损益`（走「必备科目」幂等守卫） |
| 凭证 / 总账双金额 | `erp_voucher_details`、`erp_gl_entries` 加 `currency` + `amount_fc`（原币）+ 现有 `debit/credit_amount` 明确为本位币 |
| 期末调汇（可选） | 独立 RPC + `erp_fx_revaluation` 记录表，按期末汇率重估外币货币性项目 |
| 报表视图 | `deploy_18` 全部视图明确本位币口径；另加「原币余额」视图 |

### 3.5 前端 / i18n / AI

- **抽公共工具**：新建 `src/utils/money.ts` → `formatMoney(value, currency, locale)`、`MoneyInput`（prefix 随币种）。
  替换 **20 个文件约 60 处** `¥`：`inventory/{SalesOrders 7, PurchaseOrders 7, PurchaseReceipts 4, SalesDeliveries 4, InventoryTransactions 3, Inventory 3, Products 2}`、`finance/{Vouchers 5, SubjectLedger 5, TrialBalance 3, FixedAssets 2, Payables 2, Receivables 2, GeneralLedgerBalance 2}`、`mrp/{CostCalculations 6, MrpPlans 2, MaterialIssues 1, ProductionReports 1, ProductionReceipts 1}`、`Workbench.tsx 1`。
- **币种下拉改为读主数据**：`SalesOrders.tsx:734-739`、`PurchaseOrders.tsx:810-822`（现硬编码 CNY/USD/EUR 三项）。
- **汇率联动**：选中非本位币后显示汇率输入框（默认当日汇率、可覆盖），并在表单实时展示「折合本位币 X」。
- **列表/报表加列**：原币金额 + 本位币金额 + 币种三列（凭证、应收应付、试算平衡、科目余额）。
- **AI 层**：`src/utils/aiCreateTools.ts:193,216`、`ai-server/src/tools/entityRegistry.ts:271,282`、`ai-server/src/services/mrpConvertService.ts:339-340` 的 `'CNY'`/`1` 改由本位币配置与来源单据决定。
- **i18n**：新增 `currency.*` 命名空间（币别名称、原币/本位币、汇率、汇兑损益…），zh-CN / en-US 必须同键数（当前各 2828）。

### 3.6 配置与部署（本项目特有的必做项）

1. **部署脚本**：新建 `deploy_65_*.sql`，编号顺延（当前 66 步）。
2. **必须同步两处**：`000_run_all.local.sh` 的 ORDER 数组 + `000_run_all_in_order.psql.sql` 的 `\i` 行。
3. **RLS 选择**：币别/汇率属**主数据/模板类** → `template_scope_visible`，**物化租户必须靠副本**，不能只建基线行；且要遍历 `metadata_materialized` 租户跑 `clone_platform_baseline_to_tenant`，结尾加 `RAISE EXCEPTION` 自检。
4. **菜单三步**：基线 `sys_menus` 行（用 `WHERE NOT EXISTS` 守卫，该表无 `(tenant_id, menu_code)` 唯一索引，**不能用 ON CONFLICT**）+ 基线授权 + clone。
5. **前端菜单**：`App.tsx` 加路由 → `ProLayout.tsx` 的 `pathToTranslationKey` 加映射（漏登记英文界面会露中文）。
6. **改现有函数的坑**：改 `post_stock_document` / `settle_ar_ap` 时，务必按 42P10 规则核对 `ON CONFLICT` 列组（须含 `tenant_id`，部分唯一索引还要带 WHERE 谓词）。
7. **新表权限**：新表自动获 `arwdDxtm`；汇率表若只允许读，需先 `REVOKE ALL` 再用列级 `GRANT`，否则形同虚设。

---

## 四、需要拍板的 4 个设计决策

| # | 决策 | 建议 |
|---|---|---|
| 1 | **双金额 vs 单金额+汇率反算** | 采用「原币金额 + 本位币金额双列，汇率冻结在单据上」。仅靠汇率反算会因逐行四舍五入对不上账 |
| 2 | **库存成本口径** | 库存**一律本位币**（多币种库存估值与移动加权平均不兼容）→ 采购入库必须折汇 |
| 3 | **汇率口径** | 需定：汇率类型（即期/月初/自定义）、是否区分买入/卖出/中间价、精度（现为 `DECIMAL(10,6)`）。⚠️ 同时**必须写死方向**：是「外币→本位币」还是「本位币→外币」，两种口径都有系统在用，混用会有数量级错误 |
| 4 | **汇兑损益确认时点** | 会计上核销差额与期末调汇都要做；建议第 3 期先只做核销差额，期末调汇留作可选 |

---

## 五、分期建议

| 期 | 范围 | 完成后的状态 |
|---|---|---|
| **第 1 期 · 骨架**（不动金额口径） | 币别 + 汇率主数据表与页面、`current_base_currency()`、前端 `formatMoney` / `MoneyInput`、全站替换 `¥` | 所有单据仍是 CNY，界面行为不变，但地基就位；后续改造不再零散改 UI |
| **第 2 期 · 单据 + 成本** | SO/PO 币种+汇率录入与冻结；出入库/领料/完工单补币种；`post_stock_document` 折本位币入库成本；AR/AP 继承来源币种；补 SO→应收自动生成 | 业务单据可真正用外币成交，成本按本位币入账 |
| **第 3 期 · 财务** | 凭证/总账双金额；核销汇兑差额 + 补 6603 科目；报表补币种维度与本位币口径 | 账务层面闭环，试算平衡不被币种打破 |
| **第 4 期 · 增强（可选）** | 多币别定价（物料/客户币别）、汇率自动取数、期末调汇、MRP/成本的多币别口径 | — |

---

## 六、风险与坑

1. **历史数据迁移**：已过账的单据 / 库存流水 / GL 应一次性认定为 `CNY @ 1`，`UPDATE ... SET base_* = *` 补齐。**已过账单据不得改写**，否则期初对不上。
2. **反过账必须按原汇率回冲**，不能用当日汇率（本项目 `reverse_stock_document` / `reverse_production_document` 都要一并处理）。
3. **精度**：本币 `DECIMAL(18,2)` 够用，但原币需按币别定小数位（JPY 0 位、BHD 3 位），单价维持 `DECIMAL(18,4)`；`finance.amountPrecision: 2` 配置需按币别扩展。
4. **跨单据汇总会静默串币**：工作台、BAQ、AI 分析工具里所有金额汇总，一旦金额带上币种，都必须显式折算本位币，否则是在把 USD 和 CNY 相加且**不会报错**。
5. **过账幂等键与币种**：`post_stock_document` 等函数的幂等判断不包含币种/汇率，若允许过账后改汇率会破坏幂等语义 → 汇率应冻结、过账后不可改。
6. **AI 写库路径**：`ai-server` 用 service_role（BYPASSRLS），新增币种字段后所有服务端写入都必须显式带 `currency` / `exchange_rate`，否则会取到默认值 `CNY/1` 而**静默产生错误账务**。

---

## 附：本次评估涉及的关键位置索引

```
主数据/配置   supabase/tables/deploy_01_schema_and_seed.sql:200,276-322,573-598
已有币种列    supabase/tables/deploy_01_schema_and_seed.sql:467-468,492-493,698-699,783-784
硬编码 CNY    supabase/tables/deploy_13_stock_posting_rpc.sql:282
              supabase/tables/deploy_34_outbound_inbound_location.sql:326
流转映射缺失  supabase/tables/deploy_35_doc_flow_engine.sql:968-990
核销          supabase/tables/deploy_20_depreciation_and_settlement.sql:126-200
凭证/总账      supabase/tables/deploy_01_schema_and_seed.sql:359-431
报表视图      supabase/tables/deploy_18_finance_reporting_views.sql
科目缺汇兑损益 supabase/tables/deploy_21_finance_required_subjects.sql:18-24
前端币种下拉   src/pages/inventory/SalesOrders.tsx:734-739
              src/pages/inventory/PurchaseOrders.tsx:810-822
前端 AI 默认  src/utils/aiCreateTools.ts:193,216
后端 AI 默认  ai-server/src/tools/entityRegistry.ts:271,282
              ai-server/src/services/mrpConvertService.ts:339-340
```
