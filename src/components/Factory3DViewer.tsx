import { useEffect, useMemo, useState } from "react";
import { Modal, Select, Button, InputNumber, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  FactoryScene,
  fromDeviceRows,
  useFactoryStore,
  STATUS_COLORS,
  LIB_DICT,
  normalizeLocale,
} from "factory-3d";
import type {
  DeviceLayoutChange,
  DeviceRow,
  OrderData,
  OrderOperation,
  SceneStatus,
  SceneObject,
  SceneObjectKind,
  SceneObjectChange,
} from "factory-3d";
import { supabase } from "../utils/supabase";
import { useErpDarkMode } from "../hooks/useErpDarkMode";
import "./Factory3DViewer.css";

/**
 * 3D 工厂生产驾驶舱（独立组件）。
 *
 * 布局与交互完全复刻 factory-3d 源仓库的演示驾驶舱 DemoApp（src/demo/DemoApp.tsx）：
 *   · 顶部 HUD：标题 + KPI 条（平均订单进度 / 设备运行 / 在制订单 / 缺料订单 / 逾期）+ 状态图例；
 *   · 右侧 HUD（296px）：三态切换 —— 订单列表 → 订单详情（点订单）/ 设备详情（点设备），含返回。
 * 唯一差异：数据来自 deploy_135 三个 RLS 视图（真实数据），主题/语言由 ERP 宿主控制
 * （DemoApp 的主题/语言切换按钮在集成场景下移除）。
 *
 * 3D 场景由 FactoryScene 渲染；点击设备/订单的选中态走 factory-3d 内建的 zustand store
 * （selectedDeviceCode / selectedOrderId）。
 */
export interface Factory3DViewerProps {
  open: boolean;
  onClose: () => void;
}

const SCENE_ORDER: SceneStatus[] = ["running", "idle", "offline"];

/** BOM 展开后的工单材料行（来自 vw_factory_3d_order_materials） */
interface OrderMaterial {
  order_id: number;
  order_no: string;
  order_detail_id: number;
  line_no: number;
  material_id: number | null;
  material_code: string | null;
  material_name: string | null;
  material_spec: string | null;
  planned_quantity: number | null;
  issued_quantity: number | null;
  onhand_quantity: number | null;
  unit: string | null;
}

/** 工作中心当班订单行（来自 vw_factory_3d_work_center_orders，按工序 work_center_id 匹配） */
interface WorkCenterOrder {
  work_center_id: number;
  order_id: number;
  order_no: string;
  product_name: string | null;
  planned_quantity: number | null;
  operation_progress_percent: number | null;
  actual_start_date: string | null;
  wc_op_total: number;
  wc_op_in_progress: number;
}

const num = (v: number | null | undefined) => Number(v || 0);
const round = (v: number | null | undefined) => Math.round(num(v));

/** 各类型可绑定业务对象下拉清单（AGV/仓库/人员/货车） */
type BindingOptions = Partial<Record<SceneObjectKind, { id: number | string; label: string }[]>>;

/** 场景对象持久化行（factory_3d_scene_object） */
interface SceneObjectRow {
  id: number;
  obj_id: string;
  kind: SceneObjectKind;
  name: string;
  scene_x: number;
  scene_z: number;
  bind_id: string | null;
  bind_label: string | null;
  status: string | null;
}

/** 可指派的未开工生产订单（有工序且全部 pending） */
interface AssignableOrder {
  order_id: number;
  order_no: string;
  product_name: string | null;
  planned_quantity: number | null;
}

/** 待指派的工序行 */
interface AssignableOperation {
  id: number;
  sequence_no: number;
  operation_name: string | null;
  work_center_id: number | null;
}

/** 可开工的已下达生产订单（released 且已把工序指派到当前工作中心） */
interface StartableOrder {
  order_id: number;
  order_no: string;
  product_name: string | null;
  planned_quantity: number | null;
}

/** 产能负荷行（来自 vw_erp_capacity_load，每个工作中心 + 月份一行） */
interface CapacityLoad {
  work_center_id: number;
  work_center_name: string | null;
  month_start: string | null;
  load_rate: number | null;
}

/** 库位库存行（来自 vw_factory_3d_bin_stock，按仓库 + 库位聚合） */
interface BinStock {
  warehouse_id: number;
  warehouse_code: string | null;
  warehouse_name: string | null;
  bin_id: number | null;
  bin_code: string | null;
  bin_name: string | null;
  bin_location: string | null;
  on_hand_quantity: number | null;
  locked_quantity: number | null;
  available_quantity: number | null;
}

/** 员工信息（来自 erp_employees，含排班外键） */
interface EmployeeInfo {
  id: number;
  code: string;
  name: string;
  department_id: number | null;
  department_name: string | null;
  position: string | null;
  phone: string | null;
  email: string | null;
  entry_date: string | null;
  status: string | null;
  shift_id: number | null;
  work_center_id: number | null;
  work_center_name: string | null;
}

/** 班次（来自 erp_shifts） */
interface ShiftInfo {
  id: number;
  shift_name: string;
  start_time: string | null;
  end_time: string | null;
  cross_midnight: boolean;
  net_hours: number | null;
}

/** 员工工作负荷（来自 vw_erp_employee_load，按员工 × 月一行） */
interface EmployeeLoad {
  employee_id: number;
  employee_code: string;
  employee_name: string;
  shift_name: string | null;
  shift_net_hours: number | null;
  month_start: string | null;
  labor_hours: number | null;
  machine_hours: number | null;
  load_hours: number | null;
  capacity_hours: number | null;
  load_rate: number | null;
  work_day_count: number | null;
}

/** 未确认报工单（来自 erp_production_reports，status='draft'） */
interface DraftReport {
  id: number;
  report_no: string;
  report_date: string | null;
  production_order_id: number | null;
  order_operation_id: number | null;
  operation_id: number | null;
  operator_id: number | null;
  completed_quantity: number | null;
  scrapped_quantity: number | null;
  labor_hours: number | null;
  machine_hours: number | null;
  status: string | null;
}


export function Factory3DViewer({ open, onClose }: Factory3DViewerProps) {
  const { t, i18n } = useTranslation();
  const isDark = useErpDarkMode();
  const [loaded, setLoaded] = useState(false);
  const [materials, setMaterials] = useState<OrderMaterial[]>([]);
  const [workCenterOrders, setWorkCenterOrders] = useState<WorkCenterOrder[]>([]);
  const [capacityLoads, setCapacityLoads] = useState<CapacityLoad[]>([]);
  const [binStocks, setBinStocks] = useState<BinStock[]>([]);
  const [employees, setEmployees] = useState<EmployeeInfo[]>([]);
  const [shifts, setShifts] = useState<ShiftInfo[]>([]);
  const [employeeLoads, setEmployeeLoads] = useState<EmployeeLoad[]>([]);
  const [draftReports, setDraftReports] = useState<DraftReport[]>([]);
  const [layoutMode, setLayoutMode] = useState(false);
  const [bindingOptions, setBindingOptions] = useState<BindingOptions>({});

  // 指派工作中心到未开工生产订单
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignableOrders, setAssignableOrders] = useState<AssignableOrder[]>([]);
  const [assignOrdersLoading, setAssignOrdersLoading] = useState(false);
  const [selectedAssignOrderId, setSelectedAssignOrderId] = useState<number | null>(null);
  const [assignableOps, setAssignableOps] = useState<AssignableOperation[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);

  // 开工已下达生产订单
  const [startOpen, setStartOpen] = useState(false);
  const [startLoading, setStartLoading] = useState(false);
  const [startableOrders, setStartableOrders] = useState<StartableOrder[]>([]);
  const [startOrdersLoading, setStartOrdersLoading] = useState(false);
  const [selectedStartOrderId, setSelectedStartOrderId] = useState<number | null>(null);

  // 人员派工：从未确认报工单里选一条，填完工/报废数量提交，并把状态改为 confirmed
  const [assignReportOpen, setAssignReportOpen] = useState(false);
  const [assignReportLoading, setAssignReportLoading] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
  const [assignCompletedQty, setAssignCompletedQty] = useState<number | null>(null);
  const [assignScrappedQty, setAssignScrappedQty] = useState<number | null>(null);

  const deviceRows = useFactoryStore((s) => s.deviceRows);
  const orders = useFactoryStore((s) => s.orders);
  const operations = useFactoryStore((s) => s.operations);
  const selectedDeviceCode = useFactoryStore((s) => s.selectedDeviceCode);
  const selectedOrderId = useFactoryStore((s) => s.selectedOrderId);
  const selectDevice = useFactoryStore((s) => s.selectDevice);
  const selectOrder = useFactoryStore((s) => s.selectOrder);
  const sceneObjects = useFactoryStore((s) => s.sceneObjects);
  const selectedSceneObjectId = useFactoryStore((s) => s.selectedSceneObjectId);
  const selectSceneObject = useFactoryStore((s) => s.selectSceneObject);

  const locale = normalizeLocale(i18n.language);
  const dict = LIB_DICT[locale];

  // ---------------------------------------------------------------- 数据加载
  useEffect(() => {
    if (!open) return;

    let dispose: (() => void) | undefined;

    const load = async () => {
      const { setDeviceRows, setOrders, setOperations, setSceneObjects } =
        useFactoryStore.getState();
      const [dev, ord, ops, mat, wco, cap, bst, agvs, whs, emps, trks, wcs, objs, shfts, depts, eld, drf] = await Promise.all([
        supabase.from("vw_factory_3d_devices").select("*"),
        supabase.from("vw_factory_3d_orders").select("*"),
        supabase.from("vw_factory_3d_order_operations").select("*"),
        supabase.from("vw_factory_3d_order_materials").select("*"),
        supabase.from("vw_factory_3d_work_center_orders").select("*"),
        supabase.from("vw_erp_capacity_load").select("*"),
        supabase.from("vw_factory_3d_bin_stock").select("*"),
        supabase.from("erp_agvs_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("erp_warehouses_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase
          .from("erp_employees_s_539dcf81_b")
          .select("id, code, name, department_id, position, phone, email, entry_date, status, shift_id, work_center_id")
          .eq("is_deleted", "n"),
        supabase.from("erp_vehicles_s_539dcf81_b").select("id, plate_no").eq("is_deleted", "n"),
        supabase.from("erp_work_centers_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("factory_3d_scene_object_s_539dcf81_b").select("*").eq("is_deleted", "n"),
        supabase.from("erp_shifts_s_539dcf81_b").select("id, shift_name, start_time, end_time, cross_midnight, net_hours").eq("is_deleted", "n"),
        supabase.from("erp_departments_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("vw_erp_employee_load").select("*"),
        supabase
          .from("erp_production_reports_s_539dcf81_b")
          .select("id, report_no, report_date, production_order_id, order_operation_id, operation_id, operator_id, completed_quantity, scrapped_quantity, labor_hours, machine_hours, status")
          .eq("is_deleted", "n")
          .eq("status", "draft"),
      ]);
      const deviceRowsData = (dev.data ?? []) as DeviceRow[];
      if (dev.data) setDeviceRows(deviceRowsData);
      if (ord.data) setOrders(ord.data as OrderData[]);
      if (ops.data) setOperations(ops.data as OrderOperation[]);
      if (mat.data) setMaterials(mat.data as OrderMaterial[]);
      if (wco.data) setWorkCenterOrders(wco.data as WorkCenterOrder[]);
      if (cap.data) setCapacityLoads(cap.data as CapacityLoad[]);
      if (bst.data) setBinStocks(bst.data as BinStock[]);
      if (eld.data) setEmployeeLoads(eld.data as EmployeeLoad[]);
      if (drf.data) setDraftReports(drf.data as DraftReport[]);

      // 员工 / 班次 / 部门：前端 join（部门名、工位名）
      const deptMap = new Map((depts.data ?? []).map((d) => [d.id, d.name]));
      const wcMap = new Map((wcs.data ?? []).map((w) => [w.id, w.name]));
      const empRows = (emps.data ?? []) as Array<{
        id: number;
        code: string;
        name: string;
        department_id: number | null;
        position: string | null;
        phone: string | null;
        email: string | null;
        entry_date: string | null;
        status: string | null;
        shift_id: number | null;
        work_center_id: number | null;
      }>;
      setEmployees(
        empRows.map((e) => ({
          ...e,
          department_name: e.department_id != null ? deptMap.get(e.department_id) ?? null : null,
          work_center_name:
            e.work_center_id != null ? wcMap.get(e.work_center_id) ?? null : null,
        })),
      );
      if (shfts.data) {
        setShifts(
          (shfts.data as ShiftInfo[]).map((s) => ({
            ...s,
            start_time: typeof s.start_time === "string" ? s.start_time.slice(0, 5) : s.start_time,
            end_time: typeof s.end_time === "string" ? s.end_time.slice(0, 5) : s.end_time,
          })),
        );
      }

      // 已在场景中作为「设备」出现的工作中心 id 集合（设备视图本身就是工作中心）
      const existingWcIds = new Set(
        deviceRowsData.map((r) => r.device_id).filter((id): id is number => id != null),
      );

      // 各类型可绑定业务对象清单；work_center 过滤掉场景中已存在的工作中心
      setBindingOptions({
        work_center: (wcs.data ?? [])
          .filter((r) => !existingWcIds.has(r.id))
          .map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` })),
        agv: (agvs.data ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` })),
        warehouse: (whs.data ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` })),
        person: (emps.data ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` })),
        truck: (trks.data ?? []).map((r) => ({ id: r.id, label: r.plate_no })),
      });

      // 已持久化的场景对象 → 还原到场景
      const rows = (objs.data ?? []) as SceneObjectRow[];
      if (rows.length > 0) {
        setSceneObjects(
          rows.map((r) => ({
            id: r.obj_id,
            kind: r.kind,
            name: r.name,
            position: [r.scene_x, 0, r.scene_z],
            bindId: r.bind_id ?? undefined,
            bindLabel: r.bind_label ?? undefined,
            status: (r.status as SceneObject["status"]) ?? undefined,
          })),
        );
      }
      setLoaded(true);
    };

    // 视图不进 postgres_changes，监听底层业务表变更后重拉
    const channel = supabase
      .channel("factory-3d")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "erp_production_order_operations_s_539dcf81_b" },
        () => { void load(); },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "erp_production_orders_s_539dcf81_b" },
        () => { void load(); },
      )
      .subscribe();

    dispose = () => {
      supabase.removeChannel(channel);
    };

    void load();
    return () => dispose?.();
  }, [open]);

  // 关闭时清空选中态，避免下次打开残留
  useEffect(() => {
    if (!open) {
      selectDevice(null);
      selectOrder(null);
      selectSceneObject(null);
      setLayoutMode(false);
      setAssignOpen(false);
      setStartOpen(false);
    }
  }, [open, selectDevice, selectOrder, selectSceneObject]);

  // 重新拉设备视图（拖拽回写后刷新 scene_x/scene_z）
  const refreshDevices = async () => {
    const { setDeviceRows } = useFactoryStore.getState();
    const { data } = await supabase.from("vw_factory_3d_devices").select("*");
    if (data) setDeviceRows(data as DeviceRow[]);
  };

  // 拖拽落位回写：把待回写坐标写入布局表后清空 pendingLayout，并刷新设备坐标。
  // 布局表唯一索引是「部分索引」(tenant_id,work_center_id WHERE is_deleted='n')，
  // PostgreSQL 的 ON CONFLICT 不支持部分索引，故改为「先查后写」：存在则 update、否则 insert。
  const handleLayoutChange = async (changes: DeviceLayoutChange[]) => {
    const rows = changes
      .filter((c) => c.deviceId != null)
      .map((c) => ({
        work_center_id: c.deviceId!,
        scene_x: c.sceneX,
        scene_z: c.sceneZ,
      }));
    if (rows.length === 0) return;

    // 查出这些工作中心已存在的未删布局行（RLS 自动带租户隔离）
    const ids = rows.map((r) => r.work_center_id);
    const { data: existing, error: qErr } = await supabase
      .from("factory_3d_device_layout_s_539dcf81_b")
      .select("id, work_center_id")
      .in("work_center_id", ids)
      .eq("is_deleted", "n");
    if (qErr) {
      console.error("3D 布局回写失败（查询）：", qErr.message);
      return;
    }

    const existingMap = new Map(
      (existing ?? []).map((e) => [e.work_center_id, e.id]),
    );
    const toUpdate = rows.filter((r) => existingMap.has(r.work_center_id));
    const toInsert = rows.filter((r) => !existingMap.has(r.work_center_id));

    if (toUpdate.length > 0) {
      const { error } = await supabase
        .from("factory_3d_device_layout_s_539dcf81_b")
        .upsert(toUpdate.map((r) => ({ id: existingMap.get(r.work_center_id), ...r })));
      if (error) {
        console.error("3D 布局回写失败（更新）：", error.message);
        return;
      }
    }
    if (toInsert.length > 0) {
      const { error } = await supabase
        .from("factory_3d_device_layout_s_539dcf81_b")
        .insert(toInsert);
      if (error) {
        console.error("3D 布局回写失败（新增）：", error.message);
        return;
      }
    }

    useFactoryStore.getState().clearPendingLayout();
    await refreshDevices();
  };

  // 场景对象单条变更增量持久化（add/move/rename/bind/remove）
  const handleSceneObjectChange = async (change: SceneObjectChange) => {
    const { action, object } = change;
    const base = {
      obj_id: object.id,
      kind: object.kind,
      name: object.name,
      scene_x: object.position[0],
      scene_z: object.position[2],
      bind_id: object.bindId != null ? String(object.bindId) : null,
      bind_label: object.bindLabel ?? null,
      status: object.status ?? null,
    };
    if (action === "remove") {
      const { error } = await supabase
        .from("factory_3d_scene_object_s_539dcf81_b")
        .update({ is_deleted: "y" })
        .eq("obj_id", object.id);
      if (error) console.error("3D 场景对象删除失败：", error.message);
      return;
    }
    // add/move/rename/bind 都走 upsert（obj_id 为键，场景对象表唯一索引是
    // 部分索引 (tenant_id,obj_id WHERE is_deleted='n')，同样不支持 ON CONFLICT，
    // 故先查后写）
    const { data: existing, error: qErr } = await supabase
      .from("factory_3d_scene_object_s_539dcf81_b")
      .select("id")
      .eq("obj_id", object.id)
      .eq("is_deleted", "n")
      .maybeSingle();
    if (qErr) {
      console.error("3D 场景对象查询失败：", qErr.message);
      return;
    }
    if (existing) {
      const { error } = await supabase
        .from("factory_3d_scene_object_s_539dcf81_b")
        .update(base)
        .eq("id", existing.id);
      if (error) console.error("3D 场景对象更新失败：", error.message);
    } else {
      const { error } = await supabase
        .from("factory_3d_scene_object_s_539dcf81_b")
        .insert(base);
      if (error) console.error("3D 场景对象新增失败：", error.message);
    }
  };

  // ---------------------------------------------------------------- 指派工作中心

  // 打开指派弹窗：加载「已下达(released)」生产订单
  const openAssign = async () => {
    setAssignOpen(true);
    setAssignOrdersLoading(true);
    setSelectedAssignOrderId(null);
    setAssignableOps([]);
    setSelectedOpIds([]);
    try {
      // 已下达订单：status = 'released' 且未删除
      const { data: ordRows, error: ordErr } = await supabase
        .from("erp_production_orders_s_539dcf81_b")
        .select("id, order_no, planned_quantity, product_id")
        .eq("is_deleted", "n")
        .eq("status", "released");
      if (ordErr) {
        console.error("加载可指派订单失败：", ordErr.message);
        setAssignableOrders([]);
        return;
      }
      if (!ordRows || ordRows.length === 0) {
        setAssignableOrders([]);
        return;
      }
      // 产品名：查产品表
      const productIds = Array.from(
        new Set((ordRows ?? []).map((r) => r.product_id).filter((id): id is number => id != null)),
      );
      let productNameMap = new Map<number, string>();
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from("erp_products_s_539dcf81_b")
          .select("id, name")
          .in("id", productIds);
        productNameMap = new Map(
          (prods ?? []).map((p) => [p.id as number, p.name as string]),
        );
      }

      const list: AssignableOrder[] = (ordRows ?? []).map((r) => ({
        order_id: r.id as number,
        order_no: r.order_no as string,
        product_name: productNameMap.get(r.product_id as number) ?? null,
        planned_quantity: r.planned_quantity as number | null,
      }));
      setAssignableOrders(list);
    } finally {
      setAssignOrdersLoading(false);
    }
  };

  // 选中订单后加载其 pending 工序
  const loadAssignableOps = async (orderId: number) => {
    setSelectedAssignOrderId(orderId);
    setAssignableOps([]);
    setSelectedOpIds([]);
    setOpsLoading(true);
    try {
      const { data, error } = await supabase
        .from("erp_production_order_operations_s_539dcf81_b")
        .select("id, sequence_no, work_center_id, operation_id")
        .eq("order_id", orderId)
        .eq("is_deleted", "n")
        .eq("status", "pending")
        .order("sequence_no", { ascending: true });
      if (error) {
        console.error("加载待排工序失败：", error.message);
        return;
      }
      // 工序名：查工序表
      const opIds = Array.from(
        new Set((data ?? []).map((r) => r.operation_id).filter((id): id is number => id != null)),
      );
      let opNameMap = new Map<number, string>();
      if (opIds.length > 0) {
        const { data: opRows } = await supabase
          .from("erp_operations_s_539dcf81_b")
          .select("id, name")
          .in("id", opIds);
        opNameMap = new Map((opRows ?? []).map((o) => [o.id as number, o.name as string]));
      }
      setAssignableOps(
        (data ?? []).map((r) => ({
          id: r.id as number,
          sequence_no: r.sequence_no as number,
          operation_name: opNameMap.get(r.operation_id as number) ?? null,
          work_center_id: r.work_center_id as number | null,
        })),
      );
    } finally {
      setOpsLoading(false);
    }
  };

  // 提交指派：把选中工序的 work_center_id 更新为当前工作中心 id
  const submitAssign = async () => {
    if (selectedOpIds.length === 0) {
      message.warning(t("factory3dViewer.assignEmptyOps"));
      return;
    }
    const wcId = selectedRow?.device_id;
    if (wcId == null) return;
    setAssignLoading(true);
    try {
      const { error } = await supabase
        .from("erp_production_order_operations_s_539dcf81_b")
        .update({ work_center_id: wcId })
        .in("id", selectedOpIds);
      if (error) {
        console.error("指派失败：", error.message);
        message.error(error.message);
        return;
      }
      message.success(t("factory3dViewer.assignOk", { n: selectedOpIds.length }));
      setAssignOpen(false);
      // 刷新数据：订单/工序/设备视图（postgres_changes 也会触发，这里显式刷新确保即时）
      void refreshDevices();
      const [ord, ops] = await Promise.all([
        supabase.from("vw_factory_3d_orders").select("*"),
        supabase.from("vw_factory_3d_order_operations").select("*"),
      ]);
      const { setOrders, setOperations } = useFactoryStore.getState();
      if (ord.data) setOrders(ord.data as OrderData[]);
      if (ops.data) setOperations(ops.data as OrderOperation[]);
    } finally {
      setAssignLoading(false);
    }
  };

  // ---------------------------------------------------------------- 开工生产订单

  // 打开开工弹窗：加载「已下达(released)且已把工序指派到当前工作中心」的订单
  const openStart = async () => {
    const wcId = selectedRow?.device_id;
    if (wcId == null) return;
    setStartOpen(true);
    setStartOrdersLoading(true);
    setSelectedStartOrderId(null);
    try {
      // 已指派到本工作中心：存在 work_center_id = 当前设备 id 的工序行（未删）
      const { data: opRows, error: opErr } = await supabase
        .from("erp_production_order_operations_s_539dcf81_b")
        .select("order_id")
        .eq("is_deleted", "n")
        .eq("work_center_id", wcId);
      if (opErr) {
        console.error("加载可开工订单失败：", opErr.message);
        setStartableOrders([]);
        return;
      }
      const assignedOrderIds = Array.from(
        new Set((opRows ?? []).map((r) => r.order_id as number)),
      );
      if (assignedOrderIds.length === 0) {
        setStartableOrders([]);
        return;
      }
      // 再查这些订单中状态为 released 的（开工前置条件）
      const { data: ordRows, error: ordErr } = await supabase
        .from("erp_production_orders_s_539dcf81_b")
        .select("id, order_no, planned_quantity, product_id, status")
        .eq("is_deleted", "n")
        .eq("status", "released")
        .in("id", assignedOrderIds);
      if (ordErr) {
        console.error("加载可开工订单失败：", ordErr.message);
        setStartableOrders([]);
        return;
      }
      // 产品名
      const productIds = Array.from(
        new Set((ordRows ?? []).map((r) => r.product_id).filter((id): id is number => id != null)),
      );
      let productNameMap = new Map<number, string>();
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from("erp_products_s_539dcf81_b")
          .select("id, name")
          .in("id", productIds);
        productNameMap = new Map((prods ?? []).map((p) => [p.id as number, p.name as string]));
      }
      setStartableOrders(
        (ordRows ?? []).map((r) => ({
          order_id: r.id as number,
          order_no: r.order_no as string,
          product_name: productNameMap.get(r.product_id as number) ?? null,
          planned_quantity: r.planned_quantity as number | null,
        })),
      );
    } finally {
      setStartOrdersLoading(false);
    }
  };

  // 提交开工：调 RPC start_production_order
  const submitStart = async () => {
    if (selectedStartOrderId == null) return;
    setStartLoading(true);
    try {
      const { data, error } = await supabase.rpc("start_production_order", {
        p_order_id: selectedStartOrderId,
      });
      if (error) {
        console.error("开工失败：", error.message);
        message.error(error.message);
        return;
      }
      const result = data as { order_no?: string } | null;
      const target = startableOrders.find((o) => o.order_id === selectedStartOrderId);
      message.success(
        t("factory3dViewer.startOk", { no: result?.order_no ?? target?.order_no ?? "" }),
      );
      setStartOpen(false);
      // 刷新订单/工序/设备视图
      void refreshDevices();
      const [ord, ops] = await Promise.all([
        supabase.from("vw_factory_3d_orders").select("*"),
        supabase.from("vw_factory_3d_order_operations").select("*"),
      ]);
      const { setOrders, setOperations } = useFactoryStore.getState();
      if (ord.data) setOrders(ord.data as OrderData[]);
      if (ops.data) setOperations(ops.data as OrderOperation[]);
    } finally {
      setStartLoading(false);
    }
  };

  // 打开人员派工弹窗：重置选择，列出该员工的未确认报工单
  const openAssignReport = () => {
    setSelectedReportId(null);
    setAssignCompletedQty(null);
    setAssignScrappedQty(null);
    setAssignReportOpen(true);
  };

  // 提交派工：更新完工/报废数量，人工工时=完工数量×工序标准工时，并把报工单状态改为 confirmed
  const submitAssignReport = async () => {
    if (selectedReportId == null) {
      message.warning(t("factory3dViewer.assignReportEmpty"));
      return;
    }
    // 找到所选报工单及其关联的工单工序，取单位标准工时
    const report = selectedEmployeeDraftReports.find((r) => r.id === selectedReportId);
    const op = report
      ? operations.find((o) => o.order_operation_id === report.order_operation_id)
      : undefined;
    const standardHoursPerUnit = num(op?.standard_hours_per_unit);
    const completedQty = Number(assignCompletedQty || 0);
    // 人工工时 = 完工数量 × 工序单位标准工时
    const laborHours = completedQty * standardHoursPerUnit;

    setAssignReportLoading(true);
    try {
      const { error } = await supabase
        .from("erp_production_reports_s_539dcf81_b")
        .update({
          completed_quantity: completedQty,
          scrapped_quantity: Number(assignScrappedQty || 0),
          labor_hours: laborHours,
          status: "confirmed",
          // 报工人改为当前派工的人员
          operator_id: selectedEmployee?.id ?? null,
        })
        .eq("id", selectedReportId);
      if (error) throw error;

      // 同时把这道工序的派工对象 assignee_id 改为当前人员，
      // 这样人员详情「所在工单工序」、按 assignee 的工作负荷归属都正确
      if (report?.order_operation_id != null && selectedEmployee?.id != null) {
        const { error: opErr } = await supabase
          .from("erp_production_order_operations_s_539dcf81_b")
          .update({ assignee_id: selectedEmployee.id })
          .eq("id", report.order_operation_id);
        if (opErr) throw opErr;
      }

      message.success(t("factory3dViewer.assignReportOk"));
      setAssignReportOpen(false);
      // 刷新 draft 报工单列表
      const { data } = await supabase
        .from("erp_production_reports_s_539dcf81_b")
        .select("id, report_no, report_date, production_order_id, order_operation_id, operation_id, operator_id, completed_quantity, scrapped_quantity, labor_hours, machine_hours, status")
        .eq("is_deleted", "n")
        .eq("status", "draft");
      if (data) setDraftReports(data as DraftReport[]);
      // 刷新工序视图（assignee_id 变更 + 报工确认后的完工数/进度变化）
      const { data: opsData } = await supabase
        .from("vw_factory_3d_order_operations")
        .select("*");
      if (opsData) useFactoryStore.getState().setOperations(opsData as OrderOperation[]);
    } catch (err) {
      console.error("派工失败：", (err as Error).message);
      message.error((err as Error).message);
    } finally {
      setAssignReportLoading(false);
    }
  };

  const selectedRow =
    deviceRows.find((r) => r.device_code === selectedDeviceCode) ?? null;
  const selectedOrder: OrderData | null =
    orders.find((o) => o.order_id === selectedOrderId) ?? null;
  // 当前工作中心的全部当班订单（按工序 work_center_id 匹配，不只看订单头）
  const selectedWorkCenterOrders: WorkCenterOrder[] = useMemo(
    () =>
      workCenterOrders
        .filter((o) => o.work_center_id === selectedRow?.device_id)
        .sort((a, b) => num(b.operation_progress_percent) - num(a.operation_progress_percent)),
    [workCenterOrders, selectedRow?.device_id],
  );
  // 当前工作中心的产能负荷（取最近一个月的 load_rate）
  const selectedCapacityLoad: CapacityLoad | null = useMemo(() => {
    const rows = capacityLoads
      .filter((c) => c.work_center_id === selectedRow?.device_id)
      .sort((a, b) => (b.month_start ?? "").localeCompare(a.month_start ?? ""));
    return rows[0] ?? null;
  }, [capacityLoads, selectedRow?.device_id]);
  // 当前选中的场景对象（仓储房屋等）
  const selectedSceneObject: SceneObject | null = useMemo(
    () => sceneObjects.find((o) => o.id === selectedSceneObjectId) ?? null,
    [sceneObjects, selectedSceneObjectId],
  );
  // 选中仓储对象时，该仓库下所有库位的库存（bindId = 仓库 id）
  const selectedWarehouseBins: BinStock[] = useMemo(() => {
    if (!selectedSceneObject || selectedSceneObject.kind !== "warehouse") return [];
    const wid = selectedSceneObject.bindId;
    if (wid == null) return [];
    return binStocks.filter((b) => b.warehouse_id === Number(wid));
  }, [selectedSceneObject, binStocks]);

  // 选中人员对象时，该员工信息（bindId = 员工 id）
  const selectedEmployee: EmployeeInfo | null = useMemo(() => {
    if (!selectedSceneObject || selectedSceneObject.kind !== "person") return null;
    const eid = selectedSceneObject.bindId;
    if (eid == null) return null;
    return employees.find((e) => e.id === Number(eid)) ?? null;
  }, [selectedSceneObject, employees]);

  // 选中人员的当前班次
  const selectedEmployeeShift: ShiftInfo | null = useMemo(() => {
    if (!selectedEmployee || selectedEmployee.shift_id == null) return null;
    return shifts.find((s) => s.id === selectedEmployee.shift_id) ?? null;
  }, [selectedEmployee, shifts]);

  // 选中人员的当月工作负荷（取最近一个月的负荷行）
  const selectedEmployeeLoad: EmployeeLoad | null = useMemo(() => {
    if (!selectedEmployee) return null;
    const rows = employeeLoads
      .filter((l) => l.employee_id === selectedEmployee.id)
      .sort((a, b) => (b.month_start ?? "").localeCompare(a.month_start ?? ""));
    return rows[0] ?? null;
  }, [selectedEmployee, employeeLoads]);

  // 未确认（draft）报工单，供派工选择（不过滤当前员工，所有未确认报工单均可选）
  const selectedEmployeeDraftReports: DraftReport[] = useMemo(() => {
    return draftReports;
  }, [draftReports]);

  // 选中人员被派工的工序（按 assignee_id 匹配，含工单号/工序名/状态/进度）
  const selectedEmployeeOperations: OrderOperation[] = useMemo(() => {
    if (!selectedEmployee) return [];
    return operations
      .filter((op) => op.assignee_id === selectedEmployee.id)
      .sort((a, b) => {
        if (a.order_no !== b.order_no) return a.order_no.localeCompare(b.order_no);
        return a.sequence_no - b.sequence_no;
      });
  }, [selectedEmployee, operations]);

  const selectedOrderOps: OrderOperation[] = useMemo(
    () =>
      operations
        .filter((op) => op.order_id === selectedOrderId)
        .sort((a, b) => a.line_no - b.line_no),
    [operations, selectedOrderId],
  );
  const selectedOrderMaterials: OrderMaterial[] = useMemo(
    () =>
      materials
        .filter((m) => m.order_id === selectedOrderId)
        .sort((a, b) => a.line_no - b.line_no),
    [materials, selectedOrderId],
  );

  const kpis = useMemo(() => {
    const running = deviceRows.filter((r) => r.scene_status === "running").length;
    const short = orders.filter((o) => o.material_kit_status === "short").length;
    const avgProgress = orders.length
      ? Math.round(orders.reduce((s, o) => s + num(o.progress_pct), 0) / orders.length)
      : 0;
    const delayed = orders.filter((o) => num(o.delay_days) > 0).length;
    return { running, short, avgProgress, delayed };
  }, [deviceRows, orders]);

  // ---------------------------------------------------------------- 渲染
  return (
    <>
      <div className="f3d-viewer">
        {/* 3D 场景 */}
        <div className="f3d-canvas">
          {loaded ? (
            <FactoryScene
              devices={deviceRows.length > 0 ? fromDeviceRows(deviceRows) : undefined}
              theme={isDark ? "dark" : "light"}
              locale={i18n.language}
              layoutEditable={layoutMode}
              onLayoutChange={handleLayoutChange}
              bindingOptions={bindingOptions}
              onSceneObjectChange={handleSceneObjectChange}
            />
          ) : (
            <div style={{ padding: 24, color: "#9aa0a9" }}>…</div>
          )}
        </div>

        {/* 顶部 KPI 条 */}
        <header className="f3d-hud f3d-hud-top">
          <div className="f3d-kpis">
            <div className="f3d-kpi">
              <span className="f3d-kpi-label">{t("factory3dViewer.kpiAvgProgress")}</span>
              <span className="f3d-kpi-value">{kpis.avgProgress}%</span>
            </div>
            <div className="f3d-kpi">
              <span className="f3d-kpi-label">{t("factory3dViewer.kpiDevices")}</span>
              <span className="f3d-kpi-value">
                {kpis.running}
                <small> / {deviceRows.length}</small>
              </span>
            </div>
            <div className="f3d-kpi">
              <span className="f3d-kpi-label">{t("factory3dViewer.kpiOrders")}</span>
              <span className="f3d-kpi-value">{orders.length}</span>
            </div>
            <div className="f3d-kpi">
              <span className="f3d-kpi-label">{t("factory3dViewer.kpiShort")}</span>
              <span className="f3d-kpi-value f3d-danger">{kpis.short}</span>
            </div>
            <div className="f3d-kpi">
              <span className="f3d-kpi-label">{t("factory3dViewer.kpiOverdue")}</span>
              <span className="f3d-kpi-value f3d-danger">{kpis.delayed}</span>
            </div>
          </div>
          <div className="f3d-legend">
            <button
              className={`f3d-layout-toggle${layoutMode ? " active" : ""}`}
              onClick={() => setLayoutMode((v) => !v)}
            >
              {t("factory3dViewer.layoutEdit")}
            </button>
            {SCENE_ORDER.map((s) => (
              <span key={s} className="f3d-legend-item">
                <i style={{ background: STATUS_COLORS[s] }} />
                {dict.sceneStatus[s]}{" "}
                {deviceRows.filter((r) => r.scene_status === s).length}
              </span>
            ))}
          </div>
        </header>

        {/* 右侧面板：仓储详情 / 订单列表 / 订单详情 / 设备详情 */}
        <aside className="f3d-hud f3d-hud-right">
          {selectedSceneObject?.kind === "warehouse" ? (
            <>
              <button className="f3d-back" onClick={() => selectSceneObject(null)}>
                {t("factory3dViewer.backToOrders")}
              </button>
              <h2>{selectedSceneObject.bindLabel ?? selectedSceneObject.name}</h2>
              <p className="f3d-dim">{t("factory3dViewer.warehouse")}</p>
              {selectedWarehouseBins.length > 0 ? (
                <>
                  <div className="f3d-section-title">
                    {t("factory3dViewer.bins")}（{selectedWarehouseBins.length}）
                  </div>
                  <ul className="f3d-orders">
                    {selectedWarehouseBins.map((b) => (
                      <li key={b.bin_id ?? b.warehouse_id} className="f3d-order-item">
                        <div className="f3d-order-line1">
                          <b>{b.bin_name ?? b.bin_code ?? "—"}</b>
                          <span className="f3d-dim">
                            {b.bin_location ? ` · ${b.bin_location}` : ""}
                          </span>
                        </div>
                        <div className="f3d-order-line2">
                          <span>{t("factory3dViewer.onHand")}：{round(b.on_hand_quantity)}</span>
                          <span>{t("factory3dViewer.locked")}：{round(b.locked_quantity)}</span>
                          <span>{t("factory3dViewer.available")}：{round(b.available_quantity)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noBins")}</p>
              )}
            </>
          ) : selectedSceneObject?.kind === "person" ? (
            <>
              <button className="f3d-back" onClick={() => selectSceneObject(null)}>
                {t("factory3dViewer.backToOrders")}
              </button>
              <h2>{selectedSceneObject.bindLabel ?? selectedSceneObject.name}</h2>
              <p className="f3d-dim">{t("factory3dViewer.person")}</p>

              {/* 员工基本信息 */}
              {selectedEmployee ? (
                <div className="f3d-emp-info">
                  <p>
                    <span className="f3d-dim">{t("factory3dViewer.empCode")}：</span>
                    <b>{selectedEmployee.code}</b>
                  </p>
                  {selectedEmployee.department_name && (
                    <p>
                      <span className="f3d-dim">{t("factory3dViewer.empDepartment")}：</span>
                      {selectedEmployee.department_name}
                    </p>
                  )}
                  {selectedEmployee.position && (
                    <p>
                      <span className="f3d-dim">{t("factory3dViewer.empPosition")}：</span>
                      {selectedEmployee.position}
                    </p>
                  )}
                  {selectedEmployee.work_center_name && (
                    <p>
                      <span className="f3d-dim">{t("factory3dViewer.empWorkCenter")}：</span>
                      {selectedEmployee.work_center_name}
                    </p>
                  )}
                  {selectedEmployee.phone && (
                    <p>
                      <span className="f3d-dim">{t("factory3dViewer.empPhone")}：</span>
                      {selectedEmployee.phone}
                    </p>
                  )}
                </div>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noEmpInfo")}</p>
              )}

              {/* 当前排班 */}
              <div className="f3d-section-title">{t("factory3dViewer.currentShift")}</div>
              {selectedEmployeeShift ? (
                <div className="f3d-emp-info">
                  <p>
                    <span className="f3d-dim">{t("factory3dViewer.shiftName")}：</span>
                    <b>{selectedEmployeeShift.shift_name}</b>
                  </p>
                  <p>
                    <span className="f3d-dim">{t("factory3dViewer.shiftTime")}：</span>
                    {selectedEmployeeShift.start_time} - {selectedEmployeeShift.end_time}
                    {selectedEmployeeShift.cross_midnight
                      ? ` ${t("factory3dViewer.shiftCrossMidnight")}`
                      : ""}
                  </p>
                </div>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noShift")}</p>
              )}

              {/* 工作负荷（当月 confirmed 报工工时 ÷ 排班可用工时） */}
              <div className="f3d-section-title">{t("factory3dViewer.workload")}</div>
              {selectedEmployeeLoad ? (
                <div className="f3d-emp-info">
                  <p>
                    <span className="f3d-dim">{t("factory3dViewer.workloadRate")}：</span>
                    <b
                      style={{
                        color: num(selectedEmployeeLoad.load_rate) >= 100 ? "#ff4d4f" : undefined,
                      }}
                    >
                      {round(selectedEmployeeLoad.load_rate)}%
                    </b>
                    {num(selectedEmployeeLoad.load_rate) >= 100 && (
                      <span style={{ color: "#ff4d4f", marginLeft: 6 }}>
                        {t("factory3dViewer.workloadOverload")}
                      </span>
                    )}
                  </p>
                  <p>
                    <span className="f3d-dim">{t("factory3dViewer.workloadHours")}：</span>
                    {round(selectedEmployeeLoad.load_hours)}
                    {" / "}
                    {round(selectedEmployeeLoad.capacity_hours)} h
                    {selectedEmployeeLoad.work_day_count != null && (
                      <span className="f3d-dim">
                        {" "}
                        · {t("factory3dViewer.workloadDays", { d: num(selectedEmployeeLoad.work_day_count) })}
                      </span>
                    )}
                  </p>
                </div>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noWorkload")}</p>
              )}

              {/* 所在工单工序 */}
              <div className="f3d-section-title">
                {t("factory3dViewer.empAssignments")}（{selectedEmployeeOperations.length}）
              </div>
              {selectedEmployeeOperations.length > 0 ? (
                <ul className="f3d-orders">
                  {selectedEmployeeOperations.map((op) => (
                    <li
                      key={op.order_operation_id}
                      onClick={() => selectOrder(op.order_id)}
                      className="f3d-order-item"
                    >
                      <div className="f3d-order-line1">
                        <b>{op.order_no}</b>
                        <span className="f3d-dim">{op.operation_name ?? "—"}</span>
                      </div>
                      <div className="f3d-order-line2">
                        <span className="f3d-dim">
                          {t("factory3dViewer.opSeq", { seq: op.sequence_no })}
                        </span>
                        <span className="f3d-dim">
                          {dict.opStatus[op.operation_status]}
                        </span>
                        <span className="f3d-dim">
                          {round(op.completed_quantity)}/{round(op.planned_quantity)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noAssignments")}</p>
              )}

              {/* 派工：从未确认报工单里选一条，补填完工/报废数量，提交后确认 */}
              <div style={{ marginTop: 12 }}>
                <Button
                  type="primary"
                  block
                  onClick={openAssignReport}
                >
                  {t("factory3dViewer.assignReport")}
                </Button>
              </div>
            </>
          ) : selectedRow ? (
            <>
              <button className="f3d-back" onClick={() => selectDevice(null)}>
                {t("factory3dViewer.backToOrders")}
              </button>
              <h2>{selectedRow.device_name}</h2>
              <p className="f3d-dim">
                {selectedRow.device_code}
                {selectedRow.device_type ? ` · ${selectedRow.device_type}` : ""}
              </p>
              <p>
                <b style={{ color: STATUS_COLORS[selectedRow.scene_status] }}>
                  {dict.sceneStatus[selectedRow.scene_status]}
                </b>
                {selectedRow.capacity_per_day != null && (
                  <span className="f3d-dim">
                    {" "}
                    · {t("factory3dViewer.dailyCapacity", { n: round(selectedRow.capacity_per_day) })}
                  </span>
                )}
              </p>
              {selectedCapacityLoad && (
                <p>
                  <span className="f3d-dim">{t("factory3dViewer.capacityLoad")}：</span>
                  <b
                    style={{
                      color: num(selectedCapacityLoad.load_rate) >= 80 ? "#ff4d4f" : undefined,
                    }}
                  >
                    {round(selectedCapacityLoad.load_rate)}%
                  </b>
                  {num(selectedCapacityLoad.load_rate) >= 80 && (
                    <span style={{ color: "#ff4d4f", marginLeft: 6 }}>
                      {t("factory3dViewer.capacityOverload")}
                    </span>
                  )}
                </p>
              )}
              {selectedWorkCenterOrders.length > 0 ? (
                <>
                  <div className="f3d-section-title">
                    {t("factory3dViewer.currentJobs")}（{selectedWorkCenterOrders.length}）
                  </div>
                  <ul className="f3d-orders">
                    {selectedWorkCenterOrders.map((o) => (
                      <li
                        key={o.order_id}
                        onClick={() => selectOrder(o.order_id)}
                        className="f3d-order-item"
                      >
                        <div className="f3d-order-line1">
                          <b>{o.order_no}</b>
                          <span className="f3d-dim">{o.product_name ?? "—"}</span>
                        </div>
                        <div className="f3d-order-line2">
                          <span className="f3d-dim">
                            {t("factory3dViewer.wcOpInProgress", {
                              done: o.wc_op_in_progress,
                              total: o.wc_op_total,
                            })}
                          </span>
                          <span className="f3d-dim">
                            {round(o.operation_progress_percent)}%
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noActiveJob")}</p>
              )}
              {/* 指派 / 开工：运行中与待机都可操作（一个工作中心可同时挂多个订单） */}
              {selectedRow.scene_status !== "offline" && (
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <Button
                    type="primary"
                    block
                    onClick={() => void openAssign()}
                  >
                    {t("factory3dViewer.assign")}
                  </Button>
                  <Button
                    block
                    onClick={() => void openStart()}
                  >
                    {t("factory3dViewer.start")}
                  </Button>
                </div>
              )}
            </>
          ) : selectedOrder ? (
            <>
              <button className="f3d-back" onClick={() => selectOrder(null)}>
                {t("factory3dViewer.backToOrders")}
              </button>
              <h2>{selectedOrder.order_no}</h2>
              <p>
                {t("factory3dViewer.product")}：<b>{selectedOrder.product_name}</b> ×
                {round(selectedOrder.planned_quantity)} {selectedOrder.unit}
              </p>
              <p className="f3d-dim">
                {t("factory3dViewer.priority")} {selectedOrder.priority} · {t("factory3dViewer.done")}{" "}
                {round(selectedOrder.received_quantity)}
                {num(selectedOrder.delay_days) > 0 && (
                  <span className="f3d-danger">
                    {" "}
                    · {t("factory3dViewer.delayedDays", { d: num(selectedOrder.delay_days) })}
                  </span>
                )}
              </p>
              <ProgressBar
                pct={num(selectedOrder.progress_pct)}
                label={t("factory3dViewer.orderProgress")}
              />
              <ProgressBar
                pct={num(selectedOrder.operation_progress_percent)}
                label={t("factory3dViewer.opProgress")}
              />

              <div className="f3d-section-title">
                {t("factory3dViewer.materialKit")}{" "}
                <span
                  className="f3d-badge"
                  style={
                    selectedOrder.material_kit_status === "short"
                      ? { background: "var(--f3d-danger-soft)", color: "var(--f3d-danger)" }
                      : { background: "var(--f3d-ok-soft)", color: "var(--f3d-ok)" }
                  }
                >
                  {dict.kitStatus[selectedOrder.material_kit_status]}
                  {selectedOrder.material_kit_status === "short" &&
                    t("factory3dViewer.shortCount", { n: num(selectedOrder.material_line_short) })}
                </span>
              </div>
              {/* 材料清单：来自该工单对应 BOM 展开的材料行（现存量 / 需求量）。
                  齐料看实物库存（onhand），不看已领数（issued）：草稿领料单就会回写 issued，
                  但库存要过账才扣，用 issued 会假齐料。 */}
              {selectedOrderMaterials.length > 0 ? (
                <ul className="f3d-materials">
                  {selectedOrderMaterials.map((m) => {
                    const onhand = num(m.onhand_quantity);
                    const planned = num(m.planned_quantity);
                    const complete = planned > 0 && onhand >= planned;
                    return (
                      <li key={m.order_detail_id}>
                        <i
                          style={{
                            background: complete ? "var(--f3d-ok)" : "var(--f3d-danger)",
                          }}
                        />
                        <span className="f3d-mat-name">
                          {m.material_name ?? m.material_code ?? "—"}
                          {m.material_code && m.material_name ? (
                            <small className="f3d-dim"> {m.material_code}</small>
                          ) : null}
                        </span>
                        <span className="f3d-dim">
                          {onhand}/{planned} {m.unit}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noMaterials")}</p>
              )}

              <div className="f3d-section-title">{t("factory3dViewer.operations")}</div>
              <ol className="f3d-ops">
                {selectedOrderOps.map((op) => (
                  <li key={op.order_operation_id} className={op.operation_status}>
                    <span className="f3d-op-name">
                      {op.sequence_no}. {op.operation_name ?? "—"}
                    </span>
                    <span className="f3d-dim">
                      {dict.opStatus[op.operation_status]}
                      {op.work_center_name ? ` · ${op.work_center_name}` : ""}
                      {op.operation_status !== "pending" &&
                        ` · ${round(op.completed_quantity)}/${round(op.planned_quantity)}`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <h2>
                {t("factory3dViewer.activeOrders")}（{orders.length}）
              </h2>
              <ul className="f3d-orders">
                {orders.map((o) => (
                  <li
                    key={o.order_id}
                    onClick={() => selectOrder(o.order_id)}
                    className="f3d-order-item"
                  >
                    <div className="f3d-order-line1">
                      <b>{o.order_no}</b>
                      <span className="f3d-dim">{o.product_name}</span>
                    </div>
                    <ProgressBar pct={num(o.progress_pct)} small />
                    <div className="f3d-order-line2">
                      <span
                        className="f3d-badge"
                        style={
                          o.material_kit_status === "short"
                            ? { background: "var(--f3d-danger-soft)", color: "var(--f3d-danger)" }
                            : { background: "var(--f3d-ok-soft)", color: "var(--f3d-ok)" }
                        }
                      >
                        {dict.kitStatus[o.material_kit_status]}
                      </span>
                      {num(o.delay_days) > 0 && (
                        <span
                          className="f3d-badge"
                          style={{ background: "var(--f3d-danger-soft)", color: "var(--f3d-danger)" }}
                        >
                          {t("factory3dViewer.delayedDays", { d: num(o.delay_days) })}
                        </span>
                      )}
                      <span className="f3d-dim">
                        {round(o.received_quantity)}/{round(o.planned_quantity)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="f3d-dim f3d-tip">{t("factory3dViewer.tipList")}</p>
            </>
          )}
        </aside>
      </div>

      {/* 指派工作中心到未开工生产订单的弹窗 */}
      <Modal
        title={t("factory3dViewer.assignTitle")}
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={() => void submitAssign()}
        confirmLoading={assignLoading}
        okText={t("factory3dViewer.assignConfirm")}
        destroyOnClose
      >
        <p className="f3d-dim" style={{ marginBottom: 12 }}>
          {t("factory3dViewer.assignTo")}{" "}
          <b>
            {selectedRow?.device_code} · {selectedRow?.device_name}
          </b>
        </p>
        <div style={{ marginBottom: 12 }}>
          <div className="f3d-section-title">{t("factory3dViewer.assignSelectOrder")}</div>
          <Select
            style={{ width: "100%" }}
            placeholder={t("factory3dViewer.assignSelectOrder")}
            loading={assignOrdersLoading}
            value={selectedAssignOrderId}
            onChange={(v) => void loadAssignableOps(v as number)}
            options={assignableOrders.map((o) => ({
              value: o.order_id,
              label: `${o.order_no}${o.product_name ? ` · ${o.product_name}` : ""}${
                o.planned_quantity != null ? ` ×${round(o.planned_quantity)}` : ""
              }`,
            }))}
            notFoundContent={t("factory3dViewer.assignNoOrders")}
            showSearch
            optionFilterProp="label"
          />
        </div>
        <div>
          <div className="f3d-section-title">{t("factory3dViewer.assignSelectOps")}</div>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            placeholder={t("factory3dViewer.assignSelectOps")}
            loading={opsLoading}
            disabled={selectedAssignOrderId == null}
            value={selectedOpIds}
            onChange={(v) => setSelectedOpIds(v as number[])}
            options={assignableOps.map((op) => ({
              value: op.id,
              label: `${op.sequence_no}. ${op.operation_name ?? "—"}${
                op.work_center_id != null ? `（已指派）` : ""
              }`,
            }))}
          />
        </div>
      </Modal>

      {/* 开工已下达生产订单的弹窗 */}
      <Modal
        title={t("factory3dViewer.startTitle")}
        open={startOpen}
        onCancel={() => setStartOpen(false)}
        onOk={() => void submitStart()}
        confirmLoading={startLoading}
        okText={t("factory3dViewer.startConfirm")}
        okButtonProps={{ disabled: selectedStartOrderId == null }}
        destroyOnClose
      >
        <p className="f3d-dim" style={{ marginBottom: 12 }}>
          {t("factory3dViewer.startTo")}{" "}
          <b>
            {selectedRow?.device_code} · {selectedRow?.device_name}
          </b>
        </p>
        <div className="f3d-section-title">{t("factory3dViewer.startSelectOrder")}</div>
        <Select
          style={{ width: "100%" }}
          placeholder={t("factory3dViewer.startSelectOrder")}
          loading={startOrdersLoading}
          value={selectedStartOrderId}
          onChange={(v) => setSelectedStartOrderId(v as number)}
          options={startableOrders.map((o) => ({
            value: o.order_id,
            label: `${o.order_no}${o.product_name ? ` · ${o.product_name}` : ""}${
              o.planned_quantity != null ? ` ×${round(o.planned_quantity)}` : ""
            }`,
          }))}
          notFoundContent={t("factory3dViewer.startNoOrders")}
          showSearch
          optionFilterProp="label"
        />
      </Modal>

      {/* 人员派工弹窗：从未确认报工单选一条，填完工/报废数量提交，状态改为 confirmed */}
      <Modal
        title={t("factory3dViewer.assignReportTitle")}
        open={assignReportOpen}
        onCancel={() => setAssignReportOpen(false)}
        onOk={() => void submitAssignReport()}
        confirmLoading={assignReportLoading}
        okText={t("factory3dViewer.assignReportConfirm")}
        okButtonProps={{ disabled: selectedReportId == null }}
        destroyOnClose
      >
        <p className="f3d-dim" style={{ marginBottom: 12 }}>
          {t("factory3dViewer.assignReportTo")}{" "}
          <b>
            {selectedEmployee?.code} · {selectedEmployee?.name}
          </b>
        </p>
        <div className="f3d-section-title">{t("factory3dViewer.assignReportSelect")}</div>
        <Select
          style={{ width: "100%" }}
          placeholder={t("factory3dViewer.assignReportSelect")}
          value={selectedReportId}
          onChange={(v) => {
            setSelectedReportId(v as number);
            const r = selectedEmployeeDraftReports.find((x) => x.id === v);
            if (r) {
              setAssignCompletedQty(num(r.completed_quantity));
              setAssignScrappedQty(num(r.scrapped_quantity));
            }
          }}
          options={selectedEmployeeDraftReports.map((r) => {
            const op = operations.find((o) => o.order_operation_id === r.order_operation_id);
            const emp = employees.find((e) => e.id === r.operator_id);
            const empName = emp ? `${emp.name ?? ""}` : "";
            const label = `${r.report_no}${empName ? ` · ${empName}` : ""}${op ? ` · ${op.order_no} · ${op.operation_name ?? ""}` : ""}`;
            return { value: r.id, label };
          })}
          notFoundContent={t("factory3dViewer.assignReportNoReports")}
          showSearch
          optionFilterProp="label"
        />
        <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="f3d-dim" style={{ marginBottom: 4 }}>
              {t("factory3dViewer.assignReportCompleted")}
            </div>
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              precision={0}
              value={assignCompletedQty}
              onChange={(v) => setAssignCompletedQty(v as number | null)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="f3d-dim" style={{ marginBottom: 4 }}>
              {t("factory3dViewer.assignReportScrapped")}
            </div>
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              precision={0}
              value={assignScrappedQty}
              onChange={(v) => setAssignScrappedQty(v as number | null)}
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

function ProgressBar({
  pct,
  label,
  small,
}: {
  pct: number;
  label?: string;
  small?: boolean;
}) {
  return (
    <div className={small ? "f3d-pb small" : "f3d-pb"}>
      {label && <div className="f3d-pb-label f3d-dim">{label}</div>}
      <div className="f3d-pb-rail">
        <div
          className="f3d-pb-fill"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <span className="f3d-pb-pct f3d-dim">{Math.round(pct)}%</span>
    </div>
  );
}
