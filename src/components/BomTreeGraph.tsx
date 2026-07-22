import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Empty, Spin, Space, Tag, Typography } from "antd";
import { ExtensionCategory, Graph, register, treeToGraphData } from "@antv/g6";
import { ReactNode } from "@antv/g6-extension-react";
import { supabase } from "../utils/supabase";
import type { Tables } from "../utils/supabase";

type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

interface BomTreeGraphProps {
  materialCode?: string | null;
}

interface BomTreeNode {
  id: string;
  label: string;
  code: string;
  name: string;
  quantity: number;
  unit?: string | null;
  lossRate?: number | null;
  bomNo?: string;
  level: number;
  children?: BomTreeNode[];
}

const BOM_TABLE = "erp_boms_s_539dcf81_b";
const BOM_DETAIL_TABLE = "erp_bom_details_s_539dcf81_b";
const PRODUCT_TABLE = "erp_products_s_539dcf81_b";

let reactNodeRegistered = false;
if (!reactNodeRegistered) {
  register(ExtensionCategory.NODE, "react", ReactNode);
  reactNodeRegistered = true;
}

function BomNodeCard({ data }: { data: BomTreeNode }) {
  const isRoot = data.level === 0;
  const accent = isRoot ? "#1677ff" : data.level === 1 ? "#13c2c2" : "#722ed1";

  return (
    <Card
      size="small"
      bordered
      styles={{ body: { padding: 10 } }}
      style={{
        width: 250,
        borderRadius: 14,
        borderColor: accent,
        boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
        background: isRoot
          ? "linear-gradient(180deg, #f8fbff 0%, #ffffff 100%)"
          : "#fff",
      }}
    >
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Space align="center" size={8} style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Text strong ellipsis style={{ fontSize: 13, color: "#1f2937", flex: 1 }}>
            {data.code}
          </Typography.Text>
          <Badge color={accent} text={isRoot ? "主件" : `L${data.level}`} />
        </Space>

        <Typography.Text ellipsis style={{ color: "#6b7280", fontSize: 12 }}>
          {data.name}
        </Typography.Text>

        <Space size={6} wrap>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            数量 {data.quantity}
          </Tag>
          {data.unit ? (
            <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
              {data.unit}
            </Tag>
          ) : null}
          {data.lossRate != null ? (
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>
              损耗 {(data.lossRate * 100).toFixed(2)}%
            </Tag>
          ) : null}
        </Space>
      </Space>
    </Card>
  );
}

async function fetchProductsMap(ids: number[]) {
  if (ids.length === 0) return new Map<number, Product>();

  const { data, error } = await supabase.from(PRODUCT_TABLE).select("*").in("id", ids);
  if (error) throw error;

  return new Map<number, Product>((data || []).map((item) => [item.id, item]));
}

async function fetchBestBomByProductId(productId: number) {
  const { data, error } = await supabase
    .from(BOM_TABLE)
    .select("*")
    .eq("is_deleted", "n")
    .eq("product_id", productId)
    .order("is_default", { ascending: false })
    .order("effective_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data || [])[0] || null;
}

async function fetchBomDetails(bomId: number) {
  const { data, error } = await supabase
    .from(BOM_DETAIL_TABLE)
    .select("*")
    .eq("is_deleted", "n")
    .eq("bom_id", bomId)
    .order("line_no");

  if (error) throw error;
  return data || [];
}

async function buildBomTreeByProductCode(materialCode: string) {
  const { data: productRows, error: productError } = await supabase
    .from(PRODUCT_TABLE)
    .select("*")
    .eq("is_deleted", "n")
    .eq("code", materialCode)
    .limit(1);

  if (productError) throw productError;

  const rootProduct = (productRows || [])[0] || null;
  if (!rootProduct) return null;

  const visited = new Set<number>();

  const buildNode = async (product: Product, quantity = 1, level = 0): Promise<BomTreeNode> => {
    const bom = await fetchBestBomByProductId(product.id);
    const baseNode: BomTreeNode = {
      id: `product-${product.id}`,
      label: `${product.code} ${product.name}`,
      code: product.code,
      name: product.name,
      quantity,
      unit: product.unit,
      level,
      bomNo: bom?.bom_no,
    };

    if (!bom || visited.has(product.id) || level > 10) {
      return baseNode;
    }

    visited.add(product.id);
    const details = await fetchBomDetails(bom.id);
    const childProductIds = details.map((detail) => detail.material_id).filter((id): id is number => typeof id === "number");
    const productMap = await fetchProductsMap(childProductIds);

    const children: BomTreeNode[] = [];
    for (const detail of details) {
      if (!detail.material_id) continue;
      const childProduct = productMap.get(detail.material_id);
      const childNode: BomTreeNode = {
        id: `detail-${detail.id}`,
        label: childProduct ? `${childProduct.code} ${childProduct.name}` : `物料#${detail.material_id}`,
        code: childProduct?.code || `M-${detail.material_id}`,
        name: childProduct?.name || "未命名物料",
        quantity: detail.quantity || 0,
        unit: detail.unit || childProduct?.unit,
        lossRate: detail.loss_rate,
        level: level + 1,
      };

      if (childProduct) {
        const nestedBom = await fetchBestBomByProductId(childProduct.id);
        if (nestedBom && !visited.has(childProduct.id) && level < 10) {
          childNode.children = [await buildNode(childProduct, detail.quantity || 1, level + 1)];
        }
      }

      children.push(childNode);
    }

    return { ...baseNode, children };
  };

  return buildNode(rootProduct, 1, 0);
}

export function BomTreeGraph({ materialCode }: BomTreeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasData, setHasData] = useState(true);

  const title = useMemo(() => (materialCode ? `BOM结构树 - ${materialCode}` : "BOM结构树"), [materialCode]);

  useEffect(() => {
    let cancelled = false;

    const renderTree = async () => {
      if (!containerRef.current) return;
      setLoading(true);
      setHasData(true);

      try {
        const treeData = materialCode ? await buildBomTreeByProductCode(materialCode) : null;
        if (cancelled || !containerRef.current) return;

        if (graphRef.current) {
          graphRef.current.destroy();
          graphRef.current = null;
        }

        const container = containerRef.current;
        const graph = new Graph({
          container,
          width: container.clientWidth || 800,
          height: Math.max(container.clientHeight || 640, 640),
          data: treeData ? treeToGraphData(treeData as any) : undefined,
          layout: {
            type: "dendrogram",
            direction: "TB",
            nodeSep: 160,
            rankSep: 240,
          },
          node: {
            type: "react",
            style: {
              size: [240, 104],
              component: (datum: any) => <BomNodeCard data={datum} />,
            },
          },
          edge: {
            type: "polyline",
            style: {
              stroke: "#cbd5e1",
              lineWidth: 1.4,
              endArrow: true,
            },
          },
          behaviors: [
            { type: "drag-canvas" },
            { type: "zoom-canvas" },
            { type: "collapse-expand", trigger: "dblclick" },
          ],
        });

        graphRef.current = graph;
        await graph.render();
        await graph.fitView({ when: "always", direction: "both" });

        if (!treeData) {
          setHasData(false);
        }
      } catch (error) {
        console.error("Error rendering bom tree:", error);
        setHasData(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void renderTree();

    return () => {
      cancelled = true;
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [materialCode]);

  if (!materialCode) {
    return <Empty description="请选择一个物料编码" />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Space direction="vertical" size={6} style={{ width: "100%", marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary">
          双击节点折叠/展开，滚轮缩放，拖拽浏览。
        </Typography.Text>
      </Space>

      <Spin spinning={loading} tip="正在加载BOM树...">
        <Card
          styles={{ body: { padding: 0 } }}
          style={{
            borderRadius: 16,
            overflow: "hidden",
            borderColor: "#e5e7eb",
            background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: "100%",
              height: "calc(100vh - 220px)",
              minHeight: 700,
            }}
          />
        </Card>
      </Spin>

      {!loading && !hasData ? <div style={{ marginTop: 12 }}><Empty description="未找到该物料对应的BOM" /></div> : null}
    </div>
  );
}






