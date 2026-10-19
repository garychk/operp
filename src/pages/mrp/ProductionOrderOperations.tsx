import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Modal, Progress, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined, RocketOutlined, FileAddOutlined } from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { formatQuantity } from "../../utils/money";
import { logWithTiming } from "../../utils/logger";
import { nextDocumentNo } from "../../utils/documentNaming";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

type OrderOperation = Tables["erp_production_order_operations_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Employee = Tables["erp_employees_s_539dcf81_b"]["Row"];

const OPERATIONS_TABLE = "erp_production_order_operations_s_539dcf81_b";
const REPORTS_TABLE = "erp_production_reports_s_539dcf81_b";
const REPORT_DOC_TYPE = "production_report";
const RELEASE_RPC = "release_production_order";
const STATUS_LABELS = ["pending", "in_progress", "completed", "cancelled"] as const;

// 终态工单不再允许下达/重新生成工序（与 release_production_order 的守卫一致）
const TERMINAL_ORDER_STATUSES = ["completed", "closed", "cancelled"];
// 这两个状态下「下达」才有推进意义；released/in_progress 用同一个 RPC 做「补生成工序」
const PRE_RELEASE_STATUSES = ["draft", "planned"];

/** 员工是否启用（`erp_employees` 用的是 `status` 列，本表没有 `is_active`） */
const isEmployeeActive = (e: Employee) => (e.status || "active") === "active";

/**
 * 工单工序页签（P0-1，deploy_115 / deploy_116）。
 *
 * 只读 + 派工：完工数 / 状态 / 实际起止**全部由报工驱动**（数据库触发器回写），
 * 页面绝不自己算进度 —— 否则页面显示的进度会与看板、报表各说各话。
 * 页面上唯一能改的是「派工对象」（assignee_id），那是计划员的排产决策。
 */
export function ProductionOrderOperations({
  orderId,
  orderStatus,
  onDataChanged,
}: {
  orderId: number;
  orderStatus?: string | null;
  onDataChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<OrderOperation[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [generatingReports, setGeneratingReports] = useState(false);

  const fetchRows = useCallback(async () => {
    if (!orderId) return;
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(OPERATIONS_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("sequence_no")
        .order("line_no");
      if (error) throw error;
      setRows(data || []);
    } catch (error) {
      console.error("Error fetching order operations:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [orderId, t]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    const load = async () => {
      try {
        const [ops, wcs, emps] = await Promise.all([
          supabase.from("erp_operations_s_539dcf81_b").select("*").eq("is_deleted", "n"),
          supabase.from("erp_work_centers_s_539dcf81_b").select("*").eq("is_deleted", "n"),
          // 取全部在册员工：**选项**只给启用的，但已派工的人若后来停用，
          // 仍要能查出姓名（否则历史派工会退化成显示数字 id）
          supabase
            .from("erp_employees_s_539dcf81_b")
            .select("*")
            .eq("is_deleted", "n"),
        ]);
        if (ops.error) throw ops.error;
        if (wcs.error) throw wcs.error;
        if (emps.error) throw emps.error;
        setOperations(ops.data || []);
        setWorkCenters(wcs.data || []);
        setEmployees(emps.data || []);
      } catch (error) {
        console.error("Error fetching operation master data:", error);
      }
    };
    void load();
  }, []);

  const handleAssign = async (record: OrderOperation, assigneeId: number | undefined) => {
    if ((record.status || "") === "cancelled") {
      message.warning(t("mrp.productionOrderOperations.cancelledLocked"));
      return;
    }
    // 双保险：UI 已把停用员工的选项置灰，这里再拦一次（避免旧页面 / 竞态下派给离职的人）
    if (assigneeId != null) {
      const target = employees.find((e) => e.id === assigneeId);
      if (target && !isEmployeeActive(target)) {
        message.warning(t("mrp.productionOrderOperations.assigneeInactiveBlocked"));
        return;
      }
    }
    try {
      setAssigning(record.id);
      await logWithTiming(
        t("mrp.productionOrderOperations.logAssign"),
        "UPDATE",
        async () => {
          const { error } = await supabase
            .from(OPERATIONS_TABLE)
            .update({ assignee_id: assigneeId ?? null })
            .eq("id", record.id);
          if (error) throw error;
        },
        { table: OPERATIONS_TABLE, recordId: record.id },
      );
      message.success(t("mrp.productionOrderOperations.assignSuccess"));
      await fetchRows();
      onDataChanged?.();
    } catch (error: any) {
      console.error("Error assigning operation:", error);
      message.error(error?.message || t("common.saveFailed"));
    } finally {
      setAssigning(null);
    }
  };

  // 把 RPC 的原生报错翻译成「下一步该去哪」——「No active routing」是新用户最常撞的墙
  const releaseErrorText = (error: any): string => {
    const raw = String(error?.message || error?.details || "").trim();
    if (/No active routing/i.test(raw)) {
      return t("mrp.productionOrderOperations.releaseNoRouting");
    }
    if (/没有工序明细/.test(raw)) {
      return t("mrp.productionOrderOperations.releaseRoutingEmpty");
    }
    return raw || t("mrp.productionOrderOperations.releaseHereFailed");
  };

  // 空态就地「下达」——省得用户跑回列表页先勾行再点按钮。
  // deploy_116 的 RPC 对 released 状态同样幂等，所以「已下达但工序行缺失」时
  // 点同一个按钮就是「按工艺路线补生成工序」。
  const handleRelease = () => {
    Modal.confirm({
      title: releasableNow
        ? t("mrp.productionOrderOperations.releaseHere")
        : t("mrp.productionOrderOperations.regenerate"),
      content: t("mrp.productionOrderOperations.releaseHereConfirm"),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setReleasing(true);
        try {
          const { data, error } = await supabase.rpc(RELEASE_RPC, {
            p_order_id: orderId,
          });
          if (error) throw error;
          const count = Number((data as { operation_count?: number } | null)?.operation_count ?? 0);
          if (count > 0) {
            message.success(
              t("mrp.productionOrderOperations.releaseHereSuccess", { count }),
            );
          } else {
            message.warning(t("mrp.productionOrderOperations.releaseHereNoRows"));
          }
          await fetchRows();
          onDataChanged?.();
        } catch (error: any) {
          console.error("Error releasing production order:", error);
          message.error(releaseErrorText(error), 8);
        } finally {
          setReleasing(false);
        }
      },
    });
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    pending: { text: t("mrp.productionOrderOperations.statusPending"), color: "default" },
    in_progress: { text: t("mrp.productionOrderOperations.statusInProgress"), color: "processing" },
    completed: { text: t("mrp.productionOrderOperations.statusCompleted"), color: "success" },
    cancelled: { text: t("mrp.productionOrderOperations.statusCancelled"), color: "error" },
  };

  // 把「未完成工序」的剩余计划数量生成草稿报工单。
  // 口径：status != cancelled 且 planned_quantity > completed_quantity 的工序，
  // 每道工序一张草稿报工单，数量 = 计划 - 已完成（报废不参与剩余计算）。
  // 报工单只记工时、不入成本（草稿），后续到「生产报工」确认后才会回写工序完工数与进度。
  const handleGenerateReports = () => {
    const pendingRows = liveRows.filter(
      (r) => Number(r.planned_quantity || 0) > Number(r.completed_quantity || 0),
    );
    if (pendingRows.length === 0) {
      message.info(t("mrp.productionOrderOperations.noPendingOperation"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionOrderOperations.generateReports"),
      content: t("mrp.productionOrderOperations.generateReportsConfirm", {
        count: pendingRows.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setGeneratingReports(true);
        try {
          for (const row of pendingRows) {
            const remaining = Number(row.planned_quantity || 0) - Number(row.completed_quantity || 0);
            const reportNo = await nextDocumentNo(REPORT_DOC_TYPE);
            const laborHours = Number(
              (Number(row.standard_hours_per_unit || 0) * remaining).toFixed(2),
            );
            await logWithTiming(
              t("mrp.productionOrderOperations.logGenerateReports"),
              "INSERT",
              async () => {
                const { error } = await supabase.from(REPORTS_TABLE).insert([
                  {
                    report_no: reportNo,
                    report_date: dayjs().format("YYYY-MM-DD"),
                    production_order_id: orderId,
                    operation_id: row.operation_id ?? null,
                    order_operation_id: row.id,
                    completed_quantity: remaining,
                    scrapped_quantity: 0,
                    labor_hours: laborHours,
                    machine_hours: 0,
                    work_center_id: row.work_center_id ?? null,
                    operator_id: row.assignee_id ?? null,
                    status: "draft",
                    is_deleted: "n",
                  },
                ]);
                if (error) throw error;
              },
              { table: REPORTS_TABLE },
            );
          }
          message.success(
            t("mrp.productionOrderOperations.generateReportsSuccess", {
              count: pendingRows.length,
            }),
          );
          await fetchRows();
          onDataChanged?.();
        } catch (error: any) {
          console.error("Error generating production reports:", error);
          message.error(
            error?.message || t("mrp.productionOrderOperations.generateReportsFailed"),
          );
        } finally {
          setGeneratingReports(false);
        }
      },
    });
  };

  const getOperationLabel = (operationId: number | null) => {
    const op = operations.find((o) => o.id === operationId);
    if (!op) return "-";
    return `${op.code} - ${op.name}`;
  };

  const getWorkCenterName = (workCenterId: number | null) => {
    const wc = workCenters.find((w) => w.id === workCenterId);
    return wc?.name || "-";
  };

  // 只看未取消的工序（与数据库进度口径一致）
  const liveRows = rows.filter((r) => (r.status || "") !== "cancelled");
  const totalHours = liveRows.reduce((s, r) => s + Number(r.planned_hours || 0), 0);
  const earnedHours = liveRows.reduce((s, r) => {
    const planned = Number(r.planned_hours || 0);
    const qty = Number(r.planned_quantity || 0);
    const done = Number(r.completed_quantity || 0);
    if (planned <= 0) return s;
    if (qty > 0) return s + planned * Math.min(1, done / qty);
    return s + (done > 0 ? planned : 0);
  }, 0);
  const doneCount = liveRows.filter((r) => r.status === "completed").length;
  const progress = totalHours > 0
    ? Math.round(Math.min(1, earnedHours / totalHours) * 10000) / 100
    : liveRows.length > 0
      ? Math.round((doneCount / liveRows.length) * 10000) / 100
      : 0;
  const allDone = liveRows.length > 0 && doneCount === liveRows.length;
  const lastRow = liveRows.length > 0 ? liveRows[liveRows.length - 1] : null;

  // 空态可执行动作：终态工单不给按（RPC 也会拒），draft/planned 是「下达」，其余是「补生成」
  const orderStatusLower = (orderStatus || "").toLowerCase();
  const releasableNow = PRE_RELEASE_STATUSES.includes(orderStatusLower);
  const canRelease = !TERMINAL_ORDER_STATUSES.includes(orderStatusLower);

  const emptyNode = (
    <Space direction="vertical" align="center" size={6} style={{ width: "100%", padding: "16px 0" }}>
      <span>{t("mrp.productionOrderOperations.empty")}</span>
      {canRelease ? (
        <>
          <Typography.Text type="secondary">
            {t("mrp.productionOrderOperations.releaseHereHint")}
          </Typography.Text>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            loading={releasing}
            onClick={handleRelease}
          >
            {releasableNow
              ? t("mrp.productionOrderOperations.releaseHere")
              : t("mrp.productionOrderOperations.regenerate")}
          </Button>
        </>
      ) : (
        <Typography.Text type="secondary">
          {t("mrp.productionOrderOperations.emptyTerminal", { status: orderStatus || "-" })}
        </Typography.Text>
      )}
    </Space>
  );

  const columns = [
    {
      title: t("mrp.productionOrderOperations.sequence"),
      dataIndex: "sequence_no",
      key: "sequence_no",
      width: 80,
    },
    {
      title: t("mrp.productionOrderOperations.operation"),
      dataIndex: "operation_id",
      key: "operation_id",
      render: (v: number | null) => getOperationLabel(v),
    },
    {
      title: t("mrp.productionOrderOperations.workCenter"),
      dataIndex: "work_center_id",
      key: "work_center_id",
      render: (v: number | null) => getWorkCenterName(v),
    },
    {
      title: t("mrp.productionOrderOperations.plannedQuantity"),
      dataIndex: "planned_quantity",
      key: "planned_quantity",
      align: "right" as const,
      render: (v: number | null) => formatQuantity(v),
    },
    {
      title: t("mrp.productionOrderOperations.completedQuantity"),
      dataIndex: "completed_quantity",
      key: "completed_quantity",
      align: "right" as const,
      render: (v: number | null, record: OrderOperation) => {
        const plan = Number(record.planned_quantity || 0);
        const done = Number(v || 0);
        return (
          <Tooltip title={plan > 0 ? `${formatQuantity(done)} / ${formatQuantity(plan)}` : undefined}>
            <span style={plan > 0 && done > plan ? { color: "#cf1322" } : undefined}>
              {formatQuantity(done)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: t("mrp.productionOrderOperations.scrappedQuantity"),
      dataIndex: "scrapped_quantity",
      key: "scrapped_quantity",
      align: "right" as const,
      render: (v: number | null) => {
        const n = Number(v || 0);
        return n > 0 ? <span style={{ color: "#cf1322" }}>{formatQuantity(n)}</span> : formatQuantity(n);
      },
    },
    {
      title: t("mrp.productionOrderOperations.plannedHours"),
      dataIndex: "planned_hours",
      key: "planned_hours",
      align: "right" as const,
      render: (v: number | null, record: OrderOperation) => (
        <Tooltip
          title={t("mrp.productionOrderOperations.hoursBreakdown", {
            setup: formatQuantity(record.setup_hours),
            unit: formatQuantity(record.standard_hours_per_unit),
          })}
        >
          {formatQuantity(v)}
        </Tooltip>
      ),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string | null) => {
        const config = statusLabels[status || ""] || { text: status || "-", color: "default" };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t("mrp.productionOrderOperations.actualPeriod"),
      key: "actual",
      render: (_: unknown, record: OrderOperation) =>
        record.actual_start_date || record.actual_end_date
          ? `${record.actual_start_date || "-"} ~ ${record.actual_end_date || "-"}`
          : "-",
    },
    {
      title: t("mrp.productionOrderOperations.assignee"),
      dataIndex: "assignee_id",
      key: "assignee_id",
      render: (v: number | null, record: OrderOperation) => (
        <Select
          allowClear
          size="small"
          style={{ width: 140 }}
          placeholder={t("mrp.productionOrderOperations.assigneePlaceholder")}
          value={v ?? undefined}
          loading={assigning === record.id}
          disabled={(record.status || "") === "cancelled"}
          onChange={(next) => void handleAssign(record, next)}
          // 派工只给「启用」员工 —— 离职的人不该再被派活。
          // 但**不把停用员工从选项里剔除**：用 disabled 保留姓名，否则已派工的历史记录
          // 会因为找不到匹配 option 而退化成显示数字 id（看起来像数据坏了）。
          options={employees.map((e) => ({
            value: e.id,
            label: isEmployeeActive(e)
              ? e.name
              : `${e.name}（${t("mrp.productionOrderOperations.assigneeInactive")}）`,
            disabled: !isEmployeeActive(e),
          }))}
        />
      ),
    },
    {
      title: t("mrp.productionOrderOperations.inspection"),
      dataIndex: "is_inspection_required",
      key: "is_inspection_required",
      width: 90,
      render: (v: boolean | null) =>
        v ? <Tag color="purple">{t("mrp.productionOrderOperations.needInspection")}</Tag> : null,
    },
  ];

  if (!orderId) {
    return <Alert type="info" showIcon message={t("mrp.productionOrderOperations.saveFirst")} />;
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        {rows.length > 0 && (
          <>
            <span>{t("mrp.productionOrderOperations.summary", { done: doneCount, total: liveRows.length })}</span>
            <Progress
              percent={progress}
              style={{ width: 200 }}
              status={allDone ? "success" : "active"}
            />
            <span>
              {t("mrp.productionOrderOperations.lastOutput", {
                qty: formatQuantity(lastRow?.completed_quantity),
              })}
            </span>
          </>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => void fetchRows()} loading={loading}>
          {t("common.refresh")}
        </Button>
        {liveRows.length > 0 && (
          <Button
            type="primary"
            ghost
            icon={<FileAddOutlined />}
            loading={generatingReports}
            onClick={handleGenerateReports}
          >
            {t("mrp.productionOrderOperations.generateReports")}
          </Button>
        )}
      </Space>

      {/* 口径提示：进度只认已确认报工 —— 不写清楚，车间会以为「报了没生效」。
          没工序行时这条提示没有意义（还没进入报工环节），所以只在有工序时展示。 */}
      {rows.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message={t("mrp.productionOrderOperations.confirmOnlyHint")}
        />
      )}

      {rows.length > 0 && totalHours <= 0 && liveRows.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={t("mrp.productionOrderOperations.noHoursHint")}
        />
      )}

      {allDone && !["completed", "closed"].includes((orderStatus || "").toLowerCase()) && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 8 }}
          message={t("mrp.productionOrderOperations.allDoneHint")}
        />
      )}

      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        columns={columns}
        loading={loading}
        pagination={false}
        scroll={{ y: 360, x: 1180 }}
        locale={{ emptyText: emptyNode }}
      />
    </div>
  );
}

// 供 lint 使用的常量导出（状态枚举与库内 CHECK 保持一致）
export const ORDER_OPERATION_STATUSES = STATUS_LABELS;
