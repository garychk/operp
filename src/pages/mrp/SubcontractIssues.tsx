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
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ImportOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import {
  voucherNotice,
  type InventoryVoucherResult,
} from "../../utils/inventoryVoucher";
import { SuperTable } from "../../components/SuperTable";
import { useCurrencyRegistry } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

type SubcontractIssue = Tables["erp_subcontract_issues_s_539dcf81_b"]["Row"];
type SubcontractIssueDetail =
  Tables["erp_subcontract_issue_details_s_539dcf81_b"]["Row"];
type SubcontractOrder = Tables["erp_subcontract_orders_s_539dcf81_b"]["Row"];
type SubcontractOrderDetail =
  Tables["erp_subcontract_order_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Supplier = Tables["erp_suppliers_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const { Option } = Select;
const issueTable = "erp_subcontract_issues_s_539dcf81_b";
const issueDetailTable = "erp_subcontract_issue_details_s_539dcf81_b";
const orderTable = "erp_subcontract_orders_s_539dcf81_b";
const orderDetailTable = "erp_subcontract_order_details_s_539dcf81_b";

// deploy_103：委外发料 = 出库（借 委托加工物资1408 / 贷 原材料1403）
const POST_DOCUMENT_RPC = "post_subcontract_document";
const REVERSE_DOCUMENT_RPC = "reverse_subcontract_document";
const DOCUMENT_TYPE = "subcontract_issue";
const POSTABLE_STATUSES = ["draft", "approved"];
const POSTED_STATUS = "posted";

const isPosted = (record: { status: string | null }) =>
  record.status === POSTED_STATUS;

const formatDateTime = (value: string | null | undefined) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";

export function SubcontractIssues() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity } = useCurrencyRegistry();
  const [issues, setIssues] = useState<SubcontractIssue[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<SubcontractOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingIssue, setEditingIssue] = useState<SubcontractIssue | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<SubcontractIssue | null>(null);
  const [details, setDetails] = useState<SubcontractIssueDetail[]>([]);
  const [editingDetail, setEditingDetail] =
    useState<SubcontractIssueDetail | null>(null);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();
  /** 本单带入的行按「订单 id」缓存，明细里选应发料行时用它过滤 */
  const [orderDetailOptions, setOrderDetailOptions] = useState<
    SubcontractOrderDetail[]
  >([]);

  useEffect(() => {
    fetchIssues();
    fetchProducts();
    fetchSuppliers();
    fetchOrders();
    fetchWarehouses();
    fetchBins();
  }, []);

  const fetchIssues = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(issueTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("issue_date", { ascending: false });
      if (error) throw error;
      setIssues(data || []);
    } catch (error) {
      console.error("Error fetching subcontract issues:", error);
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

  const fetchOrders = async () => {
    const { data } = await supabase
      .from(orderTable)
      .select("*")
      .eq("is_deleted", "n");
    setOrders(data || []);
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

  const fetchDetails = async (issueId: number) => {
    try {
      const { data, error } = await supabase
        .from(issueDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("issue_id", issueId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching subcontract issue details:", error);
      message.error(t("mrp.subcontractIssues.fetchDetailsFailed"));
    }
  };

  const fetchOrderDetails = async (orderId: number | null | undefined) => {
    if (!orderId) {
      setOrderDetailOptions([]);
      return;
    }
    const { data } = await supabase
      .from(orderDetailTable)
      .select("*")
      .eq("is_deleted", "n")
      .eq("order_id", orderId)
      .order("line_no");
    setOrderDetailOptions(data || []);
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        issue_date: values.issue_date
          ? dayjs(values.issue_date).format("YYYY-MM-DD")
          : undefined,
        total_cost: Number(selectedIssue?.total_cost || 0),
      };
      if (editingIssue) {
        await logWithTiming(
          t("mrp.subcontractIssues.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(issueTable)
              .update(payload)
              .eq("id", editingIssue.id);
            if (error) throw error;
          },
          { table: issueTable, recordId: editingIssue.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: issueTable,
        };
        const data = await logWithTiming(
          t("mrp.subcontractIssues.logCreate"),
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(issueTable)
              .insert([payload])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedIssue(data as SubcontractIssue);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingIssue(null);
      setHeaderWarehouseId(undefined);
      setOrderDetailOptions([]);
      fetchIssues();
    } catch (error) {
      console.error("Error saving subcontract issue:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const recomputeTotal = async (issueId: number) => {
    const { data } = await supabase
      .from(issueDetailTable)
      .select("total_cost")
      .eq("is_deleted", "n")
      .eq("issue_id", issueId);
    const total = (data || []).reduce(
      (sum, row) => sum + Number(row.total_cost || 0),
      0,
    );
    await supabase
      .from(issueTable)
      .update({ total_cost: total })
      .eq("id", issueId);
    await fetchIssues();
    await fetchDetails(issueId);
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedIssue) {
        message.warning(t("mrp.subcontractIssues.saveHeaderFirst"));
        return;
      }
      const quantity = Number(values.quantity || 0);
      const unitCost = Number(values.unit_cost || 0);
      const payload = {
        material_id: values.material_id,
        order_detail_id: values.order_detail_id ?? null,
        quantity,
        unit_cost: unitCost,
        total_cost: quantity * unitCost,
        batch_no: values.batch_no ?? null,
        location_id: values.location_id ?? null,
        expiry_date: values.expiry_date
          ? dayjs(values.expiry_date).format("YYYY-MM-DD")
          : null,
        remark: values.remark ?? null,
      };
      if (editingDetail) {
        const { error } = await supabase
          .from(issueDetailTable)
          .update(payload)
          .eq("id", editingDetail.id);
        if (error) throw error;
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo =
          details.length > 0 ? Math.max(...details.map((d) => d.line_no || 0)) : 0;
        const { error } = await supabase.from(issueDetailTable).insert([
          { ...payload, issue_id: selectedIssue.id, line_no: maxLineNo + 1 },
        ]);
        if (error) throw error;
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      await recomputeTotal(selectedIssue.id);
    } catch (error) {
      console.error("Error saving subcontract issue detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = async (record: SubcontractIssue) => {
    if (isPosted(record)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    setEditingIssue(record);
    setSelectedIssue(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({
      ...record,
      issue_date: record.issue_date ? dayjs(record.issue_date) : undefined,
    });
    await fetchDetails(record.id);
    await fetchOrderDetails(record.order_id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = issues.find((row) => row.id === id);
    if (target && isPosted(target)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractIssues.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.subcontractIssues.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(issueTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
              const { error: detailError } = await supabase
                .from(issueDetailTable)
                .update({ is_deleted: "y" })
                .eq("issue_id", id);
              if (detailError) throw detailError;
            },
            { table: issueTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          fetchIssues();
        } catch (error) {
          console.error("Error deleting subcontract issue:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const runSequential = async (
    targets: SubcontractIssue[],
    action: (record: SubcontractIssue) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running subcontract issue batch action:", error);
        failures.push(`${record.issue_no}：${error?.message || fallbackMessage}`);
      }
    }
    setSelectedRowKeys([]);
    await fetchIssues();
    return { success, failures };
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = issues.filter(
      (row) =>
        selectedIds.has(row.id) &&
        POSTABLE_STATUSES.includes((row.status || "").toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.subcontractIssues.postNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractIssues.post"),
      content: t("mrp.subcontractIssues.postConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setPosting(true);
        try {
          const voucherGaps: string[] = [];
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(POST_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
              const payload = data as {
                voucher?: InventoryVoucherResult;
                warnings?: Array<{ code: string }>;
              } | null;
              const notice = voucherNotice(payload, t);
              if (notice) voucherGaps.push(`${record.issue_no}：${notice}`);
              // 超发 / 未挂应发料属于业务判断不阻断，但必须让操作人看见
              for (const warning of payload?.warnings || []) {
                voucherGaps.push(
                  `${record.issue_no}：${t(
                    `mrp.subcontractIssues.warn.${warning.code}`,
                    { defaultValue: warning.code },
                  )}`,
                );
              }
            },
            t("mrp.subcontractIssues.postFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.subcontractIssues.postSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.subcontractIssues.postPartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
          if (voucherGaps.length > 0) message.warning(voucherGaps.join("；"), 10);
        } finally {
          setPosting(false);
        }
      },
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = issues.filter(
      (row) => selectedIds.has(row.id) && isPosted(row),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.subcontractIssues.reverseNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractIssues.reverse"),
      content: t("mrp.subcontractIssues.reverseConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setReversing(true);
        try {
          const voucherGaps: string[] = [];
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(REVERSE_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
              const notice = voucherNotice(
                data as { voucher?: InventoryVoucherResult } | null,
                t,
              );
              if (notice) voucherGaps.push(`${record.issue_no}：${notice}`);
            },
            t("mrp.subcontractIssues.reverseFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.subcontractIssues.reverseSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.subcontractIssues.reversePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
          if (voucherGaps.length > 0) message.warning(voucherGaps.join("；"), 10);
        } finally {
          setReversing(false);
        }
      },
    });
  };

  const handleAdd = async () => {
    let issueNo: string;
    try {
      issueNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(
        `${t("common.documentNoFailed")}：${(error as Error).message}`,
      );
      return;
    }
    setEditingIssue(null);
    setSelectedIssue(null);
    setDetails([]);
    setHeaderWarehouseId(undefined);
    setOrderDetailOptions([]);
    form.setFieldsValue({
      issue_no: issueNo,
      issue_date: dayjs(new Date()),
      supplier_id: undefined,
      order_id: undefined,
      warehouse_id: undefined,
      location_id: undefined,
      total_cost: 0,
      status: "draft",
      remark: "",
    });
    setIsModalOpen(true);
  };

  // 把订单里「还没发够」的应发料带进来。带出的行带上 order_detail_id，
  // 过账时会据此回写订单的已发料跟踪 —— 手工加的行不带来源就不计入进度。
  const handlePullFromOrder = () => {
    if (!selectedIssue) {
      message.warning(t("mrp.subcontractIssues.saveHeaderFirst"));
      return;
    }
    if (isPosted(selectedIssue)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    const orderId = form.getFieldValue("order_id") ?? selectedIssue.order_id;
    if (!orderId) {
      message.warning(t("mrp.subcontractIssues.pullNoOrder"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractIssues.pullFromOrder"),
      content: t("mrp.subcontractIssues.pullConfirm"),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setPulling(true);
        try {
          const { data: orderDetails, error } = await supabase
            .from(orderDetailTable)
            .select("*")
            .eq("is_deleted", "n")
            .eq("order_id", Number(orderId))
            .order("line_no");
          if (error) throw error;

          const remaining = (orderDetails || []).filter(
            (row) =>
              Number(row.required_quantity || 0) >
              Number(row.issued_quantity || 0),
          );
          if (remaining.length === 0) {
            message.info(t("mrp.subcontractIssues.pullNothing"));
            return;
          }

          let lineNo =
            details.length > 0 ? Math.max(...details.map((d) => d.line_no || 0)) : 0;
          const payload = remaining.map((row) => {
            lineNo += 1;
            const qty =
              Number(row.required_quantity || 0) - Number(row.issued_quantity || 0);
            const unitCost = Number(row.unit_cost || 0);
            return {
              issue_id: selectedIssue.id,
              line_no: lineNo,
              order_detail_id: row.id,
              material_id: row.material_id,
              quantity: qty,
              unit_cost: unitCost,
              total_cost: qty * unitCost,
            };
          });

          const { error: insertError } = await supabase
            .from(issueDetailTable)
            .insert(payload);
          if (insertError) throw insertError;

          message.success(
            t("mrp.subcontractIssues.pullSuccess", { count: payload.length }),
          );
          await recomputeTotal(selectedIssue.id);
          await fetchOrderDetails(Number(orderId));
        } catch (error: any) {
          console.error("Error pulling subcontract order lines:", error);
          message.error(error?.message || t("mrp.subcontractIssues.pullFailed"));
        } finally {
          setPulling(false);
        }
      },
    });
  };

  const handleAddDetail = () => {
    if (!selectedIssue) {
      message.warning(t("mrp.subcontractIssues.saveHeaderFirst"));
      return;
    }
    if (isPosted(selectedIssue)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      order_detail_id: undefined,
      material_id: undefined,
      quantity: 0,
      unit_cost: 0,
      batch_no: "",
      location_id: undefined,
      expiry_date: undefined,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: SubcontractIssueDetail) => {
    if (selectedIssue && isPosted(selectedIssue)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue({
      ...record,
      expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined,
    });
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedIssue && isPosted(selectedIssue)) {
      message.warning(t("mrp.subcontractIssues.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractIssues.itemDeleteConfirm"),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(issueDetailTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          if (error) throw error;
          message.success(t("common.deleteSuccess"));
          if (selectedIssue) await recomputeTotal(selectedIssue.id);
        } catch (error) {
          console.error("Error deleting subcontract issue detail:", error);
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

  const getOrderNo = (orderId: number | null) => {
    if (!orderId) return "-";
    return orders.find((o) => o.id === orderId)?.order_no || "-";
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || "-";
  };

  const getBinLabel = (binId: number | null) => {
    if (!binId) return "-";
    const bin = bins.find((b) => b.id === binId);
    return bin ? `${bin.code} - ${bin.name}` : "-";
  };

  const detailBinOptions = bins.filter(
    (b) => headerWarehouseId != null && b.warehouse_id === headerWarehouseId,
  );

  const filteredIssues = issues.filter(
    (row) =>
      row.issue_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(row.order_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(row.supplier_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.subcontractIssues.statusDraft"), color: "default" },
    approved: { text: t("mrp.subcontractIssues.statusApproved"), color: "blue" },
    posted: { text: t("mrp.subcontractIssues.statusPosted"), color: "green" },
    cancelled: { text: t("mrp.subcontractIssues.statusCancelled"), color: "error" },
  };

  const columns = [
    { title: t("mrp.subcontractIssues.issueNo"), dataIndex: "issue_no", key: "issue_no" },
    {
      title: t("mrp.subcontractIssues.issueDate"),
      dataIndex: "issue_date",
      key: "issue_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.subcontractIssues.supplier"),
      dataIndex: "supplier_id",
      key: "supplier_id",
      render: (id: number) => getSupplierName(id),
    },
    {
      title: t("mrp.subcontractIssues.order"),
      dataIndex: "order_id",
      key: "order_id",
      render: (id: number) => getOrderNo(id),
    },
    {
      title: t("mrp.subcontractIssues.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (id: number) => getWarehouseName(id),
    },
    {
      title: t("mrp.subcontractIssues.totalCost"),
      dataIndex: "total_cost",
      key: "total_cost",
      align: "right" as const,
      render: (amount: number) => formatMoney(amount),
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
      title: t("mrp.subcontractIssues.postedAt"),
      dataIndex: "posted_at",
      key: "posted_at",
      render: (text: string) => formatDateTime(text),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: SubcontractIssue) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            disabled={isPosted(record)}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={isPosted(record)}
            onClick={() => handleDelete(record.id)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    { title: t("mrp.subcontractIssues.lineNo"), dataIndex: "line_no", key: "line_no", width: 70 },
    {
      title: t("mrp.subcontractIssues.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (id: number) => getProductLabel(id),
    },
    {
      title: t("mrp.subcontractIssues.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractIssues.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      align: "right" as const,
      render: (cost: number) => formatMoney(cost),
    },
    {
      title: t("mrp.subcontractIssues.totalCost"),
      dataIndex: "total_cost",
      key: "total_cost",
      align: "right" as const,
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("mrp.subcontractIssues.batchNo"),
      dataIndex: "batch_no",
      key: "batch_no",
      width: 120,
      ellipsis: true,
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.subcontractIssues.location"),
      dataIndex: "location_id",
      key: "location_id",
      render: (binId: number | null) =>
        binId ? (
          getBinLabel(binId)
        ) : (
          <Tag color="orange">{t("mrp.subcontractIssues.locationUnset")}</Tag>
        ),
    },
    {
      title: t("mrp.subcontractIssues.source"),
      dataIndex: "order_detail_id",
      key: "order_detail_id",
      width: 110,
      render: (orderDetailId: number | null) =>
        orderDetailId ? (
          <Tag color="blue">{t("mrp.subcontractIssues.sourceOrder")}</Tag>
        ) : (
          <Tag>{t("mrp.subcontractIssues.sourceManual")}</Tag>
        ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 150,
      render: (_: any, record: SubcontractIssueDetail) => (
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

  const detailTotal = details.reduce(
    (sum, d) => sum + Number(d.total_cost || 0),
    0,
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredIssues}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="subcontract-issues"
        headerTitle={t("mrp.subcontractIssues.title")}
        toolbarActions={["export"]}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.subcontractIssues.add")}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t("mrp.subcontractIssues.post")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t("mrp.subcontractIssues.reverse")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.subcontractIssues.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchIssues}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={
          editingIssue
            ? t("mrp.subcontractIssues.editTitle")
            : t("mrp.subcontractIssues.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingIssue(null);
          setSelectedIssue(null);
        }}
        headerPanelTitle={t("mrp.subcontractIssues.headerPanelTitle")}
        detailPanelTitle={t("mrp.subcontractIssues.detailPanelTitle")}
        historyTable={issueTable}
        historyRecordId={editingIssue?.id || selectedIssue?.id}
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
                  label={t("mrp.subcontractIssues.issueNo")}
                  name="issue_no"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractIssues.issueNoPrompt"),
                    },
                  ]}
                >
                  <Input disabled={!!editingIssue} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractIssues.issueDate")}
                  name="issue_date"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractIssues.issueDatePrompt"),
                    },
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractIssues.supplier")}
                  name="supplier_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractIssues.supplierPrompt"),
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
                <Form.Item label={t("mrp.subcontractIssues.order")} name="order_id">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number | undefined) =>
                      fetchOrderDetails(value)
                    }
                  >
                    {orders.map((o) => (
                      <Option key={o.id} value={o.id}>
                        {o.order_no}（{getProductLabel(o.product_id)}）
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractIssues.warehouse")}
                  name="warehouse_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractIssues.warehousePrompt"),
                    },
                  ]}
                >
                  <Select
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number) => setHeaderWarehouseId(value)}
                  >
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractIssues.location")}
                  name="location_id"
                  extra={t("mrp.subcontractIssues.locationHint")}
                >
                  <Select allowClear showSearch optionFilterProp="children">
                    {bins
                      .filter(
                        (b) =>
                          headerWarehouseId == null ||
                          b.warehouse_id === headerWarehouseId,
                      )
                      .map((b) => (
                        <Option key={b.id} value={b.id}>
                          {b.code} - {b.name}
                        </Option>
                      ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractIssues.totalCost")}
                  name="total_cost"
                  initialValue={0}
                >
                  <InputNumber disabled precision={2} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("common.status")}
                  name="status"
                  initialValue="draft"
                >
                  <Select>
                    <Option value="draft">
                      {t("mrp.subcontractIssues.statusDraft")}
                    </Option>
                    <Option value="approved">
                      {t("mrp.subcontractIssues.statusApproved")}
                    </Option>
                    <Option value="cancelled">
                      {t("mrp.subcontractIssues.statusCancelled")}
                    </Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t("mrp.subcontractIssues.remark")} name="remark">
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        detailExtra={
          <Space size={4}>
            <Button
              type="link"
              size="small"
              loading={pulling}
              disabled={!!selectedIssue && isPosted(selectedIssue)}
              onClick={handlePullFromOrder}
              icon={<ImportOutlined />}
            >
              {t("mrp.subcontractIssues.pullFromOrder")}
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!!selectedIssue && isPosted(selectedIssue)}
              onClick={handleAddDetail}
              icon={<PlusOutlined />}
            >
              {t("mrp.subcontractIssues.addDetail")}
            </Button>
          </Space>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            scroll={{ x: 1000 }}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={4} align="right">
                  <strong>{t("mrp.subcontractIssues.totalText")}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} colSpan={5} align="right">
                  <strong>{formatMoney(detailTotal)}</strong>
                </Table.Summary.Cell>
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
            ? t("mrp.subcontractIssues.editDetailTitle")
            : t("mrp.subcontractIssues.addDetailTitle")
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
        width={680}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit}>
          <Form.Item
            label={t("mrp.subcontractIssues.orderDetail")}
            name="order_detail_id"
            extra={
              orderDetailOptions.length === 0
                ? t("mrp.subcontractIssues.orderDetailNoOptions")
                : t("mrp.subcontractIssues.orderDetailHint")
            }
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="children"
              disabled={orderDetailOptions.length === 0}
              onChange={(value: number | undefined) => {
                const picked = orderDetailOptions.find((row) => row.id === value);
                if (!picked) return;
                const remain = Math.max(
                  Number(picked.required_quantity || 0) -
                    Number(picked.issued_quantity || 0),
                  0,
                );
                detailForm.setFieldsValue({
                  material_id: picked.material_id,
                  quantity: remain,
                  unit_cost: picked.unit_cost,
                });
              }}
            >
              {orderDetailOptions.map((row) => (
                <Option key={row.id} value={row.id}>
                  #{row.line_no} {getProductLabel(row.material_id)} ·{" "}
                  {t("mrp.subcontractIssues.remaining", {
                    qty:
                      Number(row.required_quantity || 0) -
                      Number(row.issued_quantity || 0),
                  })}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("mrp.subcontractIssues.material")}
            name="material_id"
            rules={[
              { required: true, message: t("mrp.subcontractIssues.materialPrompt") },
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
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.subcontractIssues.quantity")}
                name="quantity"
                initialValue={0}
                rules={[
                  {
                    required: true,
                    message: t("mrp.subcontractIssues.quantityPrompt"),
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
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.subcontractIssues.unitCost")}
                name="unit_cost"
                initialValue={0}
                extra={t("mrp.subcontractIssues.unitCostHint")}
              >
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t("mrp.subcontractIssues.batchNo")} name="batch_no">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.subcontractIssues.expiryDate")}
                name="expiry_date"
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label={t("mrp.subcontractIssues.location")}
            name="location_id"
            extra={
              headerWarehouseId == null
                ? t("mrp.subcontractIssues.locationNeedWarehouse")
                : t("mrp.subcontractIssues.locationHint")
            }
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="children"
              disabled={headerWarehouseId == null}
            >
              {detailBinOptions.map((b) => (
                <Option key={b.id} value={b.id}>
                  {b.code} - {b.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label={t("mrp.subcontractIssues.remark")} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
