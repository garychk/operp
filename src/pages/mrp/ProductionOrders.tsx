import { useEffect, useState } from "react";
import type { Key } from 'react';
import {
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  Table,
  message,
  InputNumber,
  DatePicker,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ApartmentOutlined,
  SafetyCertificateOutlined,
  ExportOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import { SuperTable } from "../../components/SuperTable";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import dayjs from "dayjs";
import { SupaModal } from "../../components/SupaModal";
import { useTranslation } from "react-i18next";

type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"];
type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Routing = Tables["erp_routing_operations_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];

type KitRow = {
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  order_detail_ids: number[] | null;
  required_quantity: number;
  issued_quantity: number;
  to_issue_quantity: number;
  warehouse_id: number | null;
  warehouse_quantity: number;
  total_quantity: number;
  shortage_quantity: number;
  suggested_warehouse_id: number | null;
  suggested_warehouse_name: string | null;
  kit_status: string;
};

const { Option } = Select;
const productionOrderTable = "erp_production_orders_s_539dcf81_b";

// 与 deploy_57 的四个 RPC 对应
const EXPLODE_RPC = "explode_production_order_bom";
const KIT_CHECK_RPC = "production_kit_check";
const GENERATE_ISSUE_RPC = "generate_material_issue_from_order";

// 已完成的订单不允许再展开/领料；与 explore RPC 的守卫保持一致
const CLOSED_STATUSES = ["completed", "closed", "cancelled"];
const DOC_TYPE = "production_order";

export function ProductionOrders() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [boms, setBoms] = useState<Bom[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [routings, setRoutings] = useState<Routing[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<ProductionOrder | null>(
    null,
  );
  const [form] = Form.useForm();
  const [kitRows, setKitRows] = useState<KitRow[]>([]);
  const [kitOrderNo, setKitOrderNo] = useState("");
  const [isKitModalOpen, setIsKitModalOpen] = useState(false);
  const [kitLoading, setKitLoading] = useState(false);
  const [exploding, setExploding] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetchOrders();
    fetchProducts();
    fetchBoms();
    fetchWorkCenters();
    fetchRoutings();
    fetchWarehouses();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(productionOrderTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("order_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching orders:", error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_manufactured", true);
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchBoms = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_boms_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_active", true);
      if (error) throw error;
      setBoms(data || []);
    } catch (error) {
      console.error("Error fetching boms:", error);
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

  const fetchRoutings = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_routing_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_active", true);
      if (error) throw error;
      setRoutings(data || []);
    } catch (error) {
      console.error("Error fetching routings:", error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_warehouses_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error("Error fetching warehouses:", error);
    }
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || "-";
  };

  const selectedOrders = () =>
    orders.filter((row) => selectedRowKeys.map(Number).includes(row.id));

  // 批量动作逐单执行：一单失败不影响其余单，失败原因逐条汇总
  const runSequential = async (
    targets: ProductionOrder[],
    action: (record: ProductionOrder) => Promise<string | void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    const notes: string[] = [];
    for (const record of targets) {
      try {
        const note = await action(record);
        success += 1;
        if (note) notes.push(`${record.order_no}：${note}`);
      } catch (error: any) {
        console.error("Error running production order batch action:", error);
        failures.push(`${record.order_no}：${error?.message || fallbackMessage}`);
      }
    }
    setSelectedRowKeys([]);
    await fetchOrders();
    return { success, failures, notes };
  };

  const handleExplodeBom = () => {
    const targets = selectedOrders().filter(
      (row) => !CLOSED_STATUSES.includes((row.status || "").toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionOrders.explodeNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionOrders.explodeBom"),
      content: t("mrp.productionOrders.explodeConfirm", { count: targets.length }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setExploding(true);
        try {
          const { success, failures, notes } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(EXPLODE_RPC, {
                p_order_id: record.id,
                p_replace: true,
              });
              if (error) throw error;
              const result = data as { bom_no?: string; line_count?: number };
              return t("mrp.productionOrders.explodeNote", {
                bom: result?.bom_no ?? "-",
                count: result?.line_count ?? 0,
              });
            },
            t("mrp.productionOrders.explodeFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionOrders.explodeSuccess", { count: success }),
            );
            if (notes.length > 0) {
              Modal.info({
                title: t("mrp.productionOrders.explodeBom"),
                content: (
                  <div>
                    {notes.map((note) => (
                      <div key={note}>{note}</div>
                    ))}
                  </div>
                ),
              });
            }
          } else {
            message.error(
              t("mrp.productionOrders.explodePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setExploding(false);
        }
      },
    });
  };

  const handleKitCheck = async () => {
    const targets = selectedOrders();
    if (targets.length !== 1) {
      message.warning(t("mrp.productionOrders.kitSingleOnly"));
      return;
    }
    const record = targets[0];
    setKitLoading(true);
    setIsKitModalOpen(true);
    setKitOrderNo(record.order_no);
    try {
      const { data, error } = await supabase.rpc(KIT_CHECK_RPC, {
        p_order_id: record.id,
      });
      if (error) throw error;
      const rows = (data || []) as KitRow[];
      setKitRows(rows);
      if (rows.length === 0) {
        message.warning(t("mrp.productionOrders.kitEmpty"));
      }
    } catch (error: any) {
      console.error("Error running kit check:", error);
      message.error(error?.message || t("mrp.productionOrders.kitFailed"));
      setKitRows([]);
    } finally {
      setKitLoading(false);
    }
  };

  const handleGenerateIssue = () => {
    const targets = selectedOrders().filter(
      (row) => !CLOSED_STATUSES.includes((row.status || "").toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionOrders.generateNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionOrders.generateIssue"),
      content: t("mrp.productionOrders.generateConfirm", { count: targets.length }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setGenerating(true);
        try {
          const { success, failures, notes } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(GENERATE_ISSUE_RPC, {
                p_order_id: record.id,
                p_warehouse_id: record.warehouse_id ?? null,
              });
              if (error) throw error;
              const result = data as { target_document_no?: string };
              return result?.target_document_no ?? "";
            },
            t("mrp.productionOrders.generateFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionOrders.generateSuccess", { count: success }),
            );
            if (notes.length > 0) {
              Modal.info({
                title: t("mrp.productionOrders.generateIssue"),
                content: (
                  <div>
                    {notes.map((note) => (
                      <div key={note}>{note}</div>
                    ))}
                  </div>
                ),
              });
            }
          } else {
            message.error(
              t("mrp.productionOrders.generatePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setGenerating(false);
        }
      },
    });
  };

  const kitStatusLabels: Record<string, { text: string; color: string }> = {
    done: { text: t("mrp.productionOrders.kitStatusDone"), color: "default" },
    ready: { text: t("mrp.productionOrders.kitStatusReady"), color: "success" },
    transfer: { text: t("mrp.productionOrders.kitStatusTransfer"), color: "warning" },
    short: { text: t("mrp.productionOrders.kitStatusShort"), color: "error" },
  };

  const formatQty = (value: number | null | undefined) =>
    Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

  const kitColumns = [
    {
      title: t("mrp.productionOrders.kitMaterial"),
      dataIndex: "product_code",
      key: "product_code",
      render: (code: string, row: KitRow) => (code ? `${code} - ${row.product_name}` : "-"),
    },
    {
      title: t("mrp.productionOrders.kitUnit"),
      dataIndex: "unit",
      key: "unit",
      width: 80,
      render: (unit: string) => unit || "-",
    },
    {
      title: t("mrp.productionOrders.kitRequired"),
      dataIndex: "required_quantity",
      key: "required_quantity",
      width: 100,
      render: (qty: number) => formatQty(qty),
    },
    {
      title: t("mrp.productionOrders.kitIssued"),
      dataIndex: "issued_quantity",
      key: "issued_quantity",
      width: 100,
      render: (qty: number) => formatQty(qty),
    },
    {
      title: t("mrp.productionOrders.kitToIssue"),
      dataIndex: "to_issue_quantity",
      key: "to_issue_quantity",
      width: 100,
      render: (qty: number) => <strong>{formatQty(qty)}</strong>,
    },
    {
      title: t("mrp.productionOrders.kitWarehouseStock"),
      dataIndex: "warehouse_quantity",
      key: "warehouse_quantity",
      width: 110,
      render: (qty: number, row: KitRow) => (
        <span title={getWarehouseName(row.warehouse_id)}>{formatQty(qty)}</span>
      ),
    },
    {
      title: t("mrp.productionOrders.kitTotalStock"),
      dataIndex: "total_quantity",
      key: "total_quantity",
      width: 100,
      render: (qty: number) => formatQty(qty),
    },
    {
      title: t("mrp.productionOrders.kitShortage"),
      dataIndex: "shortage_quantity",
      key: "shortage_quantity",
      width: 100,
      render: (qty: number) =>
        qty > 0 ? <span style={{ color: "#cf1322" }}>{formatQty(qty)}</span> : "-",
    },
    {
      title: t("mrp.productionOrders.kitSuggestedWarehouse"),
      dataIndex: "suggested_warehouse_name",
      key: "suggested_warehouse_name",
      width: 140,
      render: (name: string) => name || "-",
    },
    {
      title: t("common.status"),
      dataIndex: "kit_status",
      key: "kit_status",
      width: 100,
      render: (status: string) => {
        const config = kitStatusLabels[status] || { text: status, color: "default" };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
  ];

  const handleSubmit = async (values: any) => {
    try {
      if (editingOrder) {
        await logWithTiming("更新生产订单", "UPDATE", async () => {
          const { error } = await supabase
            .from(productionOrderTable)
            .update(values)
            .eq("id", editingOrder.id);
          if (error) throw error;
        }, { table: productionOrderTable, recordId: editingOrder.id });
        message.success(t('common.updateSuccess'));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: productionOrderTable,
        };
        const data = await logWithTiming("新增生产订单", "INSERT", async () => {
          const { data, error } = await supabase
            .from(productionOrderTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setEditingOrder(data);
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      fetchOrders();
    } catch (error) {
      console.error("Error saving order:", error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: ProductionOrder) => {
    setEditingOrder(record);
    form.setFieldsValue({ ...record
      ,order_date: dayjs(record.order_date)
      ,planned_start_date: dayjs(record.planned_start_date)
      ,planned_end_date: dayjs(record.planned_end_date)
      ,actual_start_date: dayjs(record.actual_start_date)
      ,actual_end_date: dayjs(record.actual_end_date)
     });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('mrp.productionOrders.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming("删除生产订单", "DELETE", async () => {
            const { error } = await supabase
              .from(productionOrderTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          }, { table: productionOrderTable, recordId: id });
          message.success(t('common.deleteSuccess'));
          fetchOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    let orderNo: string;
    try {
      orderNo = await nextDocumentNo(DOC_TYPE);
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditingOrder(null);
    form.setFieldsValue({
      order_no: orderNo,
      order_date: dayjs(new Date()),
      product_id: undefined,
      bom_id: undefined,
      routing_id: undefined,
      warehouse_id: undefined,
      planned_quantity: 1,
      completed_quantity: 0,
      scrapped_quantity: 0,
      planned_start_date: "",
      planned_end_date: "",
      actual_start_date: "",
      actual_end_date: "",
      work_center_id: undefined,
      priority: 1,
      remark: "",
      status: "draft",
    });
    setIsModalOpen(true);
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getWorkCenterName = (workCenterId: number | null) => {
    const workCenter = workCenters.find((w) => w.id === workCenterId);
    return workCenter?.name || "-";
  };

  const filteredOrders = orders.filter(
    (o) =>
      o.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(o.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('mrp.productionOrders.statusDraft'), color: "default" },
    planned: { text: t('mrp.productionOrders.statusPlanned'), color: "processing" },
    released: { text: t('mrp.productionOrders.statusReleased'), color: "warning" },
    in_progress: { text: t('mrp.productionOrders.statusInProgress'), color: "blue" },
    completed: { text: t('mrp.productionOrders.statusCompleted'), color: "success" },
    closed: { text: t('mrp.productionOrders.statusClosed'), color: "default" },
    cancelled: { text: t('mrp.productionOrders.statusCancelled'), color: "error" },
  };

  const priorityLabels: Record<number, string> = {
    1: t('mrp.productionOrders.priorityLow'),
    2: t('mrp.productionOrders.priorityMedium'),
    3: t('mrp.productionOrders.priorityHigh'),
    4: t('mrp.productionOrders.priorityUrgent'),
  };

  const columns = [
    {
      title: t('mrp.productionOrders.orderNo'),
      dataIndex: "order_no",
      key: "order_no",
    },
    {
      title: t('mrp.productionOrders.product'),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('mrp.productionOrders.plannedQuantity'),
      dataIndex: "planned_quantity",
      key: "planned_quantity",
    },
    {
      title: t('mrp.productionOrders.completedQuantity'),
      dataIndex: "completed_quantity",
      key: "completed_quantity",
      render: (qty: number) => qty || 0,
    },
    {
      title: t('mrp.productionOrders.plannedStart'),
      dataIndex: "planned_start_date",
      key: "planned_start_date",
      render: (text: string) => text || "-",
    },
    {
      title: t('mrp.productionOrders.plannedEnd'),
      dataIndex: "planned_end_date",
      key: "planned_end_date",
      render: (text: string) => text || "-",
    },
    {
      title: t('mrp.productionOrders.workCenter'),
      dataIndex: "work_center_id",
      key: "work_center_id",
      render: (workCenterId: number) => getWorkCenterName(workCenterId),
    },
    {
      title: t('mrp.productionOrders.priority'),
      dataIndex: "priority",
      key: "priority",
      render: (priority: number) => priorityLabels[priority] || t('mrp.productionOrders.priorityLow'),
    },
    {
      title: t('common.status'),
      dataIndex: "status",
      key: "status",
      render: (status: string) => {
        const config = statusLabels[status] || {
          text: status,
          color: "default",
        };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: "action",
      render: (_: any, record: ProductionOrder) => (
        <Space>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        toolbarActions={["delete" , "export"]}
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey={DOC_TYPE}
        headerTitle={t('mrp.productionOrders.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('mrp.productionOrders.add')}
            </Button>
            <Button
              icon={<ApartmentOutlined />}
              loading={exploding}
              disabled={selectedRowKeys.length === 0}
              onClick={handleExplodeBom}
            >
              {t('mrp.productionOrders.explodeBom')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              icon={<SafetyCertificateOutlined />}
              disabled={selectedRowKeys.length !== 1}
              onClick={handleKitCheck}
            >
              {t('mrp.productionOrders.kitCheck')}
            </Button>
            <Button
              icon={<ExportOutlined />}
              loading={generating}
              disabled={selectedRowKeys.length === 0}
              onClick={handleGenerateIssue}
            >
              {t('mrp.productionOrders.generateIssue')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('mrp.productionOrders.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchOrders}
              style={{ width: 160 }}
            />
          </Space>
        }
      />

      <Modal
        title={`${t('mrp.productionOrders.kitCheck')}${kitOrderNo ? ` - ${kitOrderNo}` : ""}`}
        open={isKitModalOpen}
        onCancel={() => setIsKitModalOpen(false)}
        footer={
          <Button onClick={() => setIsKitModalOpen(false)}>
            {t('common.close')}
          </Button>
        }
        width={1100}
      >
        <Table
          columns={kitColumns}
          dataSource={kitRows}
          rowKey={(row) => `${row.product_id}-${row.warehouse_id ?? 0}`}
          loading={kitLoading}
          pagination={false}
          size="small"
          scroll={{ y: 420, x: 1040 }}
          locale={{ emptyText: t('mrp.productionOrders.kitEmpty') }}
        />
      </Modal>

      <SupaModal
        title={editingOrder ? t('mrp.productionOrders.edit') : t('mrp.productionOrders.addTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
        }}
        historyTable={productionOrderTable}
        historyRecordId={editingOrder?.id}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            style={{ padding: "0 16px 0 0" }}
          >
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label={t('mrp.productionOrders.orderNo')}
                  name="order_no"
                  rules={[{ required: true, message: t('mrp.productionOrders.orderNoPrompt') }]}
                >
                  <Input placeholder={t('mrp.productionOrders.orderNoPrompt')} disabled={!!editingOrder} />
                </Form.Item>
                <Form.Item
                  label={t('mrp.productionOrders.orderDate')}
                  name="order_date"
                  rules={[{ required: true, message: t('mrp.productionOrders.orderDatePrompt') }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t('mrp.productionOrders.product')}
                  name="product_id"
                  rules={[{ required: true, message: t('mrp.productionOrders.productPrompt') }]}
                >
                  <Select placeholder={t('mrp.productionOrders.productPrompt')} disabled={!!editingOrder}>
                    {products.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.bom')} name="bom_id">
                  <Select placeholder={t('mrp.productionOrders.bomPrompt')}>
                    {boms.map((b) => (
                      <Option key={b.id} value={b.id}>
                        {b.bom_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.routing')} name="routing_id">
                  <Select placeholder={t('mrp.productionOrders.routingPrompt')} allowClear>
                    {routings.map((r) => (
                      <Option key={r.id} value={r.id}>
                        {r.routing_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('mrp.productionOrders.materialWarehouse')}
                  name="warehouse_id"
                  extra={t('mrp.productionOrders.materialWarehouseHint')}
                >
                  <Select
                    placeholder={t('mrp.productionOrders.materialWarehousePrompt')}
                    allowClear
                    showSearch
                    optionFilterProp="children"
                  >
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label={t('mrp.productionOrders.plannedQuantity')}
                  name="planned_quantity"
                  initialValue={1}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('mrp.productionOrders.plannedQuantityPrompt')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('mrp.productionOrders.completedQuantity')}
                  name="completed_quantity"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('mrp.productionOrders.completedQuantityPrompt')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('mrp.productionOrders.scrappedQuantity')}
                  name="scrapped_quantity"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('mrp.productionOrders.scrappedQuantityPrompt')}
                  />
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.plannedStartDate')} name="planned_start_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.plannedEndDate')} name="planned_end_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>

              </Col>
              <Col span={8}>
                <Form.Item label={t('mrp.productionOrders.actualStartDate')} name="actual_start_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.actualEndDate')} name="actual_end_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.workCenter')} name="work_center_id">
                  <Select placeholder={t('mrp.productionOrders.workCenterPrompt')}>
                    {workCenters.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('mrp.productionOrders.priority')} name="priority" initialValue={1}>
                  <Select>
                    <Option value={1}>{t('mrp.productionOrders.priorityLow')}</Option>
                    <Option value={2}>{t('mrp.productionOrders.priorityMedium')}</Option>
                    <Option value={3}>{t('mrp.productionOrders.priorityHigh')}</Option>
                    <Option value={4}>{t('mrp.productionOrders.priorityUrgent')}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t('common.status')} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t('mrp.productionOrders.statusDraft')}</Option>
                    <Option value="planned">{t('mrp.productionOrders.statusPlanned')}</Option>
                    <Option value="released">{t('mrp.productionOrders.statusReleased')}</Option>
                    <Option value="in_progress">{t('mrp.productionOrders.statusInProgress')}</Option>
                    <Option value="completed">{t('mrp.productionOrders.statusCompleted')}</Option>
                    <Option value="closed">{t('mrp.productionOrders.statusClosed')}</Option>
                    <Option value="cancelled">{t('mrp.productionOrders.statusCancelled')}</Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label={t('mrp.productionOrders.remark')} name="remark">
                  <Input.TextArea rows={2} placeholder={t('mrp.productionOrders.remarkPrompt')} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        headerPanelTitle={t('mrp.productionOrders.title')}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={'80%'}
        height={'80%'}
        workflowDocumentType={DOC_TYPE}
      />
    </div>
  );
}
