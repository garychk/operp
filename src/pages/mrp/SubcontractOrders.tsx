import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Table,
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
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  BranchesOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { SuperTable } from "../../components/SuperTable";
import { useCurrencyRegistry } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

type SubcontractOrder = Tables["erp_subcontract_orders_s_539dcf81_b"]["Row"];
type SubcontractOrderDetail =
  Tables["erp_subcontract_order_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Supplier = Tables["erp_suppliers_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];
type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"];

const { Option } = Select;
const orderTable = "erp_subcontract_orders_s_539dcf81_b";
const orderDetailTable = "erp_subcontract_order_details_s_539dcf81_b";
/** deploy_103：按 BOM 展开应发料明细（幂等，重复调用返回 already_built） */
const BUILD_MATERIALS_RPC = "build_subcontract_order_materials";
const DOCUMENT_TYPE = "subcontract_order";

/** 只有这两个状态允许改应发料：一旦发过料，删行会打断 issued/consumed 跟踪 */
const EDITABLE_STATUSES = ["draft", "approved", "released"];

const isEditable = (record: { status: string | null }) =>
  EDITABLE_STATUSES.includes((record.status || "").toLowerCase());

export function SubcontractOrders() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity, currencyLabel, currencies } =
    useCurrencyRegistry();
  const [orders, setOrders] = useState<SubcontractOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [boms, setBoms] = useState<Bom[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SubcontractOrder | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<SubcontractOrder | null>(null);
  const [details, setDetails] = useState<SubcontractOrderDetail[]>([]);
  const [editingDetail, setEditingDetail] =
    useState<SubcontractOrderDetail | null>(null);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [building, setBuilding] = useState(false);
  const [headerProductId, setHeaderProductId] = useState<number | undefined>();

  useEffect(() => {
    fetchOrders();
    fetchProducts();
    fetchSuppliers();
    fetchWarehouses();
    fetchBins();
    fetchBoms();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(orderTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("order_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching subcontract orders:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from("erp_products_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setProducts(data || []);
  };

  const fetchSuppliers = async () => {
    const { data } = await supabase
      .from("erp_suppliers_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setSuppliers(data || []);
  };

  const fetchWarehouses = async () => {
    const { data } = await supabase
      .from("erp_warehouses_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setWarehouses(data || []);
  };

  const fetchBins = async () => {
    const { data } = await supabase
      .from("erp_bins_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setBins(data || []);
  };

  const fetchBoms = async () => {
    const { data } = await supabase
      .from("erp_boms_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setBoms(data || []);
  };

  const fetchDetails = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from(orderDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching subcontract order details:", error);
      message.error(t("mrp.subcontractOrders.fetchDetailsFailed"));
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        order_date: values.order_date
          ? dayjs(values.order_date).format("YYYY-MM-DD")
          : undefined,
        required_date: values.required_date
          ? dayjs(values.required_date).format("YYYY-MM-DD")
          : null,
        amount: Number(values.quantity || 0) * Number(values.unit_price || 0),
      };
      if (editingOrder) {
        await logWithTiming(
          "更新委外订单",
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(orderTable)
              .update(payload)
              .eq("id", editingOrder.id);
            if (error) throw error;
          },
          { table: orderTable, recordId: editingOrder.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: orderTable,
        };
        const data = await logWithTiming(
          "新增委外订单",
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(orderTable)
              .insert([payload])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedOrder(data as SubcontractOrder);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      setHeaderProductId(undefined);
      fetchOrders();
    } catch (error) {
      console.error("Error saving subcontract order:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedOrder) {
        message.warning(t("mrp.subcontractOrders.saveHeaderFirst"));
        return;
      }
      if (editingDetail) {
        const { error } = await supabase
          .from(orderDetailTable)
          .update({
            material_id: values.material_id,
            required_quantity: Number(values.required_quantity || 0),
            remark: values.remark ?? null,
          })
          .eq("id", editingDetail.id);
        if (error) throw error;
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo =
          details.length > 0 ? Math.max(...details.map((d) => d.line_no || 0)) : 0;
        const { error } = await supabase.from(orderDetailTable).insert([
          {
            order_id: selectedOrder.id,
            line_no: maxLineNo + 1,
            material_id: values.material_id,
            required_quantity: Number(values.required_quantity || 0),
            remark: values.remark ?? null,
            is_deleted: "n",
          },
        ]);
        if (error) throw error;
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      await fetchDetails(selectedOrder.id);
      await fetchOrders();
    } catch (error) {
      console.error("Error saving subcontract order detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = async (record: SubcontractOrder) => {
    setEditingOrder(record);
    setSelectedOrder(record);
    setHeaderProductId(record.product_id ?? undefined);
    form.setFieldsValue({
      ...record,
      order_date: record.order_date ? dayjs(record.order_date) : undefined,
      required_date: record.required_date ? dayjs(record.required_date) : undefined,
    });
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = orders.find((row) => row.id === id);
    if (target && !isEditable(target)) {
      message.warning(t("mrp.subcontractOrders.lockedTip"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractOrders.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            "删除委外订单",
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(orderTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
              const { error: detailError } = await supabase
                .from(orderDetailTable)
                .update({ is_deleted: "y" })
                .eq("order_id", id);
              if (detailError) throw detailError;
            },
            { table: orderTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          fetchOrders();
        } catch (error) {
          console.error("Error deleting subcontract order:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = async () => {
    let orderNo: string;
    try {
      orderNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(
        `${t("common.documentNoFailed")}：${(error as Error).message}`,
      );
      return;
    }
    setEditingOrder(null);
    setSelectedOrder(null);
    setDetails([]);
    setHeaderProductId(undefined);
    form.setFieldsValue({
      order_no: orderNo,
      order_date: dayjs(new Date()),
      supplier_id: undefined,
      product_id: undefined,
      quantity: 0,
      unit_price: 0,
      amount: 0,
      currency: currencies.find((c) => c.isBase)?.code,
      exchange_rate: 1,
      warehouse_id: undefined,
      location_id: undefined,
      bom_id: undefined,
      required_date: undefined,
      status: "draft",
      remark: "",
    });
    setIsModalOpen(true);
  };

  // 按 BOM 展开应发料。p_replace=true 时若已发生发料，后端会直接抛错
  // （重建会打断 issued/consumed 跟踪）—— 这里把异常原文透给用户。
  const runBuildMaterials = (replace: boolean) => {
    if (!selectedOrder) {
      message.warning(t("mrp.subcontractOrders.saveHeaderFirst"));
      return;
    }
    if (!isEditable(selectedOrder)) {
      message.warning(t("mrp.subcontractOrders.lockedTip"));
      return;
    }
    Modal.confirm({
      title: replace
        ? t("mrp.subcontractOrders.rebuildAction")
        : t("mrp.subcontractOrders.buildAction"),
      content: replace
        ? t("mrp.subcontractOrders.rebuildConfirm")
        : t("mrp.subcontractOrders.buildConfirm"),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      okButtonProps: replace ? { danger: true } : undefined,
      onOk: async () => {
        setBuilding(true);
        try {
          const { data, error } = await supabase.rpc(BUILD_MATERIALS_RPC, {
            p_order_id: selectedOrder.id,
            p_replace: replace,
          });
          if (error) throw error;
          const result = data as {
            ok?: boolean;
            skipped?: boolean;
            reason?: string;
            line_count?: number;
          };
          if (result?.skipped) {
            message.warning(
              t(`mrp.subcontractOrders.buildSkipped.${result.reason}`, {
                defaultValue: t("mrp.subcontractOrders.buildSkipped.other", {
                  reason: result.reason ?? "-",
                }),
              }),
            );
          } else {
            message.success(
              t("mrp.subcontractOrders.buildSuccess", {
                count: result?.line_count ?? 0,
              }),
            );
          }
          await fetchDetails(selectedOrder.id);
          await fetchOrders();
        } catch (error: any) {
          console.error("Error building subcontract order materials:", error);
          message.error(error?.message || t("mrp.subcontractOrders.buildFailed"));
        } finally {
          setBuilding(false);
        }
      },
    });
  };

  const handleAddDetail = () => {
    if (!selectedOrder) {
      message.warning(t("mrp.subcontractOrders.saveHeaderFirst"));
      return;
    }
    if (!isEditable(selectedOrder)) {
      message.warning(t("mrp.subcontractOrders.lockedTip"));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      material_id: undefined,
      required_quantity: 0,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: SubcontractOrderDetail) => {
    if (selectedOrder && !isEditable(selectedOrder)) {
      message.warning(t("mrp.subcontractOrders.lockedTip"));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue({
      material_id: record.material_id,
      required_quantity: record.required_quantity,
      remark: record.remark,
    });
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedOrder && !isEditable(selectedOrder)) {
      message.warning(t("mrp.subcontractOrders.lockedTip"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractOrders.itemDeleteConfirm"),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(orderDetailTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          if (error) throw error;
          message.success(t("common.deleteSuccess"));
          if (selectedOrder) {
            await fetchDetails(selectedOrder.id);
            await fetchOrders();
          }
        } catch (error) {
          console.error("Error deleting subcontract order detail:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const getProductLabel = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || "-";
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || "-";
  };

  const getBomLabel = (bomId: number | null) => {
    if (!bomId) return "-";
    const bom = boms.find((b) => b.id === bomId);
    return bom ? bom.bom_no : "-";
  };

  const filteredOrders = orders.filter(
    (row) =>
      row.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(row.supplier_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getProductLabel(row.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.subcontractOrders.statusDraft"), color: "default" },
    approved: { text: t("mrp.subcontractOrders.statusApproved"), color: "blue" },
    released: { text: t("mrp.subcontractOrders.statusReleased"), color: "cyan" },
    in_progress: {
      text: t("mrp.subcontractOrders.statusInProgress"),
      color: "processing",
    },
    completed: { text: t("mrp.subcontractOrders.statusCompleted"), color: "green" },
    closed: { text: t("mrp.subcontractOrders.statusClosed"), color: "default" },
    cancelled: { text: t("mrp.subcontractOrders.statusCancelled"), color: "error" },
  };

  const columns = [
    { title: t("mrp.subcontractOrders.orderNo"), dataIndex: "order_no", key: "order_no" },
    {
      title: t("mrp.subcontractOrders.orderDate"),
      dataIndex: "order_date",
      key: "order_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.subcontractOrders.supplier"),
      dataIndex: "supplier_id",
      key: "supplier_id",
      render: (id: number) => getSupplierName(id),
    },
    {
      title: t("mrp.subcontractOrders.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (id: number) => getProductLabel(id),
    },
    {
      title: t("mrp.subcontractOrders.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (id: number) => getWarehouseName(id),
    },
    {
      title: t("mrp.subcontractOrders.bom"),
      dataIndex: "bom_id",
      key: "bom_id",
      render: (id: number) => getBomLabel(id),
    },
    {
      title: t("mrp.subcontractOrders.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractOrders.processingFeeRate"),
      dataIndex: "unit_price",
      key: "unit_price",
      align: "right" as const,
      render: (price: number, record: SubcontractOrder) =>
        formatMoney(price, record.currency),
    },
    {
      title: t("mrp.subcontractOrders.amount"),
      dataIndex: "amount",
      key: "amount",
      align: "right" as const,
      render: (amount: number, record: SubcontractOrder) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractOrders.issuedQuantity"),
      dataIndex: "issued_quantity",
      key: "issued_quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractOrders.receivedQuantity"),
      dataIndex: "received_quantity",
      key: "received_quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
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
      render: (_: any, record: SubcontractOrder) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={!isEditable(record)}
            onClick={() => handleDelete(record.id)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    { title: t("mrp.subcontractOrders.lineNo"), dataIndex: "line_no", key: "line_no", width: 70 },
    {
      title: t("mrp.subcontractOrders.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (id: number) => getProductLabel(id),
    },
    {
      title: t("mrp.subcontractOrders.requiredQuantity"),
      dataIndex: "required_quantity",
      key: "required_quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractOrders.issuedQuantity"),
      dataIndex: "issued_quantity",
      key: "issued_quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractOrders.consumedQuantity"),
      dataIndex: "consumed_quantity",
      key: "consumed_quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractOrders.issuedAmount"),
      dataIndex: "issued_amount",
      key: "issued_amount",
      align: "right" as const,
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("mrp.subcontractOrders.remark"),
      dataIndex: "remark",
      key: "remark",
      ellipsis: true,
      render: (text: string) => text || "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 150,
      render: (_: any, record: SubcontractOrderDetail) => (
        <Space size="small">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
          />
        </Space>
      ),
    },
  ];

  const requiredTotal = details.reduce(
    (sum, d) => sum + Number(d.required_quantity || 0),
    0,
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="subcontract-orders"
        headerTitle={t("mrp.subcontractOrders.title")}
        toolbarActions={["export"]}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.subcontractOrders.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.subcontractOrders.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchOrders}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={
          editingOrder
            ? t("mrp.subcontractOrders.editTitle")
            : t("mrp.subcontractOrders.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
          setSelectedOrder(null);
        }}
        headerPanelTitle={t("mrp.subcontractOrders.headerPanelTitle")}
        detailPanelTitle={t("mrp.subcontractOrders.detailPanelTitle")}
        historyTable={orderTable}
        historyRecordId={editingOrder?.id || selectedOrder?.id}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractOrders.orderNo")}
                  name="order_no"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.orderNoPrompt"),
                    },
                  ]}
                >
                  <Input disabled={!!editingOrder} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.orderDate")}
                  name="order_date"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.orderDatePrompt"),
                    },
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.supplier")}
                  name="supplier_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.supplierPrompt"),
                    },
                  ]}
                >
                  <Select showSearch optionFilterProp="children">
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>
                        {s.code} - {s.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.product")}
                  name="product_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.productPrompt"),
                    },
                  ]}
                >
                  <Select
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number) => {
                      setHeaderProductId(value);
                      // 换了成品，原先选的 BOM 多半已经不对了
                      form.setFieldValue("bom_id", undefined);
                    }}
                  >
                    {products.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.code} - {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.bom")}
                  name="bom_id"
                  extra={t("mrp.subcontractOrders.bomHint")}
                >
                  <Select allowClear showSearch optionFilterProp="children">
                    {boms
                      .filter(
                        (b) =>
                          headerProductId == null || b.product_id === headerProductId,
                      )
                      .map((b) => (
                        <Option key={b.id} value={b.id}>
                          {b.bom_no}（{t("mrp.subcontractOrders.bomVersion")}{" "}
                          {b.version}）
                        </Option>
                      ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractOrders.quantity")}
                  name="quantity"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.quantityPrompt"),
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    step={0.000001}
                    precision={6}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.processingFeeRate")}
                  name="unit_price"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.processingFeeRatePrompt"),
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    step={0.0001}
                    precision={4}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Row gutter={8}>
                  <Col span={14}>
                    <Form.Item
                      label={t("mrp.subcontractOrders.currency")}
                      name="currency"
                    >
                      <Select>
                        {currencies.map((c) => (
                          <Option key={c.code} value={c.code}>
                            {currencyLabel(c.code, c.name)}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={10}>
                    <Form.Item
                      label={t("mrp.subcontractOrders.exchangeRate")}
                      name="exchange_rate"
                    >
                      <InputNumber
                        min={0}
                        step={0.00000001}
                        precision={8}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item
                  label={t("mrp.subcontractOrders.amount")}
                  name="amount"
                  initialValue={0}
                >
                  <InputNumber disabled precision={2} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractOrders.warehouse")}
                  name="warehouse_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractOrders.warehousePrompt"),
                    },
                  ]}
                >
                  <Select showSearch optionFilterProp="children">
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Row gutter={8}>
                  <Col span={12}>
                    <Form.Item
                      label={t("mrp.subcontractOrders.location")}
                      name="location_id"
                    >
                      <Select allowClear showSearch optionFilterProp="children">
                        {bins
                          .filter(
                            (b) =>
                              form.getFieldValue("warehouse_id") == null ||
                              b.warehouse_id === form.getFieldValue("warehouse_id"),
                          )
                          .map((b) => (
                            <Option key={b.id} value={b.id}>
                              {b.code} - {b.name}
                            </Option>
                          ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label={t("mrp.subcontractOrders.requiredDate")}
                      name="required_date"
                    >
                      <DatePicker style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item
                  label={t("common.status")}
                  name="status"
                  initialValue="draft"
                >
                  <Select>
                    <Option value="draft">
                      {t("mrp.subcontractOrders.statusDraft")}
                    </Option>
                    <Option value="approved">
                      {t("mrp.subcontractOrders.statusApproved")}
                    </Option>
                    <Option value="released">
                      {t("mrp.subcontractOrders.statusReleased")}
                    </Option>
                    <Option value="closed">
                      {t("mrp.subcontractOrders.statusClosed")}
                    </Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t("mrp.subcontractOrders.remark")} name="remark">
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        detailExtra={
          <Space size={4}>
            <Tooltip title={t("mrp.subcontractOrders.buildTip")}>
              <Button
                type="link"
                size="small"
                loading={building}
                icon={<BranchesOutlined />}
                disabled={!!selectedOrder && !isEditable(selectedOrder)}
                onClick={() => runBuildMaterials(false)}
              >
                {t("mrp.subcontractOrders.buildAction")}
              </Button>
            </Tooltip>
            <Tooltip title={t("mrp.subcontractOrders.rebuildTip")}>
              <Button
                type="link"
                size="small"
                loading={building}
                icon={<ReloadOutlined />}
                disabled={!!selectedOrder && !isEditable(selectedOrder)}
                onClick={() => runBuildMaterials(true)}
              >
                {t("mrp.subcontractOrders.rebuildAction")}
              </Button>
            </Tooltip>
            <Button
              type="link"
              size="small"
              disabled={!!selectedOrder && !isEditable(selectedOrder)}
              onClick={handleAddDetail}
              icon={<PlusOutlined />}
            >
              {t("mrp.subcontractOrders.addDetail")}
            </Button>
          </Space>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            scroll={{ x: 900 }}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={2} align="right">
                  <strong>{t("mrp.subcontractOrders.totalText")}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">
                  <strong>{formatQuantity(requiredTotal)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} colSpan={5} />
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"82%"}
        height={"84%"}
      />

      <SimpleModal
        title={
          editingDetail
            ? t("mrp.subcontractOrders.editDetailTitle")
            : t("mrp.subcontractOrders.addDetailTitle")
        }
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={640}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit}>
          <Form.Item
            label={t("mrp.subcontractOrders.material")}
            name="material_id"
            rules={[
              { required: true, message: t("mrp.subcontractOrders.materialPrompt") },
            ]}
          >
            <Select showSearch optionFilterProp="children">
              {products.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.code} - {p.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("mrp.subcontractOrders.requiredQuantity")}
            name="required_quantity"
            initialValue={0}
            rules={[
              {
                required: true,
                message: t("mrp.subcontractOrders.requiredQuantityPrompt"),
              },
            ]}
          >
            <InputNumber
              min={0}
              step={0.000001}
              precision={6}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item label={t("mrp.subcontractOrders.remark")} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
