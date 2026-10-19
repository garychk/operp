import type * as React from 'react'

export type DeviceStatus = 'running' | 'idle' | 'fault'
export type SceneStatus = 'running' | 'idle' | 'offline'

/** supabase-erp 视图 vw_factory_3d_devices 的行类型 */
export interface DeviceRow {
  device_id: number
  device_code: string
  device_name: string
  device_type: string | null
  capacity_per_day: number | null
  wc_status: string | null
  scene_status: SceneStatus
  current_order_id: number | null
  current_order_no: string | null
  current_product_name: string | null
  current_operation_name: string | null
  current_op_line_no: number | null
  current_op_completed: number | null
  current_op_planned: number | null
  scene_x: number | null
  scene_z: number | null
}

/** supabase-erp 视图 vw_factory_3d_orders 的行类型 */
export interface OrderData {
  order_id: number
  order_no: string
  status: string
  priority: number | null
  product_id: number | null
  product_code: string | null
  product_name: string | null
  unit: string | null
  planned_quantity: number
  received_quantity: number
  remaining_quantity: number
  progress_pct: number
  delay_days: number
  operation_progress_percent: number
  material_line_total: number
  material_line_ready: number
  material_line_short: number
  material_kit_status: 'ready' | 'short' | 'none'
}

/** supabase-erp 视图 vw_factory_3d_order_operations 的行类型 */
export interface OrderOperation {
  order_operation_id: number
  order_id: number
  order_no: string
  line_no: number
  sequence_no: number
  operation_name: string | null
  work_center_id: number | null
  work_center_name: string | null
  assignee_name: string | null
  planned_quantity: number
  completed_quantity: number
  scrapped_quantity: number
  operation_status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface DeviceData {
  id: string
  name: string
  position: [number, number, number]
  status: DeviceStatus
  currentOrderNo?: string
  currentProduct?: string
  output?: number
  deviceId?: number
}

export declare const STATUS_COLORS: Record<SceneStatus, string>
export declare const STATUS_LABELS: Record<SceneStatus, string>
export declare const OP_STATUS_LABELS: Record<OrderOperation['operation_status'], string>
export declare const KIT_STATUS_LABELS: Record<OrderData['material_kit_status'], string>
export declare const MOCK_DEVICE_ROWS: DeviceRow[]
export declare const MOCK_ORDERS: OrderData[]
export declare const MOCK_ORDER_OPERATIONS: OrderOperation[]

/** 拖拽布局后的坐标变更（宿主据此回写 factory_3d_device_layout） */
export interface DeviceLayoutChange {
  deviceCode: string
  deviceId?: number
  sceneX: number
  sceneZ: number
}

/** 场景对象类型：工作中心设备之外的可摆放对象 */
export type SceneObjectKind = 'work_center' | 'agv' | 'warehouse' | 'person' | 'truck'
export declare const SCENE_OBJECT_KINDS: SceneObjectKind[]

/** 可绑定的业务对象（AGV / 仓库 / 员工） */
export interface BindingOption {
  id: number | string
  label: string
}

/** 场景对象：AGV 小车 / 仓储房屋 / 人员，可绑定一条业务数据 */
export interface SceneObject {
  id: string
  kind: SceneObjectKind
  name: string
  position: [number, number, number]
  bindId?: number | string
  bindLabel?: string
  status?: 'running' | 'idle' | 'fault'
}

/** 场景对象操作类型 */
export type SceneObjectAction = 'add' | 'move' | 'rename' | 'bind' | 'remove'

/** 场景对象单条变更（宿主据此增量 upsert / delete 落库） */
export interface SceneObjectChange {
  action: SceneObjectAction
  /** 变更后的对象快照；remove 时为被删除对象快照 */
  object: SceneObject
}

/** 视图行 → 3D 场景设备模型（未配置坐标时按行序自动排布） */
export declare function fromDeviceRows(rows: DeviceRow[]): DeviceData[]

export interface FactorySceneProps {
  /** 不传则使用内置演示数据；传入后以该数据为准（受控模式） */
  devices?: DeviceData[]
  /** 设备被点击/取消选中时回调（参数为 device_code） */
  onDeviceSelect?: (deviceCode: string | null) => void
  /** 跟随宿主主题：'light' | 'dark' */
  theme?: 'light' | 'dark'
  /** 跟随宿主语言：'zh' | 'zh-CN' | 'en' | 'en-US'（自动归一） */
  locale?: string
  /** 布局编辑模式：开启后设备可拖拽摆放 */
  layoutEditable?: boolean
  /** 拖拽落位回调：返回全部待回写坐标（宿主 upsert 布局表后清空 pendingLayout） */
  onLayoutChange?: (changes: DeviceLayoutChange[]) => void
  /** 场景对象（AGV / 仓储房屋 / 人员）初始数据 */
  sceneObjects?: SceneObject[]
  /** 各类型可绑定业务对象下拉清单 */
  bindingOptions?: Partial<Record<SceneObjectKind, BindingOption[]>>
  /** 左侧“添加对象”面板是否显示（默认 true，仅布局编辑模式下可见） */
  showObjectPalette?: boolean
  /** 场景对象增删改/绑定回调（整表覆盖，宿主在此持久化） */
  onSceneObjectsChange?: (objects: SceneObject[]) => void
  /** 场景对象单条变更回调（add/move/rename/bind/remove） */
  onSceneObjectChange?: (change: SceneObjectChange) => void
  className?: string
  style?: React.CSSProperties
}

export declare const LIB_DICT: Record<'zh' | 'en', {
  status: Record<DeviceStatus, string>
  sceneStatus: Record<SceneStatus, string>
  opStatus: Record<OrderOperation['operation_status'], string>
  kitStatus: Record<OrderData['material_kit_status'], string>
  objectKind: Record<SceneObjectKind, string>
  palette: {
    title: string
    hint: string
    binding: string
    unbound: string
    remove: string
    name: string
  }
}>
export declare function normalizeLocale(input?: string | null): 'zh' | 'en'

export declare function FactoryScene(props: FactorySceneProps): React.JSX.Element

export interface FactoryState {
  devices: DeviceData[]
  deviceRows: DeviceRow[]
  orders: OrderData[]
  operations: OrderOperation[]
  selectedDeviceCode: string | null
  selectedOrderId: number | null
  theme: 'light' | 'dark'
  locale: 'zh' | 'en'
  layoutEditable: boolean
  pendingLayout: Record<string, { sceneX: number; sceneZ: number }>
  sceneObjects: SceneObject[]
  selectedSceneObjectId: string | null
  setDeviceRows: (rows: DeviceRow[]) => void
  setDevices: (devices: DeviceData[]) => void
  updateDeviceStatus: (code: string, status: DeviceStatus) => void
  setOrders: (orders: OrderData[]) => void
  setOperations: (operations: OrderOperation[]) => void
  selectDevice: (code: string | null) => void
  selectOrder: (id: number | null) => void
  setOnDeviceSelect: (cb: ((code: string | null) => void) | null) => void
  setOnOrderSelect: (cb: ((id: number | null) => void) | null) => void
  setTheme: (theme: 'light' | 'dark') => void
  toggleTheme: () => void
  setLocale: (locale: 'zh' | 'en') => void
  setLayoutEditable: (editable: boolean) => void
  moveDevice: (deviceCode: string, sceneX: number, sceneZ: number) => void
  clearPendingLayout: () => void
  setOnLayoutChange: (cb: ((changes: DeviceLayoutChange[]) => void) | null) => void
  setSceneObjects: (objects: SceneObject[]) => void
  addSceneObject: (kind: SceneObjectKind, name?: string) => SceneObject
  moveSceneObject: (id: string, sceneX: number, sceneZ: number) => void
  renameSceneObject: (id: string, name: string) => void
  bindSceneObject: (id: string, bindId?: number | string, bindLabel?: string) => void
  removeSceneObject: (id: string) => void
  selectSceneObject: (id: string | null) => void
  setOnSceneObjectsChange: (cb: ((objects: SceneObject[]) => void) | null) => void
  setOnSceneObjectChange: (cb: ((change: SceneObjectChange) => void) | null) => void
}

export declare const useFactoryStore: import('zustand').UseBoundStore<
  import('zustand').StoreApi<FactoryState>
>

export declare function ObjectPalette(props: {
  bindingOptions?: Partial<Record<SceneObjectKind, BindingOption[]>>
}): React.JSX.Element | null

export declare const KIND_COLORS: Record<SceneObjectKind, { body: string; accent: string }>

export declare function startMockRealtime(intervalMs?: number): () => void
