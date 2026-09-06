import { useEffect, useMemo, useState } from "react";
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
import SimpleModal from "@/components/SimpleModal";

type SourceType = "purchase_receipt" | "sales_return" | "production_operation";
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
const sourceNames: Record<SourceType, string> = {
  purchase_receipt: "采购收货",
  sales_return: "销售退货",
  production_operation: "工序完工",
};
const results: Record<string, [string, string]> = {
  pending: ["待判定", "default"],
  qualified: ["合格", "success"],
  unqualified: ["不合格", "error"],
  conditional: ["让步接收", "warning"],
};
const statuses: Record<string, [string, string]> = {
  pending: ["待检", "gold"],
  inspecting: ["检验中", "processing"],
  completed: ["已完成", "success"],
  cancelled: ["已取消", "default"],
};
const dispositions = [
  ["accept", "接收"],
  ["return", "退货"],
  ["rework", "返工"],
  ["scrap", "报废"],
  ["concession", "让步接收"],
  ["sort", "挑选"],
].map(([value, label]) => ({ value, label }));

export function QualityInspections() {
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
      message.error(
        "获取检验数据失败，请先执行 deploy_10_quality_inspection.sql",
      );
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
      message.error("获取来源单据失败");
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
        "新增检验任务",
        "INSERT",
        async () => {
          const { error } = await supabase
            .from("erp_quality_inspections_s_539dcf81_b")
            .insert(payload);
          if (error) throw error;
        },
        { table: "erp_quality_inspections_s_539dcf81_b" },
      );
      message.success("检验任务已创建");
      setCreateOpen(false);
      createForm.resetFields();
      void load();
    } catch (e: any) {
      message.error(
        e?.code === "23505" ? "该来源明细已存在检验任务" : "创建失败",
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
  const save = async (v: any, complete: boolean) => {
    if (!current) return;
    const sample = Number(v.sample_quantity),
      good = Number(v.qualified_quantity),
      bad = Number(v.unqualified_quantity);
    if (good + bad !== sample)
      return void message.error("合格数量与不合格数量之和必须等于抽样数量");
    if (sample > current.inspection_quantity)
      return void message.error("抽样数量不能超过报检数量");
    if (complete && bad > 0 && !v.disposition)
      return void message.error("存在不合格时必须选择处置方式");
    const result =
      bad === 0
        ? "qualified"
        : v.disposition === "concession"
          ? "conditional"
          : "unqualified";
    try {
      await logWithTiming(
        complete ? "完成质量检验" : "保存质量检验",
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
      message.success(complete ? "检验已完成" : "已暂存");
      setInspectOpen(false);
      void load();
    } catch {
      message.error("保存失败");
    }
  };
  const filtered = rows.filter((r) =>
    `${r.inspection_no}${r.source_no || ""}${productMap.get(r.product_id)?.name || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const columns: any[] = [
    {
      title: "检验单号",
      dataIndex: "inspection_no",
      fixed: "left",
      width: 160,
    },
    {
      title: "来源",
      dataIndex: "source_type",
      width: 110,
      render: (v: SourceType) => <Tag>{sourceNames[v]}</Tag>,
    },
    { title: "来源单号", dataIndex: "source_no", width: 150 },
    {
      title: "物料",
      dataIndex: "product_id",
      width: 190,
      render: (v: number) => {
        const p = productMap.get(v);
        return p ? `${p.code} - ${p.name}` : "-";
      },
    },
    {
      title: "报检/抽样",
      width: 130,
      render: (_: unknown, r: Inspection) =>
        `${r.inspection_quantity} / ${r.sample_quantity}`,
    },
    {
      title: "结论",
      dataIndex: "result",
      width: 100,
      render: (v: string) => (
        <Tag color={results[v]?.[1]}>{results[v]?.[0] || v}</Tag>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => (
        <Tag color={statuses[v]?.[1]}>{statuses[v]?.[0] || v}</Tag>
      ),
    },
    { title: "检验员", dataIndex: "inspector", width: 100 },
    {
      title: "操作",
      fixed: "right",
      width: 90,
      render: (_: unknown, r: Inspection) => (
        <Button type="link" onClick={() => inspect(r)}>
          {r.status === "completed" ? "复检" : "检验"}
        </Button>
      ),
    },
  ];
  return (
    <Card className='mainContent' variant="borderless" size="small">
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="待检任务"
              value={rows.filter((r) => r.status === "pending").length}
              prefix={<ExperimentOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="已完成"
              value={rows.filter((r) => r.status === "completed").length}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic
              title="不合格/让步"
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
        title="检验管理"
        extra={
          <Space>
            <Input
              prefix={<SearchOutlined />}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="检验单号、来源、物料"
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
              创建检验任务
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
        title="创建检验任务"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={create}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="检验单号"
                name="inspection_no"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="检验日期"
                name="inspection_date"
                rules={[{ required: true }]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="来源类型">
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
            label="来源明细"
            name="sourceKey"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={sources.map((s) => ({ value: s.key, label: s.label }))}
              placeholder={sources.length ? "请选择来源明细" : "暂无可检验来源"}
            />
          </Form.Item>
          <Form.Item label="抽样数量" name="sample_quantity">
            <InputNumber
              min={0.0001}
              style={{ width: "100%" }}
              placeholder="默认全部检验"
            />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
      <SimpleModal
        title={`${current?.inspection_no || ""} - 检验记录`}
        width={760}
        open={inspectOpen}
        onCancel={() => setInspectOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setInspectOpen(false)}>取消</Button>
            <Button
              onClick={() =>
                inspectForm.validateFields().then((v) => save(v, false))
              }
            >
              暂存
            </Button>
            <Button
              type="primary"
              onClick={() =>
                inspectForm.validateFields().then((v) => save(v, true))
              }
            >
              完成检验
            </Button>
          </Space>
        }
      >
        <Form form={inspectForm} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                label="抽样数量"
                name="sample_quantity"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="合格数量"
                name="qualified_quantity"
                rules={[{ required: true }]}
              >
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="不合格数量"
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
                label="检验员"
                name="inspector"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="不合格处置" name="disposition">
                <Select allowClear options={dispositions} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="检验备注" name="remark">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}
