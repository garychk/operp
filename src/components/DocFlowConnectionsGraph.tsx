import { useEffect, useRef } from "react";
import { Graph } from "@antv/x6";
import { Empty, Spin } from "antd";
import { useTranslation } from "react-i18next";

export interface DocFlowConnectionItem {
  document_type: string;
  document_id: number;
  document_no: string;
  document_name: string;
  quantity: number;
  lines: number;
}

export interface DocFlowConnectionsData {
  current: {
    document_type: string;
    document_id: number;
    document_no: string;
    document_name: string;
  } | null;
  upstream: DocFlowConnectionItem[];
  downstream: DocFlowConnectionItem[];
}

interface DocFlowConnectionsGraphProps {
  data: DocFlowConnectionsData | null;
  loading?: boolean;
  height?: number;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 280;
const ROW_GAP = 92;

const TONE = {
  current: { stroke: "#1677ff", fill: "#f0f7ff", text: "#1677ff" },
  upstream: { stroke: "#52c41a", fill: "#f6ffed", text: "#389e0d" },
  downstream: { stroke: "#fa8c16", fill: "#fff7e6", text: "#d46b08" },
};

let shapeRegistered = false;

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

// Same node shape and interaction model as WorkflowDiagram: title / subtitle /
// tag, ports on all four sides, draggable with panning and ctrl+wheel zoom.
const ensureShapeRegistered = () => {
  if (shapeRegistered) return;
  Graph.registerNode(
    "doc-flow-link-node",
    {
      inherit: "rect",
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      markup: [
        { tagName: "rect", selector: "body" },
        { tagName: "text", selector: "title" },
        { tagName: "text", selector: "subtitle" },
        { tagName: "text", selector: "tag" },
      ],
      attrs: {
        body: {
          rx: 10,
          ry: 10,
          strokeWidth: 2,
          fill: "#fff",
          stroke: "#d9d9d9",
        },
        title: {
          refX: 14,
          refY: 24,
          fontSize: 14,
          fontWeight: 600,
          fill: "#1f1f1f",
          textAnchor: "start",
          textVerticalAnchor: "middle",
        },
        subtitle: {
          refX: 14,
          refY: 48,
          fontSize: 12,
          fill: "#667085",
          textAnchor: "start",
          textVerticalAnchor: "middle",
        },
        tag: {
          refX: NODE_WIDTH - 14,
          refY: 24,
          fontSize: 11,
          fill: "#5b6b7d",
          textAnchor: "end",
          textVerticalAnchor: "middle",
        },
      },
      ports: {
        groups: {
          left: {
            position: "left",
            attrs: { circle: { r: 4, magnet: true, stroke: "#91a4b7", strokeWidth: 1, fill: "#fff" } },
          },
          right: {
            position: "right",
            attrs: { circle: { r: 4, magnet: true, stroke: "#91a4b7", strokeWidth: 1, fill: "#fff" } },
          },
        },
      },
    },
    true,
  );
  Graph.registerEdge(
    "doc-flow-link-edge",
    {
      inherit: "edge",
      attrs: {
        line: {
          stroke: "#91a4b7",
          strokeWidth: 2,
          targetMarker: { name: "block", width: 10, height: 10 },
        },
      },
      router: { name: "manhattan" },
      connector: { name: "rounded" },
    },
    true,
  );
  shapeRegistered = true;
};

export function DocFlowConnectionsGraph({
  data,
  loading,
  height = 340,
}: DocFlowConnectionsGraphProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data?.current) return;
    ensureShapeRegistered();

    graphRef.current?.dispose();
    graphRef.current = null;

    const upstream = data.upstream ?? [];
    const downstream = data.downstream ?? [];
    const rows = Math.max(upstream.length, downstream.length, 1);
    const canvasWidth = containerRef.current.clientWidth || 860;
    const canvasHeight = Math.max(height, 24 + rows * ROW_GAP + 40);

    const graph = new Graph({
      container: containerRef.current,
      width: canvasWidth,
      height: canvasHeight,
      grid: { size: 10, visible: true, type: "mesh", args: { color: "#eef2f6", thickness: 1 } },
      background: { color: "#fafafa" },
      interacting: { nodeMovable: true, edgeMovable: false, vertexMovable: false, arrowheadMovable: false },
      panning: { enabled: true, eventTypes: ["rightMouseDown", "mouseWheel"] },
      mousewheel: { enabled: true, modifiers: "ctrl", factor: 1.1, minScale: 0.5, maxScale: 1.5 },
      connecting: { allowBlank: false, allowLoop: false, allowMulti: false, snap: true },
    });
    graphRef.current = graph;

    const centerY = (canvasHeight - NODE_HEIGHT) / 2;
    const columnX = (column: number) =>
      Math.max(20, (canvasWidth - (NODE_WIDTH + 2 * COLUMN_GAP)) / 2 + column * COLUMN_GAP);

    const addNode = (
      id: string,
      column: number,
      offsetIndex: number,
      total: number,
      title: string,
      subtitle: string,
      tag: string,
      tone: keyof typeof TONE,
    ) => {
      const y = centerY + (offsetIndex - (total - 1) / 2) * ROW_GAP;
      graph.addNode({
        id,
        shape: "doc-flow-link-node",
        x: columnX(column),
        y,
        ports: [
          { id: `${id}-left`, group: "left" },
          { id: `${id}-right`, group: "right" },
        ],
        attrs: {
          body: { stroke: TONE[tone].stroke, fill: TONE[tone].fill },
          title: { text: clip(title, 13) },
          subtitle: { text: clip(subtitle, 24) },
          tag: { text: tag, fill: TONE[tone].text },
        },
      });
    };

    addNode(
      "current",
      1,
      0,
      1,
      data.current.document_name || data.current.document_type,
      data.current.document_no || `#${data.current.document_id}`,
      t("docFlow.connections.currentTag"),
      "current",
    );

    const addEdge = (source: string, target: string, label: string, tone: keyof typeof TONE) => {
      graph.addEdge({
        shape: "doc-flow-link-edge",
        source: { cell: source, port: `${source}-right` },
        target: { cell: target, port: `${target}-left` },
        attrs: { line: { stroke: TONE[tone].stroke } },
        labels: [
          {
            attrs: {
              text: { text: label, fill: TONE[tone].text, fontSize: 11, fontWeight: 500 },
              rect: { fill: "#fff", stroke: TONE[tone].stroke, strokeWidth: 0.5, rx: 3, ry: 3 },
            },
          },
        ],
      });
    };

    upstream.forEach((item, index) => {
      const id = `up-${item.document_type}-${item.document_id}`;
      addNode(
        id,
        0,
        index,
        upstream.length,
        item.document_name || item.document_type,
        item.document_no || `#${item.document_id}`,
        `${item.lines} ${t("docFlow.connections.lines")}`,
        "upstream",
      );
      addEdge(id, "current", String(item.quantity), "upstream");
    });

    downstream.forEach((item, index) => {
      const id = `down-${item.document_type}-${item.document_id}`;
      addNode(
        id,
        2,
        index,
        downstream.length,
        item.document_name || item.document_type,
        item.document_no || `#${item.document_id}`,
        `${item.lines} ${t("docFlow.connections.lines")}`,
        "downstream",
      );
      addEdge("current", id, String(item.quantity), "downstream");
    });

    graph.centerContent();

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, [data, height, t]);

  const isEmpty =
    !loading &&
    (!data?.current ||
      ((data.upstream?.length ?? 0) === 0 && (data.downstream?.length ?? 0) === 0));

  return (
    <div
      style={{
        position: "relative",
        minHeight: height,
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <Spin spinning={!!loading}>
        <div ref={containerRef} style={{ width: "100%", height }} />
      </Spin>
      {isEmpty && !loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("docFlow.connections.empty")}
          />
        </div>
      )}
    </div>
  );
}

export default DocFlowConnectionsGraph;
