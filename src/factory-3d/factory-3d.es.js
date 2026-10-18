import { jsxs as c, jsx as t } from "react/jsx-runtime";
import { useState as Y, useRef as A, useEffect as w } from "react";
import { useThree as T, useFrame as Z, Canvas as Q } from "@react-three/fiber";
import { Grid as ee, Html as X, OrbitControls as ne } from "@react-three/drei";
import { create as te } from "zustand";
import * as I from "three";
const re = [
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
], oe = [
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
], ie = [
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
function W(n) {
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
const q = 21, L = 13, K = 0.5, V = (n) => Math.round(n / K) * K, H = (n, r, e) => Math.min(e, Math.max(r, n));
function J({
  position: n,
  editable: r,
  onDrop: e
}) {
  const o = T((y) => y.controls), i = T((y) => y.camera), a = T((y) => y.gl), [s, d] = Y(n), S = A(s);
  S.current = s;
  const b = A(null), m = A(null), h = A(!1), x = A(new I.Raycaster()), M = A(new I.Vector2());
  w(() => {
    b.current?.active || (d(n), S.current = n);
  }, [n]);
  const _ = () => {
    m.current?.(), m.current = null;
  };
  w(() => {
    !r && b.current?.active && (b.current = null, _(), o && (o.enabled = !0), document.body.style.cursor = "auto");
  }, [r, o]), w(() => _, []);
  const v = (y, O) => {
    const f = a.domElement.getBoundingClientRect();
    M.current.set(
      (y.clientX - f.left) / f.width * 2 - 1,
      -((y.clientY - f.top) / f.height) * 2 + 1
    ), x.current.setFromCamera(M.current, i);
    const C = new I.Vector3();
    return x.current.ray.intersectPlane(O, C) ? C : null;
  }, g = () => {
    const y = b.current;
    if (!y?.active || (b.current = null, _(), o && (o.enabled = !0), document.body.style.cursor = r ? "grab" : "auto", !y.moved)) return;
    h.current = !0;
    const [O, , f] = S.current;
    e(O, f);
  };
  return {
    pos: s,
    handlers: { onPointerDown: (y) => {
      if (!r || y.button !== 0) return;
      y.stopPropagation();
      const O = new I.Plane(new I.Vector3(0, 1, 0), 0), f = new I.Vector3();
      if (!y.ray.intersectPlane(O, f)) return;
      o && (o.enabled = !1);
      const C = {
        active: !0,
        moved: !1,
        offset: new I.Vector3(f.x - n[0], 0, f.z - n[2]),
        plane: O,
        origin: n
      };
      b.current = C, document.body.style.cursor = "grabbing";
      const D = (F) => {
        const E = b.current;
        if (!E?.active) return;
        const p = v(F, E.plane);
        if (!p) return;
        const z = H(V(p.x - E.offset.x), -q, q), N = H(V(p.z - E.offset.z), -L, L);
        (Math.abs(z - E.origin[0]) > 0.01 || Math.abs(N - E.origin[2]) > 0.01) && (E.moved = !0);
        const $ = [z, E.origin[1], N];
        S.current = $, d($);
      }, k = () => g();
      window.addEventListener("pointermove", D), window.addEventListener("pointerup", k), window.addEventListener("pointercancel", k), m.current = () => {
        window.removeEventListener("pointermove", D), window.removeEventListener("pointerup", k), window.removeEventListener("pointercancel", k);
      };
    } },
    shouldSkipClick: () => h.current ? (h.current = !1, !0) : !1,
    isDragging: () => !!b.current?.active
  };
}
function ae(n, r = 3) {
  const e = (o, i) => n.some((a) => Math.abs(a[0] - o) < r * 0.9 && Math.abs(a[2] - i) < r * 0.9);
  for (let o = -L + 3; o <= L - 3; o += r)
    for (let i = -q + 3; i <= q - 3; i += r)
      if (!e(i, o)) return [i, 0, o];
  return [0, 0, 0];
}
const U = re, u = te((n, r) => ({
  devices: W(U),
  deviceRows: U,
  orders: oe,
  operations: ie,
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
    devices: o.devices.some((i) => i.deviceId != null) ? ce(o.devices, e) : W(e)
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
    const i = r(), a = i.sceneObjects.filter((m) => m.kind === e).length, s = [
      ...i.devices.map((m) => m.position),
      ...i.sceneObjects.map((m) => m.position)
    ], d = {
      agv: "AGV",
      warehouse: "仓库",
      person: "人员",
      truck: "货车"
    }, S = {
      id: `obj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: e,
      name: o ?? `${d[e]}-${String(a + 1).padStart(2, "0")}`,
      position: ae(s),
      status: e === "agv" || e === "truck" ? "idle" : void 0
    }, b = [...i.sceneObjects, S];
    return n({ sceneObjects: b, selectedSceneObjectId: S.id, selectedDeviceCode: null }), P(r(), b, "add", S), S;
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
function ce(n, r) {
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
const j = {
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
function se(n) {
  return n && n.toLowerCase().startsWith("en") ? "en" : "zh";
}
const G = {
  zh: {
    status: { running: "运行中", idle: "待机", fault: "故障" },
    sceneStatus: { running: "运行中", idle: "待机", offline: "离线" },
    opStatus: { pending: "未开始", in_progress: "加工中", completed: "已完成", cancelled: "已取消" },
    kitStatus: { ready: "齐料", short: "缺料", none: "无物料需求" },
    objectKind: { agv: "AGV 小车", warehouse: "仓储房屋", person: "人员", truck: "货车" },
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
    objectKind: { agv: "AGV", warehouse: "Warehouse", person: "Person", truck: "Truck" },
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
function de() {
  const n = u((e) => e.theme), r = j[n];
  return /* @__PURE__ */ c("group", { children: [
    /* @__PURE__ */ c("mesh", { rotation: [-Math.PI / 2, 0, 0], receiveShadow: !0, children: [
      /* @__PURE__ */ t("planeGeometry", { args: [48, 32] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: r.floor })
    ] }),
    /* @__PURE__ */ t(
      ee,
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
function le() {
  const n = u((a) => a.theme), r = j[n], e = 22, o = 12, i = 5;
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
const Ee = {
  running: "#3B6D11",
  idle: "#BA7517",
  offline: "#888780"
}, ue = {
  running: "#3B6D11",
  idle: "#BA7517",
  fault: "#A32D2D"
}, De = {
  running: "运行中",
  idle: "待机",
  offline: "离线"
}, Be = {
  pending: "未开始",
  in_progress: "加工中",
  completed: "已完成",
  cancelled: "已取消"
}, Ie = {
  ready: "齐料",
  short: "缺料",
  none: "无物料需求"
}, pe = ["agv", "warehouse", "person", "truck"];
function _e(n) {
  return n === "fault" ? "offline" : n;
}
function me({ device: n }) {
  const r = u((g) => g.theme), e = u((g) => g.locale), o = u((g) => g.layoutEditable), i = u((g) => g.selectedDeviceCode === n.id), a = u((g) => g.selectDevice), s = u((g) => g.moveDevice), d = j[r], S = G[e], b = n.status, m = _e(b), h = ue[b], { pos: x, handlers: M, shouldSkipClick: _ } = J({
    position: n.position,
    editable: o,
    onDrop: (g, l) => {
      s(n.id, g, l);
      const { pendingLayout: B, deviceRows: y, onLayoutChange: O } = u.getState(), f = Object.entries(B).map(([C, D]) => ({
        deviceCode: C,
        deviceId: y.find((k) => k.device_code === C)?.device_id,
        sceneX: D.sceneX,
        sceneZ: D.sceneZ
      }));
      O?.(f);
    }
  });
  return /* @__PURE__ */ c(
    "group",
    {
      position: x,
      onClick: (g) => {
        g.stopPropagation(), !_() && a(i ? null : n.id);
      },
      ...M,
      onPointerOver: (g) => {
        g.stopPropagation(), document.body.style.cursor = o ? "grab" : "pointer";
      },
      onPointerOut: () => {
        document.body.style.cursor = "auto";
      },
      children: [
        /* @__PURE__ */ c("mesh", { position: [0, 0.2, 0], castShadow: !0, receiveShadow: !0, children: [
          /* @__PURE__ */ t("boxGeometry", { args: [1.9, 0.4, 1.5] }),
          /* @__PURE__ */ t("meshStandardMaterial", { color: b === "fault" ? d.baseFault : d.base })
        ] }),
        /* @__PURE__ */ c("mesh", { position: [0, 1.05, 0], castShadow: !0, children: [
          /* @__PURE__ */ t("boxGeometry", { args: [1.4, 1.3, 1] }),
          /* @__PURE__ */ t(
            "meshStandardMaterial",
            {
              color: i ? d.bodySelected : b === "fault" ? d.bodyFault : d.body,
              emissive: i ? d.selectRing : "#000000",
              emissiveIntensity: i ? 0.25 : 0
            }
          )
        ] }),
        /* @__PURE__ */ c("mesh", { position: [0, 1.85, 0], children: [
          /* @__PURE__ */ t("sphereGeometry", { args: [0.14, 16, 16] }),
          /* @__PURE__ */ t(
            "meshStandardMaterial",
            {
              color: h,
              emissive: h,
              emissiveIntensity: r === "dark" ? i ? 2.2 : 1.5 : i ? 1.8 : 1
            }
          )
        ] }),
        i && /* @__PURE__ */ c("mesh", { position: [0, 0.03, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [1.15, 1.4, 40] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing })
        ] }),
        o && /* @__PURE__ */ c("mesh", { position: [0, 0.02, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [1.25, 1.32, 48] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing, transparent: !0, opacity: 0.45 })
        ] }),
        /* @__PURE__ */ t(X, { position: [0, 2.4, 0], center: !0, distanceFactor: 16, zIndexRange: [20, 0], children: /* @__PURE__ */ c(
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
                    background: d.labelBg[m],
                    border: `0.5px solid ${d.labelBorder[m]}`,
                    color: d.labelText[m],
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    boxShadow: r === "dark" ? "0 2px 8px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.12)"
                  },
                  children: [
                    n.name,
                    " · ",
                    S.status[b]
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
const R = {
  agv: { body: "#F2C14E", accent: "#1D9A6C" },
  warehouse: { body: "#9AA6B2", accent: "#185FA5" },
  person: { body: "#E8ECF1", accent: "#3B6D11" },
  truck: { body: "#E9EDF2", accent: "#1F6FB2" }
};
function he({ p: n, selected: r, running: e }) {
  const o = A(null);
  Z((a, s) => {
    o.current && e && (o.current.rotation.y += s * 2.4);
  });
  const i = R.agv;
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
    /* @__PURE__ */ t("group", { ref: o, children: [-0.55, 0.55].map(
      (a) => [-0.5, 0.5].map((s) => /* @__PURE__ */ c("mesh", { position: [a, 0.18, s], rotation: [Math.PI / 2, 0, 0], castShadow: !0, children: [
        /* @__PURE__ */ t("cylinderGeometry", { args: [0.18, 0.18, 0.14, 16] }),
        /* @__PURE__ */ t("meshStandardMaterial", { color: "#26282D" })
      ] }, `${a}-${s}`))
    ) }),
    /* @__PURE__ */ c("mesh", { position: [0.86, 0.42, 0], rotation: [0, 0, -Math.PI / 2], children: [
      /* @__PURE__ */ t("coneGeometry", { args: [0.13, 0.22, 12] }),
      /* @__PURE__ */ t("meshStandardMaterial", { color: i.accent })
    ] })
  ] });
}
function ge({ p: n, selected: r }) {
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
function be({ p: n, selected: r }) {
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
function ye({
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
const Se = {
  agv: 1.35,
  warehouse: 3.5,
  person: 2.05,
  truck: 2.15
};
function ve({ object: n }) {
  const r = u((_) => _.theme), e = u((_) => _.locale), o = u((_) => _.layoutEditable), i = u((_) => _.selectedSceneObjectId === n.id), a = u((_) => _.selectSceneObject), s = u((_) => _.moveSceneObject), d = j[r], S = G[e], b = R[n.kind].accent, { pos: m, handlers: h, shouldSkipClick: x } = J({
    position: n.position,
    editable: o,
    onDrop: (_, v) => s(n.id, _, v)
  });
  return /* @__PURE__ */ c(
    "group",
    {
      position: m,
      onClick: (_) => {
        _.stopPropagation(), !x() && a(i ? null : n.id);
      },
      ...h,
      onPointerOver: (_) => {
        _.stopPropagation(), document.body.style.cursor = o ? "grab" : "pointer";
      },
      onPointerOut: () => {
        document.body.style.cursor = "auto";
      },
      children: [
        n.kind === "agv" && /* @__PURE__ */ t(he, { p: d, selected: i, running: n.status === "running" }),
        n.kind === "warehouse" && /* @__PURE__ */ t(ge, { p: d, selected: i }),
        n.kind === "person" && /* @__PURE__ */ t(be, { p: d, selected: i }),
        n.kind === "truck" && /* @__PURE__ */ t(ye, { p: d, selected: i, running: n.status === "running" }),
        o && /* @__PURE__ */ c("mesh", { position: [0, 0.015, 0], rotation: [-Math.PI / 2, 0, 0], children: [
          /* @__PURE__ */ t("ringGeometry", { args: [0.9, 0.96, 40] }),
          /* @__PURE__ */ t("meshBasicMaterial", { color: d.selectRing, transparent: !0, opacity: 0.4 })
        ] }),
        /* @__PURE__ */ t(X, { position: [0, Se[n.kind], 0], center: !0, distanceFactor: 16, zIndexRange: [20, 0], children: /* @__PURE__ */ c(
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
                    border: `0.5px solid ${i ? d.selectRing : b}`,
                    color: r === "dark" ? "#E8EAEE" : "#23262B",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    boxShadow: r === "dark" ? "0 2px 8px rgba(0,0,0,.4)" : "0 2px 8px rgba(15,23,42,.12)"
                  },
                  children: [
                    n.name,
                    n.kind === "agv" && n.status ? ` · ${S.status[n.status]}` : ""
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
                  children: n.bindLabel ?? S.palette.unbound
                }
              )
            ]
          }
        ) })
      ]
    }
  );
}
function fe({ bindingOptions: n }) {
  const r = u((l) => l.layoutEditable), e = u((l) => l.theme), o = u((l) => l.locale), i = u((l) => l.sceneObjects), a = u((l) => l.selectedSceneObjectId), s = u((l) => l.addSceneObject), d = u((l) => l.renameSceneObject), S = u((l) => l.bindSceneObject), b = u((l) => l.removeSceneObject), m = G[o];
  if (!r) return null;
  const h = e === "dark", x = {
    position: "absolute",
    left: 20,
    top: "50%",
    transform: "translateY(-50%)",
    width: 188,
    padding: 10,
    borderRadius: 12,
    background: h ? "rgba(22,25,31,.92)" : "rgba(255,255,255,.94)",
    border: `0.5px solid ${h ? "rgba(255,255,255,.12)" : "rgba(15,23,42,.10)"}`,
    boxShadow: h ? "0 12px 32px rgba(0,0,0,.5)" : "0 12px 32px rgba(15,23,42,.14)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    color: h ? "#E8EAEE" : "#23262B",
    fontFamily: "system-ui, sans-serif",
    fontSize: 12,
    pointerEvents: "auto",
    zIndex: 10
  }, M = {
    fontSize: 11,
    letterSpacing: ".04em",
    opacity: 0.6,
    margin: "0 2px 8px",
    textTransform: "uppercase"
  }, _ = (l) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 9px",
    marginBottom: 6,
    borderRadius: 8,
    border: `0.5px solid ${h ? "rgba(255,255,255,.10)" : "rgba(15,23,42,.08)"}`,
    background: h ? "rgba(255,255,255,.04)" : "#fff",
    color: "inherit",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color .15s ease, transform .15s ease"
  }), v = i.find((l) => l.id === a) ?? null, g = v ? n?.[v.kind] ?? [] : [];
  return /* @__PURE__ */ c("div", { style: x, onPointerDown: (l) => l.stopPropagation(), children: [
    /* @__PURE__ */ t("div", { style: M, children: m.palette.title }),
    pe.map((l) => /* @__PURE__ */ c(
      "button",
      {
        type: "button",
        style: _(),
        onClick: () => s(l),
        title: m.palette.hint,
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
          /* @__PURE__ */ t("span", { style: { flex: 1 }, children: m.objectKind[l] }),
          /* @__PURE__ */ t("span", { style: { opacity: 0.5, fontSize: 14, lineHeight: 1 }, children: "+" })
        ]
      },
      l
    )),
    /* @__PURE__ */ t("div", { style: { marginTop: 6, fontSize: 10.5, opacity: 0.55, lineHeight: 1.5 }, children: m.palette.hint }),
    v && /* @__PURE__ */ c(
      "div",
      {
        style: {
          marginTop: 10,
          paddingTop: 10,
          borderTop: `0.5px dashed ${h ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`
        },
        children: [
          /* @__PURE__ */ t("div", { style: M, children: m.objectKind[v.kind] }),
          /* @__PURE__ */ t(
            "input",
            {
              value: v.name,
              onChange: (l) => d(v.id, l.target.value),
              placeholder: m.palette.name,
              style: {
                width: "100%",
                padding: "5px 8px",
                marginBottom: 8,
                borderRadius: 7,
                border: `0.5px solid ${h ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`,
                background: h ? "rgba(255,255,255,.05)" : "#fff",
                color: "inherit",
                fontSize: 12,
                outline: "none"
              }
            }
          ),
          /* @__PURE__ */ t("div", { style: { fontSize: 10.5, opacity: 0.55, marginBottom: 4 }, children: m.palette.binding }),
          /* @__PURE__ */ c(
            "select",
            {
              value: v.bindId != null ? String(v.bindId) : "",
              onChange: (l) => {
                const B = l.target.value, y = g.find((O) => String(O.id) === B);
                S(v.id, y?.id, y?.label);
              },
              style: {
                width: "100%",
                padding: "5px 8px",
                borderRadius: 7,
                border: `0.5px solid ${h ? "rgba(255,255,255,.14)" : "rgba(15,23,42,.12)"}`,
                background: h ? "rgba(255,255,255,.05)" : "#fff",
                color: "inherit",
                fontSize: 12,
                outline: "none"
              },
              children: [
                /* @__PURE__ */ t("option", { value: "", children: m.palette.unbound }),
                g.map((l) => /* @__PURE__ */ t("option", { value: String(l.id), children: l.label }, String(l.id)))
              ]
            }
          ),
          /* @__PURE__ */ t(
            "button",
            {
              type: "button",
              onClick: () => b(v.id),
              style: {
                width: "100%",
                marginTop: 8,
                padding: "6px 0",
                borderRadius: 7,
                border: `0.5px solid ${h ? "rgba(226,75,74,.45)" : "rgba(163,45,45,.35)"}`,
                background: "transparent",
                color: h ? "#E24B4A" : "#A32D2D",
                fontSize: 12,
                cursor: "pointer"
              },
              children: m.palette.remove
            }
          )
        ]
      }
    )
  ] });
}
function Ae({
  devices: n,
  onDeviceSelect: r,
  theme: e,
  locale: o,
  layoutEditable: i,
  onLayoutChange: a,
  className: s,
  style: d,
  sceneObjects: S,
  bindingOptions: b,
  showObjectPalette: m = !0,
  onSceneObjectsChange: h,
  onSceneObjectChange: x
}) {
  const M = u((p) => p.devices), _ = u((p) => p.theme), v = u((p) => p.sceneObjects), g = u((p) => p.setDevices), l = u((p) => p.setSceneObjects), B = u((p) => p.setOnDeviceSelect), y = u((p) => p.setTheme), O = u((p) => p.setLocale), f = u((p) => p.setLayoutEditable), C = u((p) => p.setOnLayoutChange), D = u((p) => p.setOnSceneObjectsChange), k = u((p) => p.setOnSceneObjectChange), F = j[_];
  w(() => {
    n && g(n);
  }, [n, g]), w(() => {
    S && l(S);
  }, [S, l]), w(() => {
    e && y(e);
  }, [e, y]), w(() => {
    o && O(se(o));
  }, [o, O]), w(() => {
    f(!!i);
  }, [i, f]), w(() => (C(a ?? null), () => C(null)), [a, C]), w(() => (D(h ?? null), () => D(null)), [h, D]), w(() => (k(x ?? null), () => k(null)), [x, k]), w(() => (B(r ?? null), () => B(null)), [r, B]);
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
          Q,
          {
            shadows: !0,
            dpr: [1, 2],
            camera: { position: [15, 12, 16], fov: 42 },
            onPointerMissed: E,
            children: [
              /* @__PURE__ */ t("color", { attach: "background", args: [F.background] }, _),
              /* @__PURE__ */ t("fog", { attach: "fog", args: [F.background, F.fog[0], F.fog[1]] }, `fog-${_}`),
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
              /* @__PURE__ */ t(de, {}),
              /* @__PURE__ */ t(le, {}),
              M.map((p) => /* @__PURE__ */ t(me, { device: p }, p.id)),
              v.map((p) => /* @__PURE__ */ t(ve, { object: p }, p.id)),
              /* @__PURE__ */ t(
                ne,
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
        m && /* @__PURE__ */ t(fe, { bindingOptions: b })
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
  he as AgvModel,
  Ae as FactoryScene,
  R as KIND_COLORS,
  Ie as KIT_STATUS_LABELS,
  G as LIB_DICT,
  Pe as MOCK_BINDING_OPTIONS,
  re as MOCK_DEVICE_ROWS,
  oe as MOCK_ORDERS,
  ke as MOCK_ORDER_MATERIALS,
  ie as MOCK_ORDER_OPERATIONS,
  Re as MOCK_SCENE_OBJECTS,
  Be as OP_STATUS_LABELS,
  fe as ObjectPalette,
  be as PersonModel,
  pe as SCENE_OBJECT_KINDS,
  j as SCENE_PALETTES,
  Ee as STATUS_COLORS,
  De as STATUS_LABELS,
  ye as TruckModel,
  ge as WarehouseModel,
  W as fromDeviceRows,
  se as normalizeLocale,
  Fe as startMockRealtime,
  u as useFactoryStore
};
