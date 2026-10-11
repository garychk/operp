/**
 * 物料计划参数（P0-4 · deploy_114）
 *
 * 为什么单开一页而不塞进物料主数据弹窗：
 *   `lot_policy / min_order_qty / order_multiple / order_point / max_order_qty`
 *   这几列在 deploy_114 之前**没有任何前端入口**（`erp_products` 建表时留了字段，
 *   但物料页只维护 safety_stock / max_stock）—— 也就是 MRP 引擎读的参数，
 *   计划员改不了。缺了这一页，max_qty / 订货点 / 提前期这些能力全是死代码。
 *
 * 口径（与 mrpEngine.ts 一一对应）：
 *   - 订货点 > 0 → 启用订货点补货，补到「最高库存」（未维护则补到订货点），
 *     此时安全库存并入目标水位，不再单独生成安全库存需求；
 *   - 批量规则 max_qty 必须同时维护「最大批量」，否则引擎退化为逐批补充并告警；
 *   - 提前期按工作日倒推，前提是「工作日历」页有一个默认且启用的日历。
 */
import { useEffect, useMemo, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  message,
} from "antd";
import { EditOutlined, SettingOutlined } from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

const productTable = "erp_products_s_539dcf81_b";

/** MRP 计划参数子集（src/types/database.ts 的生成类型早于 deploy_114，未含这些列） */
export interface PlanningParamRow {
  id: number;
  code: string;
  name: string;
  specification: string | null;
  unit: string | null;
  is_purchased: boolean | null;
  is_manufactured: boolean | null;
  is_mrp_relevant: boolean | null;
  safety_stock: number | null;
  min_stock: number | null;
  max_stock: number | null;
  order_point: number | null;
  lead_time_purchase: number | null;
  lead_time_production: number | null;
  lot_policy: string | null;
  min_order_qty: number | null;
  order_multiple: number | null;
  max_order_qty: number | null;
}

const LOT_POLICIES = ["lot_for_lot", "fixed_qty", "multiples", "max_qty"] as const;
type LotPolicyValue = (typeof LOT_POLICIES)[number];

/** 批量设置里允许统一修改的字段（数值型） */
const BATCH_FIELDS = [
  "safety_stock",
  "min_stock",
  "max_stock",
  "order_point",
  "lead_time_purchase",
  "lead_time_production",
  "min_order_qty",
  "order_multiple",
  "max_order_qty",
] as const;

/** 批量设置字段 → i18n 键后缀（避免一长串嵌套三元） */
const BATCH_FIELD_LABEL_KEY: Record<(typeof BATCH_FIELDS)[number], string> = {
  safety_stock: "safetyStock",
  min_stock: "minStock",
  max_stock: "maxStock",
  order_point: "orderPoint",
  lead_time_purchase: "leadTimePurchase",
  lead_time_production: "leadTimeProduction",
  min_order_qty: "minOrderQty",
  order_multiple: "orderMultiple",
  max_order_qty: "maxOrderQty",
};

export function PlanningParams() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PlanningParamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [editing, setEditing] = useState<PlanningParamRow | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [form] = Form.useForm();
  const [batchForm] = Form.useForm();

  useEffect(() => {
    void fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRows = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(productTable)
        .select(
          [
            "id",
            "code",
            "name",
            "specification",
            "unit",
            "is_purchased",
            "is_manufactured",
            "is_mrp_relevant",
            "safety_stock",
            "min_stock",
            "max_stock",
            "order_point",
            "lead_time_purchase",
            "lead_time_production",
            "lot_policy",
            "min_order_qty",
            "order_multiple",
            "max_order_qty",
          ].join(", "),
        )
        .eq("is_deleted", "n")
        .order("code", { ascending: true });
      if (error) throw error;
      setRows((data || []) as unknown as PlanningParamRow[]);
    } catch (error) {
      console.error("Error fetching planning params:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const lotPolicyLabels: Record<string, string> = {
    lot_for_lot: t("mrp.planningParams.lotPolicyLotForLot"),
    fixed_qty: t("mrp.planningParams.lotPolicyFixedQty"),
    multiples: t("mrp.planningParams.lotPolicyMultiples"),
    max_qty: t("mrp.planningParams.lotPolicyMaxQty"),
  };

  /** 参与 MRP：null 表示跟随物料属性（采购件或制造件都算参与） */
  const isRelevant = (row: PlanningParamRow) =>
    row.is_mrp_relevant === null || row.is_mrp_relevant === undefined
      ? Boolean(row.is_purchased || row.is_manufactured)
      : Boolean(row.is_mrp_relevant);

  const filtered = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    return rows.filter((row) => {
      if (onlyRelevant && !isRelevant(row)) return false;
      if (!kw) return true;
      return (
        row.code.toLowerCase().includes(kw) ||
        row.name.toLowerCase().includes(kw) ||
        (row.specification || "").toLowerCase().includes(kw)
      );
    });
  }, [rows, searchTerm, onlyRelevant]);

  const handleEdit = (record: PlanningParamRow) => {
    setEditing(record);
    form.setFieldsValue({
      is_mrp_relevant:
        record.is_mrp_relevant === null || record.is_mrp_relevant === undefined
          ? "inherit"
          : record.is_mrp_relevant
            ? "yes"
            : "no",
      safety_stock: record.safety_stock ?? 0,
      min_stock: record.min_stock ?? 0,
      max_stock: record.max_stock ?? 0,
      order_point: record.order_point ?? 0,
      lot_policy: (record.lot_policy || "lot_for_lot") as LotPolicyValue,
      min_order_qty: record.min_order_qty ?? 0,
      order_multiple: record.order_multiple ?? 0,
      max_order_qty: record.max_order_qty ?? 0,
      lead_time_purchase: record.lead_time_purchase ?? 0,
      lead_time_production: record.lead_time_production ?? 0,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!editing) return;
    const patch = {
      is_mrp_relevant:
        values.is_mrp_relevant === "inherit" ? null : values.is_mrp_relevant === "yes",
      safety_stock: values.safety_stock ?? 0,
      min_stock: values.min_stock ?? 0,
      max_stock: values.max_stock ?? 0,
      order_point: values.order_point ?? 0,
      lot_policy: values.lot_policy ?? "lot_for_lot",
      min_order_qty: values.min_order_qty ?? 0,
      order_multiple: values.order_multiple ?? 0,
      max_order_qty: values.max_order_qty ?? 0,
      lead_time_purchase: values.lead_time_purchase ?? 0,
      lead_time_production: values.lead_time_production ?? 0,
    };

    try {
      setSaving(true);
      await logWithTiming(t("mrp.planningParams.logUpdate"), "UPDATE", async () => {
        const { error } = await supabase
          .from(productTable)
          .update(patch)
          .eq("id", editing.id);
        if (error) throw error;
      });
      message.success(t("mrp.planningParams.saveSuccess"));
      setIsModalOpen(false);
      form.resetFields();
      setEditing(null);
      await fetchRows();
    } catch (error) {
      console.error("Error saving planning params:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleBatchSubmit = async (values: Record<string, unknown>) => {
    const ids = selectedRowKeys.map((k) => Number(k)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) {
      message.warning(t("mrp.planningParams.selectFirst"));
      return;
    }
    // 只把「填了值」的字段写下去：留空 = 保持原值，避免批量把别人维护的参数清零
    const patch: Record<string, number> = {};
    for (const field of BATCH_FIELDS) {
      const value = values[field];
      if (value === undefined || value === null) continue;
      patch[field] = value as number;
    }
    if (Object.keys(patch).length === 0) {
      message.warning(t("mrp.planningParams.batchEmpty"));
      return;
    }

    try {
      setSaving(true);
      await logWithTiming(t("mrp.planningParams.logBatchUpdate"), "UPDATE", async () => {
        const { error } = await supabase.from(productTable).update(patch).in("id", ids);
        if (error) throw error;
      });
      message.success(t("mrp.planningParams.batchSuccess", { count: ids.length }));
      setIsBatchOpen(false);
      batchForm.resetFields();
      setSelectedRowKeys([]);
      await fetchRows();
    } catch (error) {
      console.error("Error batch updating planning params:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const nonNegative = { type: "number" as const, min: 0, message: t("mrp.planningParams.nonNegative") };

  const num = (value: number | null | undefined) => (value ?? 0).toLocaleString();

  const columns: SuperTableColumn<PlanningParamRow>[] = [
    { title: t("common.code"), dataIndex: "code", key: "code", width: 130 },
    { title: t("common.name"), dataIndex: "name", key: "name", width: 180 },
    {
      title: t("mrp.planningParams.mrpRelevant"),
      dataIndex: "is_mrp_relevant",
      key: "is_mrp_relevant",
      width: 100,
      align: "center",
      render: (_: unknown, record: PlanningParamRow) =>
        isRelevant(record) ? (
          <Tag color="success">{t("common.yes")}</Tag>
        ) : (
          <Tag>{t("common.no")}</Tag>
        ),
    },
    {
      title: t("mrp.planningParams.safetyStock"),
      dataIndex: "safety_stock",
      key: "safety_stock",
      width: 110,
      align: "right",
      render: (v: number | null) => num(v),
    },
    {
      title: t("mrp.planningParams.orderPoint"),
      dataIndex: "order_point",
      key: "order_point",
      width: 110,
      align: "right",
      render: (v: number | null) =>
        (v ?? 0) > 0 ? <Tag color="blue">{num(v)}</Tag> : num(v),
    },
    {
      title: t("mrp.planningParams.maxStock"),
      dataIndex: "max_stock",
      key: "max_stock",
      width: 110,
      align: "right",
      render: (v: number | null) => num(v),
    },
    {
      title: t("mrp.planningParams.lotPolicy"),
      dataIndex: "lot_policy",
      key: "lot_policy",
      width: 120,
      render: (v: string | null) => lotPolicyLabels[v || "lot_for_lot"] || v,
    },
    {
      title: t("mrp.planningParams.minOrderQty"),
      dataIndex: "min_order_qty",
      key: "min_order_qty",
      width: 110,
      align: "right",
      render: (v: number | null) => num(v),
    },
    {
      title: t("mrp.planningParams.orderMultiple"),
      dataIndex: "order_multiple",
      key: "order_multiple",
      width: 110,
      align: "right",
      render: (v: number | null) => num(v),
    },
    {
      title: t("mrp.planningParams.maxOrderQty"),
      dataIndex: "max_order_qty",
      key: "max_order_qty",
      width: 110,
      align: "right",
      // max_qty 规则却没维护上限 → 引擎会退化为逐批，标出来让计划员顺手补上
      render: (v: number | null, record: PlanningParamRow) =>
        (v ?? 0) > 0 ? (
          num(v)
        ) : record.lot_policy === "max_qty" ? (
          <Tag color="orange">0</Tag>
        ) : (
          num(v)
        ),
    },
    {
      title: t("mrp.planningParams.leadTimePurchase"),
      dataIndex: "lead_time_purchase",
      key: "lead_time_purchase",
      width: 120,
      align: "center",
      render: (v: number | null) =>
        t("mrp.planningParams.leadTimeUnit", { days: v ?? 0 }),
    },
    {
      title: t("mrp.planningParams.leadTimeProduction"),
      dataIndex: "lead_time_production",
      key: "lead_time_production",
      width: 120,
      align: "center",
      render: (v: number | null) =>
        t("mrp.planningParams.leadTimeUnit", { days: v ?? 0 }),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 120,
      fixed: "right",
      render: (_: unknown, record: PlanningParamRow) => (
        <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
          {t("common.edit")}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="mrp-planning-params"
        headerTitle={t("mrp.planningParams.title")}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button
              type="primary"
              icon={<SettingOutlined />}
              disabled={selectedRowKeys.length === 0}
              onClick={() => {
                batchForm.resetFields();
                setIsBatchOpen(true);
              }}
            >
              {t("mrp.planningParams.batchApply")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.planningParams.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: 260 }}
            />
            <Space size={4}>
              <Switch checked={onlyRelevant} onChange={setOnlyRelevant} size="small" />
              <span>{t("mrp.planningParams.onlyRelevant")}</span>
            </Space>
          </Space>
        }
      />

      <SimpleModal
        title={`${t("mrp.planningParams.edit")} - ${editing?.code ?? ""} ${editing?.name ?? ""}`}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditing(null);
        }}
        width={760}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
                form.resetFields();
                setEditing(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" loading={saving} onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        <Card size="small">
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.mrpRelevant")}
                  name="is_mrp_relevant"
                  initialValue="inherit"
                >
                  <Select
                    options={[
                      { value: "inherit", label: t("mrp.planningParams.mrpRelevantInherit") },
                      { value: "yes", label: t("common.yes") },
                      { value: "no", label: t("common.no") },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.orderPoint")}
                  name="order_point"
                  rules={[nonNegative]}
                  extra={t("mrp.planningParams.orderPointHint")}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.safetyStock")}
                  name="safety_stock"
                  rules={[nonNegative]}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.planningParams.minStock")} name="min_stock" rules={[nonNegative]}>
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item label={t("mrp.planningParams.maxStock")} name="max_stock" rules={[nonNegative]}>
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.planningParams.lotPolicy")} name="lot_policy" initialValue="lot_for_lot">
                  <Select
                    options={LOT_POLICIES.map((value) => ({ value, label: lotPolicyLabels[value] }))}
                  />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.minOrderQty")}
                  name="min_order_qty"
                  rules={[nonNegative]}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.orderMultiple")}
                  name="order_multiple"
                  rules={[nonNegative]}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.maxOrderQty")}
                  name="max_order_qty"
                  rules={[nonNegative]}
                  extra={t("mrp.planningParams.maxOrderQtyHint")}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.leadTimePurchase")}
                  name="lead_time_purchase"
                  rules={[nonNegative]}
                  extra={t("mrp.planningParams.leadTimeHint")}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item
                  label={t("mrp.planningParams.leadTimeProduction")}
                  name="lead_time_production"
                  rules={[nonNegative]}
                >
                  <InputNumber style={{ width: "100%" }} min={0} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </SimpleModal>

      <SimpleModal
        title={t("mrp.planningParams.batchTitle")}
        open={isBatchOpen}
        onCancel={() => {
          setIsBatchOpen(false);
          batchForm.resetFields();
        }}
        width={760}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsBatchOpen(false);
                batchForm.resetFields();
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" loading={saving} onClick={() => batchForm.submit()}>
              {t("mrp.planningParams.batchApply")}
            </Button>
          </Space>
        }
      >
        <Card size="small">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("mrp.planningParams.batchHint")}
            description={t("mrp.planningParams.selectedCount", { count: selectedRowKeys.length })}
          />
          <Form form={batchForm} layout="vertical" onFinish={handleBatchSubmit}>
            <Row gutter={16}>
              {BATCH_FIELDS.map((field) => (
                <Col span={12} key={field}>
                  <Form.Item
                    label={t(`mrp.planningParams.${BATCH_FIELD_LABEL_KEY[field]}`)}
                    name={field}
                    rules={[nonNegative]}
                  >
                    <InputNumber style={{ width: "100%" }} min={0} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </Form>
        </Card>
      </SimpleModal>
    </div>
  );
}

export default PlanningParams;
