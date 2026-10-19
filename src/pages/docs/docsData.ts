/**
 * OPERP 使用手册 - 静态文档数据
 * 内容与 docs/OPERP使用手册.md 对齐；纯中文展示（暂不接 i18n）。
 * 注意：html 字段是可信内部内容，由 DocsSite 通过 dangerouslySetInnerHTML 渲染；
 * 书写时不要包含反引号与 ${，避免破坏模板字符串。
 */

export interface DocSection {
  /** 锚点 id，同时用于左侧分类菜单 # 链接定位 */
  id: string;
  title: string;
  html: string;
}

export interface DocCategory {
  title: string;
  sections: DocSection[];
}

export const docCategories: DocCategory[] = [
  {
    title: "产品介绍",
    sections: [
      {
        id: "overview",
        title: "系统概览",
        html: `
<p>OPERP 是一套面向制造企业的<strong>多租户、AI 原生 ERP 平台</strong>，覆盖财务、进销存、生产制造三大业务域，外加一个可配置的平台元数据底座。</p>
<p>它与传统 ERP 的最大区别在于：<strong>业务单据的形态、流转规则、审批规则不是写死的，而是配置出来的</strong>。你可以自己加字段、自己画审批流程、自己定义哪张单能转成哪张单，也可以让 AI 直接帮你建单、过账、转单。</p>
<h3>三大业务域</h3>
<table>
  <thead><tr><th>业务域</th><th>主要用途</th><th>典型角色</th></tr></thead>
  <tbody>
    <tr><td>财务管理</td><td>会计科目、凭证、总账、试算平衡、应收应付、固定资产</td><td>会计、财务主管</td></tr>
    <tr><td>进销存管理</td><td>主数据、采购、销售、库存收发存、调拨盘点、批次追溯</td><td>采购员、销售员、仓管</td></tr>
    <tr><td>生产制造</td><td>BOM、工艺路线、生产订单、领料报工、完工入库、MRP/MPS、成本核算、委外</td><td>计划员、车间主管、成本会计</td></tr>
    <tr><td>系统管理</td><td>用户、租户、角色、菜单、字典、币别、流程配置、报表设计</td><td>系统管理员</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "concepts",
        title: "六大核心概念",
        html: `
<p>理解以下六个概念，就理解了这套系统的设计思想：</p>
<table>
  <thead><tr><th>概念</th><th>一句话解释</th><th>在界面上的体现</th></tr></thead>
  <tbody>
    <tr><td>DocType 单据类型</td><td>一张单据是什么的元数据（表名、单号规则、是否可提交、绑定审批流）</td><td>系统管理 → DocType 构建</td></tr>
    <tr><td>Workflow 审批流</td><td>谁审批、按什么顺序审批，支持条件分支、多级审批、驳回撤回</td><td>系统管理 → 流程配置；单据顶部审批按钮</td></tr>
    <tr><td>DocFlow 单据转换</td><td>这张单能生成什么单，声明式字段映射 + 数量台账防超下推</td><td>单据顶部的「下推」按钮</td></tr>
    <tr><td>BAQ 业务活动查询</td><td>不写 SQL 的可视化查询设计器：ER 图式拖表勾字段，支持多级 / 多字段 / 非主外键关联，可作页面数据源</td><td>系统管理 → BAQ 管理</td></tr>
    <tr><td>页面设计器</td><td>拖拽组件拼页面，发布即成为菜单</td><td>系统管理 → 页面设计器</td></tr>
    <tr><td>AI 智能体</td><td>用自然语言查数据、建单、过账、转单、生成 BAQ</td><td>顶栏 AI 图标</td></tr>
  </tbody>
</table>
<h3>功能特点一览</h3>
<ul>
  <li><strong>AI 原生</strong>：不只是问答，能直接操作业务单据，且所有写操作都有两段式确认保护。</li>
  <li><strong>平台级元数据底座</strong>：单据类型、审批流、单据转换、查询、页面全部可配置。</li>
  <li><strong>多租户隔离</strong>：行级安全策略 + 表权限双层控制，租户之间数据物理隔离。</li>
  <li><strong>多币别核算</strong>：双金额记账、单据冻结汇率、库存凭证报表一律本位币。</li>
  <li><strong>批次追溯</strong>：批次档案、效期与冻结管理、上下游双向追溯。</li>
  <li><strong>打印模板自定义</strong>：内置打印设计器，按单据类型套打。</li>
  <li><strong>MCP 开放</strong>：可接入 Claude Desktop、WorkBuddy、Cursor 等外部 AI 客户端。</li>
</ul>`,
      },
      {
        id: "tenancy",
        title: "多租户与多币别",
        html: `
<h3>多租户</h3>
<p>一套系统服务多家企业。每家企业的数据<strong>物理隔离</strong>（数据库行级安全策略 + 表权限双层控制），互相看不见。新企业可通过登录页「注册租户」自助开通，系统自动物化该租户的菜单、角色、字典、币别等基线数据。</p>
<h3>多币别</h3>
<ul>
  <li>单据可同时记录<strong>原币金额</strong>与<strong>本位币金额</strong>，汇率在单据上<strong>冻结</strong>，后续汇率变动不影响已录单据。</li>
  <li>库存、凭证、报表一律按<strong>本位币</strong>核算；汇率方向恒为「1 单位外币 = rate 单位本位币」。</li>
  <li>本位币在「币别管理」中设定，<strong>全局唯一</strong>；切换后不会重算历史金额，请谨慎评估。</li>
  <li>汇兑损益包含核销差额与期末调汇，计入 6603（净借方为正表示损失）。</li>
</ul>`,
      },
    ],
  },
  {
    title: "快速上手",
    sections: [
      {
        id: "login",
        title: "登录与开通租户",
        html: `
<h3>登录</h3>
<table>
  <thead><tr><th>字段</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>邮箱</td><td>注册时使用的邮箱，即登录账号</td></tr>
    <tr><td>密码</td><td>至少 6 位</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 默认超管账号为 admin@operp.com / 123456，<strong>上线后请立即修改默认密码</strong>。</div>
<h3>自助开通企业租户</h3>
<p>登录页切换到「注册租户」页签，填写租户名称、租户编码（小写字母开头，仅含小写字母、数字、下划线或短横线，2~31 位）、管理员信息与邮箱密码。提交后系统自动完成：</p>
<pre class="docs-flow">注册登录账号 → 创建企业租户 → 在新租户下创建管理员 → 物化基线数据（菜单/角色/字典/币别/表权限）</pre>
<p>新租户默认角色为<strong>租户管理员</strong>，不会授予平台超管权限。</p>`,
      },
      {
        id: "ui",
        title: "界面总览",
        html: `
<h3>整体布局</h3>
<pre class="docs-flow">┌──────────────────────────────────────────────────────────────┐
│ Logo   顶部菜单(首页/财务/进销存/生产/系统)   [顶栏图标区][头像] │
├──────────────────────────────────────────────────────────────┤
│ 左侧二级菜单           │ 标签页（多开，可关闭/拖动排序）         │
│  ├ 会计科目            │ ┌──────────────────────────────────┐ │
│  ├ 凭证管理            │ │          当前页面内容             │ │
│  └ ...                 │ └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘</pre>
<p>点击左侧菜单会<strong>新开一个标签页</strong>（已开则激活）；顶栏提供菜单搜索，输入中文名回车直达。</p>
<h3>顶栏图标速查</h3>
<table>
  <thead><tr><th>图标</th><th>名称</th><th>作用</th></tr></thead>
  <tbody>
    <tr><td>🔍</td><td>菜单搜索</td><td>按名称搜菜单，回车直达</td></tr>
    <tr><td>🔔</td><td>通知中心</td><td>待审批、审批结果、库存预警、订单延期、任务完成；支持分类筛选与全部已读</td></tr>
    <tr><td>💰</td><td>订阅入口</td><td>查看当前租户的订阅方案与用量</td></tr>
    <tr><td>☀️ / 🌙</td><td>深浅色切换</td><td>浅色 / 深色模式，记忆在本地</td></tr>
    <tr><td>▤ / ▥</td><td>布局切换</td><td>顶部菜单 ↔ 纯侧边菜单</td></tr>
    <tr><td>🌐</td><td>语言切换</td><td>简体中文 / English</td></tr>
    <tr><td>🤖</td><td>AI 助手</td><td>打开 AI 对话抽屉</td></tr>
    <tr><td>🔌</td><td>MCP 接入指引</td><td>MCP 说明 + 「我的密钥」自助签发</td></tr>
    <tr><td>🎨</td><td>主题色 / 密度 / 圆角</td><td>6 套主题色、紧凑与宽松、圆角可调</td></tr>
    <tr><td>头像 ▾</td><td>个人菜单</td><td>个人工作台 / 退出登录</td></tr>
  </tbody>
</table>
<h3>首页与个人工作台</h3>
<ul>
  <li><strong>经营驾驶舱</strong>（菜单「首页」）：经营指标、图表看板。</li>
  <li><strong>个人工作台</strong>（头像下拉进入）：基本信息、租户信息、我的待办、统计卡片、通知列表。</li>
</ul>`,
      },
    ],
  },
  {
    title: "单据操作（核心）",
    sections: [
      {
        id: "doc-workbench",
        title: "单据工作台",
        html: `
<p>所有业务单据（采购、销售、库存、生产、财务）都遵循同一套操作范式，学会一张单就会用全部单据。打开单据后会弹出<strong>单据工作台</strong>：</p>
<pre class="docs-flow">┌ 标题 [展开/收起] [上一条/下一条] [审批按钮] [下推] [连接图] [P/D] [打印] ┐
│ ┌ 页签1：单头 ──────────┬ 操作日志（时间轴：谁/何时/做了什么）─┐ │
│ │  表头字段（两列布局）   ├ 审批历史（节点/审批人/意见/时间）────┤ │
│ ├ 页签2：明细 ──────────┴─────────────────────────────────────┤ │
│ │  明细表格 + 新增/编辑/删除明细行                              │ │
│ └ [底部：保存 / 取消 / 自定义动作] ────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘</pre>
<table>
  <thead><tr><th>控件</th><th>作用</th></tr></thead>
  <tbody>
    <tr><td>展开 / 收起</td><td>全屏与常规尺寸切换</td></tr>
    <tr><td>上一条 / 下一条</td><td>不关弹窗，直接在列表内翻单</td></tr>
    <tr><td>审批按钮</td><td>提交 / 通过 / 驳回 / 撤回</td></tr>
    <tr><td>下推</td><td>生成下游单据（见「单据转换」）</td></tr>
    <tr><td>单据连接图</td><td>查看本单上游来源与下游去向全链路</td></tr>
    <tr><td>P / D 开关</td><td>打印预览（Preview）/ 设计（Design）切换</td></tr>
    <tr><td>打印按钮</td><td>打开打印模板设计器，可自定义套打模板并保存</td></tr>
    <tr><td>Esc</td><td>关闭弹窗</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 明细数据在「明细」页签内维护，<strong>表头合计（总金额 / 总数量 / 总成本）由系统自动重算</strong>，无需手工填写。仓库选择后库位自动联动：切换仓库清空已选库位，单库位仓库自动带出。</div>`,
      },
      {
        id: "doc-status",
        title: "单据状态与生命周期",
        html: `
<h3>订单类（采购订单 / 销售订单）</h3>
<table>
  <thead><tr><th>状态</th><th>含义</th><th>可执行动作</th></tr></thead>
  <tbody>
    <tr><td>草稿</td><td>刚建，可随意改</td><td>编辑、删除、提交审批</td></tr>
    <tr><td>待审批</td><td>已提交，等待审批</td><td>通过 / 驳回 / 撤回</td></tr>
    <tr><td>已审批</td><td>审批通过，可下推</td><td>下推生成入库单 / 出货单</td></tr>
    <tr><td>部分收货 / 部分发货</td><td>下游单据已部分执行</td><td>继续下推剩余数量</td></tr>
    <tr><td>已收货 / 已发货</td><td>下游执行完毕</td><td>—</td></tr>
    <tr><td>已关闭 / 已取消</td><td>终止</td><td>—</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ <strong>订单类单据不可直接过账</strong>。订单只表达要买/要卖，实际出入库必须通过下推生成入库单/出货单后过账。</div>
<h3>出入库类（采购入库 / 销售出货 / 采购退货 / 销售退货）</h3>
<p>状态依次为：草稿 → 待审核 → 已审核 → <strong>已过账</strong>（或已取消）。</p>
<div class="docs-warn">⚠️ <strong>过账是库存与财务真正生效的分水岭</strong>。未过账的单据不产生库存流水，也不生成会计凭证；已过账单据锁定，需先反过账才能修改。</div>
<h3>凭证</h3>
<p>状态：草稿 / 已过账 / 已作废。过账前强制校验：<strong>至少两条分录</strong>、<strong>借贷双方金额均大于 0</strong>、<strong>借贷必须平衡</strong>，不平衡会直接拒绝并提示差额。</p>`,
      },
      {
        id: "doc-approval",
        title: "审批流操作",
        html: `
<p>单据工作台标题栏会根据当前状态显示对应按钮：</p>
<table>
  <thead><tr><th>当前状态</th><th>可用按钮</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>草稿 / 空</td><td>提交</td><td>提交后进入审批流第一节点</td></tr>
    <tr><td>待审批</td><td>通过 / 驳回 / 撤回</td><td>驳回与撤回会把单据退回</td></tr>
    <tr><td>其他状态</td><td>（无）</td><td>本节点已结束</td></tr>
  </tbody>
</table>
<ul>
  <li>审批结果<strong>自动回写单据状态</strong>，审批历史卡片可查看每个节点的审批人与意见。</li>
  <li>若该单据类型未配置审批流，会提示「未找到流程定义」，此时单据走简化路径（部分单据可直接点「审核」）。</li>
  <li>被驳回的单据可修改后重新提交。</li>
</ul>`,
      },
      {
        id: "doc-flow",
        title: "单据转换（下推）",
        html: `
<p><strong>下推 = 由一张单自动生成下游单据</strong>，并按规则带过去数量、物料、金额等字段。系统内置三条主线：</p>
<table>
  <thead><tr><th>源单</th><th>目标单</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>采购订单</td><td>采购入库单</td><td>收货入库</td></tr>
    <tr><td>销售订单</td><td>销售出货单</td><td>发货出库</td></tr>
    <tr><td>生产订单</td><td>生产领料单</td><td>按用料明细领料</td></tr>
  </tbody>
</table>
<h3>操作步骤</h3>
<ol>
  <li>打开已审批的源单（状态需在允许范围内，如已审批 / 部分收货）。</li>
  <li>点顶部「下推」按钮，弹出下推窗口。</li>
  <li>系统按<strong>可转数量</strong>预填每行数量（可手工调整），数量为 0 的行自动跳过。</li>
  <li>确认后生成<strong>目标单草稿</strong>，仍需审批 + 过账才会影响库存。</li>
</ol>
<h3>关键规则</h3>
<ul>
  <li><strong>防超下推</strong>：系统维护已转数量台账，累计已转不能超过源单数量。</li>
  <li><strong>台账只追加不删除</strong>：反冲通过插入负数行实现，任何一行源单都能追溯每一次转换与冲销。</li>
  <li>「单据连接图」可直观查看整条链路的上下游关系。</li>
</ul>`,
      },
      {
        id: "doc-print",
        title: "打印模板与附件日志",
        html: `
<h3>打印模板</h3>
<ul>
  <li>在单据工作台点「打印」按钮进入模板设计器。</li>
  <li>可用数据源：<strong>主表数据（MainData）+ 明细数据（DetailData）</strong>。</li>
  <li>支持纸张、方向、页边距、组件拖拽排版；P / D 开关切换预览与设计。</li>
  <li>保存后按<strong>单据类型</strong>复用：同一类型的所有单据使用同一套模板。</li>
</ul>
<h3>附件与操作日志</h3>
<table>
  <thead><tr><th>功能</th><th>位置</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>业务附件</td><td>单据工作台 / 详情区</td><td>上传合同、发票、质检报告等文件</td></tr>
    <tr><td>操作日志</td><td>单据工作台右侧时间轴</td><td>记录新增/修改/删除/过账/反过账等动作，含操作人、时间、失败原因</td></tr>
    <tr><td>系统日志</td><td>系统管理 → 系统日志</td><td>全站操作日志总览，可按类型、时间、操作人检索</td></tr>
  </tbody>
</table>`,
      },
    ],
  },
  {
    title: "财务管理",
    sections: [
      {
        id: "finance-pages",
        title: "财务页面一览",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>用途与要点</th></tr></thead>
  <tbody>
    <tr><td>会计科目</td><td>/finance/subjects</td><td>科目表（编码、名称、类别、方向），凭证与报表的基础</td></tr>
    <tr><td>凭证管理</td><td>/finance/vouchers</td><td>记账/收款/付款/转账四种凭证，支持多币种分录、过账与反过账</td></tr>
    <tr><td>总账余额</td><td>/finance/gl-balance</td><td>各科目期末余额，按期间查询</td></tr>
    <tr><td>试算平衡</td><td>/finance/trial-balance</td><td>借贷平衡校验，支持本位币与按币种双口径</td></tr>
    <tr><td>科目/明细账</td><td>/finance/ledger</td><td>单科目发生额与明细流水</td></tr>
    <tr><td>会计期间</td><td>/finance/periods</td><td>期间开闭管理，<strong>期间关闭后不可再记账</strong></td></tr>
    <tr><td>应收账款</td><td>/finance/receivables</td><td>客户应收台账：未结清 / 部分收款 / 已结清 / 逾期</td></tr>
    <tr><td>应付账款</td><td>/finance/payables</td><td>供应商应付台账：未结清 / 部分付款 / 已结清 / 逾期</td></tr>
    <tr><td>固定资产</td><td>/finance/assets</td><td>资产卡片、原值、折旧</td></tr>
    <tr><td>资产类别</td><td>/finance/asset-categories</td><td>资产分类与折旧规则</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "voucher",
        title: "凭证操作要点",
        html: `
<ol>
  <li>新增凭证：选择凭证类型、日期、期间，录入借方/贷方分录（至少两条）。</li>
  <li>涉及外币时，选择币种后系统按单据日期<strong>自动带出即期汇率</strong>；取不到汇率会提示并要求手工填写，<strong>不会按 1 静默处理</strong>。</li>
  <li>保存为草稿 → 过账。过账前强制校验借贷平衡。</li>
  <li>过账后凭证进入总账余额与试算平衡表。</li>
  <li>修改已过账凭证：先反过账（退回草稿）→ 修改 → 重新过账。</li>
</ol>`,
      },
      {
        id: "finance-posting",
        title: "自动凭证与多币别",
        html: `
<p>采购入库、销售出货、采购退货、销售退货、库存调拨、盘点、调整等库存单据<strong>过账时自动生成对应会计凭证</strong>并更新总账。</p>
<div class="docs-warn">⚠️ 重要规则：若会计侧出现问题（如未配置存货科目映射），系统<strong>不会阻断库存过账</strong>，而是给出警告并在返回结果中带上凭证信息。库存业务照常生效，但请及时处理会计侧提示，否则账实会不一致。</div>
<h3>多币别与汇兑损益</h3>
<ul>
  <li>双金额记账：单据同时记录原币与本位币金额，汇率冻结在单据上。</li>
  <li>汇率方向恒为「1 单位外币 = rate 单位本位币」。</li>
  <li>全站金额展示与输入统一走系统金额组件，符号与小数位跟随本位币设置。</li>
</ul>`,
      },
    ],
  },
  {
    title: "进销存管理",
    sections: [
      {
        id: "inv-master",
        title: "主数据",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>要点</th></tr></thead>
  <tbody>
    <tr><td>客户管理</td><td>/inventory/customers</td><td>客户编码、名称、联系人、等级；停用客户不参与新单据</td></tr>
    <tr><td>供应商管理</td><td>/inventory/suppliers</td><td>供应商维度同上</td></tr>
    <tr><td>物料管理</td><td>/inventory/products</td><td>编码/名称/规格/单位/分类，可维护物料图片；<strong>批次管理开关在此行</strong></td></tr>
    <tr><td>仓库管理</td><td>/inventory/warehouses</td><td>仓库 + 库位；仓库负责人取自员工主数据</td></tr>
    <tr><td>计量单位</td><td>/system/uoms</td><td>单位与单位组（换算），所有单据的单位下拉都读这里</td></tr>
    <tr><td>币别管理</td><td>/system/currencies</td><td>币别、汇率、本位币设定（全局唯一）</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 <strong>单位下拉为空？</strong>说明「计量单位」里没有数据。请到 系统管理 → 计量单位 维护，而不是去数据字典里找（字典里没有 uom 类型）。</div>`,
      },
      {
        id: "purchase",
        title: "采购业务",
        html: `
<pre class="docs-flow">采购订单 ──(审批)──> 采购入库单 ──(过账)──> 库存增加 + 应付账款
    └──> 采购退货单 ──(过账)──> 库存减少 + 冲减应付</pre>
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>采购订单</td><td>/inventory/purchase</td><td>建单 → 明细 → 提交审批 → 下推生成入库单</td></tr>
    <tr><td>采购入库</td><td>/inventory/purchase-receipts</td><td>可下推或直接新建；过账后库存增加并自动生成凭证</td></tr>
    <tr><td>采购退货</td><td>/inventory/purchase-returns</td><td>向供应商退货；过账后库存减少</td></tr>
  </tbody>
</table>
<h3>采购订单操作流程</h3>
<ol>
  <li>点「新增」→ 选择供应商、订单日期、币种、交货信息。</li>
  <li>新增明细行：选物料 → 自动带出单位 → 填数量、单价、税率 → 系统实时计算金额。</li>
  <li>保存（草稿）→ 提交 → 通过（审批完成）。</li>
  <li>点「下推」→ 生成采购入库单 → 仓库收货 → 提交/审核 → 过账。</li>
</ol>
<h3>采购入库要点</h3>
<ul>
  <li>物料启用批次管理时，入库明细必须填<strong>批次号</strong>（可自动建档）与<strong>有效期</strong>。</li>
  <li>表头合计由系统自动重算，无需手填。</li>
  <li>过账后单据锁定，如需修改必须先反过账。</li>
</ul>`,
      },
      {
        id: "sales",
        title: "销售业务",
        html: `
<pre class="docs-flow">销售订单 ──(审批)──> 销售出货单 ──(过账)──> 库存减少 + 应收账款
    └──> 销售退货单 ──(过账)──> 库存增加 + 冲减应收</pre>
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>销售订单</td><td>/inventory/sales</td><td>客户、订单日期、交货信息；支持预占库存</td></tr>
    <tr><td>销售出货</td><td>/inventory/sales-deliveries</td><td>出货明细显示可用库存；过账后扣减库存并生成凭证</td></tr>
    <tr><td>销售退货</td><td>/inventory/sales-returns</td><td>客户退货；过账后库存回补</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 <strong>预占库存</strong>：下达销售订单时可预占库存避免超卖。库存不足时预占现有部分并提示缺口数量，后续入库自动补齐。是否自动预占由系统设置控制。</div>`,
      },
      {
        id: "stock-ops",
        title: "库存日常作业",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td>库存查询</td><td>/inventory/stock</td><td>实时库存（按仓库/库位/物料/批次）</td></tr>
    <tr><td>库存流水</td><td>/inventory/transactions</td><td>每次库存增减的完整流水（方向、数量、成本、关联单据）</td></tr>
    <tr><td>库存调拨</td><td>/inventory/transfers</td><td>仓库/库位间移库；过账后自动生成凭证</td></tr>
    <tr><td>库存盘点</td><td>/inventory/stock-counts</td><td>盘点录入 → 盈亏 → 过账调整库存；已过账盘点单不可编辑</td></tr>
    <tr><td>库存调整</td><td>/inventory/stock-adjustments</td><td>手工调整数量/成本（盘盈盘亏、损耗等）</td></tr>
    <tr><td>其他出入库</td><td>/inventory/other-stock</td><td>非采购/销售/生产来源的出入库（赠送、样品、报废等）</td></tr>
    <tr><td>期初库存</td><td>/inventory/opening-balances</td><td>新客户开账用；一个仓库只允许一份已过账期初单</td></tr>
  </tbody>
</table>
<h3>期初库存特别说明</h3>
<ul>
  <li>期初默认<strong>不生成会计凭证</strong>（应体现在存货科目的期初余额里）。</li>
  <li>期初录入在报表中计入「期初」列，<strong>不计入本期收入</strong>。</li>
  <li>已过账期初单明细锁定；如需修改请先反过账。</li>
</ul>`,
      },
      {
        id: "batch",
        title: "批次管理与追溯",
        html: `
<p><strong>启用批次</strong>：物料管理 → 选中物料 → 打开「批次管理」开关（默认关闭）。</p>
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>批次管理</td><td>/inventory/batches</td><td>批次档案：批次号、生产日期、有效期、状态（正常/冻结）；可按已冻结筛选</td></tr>
    <tr><td>批次追溯</td><td>/inventory/batch-trace</td><td>查上游来源（谁生产/哪批采购）与下游去向（卖给谁/用在哪个工单）</td></tr>
  </tbody>
</table>
<h3>批次规则</h3>
<table>
  <thead><tr><th>规则</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>批次必填</td><td>启用批次管理的物料，出入库明细必须填批次号</td></tr>
    <tr><td>冻结拦截</td><td>已冻结批次不可出库，其冲销也会被拦截</td></tr>
    <tr><td>效期只补不猜</td><td>有效期缺失时系统不会凭空推算，只允许手工补齐</td></tr>
    <tr><td>入库自动建档</td><td>入库时批次不存在会自动创建，但不覆盖人工维护过的批次信息</td></tr>
    <tr><td>追溯层级</td><td>上游靠单据谱系，下游靠库存流水 + 谱系递归，最多回溯 10 层</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 已知提示：<strong>既被冻结又已过期的批次不会出现在效期预警中</strong>（系统优先判定为冻结）。请用批次管理页的「已冻结」筛选查看。</div>`,
      },
      {
        id: "inv-reports",
        title: "报表与对账",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td>库存报表</td><td>/inventory/reports</td><td>收发存汇总（期初 / 本期收入 / 本期发出 / 期末）等</td></tr>
    <tr><td>存货对账</td><td>/inventory/reconciliation</td><td>库存数量金额 与 总账存货科目余额核对</td></tr>
    <tr><td>存货科目映射</td><td>/inventory/subject-map</td><td>配置各类库存单据对应的存货/差异会计科目，是自动生成凭证的前提</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 存货科目映射没配全时，库存过账会给出会计侧警告（不阻断业务）。上线前请务必配置完整。</div>`,
      },
    ],
  },
  {
    title: "生产制造",
    sections: [
      {
        id: "mfg-master",
        title: "基础主数据",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>部门管理</td><td>/mrp/departments</td><td>组织架构</td></tr>
    <tr><td>员工管理</td><td>/mrp/employees</td><td><strong>派工对象、报工操作工、仓库负责人三处下拉都取这里</strong>；停用员工在下拉中置灰但保留姓名</td></tr>
    <tr><td>BOM 管理</td><td>/mrp/boms</td><td>物料清单，支持可编辑树图；含版本、用量、损耗率</td></tr>
    <tr><td>工艺路线</td><td>/mrp/routings</td><td>工序顺序、工作中心、标准工时；<strong>必须有已启用且在有效期内的工艺路线</strong>，生产订单才能下达</td></tr>
    <tr><td>工作中心</td><td>/mrp/workcenters</td><td>日产能、班次数、人工费率、制造费用费率</td></tr>
    <tr><td>工序管理</td><td>/mrp/operations</td><td>工序主档</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "mfg-planning",
        title: "计划与参数",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>物料计划参数</td><td>/mrp/planning-params</td><td>提前期、安全库存、最大库存、订货点、批量策略等 MRP 输入</td></tr>
    <tr><td>工作日历</td><td>/mrp/work-calendars</td><td>节假日/调休；可设默认+启用日历，影响产能计算</td></tr>
    <tr><td>班次管理</td><td>/mrp/shifts</td><td>班次起止时间、净工时；<strong>跨零点由系统自动判定</strong>（结束时间不晚于开始时间即视为跨天，含 24 小时班）</td></tr>
    <tr><td>MRP 计划</td><td>/mrp/plans</td><td>物料需求计划：按需求与库存展开，产出采购/生产建议</td></tr>
    <tr><td>主生产计划</td><td>/mrp/mps</td><td>MPS + 粗能力（RCCP）平衡</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 产能口径提示：生产报表中的产能按「日产能 × 当月工作日数」计算（读工作日历 + 班次）；而 MPS 粗能力（RCCP）<strong>仍按自然日</strong>计算。同一工作中心同一月份，两个页面的产能数字可能不同，属已知差异。</div>`,
      },
      {
        id: "mfg-exec",
        title: "生产执行",
        html: `
<pre class="docs-flow">生产订单 ──(下达)──> 按工艺路线生成工序 ──(开工)──> 生产中
   │                                            │
   ├──> 领料单 ──(过账)──> 材料库存减少           ├──> 生产报工（工时/产量/报废）
   └──> 完工入库单 ──(过账)──> 成品库存增加        └──> 检验（FQC）
                                     └──> 生产退料单（退料回仓）</pre>
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>生产订单</td><td>/mrp/production</td><td>工单主档 + 工序页签；顶部查询栏含「下达 / 开工」按钮（需先勾选行）</td></tr>
    <tr><td>领料单</td><td>/mrp/material-issues</td><td>按用料明细领料；过账后扣减材料库存</td></tr>
    <tr><td>生产退料</td><td>/mrp/material-returns</td><td>多余/不良材料退回仓库；过账后材料库存回补</td></tr>
    <tr><td>完工入库</td><td>/mrp/production-receipts</td><td>成品入库；过账后成品库存增加</td></tr>
    <tr><td>生产报工</td><td>/mrp/production-reports</td><td>记录各工序合格数、报废数、工时</td></tr>
    <tr><td>检验管理</td><td>/mrp/quality</td><td>来料检验（IQC）/ 过程检验 / 成品入库检验（FQC）</td></tr>
  </tbody>
</table>
<h3>生产订单操作流程</h3>
<ol>
  <li>新建生产订单：选择产品、数量、计划日期、BOM、工艺路线、领料仓。</li>
  <li><strong>下达</strong>：状态改为已下达，同时按工艺路线自动生成工序行，并按用料明细预占库存。</li>
  <li><strong>开工</strong>：状态改为生产中。</li>
  <li><strong>领料</strong>：生成领料单 → 审核 → 过账（材料库存减少）。</li>
  <li><strong>报工</strong>：逐工序录入合格数 / 报废数 / 工时。</li>
  <li><strong>完工入库</strong>：生成完工入库单 → 审核 → 过账（成品库存增加）。</li>
  <li>剩余材料 → 生产退料。</li>
</ol>
<div class="docs-tip">💡 下达动作<strong>幂等</strong>：重复点击不会重复生成；工序页签为空时也可以用同一个按钮补生成工序。若产品没有已启用且在有效期内的工艺路线（或工序明细为空），会报 No active routing。启用批次管理的物料，领料/退料/完工入库明细都支持填批次号。</div>`,
      },
      {
        id: "mfg-cost",
        title: "成本核算与生产报表",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>成本核算</td><td>/mrp/cost-calculations</td><td>按「月份 × 产品」维度核算成本</td></tr>
    <tr><td>生产报表</td><td>/mrp/production-analytics</td><td>生产进度、工序成本、在制品（WIP）、产能负荷等看板</td></tr>
  </tbody>
</table>
<h3>工单成本构成口径</h3>
<table>
  <thead><tr><th>成本项</th><th>计算方式</th></tr></thead>
  <tbody>
    <tr><td>材料成本</td><td>已过账领料单的金额</td></tr>
    <tr><td>人工成本</td><td>报工工时 × 工作中心人工费率</td></tr>
    <tr><td>制造费用</td><td>机器工时 × 工作中心制造费用费率</td></tr>
    <tr><td>完工产出</td><td>已过账完工入库数量</td></tr>
    <tr><td>计入范围</td><td>仅统计状态为已确认的报工记录</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 生产报表中的工单成本按<strong>工单</strong>累计；成本核算页按<strong>月 × 产品</strong>口径，两者粒度不同，数字不会一一对应，属正常。</div>`,
      },
      {
        id: "subcontract",
        title: "委外（外协）",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>委外订单</td><td>/mrp/subcontract-orders</td><td>委托外部加工</td></tr>
    <tr><td>委外发料</td><td>/mrp/subcontract-issues</td><td>发出材料</td></tr>
    <tr><td>委外入库</td><td>/mrp/subcontract-receipts</td><td>收回加工完成的成品/半成品</td></tr>
    <tr><td>委外结算</td><td>/mrp/subcontract-settlements</td><td>加工费结算</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 已知限制：<strong>委外结算目前不生成会计凭证</strong>，请通过手工凭证处理加工费入账。</div>`,
      },
      {
        id: "factory-3d",
        title: "3D 工厂生产驾驶舱",
        html: `
<p>OPERP 提供一套 <strong>3D 可视化工厂生产驾驶舱</strong>，把车间里的工作中心、在制工单、工序进度、物料齐套、产能负荷等生产数据，投射到一块<strong>可旋转、可缩放、可拖拽布局</strong>的三维车间场景里，让你「一眼看到车间正在发生什么」。</p>
<p><strong>入口</strong>：生产制造 → 生产报表 → 卡片标题栏右侧「<strong>3D 生产驾驶舱</strong>」按钮，点击后以<strong>全屏抽屉</strong>打开。</p>

<h3>驾驶舱布局</h3>
<table>
  <thead><tr><th>区域</th><th>内容</th></tr></thead>
  <tbody>
    <tr><td>3D 场景</td><td>车间平面：各工作中心（设备）以立体模型摆放在三维坐标上，颜色/铭牌随实时状态变化</td></tr>
    <tr><td>顶部 KPI 条</td><td>平均订单进度、设备运行数（运行/总数）、在制订单数、缺料订单数、逾期订单数</td></tr>
    <tr><td>状态图例</td><td>运行中 / 待机 / 离线 三色图例，各带实时计数</td></tr>
    <tr><td>右侧面板</td><td>三态切换：在制订单列表 → 订单详情（点订单）/ 设备详情（点设备）</td></tr>
  </tbody>
</table>

<h3>设备三态推导口径</h3>
<p>设备状态<strong>全部从业务事实自动推导</strong>，无人工维护字段：</p>
<table>
  <thead><tr><th>状态</th><th>含义</th><th>触发条件</th></tr></thead>
  <tbody>
    <tr><td>🟢 运行中</td><td>正有活儿在做</td><td>该工作中心上存在 <code>in_progress</code>（进行中）的工序</td></tr>
    <tr><td>🟡 待机</td><td>启用但无在制工序</td><td>工作中心 active，但没有进行中的工序</td></tr>
    <tr><td>⚪ 离线</td><td>停用</td><td>工作中心状态非 active</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 <strong>设备要亮成「运行中」，需要报工</strong>：光「下达 + 开工」工单还不够——只有某道工序收到<strong>合格数 &gt; 0 的已确认报工</strong>后，它才会从「待开工」进入「进行中」，对应工作中心才会亮起并显示当班任务。</div>

<h3>订单详情与材料清单</h3>
<p>点右侧列表里的某个订单进入<strong>订单详情</strong>：</p>
<ul>
  <li><strong>产品 × 计划数量</strong>、优先级、完工数、逾期天数</li>
  <li><strong>双口径进度条</strong>：完工入库口径（完工数 ÷ 计划数）+ 报工口径（工序完工进度）</li>
  <li><strong>物料齐套</strong>：该工单对应 BOM 展开的<strong>逐行材料清单</strong>（物料名 + 编码 + 已领数/需求数 + 单位），齐套显绿点、缺料显红点</li>
  <li><strong>工序进度时间线</strong>：每道工序的名称、所属工作中心、状态与完工/计划数</li>
</ul>
<div class="docs-tip">💡 <strong>材料来自对应 BOM</strong>：工单下达时系统按所选 BOM 展开生成材料行，领料过账回写已领数，这里展示的就是这套展开结果。</div>

<h3>场景对象（AGV / 仓储房屋 / 人员 / 货车）</h3>
<p>除了工作中心设备，车间场景还能摆放四类<strong>场景对象</strong>：</p>
<table>
  <thead><tr><th>对象</th><th>说明</th><th>绑定业务对象</th></tr></thead>
  <tbody>
    <tr><td>AGV 小车</td><td>自动导引运输车</td><td>「AGV小车」主数据（生产制造 → AGV小车）</td></tr>
    <tr><td>仓储房屋</td><td>仓库模型</td><td>「仓库」主数据（进销存 → 仓库管理）</td></tr>
    <tr><td>人员</td><td>员工模型</td><td>「员工」主数据（生产制造 → 员工管理）</td></tr>
    <tr><td>货车</td><td>运输车辆</td><td>「货车」主数据（生产制造 → 货车管理）</td></tr>
  </tbody>
</table>
<p>在布局编辑模式下，可<strong>新增、拖拽摆放、重命名、绑定业务数据、删除</strong>这些对象，位置与绑定关系都会<strong>持久化保存</strong>。</p>

<h3>布局编辑（拖拽摆放）</h3>
<p>点顶部 KPI 条左侧的「<strong>编辑布局</strong>」按钮进入布局编辑模式：</p>
<ol>
  <li><strong>拖动</strong>工作中心设备或场景对象到任意位置（松手即自动保存坐标）。</li>
  <li>左侧「添加对象」面板可新增 AGV / 仓储房屋 / 人员 / 货车四类对象。</li>
  <li>选中对象后可在面板里<strong>绑定业务数据</strong>、<strong>重命名</strong>、<strong>删除</strong>。</li>
  <li>再次点「编辑布局」退出，位置与绑定已持久化。</li>
</ol>
<div class="docs-tip">💡 布局坐标、场景对象都按<strong>租户隔离</strong>存储，各企业维护各自的车间平面图，互不可见。</div>

<h3>使用前置条件</h3>
<table>
  <thead><tr><th>前置项</th><th>维护入口</th></tr></thead>
  <tbody>
    <tr><td>工作中心（设备）</td><td>生产制造 → 工作中心</td></tr>
    <tr><td>工艺路线 + 工序</td><td>生产制造 → 工艺路线 / 工序管理</td></tr>
    <tr><td>BOM（材料清单）</td><td>生产制造 → BOM 管理</td></tr>
    <tr><td>员工（场景对象绑定源）</td><td>生产制造 → 员工管理</td></tr>
    <tr><td>仓库（场景对象绑定源）</td><td>进销存 → 仓库管理</td></tr>
    <tr><td>AGV / 货车（场景对象绑定源）</td><td>生产制造 → AGV小车 / 货车管理</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ <strong>工作中心必须先维护</strong>：设备视图以工作中心为主数据源，工作中心为空时 3D 场景里没有设备可显示。</div>`,
      },
    ],
  },
  {
    title: "系统管理",
    sections: [
      {
        id: "sys-org",
        title: "组织与权限",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>用户管理</td><td>/system/users</td><td>用户账号、所属租户、角色分配、重置密码</td></tr>
    <tr><td>租户管理</td><td>/system/tenants</td><td>租户列表与状态（超管可见）</td></tr>
    <tr><td>角色管理</td><td>/system/roles</td><td>角色 + 菜单权限 + 表权限（能否对某张业务表增删改查）</td></tr>
    <tr><td>菜单管理</td><td>/system/menus</td><td>菜单树、排序、图标、路径；修改后即时刷新</td></tr>
  </tbody>
</table>
<p><strong>权限模型</strong>：用户 → 角色 →（菜单权限 + 表权限）。用户只能看到有权限的菜单与数据；所有业务数据都带租户隔离，跨租户不可见。</p>`,
      },
      {
        id: "sys-config",
        title: "系统配置",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>系统设置</td><td>/system/settings</td><td>分类配置：基础（企业资料/时区/语言/单据号前缀）、财务（税率/会计年度/凭证自动过账/金额小数位）、制造（MRP 展望期/提前期/BOM 版本/自动预留）、检验、AI（大模型列表与参数）</td></tr>
    <tr><td>流程配置</td><td>/system/workflow</td><td>审批流定义：流程码、单据类型、节点、审批角色、条件分支，含流程图编辑器</td></tr>
    <tr><td>单据转换</td><td>/system/doc-flow</td><td>源单 → 目标单的转换规则、字段映射、可转状态</td></tr>
    <tr><td>DocType 构建</td><td>/system/document-types</td><td>单据类型元数据：表名、主键、单号规则、是否可提交、绑定审批流</td></tr>
    <tr><td>数据字典</td><td>/system/dictionaries</td><td>字典类型与字典项（值存编码，列表显示中文名）</td></tr>
    <tr><td>计量单位</td><td>/system/uoms</td><td>单位 / 单位组 / 换算率</td></tr>
    <tr><td>币别管理</td><td>/system/currencies</td><td>币别、汇率、本位币设定</td></tr>
    <tr><td>系统日志</td><td>/system/logs</td><td>全站操作日志</td></tr>
  </tbody>
</table>
<div class="docs-warn">⚠️ 系统设置里的「本位币」是只读的。要切换本位币请到「币别管理」操作；切换后不会重算历史金额，请谨慎评估。</div>`,
      },
      {
        id: "sys-lowcode",
        title: "低代码能力",
        html: `
<table>
  <thead><tr><th>页面</th><th>路径</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>页面设计器</td><td>/system/page-designer</td><td>拖拽组件（文本、指标、按钮、表格、图表）→ 绑定数据源（静态 JSON / 数据表 / BAQ）→ 发布后自动成为菜单项</td></tr>
    <tr><td>BAQ 管理</td><td>/system/baq</td><td>可视化拼装查询：<strong>图形化 ER 设计器</strong>（拖表、勾字段、拉连线）+ 经典表格模式；支持多级关联、多字段关联、非主外键关联；草稿 → 发布；发布后可作页面数据源，也可被 AI 调用（详见「BAQ 查询设计器」）</td></tr>
    <tr><td>知识库管理</td><td>/system/knowledge-base</td><td>维护企业制度/流程/手册，供 AI 问答检索</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "sys-baq",
        title: "BAQ 查询设计器（图形化）",
        html: `
<p><strong>BAQ（业务活动查询）</strong> 是一个<strong>不写 SQL</strong> 的可视化查询设计器：像搭积木一样选主表、关联表、字段，配置筛选与排序，发布后可作为<strong>页面设计器</strong>的数据源，也能被 <strong>AI</strong> 调用。</p>
<p><strong>入口</strong>：系统管理 → BAQ 管理（<code>/system/baq</code>）。设计器共 6 个页签：</p>
<table>
  <thead><tr><th>页签</th><th>作用</th></tr></thead>
  <tbody>
    <tr><td>图形设计（默认）</td><td>ER 图式可视化：每张表一个卡片，勾选卡片上的字段即加入输出，拖卡片右侧圆点连线关联主子表</td></tr>
    <tr><td>数据源与关联</td><td>经典表格模式：配置主表与关联，关联行可展开编辑多字段条件</td></tr>
    <tr><td>输出字段</td><td>字段、输出别名、聚合（求和 / 计数 / 平均…）、是否分组</td></tr>
    <tr><td>筛选</td><td>过滤条件（多个条件之间为 AND）</td></tr>
    <tr><td>排序</td><td>按输出字段升序 / 降序</td></tr>
    <tr><td>结果预览</td><td>点「预览」执行当前查询并展示结果（最多 100 行）</td></tr>
  </tbody>
</table>
<h3>图形设计页签操作要点</h3>
<ul>
  <li><strong>选主表</strong>：顶部下拉选主表。下拉与卡片标题都显示<strong>业务名</strong>（如「物料表」），悬停可见完整物理表名。</li>
  <li><strong>勾选字段 = 输出</strong>：点卡片里的字段勾选框即把该字段加入输出字段；卡片标题会标注「主表」或「N 级」。</li>
  <li><strong>拖线关联</strong>：从卡片右侧圆点拖到空白处 → 弹出选表窗口新增关联表；拖到画布上已有的表 → 改变它的父表。</li>
  <li><strong>多级关联</strong>：关联表还能继续关联子表，<strong>支持任意层级</strong>（主表 → 子表 → 孙表 → …）。系统会自动按依赖关系排好 JOIN 顺序，并拦住会成环的连线。</li>
  <li><strong>多字段关联</strong>：一条关联可包含<strong>多个字段条件</strong>（AND 连接），在右侧「关联」面板或经典页签展开行里编辑；点「⚡ 匹配同名字段」可一键补齐两端同名的业务字段。</li>
  <li><strong>非主外键关联</strong>：条件两端可<strong>任选任意字段</strong>，不限于主外键。例如用物料的 <code>code</code> 关联销售订单明细上的物料 <code>code</code>——<strong>外键关联只是系统给出的默认值，可以改</strong>。外键列会标注「外键」。</li>
  <li><strong>添加数据表</strong>：把一个尚未入画布的表加进来，系统按外键自动挂到合适的父表下。</li>
  <li><strong>自动发现关联</strong>：用外键元数据补全空着的关联字段，并提示还有哪些存在外键关系但尚未加入画布的表。</li>
  <li><strong>从画布移除表</strong>：会把挂在它下面的<strong>整棵子树</strong>一起移除（避免留下非法关联）。</li>
  <li><strong>适应画布</strong>：一键缩放，让所有卡片可见。</li>
</ul>
<div class="docs-tip">💡 表名默认<strong>去掉多租户物理后缀</strong>（如 _s_xxxxxx_b）显示，便于阅读；实际查询仍使用完整物理表名，不影响结果。自关联（同一张表父子结构，如 parent_id）不支持直接拖线，请用「添加数据表」加入同表的<strong>第二个别名</strong>再连。</div>
<div class="docs-warn">⚠️ <strong>发布即生效</strong>：BAQ 由「草稿」变为「已发布」后，引用它的页面与 AI 立即使用新定义；改动关联条件前请确认没有页面正在依赖。</div>
<p><strong>结果预览</strong>已并入设计器页签：点「预览」会保存当前定义并执行查询，结果在末页显示（最多 100 行）；预览成功会自动切到结果页签。让 AI「创建 BAQ」时，也能生成多级关联、多字段关联与非主外键关联的配置草稿。</p>`,
      },
      {
        id: "sys-page-designer",
        title: "页面设计器（可视化看板与大屏）",
        html: `
<p><strong>页面设计器</strong>是一个面向业务人员的可视化搭建工具：不用写代码，<strong>拖拽组件 + 接入数据</strong>，几分钟就能拼出一块数据看板或大屏；<strong>发布后自动成为左侧菜单的一项</strong>，有权限的人都能打开查看。它是把 BAQ 查询、业务数据变成"看得见、随时刷新"的画面的入口。</p>
<p><strong>入口</strong>：系统管理 → 页面设计器（<code>/system/page-designer</code>）。</p>

<h3>界面三块</h3>
<table>
  <thead><tr><th>区域</th><th>作用</th></tr></thead>
  <tbody>
    <tr><td>顶部工具栏</td><td>页面名称、页面描述、页面切换 / 新建、预览、保存、发布、删除页面</td></tr>
    <tr><td>左侧组件库</td><td>所有可拖拽的组件（文本、指标、图表、表格、实时流、提示等）</td></tr>
    <tr><td>中间画布</td><td>网格化画布，组件可拖动位置、拖角缩放</td></tr>
    <tr><td>右侧属性面板</td><td>选中组件后显示其属性（标题、数据源、样式等）；面板顶部以只读形式展示该组件的"类型"，方便识别</td></tr>
  </tbody>
</table>

<h3>第一步：新建与切换页面</h3>
<ol>
  <li>在顶部先填写<strong>页面名称</strong>与<strong>页面描述</strong>。</li>
  <li>用「页面」下拉切换已有页面，或选「新建页面」开一个空白页。</li>
  <li>每个页面在发布前都是<strong>草稿</strong>，仅你自己可编辑、可预览。</li>
</ol>

<h3>第二步：把组件放到画布上</h3>
<ul>
  <li>从左侧组件库<strong>点选</strong>组件，即添加到画布；在画布上拖动可移动、拖角可缩放。</li>
  <li>选中组件后，右侧属性面板可改<strong>标题、数据源、外观</strong>等；面板顶部以只读方式显示它的"组件类型"。</li>
  <li>不需要的组件：选中后通过属性面板里的删除（或画布上的删除按钮）移除。</li>
</ul>

<h3>组件库一览</h3>
<table>
  <thead><tr><th>类别</th><th>组件</th><th>适合呈现什么</th></tr></thead>
  <tbody>
    <tr><td rowspan="4">文本与基础</td><td>文本</td><td>说明性文字、标题、备注</td></tr>
    <tr><td>分割线</td><td>页面上的视觉分隔</td></tr>
    <tr><td>时钟</td><td>实时时间，适合大屏角落</td></tr>
    <tr><td>滚动播报</td><td>横向滚动的文字条（不带边框与标题），适合播报通知、标语</td></tr>
    <tr><td rowspan="3">指标与图卡</td><td>统计数值</td><td>大号数字卡片，如销售额、在产工单数，可带趋势</td></tr>
    <tr><td>进度环</td><td>环形进度，如计划完成率、良率</td></tr>
    <tr><td>仪表盘</td><td>指针式仪表，如产能负荷、设备利用率</td></tr>
    <tr><td rowspan="5">图表</td><td>折线图</td><td>随时间变化的趋势</td></tr>
    <tr><td>柱状图</td><td>分类对比</td></tr>
    <tr><td>饼图</td><td>占比构成</td></tr>
    <tr><td>散点图</td><td>分布 / 相关性</td></tr>
    <tr><td>图表联动</td><td>柱 + 线双轴，点击某类可联动高亮，适合探索式分析</td></tr>
    <tr><td rowspan="4">列表与排行</td><td>表格</td><td>明细清单</td></tr>
    <tr><td>轮播表</td><td>自动循环翻页的表格，适合大屏滚动展示</td></tr>
    <tr><td>排行榜</td><td>按数值排序的名次榜，如产量 TOP10</td></tr>
    <tr><td>实时明细流</td><td>最新记录从顶部不断流入的流水，适合监控</td></tr>
    <tr><td rowspan="2">实时与提示</td><td>告警提示</td><td>醒目横幅，突出预警 / 异常</td></tr>
    <tr><td>状态标签</td><td>用不同颜色标识状态（正常 / 预警 / 异常）</td></tr>
    <tr><td>交互</td><td>按钮</td><td>可点击，跳转到链接或触发动作</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 滚动播报、统计数值、仪表盘、进度环在预览与发布后不显示卡片标题（更贴近大屏的视觉），其余组件仍保留标题作为说明。</div>

<h3>第三步：给组件接上数据</h3>
<p>组件支持三类数据源：</p>
<table>
  <thead><tr><th>数据源</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>静态数据</td><td>直接填写示例数据（一组记录），适合固定文案或临时演示</td></tr>
    <tr><td>业务数据表</td><td>直接选择系统中的业务表</td></tr>
    <tr><td>BAQ 查询（推荐）</td><td>指向你在「BAQ 管理」里设计好的查询，可复用、好维护，也方便 AI 调用</td></tr>
  </tbody>
</table>
<ul>
  <li>接好数据源后，把<strong>"维度字段 / 数值字段 / 系列字段"</strong>映射到组件（例如柱状图的横轴、纵轴、分组）。</li>
  <li>没有合适的 BAQ？可以先到 BAQ 管理临时建一个，或让 AI 帮你建（见下一步）。</li>
  <li><strong>自动刷新</strong>：对动态数据，可在属性里设置"自动刷新（秒）"。组件会按间隔自动拉取最新数据，刷新过程不打断你正在看的画面。</li>
</ul>

<h3>第四步：预览与发布</h3>
<table>
  <thead><tr><th>动作</th><th>作用</th></tr></thead>
  <tbody>
    <tr><td>预览</td><td>点顶部「预览」（眼睛图标）弹出预览抽屉，所见即所得，但不可编辑——用于检查效果</td></tr>
    <tr><td>发布</td><td>点「发布」后，页面成为左侧菜单里的一项（路径 /custom/xxx），有权限的人都能打开</td></tr>
    <tr><td>删除页面</td><td>点顶部「删除页面」。<strong>系统会先检查是否被引用</strong>：若页面已发布并在菜单中生成入口，会被阻止删除（避免菜单失效）；未引用的页面可直接删除。要删一个已发布的页面，请先到「系统管理 → 菜单管理」移除对应菜单项</td></tr>
  </tbody>
</table>
<div class="docs-tip">💡 草稿仅你自己可见可改；发布后才对全员可见。发布前多用预览检查布局与数据。</div>

<h3>第五步：让 AI 一句话建看板（亮点）</h3>
<p>打开右上角 AI 助手，用自然语言说一句即可，例如：</p>
<div class="docs-tip">💬 "帮我创建一个生产车间看板，随时查看生产进度、产能状况、缺料状况。"</div>
<p>AI 会自动完成：</p>
<ol>
  <li>设计页面布局，挑选合适的组件；</li>
  <li>为缺少数据的组件<strong>匹配或自动创建所需的 BAQ 数据源</strong>（自动创建的 BAQ 会在备注里写明"由 AI 页面设计助手创建、供某页面使用"，方便你识别，也防止误删）；</li>
  <li>把数据源字段<strong>自动接到组件</strong>上；</li>
  <li>生成一份<strong>草稿页面</strong>。</li>
</ol>
<p>AI 回复里会给出<strong>可点击的链接</strong>：页面预览、在设计器里编辑、以及跳到 BAQ 管理页查看 / 修改自动创建的查询。你在设计器里微调、满意后点「发布」即可。</p>

<h3>典型应用场景</h3>
<ul>
  <li><strong>车间看板</strong>：生产进度、产能负荷、缺料预警。</li>
  <li><strong>经营驾驶舱</strong>：核心 KPI 汇总（销售额、应收、库存周转）。</li>
  <li><strong>库存预警大屏</strong>：告警横幅 + 状态标签 + 实时明细流。</li>
  <li><strong>质量月报</strong>：合格率、报废 TOP、趋势折线。</li>
</ul>

<h3>使用贴士</h3>
<ul>
  <li>动手前先想清楚"要展示哪些指标、给谁看"，再选组件。</li>
  <li>数据源优先用 BAQ：复用性强、后续好维护、也方便 AI 调用。</li>
  <li>凡是动态数据，记得设置<strong>自动刷新</strong>间隔，否则只在打开时取一次。</li>
  <li>大屏建议用深色主题更醒目；系统支持中文 / 英文、浅色 / 深色，页面会自动跟随你的界面设置。</li>
</ul>`,
      },
    ],
  },
  {
    title: "AI 与集成",
    sections: [
      {
        id: "ai-usage",
        title: "AI 助手使用",
        html: `
<p>点顶栏 AI 图标打开对话抽屉，输入自然语言即可。顶部可切换<strong>技能</strong>（决定 AI 往哪个方向理解你的话）：</p>
<table>
  <thead><tr><th>技能</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td>自动</td><td>由系统判断意图（推荐默认）</td></tr>
    <tr><td>数据分析</td><td>查数、算指标、找异常、给结论</td></tr>
    <tr><td>创建业务</td><td>新建业务单据</td></tr>
    <tr><td>业务动作</td><td>对已有单据做动作（过账、审批、转单）</td></tr>
    <tr><td>创建 BAQ</td><td>用自然语言生成 BAQ 查询配置</td></tr>
    <tr><td>普通对话</td><td>通用问答</td></tr>
  </tbody>
</table>
<h3>能力与示例话术</h3>
<table>
  <thead><tr><th>能力</th><th>你可以这样说</th><th>系统会做什么</th></tr></thead>
  <tbody>
    <tr><td>数据问答与分析</td><td>帮我分析本月应收应付风险 / 哪些物料低于安全库存</td><td>查询你的真实租户数据，输出指标、异常、成因与建议</td></tr>
    <tr><td>自然语言建单</td><td>建一张采购订单给上海钢铁，物料 A 100 个</td><td>抽取字段 → 名称解析成 ID → 先出草稿 → 确认后才落库</td></tr>
    <tr><td>单据动作</td><td>把这张采购订单过账 / 驳回这张单 / 转成入库单</td><td>调用单据状态闸门执行；订单类会自动改为先转单</td></tr>
    <tr><td>多步计划</td><td>新建客户，然后给它开一张销售订单</td><td>拆成多步计划依次执行，前一步结果自动传给下一步（最多 5 步）</td></tr>
    <tr><td>知识问答</td><td>入库流程应该怎么走 / XX 制度怎么规定</td><td>从知识库做向量检索，回答附来源</td></tr>
    <tr><td>BAQ 生成</td><td>我要查各客户的销售额汇总 / 用物料编码关联销售订单里的物料编码</td><td>生成 BAQ 配置草稿（支持多级 / 多字段 / 非主外键关联），确认后保存</td></tr>
    <tr><td>上下文指代</td><td>把它也改成已审批 / 刚才那单呢</td><td>记忆中的焦点对象支持它/这个/刚才那单</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "ai-kb",
        title: "知识库与文件上传",
        html: `
<p><strong>入口</strong>：系统管理 → 知识库管理。三个页签：文档管理（手工新建/编辑）、批量导入（粘贴 JSON）、文件上传（自动抽取正文并入库）。</p>
<h3>支持的文件格式</h3>
<table>
  <thead><tr><th>格式</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>.docx</td><td>支持（自动抽取正文）</td></tr>
    <tr><td>.pdf</td><td>支持</td></tr>
    <tr><td>.txt / .text / .md / .markdown / .log / .csv</td><td>支持</td></tr>
    <tr><td>.doc</td><td>❌ 不支持，请先用 Word 另存为 .docx</td></tr>
  </tbody>
</table>
<h3>上传规则</h3>
<ul>
  <li>单次最多 20 个文件，单文件不超过 20MB。</li>
  <li>逐个文件返回结果：成功显示标题、字数；<strong>部分失败不影响其他文件</strong>。</li>
  <li>正文超长会被截断（保留前 20 万字）并标记。</li>
  <li>上传完成后系统<strong>只对本次新增的文档建索引</strong>，速度更快、更省资源。</li>
</ul>
<div class="docs-tip">💡 如果系统未配置向量模型，知识库问答<strong>仍然可用</strong>，只是退化为关键字匹配（语义召回效果变弱）。建议在 系统设置 → AI 设置 中配置一个向量模型。</div>`,
      },
      {
        id: "ai-security",
        title: "安全底线：两段式确认",
        html: `
<p><strong>AI 绝不会在你没确认的情况下写业务数据。</strong></p>
<pre class="docs-flow">你下达指令 → AI 生成草稿（写入待处理区，30 分钟有效）
          → 你回复「确认」→ 才真正执行</pre>
<ul>
  <li>草稿绑定<strong>你的账号 + 你的租户</strong>，他人不可执行。</li>
  <li>草稿<strong>只能执行一次</strong>，重复提交会被拒绝（天然防重复过账）。</li>
  <li>所有 AI 动作都会写入审计日志。</li>
  <li>AI 的权限<strong>不超过你本人</strong>：服务端从角色表读取你的真实权限，不采信对话中的声明。</li>
</ul>`,
      },
      {
        id: "mcp",
        title: "MCP 接入（外部 AI 客户端）",
        html: `
<p><strong>用途</strong>：让 Claude Desktop / WorkBuddy / Cursor 等支持 MCP 协议的客户端，直接调用你的 ERP。</p>
<h3>使用步骤</h3>
<ol>
  <li>点顶栏 Api 图标 → 打开「MCP 接入指引」。</li>
  <li>切到「我的密钥」页签 → 点「生成新密钥」。</li>
  <li><strong>明文密钥只显示一次</strong>，服务端只保存摘要，请在弹窗内立刻复制保存。</li>
  <li>按指引页的配置说明，把服务地址与密钥填进客户端的 MCP 配置，重启客户端即可。</li>
</ol>
<h3>能做什么</h3>
<table>
  <thead><tr><th>类别</th><th>工具</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td>只读（6 个）</td><td>列出实体、实体结构、统计记录数、财务摘要、业务分析、知识库检索</td><td>安全，可直接调用</td></tr>
    <tr><td>单据（4 个）</td><td>查询单据（只读）、新建单据草稿、单据动作草稿、提交单据草稿</td><td>写操作分两步</td></tr>
  </tbody>
</table>
<h3>写操作为什么是两步</h3>
<p>MCP 客户端里没有「回复确认」这一轮对话，所以写入被拆开：</p>
<pre class="docs-flow">第 1 步：调用「新建单据」或「单据动作」→ 只生成草稿，返回 action_id，业务表不变
第 2 步：确认无误后调用「提交单据草稿」→ 才真正写库</pre>
<ul>
  <li>草稿 30 分钟内有效、只能提交一次，重复提交被拒绝 → 不会把单据过账两次。</li>
  <li><strong>不提供删除能力</strong>。</li>
</ul>
<h3>密钥安全</h3>
<ul>
  <li>每把密钥归属签发它的账号，能访问的数据范围与该账号完全一致。</li>
  <li>密钥与网页登录态互相独立：吊销密钥不影响网页登录。</li>
  <li>支持查看状态与最后使用时间，可随时吊销；<strong>请勿多人共用一把密钥</strong>。</li>
  <li>密钥生成依赖浏览器的安全上下文，必须通过 HTTPS 或 localhost 访问系统。</li>
</ul>`,
      },
    ],
  },
  {
    title: "场景与附录",
    sections: [
      {
        id: "scenario-purchase",
        title: "场景：采购收货入库",
        html: `
<ol>
  <li>进销存 → 采购订单 → 新增（选供应商、物料、数量、单价）。</li>
  <li>保存草稿 → 提交 → 审批通过（状态：已审批）。</li>
  <li>点「下推」→ 生成采购入库单（数量自动带出）。</li>
  <li>采购入库单 → 填批次/有效期（若物料启用批次）→ 提交 → 审核。</li>
  <li>点「过账」→ 库存增加 + 自动生成会计凭证。</li>
  <li>财务侧核对：应付账款、存货科目余额。</li>
</ol>`,
      },
      {
        id: "scenario-sales",
        title: "场景：销售发货",
        html: `
<ol>
  <li>进销存 → 销售订单 → 新增（选客户、物料、数量、单价，可选预占库存）。</li>
  <li>提交 → 审批通过。</li>
  <li>点「下推」→ 生成销售出货单（明细会展示可用库存）。</li>
  <li>出货单 → 提交 → 审核 → 过账 → 库存减少 + 凭证。</li>
  <li>财务侧核对：应收账款。</li>
</ol>`,
      },
      {
        id: "scenario-production",
        title: "场景：生产制造全流程",
        html: `
<ol>
  <li>生产制造 → BOM 管理 / 工艺路线 / 工作中心（首次需先备好）。</li>
  <li>物料计划参数 + 工作日历 + 班次（计划基础）。</li>
  <li>生产订单 → 新增（产品、数量、BOM、工艺路线、领料仓）。</li>
  <li>勾选订单 → 顶部「下达」（自动生成工序 + 预占材料）。</li>
  <li>顶部「开工」。</li>
  <li>领料单 → 审核 → 过账（材料出库）。</li>
  <li>生产报工 → 逐工序录入合格数/报废数/工时。</li>
  <li>完工入库单 → 审核 → 过账（成品入库）；如需 FQC 先做检验判定。</li>
  <li>生产退料（有剩余材料时）。</li>
  <li>成本核算 + 生产报表 查看工单成本与进度。</li>
</ol>`,
      },
      {
        id: "scenario-monthend",
        title: "场景：月末结账",
        html: `
<ol>
  <li>进销存：确认所有出入库单据已过账。</li>
  <li>存货对账：核对库存金额与总账存货科目是否一致。</li>
  <li>财务：计提折旧（固定资产）、录入调汇与费用凭证。</li>
  <li>财务：凭证过账 → 试算平衡校验借贷是否平衡。</li>
  <li>总账余额 / 科目明细账 复核。</li>
  <li>会计期间 → 关闭本期期间（关闭后不可再记账）。</li>
</ol>`,
      },
      {
        id: "faq",
        title: "常见问题与排错",
        html: `
<table>
  <thead><tr><th>现象</th><th>原因与处理</th></tr></thead>
  <tbody>
    <tr><td>单位下拉是空的</td><td>「计量单位」主数据没维护。到 系统管理 → 计量单位 添加，不要去数据字典找</td></tr>
    <tr><td>点过账报会计侧错误</td><td>存货科目映射未配置完整。先到 进销存 → 存货科目映射 补齐。注意：会计侧问题不会阻断库存过账，库存会照常生效</td></tr>
    <tr><td>下推按钮灰色/不可用</td><td>源单状态不在允许范围内（需先审批通过）。检查状态是否为已审批 / 部分收货 / 部分发货</td></tr>
    <tr><td>下推提示超量</td><td>该行累计已转数量已达上限，系统按台账防超下推。请核对已转数量</td></tr>
    <tr><td>生产订单下达报 No active routing</td><td>该产品没有已启用且在有效期内的工艺路线，或工艺路线下没有工序明细。先去 工艺路线 维护</td></tr>
    <tr><td>已过账单据改不了</td><td>正常行为。请先反过账，修改后再重新过账</td></tr>
    <tr><td>期初库存提示一个仓库只能一份</td><td>该仓库已有已过账期初单。先反过账原单</td></tr>
    <tr><td>知识库上传 .doc 报错</td><td>系统不支持旧版 .doc。请用 Word 另存为 .docx 后再上传</td></tr>
    <tr><td>AI 说要确认，但找不到确认入口</td><td>回复「确认」即可，或点击对话中的确认按钮。草稿 30 分钟内有效</td></tr>
    <tr><td>AI 查不到某个数据</td><td>AI 的权限不超过你本人。确认你的角色是否有该菜单/表的权限</td></tr>
    <tr><td>MCP 客户端连接失败</td><td>检查密钥是否复制完整、是否已吊销/过期，以及客户端 env 是否配置正确；服务不做静默降级，对不上就直接拒绝</td></tr>
    <tr><td>同一工作中心，两个页面产能不一样</td><td>已知差异：生产报表按工作日+班次计算产能，MPS 粗能力（RCCP）按自然日计算</td></tr>
    <tr><td>批次过期了但预警里没有</td><td>已知口径：同时被冻结又过期的批次优先判为冻结，不进效期预警。请用批次管理页的「已冻结」筛选</td></tr>
    <tr><td>界面变成英文了</td><td>顶栏语言图标切回「简体中文」</td></tr>
    <tr><td>当前会计期间无法记账</td><td>该期间已关闭。到 会计期间 检查期间状态</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "appendix-naming",
        title: "附录：单据编号规则",
        html: `
<p>系统采用统一定义式取号（按 DocType 的编号规则原子生成，不使用前端时间戳），支持 {YYYY} {YY} {MM} {DD} {####} 令牌，序号在日期进位时自动归零。</p>
<table>
  <thead><tr><th>单据</th><th>编号规则</th><th>单据</th><th>编号规则</th></tr></thead>
  <tbody>
    <tr><td>采购订单</td><td>PO{YYYY}{####}</td><td>生产订单</td><td>MO{YYYY}{####}</td></tr>
    <tr><td>销售订单</td><td>SO{YYYY}{####}</td><td>领料单</td><td>MI{YYYY}{####}</td></tr>
    <tr><td>采购入库</td><td>PR{YYYY}{####}</td><td>生产退料</td><td>MRN{YYYY}{####}</td></tr>
    <tr><td>销售出货</td><td>SD{YYYY}{####}</td><td>完工入库</td><td>PRT{YYYY}{####}</td></tr>
    <tr><td>采购退货</td><td>PRN{YYYY}{####}</td><td>生产报工</td><td>RPT{YYYY}{####}</td></tr>
    <tr><td>销售退货</td><td>SRN{YYYY}{####}</td><td>MRP 计划</td><td>MRP{YYYY}{####}</td></tr>
    <tr><td>库存调拨</td><td>TR{YYYY}{####}</td><td>主生产计划</td><td>MPS{YYYY}{####}</td></tr>
    <tr><td>库存盘点</td><td>SC{YYYY}{####}</td><td>BOM</td><td>BOM{YYYY}{####}</td></tr>
    <tr><td>库存调整</td><td>SA{YYYY}{####}</td><td>工艺路线</td><td>RT{YYYY}{####}</td></tr>
    <tr><td>其他出入库</td><td>QT{YYYY}{####}</td><td>工作中心</td><td>WC{YYYY}{####}</td></tr>
    <tr><td>期初库存</td><td>OB{YYYY}{####}</td><td>班次</td><td>SHF{YYYY}{####}</td></tr>
    <tr><td>凭证</td><td>V{YYYY}{####}</td><td>库存状态流转</td><td>SSM{YYYY}{####}</td></tr>
    <tr><td>委外订单</td><td>SCO{YYYY}{####}</td><td>委外发料</td><td>SCI{YYYY}{####}</td></tr>
    <tr><td>委外入库</td><td>SCR{YYYY}{####}</td><td>委外结算</td><td>SCS{YYYY}{####}</td></tr>
  </tbody>
</table>`,
      },
      {
        id: "appendix-glossary",
        title: "附录：术语表",
        html: `
<table>
  <thead><tr><th>术语</th><th>含义</th></tr></thead>
  <tbody>
    <tr><td>过账（Post）</td><td>让单据真正生效：更新库存、生成会计凭证。过账后单据锁定，需先反过账才能改</td></tr>
    <tr><td>反过账（Reverse Post）</td><td>撤销过账效果，单据退回未过账状态</td></tr>
    <tr><td>下推 / 转单（DocFlow）</td><td>由源单生成下游单据，数量受台账控制，防止超量</td></tr>
    <tr><td>台账（Ledger）</td><td>记录已转多少的追加式账本，只增不删，冲销用负数行表示</td></tr>
    <tr><td>DocType</td><td>单据类型元数据，定义单据的形态与行为</td></tr>
    <tr><td>工作流（Workflow）</td><td>审批流转定义，与单据能转成什么（DocFlow）是两件事</td></tr>
    <tr><td>BAQ</td><td>业务活动查询，可视化拼装的查询配置（图形化 ER 设计器）</td></tr>
    <tr><td>UoM</td><td>计量单位</td></tr>
    <tr><td>本位币</td><td>全站核算基准币种，全局唯一</td></tr>
    <tr><td>冻结汇率</td><td>汇率保存在单据上，后续汇率变动不影响该单据</td></tr>
    <tr><td>期初</td><td>开账数据，不计入本期收入</td></tr>
    <tr><td>预占库存</td><td>订单下达时预留库存，防止超卖</td></tr>
    <tr><td>RCCP</td><td>粗能力计划（MPS 页签）</td></tr>
    <tr><td>WIP</td><td>在制品</td></tr>
  </tbody>
</table>`,
      },
    ],
  },
];
