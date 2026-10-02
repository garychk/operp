import { useCallback, useEffect, useState } from "react";
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
} from "antd";
import { CalculatorOutlined, ExperimentOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { SuperTable } from "../../components/SuperTable";
import { useAuth } from "../../contexts/AuthContext";
import { resolveMrpApiBaseUrl } from "../../utils/aiServer";

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

/**
 * 成本卷算全部在服务端（ai-server 的 /api/mrp/cost-rollup）：
 * 浏览器只负责选期间、触发、展示。材料/人工/制费的取数口径见 costRollupService.ts 顶部注释。
 */
export function CostCalculations() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
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
      const response = await fetch(`${resolveMrpApiBaseUrl()}/cost?${params.toString()}`);
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
        headers: { "Content-Type": "application/json" },
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
      message.info(
        t("mrp.costCalculations.previewDone", { count, total: formatMoney(total) }),
      );
      return;
    }
    message.success(
      t("mrp.costCalculations.rollupDone", { count, total: formatMoney(total) }),
    );
  };

  const formatMoney = (value: number | null | undefined) => `¥${(value ?? 0).toFixed(2)}`;
  const formatQuantity = (value: number | null | undefined) =>
    Number(value ?? 0).toLocaleString();

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
              precision={2}
              prefix="¥"
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.labor")}
              value={totals.labor}
              precision={2}
              prefix="¥"
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.overhead")}
              value={totals.overhead}
              precision={2}
              prefix="¥"
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.totalCost")}
              value={totals.total}
              precision={2}
              prefix="¥"
            />
          </Col>
          <Col span={4}>
            <Statistic
              title={t("mrp.costCalculations.endingWip")}
              value={totals.endingWip}
              precision={2}
              prefix="¥"
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
