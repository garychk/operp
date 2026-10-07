import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

type SourceType =
  | "purchase_receipt"
  | "sales_return"
  | "production_operation"
  | "production_receipt";
type Inspection = {
  id: number;
  inspection_no: string;
  inspection_date: string;
  source_type: SourceType;
  source_id: number;
  source_detail_id: number | null;
  source_no: string | null;
  product_id: number;
  production_order_id: number | null;
  operation_id: number | null;
  batch_no: string | null;
  inspection_quantity: number;
  sample_quantity: number;
  qualified_quantity: number;
  unqualified_quantity: number;
  result: string;
  status: string;
  disposition: string | null;
  inspector: string | null;
  remark: string | null;
};
type Product = { id: number; code: string; name: string; unit: string | null };
type Source = {
  key: string;
  sourceId: number;
  detailId: number | null;
  sourceNo: string;
  productId: number;
  quantity: number;
  batchNo: string | null;
  productionOrderId?: number | null;
  operationId?: number | null;
  label: string;
};

export function QualityInspections() {
  const { t } = useTranslation();
  const sourceNames: Record<SourceType, string> = {
    purchase_receipt: t("mrp.quality.sourcePurchaseReceipt"),
    sales_return: t("mrp.quality.sourceSalesReturn"),
    production_operation: t("mrp.quality.sourceProductionOperation"),
    production_receipt: t("mrp.quality.sourceProductionReceipt"),
  };
  const results: Record<string, [string, string]> = {
    pending: [t("mrp.quality.resultPending"), "default"],
    qualified: [t("mrp.quality.resultQualified"), "success"],
    unqualified: [t("mrp.quality.resultUnqualified"), "error"],
    conditional: [t("mrp.quality.resultConditional"), "warning"],
  };
  const statuses: Record<string, [string, string]> = {
    pending: [t("mrp.quality.statusPending"), "gold"],
    inspecting: [t("mrp.quality.statusInspecting"), "processing"],
    completed: [t("mrp.quality.statusCompleted"), "success"],
    cancelled: [t("mrp.quality.statusCancelled"), "default"],
  };
  const dispositions = [
    ["accept", t("mrp.quality.dispAccept")],
    ["return", t("mrp.quality.dispReturn")],
    ["rework", t("mrp.quality.dispRework")],
    ["scrap", t("mrp.quality.dispScrap")],
    ["concession", t("mrp.quality.dispConcession")],
    ["sort", t("mrp.quality.dispSort")],
  ].map(([value, label]) => ({ value, label }));
  const [rows, setRows] = useState<Inspection[]>([]),
    [products, setProducts] = useState<Product[]>([]),
    [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false),
    [search, setSearch] = useState(""),
    [createOpen, setCreateOpen] = useState(false),
    [inspectOpen, setInspectOpen] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("purchase_receipt"),
    [current, setCurrent] = useState<Inspection | null>(null);
  const [createForm] = Form.useForm(),
    [inspectForm] = Form.useForm();
  const productMap = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );
  const load = async () => {
    setLoading(true);
    const [a, b] = await Promise.all([
      supabase
        .from("erp_quality_inspections_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("inspection_date", { ascending: false }),
      supabase
        .from("erp_products_s_539dcf81_b")
        .select("id,code,name,unit")
        .eq("is_deleted", "n"),
    ]);
    setLoading(false);
    if (a.error) {
      message.error(t("mrp.quality.fetchDataFailed"));
      return;
    }
    setRows((a.data || []) as Inspection[]);
    setProducts((b.data || []) as Product[]);
  };
  useEffect(() => {
    void load();
  }, []);
  const loadSources = async (type: SourceType) => {
    setSources([]);
    createForm.setFieldValue("sourceKey", undefined);
    try {
      if (type === "purchase_receipt") {
        const { data, error } = await supabase
          .from("erp_purchase_receipt_details_s_539dcf81_b")
          .select(
            "id,receipt_id,product_id,quantity,batch_no,erp_purchase_receipts_s_539dcf81_b!inner(receipt_no)",
          )
          .eq("is_deleted", "n");
        if (error) throw error;
        setSources(
          (data || []).map((d: any) => {
            const p = productMap.get(d.product_id);
            return {
              key: `${d.receipt_id}-${d.id}`,
              sourceId: d.receipt_id,
              detailId: d.id,
              sourceNo: d.erp_purchase_receipts_s_539dcf81_b.receipt_no,
              productId: d.product_id,
              quantity: Number(d.quantity),
              batchNo: d.batch_no,
              label: `${d.erp_purchase_receipts_s_539dcf81_b.receipt_no} / ${p?.name || d.product_id} / ${d.quantity}${p?.unit || ""}`,
            };
          }),
        );
      } else if (type === "sales_return") {
        const { data, error } = await supabase
          .from("erp_sales_return_details_s_539dcf81_b")
          .select(
            "id,return_id,product_id,quantity,batch_no,erp_sales_returns_s_539dcf81_b!inner(return_no)",
          )
          .eq("is_deleted", "n");
        if (error) throw error;
        setSources(
          (data || []).map((d: any) => {
            const p = productMap.get(d.product_id);
            return {
              key: `${d.return_id}-${d.id}`,
              sourceId: d.return_id,
              detailId: d.id,
              sourceNo: d.erp_sales_returns_s_539dcf81_b.return_no,
              productId: d.product_id,
              quantity: Number(d.quantity),
              batchNo: d.batch_no,
              label: `${d.erp_sales_returns_s_539dcf81_b.return_no} / ${p?.name || d.product_id} / ${d.quantity}${p?.unit || ""}`,
            };
          }),
        );
      } else if (type === "production_receipt") {
        // 成品入库检验（FQC）：完工入库单是「主表即唯一明细行」，没有明细表（deploy_58）
        const { data, error } = await supabase
          .from("erp_production_receipts_s_539dcf81_b")
          .select("id,receipt_no,product_id,quantity,batch_no")
          .eq("is_deleted", "n");
        if (error) throw error;
        setSources(
          (data || []).map((h: any) => {
            const p = productMap.get(h.product_id);
            return {
              key: String(h.id),
              sourceId: h.id,
              detailId: null,
              sourceNo: h.receipt_no,
              productId: h.product_id,
              quantity: Number(h.quantity),
              batchNo: h.batch_no,
              label: `${h.receipt_no} / ${p?.name || h.product_id} / ${h.quantity}${p?.unit || ""}`,
            };
          }),
        );
      } else {
        const { data, error } = await supabase
          .from("erp_production_reports_s_539dcf81_b")
          .select(
            "id,report_no,production_order_id,operation_id,completed_quantity,erp_production_orders_s_539dcf81_b!inner(product_id,routing_id)",
          )
          .eq("is_deleted", "n");
        if (error) throw error;
        const reports = data || [],
          routingIds = [
            ...new Set(
              reports
                .map(
                  (r: any) => r.erp_production_orders_s_539dcf81_b.routing_id,
                )
                .filter(Boolean),
            ),
          ];
        const required = await supabase
          .from("erp_routing_operation_details_s_539dcf81_b")
          .select("routing_id,operation_id")
          .in("routing_id", routingIds.length ? routingIds : [-1])
          .eq("is_inspection_required", true);
        if (required.error) throw required.error;
        const keys = new Set(
          (required.data || []).map(
            (r: any) => `${r.routing_id}-${r.operation_id}`,
          ),
        );
        setSources(
          reports
            .filter((r: any) =>
              keys.has(
                `${r.erp_production_orders_s_539dcf81_b.routing_id}-${r.operation_id}`,
              ),
            )
            .map((r: any) => {
              const productId = r.erp_production_orders_s_539dcf81_b.product_id,
                p = productMap.get(productId);
              return {
                key: String(r.id),
                sourceId: r.id,
                detailId: null,
                sourceNo: r.report_no,
                productId,
                quantity: Number(r.completed_quantity),
                batchNo: null,
                productionOrderId: r.production_order_id,
                operationId: r.operation_id,
                label: `${r.report_no} / ${p?.name || productId} / ${r.completed_quantity}${p?.unit || ""}`,
              };
            }),
        );
      }
    } catch (e) {
      console.error(e);
      message.error(t("mrp.quality.fetchSourcesFailed"));
    }
  };
  useEffect(() => {
    if (createOpen && products.length) void loadSources(sourceType);
  }, [createOpen, sourceType, products.length]);
  const create = async (v: any) => {
    const s = sources.find((x) => x.key === v.sourceKey);
    if (!s) return;
    const payload = {
      inspection_no: v.inspection_no,
      inspection_date: v.inspection_date.format("YYYY-MM-DD"),
      source_type: sourceType,
      source_id: s.sourceId,
      source_detail_id: s.detailId,
      source_no: s.sourceNo,
      product_id: s.productId,
      production_order_id: s.productionOrderId || null,
      operation_id: s.operationId || null,
      batch_no: s.batchNo,
      inspection_quantity: s.quantity,
      sample_quantity: v.sample_quantity || s.quantity,
      status: "pending",
      result: "pending",
      remark: v.remark || null,
    };
    try {
      await logWithTiming(
        t("mrp.quality.logCreate"),
        "INSERT",
        async () => {
          const { error } = await supabase
            .from("erp_quality_inspections_s_539dcf81_b")
            .insert(payload);
          if (error) throw error;
        },
        { table: "erp_quality_inspections_s_539dcf81_b" },
      );
      message.success(t("mrp.quality.taskCreated"));
      setCreateOpen(false);
      createForm.resetFields();
      void load();
    } catch (e: any) {
      message.error(
        e?.code === "23505"
          ? t("mrp.quality.sourceDuplicated")
          : t("mrp.quality.createFailed"),
      );
    }
  };
  const inspect = (r: Inspection) => {
    setCurrent(r);
    inspectForm.setFieldsValue({
      sample_quantity: r.sample_quantity || r.inspection_quantity,
      qualified_quantity: r.qualified_quantity,
      unqualified_quantity: r.unqualified_quantity,
      disposition: r.disposition,
      inspector: r.inspector,
      remark: r.remark,
    });
    setInspectOpen(true);
  };
  // 质检完成 → 把「待检」库存按结果搬进 available / hold / rejected（deploy_100 的业务级 RPC）。
  // 跳过是**正常分支**：例如入库时 receiptStockStatus='available'，压根没有待检桶，
  // 这时不该弹错误，只提示原因即可。RPC 自身幂等，重复点不会重复搬。
  const skipReasonLabels: Record<string, string> = {
    no_inspection_stock: t("mrp.quality.skipNoInspectionStock"),
    warehouse_not_resolved: t("mrp.quality.skipWarehouseNotResolved"),
    nothing_to_move: t("mrp.quality.skipNothingToMove"),
  };
  const moveStock = async (r: Inspection) => {
    const { data, error } = await supabase.rpc(
      "apply_quality_inspection_stock_move",
      { p_inspection_id: r.id },
    );
    if (error) {
      message.warning(`${t("mrp.quality.stockMoveFailed")}：${error.message}`);
      return;
    }
    const res = (data || {}) as {
      skipped?: boolean;
      idempotent?: boolean;
      reason?: string;
      available_quantity?: number;
      bad_quantity?: number;
      bad_status?: string;
    };
    if (res.skipped) {
      message.info(
        `${t("mrp.quality.stockMoveSkipped")}：${
          skipReasonLabels[res.reason || ""] || res.reason || ""
        }`,
      );
      return;
    }
    message.success(
      res.idempotent
        ? t("mrp.quality.stockMoveAlreadyDone")
        : t("mrp.quality.stockMoveDone", {
            available: res.available_quantity ?? 0,
            bad: res.bad_quantity ?? 0,
            status: res.bad_status || "-",
          }),
    );
  };
  const save = async (v: any, complete: boolean) => {
    if (!current) return;
    const sample = Number(v.sample_quantity),
      good = Number(v.qualified_quantity),
      bad = Number(v.unqualified_quantity);
    if (good + bad !== sample)
      return void message.error(t("mrp.quality.sumMustEqualSample"));
    if (sample > current.inspection_quantity)
      return void message.error(t("mrp.quality.sampleExceeds"));
    if (complete && bad > 0 && !v.disposition)
      return void message.error(t("mrp.quality.needDisposition"));
    const result =
      bad === 0
        ? "qualified"
        : v.disposition === "concession"
          ? "conditional"
          : "unqualified";
    try {
      await logWithTiming(
        complete ? t("mrp.quality.logComplete") : t("mrp.quality.logSave"),
        "UPDATE",
        async () => {
          const { error } = await supabase
            .from("erp_quality_inspections_s_539dcf81_b")
            .update({
              ...v,
              result: complete ? result : "pending",
              status: complete ? "completed" : "inspecting",
              completed_at: complete ? new Date().toISOString() : null,
            })
            .eq("id", current.id);
          if (error) throw error;
        },
        { table: "erp_quality_inspections_s_539dcf81_b", recordId: current.id },
      );
      message.success(
        complete
          ? t("mrp.quality.inspectionCompleted")
          : t("mrp.quality.savedTemp"),
      );
      setInspectOpen(false);
      if (complete) await moveStock(current);
      void load();
    } catch {
      message.error(t("common.saveFailed"));
    }
  };
  const filtered = rows.filter((r) =>
    `${r.inspection_no}${r.source_no || ""}${productMap.get(r.product_id)?.name || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const columns: any[] = [
    {
      title: t("mrp.quality.inspectionNo"),
      dataIndex: "inspection_no",
      fixed: "left",
      width: 160,
    },
    {
      title: t("mrp.quality.source"),
      dataIndex: "source_type",
      width: 110,
      render: (v: SourceType) => <Tag>{sourceNames[v]}</Tag>,
    },
    { title: t("mrp.quality.sourceNo"), dataIndex: "source_no", width: 150 },
    {
      title: t("mrp.quality.material"),
      dataIndex: "product_id",
      width: 190,
      render: (v: number) => {
        const p = productMap.get(v);
        return p ? `${p.code} - ${p.name}` : "-";
      },
    },
    {
      title: t("mrp.quality.inspectionSample"),
      width: 130,
      render: (_: unknown, r: Inspection) =>
        `${r.inspection_quantity} / ${r.sample_quantity}`,
    },
    {
      title: t("mrp.quality.result"),
      dataIndex: "result",
      width: 100,
      render: (v: string) => (
        <Tag color={results[v]?.[1]}>{results[v]?.[0] || v}</Tag>
      ),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 100,
      render: (v: string) => (
        <Tag color={statuses[v]?.[1]}>{statuses[v]?.[0] || v}</Tag>
      ),
    },
    { title: t("mrp.quality.inspector"), dataIndex: "inspector", width: 100 },
    {
      title: t("common.actions"),
      fixed: "right",
      width: 170,
      render: (_: unknown, r: Inspection) => (
        <Space size={4}>
          <Button type="link" onClick={() => inspect(r)}>
            {r.status === "completed"
              ? t("mrp.quality.reInspect")
              : t("mrp.quality.inspect")}
          </Button>
          {r.status === "completed" && (
            <Button type="link" onClick={() => void moveStock(r)}>
              {t("mrp.quality.moveStock")}
            </Button>
          )}
        </Space>
      ),
    },
  ];
  return (
    <Card variant="borderless" size="small">
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t("mrp.quality.pendingTasks")}
              value={rows.filter((r) => r.status === "pending").length}
              prefix={<ExperimentOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t("mrp.quality.completedTasks")}
              value={rows.filter((r) => r.status === "completed").length}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title={t("mrp.quality.unqualifiedOrConcession")}
              value={
                rows.filter((r) =>
                  ["unqualified", "conditional"].includes(r.result),
                ).length
              }
              valueStyle={{ color: "#cf1322" }}
            />
          </Card>
        </Col>
      </Row>
      <Card
        title={t("mrp.quality.title")}
        extra={
          <Space>
            <Input
              prefix={<SearchOutlined />}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("mrp.quality.searchPlaceholder")}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setSourceType("purchase_receipt");
                createForm.setFieldsValue({
                  inspection_no: `IQC${dayjs().format("YYYYMMDDHHmmss")}`,
                  inspection_date: dayjs(),
                });
                setCreateOpen(true);
              }}
            >
              {t("mrp.quality.addTask")}
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1150 }}
        />
      </Card>
      <SimpleModal
        title={t("mrp.quality.addTask")}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={create}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.quality.inspectionNo")}
                name="inspection_no"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.quality.inspectionDate")}
                name="inspection_date"
                rules={[{ required: true }]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("mrp.quality.sourceType")}>
            <Select
              value={sourceType}
              onChange={setSourceType}
              options={Object.entries(sourceNames).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
          <Form.Item
            label={t("mrp.quality.sourceDetail")}
            name="sourceKey"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={sources.map((s) => ({ value: s.key, label: s.label }))}
              placeholder={
                sources.length
                  ? t("mrp.quality.selectSourceDetail")
                  : t("mrp.quality.noAvailableSource")
              }
            />
          </Form.Item>
          <Form.Item
            label={t("mrp.quality.sampleQuantity")}
            name="sample_quantity"
          >
            <InputNumber
              min={0.0001}
              style={{ width: "100%" }}
              placeholder={t("mrp.quality.defaultFullInspection")}
            />
          </Form.Item>
          <Form.Item label={t("mrp.quality.remark")} name="remark">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
      <SimpleModal
        title={t("mrp.quality.inspectRecord", {
          inspectionNo: current?.inspection_no || "",
        })}
        width={760}
        open={inspectOpen}
        onCancel={() => setInspectOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setInspectOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                inspectForm.validateFields().then((v) => save(v, false))
              }
            >
              {t("mrp.quality.saveTemp")}
            </Button>
            <Button
              type="primary"
              onClick={() =>
                inspectForm.validateFields().then((v) => save(v, true))
              }
            >
              {t("mrp.quality.completeInspection")}
            </Button>
          </Space>
        }
      >
        <Form form={inspectForm} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                label={t("mrp.quality.sampleQuantity")}
                name="sample_quantity"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.quality.qualifiedQuantity")}
                name="qualified_quantity"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.quality.unqualifiedQuantity")}
                name="unqualified_quantity"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.quality.inspector")}
                name="inspector"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.quality.disposition")}
                name="disposition"
              >
                <Select allowClear options={dispositions} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("mrp.quality.inspectionRemark")} name="remark">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}
