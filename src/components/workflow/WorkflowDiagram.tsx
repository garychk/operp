import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from 'antd';
import { useTranslation } from 'react-i18next';
import { Edge, Graph } from '@antv/x6';

export type WorkflowNodeItem = {
  node_key: string;
  node_name: string;
  node_type: 'start' | 'condition' | 'approval' | 'end';
  sequence_no: number;
  approver_mode: string;
  approver_role_code: string | null;
  allow_reject: boolean;
  allow_withdraw: boolean;
  is_start_node: boolean;
  is_end_node: boolean;
  rule_json: Record<string, unknown>;
};

export type WorkflowEdgeItem = {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  kind: 'default' | 'condition' | 'true' | 'false';
  label?: string;
  condition?: string;
  lineStyle?: 'solid' | 'dashed';
  color?: '#1677ff' | '#f59e0b' | '#91a4b7';
};

type WorkflowDiagramProps = {
  nodes: WorkflowNodeItem[];
  edges: WorkflowEdgeItem[];
  selectedKey?: string;
  selectedEdgeId?: string;
  onSelectNode?: (key: string) => void;
  onSelectEdge?: (edgeId: string | null) => void;
  onNodeMove?: (key: string, position: { x: number; y: number }) => void;
  onEdgeChange?: (edges: WorkflowEdgeItem[]) => void;
  height?: string | number;
};

type DiagramNode = {
  key: string;
  kind: WorkflowNodeItem['node_type'];
  x: number;
  y: number;
  title: string;
  subtitle: string;
  tag: string;
};

const NODE_WIDTH = 252;
const COLUMN_GAP = 220;
const ROW_GAP = 92;

/** ProLayout 把暗色开关写在 <html data-erp-dark> 上；X6 画布（背景 / 网格 / 节点 / 连线）
 *  的颜色在 JS 里画，拿不到 antd 主题，需要自己跟随它切换。 */
function useIsDarkTheme() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-erp-dark') === 'true',
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.getAttribute('data-erp-dark') === 'true');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-erp-dark'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

/** 画布明暗两套取色：X6 的背景 / 网格 / 节点 / 连线颜色只能走 JS，没法靠 CSS 继承 */
const WORKFLOW_CANVAS_COLORS = {
  light: {
    background: '#fafafa',
    grid: '#eef2f6',
    nodeFill: '#fff',
    nodeFillCondition: '#fff7e6',
    nodeStroke: '#d9d9d9',
    nodeStrokeSelected: '#1677ff',
    nodeStrokeCondition: '#fa8c16',
    nodeStrokeStart: '#52c41a',
    nodeStrokeEnd: '#722ed1',
    title: '#1f1f1f',
    subtitle: '#667085',
    tag: '#5b6b7d',
    portStroke: '#91a4b7',
    portFill: '#fff',
    edgeStroke: '#91a4b7',
    labelText: '#475467',
    labelBg: '#ffffff',
  },
  dark: {
    background: '#141414',
    grid: 'rgba(255, 255, 255, 0.10)',
    nodeFill: 'rgba(255, 255, 255, 0.06)',
    nodeFillCondition: 'rgba(250, 140, 22, 0.16)',
    nodeStroke: 'rgba(255, 255, 255, 0.25)',
    nodeStrokeSelected: '#4096ff',
    nodeStrokeCondition: '#ffa940',
    nodeStrokeStart: '#73d13d',
    nodeStrokeEnd: '#9254de',
    title: '#e6e6e6',
    subtitle: '#a6adb8',
    tag: '#a6adb8',
    portStroke: '#8c8c8c',
    portFill: '#1f1f1f',
    edgeStroke: '#8c8c8c',
    labelText: '#d9d9d9',
    labelBg: '#1f1f1f',
  },
} as const;

type WorkflowCanvasTheme = keyof typeof WORKFLOW_CANVAS_COLORS;

let shapeRegisteredTheme: WorkflowCanvasTheme | null = null;
/** 明暗主题各注册一次（force 覆盖）：节点主色由 addNode 的 attrs 覆盖，但标题 / 副标题 /
 *  标签 / 端口走注册默认值，所以必须按主题重注册，否则切暗色后文字还是深色看不见。 */
const ensureShapeRegistered = (theme: WorkflowCanvasTheme, colors: (typeof WORKFLOW_CANVAS_COLORS)[WorkflowCanvasTheme]) => {
  if (shapeRegisteredTheme === theme) return;
  const portAttrs = { circle: { r: 5, magnet: true, stroke: colors.portStroke, strokeWidth: 1, fill: colors.portFill } };
  Graph.registerNode('workflow-branch-node', {
    inherit: 'rect',
    width: NODE_WIDTH,
    height: 84,
    markup: [
      { tagName: 'rect', selector: 'body' },
      { tagName: 'text', selector: 'title' },
      { tagName: 'text', selector: 'subtitle' },
      { tagName: 'text', selector: 'tag' },
    ],
    attrs: {
      body: { rx: 12, ry: 12, strokeWidth: 2, fill: colors.nodeFill },
      title: { refX: 16, refY: 24, fontSize: 14, fontWeight: 600, fill: colors.title, textAnchor: 'start', textVerticalAnchor: 'middle' },
      subtitle: { refX: 16, refY: 50, fontSize: 12, fill: colors.subtitle, textAnchor: 'start', textVerticalAnchor: 'middle' },
      tag: { refX: NODE_WIDTH - 14, refY: 18, fontSize: 11, fill: colors.tag, textAnchor: 'end', textVerticalAnchor: 'middle' },
    },
    ports: {
      groups: {
        top: { position: 'top', attrs: portAttrs },
        bottom: { position: 'bottom', attrs: portAttrs },
        left: { position: 'left', attrs: portAttrs },
        right: { position: 'right', attrs: portAttrs },
      },
    },
  }, true);
  Graph.registerEdge('workflow-branch-edge', {
    inherit: 'edge',
    attrs: { line: { stroke: colors.edgeStroke, strokeWidth: 2, targetMarker: { name: 'block', width: 10, height: 10 } } },
    router: { name: 'manhattan' },
    connector: { name: 'rounded' },
  }, true);
  shapeRegisteredTheme = theme;
};

export function WorkflowDiagram({ nodes, edges, selectedKey, selectedEdgeId, onSelectNode, onSelectEdge, onNodeMove, onEdgeChange, height }: WorkflowDiagramProps) {
  const { t } = useTranslation();
  const isDark = useIsDarkTheme();
  const canvasColors = useMemo(
    () => (isDark ? WORKFLOW_CANVAS_COLORS.dark : WORKFLOW_CANVAS_COLORS.light),
    [isDark],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const model = useMemo(() => buildGraphModel(nodes, edges), [nodes, edges]);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureShapeRegistered(isDark ? 'dark' : 'light', canvasColors);
    graphRef.current?.dispose();
    graphRef.current = null;
    if (!model.nodes.length) return;

    let graph: Graph;
    graph = new Graph({
      container: containerRef.current,
      width: containerRef.current.clientWidth || 900,
      height: typeof height === 'number' ? Math.max(containerRef.current.clientHeight || 0, height) : containerRef.current.clientHeight || Math.max(320, model.height),
      grid: { size: 10, visible: true, type: 'mesh', args: { color: canvasColors.grid, thickness: 1 } },
      background: { color: canvasColors.background },
      interacting: { nodeMovable: true, edgeMovable: true, vertexMovable: true, arrowheadMovable: false },
      // 平移画布：左键拖空白区、右键拖、滚轮（不按 ctrl 时滚轮＝平移，ctrl+滚轮＝缩放）。
      // 原来只开了 rightMouseDown + mouseWheel，左键在空白处拖拽完全没反应。
      // x6 的平移只在 blank:mousedown / node:unhandled:mousedown 上启动，所以节点
      // 拖动与端口拉线不受影响（与 BOM 结构画布同款改法，已实测）。
      panning: { enabled: true, eventTypes: ['leftMouseDown', 'rightMouseDown', 'mouseWheel'] },
      mousewheel: { enabled: true, modifiers: 'ctrl', factor: 1.1, minScale: 0.5, maxScale: 1.5 },
      connecting: {
        allowMulti: false,
        allowBlank: false,
        allowLoop: false,
        snap: true,
        highlight: true,
        connectionPoint: 'anchor',
        createEdge: (): Edge => graph.createEdge({ shape: 'workflow-branch-edge' }),
        validateConnection: ({ sourceCell, targetCell }) => Boolean(sourceCell && targetCell && sourceCell.id !== targetCell.id),
      },
    });

    graphRef.current = graph;

    model.nodes.forEach((node) => {
      graph.addNode({
        id: node.key,
        shape: 'workflow-branch-node',
        x: node.x,
        y: node.y,
        ports: [
          { id: `${node.key}-top`, group: 'top' },
          { id: `${node.key}-bottom`, group: 'bottom' },
          { id: `${node.key}-left`, group: 'left' },
          { id: `${node.key}-right`, group: 'right' },
        ],
        attrs: {
          body: {
            stroke: node.key === selectedKey ? canvasColors.nodeStrokeSelected : node.kind === 'condition' ? canvasColors.nodeStrokeCondition : node.kind === 'start' ? canvasColors.nodeStrokeStart : node.kind === 'end' ? canvasColors.nodeStrokeEnd : canvasColors.nodeStroke,
            fill: node.kind === 'condition' ? canvasColors.nodeFillCondition : canvasColors.nodeFill,
          },
          title: { text: node.title, fill: canvasColors.title },
          subtitle: { text: node.subtitle, fill: canvasColors.subtitle },
          tag: { text: node.tag, fill: canvasColors.tag },
        },
      });
    });

    model.edges.forEach((edge: WorkflowEdgeItem) => {
      graph.addEdge({
        id: edge.id,
        shape: 'workflow-branch-edge',
        source: { cell: edge.source, port: edge.sourcePort || `${edge.source}-bottom` },
        target: { cell: edge.target, port: edge.targetPort || `${edge.target}-top` },
        data: edge,
        attrs: { line: { stroke: edge.color || (edge.kind === 'default' ? canvasColors.edgeStroke : edge.kind === 'false' ? '#f59e0b' : '#1677ff'), strokeWidth: selectedEdgeId === edge.id ? 3 : 2, strokeDasharray: edge.lineStyle === 'dashed' || (!edge.lineStyle && edge.kind !== 'default') ? '6 4' : '0' } },
        labels: edge.label ? [{ attrs: { text: { text: edge.label, fill: canvasColors.labelText, fontSize: 11, fontWeight: 500 }, rect: { fill: canvasColors.labelBg, stroke: 'none' } } }] : [],
      });
    });

    graph.centerContent();
    graph.on('node:click', ({ node }: { node: any }) => onSelectNode?.(String(node.id)));
    graph.on('edge:click', ({ edge }: { edge: Edge }) => onSelectEdge?.(String(edge.id)));
    graph.on('blank:click', () => onSelectEdge?.(null));
    graph.on('node:mouseup', ({ node }: { node: any }) => onNodeMove?.(String(node.id), { x: node.position().x, y: node.position().y }));
    graph.on('edge:connected', () => onEdgeChange?.((graph.getEdges() as Edge[]).map((item: Edge) => toEdgeItem(item))));
    graph.on('edge:removed', () => onEdgeChange?.((graph.getEdges() as Edge[]).map((item: Edge) => toEdgeItem(item))));

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, [model, onSelectEdge, onSelectNode, onNodeMove, onEdgeChange, selectedEdgeId, selectedKey, height, canvasColors]);

  return nodes.length ? <div ref={containerRef} style={{ width: '100%', height: '100%' }} /> : <Empty description={t('workflow.flow.empty')} />;
}

function buildGraphModel(nodes: WorkflowNodeItem[], edges: WorkflowEdgeItem[]) {
  const ordered = [...nodes].sort((a, b) => Number(a.sequence_no) - Number(b.sequence_no));
  let maxRow = 0;
  const graphNodes: DiagramNode[] = ordered.map((node, index) => {
    const kind = node.node_type;
    const column = kind === 'condition' ? 1 : kind === 'end' ? 2 : 0;
    const row = kind === 'condition' ? 0 : index;
    const layout = getNodeLayout(node.rule_json);
    maxRow = Math.max(maxRow, row);
    return {
      key: node.node_key,
      kind,
      x: layout?.x ?? 40 + column * COLUMN_GAP,
      y: layout?.y ?? 24 + row * ROW_GAP,
      title: node.node_name,
      subtitle: kind === 'condition' ? getConditionSummary(node.rule_json) : node.approver_role_code ? `角色: ${node.approver_role_code}` : node.is_start_node ? '起始节点' : node.is_end_node ? '结束节点' : '审批节点',
      tag: node.node_type.toUpperCase(),
    };
  });

  const edgeList: WorkflowEdgeItem[] = edges.length ? edges : ordered.flatMap<WorkflowEdgeItem>((node, index) => {
    const next = ordered[index + 1];
    if (node.node_type === 'condition') {
      const rule = node.rule_json || {};
      const trueTargetKey = String(rule.trueTargetKey || '');
      const falseTargetKey = String(rule.falseTargetKey || '');
      return [
        trueTargetKey ? { id: `${node.node_key}-true-${trueTargetKey}`, source: node.node_key, sourcePort: `${node.node_key}-right`, target: trueTargetKey, targetPort: `${trueTargetKey}-left`, kind: 'condition' as const, label: String(rule.conditionLabel || '条件成立'), condition: String(rule.expr || '') } : null,
        falseTargetKey ? { id: `${node.node_key}-false-${falseTargetKey}`, source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: falseTargetKey, targetPort: `${falseTargetKey}-left`, kind: 'default' as const, label: '其他情况' } : null,
      ].filter(Boolean) as WorkflowEdgeItem[];
    }
    if (!next) return [];
    return [{ id: `${node.node_key}-to-${next.node_key}`, source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: next.node_key, targetPort: `${next.node_key}-top`, kind: 'default' as const, label: '' }];
  });

  return { nodes: graphNodes, edges: edgeList, height: 24 + (maxRow + 1) * ROW_GAP + 140 };
}

function getConditionSummary(ruleJson: Record<string, unknown>) {
  const explicitLabel = String(ruleJson.conditionLabel || '').trim();
  if (explicitLabel) return explicitLabel;
  const expression = ruleJson.expr;
  if (typeof expression === 'string') {
    try {
      const parsed = JSON.parse(expression) as { logic?: string; conditions?: Array<{ field?: string; operator?: string; value?: string }> };
      if (Array.isArray(parsed.conditions)) {
        const joiner = parsed.logic === 'or' ? ' 或 ' : ' 且 ';
        const parts = parsed.conditions.filter((item) => item.field).map((item) => `${item.field} ${item.operator || '='}${item.value ? ` ${item.value}` : ''}`);
        if (parts.length) return parts.join(joiner);
      }
    } catch {
      return expression;
    }
    return expression;
  }
  return '条件分支';
}
function getNodeLayout(ruleJson: Record<string, unknown>) {
  const layout = ruleJson.layout;
  if (!layout || typeof layout !== 'object') return null;
  const x = Number((layout as Record<string, unknown>).x);
  const y = Number((layout as Record<string, unknown>).y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}

function toEdgeItem(edge: any): WorkflowEdgeItem {
  const source = String(edge.getSourceCellId?.() || edge.getSource?.().cell || '');
  const target = String(edge.getTargetCellId?.() || edge.getTarget?.().cell || '');
  const label = String(edge.getLabels?.()?.[0]?.attrs?.text?.text || edge.getData?.()?.label || '');
  const data = (edge.getData?.() || {}) as Partial<WorkflowEdgeItem>;
  return {
    id: String(edge.id),
    source,
    target,
    sourcePort: edge.getSourcePortId?.() || edge.getSource?.().port || undefined,
    targetPort: edge.getTargetPortId?.() || edge.getTarget?.().port || undefined,
    kind: data.kind || (label === '是' ? 'true' : label === '否' ? 'false' : 'default'),
    label,
    condition: data.condition,
    lineStyle: data.lineStyle,
    color: data.color,
  };
}
