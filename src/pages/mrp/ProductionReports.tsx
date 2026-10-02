import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
  InputNumber,
  Row,
  Col,
  DatePicker,
  Alert,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckCircleOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { SuperTable } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

type ProductionReport = Tables["erp_production_reports_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type Employee = Tables["erp_employees_s_539dcf81_b"]["Row"];

const { Option } = Select;
const reportTable = "erp_production_reports_s_539dcf81_b";

const DOCUMENT_TYPE = "production_report";
const DRAFT_STATUS = "draft";
const CONFIRMED_STATUS = "confirmed";
const CANCELLED_STATUS = "cancelled";

/**
 * 报工只记录、不改库存、也不回写生产订单进度：
 *   · 库存以完工入库为准（post_production_document），报工若也加库存会双重计数；
 *   · 生产订单的 completed_quantity 同样留给完工入库，报工不抢这个口径。
 * 它的作用是给成本卷算提供「人工工时 / 机器工时」——但只有 confirmed 的报工才计入成本，
 * 这是「确认」动作存在的意义（草稿报工不入成本）。
 */
const isConfirmed = (record: { status: string | null }) =>
  record.status === CONFIRMED_STATUS;

const formatQuantity = (value: number | null | undefined) =>
  Number(value ?? 0).toLocaleString();

const formatHours = (value: number | null | undefined) =>
  Number(value ?? 0).toFixed(2);

const formatMoney = (value: number | null | undefined) =>
  `¥${(value ?? 0).toFixed(2)}`;

export function ProductionReports() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<ProductionReport[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReport, setEditingReport] = useState<ProductionReport | null>(
    null,
  );
  const [form] = Form.useForm();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    fetchReports();
    fetchProducts();
    fetchOrders();
    fetchWorkCenters();
    fetchOperations();
    fetchEmployees();
  }, []);

  const fetchReports = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(reportTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("report_date", { ascending: false });
      if (error) throw error;
      setReports(data || []);
    } catch (error) {
      console.error("Error fetching production reports:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchOrders = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_production_orders_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching production orders:", error);
    }
  };

  const fetchWorkCenters = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_work_centers_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error("Error fetching work centers:", error);
    }
  };

  const fetchOperations = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error("Error fetching operations:", error);
    }
  };

  const fetchEmployees = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_employees_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setEmployees(data || []);
    } catch (error) {
      console.error("Error fetching employees:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload: any = {
        ...values,
        report_date: values.report_date
          ? dayjs(values.report_date).format("YYYY-MM-DD")
          : null,
        completed_quantity: Number(values.completed_quantity || 0),
        scrapped_quantity: Number(values.scrapped_quantity || 0),
        labor_hours: Number(values.labor_hours || 0),
        machine_hours: Number(values.machine_hours || 0),
        operation_id: values.operation_id ?? null,
        work_center_id: values.work_center_id ?? null,
        operator_id: values.operator_id ?? null,
      };

      if (editingReport) {
        await logWithTiming(
          t("mrp.productionReports.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(reportTable)
              .update(payload)
              .eq("id", editingReport.id);
            if (error) throw error;
          },
          { table: reportTable, recordId: editingReport.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        payload.is_deleted = "n";
        await logWithTiming(
          t("mrp.productionReports.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase
              .from(reportTable)
              .insert([payload]);
            if (error) throw error;
          },
          { table: reportTable },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReport(null);
      fetchReports();
    } catch (error: any) {
      console.error("Error saving production report:", error);
      message.error(error?.message || t("common.saveFailed"));
    }
  };

  const handleEdit = (record: ProductionReport) => {
    if (isConfirmed(record)) {
      message.warning(t("mrp.productionReports.confirmedLocked"));
      return;
    }
    setEditingReport(record);
    form.setFieldsValue({
      ...record,
      report_date: record.report_date ? dayjs(record.report_date) : undefined,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = reports.find((r) => r.id === id);
    if (target && isConfirmed(target)) {
      message.warning(t("mrp.productionReports.confirmedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.productionReports.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.productionReports.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(reportTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: reportTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          fetchReports();
        } catch (error) {
          console.error("Error deleting production report:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  // 逐单执行：一条失败不影响其余，失败原因逐条汇总
  const runSequential = async (
    targets: ProductionReport[],
    action: (record: ProductionReport) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running production report batch action:", error);
        failures.push(`${record.report_no}：${error?.message || fallbackMessage}`);
      }
    }
    setSelectedRowKeys([]);
    await fetchReports();
    return { success, failures };
  };

  const handleBatchConfirm = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = reports.filter(
      (row) =>
        selectedIds.has(row.id) &&
        (row.status || "").toLowerCase() === DRAFT_STATUS,
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionReports.confirmNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionReports.confirm"),
      content: t("mrp.productionReports.confirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setConfirming(true);
        try {
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              await logWithTiming(
                t("mrp.productionReports.logConfirm"),
                "UPDATE",
                async () => {
                  const { error } = await supabase
                    .from(reportTable)
                    .update({ status: CONFIRMED_STATUS })
                    .eq("id", record.id);
                  if (error) throw error;
                },
                { table: reportTable, recordId: record.id },
              );
            },
            t("mrp.productionReports.confirmFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionReports.confirmSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.productionReports.confirmPartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setConfirming(false);
        }
      },
    });
  };

  const handleBatchRevoke = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = reports.filter(
      (row) => selectedIds.has(row.id) && isConfirmed(row),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionReports.revokeNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionReports.revoke"),
      content: t("mrp.productionReports.revokeContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRevoking(true);
        try {
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              await logWithTiming(
                t("mrp.productionReports.logRevoke"),
                "UPDATE",
                async () => {
                  const { error } = await supabase
                    .from(reportTable)
                    .update({ status: DRAFT_STATUS })
                    .eq("id", record.id);
                  if (error) throw error;
                },
                { table: reportTable, recordId: record.id },
              );
            },
            t("mrp.productionReports.revokeFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionReports.revokeSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.productionReports.revokePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setRevoking(false);
        }
      },
    });
  };

  const handleAdd = async () => {
    let reportNo: string;
    try {
      reportNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(
        `${t("common.documentNoFailed")}：${(error as Error).message}`,
      );
      return;
    }
    setEditingReport(null);
    form.setFieldsValue({
      report_no: reportNo,
      report_date: dayjs(new Date()),
      production_order_id: undefined,
      operation_id: undefined,
      completed_quantity: 0,
      scrapped_quantity: 0,
      labor_hours: 0,
      machine_hours: 0,
      work_center_id: undefined,
      operator_id: undefined,
      remark: "",
      status: DRAFT_STATUS,
    });
    setIsModalOpen(true);
  };

  // 选生产订单后带出默认工作中心（订单上没有就留空，不猜）
  const handleOrderChange = (orderId: number | undefined) => {
    if (!orderId) return;
    const order = orders.find((o) => o.id === orderId);
    if (order?.work_center_id && !form.getFieldValue("work_center_id")) {
      form.setFieldsValue({ work_center_id: order.work_center_id });
    }
  };

  const getOrderLabel = (orderId: number | null) => {
    const order = orders.find((o) => o.id === orderId);
    return order?.order_no || "-";
  };

  const getOrderProductName = (orderId: number | null) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order?.product_id) return "-";
    const product = products.find((p) => p.id === order.product_id);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getWorkCenterName = (centerId: number | null) => {
    const center = workCenters.find((c) => c.id === centerId);
    return center ? `${center.code} - ${center.name}` : "-";
  };

  const getOperationName = (operationId: number | null) => {
    if (!operationId) return "-";
    const operation = operations.find((o) => o.id === operationId);
    return operation ? `${operation.code} - ${operation.name}` : "-";
  };

  const getOperatorName = (operatorId: number | null) => {
    if (!operatorId) return "-";
    const employee = employees.find((e) => e.id === operatorId);
    return employee?.name || "-";
  };

  // 工时成本口径提示：只有已确认报工才进成本卷算
  const estimateLaborCost = (centerId: number | null, laborHours: number, machineHours: number) => {
    if (!centerId) return null;
    const center = workCenters.find((c) => c.id === centerId);
    if (!center) return null;
    return (
      Number(laborHours || 0) * Number(center.labor_rate || 0) +
      Number(machineHours || 0) * Number(center.overhead_rate || 0)
    );
  };

  const filteredReports = reports.filter(
    (r) =>
      (r.report_no || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderLabel(r.production_order_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.productionReports.statusDraft"), color: "default" },
    confirmed: {
      text: t("mrp.productionReports.statusConfirmed"),
      color: "success",
    },
    cancelled: {
      text: t("mrp.productionReports.statusCancelled"),
      color: "error",
    },
  };

  const formWorkCenterId = Form.useWatch("work_center_id", form);
  const formLaborHours = Form.useWatch("labor_hours", form);
  const formMachineHours = Form.useWatch("machine_hours", form);
  const estimatedCost = estimateLaborCost(
    formWorkCenterId ?? null,
    Number(formLaborHours || 0),
    Number(formMachineHours || 0),
  );

  const columns = [
    {
      title: t("mrp.productionReports.reportNo"),
      dataIndex: "report_no",
      key: "report_no",
    },
    {
      title: t("mrp.productionReports.reportDate"),
      dataIndex: "report_date",
      key: "report_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.productionReports.productionOrder"),
      dataIndex: "production_order_id",
      key: "production_order_id",
      render: (orderId: number) => getOrderLabel(orderId),
    },
    {
      title: t("mrp.productionReports.product"),
      dataIndex: "productViaOrder",
      key: "productViaOrder",
      render: (_: unknown, record: ProductionReport) =>
        getOrderProductName(record.production_order_id),
    },
    {
      title: t("mrp.productionReports.operation"),
      dataIndex: "operation_id",
      key: "operation_id",
      render: (operationId: number) => getOperationName(operationId),
    },
    {
      title: t("mrp.productionReports.workCenter"),
      dataIndex: "work_center_id",
      key: "work_center_id",
      render: (centerId: number) => getWorkCenterName(centerId),
    },
    {
      title: t("mrp.productionReports.operator"),
      dataIndex: "operator_id",
      key: "operator_id",
      render: (operatorId: number) => getOperatorName(operatorId),
    },
    {
      title: t("mrp.productionReports.completedQuantity"),
      dataIndex: "completed_quantity",
      key: "completed_quantity",
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.productionReports.scrappedQuantity"),
      dataIndex: "scrapped_quantity",
      key: "scrapped_quantity",
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.productionReports.laborHours"),
      dataIndex: "labor_hours",
      key: "labor_hours",
      render: (hours: number) => formatHours(hours),
    },
    {
      title: t("mrp.productionReports.machineHours"),
      dataIndex: "machine_hours",
      key: "machine_hours",
      render: (hours: number) => formatHours(hours),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: "default" };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: ProductionReport) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            disabled={isConfirmed(record)}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={isConfirmed(record)}
            onClick={() => handleDelete(record.id)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredReports}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="production-reports"
        headerTitle={t("mrp.productionReports.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.productionReports.add")}
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={confirming}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchConfirm}
            >
              {t("mrp.productionReports.confirm")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={revoking}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchRevoke}
            >
              {t("mrp.productionReports.revoke")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.productionReports.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReports}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={
          editingReport
            ? t("mrp.productionReports.editTitle")
            : t("mrp.productionReports.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReport(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
                form.resetFields();
                setEditingReport(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={780}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.productionReports.costHint")}
        />
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReports.reportNo")}
                name="report_no"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReports.reportNoPrompt"),
                  },
                ]}
              >
                <Input
                  placeholder={t("mrp.productionReports.reportNoPrompt")}
                  disabled={!!editingReport}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReports.reportDate")}
                name="report_date"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReports.reportDatePrompt"),
                  },
                ]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReports.productionOrder")}
                name="production_order_id"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReports.productionOrderPrompt"),
                  },
                ]}
                extra={t("mrp.productionReports.productionOrderHint")}
              >
                <Select
                  placeholder={t("mrp.productionReports.productionOrderPrompt")}
                  showSearch
                  optionFilterProp="children"
                  onChange={handleOrderChange}
                >
                  {orders.map((o) => (
                    <Option key={o.id} value={o.id}>
                      {o.order_no}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReports.operation")}
                name="operation_id"
              >
                <Select
                  allowClear
                  placeholder={t("mrp.productionReports.operationPrompt")}
                  showSearch
                  optionFilterProp="children"
                >
                  {operations.map((o) => (
                    <Option key={o.id} value={o.id}>
                      {o.code} - {o.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.completedQuantity")}
                name="completed_quantity"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.scrappedQuantity")}
                name="scrapped_quantity"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.workCenter")}
                name="work_center_id"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReports.workCenterPrompt"),
                  },
                ]}
                extra={t("mrp.productionReports.workCenterHint")}
              >
                <Select
                  placeholder={t("mrp.productionReports.workCenterPrompt")}
                  showSearch
                  optionFilterProp="children"
                >
                  {workCenters.map((c) => (
                    <Option key={c.id} value={c.id}>
                      {c.code} - {c.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.laborHours")}
                name="labor_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.01}
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.machineHours")}
                name="machine_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.01}
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReports.operator")}
                name="operator_id"
              >
                <Select
                  allowClear
                  placeholder={t("mrp.productionReports.operatorPrompt")}
                  showSearch
                  optionFilterProp="children"
                >
                  {employees.map((e) => (
                    <Option key={e.id} value={e.id}>
                      {e.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          {estimatedCost != null && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("mrp.productionReports.estimatedCost", {
                cost: formatMoney(estimatedCost),
              })}
            />
          )}

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("common.status")}
                name="status"
                initialValue={DRAFT_STATUS}
              >
                <Select>
                  <Option value={DRAFT_STATUS}>
                    {t("mrp.productionReports.statusDraft")}
                  </Option>
                  <Option value={CANCELLED_STATUS}>
                    {t("mrp.productionReports.statusCancelled")}
                  </Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label={t("mrp.productionReports.remark")} name="remark">
            <Input.TextArea
              rows={3}
              placeholder={t("mrp.productionReports.remarkPrompt")}
            />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
