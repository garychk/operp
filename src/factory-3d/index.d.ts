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
  className?: string
  style?: React.CSSProperties
}

export declare const LIB_DICT: Record<'zh' | 'en', {
  status: Record<DeviceStatus, string>
  sceneStatus: Record<SceneStatus, string>
  opStatus: Record<OrderOperation['operation_status'], string>
  kitStatus: Record<OrderData['material_kit_status'], string>
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
}

export declare const useFactoryStore: import('zustand').UseBoundStore<
  import('zustand').StoreApi<FactoryState>
>

export declare function startMockRealtime(intervalMs?: number): () => void
