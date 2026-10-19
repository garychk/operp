import { jsxs as c, jsx as t } from "react/jsx-runtime";
import { useState as Z, useRef as I, useEffect as w } from "react";
import { useThree as L, useFrame as Q, Canvas as ee } from "@react-three/fiber";
import { Grid as ne, Html as J, OrbitControls as te } from "@react-three/drei";
import { create as re } from "zustand";
import * as A from "three";
const oe = [
  {
    device_id: 1,
    device_code: "WC-CNC01",
    device_name: "CNC 加工中心 01",
    device_type: "cnc",
    capacity_per_day: 80,
    wc_status: "active",
    scene_status: "running",
    current_order_id: 101,
    current_order_no: "MO-2026-018",
    current_product_name: "减速机箱体",
    current_operation_name: "精铣结合面",
    current_op_line_no: 3,
    current_op_completed: 96,
    current_op_planned: 200,
    scene_x: -7,
    scene_z: -3
  },
  {
    device_id: 2,
    device_code: "WC-CNC02",
    device_name: "CNC 加工中心 02",
    device_type: "cnc",
    capacity_per_day: 80,
    wc_status: "active",
    scene_status: "running",
    current_order_id: 102,
    current_order_no: "MO-2026-021",
    current_product_name: "齿轮轴",
    current_operation_name: "车削粗加工",
    current_op_line_no: 2,
    current_op_completed: 300,
    current_op_planned: 500,
    scene_x: -2.5,
    scene_z: -3
  },
  {
    device_id: 3,
    device_code: "WC-PRESS",
    device_name: "冲压机 01",
    device_type: "press",
    capacity_per_day: 200,
    wc_status: "active",
    scene_status: "running",
    current_order_id: 101,
    current_order_no: "MO-2026-018",
    current_product_name: "减速机箱体",
    current_operation_name: "箱体冲压成型",
    current_op_line_no: 2,
    current_op_completed: 180,
    current_op_planned: 200,
    scene_x: 2.5,
    scene_z: -3
  },
  {
    device_id: 4,
    device_code: "WC-WELD",
    device_name: "焊接工作站",
    device_type: "weld",
    capacity_per_day: 60,
    wc_status: "active",
    scene_status: "idle",
    current_order_id: null,
    current_order_no: null,
    current_product_name: null,
    current_operation_name: null,
    current_op_line_no: null,
    current_op_completed: null,
    current_op_planned: null,
    scene_x: 7,
    scene_z: -3
  },
  {
    device_id: 5,
    device_code: "WC-ASSY",
    device_name: "总装工位",
    device_type: "assembly",
    capacity_per_day: 120,
    wc_status: "active",
    scene_status: "running",
    current_order_id: 103,
    current_order_no: "MO-2026-015",
    current_product_name: "减速机总成",
    current_operation_name: "总装",
    current_op_line_no: 5,
    current_op_completed: 42,
    current_op_planned: 150,
    scene_x: -5.5,
    scene_z: 3
  },
  {
    device_id: 6,
    device_code: "WC-TEST",
    device_name: "测试台 01",
    device_type: "test",
    capacity_per_day: 100,
    wc_status: "active",
    scene_status: "idle",
    current_order_id: null,
    current_order_no: null,
    current_product_name: null,
    current_operation_name: null,
    current_op_line_no: null,
    current_op_completed: null,
    current_op_planned: null,
    scene_x: -0.5,
    scene_z: 3
  },
  {
    device_id: 7,
    device_code: "WC-PAINT",
    device_name: "喷涂线（检修中）",
    device_type: "paint",
    capacity_per_day: 90,
    wc_status: "inactive",
    scene_status: "offline",
    current_order_id: null,
    current_order_no: null,
    current_product_name: null,
    current_operation_name: null,
    current_op_line_no: null,
    current_op_completed: null,
    current_op_planned: null,
    scene_x: 4.5,
    scene_z: 3
  }
], ie = [
  {
    order_id: 101,
    order_no: "MO-2026-018",
    status: "in_progress",
    priority: 8,
    product_id: 11,
    product_code: "P-JSX",
    product_name: "减速机箱体",
    unit: "台",
    planned_quantity: 200,
    received_quantity: 124,
    remaining_quantity: 76,
    progress_pct: 62,
    delay_days: 0,
    operation_progress_percent: 58.5,
    material_line_total: 6,
    material_line_ready: 5,
    material_line_short: 1,
    material_kit_status: "short"
  },
  {
    order_id: 102,
    order_no: "MO-2026-021",
    status: "in_progress",
    priority: 5,
    product_id: 12,
    product_code: "P-CLZ",
    product_name: "齿轮轴",
    unit: "件",
    planned_quantity: 500,
    received_quantity: 300,
    remaining_quantity: 200,
    progress_pct: 60,
    delay_days: 0,
    operation_progress_percent: 55,
    material_line_total: 3,
    material_line_ready: 3,
    material_line_short: 0,
    material_kit_status: "ready"
  },
  {
    order_id: 103,
    order_no: "MO-2026-015",
    status: "in_progress",
    priority: 3,
    product_id: 13,
    product_code: "P-ZC",
    product_name: "减速机总成",
    unit: "台",
    planned_quantity: 150,
    received_quantity: 42,
    remaining_quantity: 108,
    progress_pct: 28,
    delay_days: 2,
    operation_progress_percent: 31.2,
    material_line_total: 9,
    material_line_ready: 6,
    material_line_short: 3,
    material_kit_status: "short"
  }
], ae = [
  { order_operation_id: 1, order_id: 101, order_no: "MO-2026-018", line_no: 1, sequence_no: 10, operation_name: "铸造毛坯检验", work_center_id: null, work_center_name: null, assignee_name: "王强", planned_quantity: 200, completed_quantity: 200, scrapped_quantity: 2, operation_status: "completed" },
  { order_operation_id: 2, order_id: 101, order_no: "MO-2026-018", line_no: 2, sequence_no: 20, operation_name: "箱体冲压成型", work_center_id: 3, work_center_name: "冲压机 01", assignee_name: "李明", planned_quantity: 200, completed_quantity: 180, scrapped_quantity: 0, operation_status: "in_progress" },
  { order_operation_id: 3, order_id: 101, order_no: "MO-2026-018", line_no: 3, sequence_no: 30, operation_name: "精铣结合面", work_center_id: 1, work_center_name: "CNC 加工中心 01", assignee_name: "张伟", planned_quantity: 200, completed_quantity: 96, scrapped_quantity: 1, operation_status: "in_progress" },
  { order_operation_id: 4, order_id: 101, order_no: "MO-2026-018", line_no: 4, sequence_no: 40, operation_name: "镗轴承孔", work_center_id: 4, work_center_name: null, assignee_name: null, planned_quantity: 200, completed_quantity: 0, scrapped_quantity: 0, operation_status: "pending" },
  { order_operation_id: 5, order_id: 102, order_no: "MO-2026-021", line_no: 1, sequence_no: 10, operation_name: "下料", work_center_id: null, work_center_name: null, assignee_name: "赵刚", planned_quantity: 500, completed_quantity: 500, scrapped_quantity: 0, operation_status: "completed" },
  { order_operation_id: 6, order_id: 102, order_no: "MO-2026-021", line_no: 2, sequence_no: 20, operation_name: "车削粗加工", work_center_id: 2, work_center_name: "CNC 加工中心 02", assignee_name: "陈浩", planned_quantity: 500, completed_quantity: 300, scrapped_quantity: 4, operation_status: "in_progress" },
  { order_operation_id: 7, order_id: 103, order_no: "MO-2026-015", line_no: 5, sequence_no: 50, operation_name: "总装", work_center_id: 5, work_center_name: "总装工位", assignee_name: "刘洋", planned_quantity: 150, completed_quantity: 42, scrapped_quantity: 0, operation_status: "in_progress" }
], ke = {
  101: [
    { name: "铸件毛坯 JSX-100", required: 200, issued: 200, unit: "件" },
    { name: "轴承 6205-2RS", required: 800, issued: 800, unit: "套" },
    { name: "密封件 JSX-MF", required: 400, issued: 300, unit: "件" },
    { name: "端盖 JSX-DG", required: 400, issued: 400, unit: "件" },
    { name: "油标 JSX-YB", required: 200, issued: 200, unit: "件" },
    { name: "通气器 JSX-TQ", required: 200, issued: 200, unit: "件" }
  ],
  102: [
    { name: "40Cr 圆钢 Φ60", required: 2600, issued: 2600, unit: "kg" },
    { name: "切削液", required: 50, issued: 50, unit: "L" },
    { name: "焊接材料", required: 100, issued: 100, unit: "kg" }
  ],
  103: [
    { name: "减速机箱体", required: 150, issued: 124, unit: "台" },
    { name: "齿轮轴", required: 300, issued: 300, unit: "件" },
    { name: "轴承 30211", required: 600, issued: 480, unit: "套" },
    { name: "油封 TC-45", required: 300, issued: 250, unit: "件" },
    { name: "螺栓 M12×45", required: 1800, issued: 1800, unit: "套" },
    { name: "齿轮油 L-CKC220", required: 150, issued: 120, unit: "L" },
    { name: "平键 12×8×50", required: 300, issued: 300, unit: "件" },
    { name: "透气帽", required: 150, issued: 150, unit: "件" },
    { name: "铭牌", required: 150, issued: 150, unit: "张" }
  ]
};
function $(n) {
  return Math.max(n.length, 1), n.map((r, e) => {
    const o = {
      x: (e % 4 - 1.5) * 4.5,
      z: Math.floor(e / 4) * 5 - 1
    };
    return {
      id: r.device_code,
      name: r.device_name,
      deviceId: r.device_id,
      position: [
        r.scene_x ?? o.x,
        0,
        r.scene_z ?? o.z
      ],
      status: r.scene_status === "running" ? "running" : r.scene_status === "offline" ? "fault" : "idle",
      currentOrderNo: r.current_order_no ?? void 0,
      currentProduct: r.current_product_name ?? void 0,
      output: r.current_op_planned && r.current_op_planned > 0 ? Math.round((r.current_op_completed ?? 0) / r.current_op_planned * 100) : void 0
    };
  });
}
const j = 21, q = 13, K = 0.5, V = (n) => Math.round(n / K) * K, H = (n, r, e) => Math.min(e, Math.max(r, n));
function U({
  position: n,
  editable: r,
  onDrop: e
}) {
  const o = L((m) => m.controls), i = L((m) => m.camera), a = L((m) => m.gl), [s, d] = Z(n), b = I(s);
  b.current = s;
  const y = I(null), g = I(null), S = I(!1), O = I(new A.Raycaster()), C = I(new A.Vector2());
  w(() => {
    y.current?.active || (d(n), b.current = n);
  }, [n]);
  const h = () => {
    g.current?.(), g.current = null;
  };
  w(() => {
    !r && y.current?.active && (y.current = null, h(), o && (o.enabled = !0), document.body.style.cursor = "auto");
  }, [r, o]), w(() => h, []);
  const _ = (m, f) => {
    const v = a.domElement.getBoundingClientRect();
    C.current.set(
      (m.clientX - v.left) / v.width * 2 - 1,
      -((m.clientY - v.top) / v.height) * 2 + 1
    ), O.current.setFromCamera(C.current, i);
    const M = new A.Vector3();
    return O.current.ray.intersectPlane(f, M) ? M : null;
  }, x = () => {
    const m = y.current;
    if (!m?.active || (y.current = null, h(), o && (o.enabled = !0), document.body.style.cursor = r ? "grab" : "auto", !m.moved)) return;
    S.current = !0;
    const [f, , v] = b.current;
    e(f, v);
  };
  return {
    pos: s,
    handlers: { onPointerDown: (m) => {
      if (!r || m.button !== 0) return;
      m.stopPropagation();
      const f = new A.Plane(new A.Vector3(0, 1, 0), 0), v = new A.Vector3();
      if (!m.ray.intersectPlane(f, v)) return;
      o && (o.enabled = !1);
      const M = {
        active: !0,
        moved: !1,
        offset: new A.Vector3(v.x - n[0], 0, v.z - n[2]),
        plane: f,
        origin: n
      };
      y.current = M, document.body.style.cursor = "grabbing";
      const B = (F) => {
        const E = y.current;
        if (!E?.active) return;
        const p = _(F, E.plane);
        if (!p) return;
        const z = H(V(p.x - E.offset.x), -j, j), N = H(V(p.z - E.offset.z), -q, q);
        (Math.abs(z - E.origin[0]) > 0.01 || Math.abs(N - E.origin[2]) > 0.01) && (E.moved = !0);
        const W = [z, E.origin[1], N];
        b.current = W, d(W);
      }, D = () => x();
      window.addEventListener("pointermove", B), window.addEventListener("pointerup", D), window.addEventListener("pointercancel", D), g.current = () => {
        window.removeEventListener("pointermove", B), window.removeEventListener("pointerup", D), window.removeEventListener("pointercancel", D);
      };
    } },
    shouldSkipClick: () => S.current ? (S.current = !1, !0) : !1,
    isDragging: () => !!y.current?.active
  };
}
function ce(n, r = 3) {
  const e = (o, i) => n.some((a) => Math.abs(a[0] - o) < r * 0.9 && Math.abs(a[2] - i) < r * 0.9);
  for (let o = -q + 3; o <= q - 3; o += r)
    for (let i = -j + 3; i <= j - 3; i += r)
      if (!e(i, o)) return [i, 0, o];
  return [0, 0, 0];
}
const X = oe, u = re((n, r) => ({
  devices: $(X),
  deviceRows: X,
  orders: ie,
  operations: ae,
  selectedDeviceCode: null,
  selectedOrderId: null,
  theme: "light",
  locale: "zh",
  layoutEditable: !1,
  pendingLayout: {},
  sceneObjects: [],
  selectedSceneObjectId: null,
  onDeviceSelect: null,
  onOrderSelect: null,
  onLayoutChange: null,
  onSceneObjectsChange: null,
  onSceneObjectChange: null,
  setDeviceRows: (e) => n((o) => ({
    deviceRows: e,
    devices: o.devices.some((i) => i.deviceId != null) ? se(o.devices, e) : $(e)
  })),
  setDevices: (e) => n({ devices: e }),
  updateDeviceStatus: (e, o) => n((i) => ({
    devices: i.devices.map((a) => a.id === e ? { ...a, status: o } : a)
  })),
  setOrders: (e) => n({ orders: e }),
  setOperations: (e) => n({ operations: e }),
  selectDevice: (e) => {
    r().onDeviceSelect?.(e), n((o) => {
      const i = o.deviceRows.find((a) => a.device_code === e);
      return {
        selectedDeviceCode: e,
        selectedOrderId: e ? i?.current_order_id ?? o.selectedOrderId : null,
        selectedSceneObjectId: e ? null : o.selectedSceneObjectId
      };
    });
  },
  selectOrder: (e) => {
    r().onOrderSelect?.(e), n({ selectedOrderId: e });
  },
  setOnDeviceSelect: (e) => n({ onDeviceSelect: e }),
  setOnOrderSelect: (e) => n({ onOrderSelect: e }),
  setTheme: (e) => n({ theme: e }),
  toggleTheme: () => n((e) => ({ theme: e.theme === "light" ? "dark" : "light" })),
  setLocale: (e) => n({ locale: e }),
  setLayoutEditable: (e) => n(e ? { layoutEditable: e } : { layoutEditable: e, pendingLayout: {} }),
  moveDevice: (e, o, i) => n((a) => ({
    devices: a.devices.map(
      (s) => s.id === e ? { ...s, position: [o, s.position[1], i] } : s
    ),
    pendingLayout: { ...a.pendingLayout, [e]: { sceneX: o, sceneZ: i } }
  })),
  clearPendingLayout: () => n({ pendingLayout: {} }),
  setOnLayoutChange: (e) => n({ onLayoutChange: e }),
  setSceneObjects: (e) => n({ sceneObjects: e }),
  addSceneObject: (e, o) => {
    const i = r(), a = i.sceneObjects.filter((g) => g.kind === e).length, s = [
      ...i.devices.map((g) => g.position),
      ...i.sceneObjects.map((g) => g.position)
    ], d = {
      work_center: "工作中心",
      agv: "AGV",
      warehouse: "仓库",
      person: "人员",
      truck: "货车"
    }, b = {
      id: `obj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: e,
      name: o ?? `${d[e]}-${String(a + 1).padStart(2, "0")}`,
      position: ce(s),
      status: e === "agv" || e === "truck" ? "idle" : void 0
    }, y = [...i.sceneObjects, b];
    return n({ sceneObjects: y, selectedSceneObjectId: b.id, selectedDeviceCode: null }), P(r(), y, "add", b), b;
  },
  moveSceneObject: (e, o, i) => {
    const a = r().sceneObjects.map(
      (d) => d.id === e ? { ...d, position: [o, d.position[1], i] } : d
    );
    n({ sceneObjects: a });
    const s = a.find((d) => d.id === e);
    s && P(r(), a, "move", s);
  },
  renameSceneObject: (e, o) => {
    const i = r().sceneObjects.map((s) => s.id === e ? { ...s, name: o } : s);
    n({ sceneObjects: i });
    const a = i.find((s) => s.id === e);
    a && P(r(), i, "rename", a);
  },
  bindSceneObject: (e, o, i) => {
    const a = r().sceneObjects.map(
      (d) => d.id === e ? { ...d, bindId: o, bindLabel: o == null ? void 0 : i } : d
    );
    n({ sceneObjects: a });
    const s = a.find((d) => d.id === e);
    s && P(r(), a, "bind", s);
  },
  removeSceneObject: (e) => {
    const o = r(), i = o.sceneObjects.find((s) => s.id === e), a = o.sceneObjects.filter((s) => s.id !== e);
    n({
      sceneObjects: a,
      selectedSceneObjectId: o.selectedSceneObjectId === e ? null : o.selectedSceneObjectId
    }), i && P(r(), a, "remove", i);
  },
  selectSceneObject: (e) => n({ selectedSceneObjectId: e, selectedDeviceCode: null }),
  setOnSceneObjectsChange: (e) => n({ onSceneObjectsChange: e }),
  setOnSceneObjectChange: (e) => n({ onSceneObjectChange: e })
}));
function P(n, r, e, o) {
  n.onSceneObjectsChange?.(r), n.onSceneObjectChange?.({ action: e, object: o });
}
function se(n, r) {
  return r.map((e, o) => {
    const i = n.find((s) => s.id === e.device_code), a = { x: (o % 4 - 1.5) * 4.5, z: Math.floor(o / 4) * 5 - 1 };
    return {
      id: e.device_code,
      name: e.device_name,
      deviceId: e.device_id,
      position: i?.position ?? [e.scene_x ?? a.x, 0, e.scene_z ?? a.z],
      status: e.scene_status === "running" ? "running" : e.scene_status === "offline" ? "fault" : "idle",
      currentOrderNo: e.current_order_no ?? void 0,
      currentProduct: e.current_product_name ?? void 0,
      output: e.current_op_planned && e.current_op_planned > 0 ? Math.round((e.current_op_completed ?? 0) / e.current_op_planned * 100) : void 0
    };
  });
}
const G = {
  light: {
    background: "#E8EEF3",
    fog: [45, 95],
    floor: "#CFD6DD",
    gridCell: "#B4B2A9",
    gridSection: "#888780",
    road: "#8A8F94",
    wall: "#E6EBF0",
    wallBand: "#85B7EB",
    steel: "#7C8894",
    base: "#5F5E5A",
    baseFault: "#4A4A48",
    body: "#B4B2A9",
    bodyFault: "#8F8F8A",
    bodySelected: "#85B7EB",
    selectRing: "#185FA5",
    labelBg: { running: "#EAF3DE", idle: "#FAEEDA", offline: "#F1EFE8" },
    labelText: { running: "#27500A", idle: "#633806", offline: "#444441" },
    labelBorder: { running: "#3B6D11", idle: "#BA7517", offline: "#888780" },
    orderBadgeBg: "#E6F1FB",
    orderBadgeText: "#0C447C"
  },
  dark: {
    background: "#15181D",
    fog: [38, 82],
    floor: "#22262D",
    gridCell: "#3A404B",
    gridSection: "#4A5160",
    road: "#2E333C",
    wall: "#2A2F38",
    wallBand: "#2E5E8F",
    steel: "#4A5160",
    base: "#3A404B",
    baseFault: "#2C2F36",
    body: "#565E6B",
    bodyFault: "#3A3E46",
    bodySelected: "#378ADD",
    selectRing: "#85B7EB",
    labelBg: { running: "#1F3320", idle: "#3A2E14", offline: "#26282D" },
    labelText: { running: "#C0DD97", idle: "#FAC775", offline: "#B4B2A9" },
    labelBorder: { running: "#3B6D11", idle: "#BA7517", offline: "#5F5E5A" },
    orderBadgeBg: "#14293F",
    orderBadgeText: "#85B7EB"
  }
};
function de(n) {
  return n && n.toLowerCase().startsWith("en") ? "en" : "zh";
}
const T = {
  zh: {
    status: { running: "运行中", idle: "待机", fault: "故障" },
    sceneStatus: { running: "运行中", idle: "待机", offline: "离线" },
    opStatus: { pending: "未开始", in_progress: "加工中", completed: "已完成", cancelled: "已取消" },
    kitStatus: { ready: "齐料", short: "缺料", none: "无物料需求" },
    objectKind: {
      work_center: "工作中心",
      agv: "AGV 小车",
      warehouse: "仓储房屋",
      person: "人员",
      truck: "货车"
    },
    palette: {
      title: "添加对象",
      hint: "点击添加 · 拖动摆放",
      binding: "绑定数据",
      unbound: "未绑定",
      remove: "删除",
      name: "名称"
    }
  },
  en: {
    status: { running: "Running", idle: "Idle", fault: "Fault" },
    sceneStatus: { running: "Running", idle: "Idle", offline: "Offline" },
    opStatus: { pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" },
    kitStatus: { ready: "Kitted", short: "Short", none: "No materials" },
    objectKind: {
      work_center: "Work center",
      agv: "AGV",
      warehouse: "Warehouse",
      person: "Person",
      truck: "Truck"
    },
    palette: {
      title: "Add object",
      hint: "Click to add · drag to place",
      binding: "Bind data",
      unbound: "Unbound",
      remove: "Remove",
      name: "Name"
    }
  }
};
function le() {
  const n = u((e) => e.theme), r = G[n];
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { rotation: [-Math.PI / 2, 0, 0], receiveShadow: !0, children: [
      /* @__PURE__ */ t("planeGeometry", { args: [48, 32] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.floor })
    ] }),
    /* @__PURE__ */ t(
      ne,
      {
        position: [0, 0.01, 0],
        args: [48, 32],
        cellSize: 1,
        cellThickness: 0.6,
        cellColor: r.gridCell,
        sectionSize: 5,
        sectionThickness: 1,
        sectionColor: r.gridSection,
        fadeDistance: 70,
        fadeStrength: 1
      }
    ),
    /* @__PURE__ */ c("mesh", { rotation: [-Math.PI / 2, 0, 0], position: [0, 0.02, 7], children: [
      /* @__PURE__ */ t("planeGeometry", { args: [48, 2.4] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.road })
    ] })
  ] });
}
function ue() {
  const n = u((a) => a.theme), r = G[n], e = 22, o = 12, i = 5;
  return /* @__PURE__ */ c("group", { position: [0, 0, -2], children: [
    /* @__PURE__ */ c("mesh", { position: [0, i / 2, -o / 2], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [e, i, 0.3] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.wall })
    ] }),
    [-e / 2, e / 2].map((a) => /* @__PURE__ */ c("mesh", { position: [a, i / 2, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.3, i, o] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.wall })
    ] }, a)),
    [
      [-e / 2, -o / 2],
      [e / 2, -o / 2],
      [-e / 2, o / 2],
      [e / 2, o / 2]
    ].map(([a, s]) => /* @__PURE__ */ c("mesh", { position: [a, i / 2, s], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.5, i, 0.5] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.steel })
    ] }, `${a},${s}`)),
    [-o / 2, 0, o / 2].map((a) => /* @__PURE__ */ c("mesh", { position: [0, i + 0.2, a], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [e + 0.5, 0.35, 0.35] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.steel })
    ] }, a)),
    /* @__PURE__ */ c("mesh", { position: [0, i * 0.72, -o / 2 + 0.17], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [e - 2, 0.9, 0.05] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.wallBand })
    ] })
  ] });
}
const R = {
  work_center: { body: "#B4B2A9", accent: "#185FA5" },
  agv: { body: "#F2C14E", accent: "#1D9A6C" },
  warehouse: { body: "#9AA6B2", accent: "#185FA5" },
  person: { body: "#E8ECF1", accent: "#3B6D11" },
  truck: { body: "#E9EDF2", accent: "#1F6FB2" }
};
function Y({
  p: n,
  selected: r,
  status: e
}) {
  const o = r ? n.bodySelected : "#8A93A0", i = r ? n.bodySelected : "#6F7885", a = (s, d) => /* @__PURE__ */ t(
    "meshStandardMaterial",
    {
      color: s ? d : "#3A3E46",
      emissive: s ? d : "#000000",
      emissiveIntensity: s ? 1.6 : 0
    }
  );
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { position: [0.05, 0.16, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [2.3, 0.32, 1.7] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r ? n.bodySelected : i })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0.55, 0.42, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.05, 0.16, 1] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: i })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0.55, 0.64, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.42, 0.3, 0.42] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#C8A24B", metalness: 0.4, roughness: 0.5 })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 1, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.55, 1.7, 1.5] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: o,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.25 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.32, 1.62, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1, 0.52, 0.68] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: o,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.25 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0.08, 1.28, 0], rotation: [Math.PI, 0, 0], children: [
      /* @__PURE__ */ t("coneGeometry", { args: [0.09, 0.3, 12] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#4A5160", metalness: 0.5, roughness: 0.4 })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [1.1, 0.82, -0.28], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.42, 1, 0.85] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: i })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [1.1, 1.12, 0.18], rotation: [-0.35, 0, 0], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.3, 0.2, 0.03] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#1B2733", emissive: "#2E5E8F", emissiveIntensity: 0.35 })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 1.93, 0.5], children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.03, 0.03, 0.16, 8] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#3A3E46" })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 2.09, 0.5], children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.095, 0.095, 0.15, 12] }),
      a(e === "running", "#3B6D11")
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 2.24, 0.5], children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.095, 0.095, 0.15, 12] }),
      a(e === "idle", "#BA7517")
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 2.39, 0.5], children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.095, 0.095, 0.15, 12] }),
      a(e === "fault", "#A32D2D")
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-0.78, 2.49, 0.5], children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.06, 0.095, 0.06, 12] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#3A3E46" })
    ] })
  ] });
}
function pe({ p: n, selected: r, running: e }) {
  const o = I([]);
  Q((s, d) => {
    if (e)
      for (const b of o.current) b && (b.rotation.y -= d * 3);
  });
  const i = R.agv, a = [
    [-0.55, 0.5],
    [-0.55, -0.5],
    [0.55, 0.5],
    [0.55, -0.5]
  ];
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { position: [0, 0.42, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.6, 0.36, 1.05] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: r ? n.bodySelected : i.body,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.2 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 0.68, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.1, 0.18, 0.8] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: n.base })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 0.82, 0.28], children: [
      /* @__PURE__ */ t("sphereGeometry", { args: [0.09, 12, 12] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: e ? i.accent : n.steel,
          emissive: e ? i.accent : "#000000",
          emissiveIntensity: e ? 1.6 : 0
        }
      )
    ] }),
    a.map(([s, d], b) => /* @__PURE__ */ c(
      "mesh",
      {
        ref: (y) => {
          y && (o.current[b] = y);
        },
        position: [s, 0.18, d],
        rotation: [Math.PI / 2, 0, 0],
        castShadow: !0,
        children: [
          /* @__PURE__ */ t("cylinderGeometry", { args: [0.18, 0.18, 0.14, 16] }),
          /* @__PURE__ */ t("meshStandardMaterial", { color: "#26282D" }),
          /* @__PURE__ */ c("mesh", { children: [
            /* @__PURE__ */ t("boxGeometry", { args: [0.37, 0.17, 0.03] }),
            /* @__PURE__ */ t("meshStandardMaterial", { color: "#B8C0CA" })
          ] }),
          /* @__PURE__ */ c("mesh", { rotation: [0, Math.PI / 2, 0], children: [
            /* @__PURE__ */ t("boxGeometry", { args: [0.37, 0.17, 0.03] }),
            /* @__PURE__ */ t("meshStandardMaterial", { color: "#B8C0CA" })
          ] })
        ]
      },
      `${s}-${d}`
    )),
    /* @__PURE__ */ c("mesh", { position: [0.86, 0.42, 0], rotation: [0, 0, -Math.PI / 2], children: [
      /* @__PURE__ */ t("coneGeometry", { args: [0.13, 0.22, 12] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: i.accent })
    ] })
  ] });
}
function _e({ p: n, selected: r }) {
  const e = R.warehouse;
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { position: [0, 1.3, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [4.4, 2.6, 3.4] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: r ? n.bodySelected : e.body,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.16 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 2.75, 0], rotation: [0, Math.PI / 4, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("coneGeometry", { args: [3.3, 0.7, 4] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: n.steel })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 0.85, 1.72], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.5, 1.7, 0.06] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: e.accent })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 2, 1.72], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [3.2, 0.22, 0.05] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: e.accent, emissive: e.accent, emissiveIntensity: 0.25 })
    ] })
  ] });
}
function me({ p: n, selected: r }) {
  const e = R.person;
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { position: [0, 1.5, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("sphereGeometry", { args: [0.17, 16, 16] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: e.body })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0, 1.02, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("capsuleGeometry", { args: [0.2, 0.5, 6, 12] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: r ? n.bodySelected : e.accent,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.3 : 0
        }
      )
    ] }),
    [-0.11, 0.11].map((o) => /* @__PURE__ */ c("mesh", { position: [o, 0.36, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("capsuleGeometry", { args: [0.07, 0.4, 4, 8] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: n.base })
    ] }, o)),
    /* @__PURE__ */ c("mesh", { position: [0, 0.02, 0], rotation: [-Math.PI / 2, 0, 0], children: [
      /* @__PURE__ */ t("ringGeometry", { args: [0.42, 0.5, 32] }),
      /* @__PURE__ */ t("meshBasicMaterial", { color: e.accent, transparent: !0, opacity: 0.5 })
    ] })
  ] });
}
function he({
  p: n,
  selected: r,
  running: e
}) {
  const o = R.truck, i = 0.62;
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { position: [0, 0.42, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [3.5, 0.18, 1.3] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: n.base })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-1.25, 0.98, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.05, 0.95, 1.35] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: r ? n.bodySelected : o.body,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.2 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [-1.78, 1.08, 0], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.06, 0.5, 1.1] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: n.steel })
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0.72, 1.12, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ t("boxGeometry", { args: [2.15, 1.25, 1.4] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: r ? n.bodySelected : o.body,
          emissive: r ? n.selectRing : "#000000",
          emissiveIntensity: r ? 0.2 : 0
        }
      )
    ] }),
    /* @__PURE__ */ c("mesh", { position: [0.72, 1.3, 0.71], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [1.9, 0.22, 0.04] }),
      /* @__PURE__ */ t(
        "meshStandardMaterial",
        {
          color: o.accent,
          emissive: e ? o.accent : "#000000",
          emissiveIntensity: e ? 0.5 : 0
        }
      )
    ] }),
    [-0.45, 0.45].map((a) => /* @__PURE__ */ c("mesh", { position: [-1.79, 0.75, a], children: [
      /* @__PURE__ */ t("boxGeometry", { args: [0.05, 0.16, 0.22] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#FFF3C4", emissive: "#FFF3C4", emissiveIntensity: 0.8 })
    ] }, a)),
    [
      [-1.3, i],
      [-1.3, -i],
      [1.15, i],
      [1.15, -i],
      [1.72, i],
      [1.72, -i]
    ].map(([a, s]) => /* @__PURE__ */ c("mesh", { position: [a, 0.28, s], rotation: [Math.PI / 2, 0, 0], castShadow: !0, children: [
      /* @__PURE__ */ t("cylinderGeometry", { args: [0.28, 0.28, 0.2, 18] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: "#26282D" })
    ] }, `${a}-${s}`))
  ] });
}
function ge(n) {
  return n === "fault" ? "offline" : n;
}
function be({ device: n }) {
  const r = u((_) => _.theme), e = u((_) => _.locale), o = u((_) => _.layoutEditable), i = u((_) => _.selectedDeviceCode === n.id), a = u((_) => _.selectDevice), s = u((_) => _.moveDevice), d = G[r], b = T[e], y = n.status, g = ge(y), { pos: S, handlers: O, shouldSkipClick: C } = U({
    position: n.position,
    editable: o,
    onDrop: (_, x) => {
      s(n.id, _, x);
      const { pendingLayout: l, deviceRows: k, onLayoutChange: m } = u.getState(), f = Object.entries(l).map(([v, M]) => ({
        deviceCode: v,
        deviceId: k.find((B) => B.device_code === v)?.device_id,
        sceneX: M.sceneX,
        sceneZ: M.sceneZ
      }));
      m?.(f);
    }
  });
  return /* @__PURE__ */ c(
    "group",
    {
      position: S,
      onClick: (_) => {
        _.stopPropagation(), !C() && a(i ? null : n.id);
      },
      ...O,
      onPointerOver: (_) => {
        _.stopPropagation(), document.body.style.cursor = o ? "grab" : "pointer";
      },
      onPointerOut: () => {
        document.body.style.cursor = "auto";
      },
      children: [
        /* @__PURE__ */ t(Y, { p: d, selected: i, status: y }),
        i && /* @__PURE__ */ c("mesh", { position: [0, 0.03, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [1.15, 1.4, 40] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing })
        ] }),
        o && /* @__PURE__ */ c("mesh", { position: [0, 0.02, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [1.25, 1.32, 48] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing, transparent: !0, opacity: 0.45 })
        ] }),
        /* @__PURE__ */ t(J, { position: [0, 2.4, 0], center: !0, distanceFactor: 16, zIndexRange: [20, 0], children: /* @__PURE__ */ c(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              pointerEvents: "none",
              fontFamily: "system-ui, sans-serif"
            },
            children: [
              /* @__PURE__ */ c(
                "div",
                {
                  style: {
                    padding: "2px 10px",
                    borderRadius: 10,
                    background: d.labelBg[g],
                    border: `0.5px solid ${d.labelBorder[g]}`,
                    color: d.labelText[g],
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    boxShadow: r === "dark" ? "0 2px 8px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.12)"
                  },
                  children: [
                    n.name,
                    " · ",
                    b.status[y]
                  ]
                }
              ),
              n.currentOrderNo && /* @__PURE__ */ c(
                "div",
                {
                  style: {
                    padding: "1px 9px",
                    borderRadius: 10,
                    background: d.orderBadgeBg,
                    border: `0.5px solid ${d.selectRing}`,
                    color: d.orderBadgeText,
                    fontSize: 11,
                    whiteSpace: "nowrap"
                  },
                  children: [
                    n.currentOrderNo,
                    n.currentProduct ? ` · ${n.currentProduct}` : ""
                  ]
                }
              )
            ]
          }
        ) })
      ]
    }
  );
}
const ye = {
  work_center: 2.4,
  agv: 1.35,
  warehouse: 3.5,
  person: 2.05,
  truck: 2.15
};
function Se({ object: n }) {
  const r = u((h) => h.theme), e = u((h) => h.locale), o = u((h) => h.layoutEditable), i = u((h) => h.selectedSceneObjectId === n.id), a = u((h) => h.selectSceneObject), s = u((h) => h.moveSceneObject), d = G[r], b = T[e], y = R[n.kind].accent, { pos: g, handlers: S, shouldSkipClick: O } = U({
    position: n.position,
    editable: o,
    onDrop: (h, _) => s(n.id, h, _)
  });
  return /* @__PURE__ */ c(
    "group",
    {
      position: g,
      onClick: (h) => {
        h.stopPropagation(), !O() && a(i ? null : n.id);
      },
      ...S,
      onPointerOver: (h) => {
        h.stopPropagation(), document.body.style.cursor = o ? "grab" : "pointer";
      },
      onPointerOut: () => {
        document.body.style.cursor = "auto";
      },
      children: [
        n.kind === "work_center" && /* @__PURE__ */ t(Y, { p: d, selected: i, status: n.status }),
        n.kind === "agv" && /* @__PURE__ */ t(pe, { p: d, selected: i, running: n.status === "running" }),
        n.kind === "warehouse" && /* @__PURE__ */ t(_e, { p: d, selected: i }),
        n.kind === "person" && /* @__PURE__ */ t(me, { p: d, selected: i }),
        n.kind === "truck" && /* @__PURE__ */ t(he, { p: d, selected: i, running: n.status === "running" }),
        o && /* @__PURE__ */ c("mesh", { position: [0, 0.015, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [0.9, 0.96, 40] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing, transparent: !0, opacity: 0.4 })
        ] }),
        /* @__PURE__ */ t(J, { position: [0, ye[n.kind], 0], center: !0, distanceFactor: 16, zIndexRange: [20, 0], children: /* @__PURE__ */ c(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              pointerEvents: "none",
              fontFamily: "system-ui, sans-serif"
            },
            children: [
              /* @__PURE__ */ c(
                "div",
                {
                  style: {
                    padding: "2px 10px",
                    borderRadius: 10,
                    background: r === "dark" ? "#26282D" : "#FFFFFF",
                    border: `0.5px solid ${i ? d.selectRing : y}`,
                    color: r === "dark" ? "#E8EAEE" : "#23262B",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    boxShadow: r === "dark" ? "0 2px 8px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.12)"
                  },
                  children: [
                    n.name,
                    n.kind === "agv" && n.status ? ` · ${b.status[n.status]}` : ""
                  ]
                }
              ),
              /* @__PURE__ */ t(
                "div",
                {
                  style: {
                    padding: "1px 9px",
                    borderRadius: 10,
                    background: r === "dark" ? "#14293F" : "#E6F1FB",
                    border: `0.5px solid ${d.selectRing}`,
                    color: r === "dark" ? "#85B7EB" : "#0C447C",
                    fontSize: 11,
                    whiteSpace: "nowrap"
                  },
                  children: n.bindLabel ?? b.palette.unbound
                }
              )
            ]
          }
        ) })
      ]
    }
  );
}
const Ee = {
  running: "#3B6D11",
  idle: "#BA7517",
  offline: "#888780"
}, Be = {
  running: "运行中",
  idle: "待机",
  offline: "离线"
}, De = {
  pending: "未开始",
  in_progress: "加工中",
  completed: "已完成",
  cancelled: "已取消"
}, Ae = {
  ready: "齐料",
  short: "缺料",
  none: "无物料需求"
}, ve = [
  "work_center",
  "agv",
  "warehouse",
  "person",
  "truck"
];
function fe({ bindingOptions: n }) {
  const r = u((l) => l.layoutEditable), e = u((l) => l.theme), o = u((l) => l.locale), i = u((l) => l.sceneObjects), a = u((l) => l.selectedSceneObjectId), s = u((l) => l.addSceneObject), d = u((l) => l.renameSceneObject), b = u((l) => l.bindSceneObject), y = u((l) => l.removeSceneObject), g = T[o];
  if (!r) return null;
  const S = e === "dark", O = {
    position: "absolute",
    left: 20,
    top: "50%",
    transform: "translateY(-50%)",
    width: 188,
    padding: 10,
    borderRadius: 12,
    background: S ? "rgba(22,25,31,.92)" : "rgba(255,255,255,.94)",
    border: `0.5px solid ${S ? "rgba(255,255,255,.12)" : "rgba(15,23,42,.10)"}`,
    boxShadow: S ? "0 12px 32px rgba(0,0,0,.5)" : "0 12px 32px rgba(15,23,42,.14)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    color: S ? "#E8EAEE" : "#23262B",
    fontFamily: "system-ui, sans-serif",
    fontSize: 12,
    pointerEvents: "auto",
    zIndex: 30
  }, C = {
    fontSize: 11,
    letterSpacing: ".04em",
    opacity: 0.6,
    margin: "0 2px 8px",
    textTransform: "uppercase"
  }, h = (l) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 9px",
    marginBottom: 6,
    borderRadius: 8,
    border: `0.5px solid ${S ? "rgba(255,255,255,.10)" : "rgba(15,23,42,.08)"}`,
    background: S ? "rgba(255,255,255,.04)" : "#fff",
    color: "inherit",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color .15s ease, transform .15s ease"
  }), _ = i.find((l) => l.id === a) ?? null;
  let x = _ ? n?.[_.kind] ?? [] : [];
  if (_?.kind === "work_center") {
    const l = u.getState().devices, k = /* @__PURE__ */ new Set([
      ...l.map((m) => m.deviceId != null ? String(m.deviceId) : "").filter(Boolean),
      ...i.filter((m) => m.kind === "work_center" && m.bindId != null).map((m) => String(m.bindId))
    ]);
    x = x.filter((m) => !k.has(String(m.id)));
  }
  return /* @__PURE__ */ c("div", { style: O, onPointerDown: (l) => l.stopPropagation(), children: [
    /* @__PURE__ */ t("div", { style: C, children: g.palette.title }),
    ve.map((l) => /* @__PURE__ */ c(
      "button",
      {
        type: "button",
        style: h(),
        onClick: () => s(l),
        title: g.palette.hint,
        children: [
          /* @__PURE__ */ t(
            "span",
            {
              style: {
                width: 9,
                height: 9,
                borderRadius: 3,
                background: R[l].accent,
                flex: "none"
              }
            }
          ),
          /* @__PURE__ */ t("span", { style: { flex: 1 }, children: g.objectKind[l] }),
          /* @__PURE__ */ t("span", { style: { opacity: 0.5, fontSize: 14, lineHeight: 1 }, children: "+" })
        ]
      },
      l
    )),
    /* @__PURE__ */ t("div", { style: { marginTop: 6, fontSize: 10.5, opacity: 0.55, lineHeight: 1.5 }, children: g.palette.hint }),
    _ && /* @__PURE__ */ c(
      "div",
      {
        style: {
          marginTop: 10,
          paddingTop: 10,
          borderTop: `0.5px dashed ${S ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`
        },
        children: [
          /* @__PURE__ */ t("div", { style: C, children: g.objectKind[_.kind] }),
          /* @__PURE__ */ t(
            "input",
            {
              value: _.name,
              onChange: (l) => d(_.id, l.target.value),
              placeholder: g.palette.name,
              style: {
                width: "100%",
                padding: "5px 8px",
                marginBottom: 8,
                borderRadius: 7,
                border: `0.5px solid ${S ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`,
                background: S ? "rgba(255,255,255,.05)" : "#fff",
                color: "inherit",
                fontSize: 12,
                outline: "none"
              }
            }
          ),
          /* @__PURE__ */ t("div", { style: { fontSize: 10.5, opacity: 0.55, marginBottom: 4 }, children: g.palette.binding }),
          /* @__PURE__ */ c(
            "select",
            {
              value: _.bindId != null ? String(_.bindId) : "",
              onChange: (l) => {
                const k = l.target.value, m = x.find((f) => String(f.id) === k);
                b(_.id, m?.id, m?.label);
              },
              style: {
                width: "100%",
                padding: "5px 8px",
                borderRadius: 7,
                border: `0.5px solid ${S ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`,
                background: S ? "rgba(255,255,255,.05)" : "#fff",
                color: "inherit",
                fontSize: 12,
                outline: "none"
              },
              children: [
                /* @__PURE__ */ t("option", { value: "", children: g.palette.unbound }),
                x.map((l) => /* @__PURE__ */ t("option", { value: String(l.id), children: l.label }, String(l.id)))
              ]
            }
          ),
          /* @__PURE__ */ t(
            "button",
            {
              type: "button",
              onClick: () => y(_.id),
              style: {
                width: "100%",
                marginTop: 8,
                padding: "6px 0",
                borderRadius: 7,
                border: `0.5px solid ${S ? "rgba(226,75,74,.45)" : "rgba(163,45,45,.35)"}`,
                background: "transparent",
                color: S ? "#E24B4A" : "#A32D2D",
                fontSize: 12,
                cursor: "pointer"
              },
              children: g.palette.remove
            }
          )
        ]
      }
    )
  ] });
}
function Ie({
  devices: n,
  onDeviceSelect: r,
  theme: e,
  locale: o,
  layoutEditable: i,
  onLayoutChange: a,
  className: s,
  style: d,
  sceneObjects: b,
  bindingOptions: y,
  showObjectPalette: g = !0,
  onSceneObjectsChange: S,
  onSceneObjectChange: O
}) {
  const C = u((p) => p.devices), h = u((p) => p.theme), _ = u((p) => p.sceneObjects), x = u((p) => p.setDevices), l = u((p) => p.setSceneObjects), k = u((p) => p.setOnDeviceSelect), m = u((p) => p.setTheme), f = u((p) => p.setLocale), v = u((p) => p.setLayoutEditable), M = u((p) => p.setOnLayoutChange), B = u((p) => p.setOnSceneObjectsChange), D = u((p) => p.setOnSceneObjectChange), F = G[h];
  w(() => {
    n && x(n);
  }, [n, x]), w(() => {
    b && l(b);
  }, [b, l]), w(() => {
    e && m(e);
  }, [e, m]), w(() => {
    o && f(de(o));
  }, [o, f]), w(() => {
    v(!!i);
  }, [i, v]), w(() => (M(a ?? null), () => M(null)), [a, M]), w(() => (B(S ?? null), () => B(null)), [S, B]), w(() => (D(O ?? null), () => D(null)), [O, D]), w(() => (k(r ?? null), () => k(null)), [r, k]);
  const E = () => {
    const p = u.getState();
    p.selectDevice(null), p.selectSceneObject(null);
  };
  return /* @__PURE__ */ c(
    "div",
    {
      className: s,
      style: { width: "100%", height: "100%", position: "relative", ...d },
      children: [
        /* @__PURE__ */ c(
          ee,
          {
            shadows: !0,
            dpr: [1, 2],
            camera: { position: [15, 12, 16], fov: 42 },
            onPointerMissed: E,
            children: [
              /* @__PURE__ */ t("color", { attach: "background", args: [F.background] }, h),
              /* @__PURE__ */ t("fog", { attach: "fog", args: [F.background, F.fog[0], F.fog[1]] }, `fog-${h}`),
              /* @__PURE__ */ t("ambientLight", { intensity: 0.65 }),
              /* @__PURE__ */ t(
                "directionalLight",
                {
                  position: [12, 18, 10],
                  intensity: 1.15,
                  castShadow: !0,
                  "shadow-mapSize": [2048, 2048],
                  "shadow-camera-left": -28,
                  "shadow-camera-right": 28,
                  "shadow-camera-top": 28,
                  "shadow-camera-bottom": -28
                }
              ),
              /* @__PURE__ */ t(le, {}),
              /* @__PURE__ */ t(ue, {}),
              C.map((p) => /* @__PURE__ */ t(be, { device: p }, p.id)),
              _.map((p) => /* @__PURE__ */ t(Se, { object: p }, p.id)),
              /* @__PURE__ */ t(
                te,
                {
                  makeDefault: !0,
                  target: [0, 1, 0],
                  maxPolarAngle: Math.PI / 2.1,
                  minDistance: 6,
                  maxDistance: 50
                }
              )
            ]
          }
        ),
        g && /* @__PURE__ */ t(fe, { bindingOptions: y })
      ]
    }
  );
}
function Fe(n = 2500) {
  const r = ["running", "running", "running", "idle", "fault"], e = setInterval(() => {
    const { devices: o, updateDeviceStatus: i } = u.getState();
    if (o.length === 0) return;
    const a = o[Math.floor(Math.random() * o.length)], s = r[Math.floor(Math.random() * r.length)];
    a.status !== s && i(a.id, s);
  }, n);
  return () => clearInterval(e);
}
const Re = [
  {
    id: "obj_demo_agv",
    kind: "agv",
    name: "AGV-01",
    position: [11, 0, 7],
    bindId: "AGV-001",
    bindLabel: "AGV-001 · 3 号搬运车",
    status: "running"
  },
  {
    id: "obj_demo_wh",
    kind: "warehouse",
    name: "成品仓",
    position: [-13, 0, 8.5],
    bindId: "WH-02",
    bindLabel: "WH-02 · 成品仓"
  },
  {
    id: "obj_demo_person",
    kind: "person",
    name: "巡检员",
    position: [1, 0, 8],
    bindId: "EMP-1024",
    bindLabel: "EMP-1024 · 李明"
  },
  {
    id: "obj_demo_truck",
    kind: "truck",
    name: "月台货车",
    position: [8.5, 0, -9.5],
    bindId: "TRK-7",
    bindLabel: "粤B·8823 · 厢式货车",
    status: "running"
  }
], Pe = {
  // 工作中心清单只传"尚未摆放"的（已在场景里的由组件自动过滤，双保险）
  work_center: [
    { id: 8, label: "WC-08 · CNC 加工中心 08" },
    { id: 9, label: "WC-09 · 焊接工作站 02" },
    { id: 10, label: "WC-10 · 测试台 02" }
  ],
  agv: [
    { id: "AGV-001", label: "AGV-001 · 3 号搬运车" },
    { id: "AGV-002", label: "AGV-002 · 5 号搬运车" },
    { id: "AGV-003", label: "AGV-003 · 立库穿梭车" }
  ],
  warehouse: [
    { id: "WH-01", label: "WH-01 · 原料仓" },
    { id: "WH-02", label: "WH-02 · 成品仓" },
    { id: "WH-03", label: "WH-03 · 线边仓" }
  ],
  person: [
    { id: "EMP-1024", label: "EMP-1024 · 李明" },
    { id: "EMP-1088", label: "EMP-1088 · 王芳" },
    { id: "EMP-1120", label: "EMP-1120 · 张伟" }
  ],
  truck: [
    { id: "TRK-7", label: "粤B·8823 · 厢式货车" },
    { id: "TRK-9", label: "粤B·9156 · 冷藏车" },
    { id: "TRK-12", label: "粤B·3308 · 平板车" }
  ]
};
export {
  pe as AgvModel,
  Ie as FactoryScene,
  R as KIND_COLORS,
  Ae as KIT_STATUS_LABELS,
  T as LIB_DICT,
  Pe as MOCK_BINDING_OPTIONS,
  oe as MOCK_DEVICE_ROWS,
  ie as MOCK_ORDERS,
  ke as MOCK_ORDER_MATERIALS,
  ae as MOCK_ORDER_OPERATIONS,
  Re as MOCK_SCENE_OBJECTS,
  De as OP_STATUS_LABELS,
  fe as ObjectPalette,
  me as PersonModel,
  ve as SCENE_OBJECT_KINDS,
  G as SCENE_PALETTES,
  Ee as STATUS_COLORS,
  Be as STATUS_LABELS,
  he as TruckModel,
  _e as WarehouseModel,
  $ as fromDeviceRows,
  de as normalizeLocale,
  Fe as startMockRealtime,
  u as useFactoryStore
};
