import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Checkbox, Col, DatePicker, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Spin, Splitter, message } from "antd";
import { Graph, Edge } from "@antv/x6";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { supabase } from "../utils/supabase";
import type { Tables } from "../utils/supabase";
import { useUoms, buildUomOptions, productUnitText, normalizeUnitText } from "../hooks/useUoms";

type BomRow = Tables["erp_boms_s_539dcf81_b"]["Row"];
type BomDetailRow = Tables["erp_bom_details_s_539dcf81_b"]["Row"];
type ProductRow = Tables["erp_products_s_539dcf81_b"]["Row"];
type OperationRow = Tables["erp_operations_s_539dcf81_b"]["Row"];

type NodeType = "bom" | "detail";

type BomTreeNode = {
  id: string;
  type: NodeType;
  level: number;
  sourceId: number;
  title: string;
  subtitle: string;
  tag: string;
  productId?: number | null;
  bomId?: number | null;
  detailId?: number | null;
  bom?: BomRow | null;
  detail?: BomDetailRow | null;
  children?: BomTreeNode[];
};

type Props = { materialCode?: string | null };

type DiagramNode = {
  key: string;
  type: NodeType;
  x: number;
  y: number;
  title: string;
  subtitle: string;
  tag: string;
  bomId?: number | null;
  detailId?: number | null;
  bom?: BomRow | null;
  detail?: BomDetailRow | null;
  productId?: number | null;
};

type DiagramEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

const BOM_TABLE = "erp_boms_s_539dcf81_b";
const BOM_DETAIL_TABLE = "erp_bom_details_s_539dcf81_b";
const PRODUCT_TABLE = "erp_products_s_539dcf81_b";
const OPERATION_TABLE = "erp_operations_s_539dcf81_b";
const POSITION_STORAGE_PREFIX = "bom-tree-layout:";
const NODE_WIDTH = 252;
const COLUMN_GAP = 220;
const ROW_GAP = 92;

/** ProLayout 把暗色开关写在 <html data-erp-dark> 上；X6 画布（背景 / 网格 / 节点 / 连线）
 *  的颜色在 JS 里画，拿不到 antd 主题，需要自己跟随它切换。 */
function useIsDarkTheme() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-erp-dark") === "true",
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.getAttribute("data-erp-dark") === "true");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-erp-dark"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

/** 画布明暗两套取色：X6 的背景 / 网格 / 节点 / 连线颜色只能走 JS，没法靠 CSS 继承 */
const BOM_CANVAS_COLORS = {
  light: {
    background: "#fafafa",
    grid: "#eef2f6",
    nodeFillBom: "#f8fbff",
    nodeFillDetail: "#f0fffb",
    nodeStrokeBom: "#1677ff",
    nodeStrokeDetail: "#13c2c2",
    nodeStrokeSelected: "#1677ff",
    nodeShadow: "drop-shadow(0px 0px 10px rgba(22, 119, 255, 0.32))",
    title: "#1f2937",
    titleActive: "#1677ff",
    subtitle: "#667085",
    tag: "#5b6b7d",
    tagActive: "#1677ff",
    portStroke: "#91a4b7",
    portFill: "#fff",
    edgeStroke: "#91a4b7",
    labelText: "#475467",
    labelBg: "#ffffff",
    labelStroke: "#d0d5dd",
  },
  dark: {
    background: "#141414",
    grid: "rgba(255, 255, 255, 0.10)",
    nodeFillBom: "rgba(22, 119, 255, 0.16)",
    nodeFillDetail: "rgba(19, 194, 194, 0.14)",
    nodeStrokeBom: "#4096ff",
    nodeStrokeDetail: "#36cfc9",
    nodeStrokeSelected: "#4096ff",
    nodeShadow: "drop-shadow(0px 0px 12px rgba(64, 150, 255, 0.55))",
    title: "#e6e6e6",
    titleActive: "#4096ff",
    subtitle: "#a6adb8",
    tag: "#a6adb8",
    tagActive: "#4096ff",
    portStroke: "#8c8c8c",
    portFill: "#1f1f1f",
    edgeStroke: "#8c8c8c",
    labelText: "#d9d9d9",
    labelBg: "#1f1f1f",
    labelStroke: "rgba(255, 255, 255, 0.18)",
  },
} as const;

type BomCanvasTheme = keyof typeof BOM_CANVAS_COLORS;

let shapeRegisteredTheme: BomCanvasTheme | null = null;
/** 明暗主题各注册一次（force 覆盖）；节点主色由 addNode 的 attrs 覆盖，
 *  副标题 / 端口这些用注册默认值，所以必须按主题重注册。 */
function ensureShapeRegistered(theme: BomCanvasTheme, colors: (typeof BOM_CANVAS_COLORS)[BomCanvasTheme]) {
  if (shapeRegisteredTheme === theme) return;
  const portAttrs = { circle: { r: 5, magnet: true, stroke: colors.portStroke, strokeWidth: 1, fill: colors.portFill } };
  Graph.registerNode(
    "bom-edit-node",
    {
      inherit: "rect",
      width: NODE_WIDTH,
      height: 84,
      markup: [
        { tagName: "rect", selector: "body" },
        { tagName: "text", selector: "title" },
        { tagName: "text", selector: "subtitle" },
        { tagName: "text", selector: "tag" },
      ],
      attrs: {
        body: { rx: 12, ry: 12, strokeWidth: 2, fill: colors.nodeFillBom },
        title: { refX: 16, refY: 24, fontSize: 14, fontWeight: 600, fill: colors.title, textAnchor: "start", textVerticalAnchor: "middle" },
        subtitle: { refX: 16, refY: 50, fontSize: 12, fill: colors.subtitle, textAnchor: "start", textVerticalAnchor: "middle" },
        tag: { refX: NODE_WIDTH - 14, refY: 18, fontSize: 11, fill: colors.tag, textAnchor: "end", textVerticalAnchor: "middle" },
      },
      ports: {
        groups: {
          top: { position: "top", attrs: portAttrs },
          bottom: { position: "bottom", attrs: portAttrs },
          left: { position: "left", attrs: portAttrs },
          right: { position: "right", attrs: portAttrs },
        },
      },
    },
    true,
  );
  Graph.registerEdge(
    "bom-edit-edge",
    {
      inherit: "edge",
      attrs: {
        line: {
          stroke: colors.edgeStroke,
          strokeWidth: 2,
          targetMarker: { name: "block", width: 10, height: 10 },
        },
      },
      router: { name: "manhattan" },
      connector: { name: "rounded" },
    },
    true,
  );
  shapeRegisteredTheme = theme;
}

async function fetchProductsMap(ids: number[]) {
  if (!ids.length) return new Map<number, ProductRow>();
  const { data, error } = await supabase.from(PRODUCT_TABLE).select("*").in("id", ids);
  if (error) throw error;
  return new Map<number, ProductRow>((data || []).map((item) => [item.id, item]));
}

async function fetchOperationsMap() {
  const { data, error } = await supabase.from(OPERATION_TABLE).select("*").eq("is_deleted", "n");
  if (error) throw error;
  return new Map<number, OperationRow>((data || []).map((item) => [item.id, item]));
}

async function fetchBomByProductId(productId: number) {
  const { data, error } = await supabase.from(BOM_TABLE).select("*").eq("is_deleted", "n").eq("product_id", productId).order("is_default", { ascending: false }).order("effective_date", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function fetchBomDetails(bomId: number) {
  const { data, error } = await supabase.from(BOM_DETAIL_TABLE).select("*").eq("is_deleted", "n").eq("bom_id", bomId).order("line_no");
  if (error) throw error;
  return data || [];
}

async function buildBomTree(materialCode: string, t: (key: string, options?: Record<string, unknown>) => string) {
  const { data, error } = await supabase.from(PRODUCT_TABLE).select("*").eq("is_deleted", "n").eq("code", materialCode).limit(1);
  if (error) throw error;
  const rootProduct = (data || [])[0] || null;
  if (!rootProduct) return null;

  const visitedBomIds = new Set<number>();

  const buildBomNode = async (product: ProductRow, level: number): Promise<BomTreeNode> => {
    const bom = await fetchBomByProductId(product.id);
    const node: BomTreeNode = {
      id: `bom-${bom?.id || product.id}`,
      type: "bom",
      level,
      sourceId: bom?.id || product.id,
      bomId: bom?.id || null,
      bom,
      productId: product.id,
      title: bom?.bom_no || product.code,
      subtitle: `${product.code} ${product.name}`,
      tag: `BOM L${level + 1}`,
    };
    if (!bom || visitedBomIds.has(bom.id) || level > 10) return node;
    visitedBomIds.add(bom.id);
    const details = await fetchBomDetails(bom.id);
    const productMap = await fetchProductsMap(details.map((d) => d.material_id).filter((id): id is number => typeof id === "number"));
    node.children = [];
    for (const detail of details) {
      node.children.push(await buildDetailNode(detail, productMap.get(detail.material_id || -1) || null, level + 1));
    }
    return node;
  };

  const buildDetailNode = async (detail: BomDetailRow, product: ProductRow | null, level: number): Promise<BomTreeNode> => {
    const node: BomTreeNode = {
      id: `detail-${detail.id}`,
      type: "detail",
      level,
      sourceId: detail.id,
      detailId: detail.id,
      detail,
      bomId: detail.bom_id,
      productId: detail.material_id,
      title: product ? `${product.code} ${product.name}` : t("bomTree.fallback.unnamedMaterial"),
      subtitle: [
        t("bomTree.node.quantity", { quantity: detail.quantity ?? 0 }),
        detail.unit,
        detail.loss_rate != null ? t("bomTree.node.lossRate", { rate: ((detail.loss_rate || 0) * 100).toFixed(2) }) : undefined,
      ].filter(Boolean).join(" / "),
      tag: `Detail L${level + 1}`,
    };
    if (!product || level > 10) return node;
    const bom = await fetchBomByProductId(product.id);
    if (!bom || visitedBomIds.has(bom.id)) return node;
    node.children = [await buildBomNode(product, level + 1)];
    return node;
  };

  return buildBomNode(rootProduct, 0);
}

function flattenTree(root: BomTreeNode | null, t: (key: string, options?: Record<string, unknown>) => string) {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const visited = new Set<string>();
  let maxRow = 0;

  const walk = (node: BomTreeNode, row: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const column = node.type === "bom" ? 0 : 1;
    const x = 40 + column * COLUMN_GAP;
    const y = 24 + row * ROW_GAP;
    nodes.push({ key: node.id, type: node.type, x, y, title: node.title, subtitle: node.subtitle, tag: node.tag, bomId: node.bomId, detailId: node.detailId, productId: node.productId });
    maxRow = Math.max(maxRow, row);
    (node.children || []).forEach((child, index) => {
      edges.push({
        id: `${node.id}-to-${child.id}`,
        source: node.id,
        target: child.id,
        label: `${node.type === "bom" ? t("bomTree.node.headerType") : t("bomTree.node.detailType")} → ${child.type === "bom" ? t("bomTree.node.headerType") : t("bomTree.node.detailType")}`,
      });
      walk(child, row + index + 1);
    });
  };

  if (root) walk(root, 0);
  return { nodes, edges, height: 24 + (maxRow + 1) * ROW_GAP + 140 };
}

function findTreeNode(root: BomTreeNode | null, id: string): BomTreeNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}
export function BomEditableTreeGraph({ materialCode }: Props) {
  const { t } = useTranslation();
  const isDark = useIsDarkTheme();
  const canvasColors = useMemo(
    () => (isDark ? BOM_CANVAS_COLORS.dark : BOM_CANVAS_COLORS.light),
    [isDark],
  );
  const [loading, setLoading] = useState(false);
  const [treeData, setTreeData] = useState<BomTreeNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<BomTreeNode | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const [leftForm] = Form.useForm();
  const [rightForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<"detail" | "bom" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const positionCacheRef = useRef<Record<string, { x: number; y: number }>>({});

  // 单位下拉数据源 = 单位主数据表（erp_uoms），与物料管理页一致。
  // 原先用的 <DictSelect dictType="uom" /> 取的是 sys_dict_items，
  // 而该字典并不存在 → 下拉恒为空。
  const { uoms, uomMap, groupNameMap } = useUoms();
  const uomOptions = useMemo(
    () => buildUomOptions(uoms, groupNameMap, "symbol"),
    [uoms, groupNameMap],
  );

  const title = useMemo(() => (materialCode ? t("bomTree.titleWithCode", { code: materialCode }) : t("bomTree.title")), [materialCode, t]);

  const reloadTree = async (keepSelectedId?: string | null) => {
    if (!materialCode) return;
    setLoading(true);
    try {
      const data = await buildBomTree(materialCode, t);
      setTreeData(data);
      if (keepSelectedId && data) {
        const queue = [data];
        while (queue.length) {
          const item = queue.shift()!;
          if (item.id === keepSelectedId) {
            setSelectedNode(item);
            break;
          }
          queue.push(...(item.children || []));
        }
      }
    } catch (error) {
      console.error(error);
      message.error(t("bomTree.msg.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedNode) return;
    if (selectedNode.type === "bom") {
      const product = products.find((item) => item.id === selectedNode.productId);
      const bom = selectedNode.bom;
      leftForm.setFieldsValue({
        bom_no: bom?.bom_no ?? selectedNode.title,
        product_id: bom?.product_id ?? selectedNode.productId,
        version: bom?.version ?? undefined,
        quantity: bom?.quantity ?? undefined,
        unit: normalizeUnitText(bom?.unit, uomMap) || productUnitText(product, uomMap),
        is_default: bom?.is_default ?? false,
        is_active: bom?.is_active ?? false,
        effective_date: bom?.effective_date ? dayjs(bom.effective_date) : null,
        expiry_date: bom?.expiry_date ? dayjs(bom.expiry_date) : null,
        remark: bom?.remark ?? selectedNode.subtitle,
      });
      rightForm.resetFields();
    } else {
      const detail = selectedNode.detail;
      rightForm.setFieldsValue({
        line_no: detail?.line_no ?? undefined,
        material_id: detail?.material_id ?? selectedNode.productId,
        quantity: detail?.quantity ?? undefined,
        unit: normalizeUnitText(detail?.unit, uomMap) || undefined,
        loss_rate: detail?.loss_rate ?? undefined,
        operation_id: detail?.operation_id ?? undefined,
        remark: detail?.remark ?? undefined,
      });
      leftForm.resetFields();
    }
  }, [selectedNode, products, uomMap, leftForm, rightForm]);

  useEffect(() => {
    void (async () => {
      const [productRes, operationRes] = await Promise.all([
        supabase.from(PRODUCT_TABLE).select("*").eq("is_deleted", "n"),
        fetchOperationsMap(),
      ]);
      setProducts(productRes.data || []);
      setOperations(Array.from(operationRes.values()));
    })();
  }, []);

  useEffect(() => {
    void reloadTree();
  }, [materialCode]);

  useEffect(() => {
    if (!treeData || !containerRef.current) return;
    ensureShapeRegistered(isDark ? "dark" : "light", canvasColors);
    graphRef.current?.dispose();
    const storageKey = `${POSITION_STORAGE_PREFIX}${materialCode || "default"}`;
    try { positionCacheRef.current = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { positionCacheRef.current = {}; }
    const model = flattenTree(treeData, t);
    const graph = new Graph({
      container: containerRef.current,
      width: containerRef.current.clientWidth || 900,
      height: Math.max(containerRef.current.clientHeight || 640, model.height),
      grid: { size: 10, visible: true, type: "mesh", args: { color: canvasColors.grid, thickness: 1 } },
      background: { color: canvasColors.background },
      interacting: { nodeMovable: true, edgeMovable: false, vertexMovable: false, arrowheadMovable: false },
      // 平移画布：左键拖空白区、右键拖、滚轮（不按 ctrl 时滚轮＝平移，ctrl+滚轮＝缩放）。
      // 原来只开了 rightMouseDown + mouseWheel，左键在空白处拖拽完全没反应。
      // x6 的平移只在 blank:mousedown / node:unhandled:mousedown 上启动，所以
      // 节点拖动与端口拉线不受影响（已用无头 Chrome 实测：加 leftMouseDown 后
      // 节点仍可被拖走且画布 translate 保持 0，端口仍能建连线）。
      panning: { enabled: true, eventTypes: ["leftMouseDown", "rightMouseDown", "mouseWheel"] },
      mousewheel: { enabled: true, modifiers: "ctrl", factor: 1.1, minScale: 0.5, maxScale: 1.5 },
      connecting: {
        allowBlank: false, allowLoop: false, allowMulti: false, snap: true, highlight: true, connectionPoint: "anchor",
        createEdge: (): Edge => graph.createEdge({ shape: "bom-edit-edge" }),
        validateConnection: ({ sourceCell, targetCell }) => Boolean(sourceCell && targetCell && sourceCell.id !== targetCell.id),
      },
    });
    graphRef.current = graph;
    model.nodes.forEach((node) => graph.addNode({
      id: node.key, shape: "bom-edit-node", x: positionCacheRef.current[node.key]?.x ?? node.x, y: positionCacheRef.current[node.key]?.y ?? node.y,
      data: node,
      ports: [{ id: `${node.key}-top`, group: "top" }, { id: `${node.key}-bottom`, group: "bottom" }, { id: `${node.key}-left`, group: "left" }, { id: `${node.key}-right`, group: "right" }],
      attrs: {
        body: {
          stroke: selectedNode?.id === node.key ? canvasColors.nodeStrokeSelected : node.type === "bom" ? canvasColors.nodeStrokeBom : canvasColors.nodeStrokeDetail,
          fill: node.type === "bom" ? canvasColors.nodeFillBom : canvasColors.nodeFillDetail,
          filter: selectedNode?.id === node.key ? canvasColors.nodeShadow : undefined,
        },
        title: { text: node.title, fill: selectedNode?.id === node.key ? canvasColors.titleActive : canvasColors.title },
        subtitle: { text: node.subtitle, fill: canvasColors.subtitle },
        tag: { text: node.type === "bom" ? "BOM" : "DETAIL", fill: selectedNode?.id === node.key ? canvasColors.tagActive : canvasColors.tag },
      },
    }));
    model.edges.forEach((edge) => graph.addEdge({
      id: edge.id, shape: "bom-edit-edge", source: { cell: edge.source, port: `${edge.source}-bottom` }, target: { cell: edge.target, port: `${edge.target}-top` },
      labels: [{ attrs: { text: { text: edge.label, fill: canvasColors.labelText, fontSize: 11, fontWeight: 500 }, rect: { fill: canvasColors.labelBg, stroke: canvasColors.labelStroke, rx: 6, ry: 6 } }, position: 0.5 }],
    }));
    graph.centerContent();
    const selectGraphNode = (node: any) => { const data = findTreeNode(treeData, String(node.id)); if (data) setSelectedNode(data); };
    graph.on("node:click", ({ node }: { node: any }) => selectGraphNode(node));
    graph.on("cell:click", ({ cell }: { cell: any }) => { if (cell?.isNode?.()) selectGraphNode(cell); });
    graph.on("blank:click", () => setSelectedNode(null));
    graph.on("node:mouseup", ({ node }: { node: any }) => { const pos = node.position(); positionCacheRef.current[String(node.id)] = { x: pos.x, y: pos.y }; localStorage.setItem(storageKey, JSON.stringify(positionCacheRef.current)); });
    return () => { graph.dispose(); graphRef.current = null; };
  }, [treeData, selectedNode?.id, materialCode, canvasColors]);
  const handleSaveSelected = async () => {
    if (!selectedNode) return;
    try {
      if (selectedNode.type === "bom" && selectedNode.bomId) {
        const values = await leftForm.validateFields();
        const { error } = await supabase.from(BOM_TABLE).update(values).eq("id", selectedNode.bomId);
        if (error) throw error;
        message.success(t("bomTree.msg.headerSaved"));
      } else if (selectedNode.type === "detail" && selectedNode.detailId) {
        const values = await rightForm.validateFields();
        const { error } = await supabase.from(BOM_DETAIL_TABLE).update(values).eq("id", selectedNode.detailId);
        if (error) throw error;
        message.success(t("bomTree.msg.detailSaved"));
      }
      await reloadTree(selectedNode.id);
    } catch (error) {
      console.error(error);
      message.error(t("common.saveFailed"));
    }
  };

  const openCreateModal = () => {
    if (!selectedNode) return;
    const target = selectedNode.type === "bom" ? "detail" : "bom";
    setCreateTarget(target);
    createForm.resetFields();
    if (target === "detail" && selectedNode.type === "bom") {
      const details = [];
      createForm.setFieldsValue({ line_no: details.length + 1, quantity: 0, loss_rate: 0 });
    }
    if (target === "bom" && selectedNode.productId) {
      const product = products.find((item) => item.id === selectedNode.productId);
      createForm.setFieldsValue({
        product_id: product?.id,
        quantity: 1,
        unit: productUnitText(product, uomMap),
        version: "1.0",
        is_default: false,
        is_active: true,
      });
    }
    setCreateModalOpen(true);
  };

  const handleCreateSubmit = async () => {
    if (!selectedNode || !createTarget) return;
    try {
      const values = await createForm.validateFields();
      if (createTarget === "detail" && selectedNode.type === "bom" && selectedNode.bomId) {
        const details = await fetchBomDetails(selectedNode.bomId);
        const nextLineNo = details.length ? Math.max(...details.map((item) => item.line_no || 0)) + 1 : 1;
        const payload: Partial<BomDetailRow> = {
          bom_id: selectedNode.bomId,
          line_no: values.line_no || nextLineNo,
          material_id: values.material_id || null,
          quantity: values.quantity ?? 0,
          unit: values.unit || null,
          loss_rate: values.loss_rate ?? 0,
          operation_id: values.operation_id || null,
          remark: values.remark || null,
          is_deleted: "n",
        };
        const { error } = await supabase.from(BOM_DETAIL_TABLE).insert([payload as any]);
        if (error) throw error;
        message.success(t("bomTree.msg.detailAdded"));
        setCreateModalOpen(false);
        await reloadTree(selectedNode.id);
        return;
      }

      if (createTarget === "bom" && selectedNode.type === "detail" && selectedNode.productId) {
        const product = products.find((item) => item.id === selectedNode.productId);
        if (!product) {
          message.warning(t("bomTree.msg.materialNotFound"));
          return;
        }
        const existedBom = await fetchBomByProductId(product.id);
        if (existedBom) {
          message.info(t("bomTree.msg.bomExistsLinked"));
          setCreateModalOpen(false);
          await reloadTree(selectedNode.id);
          return;
        }
        const bomPayload: Partial<BomRow> = {
          bom_no: values.bom_no || `${product.code || `BOM-${product.id}`}-AUTO`,
          product_id: values.product_id || product.id,
          version: values.version || "1.0",
          quantity: values.quantity ?? 1,
          unit: values.unit || productUnitText(product, uomMap) || null,
          is_default: values.is_default ?? false,
          is_active: values.is_active ?? true,
          effective_date: values.effective_date ? dayjs(values.effective_date).format("YYYY-MM-DD") : null,
          expiry_date: values.expiry_date ? dayjs(values.expiry_date).format("YYYY-MM-DD") : null,
          remark: values.remark || `Auto created from BOM tree`,
        };
        const { error: bomError } = await supabase.from(BOM_TABLE).insert([bomPayload as any]);
        if (bomError) throw bomError;
        message.success(t("bomTree.msg.nextBomAdded"));
        setCreateModalOpen(false);
        await reloadTree(selectedNode.id);
      }
    } catch (error) {
      console.error(error);
      message.error(t("bomTree.msg.createFailed"));
    }
  };

  if (!materialCode) return <Empty description={t("bomTree.empty.selectMaterial")} />;

  return (
    <>
    <Splitter style={{ height: "calc(100vh - 120px)", width: "100%" }}>
      <Splitter.Panel defaultSize="15%" min="260px">
        <Card size="small" title={t("bomTree.panel.header")} style={{ height: "100%", overflow: "auto" }}>
          <Form form={leftForm} layout="vertical">
            <Form.Item label={t("bomTree.field.bomNo")} name="bom_no"><Input /></Form.Item>
            <Form.Item label={t("bomTree.field.product")} name="product_id"><Select options={products.map((p) => ({ label: `${p.code} ${p.name}`, value: p.id }))} /></Form.Item>
            <Form.Item label={t("bomTree.field.version")} name="version"><Input /></Form.Item>
            <Form.Item label={t("bomTree.field.quantity")} name="quantity"><InputNumber style={{ width: "100%" }} /></Form.Item>
            <Form.Item label={t("bomTree.field.unit")} name="unit"><Select showSearch optionFilterProp="label" options={uomOptions} placeholder={t("bomTree.field.unitPrompt")} allowClear /></Form.Item>
            <Form.Item label={t("bomTree.field.remark")} name="remark"><Input.TextArea rows={4} /></Form.Item>
            <Button type="primary" block onClick={handleSaveSelected} disabled={!selectedNode || selectedNode.type !== "bom"}>{t("bomTree.action.saveHeader")}</Button>
          </Form>
        </Card>
      </Splitter.Panel>

      <Splitter.Panel defaultSize="70%" min="40%" style={{ overflow: "hidden" }}>
        <Spin spinning={loading}>
          <Card  title={title} style={{ height: "100%" }} styles={{ body: { padding: 0, height: "100%", overflow: "hidden" } }}
          extra={
          <Space>
              <Button type="primary" block onClick={handleSaveSelected} disabled={!selectedNode || selectedNode.type !== "detail"}>{t("common.save")}</Button>
              <Button block onClick={openCreateModal} disabled={!selectedNode}>{t("bomTree.action.addChild")}</Button></Space>
          }>
            <div ref={containerRef} style={{ width: "100%", height: "calc(100vh - 160px)", minHeight: 700 }} />
          </Card>
        </Spin>
      </Splitter.Panel>

      <Splitter.Panel defaultSize="15%" min="260px">
        <Card size="small" title={t("bomTree.panel.detail")} style={{ height: "100%", overflow: "auto" }}>
          <Form form={rightForm} layout="vertical">
            <Form.Item label={t("bomTree.field.lineNo")} name="line_no"><InputNumber style={{ width: "100%" }} /></Form.Item>
            <Form.Item label={t("bomTree.field.material")} name="material_id"><Select options={products.map((p) => ({ label: `${p.code} ${p.name}`, value: p.id }))} /></Form.Item>
            <Form.Item label={t("bomTree.field.quantity")} name="quantity"><InputNumber style={{ width: "100%" }} /></Form.Item>
            <Form.Item label={t("bomTree.field.unit")} name="unit"><Select showSearch optionFilterProp="label" options={uomOptions} placeholder={t("bomTree.field.unitPrompt")} allowClear /></Form.Item>
            <Form.Item label={t("bomTree.field.lossRate")} name="loss_rate"><InputNumber style={{ width: "100%" }} min={0} max={1} step={0.0001} /></Form.Item>
            <Form.Item label={t("bomTree.field.operation")} name="operation_id"><Select allowClear options={operations.map((o) => ({ label: o.name, value: o.id }))} /></Form.Item>
            <Form.Item label={t("bomTree.field.remark")} name="remark"><Input.TextArea rows={4} /></Form.Item>
            
            
          </Form>
        </Card>
      </Splitter.Panel>

      
    </Splitter>
    <Modal
        title={createTarget === "detail" ? t("bomTree.modal.addDetail") : t("bomTree.modal.addBom")}
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={handleCreateSubmit}
        okText={t("bomTree.modal.create")}
        cancelText={t("common.cancel")}
        destroyOnHidden
      >
        <Card size="small">
        <Form form={createForm} layout="vertical">
          {createTarget === "detail" ? (
            <>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.material")} name="material_id" rules={[{ required: true, message: t("bomTree.prompt.material") }]}>
                    <Select showSearch optionFilterProp="label" options={products.filter((p) => !selectedNode || p.id !== selectedNode.productId).map((p) => ({ label: `${p.code} ${p.name}`, value: p.id }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.lineNo")} name="line_no">
                    <InputNumber style={{ width: "100%" }} min={1} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.quantity")} name="quantity" rules={[{ required: true, message: t("bomTree.prompt.quantity") }]}>
                    <InputNumber style={{ width: "100%" }} min={0} step={0.000001} precision={6} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.unit")} name="unit">
                    <Select showSearch optionFilterProp="label" options={uomOptions} placeholder={t("bomTree.field.unitPrompt")} allowClear />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.lossRate")} name="loss_rate">
                    <InputNumber style={{ width: "100%" }} min={0} max={1} step={0.0001} precision={4} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.operation")} name="operation_id">
                    <Select allowClear showSearch optionFilterProp="label" options={operations.map((o) => ({ label: o.name, value: o.id }))} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item label={t("bomTree.field.remark")} name="remark">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </Col>
              </Row>
            </>
          ) : (
            <>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.bomNo")} name="bom_no" rules={[{ required: true, message: t("bomTree.prompt.bomNo") }]}>
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.product")} name="product_id" rules={[{ required: true, message: t("bomTree.prompt.product") }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={products.filter((p) => !selectedNode || p.id !== selectedNode.productId).map((p) => ({ label: `${p.code} ${p.name}`, value: p.id }))}
                      onChange={(val) => {
                        const p = products.find((p) => p.id === val);
                        if (p) createForm.setFieldsValue({ bom_no: p.code });
                      }}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.version")} name="version">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.quantity")} name="quantity">
                    <InputNumber style={{ width: "100%" }} min={0} step={0.000001} precision={6} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.unit")} name="unit">
                    <Select showSearch optionFilterProp="label" options={uomOptions} placeholder={t("bomTree.field.unitPrompt")} allowClear />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label={t("common.enabled")} name="is_active" valuePropName="checked">
                    <Checkbox />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label={t("bomTree.field.defaultBom")} name="is_default" valuePropName="checked">
                    <Checkbox />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.effectiveDate")} name="effective_date">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t("bomTree.field.expiryDate")} name="expiry_date">
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                
              </Row>
              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item label={t("bomTree.field.remark")} name="remark">
                    <Input.TextArea rows={3} />
                  </Form.Item>
                </Col>
              </Row>
            </>
          )}
        </Form>
        </Card>
      </Modal>
    </>
  );
}








