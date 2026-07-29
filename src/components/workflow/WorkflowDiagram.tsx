import { useEffect, useMemo, useRef } from 'react';
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
  kind: 'default' | 'true' | 'false';
  label?: string;
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
let shapeRegistered = false;

const ensureShapeRegistered = () => {
  if (shapeRegistered) return;
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
      body: { rx: 12, ry: 12, strokeWidth: 2, fill: '#fff' },
      title: { refX: 16, refY: 24, fontSize: 14, fontWeight: 600, fill: '#1f1f1f', textAnchor: 'start', textVerticalAnchor: 'middle' },
      subtitle: { refX: 16, refY: 50, fontSize: 12, fill: '#667085', textAnchor: 'start', textVerticalAnchor: 'middle' },
      tag: { refX: NODE_WIDTH - 14, refY: 18, fontSize: 11, fill: '#5b6b7d', textAnchor: 'end', textVerticalAnchor: 'middle' },
    },
    ports: {
      groups: {
        top: { position: 'top', attrs: { circle: { r: 5, magnet: true, stroke: '#91a4b7', strokeWidth: 1, fill: '#fff' } } },
        bottom: { position: 'bottom', attrs: { circle: { r: 5, magnet: true, stroke: '#91a4b7', strokeWidth: 1, fill: '#fff' } } },
        left: { position: 'left', attrs: { circle: { r: 5, magnet: true, stroke: '#91a4b7', strokeWidth: 1, fill: '#fff' } } },
        right: { position: 'right', attrs: { circle: { r: 5, magnet: true, stroke: '#91a4b7', strokeWidth: 1, fill: '#fff' } } },
      },
    },
  }, true);
  Graph.registerEdge('workflow-branch-edge', {
    inherit: 'edge',
    attrs: { line: { stroke: '#91a4b7', strokeWidth: 2, targetMarker: { name: 'block', width: 10, height: 10 } } },
    router: { name: 'manhattan' },
    connector: { name: 'rounded' },
  }, true);
  shapeRegistered = true;
};

export function WorkflowDiagram({ nodes, edges, selectedKey, selectedEdgeId, onSelectNode, onSelectEdge, onNodeMove, onEdgeChange, height }: WorkflowDiagramProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const model = useMemo(() => buildGraphModel(nodes, edges), [nodes, edges]);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureShapeRegistered();
    graphRef.current?.dispose();
    graphRef.current = null;
    if (!model.nodes.length) return;

    let graph: Graph;
    graph = new Graph({
      container: containerRef.current,
      width: containerRef.current.clientWidth || 900,
      height: typeof height === 'number' ? height : containerRef.current.clientHeight || Math.max(320, model.height),
      grid: { size: 10, visible: true, type: 'mesh', args: { color: '#eef2f6', thickness: 1 } },
      background: { color: '#fafafa' },
      interacting: { nodeMovable: true, edgeMovable: true, vertexMovable: true, arrowheadMovable: false },
      panning: { enabled: true, eventTypes: ['rightMouseDown', 'mouseWheel'] },
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
            stroke: node.key === selectedKey ? '#1677ff' : node.kind === 'condition' ? '#fa8c16' : node.kind === 'start' ? '#52c41a' : node.kind === 'end' ? '#722ed1' : '#d9d9d9',
            fill: node.kind === 'condition' ? '#fff7e6' : '#fff',
          },
          title: { text: node.title },
          subtitle: { text: node.subtitle },
          tag: { text: node.tag },
        },
      });
    });

    model.edges.forEach((edge: WorkflowEdgeItem) => {
      graph.addEdge({
        id: edge.id,
        shape: 'workflow-branch-edge',
        source: { cell: edge.source, port: edge.sourcePort || `${edge.source}-bottom` },
        target: { cell: edge.target, port: edge.targetPort || `${edge.target}-top` },
        attrs: { line: { stroke: edge.color || (edge.kind === 'default' ? '#91a4b7' : edge.kind === 'true' ? '#1677ff' : '#f59e0b'), strokeWidth: selectedEdgeId === edge.id ? 3 : 2, strokeDasharray: edge.lineStyle === 'dashed' || (!edge.lineStyle && edge.kind !== 'default') ? '6 4' : '0' } },
        labels: edge.label ? [{ attrs: { text: { text: edge.label, fill: '#475467', fontSize: 11, fontWeight: 500 }, rect: { fill: '#fff', stroke: 'none' } } }] : [],
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
  }, [model, onSelectEdge, onSelectNode, onNodeMove, onEdgeChange, selectedEdgeId, selectedKey, height]);

  return nodes.length ? <div ref={containerRef} style={{ width: '100%', height: height ?? '100%' }} /> : <Empty description={t('workflow.flow.empty')} />;
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
      subtitle: kind === 'condition' ? String(node.rule_json?.expr || '条件分支') : node.approver_role_code ? `角色: ${node.approver_role_code}` : node.is_start_node ? '起始节点' : node.is_end_node ? '结束节点' : '审批节点',
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
        trueTargetKey ? { id: `${node.node_key}-true-${trueTargetKey}`, source: node.node_key, sourcePort: `${node.node_key}-right`, target: trueTargetKey, targetPort: `${trueTargetKey}-left`, kind: 'true' as const, label: '是' } : null,
        falseTargetKey ? { id: `${node.node_key}-false-${falseTargetKey}`, source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: falseTargetKey, targetPort: `${falseTargetKey}-left`, kind: 'false' as const, label: '否' } : null,
      ].filter(Boolean) as WorkflowEdgeItem[];
    }
    if (!next) return [];
    return [{ id: `${node.node_key}-to-${next.node_key}`, source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: next.node_key, targetPort: `${next.node_key}-top`, kind: 'default' as const, label: '' }];
  });

  return { nodes: graphNodes, edges: edgeList, height: 24 + (maxRow + 1) * ROW_GAP + 140 };
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
  return {
    id: String(edge.id),
    source,
    target,
    sourcePort: edge.getSourcePortId?.() || edge.getSource?.().port || undefined,
    targetPort: edge.getTargetPortId?.() || edge.getTarget?.().port || undefined,
    kind: label === '是' ? 'true' : label === '否' ? 'false' : 'default',
    label,
  };
}
