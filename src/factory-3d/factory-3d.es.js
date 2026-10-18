import { jsxs as d, jsx as o } from "react/jsx-runtime";
import { useState as J, useRef as E, useEffect as v } from "react";
import { useThree as $, Canvas as V } from "@react-three/fiber";
import { Grid as Z, Html as j, OrbitControls as H } from "@react-three/drei";
import { create as Y } from "zustand";
import * as O from "three";
const Q = [
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
], ee = [
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
], ne = [
  { order_operation_id: 1, order_id: 101, order_no: "MO-2026-018", line_no: 1, sequence_no: 10, operation_name: "铸造毛坯检验", work_center_id: null, work_center_name: null, assignee_name: "王强", planned_quantity: 200, completed_quantity: 200, scrapped_quantity: 2, operation_status: "completed" },
  { order_operation_id: 2, order_id: 101, order_no: "MO-2026-018", line_no: 2, sequence_no: 20, operation_name: "箱体冲压成型", work_center_id: 3, work_center_name: "冲压机 01", assignee_name: "李明", planned_quantity: 200, completed_quantity: 180, scrapped_quantity: 0, operation_status: "in_progress" },
  { order_operation_id: 3, order_id: 101, order_no: "MO-2026-018", line_no: 3, sequence_no: 30, operation_name: "精铣结合面", work_center_id: 1, work_center_name: "CNC 加工中心 01", assignee_name: "张伟", planned_quantity: 200, completed_quantity: 96, scrapped_quantity: 1, operation_status: "in_progress" },
  { order_operation_id: 4, order_id: 101, order_no: "MO-2026-018", line_no: 4, sequence_no: 40, operation_name: "镗轴承孔", work_center_id: 4, work_center_name: null, assignee_name: null, planned_quantity: 200, completed_quantity: 0, scrapped_quantity: 0, operation_status: "pending" },
  { order_operation_id: 5, order_id: 102, order_no: "MO-2026-021", line_no: 1, sequence_no: 10, operation_name: "下料", work_center_id: null, work_center_name: null, assignee_name: "赵刚", planned_quantity: 500, completed_quantity: 500, scrapped_quantity: 0, operation_status: "completed" },
  { order_operation_id: 6, order_id: 102, order_no: "MO-2026-021", line_no: 2, sequence_no: 20, operation_name: "车削粗加工", work_center_id: 2, work_center_name: "CNC 加工中心 02", assignee_name: "陈浩", planned_quantity: 500, completed_quantity: 300, scrapped_quantity: 4, operation_status: "in_progress" },
  { order_operation_id: 7, order_id: 103, order_no: "MO-2026-015", line_no: 5, sequence_no: 50, operation_name: "总装", work_center_id: 5, work_center_name: "总装工位", assignee_name: "刘洋", planned_quantity: 150, completed_quantity: 42, scrapped_quantity: 0, operation_status: "in_progress" }
], ge = {
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
function P(n) {
  return Math.max(n.length, 1), n.map((t, e) => {
    const r = {
      x: (e % 4 - 1.5) * 4.5,
      z: Math.floor(e / 4) * 5 - 1
    };
    return {
      id: t.device_code,
      name: t.device_name,
      deviceId: t.device_id,
      position: [
        t.scene_x ?? r.x,
        0,
        t.scene_z ?? r.z
      ],
      status: t.scene_status === "running" ? "running" : t.scene_status === "offline" ? "fault" : "idle",
      currentOrderNo: t.current_order_no ?? void 0,
      currentProduct: t.current_product_name ?? void 0,
      output: t.current_op_planned && t.current_op_planned > 0 ? Math.round((t.current_op_completed ?? 0) / t.current_op_planned * 100) : void 0
    };
  });
}
const F = Q, l = Y((n, t) => ({
  devices: P(F),
  deviceRows: F,
  orders: ee,
  operations: ne,
  selectedDeviceCode: null,
  selectedOrderId: null,
  theme: "light",
  locale: "zh",
  layoutEditable: !1,
  pendingLayout: {},
  onDeviceSelect: null,
  onOrderSelect: null,
  onLayoutChange: null,
  setDeviceRows: (e) => n((r) => ({
    deviceRows: e,
    devices: r.devices.some((i) => i.deviceId != null) ? te(r.devices, e) : P(e)
  })),
  setDevices: (e) => n({ devices: e }),
  updateDeviceStatus: (e, r) => n((i) => ({
    devices: i.devices.map((a) => a.id === e ? { ...a, status: r } : a)
  })),
  setOrders: (e) => n({ orders: e }),
  setOperations: (e) => n({ operations: e }),
  selectDevice: (e) => {
    t().onDeviceSelect?.(e), n((r) => {
      const i = r.deviceRows.find((a) => a.device_code === e);
      return {
        selectedDeviceCode: e,
        selectedOrderId: e ? i?.current_order_id ?? r.selectedOrderId : null
      };
    });
  },
  selectOrder: (e) => {
    t().onOrderSelect?.(e), n({ selectedOrderId: e });
  },
  setOnDeviceSelect: (e) => n({ onDeviceSelect: e }),
  setOnOrderSelect: (e) => n({ onOrderSelect: e }),
  setTheme: (e) => n({ theme: e }),
  toggleTheme: () => n((e) => ({ theme: e.theme === "light" ? "dark" : "light" })),
  setLocale: (e) => n({ locale: e }),
  setLayoutEditable: (e) => n(e ? { layoutEditable: e } : { layoutEditable: e, pendingLayout: {} }),
  moveDevice: (e, r, i) => n((a) => ({
    devices: a.devices.map(
      (u) => u.id === e ? { ...u, position: [r, u.position[1], i] } : u
    ),
    pendingLayout: { ...a.pendingLayout, [e]: { sceneX: r, sceneZ: i } }
  })),
  clearPendingLayout: () => n({ pendingLayout: {} }),
  setOnLayoutChange: (e) => n({ onLayoutChange: e })
}));
function te(n, t) {
  return t.map((e, r) => {
    const i = n.find((u) => u.id === e.device_code), a = { x: (r % 4 - 1.5) * 4.5, z: Math.floor(r / 4) * 5 - 1 };
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
const x = {
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
function re(n) {
  return n && n.toLowerCase().startsWith("en") ? "en" : "zh";
}
const oe = {
  zh: {
    status: { running: "运行中", idle: "待机", fault: "故障" },
    sceneStatus: { running: "运行中", idle: "待机", offline: "离线" },
    opStatus: { pending: "未开始", in_progress: "加工中", completed: "已完成", cancelled: "已取消" },
    kitStatus: { ready: "齐料", short: "缺料", none: "无物料需求" }
  },
  en: {
    status: { running: "Running", idle: "Idle", fault: "Fault" },
    sceneStatus: { running: "Running", idle: "Idle", offline: "Offline" },
    opStatus: { pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" },
    kitStatus: { ready: "Kitted", short: "Short", none: "No materials" }
  }
};
function ie() {
  const n = l((e) => e.theme), t = x[n];
  return /* @__PURE__ */ d("group", { children: [
    /* @__PURE__ */ d("mesh", { rotation: [-Math.PI / 2, 0, 0], receiveShadow: !0, children: [
      /* @__PURE__ */ o("planeGeometry", { args: [48, 32] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.floor })
    ] }),
    /* @__PURE__ */ o(
      Z,
      {
        position: [0, 0.01, 0],
        args: [48, 32],
        cellSize: 1,
        cellThickness: 0.6,
        cellColor: t.gridCell,
        sectionSize: 5,
        sectionThickness: 1,
        sectionColor: t.gridSection,
        fadeDistance: 70,
        fadeStrength: 1
      }
    ),
    /* @__PURE__ */ d("mesh", { rotation: [-Math.PI / 2, 0, 0], position: [0, 0.02, 7], children: [
      /* @__PURE__ */ o("planeGeometry", { args: [48, 2.4] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.road })
    ] })
  ] });
}
function ae() {
  const n = l((a) => a.theme), t = x[n], e = 22, r = 12, i = 5;
  return /* @__PURE__ */ d("group", { position: [0, 0, -2], children: [
    /* @__PURE__ */ d("mesh", { position: [0, i / 2, -r / 2], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ o("boxGeometry", { args: [e, i, 0.3] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.wall })
    ] }),
    [-e / 2, e / 2].map((a) => /* @__PURE__ */ d("mesh", { position: [a, i / 2, 0], castShadow: !0, receiveShadow: !0, children: [
      /* @__PURE__ */ o("boxGeometry", { args: [0.3, i, r] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.wall })
    ] }, a)),
    [
      [-e / 2, -r / 2],
      [e / 2, -r / 2],
      [-e / 2, r / 2],
      [e / 2, r / 2]
    ].map(([a, u]) => /* @__PURE__ */ d("mesh", { position: [a, i / 2, u], castShadow: !0, children: [
      /* @__PURE__ */ o("boxGeometry", { args: [0.5, i, 0.5] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.steel })
    ] }, `${a},${u}`)),
    [-r / 2, 0, r / 2].map((a) => /* @__PURE__ */ d("mesh", { position: [0, i + 0.2, a], castShadow: !0, children: [
      /* @__PURE__ */ o("boxGeometry", { args: [e + 0.5, 0.35, 0.35] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.steel })
    ] }, a)),
    /* @__PURE__ */ d("mesh", { position: [0, i * 0.72, -r / 2 + 0.17], children: [
      /* @__PURE__ */ o("boxGeometry", { args: [e - 2, 0.9, 0.05] }),
      /* @__PURE__ */ o("meshStandardMaterial", { color: t.wallBand })
    ] })
  ] });
}
const he = {
  running: "#3B6D11",
  idle: "#BA7517",
  offline: "#888780"
}, ce = {
  running: "#3B6D11",
  idle: "#BA7517",
  fault: "#A32D2D"
}, ye = {
  running: "运行中",
  idle: "待机",
  offline: "离线"
}, fe = {
  pending: "未开始",
  in_progress: "加工中",
  completed: "已完成",
  cancelled: "已取消"
}, ve = {
  ready: "齐料",
  short: "缺料",
  none: "无物料需求"
};
function se(n) {
  return n === "fault" ? "offline" : n;
}
const R = 21, T = 13, I = 0.5, z = (n) => Math.round(n / I) * I, N = (n, t, e) => Math.min(e, Math.max(t, n));
function de({ device: n }) {
  const t = l((c) => c.theme), e = l((c) => c.locale), r = l((c) => c.layoutEditable), i = l((c) => c.selectedDeviceCode === n.id), a = l((c) => c.selectDevice), u = l((c) => c.moveDevice), g = $((c) => c.controls), _ = x[t], w = oe[e], y = n.status, S = se(y), C = ce[y], [b, D] = J(n.position), f = E(b);
  f.current = b;
  const p = E(null), s = E(!1);
  v(() => {
    p.current?.active || (D(n.position), f.current = n.position);
  }, [n.position]), v(() => {
    !r && p.current?.active && (p.current = null, g && (g.enabled = !0), document.body.style.cursor = "auto");
  }, [r, g]);
  const G = (c) => {
    if (c.stopPropagation(), s.current) {
      s.current = !1;
      return;
    }
    a(i ? null : n.id);
  }, W = (c) => {
    if (!r || c.button !== 0) return;
    c.stopPropagation();
    const m = new O.Plane(new O.Vector3(0, 1, 0), 0), h = new O.Vector3();
    if (c.ray.intersectPlane(m, h)) {
      g && (g.enabled = !1), p.current = {
        active: !0,
        moved: !1,
        offset: new O.Vector3(h.x - n.position[0], 0, h.z - n.position[2]),
        plane: m,
        origin: n.position
      };
      try {
        c.target?.setPointerCapture?.(
          c.pointerId
        );
      } catch {
      }
      document.body.style.cursor = "grabbing";
    }
  }, U = (c) => {
    const m = p.current;
    if (!m?.active) return;
    const h = new O.Vector3();
    if (!c.ray.intersectPlane(m.plane, h)) return;
    const q = N(z(h.x - m.offset.x), -R, R), B = N(z(h.z - m.offset.z), -T, T);
    (Math.abs(q - m.origin[0]) > 0.01 || Math.abs(B - m.origin[2]) > 0.01) && (m.moved = !0);
    const M = [q, m.origin[1], B];
    f.current = M, D(M);
  }, A = () => {
    const c = p.current;
    if (!c?.active || (p.current = null, g && (g.enabled = !0), document.body.style.cursor = r ? "grab" : "auto", !c.moved)) return;
    s.current = !0;
    const [m, , h] = f.current;
    u(n.id, m, h);
    const { pendingLayout: q, deviceRows: B, onLayoutChange: M } = l.getState(), X = Object.entries(q).map(([k, L]) => ({
      deviceCode: k,
      deviceId: B.find((K) => K.device_code === k)?.device_id,
      sceneX: L.sceneX,
      sceneZ: L.sceneZ
    }));
    M?.(X);
  };
  return /* @__PURE__ */ d(
    "group",
    {
      position: b,
      onClick: G,
      onPointerDown: W,
      onPointerMove: U,
      onPointerUp: A,
      onPointerCancel: A,
      onPointerOver: (c) => {
        c.stopPropagation(), document.body.style.cursor = r ? "grab" : "pointer";
      },
      onPointerOut: () => {
        p.current?.active || (document.body.style.cursor = "auto");
      },
      children: [
        /* @__PURE__ */ d("mesh", { position: [0, 0.2, 0], castShadow: !0, receiveShadow: !0, children: [
          /* @__PURE__ */ o("boxGeometry", { args: [1.9, 0.4, 1.5] }),
          /* @__PURE__ */ o("meshStandardMaterial", { color: y === "fault" ? _.baseFault : _.base })
        ] }),
        /* @__PURE__ */ d("mesh", { position: [0, 1.05, 0], castShadow: !0, children: [
          /* @__PURE__ */ o("boxGeometry", { args: [1.4, 1.3, 1] }),
          /* @__PURE__ */ o(
            "meshStandardMaterial",
            {
              color: i ? _.bodySelected : y === "fault" ? _.bodyFault : _.body,
              emissive: i ? _.selectRing : "#000000",
              emissiveIntensity: i ? 0.25 : 0
            }
          )
        ] }),
        /* @__PURE__ */ d("mesh", { position: [0, 1.85, 0], children: [
          /* @__PURE__ */ o("sphereGeometry", { args: [0.14, 16, 16] }),
          /* @__PURE__ */ o(
            "meshStandardMaterial",
            {
              color: C,
              emissive: C,
              emissiveIntensity: t === "dark" ? i ? 2.2 : 1.5 : i ? 1.8 : 1
            }
          )
        ] }),
        i && /* @__PURE__ */ d("mesh", { position: [0, 0.03, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ o("ringGeometry", { args: [1.15, 1.4, 40] }),
          /* @__PURE__ */ o("meshBasicMaterial", { color: _.selectRing })
        ] }),
        r && /* @__PURE__ */ d("mesh", { position: [0, 0.02, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ o("ringGeometry", { args: [1.25, 1.32, 48] }),
          /* @__PURE__ */ o("meshBasicMaterial", { color: _.selectRing, transparent: !0, opacity: 0.45 })
        ] }),
        /* @__PURE__ */ o(j, { position: [0, 2.4, 0], center: !0, distanceFactor: 16, zIndexRange: [20, 0], children: /* @__PURE__ */ d(
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
              /* @__PURE__ */ d(
                "div",
                {
                  style: {
                    padding: "2px 10px",
                    borderRadius: 10,
                    background: _.labelBg[S],
                    border: `0.5px solid ${_.labelBorder[S]}`,
                    color: _.labelText[S],
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    boxShadow: t === "dark" ? "0 2px 8px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.12)"
                  },
                  children: [
                    n.name,
                    " · ",
                    w.status[y]
                  ]
                }
              ),
              n.currentOrderNo && /* @__PURE__ */ d(
                "div",
                {
                  style: {
                    padding: "1px 9px",
                    borderRadius: 10,
                    background: _.orderBadgeBg,
                    border: `0.5px solid ${_.selectRing}`,
                    color: _.orderBadgeText,
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
function Se({
  devices: n,
  onDeviceSelect: t,
  theme: e,
  locale: r,
  layoutEditable: i,
  onLayoutChange: a,
  className: u,
  style: g
}) {
  const _ = l((s) => s.devices), w = l((s) => s.theme), y = l((s) => s.setDevices), S = l((s) => s.setOnDeviceSelect), C = l((s) => s.setTheme), b = l((s) => s.setLocale), D = l((s) => s.setLayoutEditable), f = l((s) => s.setOnLayoutChange), p = x[w];
  return v(() => {
    n && y(n);
  }, [n, y]), v(() => {
    e && C(e);
  }, [e, C]), v(() => {
    r && b(re(r));
  }, [r, b]), v(() => {
    D(!!i);
  }, [i, D]), v(() => (f(a ?? null), () => f(null)), [a, f]), v(() => (S(t ?? null), () => S(null)), [t, S]), /* @__PURE__ */ o("div", { className: u, style: { width: "100%", height: "100%", ...g }, children: /* @__PURE__ */ d(V, { shadows: !0, dpr: [1, 2], camera: { position: [15, 12, 16], fov: 42 }, children: [
    /* @__PURE__ */ o("color", { attach: "background", args: [p.background] }, w),
    /* @__PURE__ */ o("fog", { attach: "fog", args: [p.background, p.fog[0], p.fog[1]] }, `fog-${w}`),
    /* @__PURE__ */ o("ambientLight", { intensity: 0.65 }),
    /* @__PURE__ */ o(
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
    /* @__PURE__ */ o(ie, {}),
    /* @__PURE__ */ o(ae, {}),
    _.map((s) => /* @__PURE__ */ o(de, { device: s }, s.id)),
    /* @__PURE__ */ o(
      H,
      {
        target: [0, 1, 0],
        maxPolarAngle: Math.PI / 2.1,
        minDistance: 6,
        maxDistance: 50
      }
    )
  ] }) });
}
function be(n = 2500) {
  const t = ["running", "running", "running", "idle", "fault"], e = setInterval(() => {
    const { devices: r, updateDeviceStatus: i } = l.getState();
    if (r.length === 0) return;
    const a = r[Math.floor(Math.random() * r.length)], u = t[Math.floor(Math.random() * t.length)];
    a.status !== u && i(a.id, u);
  }, n);
  return () => clearInterval(e);
}
export {
  Se as FactoryScene,
  ve as KIT_STATUS_LABELS,
  oe as LIB_DICT,
  Q as MOCK_DEVICE_ROWS,
  ee as MOCK_ORDERS,
  ge as MOCK_ORDER_MATERIALS,
  ne as MOCK_ORDER_OPERATIONS,
  fe as OP_STATUS_LABELS,
  x as SCENE_PALETTES,
  he as STATUS_COLORS,
  ye as STATUS_LABELS,
  P as fromDeviceRows,
  re as normalizeLocale,
  be as startMockRealtime,
  l as useFactoryStore
};
