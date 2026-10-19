import { useCallback, useEffect, useState } from "react";
import { Alert, Space, Table, Tag, Typography } from "antd";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { formatQuantity, formatMoney } from "../../utils/money";
import { useTranslation } from "react-i18next";

type MaterialIssue = Tables["erp_material_issues_s_539dcf81_b"]["Row"];
type MaterialIssueDetail = Tables["erp_material_issue_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const ISSUES_TABLE = "erp_material_issues_s_539dcf81_b";
const DETAILS_TABLE = "erp_material_issue_details_s_539dcf81_b";

/**
 * 生产订单「物料领料」页签：只读展示该订单下的领料单及明细。
 * 领料单头通过 production_order_id 关联本订单，明细通过 issue_id 关联领料单头。
 */
export function ProductionOrderMaterialIssues({
  orderId,
}: {
  orderId: number;
}) {
  const { t } = useTranslation();
  const [issues, setIssues] = useState<MaterialIssue[]>([]);
  const [details, setDetails] = useState<Record<number, MaterialIssueDetail[]>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchIssues = useCallback(async () => {
    if (!orderId) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(ISSUES_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .eq("production_order_id", orderId)
        .order("issue_date", { ascending: false })
        .order("id", { ascending: false });
      if (error) throw error;
      setIssues(data || []);
    } catch (error) {
      console.error("Error fetching material issues:", error);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void fetchIssues();
  }, [fetchIssues]);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, w, b] = await Promise.all([
          supabase.from("erp_products_s_539dcf81_b").select("*").eq("is_deleted", "n"),
          supabase.from("erp_warehouses_s_539dcf81_b").select("*").eq("is_deleted", "n"),
          supabase.from("erp_bins_s_539dcf81_b").select("*").eq("is_deleted", "n"),
        ]);
        if (p.error) throw p.error;
        if (w.error) throw w.error;
        if (b.error) throw b.error;
        setProducts(p.data || []);
        setWarehouses(w.data || []);
        setBins(b.data || []);
      } catch (error) {
        console.error("Error fetching material issue master data:", error);
      }
    };
    void load();
  }, []);

  const fetchDetails = useCallback(async (issueIds: number[]) => {
    if (issueIds.length === 0) {
      setDetails({});
      return;
    }
    try {
      const { data, error } = await supabase
        .from(DETAILS_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .in("issue_id", issueIds)
        .order("line_no");
      if (error) throw error;
      const grouped: Record<number, MaterialIssueDetail[]> = {};
      for (const d of data || []) {
        if (d.issue_id == null) continue;
        (grouped[d.issue_id] ||= []).push(d);
      }
      setDetails(grouped);
    } catch (error) {
      console.error("Error fetching material issue details:", error);
      setDetails({});
    }
  }, []);

  useEffect(() => {
    void fetchDetails(issues.map((i) => i.id));
  }, [issues, fetchDetails]);

  const getProductLabel = (productId: number | null) => {
    if (!productId) return "-";
    const p = products.find((x) => x.id === productId);
    return p ? `${p.code} - ${p.name}` : "-";
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const w = warehouses.find((x) => x.id === warehouseId);
    return w?.name || "-";
  };

  const getBinLabel = (binId: number | null) => {
    if (!binId) return "-";
    const bin = bins.find((x) => x.id === binId);
    return bin ? `${bin.code} - ${bin.name}` : "-";
  };

  const issueStatusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.materialIssues.statusDraft"), color: "default" },
    approved: { text: t("mrp.materialIssues.statusApproved"), color: "blue" },
    issued: { text: t("mrp.materialIssues.statusIssued"), color: "success" },
    posted: { text: t("mrp.materialIssues.statusPosted"), color: "green" },
    cancelled: { text: t("mrp.materialIssues.statusCancelled"), color: "error" },
  };

  const issueColumns = [
    {
      title: t("mrp.materialIssues.issueNo"),
      dataIndex: "issue_no",
      key: "issue_no",
    },
    {
      title: t("mrp.materialIssues.issueDate"),
      dataIndex: "issue_date",
      key: "issue_date",
      render: (v: string | null) => v || "-",
    },
    {
      title: t("mrp.materialIssues.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (v: number | null) => getWarehouseName(v),
    },
    {
      title: t("mrp.materialIssues.totalAmount"),
      dataIndex: "total_amount",
      key: "total_amount",
      align: "right" as const,
      render: (v: number | null) => formatMoney(v),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string | null) => {
        const cfg = issueStatusLabels[status || ""] || { text: status || "-", color: "default" };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
  ];

  const detailColumns = [
    {
      title: t("mrp.materialIssues.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
      width: 70,
    },
    {
      title: t("mrp.materialIssues.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (v: number | null) => getProductLabel(v),
    },
    {
      title: t("mrp.materialIssues.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (v: number | null) => formatQuantity(v),
    },
    {
      title: t("mrp.materialIssues.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      align: "right" as const,
      render: (v: number | null) => formatMoney(v),
    },
    {
      title: t("mrp.materialIssues.amount"),
      dataIndex: "amount",
      key: "amount",
      align: "right" as const,
      render: (v: number | null) => formatMoney(v),
    },
    {
      title: t("mrp.materialIssues.batchNo"),
      dataIndex: "batch_no",
      key: "batch_no",
      width: 120,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: t("mrp.materialIssues.location"),
      dataIndex: "location_id",
      key: "location_id",
      render: (v: number | null) => (v ? getBinLabel(v) : "-"),
    },
    {
      title: t("mrp.materialIssues.source"),
      dataIndex: "order_detail_id",
      key: "order_detail_id",
      width: 100,
      render: (v: number | null) =>
        v ? (
          <Tag color="blue">{t("mrp.materialIssues.sourceOrder")}</Tag>
        ) : (
          <Tag>{t("mrp.materialIssues.sourceManual")}</Tag>
        ),
    },
  ];

  if (!orderId) {
    return <Alert type="info" showIcon message={t("mrp.productionOrderOperations.saveFirst")} />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">
          {t("mrp.productionOrderMaterialIssues.hint")}
        </Typography.Text>
      </Space>

      <Table
        rowKey="id"
        size="small"
        dataSource={issues}
        columns={issueColumns}
        loading={loading}
        pagination={false}
        scroll={{ y: 320, x: 720 }}
        expandable={{
          rowExpandable: (record) => (details[record.id]?.length ?? 0) > 0,
          expandedRowRender: (record) => (
            <Table
              rowKey="id"
              size="small"
              columns={detailColumns}
              dataSource={details[record.id] || []}
              pagination={false}
              locale={{ emptyText: t("mrp.productionOrderMaterialIssues.noDetails") }}
            />
          ),
        }}
        locale={{ emptyText: t("mrp.productionOrderMaterialIssues.empty") }}
      />
    </div>
  );
}
