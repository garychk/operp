# 页面设计器（PageDesigner）说明文档

> 源码位置：`src/features/page-builder/`
> 主文件：`PageDesigner.tsx`（616 行）
> 配套文件：`types.ts`、`api.ts`、`PageRenderer.tsx`、`page-builder.css`
> 最后更新：2026-09-27

---

## 1. 一句话定位

页面设计器是一个**运行期、低代码的仪表盘/自定义页面搭建工具**：管理员无需改代码，通过"拖组件 → 配数据 → 发布"三步，就能在 Supabase ERP 里生成一个带侧边栏菜单入口的数据看板页面。

它把"页面布局 + 取数逻辑 + 菜单权限"三者打包成一个可持久化的 JSON 配置，存进 `sys_custom_pages` 表，由 `CustomPageRenderer` 在运行期解释渲染。

---

## 2. 在系统中的位置

| 维度 | 值 |
| --- | --- |
| 访问路径 | `/system/page-designer` |
| 路由注册 | `src/App.tsx:148` → `<Route path="page-designer" element={<PageDesigner />} />` |
| 菜单注册 | `supabase/tables/deploy_08_custom_pages.sql` 自动插入 `sys_menus`，`menu_code='page_designer'`，默认授权给 `super_admin` |
| 发布后的访问路径 | `/custom/:slug` → `CustomPageRenderer`（`src/App.tsx:152`） |
| 依赖的外部模块 | `features/baq`（BAQ 查询引擎）、`utils/supabase` |
| 数据表 | `sys_custom_pages`（页面配置）、`sys_menus`（发布时生成的菜单） |

### 数据流全景

```
                    ┌──────────────── PageDesigner.tsx（编辑态）────────────────┐
  组件面板           │                                                          │
  8 种 Widget ──addWidget──┐                                                    │
                           ▼                                                    │
  页面下拉 ◄──listCustomPages── sys_custom_pages ──────┐                        │
                           │                          │                        │
                    page.config.widgets[]              │                        │
                    （内存中的单一数据源）              │                        │
                           │                          │                        │
      ┌────────────────────┼──────────────────┐       │                        │
      ▼                    ▼                  ▼       │                        │
  属性面板            PageCanvas           预览 Drawer │                        │
  patchWidget()      （可拖拽 12 栅格）    （只读态）  │                        │
      │                    │                          │                        │
      │            onLayoutChange                     │                        │
      │            updateLayout()                     │                        │
      └────────────────────┴──────────────────────────┤                        │
                                                      │                        │
   保存草稿 saveCustomPage ────────────────────────────┤                        │
   发布   publishCustomPage ──► sys_custom_pages       │                        │
                              └► sys_menus（新建/更新）│                        │
                              └► dispatchEvent('custom-pages-changed')         │
                                                      ▼                        │
                                        ProLayout 监听事件 → 刷新菜单树         │
                                                                               │
   运行期：/custom/:slug → CustomPageRenderer → getCustomPage(slug) → PageCanvas（只读）│
   组件内部 WidgetBody 按 dataSource.mode 取数：static / supabase / baq         │
                                                                               │
   └───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. UI 结构

三栏工作区（`page-builder.css` → `.designer-workspace`）：

```
┌────────────────────────────────────────────────────────────────────────┐
│  标题 │ [页面下拉] [预览] [保存] [发布]                                  │  ← Card.extra 工具栏
├──────────┬──────────────────────────────────────┬──────────────────────┤
│ 组件面板  │            画布 Canvas                │     属性面板          │
│ 190px    │        minmax(420px, 1fr)             │      270px           │
│          │                                       │                      │
│ [文本][指标]│   ┌─────────┐ ┌─────────┐          │  标题  [____]        │
│ [按钮][表格]│   │ Widget  │ │ Widget  │          │  内容  [____]        │
│ [折线][柱状]│   └─────────┘ └─────────┘          │  列X  [2] 行Y [0]   │
│ [饼图][分割]│   ┌──────────────────┐             │  宽W  [6] 高H [4]   │
│          │   │    Widget         │             │  ─── 数据源 ───      │
│ ─────────│   └──────────────────┘             │  [静态|Supabase|BAQ] │
│ 页面名称  │                                       │  ...                │
│ [______] │   网格背景 24px、12 列栅格             │            [🗑 删除] │
│ 页面描述  │   拖拽把手 = Card header             │                      │
│ [______] │                                       │                      │
└──────────┴──────────────────────────────────────┴──────────────────────┘
```

- 窄屏（≤1000px）：属性面板换行到整行底部（CSS 媒体查询）。
- 画布在无组件时显示 `Empty` 空状态。

---

## 4. 核心能力清单

### 4.1 页面管理

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| 新建页面 | `emptyPage()` | 名称「未命名页面」，slug 为 `page-<时间戳>`，状态 `draft`，widgets 为空 |
| 切换页面 | 顶部 `Select`（宽 220px） | 选项 = `新建页面` + 已保存页面列表；已发布页面标签追加 `· 已发布` |
| 编辑元信息 | 左栏两个 `Input` | 页面名称、页面描述（**仅存草稿态，发布弹窗里再确认一次**） |
| 列表加载 | `refresh()` → `listCustomPages()` | 按 `updated_at` 倒序，过滤 `is_deleted='n'`；失败仅 toast 提示 |

### 4.2 组件面板（Palette）

支持 8 种 Widget（`types.ts` → `WidgetType`）：

| 类型 | 名称 | 默认尺寸 (w×h) | 默认静态数据 |
| --- | --- | --- | --- |
| `text` | 文本 | 4×2 | 无（`content` 直接渲染） |
| `statistic` | 指标卡 | 3×3 | `[{label:'本月销售额', value:128600}]` |
| `button` | 按钮 | 2×2 | 无（`content` 作按钮文案） |
| `table` | 数据表格 | 6×4 | 2 行示例数据，分页 10 条 |
| `line` | 折线图 | 6×4 | 一月/二月/三月 |
| `column` | 柱状图 | 6×4 | 华东/华南/华北 |
| `pie` | 饼图 | 5×4 | 已完成/进行中/待处理（环形，`innerRadius=0.55`） |
| `divider` | 分割线 | 6×1 | 无（`dividerText` 作标题文字） |

**添加逻辑**（`addWidget`）：

```ts
const widget = { ...widgetDefaults[type], id: `${type}-${Date.now()}`, type, x: 0, y: Infinity };
```

`y: Infinity` 是 react-grid-layout 的惯用法——新组件自动落到画布最底部，避免覆盖已有组件。添加后自动选中，属性面板立即展开。

> ⚠️ 注意：id 用 `Date.now()` 生成，同一毫秒内连续点击两次会产生**重复 id**，导致栅格布局错乱。

### 4.3 画布与布局

画布由 `PageCanvas`（`PageRenderer.tsx:156`）承载：

- 底层 `react-grid-layout` + `WidthProvider` 做宽度自适应。
- **12 列栅格**，`rowHeight=48`，`margin=[12,12]`。
- 编辑态：`isDraggable` / `isResizable` 开启，容器加 `.is-editing` 类，拖拽把手限定为 `.widget-drag-handle`（即 Card 的 header），避免在内容区误拖。
- 只读态：不可拖拽/缩放，文本/按钮/分割线渲染为无边框「裸卡片」（`.page-widget-plain`）。
- 布局变更通过 `onLayoutChange → updateLayout()` 回写每个 widget 的 `x/y/w/h`。
- 约束：`minW=2`、`minH=2`；属性面板中 `w`、`h` 可输入 2–12，`x` 上限为 `12 - w`（改宽度时自动 clamp `x`）。

### 4.4 属性面板（表单化配置）

选中组件后展开，未选中显示 `Empty`。

**通用属性**

- 组件标题（所有类型）
- 内容（`text` / `button` 写 `content`；`divider` 写 `dividerText`）
- 位置：列 X（0 ~ 12-w）、行 Y（≥0）
- 尺寸：宽 W（2–12）、高 H（2–12）

**分割线专属**（6 项）

- 虚线开关（Segmented 是/否）
- 方向：`horizontal` / `vertical`；切到 vertical 时清空 `titlePlacement`
- 标题位置：`start` / `center` / `end`（水平方向下生效）
- 线型：`solid` / `dashed` / `dotted`

**表格专属**

- 每页条数 `pageSize`（1–100，默认 10）
- 最大记录数 `dataSource.limit`（1–10000，默认 100）

**图表专属**（statistic / line / column / pie）

- X 轴字段 `xField`（饼图该项为分类字段 `colorField`）
- 数值字段 `yField`
- statistic 取 `data[0]` 的对应字段渲染 `Statistic` 组件

**数据源配置**（核心）

三种模式，用 `Segmented` 切换：

| 模式 | 配置项 | 运行期取数 |
| --- | --- | --- |
| `static` | JSON 数组文本框（6 行，`JSON.stringify(...,null,2)` 展示） | 直接用 `staticData`，按 `limit` 截断 |
| `supabase` | 表名 `table`、查询字段 `select`（默认 `*`） | `supabase.from(table).select(select).limit(limit)` |
| `baq` | 选择已发布的 BAQ 查询（`Select` + 搜索，展示 `名称 (code)`） | `executeBaq(baqCode, 1, limit)` |

JSON 编辑采用**即时解析 + 失焦校验**：`onChange` 尝试 `JSON.parse` 并静默失败，`onBlur` 时才报错（`pageDesigner.invalidJsonArray`），避免边打字边弹错。

BAQ 下拉数据来自 `listBaqs(true)`（仅已发布），组件挂载时加载一次，失败静默忽略。

### 4.5 预览

- 点击「预览」打开 `Drawer`，宽度 90%，标题 `pageDesigner.previewTitle`（带页面名）。
- 内部复用 `PageCanvas`，但不传 `editable`，即**真正的运行期渲染效果**——数据源会真实发起 Supabase / BAQ 请求。
- 这是验证取数配置是否正确的主要手段。

### 4.6 保存与发布

**保存草稿**（`save`）

```
saveCustomPage(page) → 有 id 走 update，无 id 走 insert → setPage(saved) → toast「草稿已保存」→ refresh()
```

payload 只写 `name / slug / description / status / config / updated_at`。

**发布**（`publish` → `publishCustomPage`）

1. 先 `saveCustomPage({...page, status:'published'})` 落库。
2. 拼装菜单记录：
   - `parent_id: 0`（顶级菜单）
   - `menu_name` = 页面名，`menu_code` = `custom_<slug>`
   - `menu_type: 'C'`，`icon: 'DashboardOutlined'`
   - `path` = `/custom/<slug>`，`component: 'CustomPageRenderer'`
   - `sort_order: 90`，`status: '1'`
3. 菜单已存在（`menu_id` 或按 `menu_code` 查到）→ 更新；否则插入，并回写 `sys_custom_pages.menu_id`。
4. `window.dispatchEvent(new Event('custom-pages-changed'))` —— `ProLayout.tsx:662` 监听该事件刷新菜单树，**发布后侧边栏立刻出现入口，无需刷新页面**。

**发布弹窗表单**

| 字段 | 校验 |
| --- | --- |
| 菜单及页面名称 | 必填 |
| 页面路径 slug | 必填 + `/^[a-z0-9-]+$/`，输入框前缀 `/custom/` |
| 描述 | 选填 |

弹窗顶部有 `Alert` 提示 `pageDesigner.publishHint`。

---

## 5. 数据模型

```ts
// types.ts
type WidgetType = 'text'|'statistic'|'button'|'table'|'line'|'column'|'pie'|'divider';

interface DataSourceConfig {
  mode: 'static' | 'supabase' | 'baq';
  table?: string;        // supabase 模式：表名
  select?: string;       // supabase 模式：字段串，默认 '*'
  baqCode?: string;      // baq 模式：查询 code
  limit?: number;        // 取数上限，默认 100
  staticData?: unknown[];
}

interface PageWidget {
  id: string; type: WidgetType; title: string;
  x: number; y: number; w: number; h: number;      // 栅格坐标
  content?: string; dividerText?: string;
  dashed?: boolean;
  titlePlacement?: 'center'|'start'|'end';
  orientation?: 'horizontal'|'vertical';
  variant?: 'dashed'|'dotted'|'solid';
  xField?: string; yField?: string; colorField?: string;
  pageSize?: number;
  dataSource: DataSourceConfig;
}

interface CustomPage {
  id?: number; name: string; slug: string;
  description?: string | null;
  status: 'draft' | 'published';
  menu_id?: number | null;
  config: { widgets: PageWidget[] };
  created_at?: string; updated_at?: string;
}
```

### 表结构（`sys_custom_pages`）

```sql
id SERIAL PK, corp_id, emp_id,
name VARCHAR(100) NOT NULL,
slug VARCHAR(100) NOT NULL UNIQUE,
description TEXT,
status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','published')),
menu_id INTEGER REFERENCES sys_menus(id) ON DELETE SET NULL,
config JSONB NOT NULL DEFAULT '{"widgets":[]}',
is_deleted CHAR(1) DEFAULT 'n',
created_at / updated_at TIMESTAMPTZ
```

RLS：authenticated 可读（`is_deleted='n'`），可全量管理。

---

## 6. 渲染侧协作（运行期）

`PageRenderer.tsx` 导出两个组件：

### `PageCanvas`

编辑态与运行态共用。差异：

| | 编辑态 `editable=true` | 运行态 |
| --- | --- | --- |
| 拖拽/缩放 | 开启（把手为 header） | 关闭 |
| 选中高亮 | `.page-widget.selected`（`outline: 2px solid var(--accent)`） | 无 |
| 裸卡片 | 无 | text/button/divider 去边框 |
| 卡片阴影 | 保留 | 去除 |

### `WidgetBody`

每个组件独立管理自己的取数状态（`data` / `loading` / `error` / `columnOrder`），`useEffect` 依赖 `widget.dataSource` 重新取数，并通过 `active` 标志防止竞态写入。

取数分支：

- `static` → 直接切片
- `supabase` → 表名空则提示 `pageRenderer.configureSupabaseTable`；否则查询，错误展示 `message (code)`
- `baq` → 未选 code 提示 `pageRenderer.baqNotSelected`；否则 `executeBaq(code, 1, limit)`

**表格列推断**：优先用 BAQ 返回的 `columns`（即查询定义里的 alias 顺序），否则取 `Object.keys(data[0])` 的**前 8 列**。

**图表尺寸**：`getChartHeight()` 由 `widget.h` 反推像素高（`(h*48 + (h-1)*12) - 44 - 48`，下限 180）；宽度用自建 `useElementWidth`（`ResizeObserver`，降级到 `window.resize`）测量后传给 `autoFit`。

### `CustomPageRenderer`

`/custom/:slug` 的落地页：按 slug 取页面 → 渲染标题 + 描述 + `PageCanvas`（只读）。加载中 `Skeleton`，失败 `Alert`。

---

## 7. 典型使用流程

以「搭一个销售看板」为例：

1. 进入 **系统管理 → 页面设计器**。
2. 顶部下拉保持「新建页面」，左栏填名称「销售看板」、描述。
3. 点击「指标」×3 → 画布出现 3 个指标卡（自动排到底部）。
4. 依次选中每个指标卡，右侧数据源切到 **BAQ**，选择对应的已发布查询；X 轴字段填 `label`，数值字段填 `value`。
5. 点击「折线图」「柱状图」，同样绑定 BAQ 或 Supabase 表，配置 `xField` / `yField`。
6. 点击「表格」，数据源选 `supabase`，表名 `sales_orders`，字段 `id,order_no,amount,status`；设置每页 20 条、上限 500。
7. 拖动各组件调整顺序，拖右下角调整大小，或在属性面板直接输入 X/Y/W/H 精确布局。
8. 点「预览」确认数据真实返回、图表尺寸合适。
9. 点「保存」存草稿（可反复迭代）。
10. 点「发布」→ 填名称、slug（如 `sales-dashboard`）→ 提交。
11. 侧边栏顶部立即出现「销售看板」菜单，点击访问 `/custom/sales-dashboard`。

---

## 8. 已知局限与改进建议

按影响程度排序，供后续迭代参考。

### 功能缺失

| 问题 | 位置 | 影响 | 建议 |
| --- | --- | --- | --- |
| **无页面删除能力** | `api.ts` 无 `deleteCustomPage` | 废弃页面只能直接改库 `is_deleted` | 补充软删除 + 列表管理入口 |
| **无撤销/重做** | `PageDesigner.tsx` | 误删组件无法恢复 | 引入 history 栈（immer + 命令模式） |
| **切换页面无脏检查** | `Select.onChange`（L166-173） | 未保存改动被静默丢弃 | 加 `isDirty` 比较 + 离开确认 |
| **无组件复制/层级/对齐** | — | 复杂布局搭建效率低 | 复制粘贴、吸附辅助线、置顶置底 |
| **无版本历史** | — | 发布后无法回滚 | 每次发布存快照表 |
| **无页面级权限** | RLS 只校验 authenticated | 任何登录用户可访问所有自定义页 | 增加 `role_menus` 授权或 corp/role 维度过滤 |
| **无多断点响应式布局** | 使用 `WidthProvider(GridLayout)` 而非 `Responsive*` | 手机端只是等比压缩，不能重排 | 引入 `ResponsiveGridLayout` + `layouts` 多档配置 |

### 数据能力

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| **Supabase 模式无过滤/排序/JOIN** | `PageRenderer.tsx:99-102` | 只能整表取前 N 条，实际业务价值有限；复杂取数必须走 BAQ |
| **BAQ 模式固定取第 1 页** | `executeBaq(code, 1, limit)` | 无法翻页，最多 `limit` 条（上限 10000） |
| **表格列按首行推断** | `PageRenderer.tsx:130` | 首行字段缺失或后续行字段更多时列会丢；硬编码最多 8 列 |
| **statistic 只取 `data[0]`** | `PageRenderer.tsx:150` | 多返回值场景只能显示第一条 |
| **无字段类型/格式化配置** | `PageWidget` | 金额、日期、百分比无法自定义格式化 |
| **无参数/筛选联动** | — | 组件之间不能联动（如点击图表过滤表格），无法做交互式看板 |

### 健壮性 & 体验

| 问题 | 位置 | 说明 |
| --- | --- | --- |
| **组件 id 可能重复** | `addWidget`：`${type}-${Date.now()}` | 同毫秒连续点击产生重复 id，栅格布局错乱。建议改用 `crypto.randomUUID()` 或递增计数器 |
| **分割线标题位置字段重复渲染** | L303-313 与 L332-346 | `orientation !== 'vertical'` 时页面上出现两个「标题位置」下拉，功能重复。应删除 L303 那一份 |
| **slug 唯一性未前置校验** | `publish` 弹窗 | 重名时直接抛 Supabase 唯一约束错误，提示不友好。应做 `slug` 查重或捕获特定错误码翻译 |
| **Supabase 直连表名无白名单** | `source.table` 自由输入 | 依赖 RLS 兜底；建议改为从 `sys_tables` 元数据下拉选择 |
| **`pages` 与 `page` 状态可能不同步** | `refresh()` 后 `page` 不刷新 | 保存后 `setPage(saved)` 已处理，但列表刷新存在竞态窗口 |
| **`console` 静默吞错** | `listBaqs(...).catch(() => undefined)` | BAQ 加载失败无任何提示，用户会看到空下拉却不知原因 |
| **图表高度硬编码推算** | `getChartHeight()` 里的 `44`/`48` 魔数 | Card header 高度变化会导致图表溢出 |
| **`rowHeight={editable ? 48 : 48}`** | `PageRenderer.tsx:159` | 三元表达式两边相同，冗余代码 |

### 安全

- `publishCustomPage` 直接写 `sys_menus`，**无权限校验**（仅靠 RLS）。应确认 RLS 策略是否限制到管理员角色，否则普通用户可自建顶级菜单。
- BAQ 与 Supabase 取数均在前端发起，数据可见范围完全由 RLS 决定，敏感表需确保策略完备。

---

## 9. 扩展指引

**新增一种 Widget 类型**，需改动 4 处：

1. `types.ts` → `WidgetType` 加枚举值；`widgetDefaults` 加默认配置（含 `w`/`h`/`dataSource`）。
2. `PageDesigner.tsx` → `palette` 数组加一项（type / label / icon）；如需专属属性，在属性面板加条件分支。
3. `PageRenderer.tsx` → `WidgetBody` 加渲染分支。
4. `src/locales/zh-CN.ts` 与 `en-US.ts` → 补 `pageDesigner.widgetXxx` 等文案（当前各约 64 条 `pageDesigner.*` / `pageRenderer.*` 键）。

**新增一种数据源模式**，需改动 3 处：

1. `types.ts` → `DataSourceConfig.mode` 加类型 + 相关字段。
2. `PageDesigner.tsx` → `Segmented` 加选项 + 对应的表单分支。
3. `PageRenderer.tsx` → `WidgetBody` 的取数 `useEffect` 加分支。

---

## 10. 附录：i18n 键位

全部文案走 `react-i18next`，命名空间前缀为 `pageDesigner.*`（设计器）和 `pageRenderer.*`（渲染/取数错误提示），中英文各约 64 条，定义在：

- `src/locales/zh-CN.ts`（`pageDesigner.*` 从 L1338 起）
- `src/locales/en-US.ts`

新增 UI 文案时两边需同步补齐，缺失时 `t()` 会直接回显键名。
