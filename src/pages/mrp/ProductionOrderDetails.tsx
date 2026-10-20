import { useCallback, useEffect, useState } from "react";
import { Alert, Space, Table, Typography } from "antd";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { formatQuantity } from "../../utils/money";
import { useTranslation } from "react-i18next";

type OrderDetail = Tables["erp_production_order_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];

const DETAILS_TABLE = "erp_production_order_details_s_539dcf81_b";

/**
 * 生产订单「订单明细」页签：只读展示该订单的 BOM 领料明细。
 * 由「展开 BOM」动作（explode_production_order_bom RPC）生成，物料列叫 material_id。
 * 这是 MRP 把生产订单当毛需求来源时直接读取的明细（有明细就不按 BOM 展开）。
 */
export function ProductionOrderDetails({
  orderId,
}: {
  orderId: number;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<OrderDetail[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDetails = useCallback(async () => {
    if (!orderId) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(DETAILS_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("line_no")
        .order("id");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching production order details:", error);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void fetchDetails();
  }, [fetchDetails]);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, w] = await Promise.all([
          supabase.from("erp_products_s_539dcf81_b").select("*").eq("is_deleted", "n"),
          supabase.from("erp_warehouses_s_539dcf81_b").select("*").eq("is_deleted", "n"),
        ]);
        if (p.error) throw p.error;
        if (w.error) throw w.error;
        setProducts(p.data || []);
        setWarehouses(w.data || []);
      } catch (error) {
        console.error("Error fetching production order detail master data:", error);
      }
    };
    void load();
  }, []);

  const getProductLabel = (productId: number | null) => {
    if (!productId) return "-";
    const p = products.find((x) => x.id === productId);
    return p ? `${p.code} - ${p.name}` : `#${productId}`;
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const w = warehouses.find((x) => x.id === warehouseId);
    return w?.name || "-";
  };

  const columns = [
    {
      title: t("mrp.productionOrderDetails.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
      width: 70,
      render: (v: number | null) => v ?? "-",
    },
    {
      title: t("mrp.productionOrderDetails.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (v: number | null) => getProductLabel(v),
    },
    {
      title: t("mrp.productionOrderDetails.plannedQuantity"),
      dataIndex: "planned_quantity",
      key: "planned_quantity",
      align: "right" as const,
      render: (v: number | null) => formatQuantity(v),
    },
    {
      title: t("mrp.productionOrderDetails.issuedQuantity"),
      dataIndex: "issued_quantity",
      key: "issued_quantity",
      align: "right" as const,
      render: (v: number | null) => formatQuantity(v),
    },
    {
      title: t("mrp.productionOrderDetails.unit"),
      dataIndex: "unit",
      key: "unit",
      width: 80,
      render: (v: string | null) => v || "-",
    },
    {
      title: t("mrp.productionOrderDetails.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (v: number | null) => getWarehouseName(v),
    },
    {
      title: t("mrp.productionOrderDetails.remark"),
      dataIndex: "remark",
      key: "remark",
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
  ];

  if (!orderId) {
    return <Alert type="info" showIcon message={t("mrp.productionOrderOperations.saveFirst")} />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">
          {t("mrp.productionOrderDetails.hint")}
        </Typography.Text>
      </Space>

      <Table
        rowKey="id"
        size="small"
        dataSource={details}
        columns={columns}
        loading={loading}
        pagination={false}
        scroll={{ y: 360, x: 860 }}
        locale={{ emptyText: t("mrp.productionOrderDetails.empty") }}
      />
    </div>
  );
}
