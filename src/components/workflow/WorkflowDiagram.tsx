import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Empty } from 'antd';
import { Graph } from '@antv/x6';

type WorkflowDiagramNode = {
  node_key: string;
  node_name: string;
  sequence_no: number;
  approver_mode: string;
  approver_role_code: string | null;
  allow_reject: boolean;
  allow_withdraw: boolean;
  is_start_node: boolean;
  is_end_node: boolean;
};

type WorkflowDiagramProps = {
  nodes: WorkflowDiagramNode[];
};

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;
const NODE_GAP = 54;
let shapeRegistered = false;

const ensureShapeRegistered = () => {
  if (shapeRegistered) return;

  Graph.registerNode(
    'workflow-dag-node',
    {
      inherit: 'rect',
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'text', selector: 'label' },
        { tagName: 'text', selector: 'subLabel' },
        { tagName: 'circle', selector: 'statusDot' },
      ],
      attrs: {
        body: {
          rx: 10,
          ry: 10,
          strokeWidth: 2,
          fill: '#fff',
        },
        label: {
          refX: 18,
          refY: 22,
          fontSize: 14,
          fontWeight: 600,
          fill: '#1f1f1f',
          textAnchor: 'start',
          textVerticalAnchor: 'middle',
        },
        subLabel: {
          refX: 18,
          refY: 48,
          fontSize: 12,
          fill: '#666',
          textAnchor: 'start',
          textVerticalAnchor: 'middle',
        },
        statusDot: {
          refX: NODE_WIDTH - 20,
          refY: 22,
          r: 5,
          fill: '#d9d9d9',
          stroke: 'none',
        },
      },
      ports: {
        groups: {
          top: {
            position: 'top',
            attrs: {
              circle: {
                r: 5,
                magnet: true,
                stroke: '#91a4b7',
                strokeWidth: 1,
                fill: '#fff',
              },
            },
          },
          bottom: {
            position: 'bottom',
            attrs: {
              circle: {
                r: 5,
                magnet: true,
                stroke: '#91a4b7',
                strokeWidth: 1,
                fill: '#fff',
              },
            },
          },
        },
      },
    },
    true,
  );

  Graph.registerEdge(
    'workflow-dag-edge',
    {
      inherit: 'edge',
      attrs: {
        line: {
          stroke: '#91a4b7',
          strokeWidth: 2,
          targetMarker: {
            name: 'block',
            width: 10,
            height: 10,
          },
        },
      },
    },
    true,
  );

  shapeRegistered = true;
};

export function WorkflowDiagram({ nodes }: WorkflowDiagramProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureShapeRegistered();

    const container = containerRef.current;
    const orderedNodes = [...nodes].sort((a, b) => Number(a.sequence_no) - Number(b.sequence_no));

    graphRef.current?.dispose();
    graphRef.current = null;

    if (!orderedNodes.length) return;

    const width = container.clientWidth || 900;
    const height = Math.max(260, orderedNodes.length * (NODE_HEIGHT + NODE_GAP) + 40);
    const startX = Math.max(24, Math.floor((width - NODE_WIDTH) / 2));

    const graph = new Graph({
      container,
      width,
      height,
      grid: {
        size: 10,
        visible: true,
        type: 'mesh',
        args: { color: '#eef2f6', thickness: 1 },
      },
      background: { color: '#fafafa' },
      interacting: false,
      panning: false,
      mousewheel: false,
    });

    graphRef.current = graph;

    orderedNodes.forEach((node, index) => {
      const status = node.is_start_node ? 'running' : node.is_end_node ? 'success' : 'default';
      const displayLabel = node.is_start_node
        ? t('workflow.flow.startPrefix') + node.node_name
        : node.is_end_node
          ? t('workflow.flow.endPrefix') + node.node_name
          : node.node_name;
      const subLabel = node.approver_role_code ? t('workflow.flow.rolePrefix') + node.approver_role_code : t('workflow.flow.roleUnassigned');
      const y = 30 + index * (NODE_HEIGHT + NODE_GAP);

      graph.addNode({
        id: node.node_key,
        shape: 'workflow-dag-node',
        x: startX,
        y,
        attrs: {
          body: {
            stroke: status === 'running' ? '#1677ff' : status === 'success' ? '#52c41a' : '#d9d9d9',
          },
          label: {
            text: displayLabel,
          },
          subLabel: {
            text: subLabel,
          },
          statusDot: {
            fill: status === 'running' ? '#1677ff' : status === 'success' ? '#52c41a' : '#d9d9d9',
          },
        },
        ports: [
          { id: `${node.node_key}-top`, group: 'top' },
          { id: `${node.node_key}-bottom`, group: 'bottom' },
        ],
      });

      if (index > 0) {
        const prev = orderedNodes[index - 1];
        graph.addEdge({
          shape: 'workflow-dag-edge',
          source: { cell: prev.node_key, port: `${prev.node_key}-bottom` },
          target: { cell: node.node_key, port: `${node.node_key}-top` },
        });
      }
    });

    graph.centerContent();

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, [nodes]);

  return (
    <>
      {nodes.length ? <div ref={containerRef} style={{ width: '100%', minHeight: 260 }} /> : <Empty description={t('workflow.flow.empty')} />}
    </>
  );
}
