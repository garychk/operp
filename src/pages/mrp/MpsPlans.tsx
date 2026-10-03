/**
 * 主生产计划 MPS（阶段 5）。
 *
 * 计划链路定位：MPS 管「计划员的人为决策」，MRP 管「执行层的自动展开」。
 *   预测/订单参考 → 计划员维护 mps_qty → 确认（整单锁定）→ 下推生产订单（一行一张 MO）
 *   → MRP 运算时「确认未下推的 mps_qty」作为计划供给（sourceType=mps）。
 *
 * 服务端约定（与 MRP 页一致，别在页面里再写一份 base URL）：
 *   · 计划头/行的新增编辑删除走 supabase-js（RLS 管写入）；
 *   · 汇总 / RCCP / 确认 / 下推走 ai-server /api/mps（角色在服务端核实）；
 *   · 下推防重复靠 doc_flow 台账（doc_flow_transfers + pushed_quantity 回写），
 *     页面上的「剩余可下推」就是 mps_qty - pushed_quantity。
 *
 * 布局：页面高度由布局统一负责，这里不定高（.page-viewport 约定）。
 */
import { useEffect, useMemo, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  CalendarOutlined,
  PlusOutlined,
  PushpinOutlined,
  ReconciliationOutlined,
  StopOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import { useAuth } from "../../contexts/AuthContext";
import { resolveMpsApiBaseUrl } from "../../utils/aiServer";
import { nextDocumentNo } from "../../utils/documentNaming";
import { logWithTiming } from "../../utils/logger";

type MpsPlan = Tables["erp_mps_plans_s_539dcf81_b"]["Row"];
type MpsLine = Tables["erp_mps_plan_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

const PLANS_TABLE = "erp_mps_plans_s_539dcf81_b";
const LINES_TABLE = "erp_mps_plan_details_s_539dcf81_b";
const DOCUMENT_TYPE = "mps_plan";

/** ai-server /overview 返回的行（在库行上补充展示字段） */
interface MpsOverviewLine extends MpsLine {
  product_code: string;
  product_name: string;
  remaining_qty: number;
  order_qty: number;
}

interface MpsOverview {
  plan: MpsPlan;
  lines: MpsOverviewLine[];
  summary: {
    totalLines: number;
    totalForecast: number;
    totalMps: number;
    totalPushed: number;
    totalRemaining: number;
    linesWithOrderGap: number;
  };
}

interface RccpRow {
  work_center_id: number | null;
  work_center_code: string;
  work_center_name: string;
  month: string;
  capacity_per_day: number;
  load_hours: number;
  capacity_hours: number;
  load_ratio: number;
}

interface RccpOutcome {
  plan: MpsPlan;
  months: string[];
  unitHours: {
    product_id: number;
    product_code: string;
    product_name: string;
    unit_hours: number;
    hours_source: string;
  }[];
  rows: RccpRow[];
  warnings: string[];
}

interface PushItemResult {
  lineId: number;
  productCode: string;
  productName: string;
  quantity: number;
  ok: boolean;
  documentNo?: string;
  error?: string;
  warnings: string[];
}

const statusLabelKey = (status: string | null): string => {
  switch (status) {
    case "confirmed":
      return "mrp.mps.statusConfirmed";
    default:
      return "mrp.mps.statusDraft";
  }
};

const statusColor = (status: string | null): string =>
  status === "confirmed" ? "success" : "default";

export function MpsPlans() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [plans, setPlans] = useState<MpsPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedPlanKeys, setSelectedPlanKeys] = useState<Key[]>([]);

  const [overview, setOverview] = useState<MpsOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [selectedLineKeys, setSelectedLineKeys] = useState<Key[]>([]);

  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [lineModalOpen, setLineModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<MpsOverviewLine | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [rccpOpen, setRccpOpen] = useState(false);
  const [rccp, setRccp] = useState<RccpOutcome | null>(null);
  const [rccpLoading, setRccpLoading] = useState(false);
  const [pushResult, setPushResult] = useState<{
    created: number;
    failed: number;
    items: PushItemResult[];
  } | null>(null);
  const [pushing, setPushing] = useState(false);

  const [planForm] = Form.useForm();
  const [lineForm] = Form.useForm();

  const selectedPlan = useMemo(
    () => plans.find((p) => p.id === Number(selectedPlanKeys[0])) ?? null,
    [plans, selectedPlanKeys],
  );
  const isConfirmed = selectedPlan?.status === "confirmed";

  useEffect(() => {
    fetchPlans();
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(PLANS_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .order("plan_date", { ascending: false })
        .order("id", { ascending: false });
      if (error) throw error;
      setPlans((data || []) as MpsPlan[]);
    } catch (error) {
      console.error("Error fetching MPS plans:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("id, code, name, is_purchased, is_manufactured")
        .eq("is_deleted", "n")
        .order("code", { ascending: true });
      if (error) throw error;
      setProducts((data || []) as Product[]);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const loadOverview = async (planId: number) => {
    if (!user) return;
    try {
      setOverviewLoading(true);
      const params = new URLSearchParams({
        user_id: String(user.profile.id),
        tenant_id: String(user.tenantId ?? ""),
        plan_id: String(planId),
      });
      const response = await fetch(
        `${resolveMpsApiBaseUrl()}/overview?${params.toString()}`,
      );
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body?.error || t("common.fetchFailed"));
      }
      setOverview(body as MpsOverview);
      setSelectedLineKeys([]);
    } catch (error) {
      console.error("Error loading MPS overview:", error);
      setOverview(null);
      message.error(error instanceof Error ? error.message : t("common.fetchFailed"));
    } finally {
      setOverviewLoading(false);
    }
  };

  const filteredPlans = plans.filter((p) =>
    (p.plan_no || "").toLowerCase().includes(searchTerm.toLowerCase()),
  );

  // ------------------------------------------------------------------
  // 计划头：新增（编号走取号 RPC，拿不到号就不开弹窗）
  // ------------------------------------------------------------------
  const handleAddPlan = async () => {
    try {
      const planNo = await nextDocumentNo(DOCUMENT_TYPE);
      planForm.setFieldsValue({
        plan_no: planNo,
        plan_date: dayjs(),
        start_date: dayjs().startOf("month"),
        end_date: dayjs().endOf("month"),
        frozen_days: 0,
      });
      setPlanModalOpen(true);
    } catch (error) {
      console.error("Error getting document no:", error);
      message.error(error instanceof Error ? error.message : t("common.saveFailed"));
    }
  };

  const handlePlanSubmit = async (values: {
    plan_no: string;
    plan_date: Dayjs;
    start_date: Dayjs;
    end_date: Dayjs;
    frozen_days?: number;
    remark?: string;
  }) => {
    try {
      await logWithTiming(t("mrp.mps.logCreatePlan"), "INSERT", async () => {
        const { error } = await supabase.from(PLANS_TABLE).insert([
          {
            plan_no: values.plan_no,
            plan_date: values.plan_date.format("YYYY-MM-DD"),
            start_date: values.start_date.format("YYYY-MM-DD"),
            end_date: values.end_date.format("YYYY-MM-DD"),
            frozen_days: values.frozen_days ?? 0,
            remark: values.remark ?? null,
            status: "draft",
          },
        ]);
        if (error) throw error;
      });
      message.success(t("common.createSuccess"));
      setPlanModalOpen(false);
      planForm.resetFields();
      fetchPlans();
    } catch (error) {
      console.error("Error saving MPS plan:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDeletePlan = (record: MpsPlan) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.mps.deletePlanConfirm", { no: record.plan_no }),
      onOk: async () => {
        try {
          await logWithTiming(t("mrp.mps.logDeletePlan"), "DELETE", async () => {
            const { error } = await supabase
              .from(PLANS_TABLE)
              .update({ is_deleted: "y" })
              .eq("id", record.id);
            if (error) throw error;
          });
          message.success(t("common.deleteSuccess"));
          if (selectedPlan?.id === record.id) {
            setOverview(null);
            setSelectedPlanKeys([]);
          }
          fetchPlans();
        } catch (error) {
          console.error("Error deleting MPS plan:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  // ------------------------------------------------------------------
  // 计划行：新增 / 编辑 / 删除（草稿才可维护；确认锁由 DB 触发器兜底）
  // ------------------------------------------------------------------
  const openLineModal = (line: MpsOverviewLine | null) => {
    if (!selectedPlan) return;
    setEditingLine(line);
    if (line) {
      lineForm.setFieldsValue({
        product_id: line.product_id,
        requirement_date: dayjs(line.requirement_date),
        forecast_qty: line.forecast_qty,
        mps_qty: line.mps_qty,
        remark: line.remark,
      });
    } else {
      lineForm.resetFields();
      lineForm.setFieldsValue({ forecast_qty: 0, mps_qty: 0 });
    }
    setLineModalOpen(true);
  };

  const handleLineSubmit = async (values: {
    product_id: number;
    requirement_date: Dayjs;
    forecast_qty?: number;
    mps_qty?: number;
    remark?: string;
  }) => {
    if (!selectedPlan) return;
    const payload = {
      plan_id: selectedPlan.id,
      product_id: values.product_id,
      requirement_date: values.requirement_date.format("YYYY-MM-DD"),
      forecast_qty: values.forecast_qty ?? 0,
      mps_qty: values.mps_qty ?? 0,
      remark: values.remark ?? null,
    };
    try {
      if (editingLine) {
        await logWithTiming(t("mrp.mps.logUpdateLine"), "UPDATE", async () => {
          const { error } = await supabase
            .from(LINES_TABLE)
            .update(payload)
            .eq("id", editingLine.id);
          if (error) throw error;
        });
      } else {
        await logWithTiming(t("mrp.mps.logCreateLine"), "INSERT", async () => {
          const { error } = await supabase.from(LINES_TABLE).insert([payload]);
          if (error) throw error;
        });
      }
      message.success(
        editingLine ? t("common.updateSuccess") : t("common.createSuccess"),
      );
      setLineModalOpen(false);
      lineForm.resetFields();
      setEditingLine(null);
      if (selectedPlan) await loadOverview(selectedPlan.id);
    } catch (error) {
      console.error("Error saving MPS line:", error);
      // DB 触发器的确认锁报错直接透出，引导用户先取消确认
      message.error(
        error instanceof Error ? error.message : t("common.saveFailed"),
      );
    }
  };

  const handleDeleteLine = (line: MpsOverviewLine) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.mps.deleteLineConfirm"),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(LINES_TABLE)
            .update({ is_deleted: "y" })
            .eq("id", line.id);
          if (error) throw error;
          message.success(t("common.deleteSuccess"));
          if (selectedPlan) await loadOverview(selectedPlan.id);
        } catch (error) {
          console.error("Error deleting MPS line:", error);
          message.error(
            error instanceof Error ? error.message : t("common.deleteFailed"),
          );
        }
      },
    });
  };

  // ------------------------------------------------------------------
  // 确认 / 取消确认 / RCCP / 下推（ai-server）
  // ------------------------------------------------------------------
  const postMps = async <T,>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> => {
    if (!user) throw new Error(t("common.fetchFailed"));
    const response = await fetch(`${resolveMpsApiBaseUrl()}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        user_id: user.profile.id,
        tenant_id: user.tenantId,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || t("common.saveFailed"));
    }
    return data as T;
  };

  const handleConfirm = (confirm: boolean) => {
    if (!selectedPlan) return;
    Modal.confirm({
      title: confirm ? t("mrp.mps.confirmTitle") : t("mrp.mps.unconfirmTitle"),
      content: confirm
        ? t("mrp.mps.confirmContent", { no: selectedPlan.plan_no })
        : t("mrp.mps.unconfirmContent"),
      onOk: async () => {
        try {
          await postMps("confirm", { plan_id: selectedPlan.id, confirm });
          message.success(
            confirm ? t("mrp.mps.confirmSuccess") : t("mrp.mps.unconfirmSuccess"),
          );
          await fetchPlans();
          await loadOverview(selectedPlan.id);
        } catch (error) {
          console.error("Error confirming MPS plan:", error);
          message.error(
            error instanceof Error ? error.message : t("common.saveFailed"),
          );
        }
      },
    });
  };

  const loadRccp = async () => {
    if (!selectedPlan) return;
    try {
      setRccpLoading(true);
      const params = new URLSearchParams({
        user_id: String(user?.profile.id ?? ""),
        tenant_id: String(user?.tenantId ?? ""),
        plan_id: String(selectedPlan.id),
      });
      const response = await fetch(
        `${resolveMpsApiBaseUrl()}/rccp?${params.toString()}`,
      );
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body?.error || t("common.fetchFailed"));
      }
      setRccp(body as RccpOutcome);
      setRccpOpen(true);
    } catch (error) {
      console.error("Error loading RCCP:", error);
      message.error(error instanceof Error ? error.message : t("common.fetchFailed"));
    } finally {
      setRccpLoading(false);
    }
  };

  const handlePush = () => {
    if (!selectedPlan) return;
    const lineIds =
      selectedLineKeys.length > 0 ? selectedLineKeys.map(Number) : undefined;
    Modal.confirm({
      title: t("mrp.mps.pushTitle"),
      content: t("mrp.mps.pushContent"),
      onOk: async () => {
        try {
          setPushing(true);
          const outcome = await postMps<{
            created: number;
            failed: number;
            items: PushItemResult[];
          }>("push", { plan_id: selectedPlan.id, line_ids: lineIds });
          setPushResult(outcome);
          await loadOverview(selectedPlan.id);
        } catch (error) {
          console.error("Error pushing MPS:", error);
          message.error(
            error instanceof Error ? error.message : t("common.saveFailed"),
          );
        } finally {
          setPushing(false);
        }
      },
    });
  };

  const rccpWarningLabel = (code: string): string => {
    if (code.startsWith("no_routing_hours:")) {
      return t("mrp.mps.rccpWarnNoRoutingHours", {
        product: code.slice("no_routing_hours:".length),
      });
    }
    return t("mrp.mps.rccpWarnLoadWithoutWorkCenter");
  };

  // ------------------------------------------------------------------
  // 列定义
  // ------------------------------------------------------------------
  const planColumns: SuperTableColumn<MpsPlan>[] = [
    { title: t("common.code"), dataIndex: "plan_no", key: "plan_no", width: 160 },
    { title: t("mrp.mps.planDate"), dataIndex: "plan_date", key: "plan_date", width: 120 },
    { title: t("mrp.mps.startDate"), dataIndex: "start_date", key: "start_date", width: 120 },
    { title: t("mrp.mps.endDate"), dataIndex: "end_date", key: "end_date", width: 120 },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (status: string | null) => (
        <Tag color={statusColor(status)}>{t(statusLabelKey(status))}</Tag>
      ),
    },
    { title: t("mrp.mps.remark"), dataIndex: "remark", key: "remark" },
    {
      title: t("common.actions"),
      key: "action",
      width: 90,
      render: (_: unknown, record: MpsPlan) => (
        <Button type="text" danger onClick={() => handleDeletePlan(record)}>
          {t("common.delete")}
        </Button>
      ),
    },
  ];

  const lineColumns: SuperTableColumn<MpsOverviewLine>[] = [
    {
      title: t("products.code"),
      dataIndex: "product_code",
      key: "product_code",
      width: 130,
      render: (_: unknown, record: MpsOverviewLine) =>
        record.product_code || record.product_id,
    },
    { title: t("products.name"), dataIndex: "product_name", key: "product_name" },
    {
      title: t("mrp.mps.requirementDate"),
      dataIndex: "requirement_date",
      key: "requirement_date",
      width: 120,
    },
    { title: t("mrp.mps.forecastQty"), dataIndex: "forecast_qty", key: "forecast_qty", width: 110, align: "center" },
    { title: t("mrp.mps.mpsQty"), dataIndex: "mps_qty", key: "mps_qty", width: 110, align: "center" },
    { title: t("mrp.mps.orderQty"), dataIndex: "order_qty", key: "order_qty", width: 110, align: "center" },
    { title: t("mrp.mps.pushedQty"), dataIndex: "pushed_quantity", key: "pushed_quantity", width: 110, align: "center" },
    {
      title: t("mrp.mps.remainingQty"),
      dataIndex: "remaining_qty",
      key: "remaining_qty",
      width: 110,
      align: "center",
      render: (_: unknown, record: MpsOverviewLine) =>
        record.remaining_qty > 0 ? record.remaining_qty : "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 150,
      render: (_: unknown, record: MpsOverviewLine) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<CalendarOutlined />}
            disabled={isConfirmed}
            onClick={() => openLineModal(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            size="small"
            danger
            disabled={isConfirmed}
            onClick={() => handleDeleteLine(record)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable<MpsPlan>
        columns={planColumns}
        dataSource={filteredPlans}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="mps-plans"
        headerTitle={t("mrp.mps.title")}
        rowSelection={{
          type: "radio",
          selectedRowKeys: selectedPlanKeys,
          onChange: (keys) => {
            setSelectedPlanKeys(keys);
            const planId = Number(keys[0]);
            if (planId) void loadOverview(planId);
            else setOverview(null);
          },
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddPlan}>
              {t("mrp.mps.addPlan")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.mps.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      {selectedPlan && (
        <div style={{ marginTop: 16 }}>
          <Alert
            style={{ marginBottom: 12 }}
            type={isConfirmed ? "success" : "info"}
            showIcon
            icon={isConfirmed ? <CheckCircleOutlined /> : <CalendarOutlined />}
            message={
              isConfirmed
                ? t("mrp.mps.lockedBanner", { no: selectedPlan.plan_no })
                : t("mrp.mps.draftBanner", { no: selectedPlan.plan_no })
            }
            description={
              overview && (
                <Space size="large" wrap>
                  <Statistic title={t("mrp.mps.summaryLines")} value={overview.summary.totalLines} />
                  <Statistic title={t("mrp.mps.summaryForecast")} value={overview.summary.totalForecast} />
                  <Statistic title={t("mrp.mps.summaryMps")} value={overview.summary.totalMps} />
                  <Statistic title={t("mrp.mps.summaryPushed")} value={overview.summary.totalPushed} />
                  <Statistic title={t("mrp.mps.summaryRemaining")} value={overview.summary.totalRemaining} />
                </Space>
              )
            }
          />

          <SuperTable<MpsOverviewLine>
            columns={lineColumns}
            dataSource={overview?.lines ?? []}
            rowKey="id"
            loading={overviewLoading}
            pagination={false}
            storageKey="mps-lines"
            headerTitle={t("mrp.mps.linesTitle")}
            rowSelection={{
              selectedRowKeys: selectedLineKeys,
              onChange: setSelectedLineKeys,
              getCheckboxProps: (record) => ({ disabled: record.remaining_qty <= 0 }),
            }}
            queryBar={
              <Space wrap>
                <Tooltip title={isConfirmed ? t("mrp.mps.lockedTooltip") : ""}>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    disabled={isConfirmed}
                    onClick={() => openLineModal(null)}
                  >
                    {t("mrp.mps.addLine")}
                  </Button>
                </Tooltip>
                {isConfirmed ? (
                  <Button
                    icon={<StopOutlined />}
                    onClick={() => handleConfirm(false)}
                  >
                    {t("mrp.mps.unconfirm")}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    ghost
                    icon={<CheckCircleOutlined />}
                    disabled={(overview?.summary.totalMps ?? 0) <= 0}
                    onClick={() => handleConfirm(true)}
                  >
                    {t("mrp.mps.confirm")}
                  </Button>
                )}
                <Button
                  icon={<ReconciliationOutlined />}
                  loading={rccpLoading}
                  disabled={(overview?.summary.totalMps ?? 0) <= 0}
                  onClick={loadRccp}
                >
                  {t("mrp.mps.rccp")}
                </Button>
                <Tooltip title={isConfirmed ? "" : t("mrp.mps.pushNeedConfirm")}>
                  <Button
                    type="primary"
                    icon={<PushpinOutlined />}
                    disabled={!isConfirmed || pushing}
                    loading={pushing}
                    onClick={handlePush}
                  >
                    {t("mrp.mps.push")}
                  </Button>
                </Tooltip>
              </Space>
            }
          />
        </div>
      )}

      <SimpleModal
        title={t("mrp.mps.addPlan")}
        open={planModalOpen}
        onCancel={() => {
          setPlanModalOpen(false);
          planForm.resetFields();
        }}
        footer={
          <Space>
            <Button onClick={() => setPlanModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => planForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        <Form form={planForm} layout="vertical" onFinish={handlePlanSubmit}>
          <Form.Item
            label={t("common.code")}
            name="plan_no"
            rules={[{ required: true, message: t("mrp.mps.planNoPrompt") }]}
          >
            <Input disabled />
          </Form.Item>
          <Form.Item
            label={t("mrp.mps.planDate")}
            name="plan_date"
            rules={[{ required: true, message: t("mrp.mps.planDatePrompt") }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Space style={{ display: "flex" }} align="start">
            <Form.Item
              label={t("mrp.mps.startDate")}
              name="start_date"
              rules={[{ required: true, message: t("mrp.mps.startDatePrompt") }]}
            >
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("mrp.mps.endDate")}
              name="end_date"
              rules={[{ required: true, message: t("mrp.mps.endDatePrompt") }]}
            >
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item label={t("mrp.mps.frozenDays")} name="frozen_days">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label={t("mrp.mps.remark")} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={editingLine ? t("mrp.mps.editLine") : t("mrp.mps.addLine")}
        open={lineModalOpen}
        onCancel={() => {
          setLineModalOpen(false);
          lineForm.resetFields();
          setEditingLine(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setLineModalOpen(false);
                lineForm.resetFields();
                setEditingLine(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => lineForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        <Form form={lineForm} layout="vertical" onFinish={handleLineSubmit}>
          <Form.Item
            label={t("products.name")}
            name="product_id"
            rules={[{ required: true, message: t("mrp.mps.productPrompt") }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={products.map((p) => ({
                value: p.id,
                label: `${p.code} - ${p.name}`,
              }))}
              placeholder={t("mrp.mps.productPrompt")}
            />
          </Form.Item>
          <Form.Item
            label={t("mrp.mps.requirementDate")}
            name="requirement_date"
            rules={[{ required: true, message: t("mrp.mps.requirementDatePrompt") }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("mrp.mps.forecastQty")}
            name="forecast_qty"
            extra={t("mrp.mps.forecastHint")}
          >
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("mrp.mps.mpsQty")}
            name="mps_qty"
            rules={[{ required: true, message: t("mrp.mps.mpsQtyPrompt") }]}
          >
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label={t("mrp.mps.remark")} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={t("mrp.mps.rccpTitle")}
        open={rccpOpen}
        onCancel={() => setRccpOpen(false)}
        footer={
          <Button onClick={() => setRccpOpen(false)}>{t("common.close")}</Button>
        }
        width={760}
      >
        {rccp && (
          <>
            {rccp.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={rccp.warnings.map((w, i) => (
                  <Tag key={i} color="warning" style={{ marginTop: 4 }}>
                    {rccpWarningLabel(w)}
                  </Tag>
                ))}
              />
            )}
            {rccp.unitHours.some((u) => u.hours_source === "no_routing") && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={t("mrp.mps.rccpNoRoutingHint")}
              />
            )}
            <Table<RccpRow>
              rowKey={(r) => `${r.work_center_id ?? 0}-${r.month}`}
              dataSource={rccp.rows}
              pagination={false}
              size="small"
              columns={[
                { title: t("common.code"), dataIndex: "work_center_code", width: 120 },
                { title: t("common.name"), dataIndex: "work_center_name" },
                { title: t("mrp.mps.rccpMonth"), dataIndex: "month", width: 100 },
                { title: t("mrp.mps.rccpLoad"), dataIndex: "load_hours", width: 110, align: "center" },
                { title: t("mrp.mps.rccpCapacity"), dataIndex: "capacity_hours", width: 110, align: "center" },
                {
                  title: t("mrp.mps.rccpRatio"),
                  dataIndex: "load_ratio",
                  width: 120,
                  align: "center",
                  render: (ratio: number) => {
                    const percent = Math.round(ratio * 100);
                    return (
                      <Tag color={percent > 100 ? "error" : percent >= 80 ? "warning" : "success"}>
                        {percent}%
                      </Tag>
                    );
                  },
                },
              ]}
            />
          </>
        )}
      </SimpleModal>

      <SimpleModal
        title={t("mrp.mps.pushResultTitle")}
        open={pushResult !== null}
        onCancel={() => setPushResult(null)}
        footer={
          <Button onClick={() => setPushResult(null)}>{t("common.close")}</Button>
        }
        width={720}
      >
        {pushResult && (
          <>
            <Alert
              style={{ marginBottom: 12 }}
              type={pushResult.failed > 0 ? "warning" : "success"}
              showIcon
              message={t("mrp.mps.pushResultSummary", {
                created: pushResult.created,
                failed: pushResult.failed,
              })}
            />
            <Table<PushItemResult>
              rowKey={(r) => `${r.lineId}-${r.productCode}`}
              dataSource={pushResult.items}
              pagination={false}
              size="small"
              columns={[
                { title: t("products.code"), dataIndex: "productCode", width: 120 },
                { title: t("products.name"), dataIndex: "productName" },
                { title: t("mrp.mps.mpsQty"), dataIndex: "quantity", width: 100, align: "center" },
                {
                  title: t("mrp.mps.result"),
                  width: 220,
                  render: (_: unknown, record: PushItemResult) =>
                    record.ok ? (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        {record.documentNo}
                      </Tag>
                    ) : (
                      <Tag color="error">{record.error}</Tag>
                    ),
                },
              ]}
            />
          </>
        )}
      </SimpleModal>
    </div>
  );
}
