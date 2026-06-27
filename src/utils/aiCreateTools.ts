import { supabase } from './supabase';
import { logWithTiming } from './logger';

type CreateEntity =
  | 'customer'
  | 'supplier'
  | 'product'
  | 'warehouse'
  | 'purchaseOrder'
  | 'salesOrder'
  | 'purchaseReceipt'
  | 'salesDelivery'
  | 'department'
  | 'bom'
  | 'routing'
  | 'workCenter'
  | 'operation'
  | 'productionOrder';

type CreateStatus = 'ignored' | 'needs_more' | 'created' | 'invalid' | 'error';
type FieldType = 'string' | 'number' | 'date' | 'enum' | 'boolean';
type DraftData = Record<string, unknown>;
type DbRecord = Record<string, unknown>;

export interface CreateFlowState {
  entity: CreateEntity;
  data: DraftData;
}

export interface CreateToolResult {
  status: CreateStatus;
  reply?: string;
  pending?: CreateFlowState | null;
}

interface FieldDef {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
  type?: FieldType;
  options?: string[];
  defaultValue?: unknown | (() => unknown);
}

interface EntityDef {
  label: string;
  tableName: string;
  operation: string;
  keywords: string[];
  fields: FieldDef[];
  createDefaults: () => DraftData;
}

const today = () => new Date().toISOString().slice(0, 10);
const serial = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

const statusField = (options = ['active', 'inactive']): FieldDef => ({
  key: 'status',
  label: '状态',
  type: 'enum',
  aliases: ['状态'],
  options,
  defaultValue: options[0],
});

const codeField = (label: string, aliases: string[]): FieldDef => ({
  key: 'code',
  label,
  required: true,
  aliases: [...aliases, '编码', 'code'],
});

const nameField = (label: string, aliases: string[]): FieldDef => ({
  key: 'name',
  label,
  required: true,
  aliases: [...aliases, '名称', 'name'],
});

const entityDefs: Record<CreateEntity, EntityDef> = {
  customer: {
    label: '客户',
    tableName: 'erp_customers_s_539dcf81_b',
    operation: 'AI新增客户',
    keywords: ['客户', '客戶'],
    createDefaults: () => ({ type: 'enterprise', level: 'normal', credit_limit: 0, status: 'active' }),
    fields: [
      codeField('客户编码', ['客户编码']),
      nameField('客户名称', ['客户名称', '客户名']),
      { key: 'short_name', label: '简称', aliases: ['简称', 'short_name'] },
      { key: 'type', label: '类型', type: 'enum', aliases: ['类型'], options: ['enterprise', 'individual', 'government', 'other'], defaultValue: 'enterprise' },
      { key: 'level', label: '等级', type: 'enum', aliases: ['等级'], options: ['vip', 'important', 'normal', 'potential'], defaultValue: 'normal' },
      { key: 'contact_name', label: '联系人', aliases: ['联系人', '联系'] },
      { key: 'contact_phone', label: '联系电话', aliases: ['联系电话', '电话', '手机'] },
      { key: 'address', label: '地址', aliases: ['地址'] },
      { key: 'tax_no', label: '税号', aliases: ['税号'] },
      { key: 'credit_limit', label: '信用额度', type: 'number', aliases: ['信用额度', '额度'], defaultValue: 0 },
      statusField(),
    ],
  },
  supplier: {
    label: '供应商',
    tableName: 'erp_suppliers_s_539dcf81_b',
    operation: 'AI新增供应商',
    keywords: ['供应商', '供應商'],
    createDefaults: () => ({ type: 'manufacturer', level: 'normal', credit_limit: 0, status: 'active' }),
    fields: [
      codeField('供应商编码', ['供应商编码']),
      nameField('供应商名称', ['供应商名称', '供应商名']),
      { key: 'short_name', label: '简称', aliases: ['简称'] },
      { key: 'type', label: '类型', type: 'enum', aliases: ['类型'], options: ['manufacturer', 'distributor', 'retailer', 'service', 'other'], defaultValue: 'manufacturer' },
      { key: 'level', label: '等级', type: 'enum', aliases: ['等级'], options: ['strategic', 'preferred', 'normal', 'potential'], defaultValue: 'normal' },
      { key: 'contact_name', label: '联系人', aliases: ['联系人'] },
      { key: 'contact_phone', label: '联系电话', aliases: ['联系电话', '电话', '手机'] },
      { key: 'address', label: '地址', aliases: ['地址'] },
      { key: 'tax_no', label: '税号', aliases: ['税号'] },
      { key: 'bank_name', label: '开户银行', aliases: ['开户银行', '银行'] },
      { key: 'bank_account', label: '银行账号', aliases: ['银行账号', '账号'] },
      { key: 'credit_limit', label: '信用额度', type: 'number', aliases: ['信用额度', '额度'], defaultValue: 0 },
      statusField(),
    ],
  },
  product: {
    label: '物料',
    tableName: 'erp_products_s_539dcf81_b',
    operation: 'AI新增物料',
    keywords: ['物料', '产品', '商品'],
    createDefaults: () => ({ unit: '件', purchase_price: 0, sale_price: 0, cost_price: 0, safety_stock: 0, max_stock: 0, min_stock: 0, is_purchased: true, is_sold: true, is_manufactured: false, status: 'active' }),
    fields: [
      codeField('物料编码', ['物料编码', '产品编码']),
      nameField('物料名称', ['物料名称', '产品名称']),
      { key: 'short_name', label: '简称', aliases: ['简称'] },
      { key: 'category_id', label: '类别ID', type: 'number', aliases: ['类别ID', 'category_id'] },
      { key: 'specification', label: '规格', aliases: ['规格', '型号'] },
      { key: 'unit', label: '单位', aliases: ['单位'], defaultValue: '件' },
      { key: 'barcode', label: '条码', aliases: ['条码'] },
      { key: 'purchase_price', label: '采购价', type: 'number', aliases: ['采购价', '进价'], defaultValue: 0 },
      { key: 'sale_price', label: '销售价', type: 'number', aliases: ['销售价', '售价'], defaultValue: 0 },
      { key: 'cost_price', label: '成本价', type: 'number', aliases: ['成本价', '成本'], defaultValue: 0 },
      { key: 'safety_stock', label: '安全库存', type: 'number', aliases: ['安全库存'], defaultValue: 0 },
      { key: 'max_stock', label: '最大库存', type: 'number', aliases: ['最大库存'], defaultValue: 0 },
      { key: 'min_stock', label: '最小库存', type: 'number', aliases: ['最小库存'], defaultValue: 0 },
      { key: 'is_purchased', label: '可采购', type: 'boolean', aliases: ['可采购'], defaultValue: true },
      { key: 'is_sold', label: '可销售', type: 'boolean', aliases: ['可销售'], defaultValue: true },
      { key: 'is_manufactured', label: '可生产', type: 'boolean', aliases: ['可生产'], defaultValue: false },
      statusField(),
    ],
  },
  warehouse: {
    label: '仓库',
    tableName: 'erp_warehouses_s_539dcf81_b',
    operation: 'AI新增仓库',
    keywords: ['仓库', '倉庫'],
    createDefaults: () => ({ type: 'raw_material', is_negative_stock_allowed: false, status: 'active' }),
    fields: [
      codeField('仓库编码', ['仓库编码']),
      nameField('仓库名称', ['仓库名称', '仓库名']),
      { key: 'type', label: '类型', type: 'enum', aliases: ['类型'], options: ['raw_material', 'finished', 'semi_finished', 'return', 'scrap', 'other'], defaultValue: 'raw_material' },
      { key: 'location', label: '位置', aliases: ['位置', '地址'] },
      { key: 'manager_id', label: '负责人ID', type: 'number', aliases: ['负责人ID', 'manager_id'] },
      { key: 'is_negative_stock_allowed', label: '允许负库存', type: 'boolean', aliases: ['允许负库存', '负库存'], defaultValue: false },
      statusField(),
    ],
  },
  purchaseOrder: {
    label: '采购订单',
    tableName: 'erp_purchase_orders_s_539dcf81_b',
    operation: 'AI新增采购订单',
    keywords: ['采购订单', '采购单'],
    createDefaults: () => ({ order_no: serial('PO'), order_date: today(), total_amount: 0, tax_amount: 0, payable_amount: 0, currency: 'CNY', status: 'draft' }),
    fields: [
      { key: 'order_no', label: '订单号', aliases: ['订单号', '采购单号', '单号'], defaultValue: () => serial('PO') },
      { key: 'supplier_id', label: '供应商ID', required: true, type: 'number', aliases: ['供应商ID', 'supplier_id'] },
      { key: 'order_date', label: '订单日期', required: true, type: 'date', aliases: ['订单日期', '日期'], defaultValue: today },
      { key: 'delivery_date', label: '交货日期', type: 'date', aliases: ['交货日期'] },
      { key: 'total_amount', label: '总金额', type: 'number', aliases: ['总金额', '金额'], defaultValue: 0 },
      { key: 'tax_amount', label: '税额', type: 'number', aliases: ['税额'], defaultValue: 0 },
      { key: 'payable_amount', label: '应付金额', type: 'number', aliases: ['应付金额'], defaultValue: 0 },
      { key: 'currency', label: '币种', aliases: ['币种'], defaultValue: 'CNY' },
      { key: 'delivery_address', label: '交货地址', aliases: ['交货地址'] },
      { key: 'contact_person', label: '联系人', aliases: ['联系人'] },
      { key: 'contact_phone', label: '联系电话', aliases: ['联系电话', '电话'] },
      { key: 'remark', label: '备注', aliases: ['备注'] },
      statusField(['draft', 'pending', 'approved', 'partially_received', 'received', 'closed', 'cancelled']),
    ],
  },
  salesOrder: {
    label: '销售订单',
    tableName: 'erp_sales_orders_s_539dcf81_b',
    operation: 'AI新增销售订单',
    keywords: ['销售订单', '销售单'],
    createDefaults: () => ({ order_no: serial('SO'), order_date: today(), total_amount: 0, tax_amount: 0, discount_amount: 0, receivable_amount: 0, currency: 'CNY', status: 'draft' }),
    fields: [
      { key: 'order_no', label: '订单号', aliases: ['订单号', '销售单号', '单号'], defaultValue: () => serial('SO') },
      { key: 'customer_id', label: '客户ID', required: true, type: 'number', aliases: ['客户ID', 'customer_id'] },
      { key: 'order_date', label: '订单日期', required: true, type: 'date', aliases: ['订单日期', '日期'], defaultValue: today },
      { key: 'delivery_date', label: '交货日期', type: 'date', aliases: ['交货日期'] },
      { key: 'total_amount', label: '总金额', type: 'number', aliases: ['总金额', '金额'], defaultValue: 0 },
      { key: 'tax_amount', label: '税额', type: 'number', aliases: ['税额'], defaultValue: 0 },
      { key: 'discount_amount', label: '折扣金额', type: 'number', aliases: ['折扣金额'], defaultValue: 0 },
      { key: 'receivable_amount', label: '应收金额', type: 'number', aliases: ['应收金额'], defaultValue: 0 },
      { key: 'currency', label: '币种', aliases: ['币种'], defaultValue: 'CNY' },
      { key: 'delivery_address', label: '交货地址', aliases: ['交货地址'] },
      { key: 'contact_person', label: '联系人', aliases: ['联系人'] },
      { key: 'contact_phone', label: '联系电话', aliases: ['联系电话', '电话'] },
      { key: 'remark', label: '备注', aliases: ['备注'] },
      statusField(['draft', 'pending', 'approved', 'partially_delivered', 'delivered', 'closed', 'cancelled']),
    ],
  },
  purchaseReceipt: {
    label: '采购入库单',
    tableName: 'erp_purchase_receipts_s_539dcf81_b',
    operation: 'AI新增采购入库单',
    keywords: ['采购入库单', '采购入库', '入库单'],
    createDefaults: () => ({ receipt_no: serial('PR'), receipt_date: today(), total_amount: 0, status: 'draft' }),
    fields: [
      { key: 'receipt_no', label: '入库单号', aliases: ['入库单号', '单号'], defaultValue: () => serial('PR') },
      { key: 'receipt_date', label: '入库日期', required: true, type: 'date', aliases: ['入库日期', '日期'], defaultValue: today },
      { key: 'order_id', label: '采购订单ID', type: 'number', aliases: ['采购订单ID', '订单ID', 'order_id'] },
      { key: 'supplier_id', label: '供应商ID', required: true, type: 'number', aliases: ['供应商ID', 'supplier_id'] },
      { key: 'warehouse_id', label: '仓库ID', required: true, type: 'number', aliases: ['仓库ID', 'warehouse_id'] },
      { key: 'total_amount', label: '总金额', type: 'number', aliases: ['总金额', '金额'], defaultValue: 0 },
      { key: 'remark', label: '备注', aliases: ['备注'] },
      statusField(['draft', 'pending', 'approved', 'cancelled']),
    ],
  },
  salesDelivery: {
    label: '销售出货单',
    tableName: 'erp_sales_deliveries_s_539dcf81_b',
    operation: 'AI新增销售出货单',
    keywords: ['销售出货单', '销售出货', '出货单'],
    createDefaults: () => ({ delivery_no: serial('SD'), delivery_date: today(), total_amount: 0, status: 'draft' }),
    fields: [
      { key: 'delivery_no', label: '出货单号', aliases: ['出货单号', '单号'], defaultValue: () => serial('SD') },
      { key: 'delivery_date', label: '出货日期', required: true, type: 'date', aliases: ['出货日期', '日期'], defaultValue: today },
      { key: 'order_id', label: '销售订单ID', type: 'number', aliases: ['销售订单ID', '订单ID', 'order_id'] },
      { key: 'customer_id', label: '客户ID', required: true, type: 'number', aliases: ['客户ID', 'customer_id'] },
      { key: 'warehouse_id', label: '仓库ID', required: true, type: 'number', aliases: ['仓库ID', 'warehouse_id'] },
      { key: 'total_amount', label: '总金额', type: 'number', aliases: ['总金额', '金额'], defaultValue: 0 },
      { key: 'remark', label: '备注', aliases: ['备注'] },
      statusField(['draft', 'pending', 'approved', 'cancelled']),
    ],
  },
  department: {
    label: '部门',
    tableName: 'erp_departments_s_539dcf81_b',
    operation: 'AI新增部门',
    keywords: ['部门'],
    createDefaults: () => ({ status: 'active' }),
    fields: [
      codeField('部门编码', ['部门编码']),
      nameField('部门名称', ['部门名称', '部门名']),
      { key: 'parent_id', label: '上级部门ID', type: 'number', aliases: ['上级部门ID', 'parent_id'] },
      { key: 'manager_id', label: '负责人ID', type: 'number', aliases: ['负责人ID', 'manager_id'] },
      { key: 'company_id', label: '公司ID', type: 'number', aliases: ['公司ID', 'company_id'] },
      statusField(),
    ],
  },
  bom: {
    label: 'BOM',
    tableName: 'erp_boms_s_539dcf81_b',
    operation: 'AI新增BOM',
    keywords: ['BOM', 'bom'],
    createDefaults: () => ({ bom_no: serial('BOM'), version: '1.0', quantity: 1, unit: '件', is_default: true, is_active: true, effective_date: today() }),
    fields: [
      { key: 'bom_no', label: 'BOM编号', aliases: ['BOM编号', 'bom编号', '编号'], defaultValue: () => serial('BOM') },
      { key: 'product_id', label: '产品ID', required: true, type: 'number', aliases: ['产品ID', '物料ID', 'product_id'] },
      { key: 'version', label: '版本', aliases: ['版本'], defaultValue: '1.0' },
      { key: 'quantity', label: '数量', type: 'number', aliases: ['数量'], defaultValue: 1 },
      { key: 'unit', label: '单位', aliases: ['单位'], defaultValue: '件' },
      { key: 'is_default', label: '默认BOM', type: 'boolean', aliases: ['默认BOM', '默认'], defaultValue: true },
      { key: 'is_active', label: '启用', type: 'boolean', aliases: ['启用'], defaultValue: true },
      { key: 'effective_date', label: '生效日期', type: 'date', aliases: ['生效日期'], defaultValue: today },
      { key: 'expiry_date', label: '失效日期', type: 'date', aliases: ['失效日期'] },
      { key: 'remark', label: '备注', aliases: ['备注'] },
    ],
  },
  routing: {
    label: '工艺路线',
    tableName: 'erp_routing_operations_s_539dcf81_b',
    operation: 'AI新增工艺路线',
    keywords: ['工艺路线', '路线'],
    createDefaults: () => ({ routing_no: serial('RT'), version: '1.0', is_default: true, is_active: true, effective_date: today(), total_standard_hours: 0 }),
    fields: [
      { key: 'routing_no', label: '工艺路线编号', aliases: ['工艺路线编号', '路线编号', '编号'], defaultValue: () => serial('RT') },
      { key: 'product_id', label: '产品ID', required: true, type: 'number', aliases: ['产品ID', '物料ID', 'product_id'] },
      { key: 'version', label: '版本', aliases: ['版本'], defaultValue: '1.0' },
      { key: 'total_standard_hours', label: '标准工时', type: 'number', aliases: ['标准工时', '总工时'], defaultValue: 0 },
      { key: 'is_default', label: '默认工艺路线', type: 'boolean', aliases: ['默认工艺路线', '默认'], defaultValue: true },
      { key: 'is_active', label: '启用', type: 'boolean', aliases: ['启用'], defaultValue: true },
      { key: 'effective_date', label: '生效日期', type: 'date', aliases: ['生效日期'], defaultValue: today },
      { key: 'expiry_date', label: '失效日期', type: 'date', aliases: ['失效日期'] },
      { key: 'remark', label: '备注', aliases: ['备注'] },
    ],
  },
  workCenter: {
    label: '工作中心',
    tableName: 'erp_work_centers_s_539dcf81_b',
    operation: 'AI新增工作中心',
    keywords: ['工作中心'],
    createDefaults: () => ({ type: 'machine', capacity_per_day: 8, labor_rate: 0, overhead_rate: 0, status: 'active' }),
    fields: [
      codeField('工作中心编码', ['工作中心编码', '编码']),
      nameField('工作中心名称', ['工作中心名称', '名称']),
      { key: 'type', label: '类型', type: 'enum', aliases: ['类型'], options: ['machine', 'labor', 'mixed', 'other'], defaultValue: 'machine' },
      { key: 'department_id', label: '部门ID', type: 'number', aliases: ['部门ID', 'department_id'] },
      { key: 'capacity_per_day', label: '日产能', type: 'number', aliases: ['日产能', '产能'], defaultValue: 8 },
      { key: 'labor_rate', label: '人工费率', type: 'number', aliases: ['人工费率'], defaultValue: 0 },
      { key: 'overhead_rate', label: '制造费率', type: 'number', aliases: ['制造费率', '制造费用率'], defaultValue: 0 },
      statusField(),
    ],
  },
  operation: {
    label: '工序',
    tableName: 'erp_operations_s_539dcf81_b',
    operation: 'AI新增工序',
    keywords: ['工序'],
    createDefaults: () => ({ standard_hours: 0, setup_hours: 0, labor_rate: 0, overhead_rate: 0, status: 'active' }),
    fields: [
      codeField('工序编码', ['工序编码', '编码']),
      nameField('工序名称', ['工序名称', '名称']),
      { key: 'description', label: '描述', aliases: ['描述'] },
      { key: 'work_center_id', label: '工作中心ID', type: 'number', aliases: ['工作中心ID', 'work_center_id'] },
      { key: 'standard_hours', label: '标准工时', type: 'number', aliases: ['标准工时'], defaultValue: 0 },
      { key: 'setup_hours', label: '准备工时', type: 'number', aliases: ['准备工时'], defaultValue: 0 },
      { key: 'labor_rate', label: '人工费率', type: 'number', aliases: ['人工费率'], defaultValue: 0 },
      { key: 'overhead_rate', label: '制造费率', type: 'number', aliases: ['制造费率', '制造费用率'], defaultValue: 0 },
      statusField(),
    ],
  },
  productionOrder: {
    label: '生产订单',
    tableName: 'erp_production_orders_s_539dcf81_b',
    operation: 'AI新增生产订单',
    keywords: ['生产订单', '生产单', '工单'],
    createDefaults: () => ({ order_no: serial('MO'), order_date: today(), planned_quantity: 1, completed_quantity: 0, scrapped_quantity: 0, priority: 1, status: 'draft' }),
    fields: [
      { key: 'order_no', label: '订单号', aliases: ['订单号', '生产单号', '工单号'], defaultValue: () => serial('MO') },
      { key: 'order_date', label: '订单日期', required: true, type: 'date', aliases: ['订单日期', '日期'], defaultValue: today },
      { key: 'product_id', label: '产品ID', required: true, type: 'number', aliases: ['产品ID', '物料ID', 'product_id'] },
      { key: 'bom_id', label: 'BOM ID', type: 'number', aliases: ['BOM ID', 'bom_id'] },
      { key: 'routing_id', label: '工艺路线ID', type: 'number', aliases: ['工艺路线ID', 'routing_id'] },
      { key: 'planned_quantity', label: '计划数量', type: 'number', aliases: ['计划数量', '数量'], defaultValue: 1 },
      { key: 'completed_quantity', label: '完成数量', type: 'number', aliases: ['完成数量'], defaultValue: 0 },
      { key: 'scrapped_quantity', label: '报废数量', type: 'number', aliases: ['报废数量'], defaultValue: 0 },
      { key: 'planned_start_date', label: '计划开始日期', type: 'date', aliases: ['计划开始日期'] },
      { key: 'planned_end_date', label: '计划结束日期', type: 'date', aliases: ['计划结束日期'] },
      { key: 'actual_start_date', label: '实际开始日期', type: 'date', aliases: ['实际开始日期'] },
      { key: 'actual_end_date', label: '实际结束日期', type: 'date', aliases: ['实际结束日期'] },
      { key: 'work_center_id', label: '工作中心ID', type: 'number', aliases: ['工作中心ID', 'work_center_id'] },
      { key: 'priority', label: '优先级', type: 'number', aliases: ['优先级'], defaultValue: 1 },
      { key: 'remark', label: '备注', aliases: ['备注'] },
      statusField(['draft', 'planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled']),
    ],
  },
};

const createWords = ['新增', '创建', '添加', '建立', '录入', '生成'];
const correctionWords = ['不是', '不对', '应该', '改成', '是帮我', '帮我新增', '新增'];
const stopWords = ['，', ',', '。', ';', '；', '\n'];

const includesCreateIntent = (text: string) => createWords.some((word) => text.includes(word));
const includesCorrectionIntent = (text: string) => correctionWords.some((word) => text.includes(word));

const detectEntity = (text: string): CreateEntity | null => {
  const ordered: CreateEntity[] = [
    'purchaseReceipt',
    'salesDelivery',
    'purchaseOrder',
    'salesOrder',
    'productionOrder',
    'workCenter',
    'routing',
    'operation',
    'bom',
    'supplier',
    'warehouse',
    'department',
    'customer',
    'product',
  ];
  const lowerText = text.toLowerCase();
  return ordered.find((entity) => entityDefs[entity].keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()))) || null;
};

const enumMap: Record<string, string> = {
  启用: 'active',
  停用: 'inactive',
  企业: 'enterprise',
  个人: 'individual',
  政府: 'government',
  其他: 'other',
  普通: 'normal',
  重要: 'important',
  潜在: 'potential',
  制造商: 'manufacturer',
  经销商: 'distributor',
  零售商: 'retailer',
  服务商: 'service',
  战略: 'strategic',
  优先: 'preferred',
  原材料仓: 'raw_material',
  成品仓: 'finished',
  半成品仓: 'semi_finished',
  退货仓: 'return',
  废料仓: 'scrap',
  机器: 'machine',
  人工: 'labor',
  混合: 'mixed',
  草稿: 'draft',
  待审批: 'pending',
  待审核: 'pending',
  已审批: 'approved',
  已审核: 'approved',
  已收货: 'received',
  部分收货: 'partially_received',
  已发货: 'delivered',
  部分发货: 'partially_delivered',
  已计划: 'planned',
  已下达: 'released',
  生产中: 'in_progress',
  已完成: 'completed',
  已关闭: 'closed',
  已取消: 'cancelled',
};

const booleanMap: Record<string, boolean> = {
  是: true,
  true: true,
  yes: true,
  y: true,
  启用: true,
  允许: true,
  默认: true,
  否: false,
  false: false,
  no: false,
  n: false,
  停用: false,
  不允许: false,
  非默认: false,
};

const cleanValue = (value: string) => value.trim().replace(/^[:：=是为\s]+/, '').replace(/[。；;,，]$/, '').trim();

const extractByAlias = (text: string, aliases: string[]) => {
  for (const alias of aliases) {
    const pattern = new RegExp(`${alias}\\s*[:：=是为]?\\s*([^,，;；\\n]+)`, 'i');
    const match = text.match(pattern);
    if (match?.[1]) return cleanValue(match[1]);
  }
  return undefined;
};

const extractLooseName = (text: string, def: EntityDef) => {
  const keyword = def.keywords.find((item) => text.includes(item));
  if (!keyword) return undefined;
  const after = text.slice(text.indexOf(keyword) + keyword.length);
  const trimmed = cleanValue(after.replace(/^(叫|为|是|名称|名字|名)/, ''));
  if (!trimmed || trimmed.length > 50 || stopWords.some((word) => trimmed.startsWith(word))) return undefined;
  return trimmed;
};

const coerceValue = (value: unknown, field: FieldDef) => {
  if (value == null || value === '') return undefined;
  if (field.type === 'number') {
    const numeric = Number(String(value).replace(/[￥¥元小时件个]/g, ''));
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (field.type === 'date') {
    const text = String(value).trim();
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return text;
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(text)) return text.replace(/\//g, '-');
    if (text === '今天') return today();
    return value;
  }
  if (field.type === 'enum') return enumMap[String(value).trim()] || String(value).trim();
  if (field.type === 'boolean') {
    const text = String(value).trim();
    return booleanMap[text] ?? value;
  }
  return String(value).trim();
};

const parseData = (text: string, entity: CreateEntity) => {
  const def = entityDefs[entity];
  const data: DraftData = {};
  for (const field of def.fields) {
    const value = coerceValue(extractByAlias(text, field.aliases), field);
    if (value !== undefined) data[field.key] = value;
  }
  if (!data.name && ['customer', 'supplier', 'product', 'warehouse', 'department', 'workCenter', 'operation'].includes(entity)) {
    const looseName = extractLooseName(text, def);
    if (looseName) data.name = looseName;
  }
  return data;
};

const validateData = (entity: CreateEntity, data: DraftData) => {
  const def = entityDefs[entity];
  const missing = def.fields.filter((field) => field.required && (data[field.key] == null || data[field.key] === ''));
  const invalid: string[] = [];
  for (const field of def.fields) {
    const value = data[field.key];
    if (value == null || value === '') continue;
    if (field.type === 'number' && typeof value !== 'number') invalid.push(`${field.label} 需要是数字`);
    if (field.type === 'boolean' && typeof value !== 'boolean') invalid.push(`${field.label} 需要填写 是/否`);
    if (field.type === 'date' && typeof value === 'string' && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) invalid.push(`${field.label} 需要是 YYYY-MM-DD 格式`);
    if (field.type === 'enum' && field.options && !field.options.includes(String(value))) invalid.push(`${field.label} 可选值为 ${field.options.join(', ')}`);
  }
  return { missing, invalid };
};

const dataPreview = (entity: CreateEntity, data: DraftData) => {
  const def = entityDefs[entity];
  return def.fields
    .filter((field) => data[field.key] !== undefined && data[field.key] !== '')
    .map((field) => `${field.label}: ${String(data[field.key])}`)
    .join('\n');
};

const askForMore = (entity: CreateEntity, data: DraftData, invalid: string[] = []) => {
  const def = entityDefs[entity];
  const { missing } = validateData(entity, data);
  const lines = [`我可以帮你新增${def.label}，但还需要补充/修正以下信息：`];
  if (missing.length) lines.push(`缺少：${missing.map((field) => field.label).join('、')}`);
  if (invalid.length) lines.push(`不正确：${invalid.join('；')}`);
  lines.push('请继续回复这些字段即可，例如：');
  lines.push(def.fields.filter((field) => field.required).map((field) => `${field.label}: xxx`).join('，'));
  const preview = dataPreview(entity, data);
  if (preview) lines.push('\n当前已识别：', preview);
  return lines.join('\n');
};

const withDefaults = (entity: CreateEntity, data: DraftData) => {
  const def = entityDefs[entity];
  const merged = { ...def.createDefaults(), ...data };
  for (const field of def.fields) {
    if (merged[field.key] === undefined && field.defaultValue !== undefined) {
      merged[field.key] = typeof field.defaultValue === 'function' ? field.defaultValue() : field.defaultValue;
    }
  }
  return merged;
};

const insertEntity = async (entity: CreateEntity, data: DraftData) => {
  const def = entityDefs[entity];
  const payload = withDefaults(entity, data);
  const result = await logWithTiming(
    def.operation,
    'INSERT',
    async () => {
      const { data: inserted, error } = await supabase.from(def.tableName).insert([payload]).select().single();
      if (error) throw error;
      return inserted as DbRecord;
    },
    { table: def.tableName, params: payload },
  );
  return { payload, result };
};

export const handleCreateSkill = async (text: string, pending?: CreateFlowState | null): Promise<CreateToolResult> => {
  const detectedEntity = detectEntity(text);
  const shouldSwitchEntity = Boolean(pending && detectedEntity && detectedEntity !== pending.entity && includesCorrectionIntent(text));
  const entity = shouldSwitchEntity ? detectedEntity : pending?.entity || detectedEntity;
  if (!entity || (!pending && !includesCreateIntent(text))) return { status: 'ignored' };

  const parsed = parseData(text, entity);
  const data = { ...(shouldSwitchEntity ? {} : pending?.data || {}), ...parsed };
  const { missing, invalid } = validateData(entity, data);
  if (missing.length || invalid.length) {
    return {
      status: invalid.length ? 'invalid' : 'needs_more',
      reply: askForMore(entity, data, invalid),
      pending: { entity, data },
    };
  }

  try {
    const { payload, result } = await insertEntity(entity, data);
    return {
      status: 'created',
      pending: null,
      reply: [`已成功新增${entityDefs[entity].label}。`, `记录ID：${String(result.id ?? '-')}`, '', '创建内容：', dataPreview(entity, payload)].join('\n'),
    };
  } catch (error) {
    return {
      status: 'error',
      pending: { entity, data },
      reply: `创建${entityDefs[entity].label}失败：${error instanceof Error ? error.message : String(error)}\n请修正后继续发送。`,
    };
  }
};
