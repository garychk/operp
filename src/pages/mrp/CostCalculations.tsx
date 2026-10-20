import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Space,
  message,
  DatePicker,
  Alert,
  Tag,
  Statistic,
  Row,
  Col,
  Card,
  Tabs,
  Form,
  Input,
  InputNumber,
  Select,
  Modal,
  Tooltip,
} from "antd";
import {
  CalculatorOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  StopOutlined,
  ProfileOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import { useAuth } from "../../contexts/AuthContext";
import { resolveMrpApiBaseUrl, aiServerAuthHeaders } from "../../utils/aiServer";
import { formatMoney, formatQuantity, useCurrencyRegistry } from "../../utils/money";
import { supabase } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

/* ==========================================================================
 * 类型
 * ========================================================================== */

interface CostRow {
  productId: number;
  productCode: string;
  productName: string;
  beginningWip: number;
  currentMaterial: number;
  currentLabor: number;
  currentOverhead: number;
  totalCost: number;
  finishedQuantity: number;
  unitCost: number;
  endingWip: number;
}

interface RollupResponse {
  ok: boolean;
  error?: string;
  dryRun?: boolean;
  periodId?: number;
  rows?: CostRow[];
  warnings?: string[];
  totals?: {
    material: number;
    labor: number;
    overhead: number;
    total: number;
    finishedQuantity: number;
  };
}

interface ProductOption {
  id: number;
  code: string;
  name: string;
  unit: string | null;
}

/** erp_standard_costs 行（生成列 standard_total_cost 只读） */
interface StandardCostRow {
  id: number;
  standard_cost_no: string;
  product_id: number;
  version: string;
  effective_date: string;
  status: "draft" | "active" | "inactive";
  standard_material_cost: number;
  standard_labor_cost: number;
  standard_overhead_cost: number;
  standard_total_cost: number;
  source: "manual" | "bom_rollup";
  bom_id: number | null;
  routing_id: number | null;
  remark: string | null;
}

interface StandardCostLine {
  id: number;
  material_id: number;
  line_no: number;
  standard_quantity: number;
  loss_rate: number;
  standard_price: number;
  standard_amount: number;
}

interface VarianceRow {
  order_id: number;
  order_no: string;
  order_date: string;
  order_status: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  completed_quantity: number;
  has_standard_cost: boolean;
  standard_cost_id: number | null;
  standard_version: string | null;
  standard_material: number;
  standard_labor: number;
  standard_overhead: number;
  standard_total: number;
  actual_material: number;
  actual_labor: number;
  actual_overhead: number;
  actual_total: number;
  material_variance: number;
  labor_variance: number;
  overhead_variance: number;
  total_variance: number;
  total_variance_rate: number;
}

interface MaterialVarianceRow {
  material_id: number;
  material_code: string | null;
  material_name: string | null;
  unit: string | null;
  standard_quantity: number;
  standard_price: number;
  standard_amount: number;
  actual_quantity: number;
  actual_amount: number;
  actual_price: number;
  price_variance: number;
  usage_variance: number;
  total_variance: number;
}

const STANDARD_COST_TABLE = "erp_standard_costs_s_539dcf81_b";
const STANDARD_COST_LINE_TABLE = "erp_standard_cost_materials_s_539dcf81_b";

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 差异的正负配色：这是财务口径（超支=红/不利，节约=绿/有利），与股市红涨绿跌无关 */
const varianceColor = (v: number) => (v > 0 ? "#cf1322" : v < 0 ? "#389e0d" : undefined);
const renderVariance = (v: unknown) => {
  const n = num(v);
  return <span style={{ color: varianceColor(n) }}>{formatMoney(n)}</span>;
};

/* ==========================================================================
 * 页签一：实际成本卷算（原有能力，逻辑不动）
 * ========================================================================== */

function ActualCostTab() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { getMeta } = useCurrencyRegistry();
  const baseMeta = getMeta();
  const baseCurrencySymbol = baseMeta.symbol;
  const baseDecimalPlaces = baseMeta.decimalPlaces;
  const [monthValue, setMonthValue] = useState<Dayjs>(dayjs());
  const [rows, setRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [periodMissing, setPeriodMissing] = useState(false);

  const year = monthValue.year();
  const month = monthValue.month() + 1;

  const fetchRows = useCallback(async () => {
    if (!user?.profile.id || !user?.tenantId) return;
    try {
      setLoading(true);
      const params = new URLSearchParams({
        user_id: String(user.profile.id),
        tenant_id: String(user.tenantId),
        year: String(year),
        month: String(month),
      });
      const response = await fetch(`${resolveMrpApiBaseUrl()}/cost?${params.toString()}`, {
        headers: await aiServerAuthHeaders(),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        period_id?: number | null;
        rows?: CostRow[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setRows(data.rows || []);
      setPeriodMissing(!data.period_id);
    } catch (error) {
      console.error("Error fetching cost rows:", error);
      message.error(`${t("mrp.costCalculations.fetchFailed")}：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [user?.profile.id, user?.tenantId, year, month, t]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const callRollup = async (dryRun: boolean) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t("auth.noTenantAssigned"));
      return;
    }
    try {
      if (dryRun) setPreviewing(true);
      else setComputing(true);

      const response = await fetch(`${resolveMrpApiBaseUrl()}/cost-rollup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await aiServerAuthHeaders()),
        },
        body: JSON.stringify({
          user_id: user.profile.id,
          tenant_id: user.tenantId,
          year,
          month,
          dry_run: dryRun,
        }),
      });
      const data = (await response.json()) as RollupResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const rollupWarnings = data.warnings || [];
      setWarnings(rollupWarnings);
      showRollupResult(data, dryRun);

      if (!dryRun) await fetchRows();
    } catch (error) {
      console.error("Error rolling up production cost:", error);
      message.error(`${t("mrp.costCalculations.rollupFailed")}：${(error as Error).message}`);
    } finally {
      setPreviewing(false);
      setComputing(false);
    }
  };

  const showRollupResult = (data: RollupResponse, dryRun: boolean) => {
    const total = data.totals?.total ?? 0;
    const count = data.rows?.length ?? 0;
    if (dryRun) {
      message.info(t("mrp.costCalculations.previewDone", { count, total: formatMoney(total) }));
      return;
    }
    message.success(t("mrp.costCalculations.rollupDone", { count, total: formatMoney(total) }));
  };

  // 服务端返回的告警是「结构性事实」的机器码，映射到 i18n 标签；未知码回退原样
  const warningLabel = (code: string) => {
    const [name, ...rest] = code.split(":");
    const key = `mrp.costCalculations.warn.${name}`;
    if (!i18n.exists(key)) return code;
    return rest.length > 0 ? t(key, { detail: rest.join(":") }) : t(key);
  };

  const totals = {
    material: rows.reduce((s, r) => s + r.currentMaterial, 0),
    labor: rows.reduce((s, r) => s + r.currentLabor, 0),
    overhead: rows.reduce((s, r) => s + r.currentOverhead, 0),
    total: rows.reduce((s, r) => s + r.totalCost, 0),
    finished: rows.reduce((s, r) => s + r.finishedQuantity, 0),
    endingWip: rows.reduce((s, r) => s + r.endingWip, 0),
  };

  const columns = [
    {
      title: t("mrp.costCalculations.product"),
      dataIndex: "productCode",
      key: "productCode",
      render: (_: unknown, record: CostRow) =>
        record.productName ? `${record.productCode} - ${record.productName}` : record.productCode,
    },
    {
      title: t("mrp.costCalculations.beginningWip"),
      dataIndex: "beginningWip",
      key: "beginningWip",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t("mrp.costCalculations.material"),
      dataIndex: "currentMaterial",
      key: "currentMaterial",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t("mrp.costCalculations.labor"),
      dataIndex: "currentLabor",
      key: "currentLabor",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t("mrp.costCalculations.overhead"),
      dataIndex: "currentOverhead",
      key: "currentOverhead",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t("mrp.costCalculations.totalCost"),
      dataIndex: "totalCost",
      key: "totalCost",
      align: "right" as const,
      render: (v: number) => <strong>{formatMoney(v)}</strong>,
    },
    {
      title: t("mrp.costCalculations.finishedQuantity"),
      dataIndex: "finishedQuantity",
      key: "finishedQuantity",
      align: "right" as const,
      render: (v: number) => formatQuantity(v),
    },
    {
      title: t("mrp.costCalculations.unitCost"),
      dataIndex: "unitCost",
      key: "unitCost",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t("mrp.costCalculations.endingWip"),
      dataIndex: "endingWip",
      key: "endingWip",
      align: "right" as const,
      render: (v: number) => formatMoney(v),
    },
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.material")}
              value={totals.material}
              precision={baseDecimalPlaces}
              prefix={baseCurrencySymbol}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.labor")}
              value={totals.labor}
              precision={baseDecimalPlaces}
              prefix={baseCurrencySymbol}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.overhead")}
              value={totals.overhead}
              precision={baseDecimalPlaces}
              prefix={baseCurrencySymbol}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.totalCost")}
              value={totals.total}
              precision={baseDecimalPlaces}
              prefix={baseCurrencySymbol}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.endingWip")}
              value={totals.endingWip}
              precision={baseDecimalPlaces}
              prefix={baseCurrencySymbol}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.finishedQuantity")}
              value={totals.finished}
              precision={2}
            />
          </Col>
        </Row>
      </Card>

      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.costCalculations.warningsTitle")}
          description={
            <Space wrap>
              {warnings.map((code) => (
                <Tag key={code} color="orange">
                  {warningLabel(code)}
                </Tag>
              ))}
            </Space>
          }
        />
      )}

      {periodMissing && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.costCalculations.periodMissing")}
        />
      )}

      <SuperTable
        columns={columns}
        dataSource={rows}
        rowKey="productId"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="cost-calculations"
        headerTitle={t("mrp.costCalculations.title")}
        queryBar={
          <Space wrap>
            <DatePicker
              picker="month"
              value={monthValue}
              onChange={(value) => value && setMonthValue(value)}
              allowClear={false}
            />
            <Button
              type="primary"
              icon={<CalculatorOutlined />}
              loading={computing}
              onClick={() => callRollup(false)}
            >
              {t("mrp.costCalculations.rollup")}
            </Button>
            <Button
              icon={<ExperimentOutlined />}
              loading={previewing}
              onClick={() => callRollup(true)}
            >
              {t("mrp.costCalculations.preview")}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchRows}>
              {t("mrp.costCalculations.refresh")}
            </Button>
          </Space>
        }
      />
    </div>
  );
}

/* ==========================================================================
 * 页签二：标准成本（产品 × 版本）
 *
 * 口径（与 deploy_111/112 一致）：
 *   · 标准价取 erp_products.cost_price（不是移动加权实际价）
 *   · 材料明细的「标准用量」**已含损耗**，来源 BOM 用量 × (1+损耗率)
 *   · 合计是数据库生成列，前端只写材料/人工/制费三个要素
 *   · 每产品至多一个 active 版本；active 版本不允许被卷算覆盖
 * ========================================================================== */

function StandardCostTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rows, setRows] = useState<StandardCostRow[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isRollupOpen, setIsRollupOpen] = useState(false);
  const [editing, setEditing] = useState<StandardCostRow | null>(null);
  const [linesFor, setLinesFor] = useState<StandardCostRow | null>(null);
  const [lines, setLines] = useState<StandardCostLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [form] = Form.useForm();
  const [rollupForm] = Form.useForm();

  const productById = useMemo(() => {
    const m = new Map<number, ProductOption>();
    products.forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const [sc, pd] = await Promise.all([
        supabase
          .from(STANDARD_COST_TABLE)
          .select("*")
          .eq("is_deleted", "n")
          .order("created_at", { ascending: false }),
        supabase
          .from("erp_products_s_539dcf81_b")
          .select("id, code, name, unit")
          .eq("is_deleted", "n")
          .order("code"),
      ]);
      if (sc.error) throw sc.error;
      if (pd.error) throw pd.error;
      setRows((sc.data || []) as StandardCostRow[]);
      setProducts((pd.data || []) as ProductOption[]);
    } catch (error) {
      console.error("Error fetching standard costs:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const productLabel = (record: StandardCostRow) => {
    const p = productById.get(record.product_id);
    return p ? `${p.code} - ${p.name}` : String(record.product_id);
  };

  /** 只提交可写列 —— standard_total_cost 是生成列，带上会被数据库拒绝 */
  const buildPayload = (values: Record<string, unknown>) => ({
    standard_cost_no: values.standard_cost_no,
    product_id: values.product_id,
    version: values.version,
    effective_date: (values.effective_date as Dayjs).format("YYYY-MM-DD"),
    status: values.status,
    standard_material_cost: num(values.standard_material_cost),
    standard_labor_cost: num(values.standard_labor_cost),
    standard_overhead_cost: num(values.standard_overhead_cost),
    remark: values.remark ?? null,
  });

  const handleAdd = async () => {
    setEditing(null);
    form.resetFields();
    let standardCostNo = "";
    try {
      // 编号拿不到就不开弹窗（失败不降级，见 documentNaming.ts 注释）
      standardCostNo = await nextDocumentNo("standard_cost");
    } catch (error) {
      message.error(`${t("mrp.standardCosts.noNumber")}：${(error as Error).message}`);
      return;
    }
    form.setFieldsValue({
      standard_cost_no: standardCostNo,
      version: "V1",
      effective_date: dayjs(),
      status: "draft",
      standard_material_cost: 0,
      standard_labor_cost: 0,
      standard_overhead_cost: 0,
    });
    setIsModalOpen(true);
  };

  const handleEdit = (record: StandardCostRow) => {
    setEditing(record);
    form.setFieldsValue({
      standard_cost_no: record.standard_cost_no,
      product_id: record.product_id,
      version: record.version,
      effective_date: dayjs(record.effective_date),
      status: record.status,
      standard_material_cost: num(record.standard_material_cost),
      standard_labor_cost: num(record.standard_labor_cost),
      standard_overhead_cost: num(record.standard_overhead_cost),
      remark: record.remark,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      setSaving(true);
      const payload = buildPayload(values);
      if (editing) {
        await logWithTiming(
          t("mrp.standardCosts.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(STANDARD_COST_TABLE)
              .update({ ...payload, updated_at: new Date().toISOString() })
              .eq("id", editing.id);
            if (error) throw error;
          },
          { table: STANDARD_COST_TABLE, recordId: editing.id, document_no: payload.standard_cost_no },
        );
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(
          t("mrp.standardCosts.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase.from(STANDARD_COST_TABLE).insert([payload]);
            if (error) throw error;
          },
          { table: STANDARD_COST_TABLE, document_no: payload.standard_cost_no },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      setEditing(null);
      form.resetFields();
      fetchAll();
    } catch (error) {
      console.error("Error saving standard cost:", error);
      message.error(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  /** 生效：每产品至多一个 active（部分唯一索引兜底），冲突要给可读提示而不是抛库错 */
  const changeStatus = async (record: StandardCostRow, status: StandardCostRow["status"]) => {
    try {
      await logWithTiming(
        status === "active" ? t("mrp.standardCosts.logActivate") : t("mrp.standardCosts.logDeactivate"),
        "UPDATE",
        async () => {
          const { error } = await supabase
            .from(STANDARD_COST_TABLE)
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", record.id);
          if (error) throw error;
        },
        { table: STANDARD_COST_TABLE, recordId: record.id, document_no: record.standard_cost_no },
      );
      message.success(
        status === "active"
          ? t("mrp.standardCosts.activateDone")
          : t("mrp.standardCosts.deactivateDone"),
      );
      fetchAll();
    } catch (error) {
      const msg = String((error as Error).message || "");
      message.error(
        /duplicate key|uq_erp_standard_costs_active/i.test(msg)
          ? t("mrp.standardCosts.activeConflict")
          : t("common.saveFailed"),
      );
    }
  };

  const handleDelete = (record: StandardCostRow) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.standardCosts.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.standardCosts.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(STANDARD_COST_TABLE)
                .update({ is_deleted: "y" })
                .eq("id", record.id);
              if (error) throw error;
            },
            { table: STANDARD_COST_TABLE, recordId: record.id, document_no: record.standard_cost_no },
          );
          message.success(t("common.deleteSuccess"));
          fetchAll();
        } catch (error) {
          console.error("Error deleting standard cost:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const openLines = async (record: StandardCostRow) => {
    setLinesFor(record);
    setLines([]);
    try {
      setLinesLoading(true);
      const { data, error } = await supabase
        .from(STANDARD_COST_LINE_TABLE)
        .select("id, material_id, line_no, standard_quantity, loss_rate, standard_price, standard_amount")
        .eq("standard_cost_id", record.id)
        .eq("is_deleted", "n")
        .order("line_no");
      if (error) throw error;
      setLines((data || []) as StandardCostLine[]);
    } catch (error) {
      console.error("Error fetching standard cost lines:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLinesLoading(false);
    }
  };

  const openRollup = (record?: StandardCostRow) => {
    rollupForm.resetFields();
    if (record) {
      rollupForm.setFieldsValue({
        product_id: record.product_id,
        version: record.version,
        effective_date: dayjs(record.effective_date),
      });
    } else {
      rollupForm.setFieldsValue({ version: "V1", effective_date: dayjs() });
    }
    setIsRollupOpen(true);
  };

  const handleRollup = async (values: Record<string, unknown>) => {
    if (!user?.profile.id) return;
    try {
      setRolling(true);
      const productId = num(values.product_id);
      const payload = {
        p_product_id: productId,
        p_version: String(values.version || "V1"),
        p_effective_date: (values.effective_date as Dayjs).format("YYYY-MM-DD"),
        p_actor_id: user.profile.id,
        p_overwrite: false,
      };
      const result = await logWithTiming(
        t("mrp.standardCosts.logRollup"),
        "RPC",
        async () => {
          const { data, error } = await supabase.rpc("rollup_standard_cost", payload);
          if (error) throw error;
          return data as Record<string, unknown> | null;
        },
        { table: STANDARD_COST_TABLE, productId },
      );
      const p = productById.get(productId);
      message.success(
        t("mrp.standardCosts.rollupDone", {
          product: p ? p.code : String(productId),
          version: String(values.version || "V1"),
        }),
      );
      if (result && num(result.standard_material_cost) === 0) {
        message.warning(t("mrp.standardCosts.rollupZeroMaterial"));
      }
      setIsRollupOpen(false);
      fetchAll();
    } catch (error) {
      console.error("Error rolling up standard cost:", error);
      const msg = String((error as Error).message || "");
      message.error(
        /已生效/.test(msg)
          ? t("mrp.standardCosts.rollupActiveBlocked")
          : `${t("mrp.standardCosts.rollupFailed")}：${msg}`,
      );
    } finally {
      setRolling(false);
    }
  };

  const statusTag = (status: StandardCostRow["status"]) => {
    const map: Record<string, { color: string; key: string }> = {
      draft: { color: "default", key: "mrp.standardCosts.statusDraft" },
      active: { color: "success", key: "mrp.standardCosts.statusActive" },
      inactive: { color: "warning", key: "mrp.standardCosts.statusInactive" },
    };
    const cfg = map[status] || map.draft;
    return <Tag color={cfg.color}>{t(cfg.key)}</Tag>;
  };

  const columns: SuperTableColumn<StandardCostRow>[] = [
    { title: t("mrp.standardCosts.no"), dataIndex: "standard_cost_no", key: "standard_cost_no", width: 150 },
    {
      title: t("mrp.standardCosts.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (_: unknown, record: StandardCostRow) => productLabel(record),
    },
    { title: t("mrp.standardCosts.version"), dataIndex: "version", key: "version", width: 90, align: "center" },
    {
      title: t("mrp.standardCosts.effectiveDate"),
      dataIndex: "effective_date",
      key: "effective_date",
      width: 120,
      align: "center",
      render: (v: string) => (v ? dayjs(v).format("YYYY-MM-DD") : "-"),
    },
    {
      title: t("mrp.standardCosts.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (v: StandardCostRow["status"]) => statusTag(v),
    },
    {
      title: t("mrp.standardCosts.materialCost"),
      dataIndex: "standard_material_cost",
      key: "standard_material_cost",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.standardCosts.laborCost"),
      dataIndex: "standard_labor_cost",
      key: "standard_labor_cost",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.standardCosts.overheadCost"),
      dataIndex: "standard_overhead_cost",
      key: "standard_overhead_cost",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.standardCosts.totalCost"),
      dataIndex: "standard_total_cost",
      key: "standard_total_cost",
      align: "right",
      render: (v: unknown) => <strong>{formatMoney(num(v))}</strong>,
    },
    {
      title: t("mrp.standardCosts.source"),
      dataIndex: "source",
      key: "source",
      width: 100,
      align: "center",
      render: (v: string) =>
        v === "bom_rollup" ? (
          <Tag color="blue">{t("mrp.standardCosts.sourceBomRollup")}</Tag>
        ) : (
          <Tag>{t("mrp.standardCosts.sourceManual")}</Tag>
        ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 300,
      render: (_: unknown, record: StandardCostRow) => (
        <Space size="small" wrap>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" icon={<ProfileOutlined />} onClick={() => openLines(record)}>
            {t("mrp.standardCosts.lines")}
          </Button>
          <Tooltip title={t("mrp.standardCosts.rollupHint")}>
            <Button type="text" icon={<ThunderboltOutlined />} onClick={() => openRollup(record)}>
              {t("mrp.standardCosts.recalc")}
            </Button>
          </Tooltip>
          {record.status === "active" ? (
            <Button type="text" icon={<StopOutlined />} onClick={() => changeStatus(record, "inactive")}>
              {t("mrp.standardCosts.deactivate")}
            </Button>
          ) : (
            <Button
              type="text"
              icon={<CheckCircleOutlined />}
              onClick={() => changeStatus(record, "active")}
            >
              {t("mrp.standardCosts.activate")}
            </Button>
          )}
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)}>
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const lineColumns: SuperTableColumn<StandardCostLine>[] = [
    {
      title: t("mrp.standardCosts.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (v: number) => {
        const p = productById.get(v);
        return p ? `${p.code} - ${p.name}` : String(v);
      },
    },
    {
      title: t("mrp.standardCosts.standardQuantity"),
      dataIndex: "standard_quantity",
      key: "standard_quantity",
      align: "right",
      render: (v: unknown) => formatQuantity(num(v)),
    },
    {
      title: t("mrp.standardCosts.lossRate"),
      dataIndex: "loss_rate",
      key: "loss_rate",
      align: "right",
      render: (v: unknown) => `${(num(v) * 100).toFixed(2)}%`,
    },
    {
      title: t("mrp.standardCosts.standardPrice"),
      dataIndex: "standard_price",
      key: "standard_price",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.standardCosts.standardAmount"),
      dataIndex: "standard_amount",
      key: "standard_amount",
      align: "right",
      render: (v: unknown) => <strong>{formatMoney(num(v))}</strong>,
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={rows}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="standard-costs"
        headerTitle={t("mrp.standardCosts.title")}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.standardCosts.add")}
            </Button>
            <Button icon={<ThunderboltOutlined />} onClick={() => openRollup()}>
              {t("mrp.standardCosts.rollup")}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchAll}>
              {t("mrp.costCalculations.refresh")}
            </Button>
          </Space>
        }
      />

      <SimpleModal
        title={editing ? t("mrp.standardCosts.edit") : t("mrp.standardCosts.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        width={760}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
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
          <Form form={form} labelCol={{ span: 8 }} wrapperCol={{ span: 16 }} onFinish={handleSubmit}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label={t("mrp.standardCosts.no")} name="standard_cost_no">
                  <Input disabled />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.standardCosts.product")}
                  name="product_id"
                  rules={[{ required: true, message: t("mrp.standardCosts.productRequired") }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    disabled={!!editing}
                    placeholder={t("mrp.standardCosts.productRequired")}
                    options={products.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.standardCosts.version")}
                  name="version"
                  initialValue="V1"
                  rules={[{ required: true, message: t("mrp.standardCosts.versionPrompt") }]}
                >
                  <Input placeholder={t("mrp.standardCosts.versionPrompt")} disabled={!!editing} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.standardCosts.effectiveDate")}
                  name="effective_date"
                  rules={[{ required: true }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.standardCosts.status")} name="status" initialValue="draft">
                  <Select
                    options={[
                      { value: "draft", label: t("mrp.standardCosts.statusDraft") },
                      { value: "active", label: t("mrp.standardCosts.statusActive") },
                      { value: "inactive", label: t("mrp.standardCosts.statusInactive") },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.standardCosts.materialCost")} name="standard_material_cost" initialValue={0}>
                  <InputNumber min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.standardCosts.laborCost")} name="standard_labor_cost" initialValue={0}>
                  <InputNumber min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t("mrp.standardCosts.overheadCost")} name="standard_overhead_cost" initialValue={0}>
                  <InputNumber min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label={t("common.remark")} name="remark" labelCol={{ span: 4 }} wrapperCol={{ span: 20 }}>
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </SimpleModal>

      <SimpleModal
        title={t("mrp.standardCosts.rollupTitle")}
        open={isRollupOpen}
        onCancel={() => setIsRollupOpen(false)}
        width={520}
        footer={
          <Space>
            <Button onClick={() => setIsRollupOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" loading={rolling} onClick={() => rollupForm.submit()}>
              {t("mrp.standardCosts.rollup")}
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.standardCosts.rollupHint")}
        />
        <Form form={rollupForm} labelCol={{ span: 7 }} wrapperCol={{ span: 17 }} onFinish={handleRollup}>
          <Form.Item
            label={t("mrp.standardCosts.product")}
            name="product_id"
            rules={[{ required: true, message: t("mrp.standardCosts.productRequired") }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={t("mrp.standardCosts.productRequired")}
              options={products.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item label={t("mrp.standardCosts.version")} name="version" initialValue="V1">
            <Input />
          </Form.Item>
          <Form.Item label={t("mrp.standardCosts.effectiveDate")} name="effective_date" initialValue={dayjs()}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={
          linesFor
            ? `${t("mrp.standardCosts.linesTitle")} · ${productLabel(linesFor)} · ${linesFor.version}`
            : t("mrp.standardCosts.linesTitle")
        }
        open={!!linesFor}
        onCancel={() => setLinesFor(null)}
        width={860}
        footer={<Button onClick={() => setLinesFor(null)}>{t("common.close")}</Button>}
      >
        {!linesLoading && lines.length === 0 ? (
          <Alert type="info" showIcon message={t("mrp.standardCosts.noLines")} />
        ) : (
          <SuperTable
            columns={lineColumns}
            dataSource={lines}
            rowKey="id"
            loading={linesLoading}
            pagination={false}
            storageKey="standard-cost-lines"
          />
        )}
      </SimpleModal>
    </div>
  );
}

/* ==========================================================================
 * 页签三：成本差异分析（标准 vs 实际）
 *
 * 数据来自 vw_erp_cost_variance（工单维度）与
 * vw_erp_material_cost_variance（工单 × 物料，价差/量差）。
 * ========================================================================== */

function CostVarianceTab() {
  const { t } = useTranslation();
  const { getMeta } = useCurrencyRegistry();
  const baseMeta = getMeta();
  const [monthValue, setMonthValue] = useState<Dayjs>(dayjs());
  const [productId, setProductId] = useState<number | undefined>(undefined);
  const [rows, setRows] = useState<VarianceRow[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailFor, setDetailFor] = useState<VarianceRow | null>(null);
  const [detailRows, setDetailRows] = useState<MaterialVarianceRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("id, code, name, unit")
        .eq("is_deleted", "n")
        .order("code");
      if (!error) setProducts((data || []) as ProductOption[]);
    })();
  }, []);

  const fetchRows = useCallback(async () => {
    try {
      setLoading(true);
      let query = supabase
        .from("vw_erp_cost_variance")
        .select("*")
        .eq("period_year", monthValue.year())
        .eq("period_month", monthValue.month() + 1)
        .order("order_date", { ascending: false });
      if (productId) query = query.eq("product_id", productId);
      const { data, error } = await query;
      if (error) throw error;
      setRows((data || []) as VarianceRow[]);
    } catch (error) {
      console.error("Error fetching cost variance:", error);
      message.error(`${t("mrp.costVariance.fetchFailed")}：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [monthValue, productId, t]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const openDetail = async (record: VarianceRow) => {
    setDetailFor(record);
    setDetailRows([]);
    try {
      setDetailLoading(true);
      const { data, error } = await supabase
        .from("vw_erp_material_cost_variance")
        .select("*")
        .eq("order_id", record.order_id)
        .order("material_id");
      if (error) throw error;
      setDetailRows((data || []) as MaterialVarianceRow[]);
    } catch (error) {
      console.error("Error fetching material variance:", error);
      message.error(t("mrp.costVariance.fetchFailed"));
    } finally {
      setDetailLoading(false);
    }
  };

  // 汇总只统计「有基准」的工单：没设标准成本的工单差异恒为 0，计入总数会摊薄差异率
  const withStandard = rows.filter((r) => r.has_standard_cost);
  const totals = {
    standard: withStandard.reduce((s, r) => s + num(r.standard_total), 0),
    actual: withStandard.reduce((s, r) => s + num(r.actual_total), 0),
    variance: withStandard.reduce((s, r) => s + num(r.total_variance), 0),
  };
  const varianceRate = totals.standard !== 0 ? (totals.variance / totals.standard) * 100 : 0;
  const missingCount = rows.length - withStandard.length;

  const columns: SuperTableColumn<VarianceRow>[] = [
    { title: t("mrp.costVariance.orderNo"), dataIndex: "order_no", key: "order_no", width: 150 },
    {
      title: t("mrp.standardCosts.product"),
      dataIndex: "product_code",
      key: "product_code",
      render: (_: unknown, record: VarianceRow) =>
        record.product_name ? `${record.product_code} - ${record.product_name}` : record.product_code || "-",
    },
    {
      title: t("mrp.costVariance.orderDate"),
      dataIndex: "order_date",
      key: "order_date",
      width: 120,
      align: "center",
      render: (v: string) => (v ? dayjs(v).format("YYYY-MM-DD") : "-"),
    },
    {
      title: t("mrp.costVariance.completedQuantity"),
      dataIndex: "completed_quantity",
      key: "completed_quantity",
      width: 100,
      align: "right",
      render: (v: unknown) => formatQuantity(num(v)),
    },
    {
      title: t("mrp.costVariance.baselineVersion"),
      dataIndex: "standard_version",
      key: "standard_version",
      width: 100,
      align: "center",
      render: (v: string | null) =>
        v ? <Tag color="blue">{v}</Tag> : <Tag color="orange">{t("mrp.costVariance.noStandard")}</Tag>,
    },
    {
      title: t("mrp.costVariance.standardCost"),
      dataIndex: "standard_total",
      key: "standard_total",
      align: "right",
      render: (_: unknown, record: VarianceRow) =>
        record.has_standard_cost ? formatMoney(num(record.standard_total)) : "-",
    },
    {
      title: t("mrp.costVariance.actualCost"),
      dataIndex: "actual_total",
      key: "actual_total",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.costVariance.variance"),
      dataIndex: "total_variance",
      key: "total_variance",
      align: "right",
      render: (_: unknown, record: VarianceRow) =>
        record.has_standard_cost ? renderVariance(record.total_variance) : "-",
    },
    {
      title: t("mrp.costVariance.varianceRate"),
      dataIndex: "total_variance_rate",
      key: "total_variance_rate",
      width: 100,
      align: "right",
      render: (_: unknown, record: VarianceRow) =>
        record.has_standard_cost ? (
          <span style={{ color: varianceColor(num(record.total_variance_rate)) }}>
            {num(record.total_variance_rate).toFixed(2)}%
          </span>
        ) : (
          "-"
        ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 130,
      render: (_: unknown, record: VarianceRow) =>
        record.has_standard_cost ? (
          <Button type="text" icon={<ProfileOutlined />} onClick={() => openDetail(record)}>
            {t("mrp.costVariance.materialDetail")}
          </Button>
        ) : (
          "-"
        ),
    },
  ];

  const detailColumns: SuperTableColumn<MaterialVarianceRow>[] = [
    {
      title: t("mrp.standardCosts.material"),
      dataIndex: "material_code",
      key: "material_code",
      render: (_: unknown, record: MaterialVarianceRow) =>
        record.material_name
          ? `${record.material_code} - ${record.material_name}`
          : record.material_code || String(record.material_id),
    },
    {
      title: t("mrp.costVariance.standardQuantity"),
      dataIndex: "standard_quantity",
      key: "standard_quantity",
      align: "right",
      render: (v: unknown) => formatQuantity(num(v)),
    },
    {
      title: t("mrp.costVariance.actualQuantity"),
      dataIndex: "actual_quantity",
      key: "actual_quantity",
      align: "right",
      render: (v: unknown) => formatQuantity(num(v)),
    },
    {
      title: t("mrp.costVariance.standardPrice"),
      dataIndex: "standard_price",
      key: "standard_price",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.costVariance.actualPrice"),
      dataIndex: "actual_price",
      key: "actual_price",
      align: "right",
      render: (v: unknown) => formatMoney(num(v)),
    },
    {
      title: t("mrp.costVariance.priceVariance"),
      dataIndex: "price_variance",
      key: "price_variance",
      align: "right",
      render: (v: unknown) => renderVariance(v),
    },
    {
      title: t("mrp.costVariance.usageVariance"),
      dataIndex: "usage_variance",
      key: "usage_variance",
      align: "right",
      render: (v: unknown) => renderVariance(v),
    },
    {
      title: t("mrp.costVariance.variance"),
      dataIndex: "total_variance",
      key: "total_variance",
      align: "right",
      render: (v: unknown) => <strong>{renderVariance(v)}</strong>,
    },
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col span={6}>
            <Statistic
              title={t("mrp.costVariance.standardTotal")}
              value={totals.standard}
              precision={baseMeta.decimalPlaces}
              prefix={baseMeta.symbol}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title={t("mrp.costVariance.actualTotal")}
              value={totals.actual}
              precision={baseMeta.decimalPlaces}
              prefix={baseMeta.symbol}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title={t("mrp.costVariance.totalVariance")}
              value={totals.variance}
              precision={baseMeta.decimalPlaces}
              prefix={baseMeta.symbol}
              valueStyle={{ color: varianceColor(totals.variance) }}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title={t("mrp.costVariance.varianceRate")}
              value={varianceRate}
              precision={2}
              suffix="%"
              valueStyle={{ color: varianceColor(varianceRate) }}
            />
          </Col>
        </Row>
      </Card>

      {missingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.costVariance.noStandardHint", { count: missingCount })}
        />
      )}

      <SuperTable
        columns={columns}
        dataSource={rows}
        rowKey="order_id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="cost-variance"
        headerTitle={t("mrp.costVariance.title")}
        queryBar={
          <Space wrap>
            <DatePicker
              picker="month"
              value={monthValue}
              onChange={(value) => value && setMonthValue(value)}
              allowClear={false}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 260 }}
              placeholder={t("mrp.standardCosts.product")}
              value={productId}
              onChange={(v) => setProductId(v)}
              options={products.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchRows}>
              {t("mrp.costCalculations.refresh")}
            </Button>
          </Space>
        }
      />

      <div style={{ marginTop: 16, color: "#888", fontSize: 13, lineHeight: 1.8 }}>
        <p style={{ marginBottom: 6 }}>💡 {t("mrp.costVariance.footerHint")}</p>
        <p style={{ margin: 0 }}>💡 {t("mrp.costVariance.rateHint")}</p>
      </div>

      <SimpleModal
        title={
          detailFor
            ? `${t("mrp.costVariance.materialDetailTitle")} · ${detailFor.order_no}`
            : t("mrp.costVariance.materialDetailTitle")
        }
        open={!!detailFor}
        onCancel={() => setDetailFor(null)}
        width={980}
        footer={<Button onClick={() => setDetailFor(null)}>{t("common.close")}</Button>}
      >
        <SuperTable
          columns={detailColumns}
          dataSource={detailRows}
          rowKey="material_id"
          loading={detailLoading}
          pagination={false}
          storageKey="cost-variance-detail"
        />
      </SimpleModal>
    </div>
  );
}

/* ==========================================================================
 * 成本核算页：实际卷算 / 标准成本 / 成本差异
 *
 * 实际成本卷算全部在服务端（ai-server /api/mrp/cost-rollup），浏览器只触发与展示；
 * 标准成本与差异分析走 PostgREST（表 + security_invoker 视图），RLS 按登录身份生效。
 * ========================================================================== */

export function CostCalculations() {
  const { t } = useTranslation();

  return (
    <Card variant="borderless" title={t("mrp.costCalculations.title")}>
      <Tabs
        items={[
          { key: "actual", label: t("mrp.costCalculations.tabActual"), children: <ActualCostTab /> },
          { key: "standard", label: t("mrp.costCalculations.tabStandard"), children: <StandardCostTab /> },
          { key: "variance", label: t("mrp.costCalculations.tabVariance"), children: <CostVarianceTab /> },
        ]}
      />
    </Card>
  );
}
