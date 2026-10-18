import { useEffect, useMemo, useState } from "react";
import { Drawer } from "antd";
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
  unit: string | null;
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

export function Factory3DViewer({ open, onClose }: Factory3DViewerProps) {
  const { t, i18n } = useTranslation();
  const isDark = useErpDarkMode();
  const [loaded, setLoaded] = useState(false);
  const [materials, setMaterials] = useState<OrderMaterial[]>([]);
  const [layoutMode, setLayoutMode] = useState(false);
  const [bindingOptions, setBindingOptions] = useState<BindingOptions>({});

  const deviceRows = useFactoryStore((s) => s.deviceRows);
  const orders = useFactoryStore((s) => s.orders);
  const operations = useFactoryStore((s) => s.operations);
  const selectedDeviceCode = useFactoryStore((s) => s.selectedDeviceCode);
  const selectedOrderId = useFactoryStore((s) => s.selectedOrderId);
  const selectDevice = useFactoryStore((s) => s.selectDevice);
  const selectOrder = useFactoryStore((s) => s.selectOrder);

  const locale = normalizeLocale(i18n.language);
  const dict = LIB_DICT[locale];

  // ---------------------------------------------------------------- 数据加载
  useEffect(() => {
    if (!open) return;

    let dispose: (() => void) | undefined;

    const load = async () => {
      const { setDeviceRows, setOrders, setOperations, setSceneObjects } =
        useFactoryStore.getState();
      const [dev, ord, ops, mat, agvs, whs, emps, trks, objs] = await Promise.all([
        supabase.from("vw_factory_3d_devices").select("*"),
        supabase.from("vw_factory_3d_orders").select("*"),
        supabase.from("vw_factory_3d_order_operations").select("*"),
        supabase.from("vw_factory_3d_order_materials").select("*"),
        supabase.from("erp_agvs_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("erp_warehouses_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("erp_employees_s_539dcf81_b").select("id, code, name").eq("is_deleted", "n"),
        supabase.from("erp_vehicles_s_539dcf81_b").select("id, plate_no").eq("is_deleted", "n"),
        supabase.from("factory_3d_scene_object_s_539dcf81_b").select("*").eq("is_deleted", "n"),
      ]);
      if (dev.data) setDeviceRows(dev.data as DeviceRow[]);
      if (ord.data) setOrders(ord.data as OrderData[]);
      if (ops.data) setOperations(ops.data as OrderOperation[]);
      if (mat.data) setMaterials(mat.data as OrderMaterial[]);

      // 各类型可绑定业务对象清单
      setBindingOptions({
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
      setLayoutMode(false);
    }
  }, [open, selectDevice, selectOrder]);

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

  // ---------------------------------------------------------------- 派生数据
  const selectedRow =
    deviceRows.find((r) => r.device_code === selectedDeviceCode) ?? null;
  const selectedOrder: OrderData | null =
    orders.find((o) => o.order_id === selectedOrderId) ?? null;
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
    <Drawer
      title={t("factory3dViewer.title")}
      open={open}
      onClose={onClose}
      width="100%"
      styles={{ body: { padding: 0, height: "100%" } }}
      destroyOnClose
    >
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

        {/* 右侧面板：订单列表 / 订单详情 / 设备详情 */}
        <aside className="f3d-hud f3d-hud-right">
          {selectedRow ? (
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
              {selectedRow.current_order_no ? (
                <>
                  <div className="f3d-section-title">{t("factory3dViewer.currentJob")}</div>
                  <p>
                    <b>{selectedRow.current_order_no}</b> · {selectedRow.current_product_name}
                  </p>
                  <p className="f3d-dim">
                    {t("factory3dViewer.currentOp")}：{selectedRow.current_operation_name}
                    （{round(selectedRow.current_op_completed)}/
                    {round(selectedRow.current_op_planned)}）
                  </p>
                  {selectedOrder && (
                    <ProgressBar
                      pct={num(selectedOrder.progress_pct)}
                      label={t("factory3dViewer.orderProgress")}
                    />
                  )}
                </>
              ) : (
                <p className="f3d-dim f3d-tip">{t("factory3dViewer.noActiveJob")}</p>
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
              {/* 材料清单：来自该工单对应 BOM 展开的材料行（领料数 / 需求数） */}
              {selectedOrderMaterials.length > 0 ? (
                <ul className="f3d-materials">
                  {selectedOrderMaterials.map((m) => {
                    const issued = num(m.issued_quantity);
                    const planned = num(m.planned_quantity);
                    const complete = planned > 0 && issued >= planned;
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
                          {issued}/{planned} {m.unit}
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
    </Drawer>
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
