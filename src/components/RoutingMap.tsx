import { useEffect, useRef, useState } from "react";
import { Graph } from "@antv/x6";
import { Spin } from "antd";
import { useTranslation } from "react-i18next";

interface RoutingMapProps {
  details: any[];
  operations: any[];
  routingNo: string;
}

interface NodeData {
  sequenceNo: number;
  operationName: string;
  standardHours: number;
  setupHours: number;
  laborRate: number;
  overheadRate: number;
  isInspection: boolean;
}

export function RoutingMap({ details, operations, routingNo }: RoutingMapProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [loading, setLoading] = useState(false);

  const getOperationName = (operationId: number | null) => {
    const operation = operations.find((op) => op.id === operationId);
    if (!operation?.name) return t("routingMap.fallback.operation");
    return `🕒 ${operation.name}`;
  };
  // 滤镜配置
  const FILTERS = {
    card: [
      'drop-shadow(0 6px 16px rgba(0,0,0,0.12))',
      'drop-shadow(0 3px 6px rgba(0,0,0,0.06))',
    ],
    tips: [
      'drop-shadow(0 6px 20px rgba(0,0,0,0.25))',
      'drop-shadow(0 4px 12px rgba(0,0,0,0.15))',
    ],
    diamond: [
      'drop-shadow(0 6px 20px rgba(65,105,225,0.5))',
      'drop-shadow(0 4px 12px rgba(65,105,225,0.3))',
    ],
  }
  const CONFIG = {
    card: { width: 100, height: 80 },
    marker: { diameter: 12 },
    diamond: { size: 80 },
    layout: { timelineY: 400, cardsY: 250, tipsGap: 160 },
    timeline: { startX: 250, endX: 1850 },
    text: { fontFamily: 'Inter, Helvetica, Arial, sans-serif',lineHeight: 20 },
  }
  const updateInfoNode = (graph: Graph, mouseX: number, mouseY: number, data?: NodeData) => {
    let infoNode = graph.getCellById("info-node");

    if (data) {
      const infoText = [
        t("routingMap.detail.title"),
        t("routingMap.detail.seqNo", { value: data.sequenceNo }),
        t("routingMap.detail.operation", { value: data.operationName }),
        t("routingMap.detail.standardHours", { value: data.standardHours }),
        t("routingMap.detail.setupHours", { value: data.setupHours }),
        t("routingMap.detail.laborRate", { value: data.laborRate }),
        t("routingMap.detail.overheadRate", { value: data.overheadRate }),
        data.isInspection ? t("routingMap.detail.needInspect") : "",
      ].join("\n");

      const nodeWidth = 140;
      const nodeHeight = 175;
      const offsetX = 10;
      const offsetY = 30;

      const newX = mouseX + offsetX;
      const newY = mouseY + offsetY;

      if (infoNode) {
        infoNode.attr("label/text", infoText);
        (infoNode as any).position(newX, newY);
      } else {
        infoNode = graph.addNode({
          id: "info-node",
          x: newX,
          y: newY,
          width: nodeWidth,
          height: nodeHeight,
          attrs: {
            body: {
              fill: "#ffffff",
              stroke: 'none',
              rx: 6,
              ry: 6,
              filter: FILTERS.tips[1],
            },
            label: {
              text: infoText,
              fill: "#333",
              fontSize: 12,
              textAnchor: "start",
              textVerticalAnchor: "top",
              ...CONFIG.text,
              refX: 10,
              refY: 10,
            },
            header: {
              width: 200,
              height: 40,
              fill: '#1a1a1a',
              stroke: 'none',
              rx: 6,
              ry: 6,
            },
            headerText: {
              refX: 100,
              refY: 20,
              text: 'Timeline',
              fill: '#FFFFFF',
              fontSize: 18,
              fontWeight: 'bold',
              textAnchor: 'middle',
              dominantBaseline: 'middle',
              ...CONFIG.text,
            },
          },
        });
      }
    } else {
      if (infoNode) {
        graph.removeCell(infoNode);
      }
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);

    const container = containerRef.current;
    const width = container.clientWidth || 800;
    const height = 400;

    if (graphRef.current) {
      graphRef.current.dispose();
    }

    const graph = new Graph({
      container: container,
      width,
      height,
      grid: {
        size: 10,
        visible: true,
        type: "mesh",
        args: {
          color: "#e0e0e0",
          thickness: 1,
        },
      },
      background: {
        color: "#ffffff",
      },
    });

    graphRef.current = graph;

    const titleText = `💡${routingNo ? t("routingMap.titleWithNo", { no: routingNo }) : t("routingMap.selectRouting")}`;
    graph.addNode({
      id: "title-node",
      x: 10,
      y: 10,
      width: 280,
      height: 36,
      attrs: {
        body: {
          fill: "#ffffff00",
          stroke: "none",
          rx: 4,
          ry: 4,
        },
        label: {
          text: titleText,
          fill: "#000000",
          fontSize: 14,
          fontWeight: "bold",
          ...CONFIG.text,
        },
      },
    });

    if (details.length === 0) {
      setLoading(false);
      return;
    }

    const nodeWidth = 80;
    const nodeHeight = 40;
    const horizontalGap = 80;
    const verticalGap = 100;

    details.forEach((detail, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const x = 60 + col * (nodeWidth + horizontalGap);
      const y = 80 + row * (nodeHeight + verticalGap);

      const isInspection = detail.is_inspection_required;
      const nodeData: NodeData = {
        sequenceNo: detail.sequence_no,
        operationName: getOperationName(detail.operation_id),
        standardHours: detail.standard_hours || 0,
        setupHours: detail.setup_hours || 0,
        laborRate: detail.labor_rate || 0,
        overheadRate: detail.overhead_rate || 0,
        isInspection: isInspection,
      };

      graph.addNode({
        id: `node-${detail.id}`,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        attrs: {
          body: {
            fill: isInspection ? "#eaeefa" : "#eaeefa",
            stroke: isInspection ? "#31d0c6" : "#1890ff",
            strokeWidth: 2,
            rx: 6,
            ry: 6,
            filter: FILTERS.tips[2],
          },
          label: {
            text: getOperationName(detail.operation_id),
            fill: "#333",
            fontSize: 12,
            fontWeight: "bold",
          },
        },
        ports: {
          groups: {
            left: {
              position: {
                name: "left",
              },
              attrs: {
                circle: {
                  r: 5,
                  magnet: true,
                  stroke: isInspection ? "#31d0c6" : "#1890ff",
                  strokeWidth: 1,
                  fill: "#fff",
                },
              },
            },
            right: {
              position: {
                name: "right",
              },
              attrs: {
                circle: {
                  r: 5,
                  magnet: true,
                  stroke: isInspection ? "#31d0c6" : "#1890ff",
                  strokeWidth: 1,
                  fill: "#fff",
                },
              },
            },
          },
          items: [
            { id: "port-left", group: "left" },
            { id: "port-right", group: "right" },
          ],
        },
        data: nodeData,
      });

      if (detail.next_operation_id) {
        const nextDetail = details.find((d) => d.operation_id === detail.next_operation_id);
        if (nextDetail) {
          graph.addEdge({
            id: `edge-${detail.id}-${nextDetail.id}`,
            source: { cell: `node-${detail.id}`, port: "port-right" },
            target: { cell: `node-${nextDetail.id}`, port: "port-left" },
            connector: {
              name: "rounded",
              args: {
                radius: 8,
              },
            },
            attrs: {
              line: {
                stroke: "#31d0c6",
                strokeWidth: 1,
                targetMarker: {
                  name: "classic",
                  size: 8,
                  fill: "#31d0c6",
                },
              },
            },
            labels: [
              {
                attrs: {
                  text: {
                    text: t("routingMap.nextOperation"),
                    fill: "#31d0c6",
                    fontSize: 10,
                  },
                },
                position: 0.5,
              },
            ],
          });
        }
      } else if (index < details.length - 1) {
        const nextDetail = details[index + 1];
        graph.addEdge({
          id: `edge-${detail.id}-${nextDetail.id}`,
          source: { cell: `node-${detail.id}`, port: "port-right" },
          target: { cell: `node-${nextDetail.id}`, port: "port-left" },
          connector: {
            name: "rounded",
            args: {
              radius: 8,
            },
          },
          attrs: {
            line: {
              stroke: "#1890ff",
              strokeWidth: 1,
              targetMarker: {
                name: "classic",
                size: 8,
                fill: "#1890ff",
              },
            },
          },
        });
      }
    });

    graph.on("node:click", ({ node, e }) => {
      if (node.id === "info-node") return;

      const data = node.getData();
      if (data && e) {
        const point = graph.clientToLocal(e.clientX, e.clientY);
        updateInfoNode(graph, point.x, point.y, data);
      }
    });

    graph.zoomToFit({ padding: 40, maxScale: 1 });

    setLoading(false);

    return () => {
      if (graphRef.current) {
        graphRef.current.dispose();
        graphRef.current = null;
      }
    };
  }, [details, operations]);

  return (
    <>
      <Spin spinning={loading} indicator={<span>{t("routingMap.loading")}</span>}>
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: 400,
            border: "1px solid #e8e8e8",
            borderRadius: 4,
          }}
        />
      </Spin>
      {details.length === 0 && !loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 400,
            color: "#999",
          }}
        >
          {t("routingMap.empty.selectRouting")}
        </div>
      )}
    </>
  );
}


