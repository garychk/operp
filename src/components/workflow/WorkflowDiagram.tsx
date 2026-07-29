import { useEffect, useMemo, useRef } from 'react';
import { Empty } from 'antd';
import { useTranslation } from 'react-i18next';
import { Graph } from '@antv/x6';

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

type WorkflowDiagramProps = {
  nodes: WorkflowNodeItem[];
  selectedKey?: string;
  onSelectNode?: (key: string) => void;
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

type DiagramEdge = {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  kind: 'default' | 'true' | 'false';
  label: string;
};

const NODE_WIDTH = 252;
const NODE_HEIGHT = 84;
const COLUMN_GAP = 220;
const ROW_GAP = 92;
let shapeRegistered = false;

const ensureShapeRegistered = () => {
  if (shapeRegistered) return;

  Graph.registerNode(
    'workflow-branch-node',
    {
      inherit: 'rect',
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
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
    },
    true,
  );

  Graph.registerEdge(
    'workflow-branch-edge',
    {
      inherit: 'edge',
      attrs: { line: { stroke: '#91a4b7', strokeWidth: 2, targetMarker: { name: 'block', width: 10, height: 10 } } },
      router: { name: 'manhattan' },
    },
    true,
  );

  shapeRegistered = true;
};

export function WorkflowDiagram({ nodes, selectedKey, onSelectNode, height }: WorkflowDiagramProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  const model = useMemo(() => buildGraphModel(nodes), [nodes]);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureShapeRegistered();

    const container = containerRef.current;
    graphRef.current?.dispose();
    graphRef.current = null;

    if (!model.nodes.length) return;

    const graph = new Graph({
      container,
      width: container.clientWidth || 900,
      height: typeof height === 'number' ? height : container.clientHeight || Math.max(320, model.height),
      grid: { size: 10, visible: true, type: 'mesh', args: { color: '#eef2f6', thickness: 1 } },
      background: { color: '#fafafa' },
      interacting: { nodeMovable: true, edgeMovable: false, vertexMovable: false },
      panning: { enabled: true, eventTypes: ['rightMouseDown', 'mouseWheel'] },
      mousewheel: { enabled: true, modifiers: 'ctrl', factor: 1.1, minScale: 0.5, maxScale: 1.5 },
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

    model.edges.forEach((edge: DiagramEdge) => {
      graph.addEdge({
        shape: 'workflow-branch-edge',
        source: { cell: edge.source, port: edge.sourcePort },
        target: { cell: edge.target, port: edge.targetPort },
        attrs: { line: { stroke: edge.kind === 'default' ? '#91a4b7' : edge.kind === 'true' ? '#1677ff' : '#f59e0b', strokeDasharray: edge.kind === 'default' ? '0' : '6 4' } },
        labels: edge.label ? [{ attrs: { text: { text: edge.label, fill: '#475467', fontSize: 11, fontWeight: 500 }, rect: { fill: '#fff', stroke: 'none' } } }] : [],
      });
    });

    graph.centerContent();
    graph.on('node:click', ({ node }) => onSelectNode?.(String(node.id)));

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, [model, onSelectNode, selectedKey]);

  return nodes.length ? <div ref={containerRef} style={{ width: '100%', height: height ?? '100%' }} /> : <Empty description={t('workflow.flow.empty')} />;
}

function buildGraphModel(nodes: WorkflowNodeItem[]) {
  const ordered = [...nodes].sort((a, b) => Number(a.sequence_no) - Number(b.sequence_no));
  let maxRow = 0;
  const graphNodes: DiagramNode[] = ordered.map((node, index) => {
    const kind = node.node_type;
    const column = kind === 'condition' ? 1 : kind === 'end' ? 2 : 0;
    const row = kind === 'condition' ? 0 : index;
    maxRow = Math.max(maxRow, row);
    return {
      key: node.node_key,
      kind,
      x: 40 + column * COLUMN_GAP,
      y: 24 + row * ROW_GAP,
      title: node.node_name,
      subtitle: kind === 'condition'
        ? String(node.rule_json?.expr || '条件分支')
        : node.approver_role_code
          ? `角色: ${node.approver_role_code}`
          : node.is_start_node
            ? '起始节点'
            : node.is_end_node
              ? '结束节点'
              : '审批节点',
      tag: node.node_type.toUpperCase(),
    };
  });

  const edges: DiagramEdge[] = ordered.flatMap((node, index) => {
    const next = ordered[index + 1];
    if (node.node_type === 'condition') {
      const rule = node.rule_json || {};
      const trueTargetKey = String(rule.trueTargetKey || '');
      const falseTargetKey = String(rule.falseTargetKey || '');
      return [
        trueTargetKey ? { source: node.node_key, sourcePort: `${node.node_key}-right`, target: trueTargetKey, targetPort: `${trueTargetKey}-left`, kind: 'true', label: '是' } : null,
        falseTargetKey ? { source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: falseTargetKey, targetPort: `${falseTargetKey}-left`, kind: 'false', label: '否' } : null,
      ].filter((item): item is DiagramEdge => Boolean(item));
    }
    if (!next) return [];
    return [{ source: node.node_key, sourcePort: `${node.node_key}-bottom`, target: next.node_key, targetPort: `${next.node_key}-top`, kind: 'default', label: '' }];
  });

  return { nodes: graphNodes, edges, height: 24 + (maxRow + 1) * ROW_GAP + 100 };
}
