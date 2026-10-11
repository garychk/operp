import { useEffect, useMemo, useState } from "react";
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
  Alert,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { voucherNotice, type InventoryVoucherResult } from "../../utils/inventoryVoucher";
import { SuperTable } from "../../components/SuperTable";
import { formatMoney } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import { BizAttachments } from "../../components/BizAttachments";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

/**
 * 生产退料单（P1-3）。
 *
 * 过账走 post_production_document（deploy_93），'material_return' 分支，方向 **in**：
 *   · 物料按**原领料成本**回库（同料号 + 原批号 + 原库位），冲减当期生产成本
 * 明细的 unit_cost 若为空，RPC 会去 erp_inventory_transactions 找原领料成本；
 * 来源行用 issue_detail_id 抵扣领料数量，账面「已退」由流转台账回写。
 */
type MaterialReturn = Tables["erp_material_returns_s_539dcf81_b"]["Row"];
type MaterialReturnDetail = Tables["erp_material_return_details_s_539dcf81_b"]["Row"];
type MaterialIssue = Tables["erp_material_issues_s_539dcf81_b"]["Row"];
type MaterialIssueDetail = Tables["erp_material_issue_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const { Option } = Select;

const returnTable = "erp_material_returns_s_539dcf81_b";
const returnDetailTable = "erp_material_return_details_s_539dcf81_b";
const issueTable = "erp_material_issues_s_539dcf81_b";
const issueDetailTable = "erp_material_issue_details_s_539dcf81_b";

// 与 deploy_93 的 post_production_document / reverse_production_document 对应
const POST_DOCUMENT_RPC = "post_production_document";
const REVERSE_DOCUMENT_RPC = "reverse_production_document";
const DOCUMENT_TYPE = "material_return";
const POSTABLE_STATUSES = ["draft", "approved"];
const POSTED_STATUS = "posted";

const isPosted = (record: { status: string }) => record.status === POSTED_STATUS;

export function MaterialReturns() {
  const { t } = useTranslation();
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [issues, setIssues] = useState<MaterialIssue[]>([]);
  const [issueDetails, setIssueDetails] = useState<MaterialIssueDetail[]>([]);

  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingReturn, setEditingReturn] = useState<MaterialReturn | null>(null);
  const [selectedReturn, setSelectedReturn] = useState<MaterialReturn | null>(null);
  const [details, setDetails] = useState<MaterialReturnDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<MaterialReturnDetail | null>(null);
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();

  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const watchedIssueId = Form.useWatch("issue_id", form);

  useEffect(() => {
    fetchReturns();
    fetchProducts();
    fetchOrders();
    fetchWarehouses();
    fetchBins();
    fetchIssues();
  }, []);

  const fetchReturns = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(returnTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("return_date", { ascending: false });
      if (error) throw error;
      setReturns(data || []);
    } catch (error) {
      console.error("Error fetching material returns:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase.from("erp_products_s_539dcf81_b").select("*").eq("is_deleted", "n");
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchOrders = async () => {
    try {
      const { data, error } = await supabase.from("erp_production_orders_s_539dcf81_b").select("*").eq("is_deleted", "n");
      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching production orders:", error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase.from("erp_warehouses_s_539dcf81_b").select("*").eq("is_deleted", "n");
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error("Error fetching warehouses:", error);
    }
  };

  const fetchBins = async () => {
    try {
      const { data, error } = await supabase.from("erp_bins_s_539dcf81_b").select("*").eq("is_deleted", "n");
      if (error) throw error;
      setBins(data || []);
    } catch (error) {
      console.error("Error fetching bins:", error);
    }
  };

  const fetchIssues = async () => {
    try {
      const { data, error } = await supabase.from(issueTable).select("*").eq("is_deleted", "n");
      if (error) throw error;
      setIssues(data || []);
    } catch (error) {
      console.error("Error fetching material issues:", error);
    }
  };

  const fetchIssueDetails = async (issueId: number): Promise<MaterialIssueDetail[]> => {
    try {
      const { data, error } = await supabase
        .from(issueDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("issue_id", issueId)
        .order("line_no");
      if (error) throw error;
      setIssueDetails(data || []);
      return data || [];
    } catch (error) {
      console.error("Error fetching material issue details:", error);
      return [];
    }
  };

  const fetchDetails = async (returnId: number) => {
    try {
      const { data, error } = await supabase
        .from(returnDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("return_id", returnId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching material return details:", error);
      message.error(t("mrp.materialReturns.fetchDetailsFailed"));
    }
  };

  const sumAmount = (rows: { amount: number | null }[]) => rows.reduce((sum, d) => sum + (d.amount || 0), 0);

  const updateReturnTotal = async (returnId: number) => {
    try {
      const { data, error } = await supabase
        .from(returnDetailTable)
        .select("amount")
        .eq("is_deleted", "n")
        .eq("return_id", returnId);
      if (error) throw error;
      const total = sumAmount(data || []);
      await supabase.from(returnTable).update({ total_amount: total }).eq("id", returnId);
      form.setFieldValue("total_amount", total);
      fetchReturns();
    } catch (error) {
      console.error("Error updating material return total:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = { ...values, total_amount: sumAmount(details) };
      if (editingReturn) {
        await logWithTiming(t("mrp.materialReturns.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase.from(returnTable).update(payload).eq("id", editingReturn.id);
          if (error) throw error;
        }, { table: returnTable, recordId: editingReturn.id });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("mrp.materialReturns.logCreate"), "INSERT", async () => {
          const { error } = await supabase.from(returnTable).insert([payload]);
          if (error) throw error;
        }, { table: returnTable });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReturn(null);
      setHeaderWarehouseId(undefined);
      fetchReturns();
    } catch (error) {
      console.error("Error saving material return:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedReturn) {
        message.warning(t("mrp.materialReturns.saveHeaderFirst"));
        return;
      }
      values.amount = Number(values.quantity || 0) * Number(values.unit_cost || 0);

      if (editingDetail) {
        await supabase.from(returnDetailTable).update(values).eq("id", editingDetail.id);
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map((d) => d.line_no || 0)) : 0;
        values.return_id = selectedReturn.id;
        values.line_no = maxLineNo + 1;
        values.is_deleted = "n";
        const { error } = await supabase.from(returnDetailTable).insert([values]);
        if (error) throw error;
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedReturn.id);
      updateReturnTotal(selectedReturn.id);
    } catch (error) {
      console.error("Error saving material return detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = async (record: MaterialReturn) => {
    if (isPosted(record)) {
      message.warning(t("mrp.materialReturns.postedLocked"));
      return;
    }
    setEditingReturn(record);
    setSelectedReturn(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({ ...record, return_date: dayjs(record.return_date) });
    await fetchDetails(record.id);
    if (record.issue_id) await fetchIssueDetails(record.issue_id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = returns.find((r) => r.id === id);
    if (target && isPosted(target)) {
      message.warning(t("mrp.materialReturns.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.materialReturns.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(t("mrp.materialReturns.logDelete"), "DELETE", async () => {
            const { error } = await supabase.from(returnTable).update({ is_deleted: "y" }).eq("id", id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(returnDetailTable)
              .update({ is_deleted: "y" })
              .eq("return_id", id);
            if (detailError) throw detailError;
          }, { table: returnTable, recordId: id });
          message.success(t("common.deleteSuccess"));
          fetchReturns();
        } catch (error) {
          console.error("Error deleting material return:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = async () => {
    let returnNo: string;
    try {
      returnNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditingReturn(null);
    setSelectedReturn(null);
    setDetails([]);
    setIssueDetails([]);
    setHeaderWarehouseId(undefined);
    form.setFieldsValue({
      return_no: returnNo,
      return_date: dayjs(new Date()),
      production_order_id: undefined,
      issue_id: undefined,
      warehouse_id: undefined,
      location_id: undefined,
      total_amount: 0,
      reason: "",
      remark: "",
      status: "draft",
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = () => {
    if (!selectedReturn) {
      message.warning(t("mrp.materialReturns.saveHeaderFirst"));
      return;
    }
    if (isPosted(selectedReturn)) {
      message.warning(t("mrp.materialReturns.postedLocked"));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      issue_detail_id: undefined,
      material_id: undefined,
      quantity: 0,
      unit_cost: 0,
      amount: 0,
      batch_no: "",
      location_id: undefined,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: MaterialReturnDetail) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t("mrp.materialReturns.postedLocked"));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t("mrp.materialReturns.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.materialReturns.itemDeleteConfirm"),
      onOk: async () => {
        try {
          await supabase.from(returnDetailTable).update({ is_deleted: "y" }).eq("id", id);
          message.success(t("common.deleteSuccess"));
          if (selectedReturn) {
            fetchDetails(selectedReturn.id);
            updateReturnTotal(selectedReturn.id);
          }
        } catch (error) {
          console.error("Error deleting material return detail:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  // 选来源领料单：把生产订单 / 仓库带过来。退料必须退回**原领料仓库**，
  // 所以这里默认填领料单的表头仓库；库位取领料明细里第一个有值的库位
  // （erp_material_issues 表头本身没有 location_id，库位只存在于明细上）。
  const handleIssueChange = async (value: number | null) => {
    if (!value) {
      setIssueDetails([]);
      return;
    }
    const issue = issues.find((i) => i.id === value);
    if (issue) {
      form.setFieldsValue({
        production_order_id: issue.production_order_id,
        warehouse_id: issue.warehouse_id,
      });
      setHeaderWarehouseId(issue.warehouse_id ?? undefined);
    }
    const lines = await fetchIssueDetails(value);
    const firstBin = lines?.find((d) => d.location_id != null)?.location_id ?? undefined;
    form.setFieldsValue({ location_id: firstBin });
  };

  const getIssueDetailInfo = (issueDetailId: number | null) => {
    const detail = issueDetails.find((d) => d.id === issueDetailId);
    if (!detail) return null;
    const product = products.find((p) => p.id === detail.material_id);
    return {
      materialId: detail.material_id,
      maxQty: detail.quantity || 0,
      unitCost: detail.unit_cost || 0,
      batchNo: detail.batch_no || "",
      locationId: detail.location_id ?? null,
      label: product ? `${product.code} - ${product.name}` : "-",
    };
  };

  const handleIssueDetailChange = (value: number | null) => {
    const info = getIssueDetailInfo(value);
    if (info) {
      detailForm.setFieldsValue({
        material_id: info.materialId,
        quantity: info.maxQty,
        unit_cost: info.unitCost,
        amount: info.maxQty * info.unitCost,
        batch_no: info.batchNo,
        location_id: info.locationId ?? undefined,
      });
    }
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };
  const getOrderLabel = (orderId: number | null) => orders.find((o) => o.id === orderId)?.order_no || "-";
  const getWarehouseName = (warehouseId: number | null) => warehouses.find((w) => w.id === warehouseId)?.name || "-";
  const getIssueNo = (issueId: number | null) => issues.find((i) => i.id === issueId)?.issue_no || "-";
  const getBinLabel = (binId: number | null) => {
    if (!binId) return "-";
    const bin = bins.find((b) => b.id === binId);
    return bin ? `${bin.code} - ${bin.name}` : "-";
  };

  const returnableIssues = useMemo(
    () => issues.filter((i) => i.status === "posted" || i.id === editingReturn?.issue_id),
    [issues, editingReturn],
  );

  const currentWarehouseId = headerWarehouseId ?? selectedReturn?.warehouse_id ?? null;
  const detailBinOptions = bins.filter((b) => currentWarehouseId != null && b.warehouse_id === currentWarehouseId);

  const runSequential = async (
    targets: MaterialReturn[],
    action: (record: MaterialReturn) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running material return batch action:", error);
        failures.push(`${record.return_no}：${error?.message || fallbackMessage}`);
      }
    }
    setSelectedRowKeys([]);
    await fetchReturns();
    return { success, failures };
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((k) => Number(k)));
    const targets = returns.filter(
      (row) => selectedIds.has(row.id) && POSTABLE_STATUSES.includes((row.status || "").toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.materialReturns.postNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.materialReturns.post"),
      content: t("mrp.materialReturns.postConfirmContentMany", { count: targets.length }),
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
              // deploy_87：库存过账会顺带生成会计凭证；会计侧问题不阻断过账，但要提示。
              const notice = voucherNotice(data as { voucher?: InventoryVoucherResult } | null, t);
              if (notice) voucherGaps.push(`${record.return_no}：${notice}`);
            },
            t("mrp.materialReturns.postFailed"),
          );
          if (failures.length === 0) {
            message.success(t("mrp.materialReturns.postSuccessMany", { count: success }));
          } else {
            message.error(t("mrp.materialReturns.postPartialFailed", { success, failed: failures.length, detail: failures.join("；") }));
          }
          if (voucherGaps.length > 0) message.warning(voucherGaps.join("；"), 10);
        } finally {
          setPosting(false);
        }
      },
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((k) => Number(k)));
    const targets = returns.filter((row) => selectedIds.has(row.id) && isPosted(row));
    if (targets.length === 0) {
      message.warning(t("mrp.materialReturns.reverseNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.materialReturns.reverse"),
      content: t("mrp.materialReturns.reverseConfirmContentMany", { count: targets.length }),
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
              const notice = voucherNotice(data as { voucher?: InventoryVoucherResult } | null, t);
              if (notice) voucherGaps.push(`${record.return_no}：${notice}`);
            },
            t("mrp.materialReturns.reverseFailed"),
          );
          if (failures.length === 0) {
            message.success(t("mrp.materialReturns.reverseSuccessMany", { count: success }));
          } else {
            message.error(t("mrp.materialReturns.reversePartialFailed", { success, failed: failures.length, detail: failures.join("；") }));
          }
          if (voucherGaps.length > 0) message.warning(voucherGaps.join("；"), 10);
        } finally {
          setReversing(false);
        }
      },
    });
  };

  const filteredReturns = returns.filter(
    (r) =>
      r.return_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderLabel(r.production_order_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getIssueNo(r.issue_id).toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.materialReturns.statusDraft"), color: "default" },
    pending: { text: t("mrp.materialReturns.statusPending"), color: "warning" },
    approved: { text: t("mrp.materialReturns.statusApproved"), color: "blue" },
    posted: { text: t("mrp.materialReturns.statusPosted"), color: "green" },
    cancelled: { text: t("mrp.materialReturns.statusCancelled"), color: "error" },
  };

  const columns = [
    { title: t("mrp.materialReturns.returnNo"), dataIndex: "return_no", key: "return_no" },
    { title: t("mrp.materialReturns.returnDate"), dataIndex: "return_date", key: "return_date" },
    {
      title: t("mrp.materialReturns.productionOrder"),
      dataIndex: "production_order_id",
      key: "production_order_id",
      render: (id: number | null) => getOrderLabel(id),
    },
    {
      title: t("mrp.materialReturns.sourceIssue"),
      dataIndex: "issue_id",
      key: "issue_id",
      render: (id: number | null) => getIssueNo(id),
    },
    {
      title: t("mrp.materialReturns.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (id: number | null) => getWarehouseName(id),
    },
    {
      title: t("mrp.materialReturns.totalAmount"),
      dataIndex: "total_amount",
      key: "total_amount",
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
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: MaterialReturn) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} disabled={isPosted(record)} onClick={() => handleEdit(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} disabled={isPosted(record)} onClick={() => handleDelete(record.id)}>
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    { title: t("mrp.materialReturns.lineNo"), dataIndex: "line_no", key: "line_no", width: 80 },
    {
      title: t("mrp.materialReturns.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (materialId: number) => getProductName(materialId),
    },
    {
      title: t("mrp.materialReturns.source"),
      dataIndex: "issue_detail_id",
      key: "issue_detail_id",
      width: 110,
      render: (id: number | null) =>
        id ? <Tag color="blue">{t("mrp.materialReturns.sourceIssueLine")}</Tag> : <Tag>{t("mrp.materialReturns.sourceManual")}</Tag>,
    },
    {
      title: t("mrp.materialReturns.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => Number(qty || 0).toLocaleString(),
    },
    {
      title: t("mrp.materialReturns.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      render: (cost: number) => formatMoney(cost),
    },
    {
      title: t("mrp.materialReturns.amount"),
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("mrp.materialReturns.batchNo"),
      dataIndex: "batch_no",
      key: "batch_no",
      width: 120,
      ellipsis: true,
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.materialReturns.location"),
      dataIndex: "location_id",
      key: "location_id",
      render: (binId: number | null) => (binId ? getBinLabel(binId) : <Tag color="orange">{t("mrp.materialReturns.locationUnset")}</Tag>),
    },
    { title: t("mrp.materialReturns.remark"), dataIndex: "remark", key: "remark", width: 100, ellipsis: true, render: (text: string) => text || "-" },
    {
      title: t("common.actions"),
      key: "action",
      width: 140,
      render: (_: any, record: MaterialReturnDetail) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)} />
        </Space>
      ),
    },
  ];

  const detailTotal = sumAmount(details);

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredReturns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="material-returns"
        tableName={returnTable}
        headerTitle={t("mrp.materialReturns.title")}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.materialReturns.add")}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t("mrp.materialReturns.post")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t("mrp.materialReturns.reverse")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.materialReturns.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReturns}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingReturn ? t("mrp.materialReturns.editTitle") : t("mrp.materialReturns.addTitle")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReturn(null);
          setSelectedReturn(null);
          setHeaderWarehouseId(undefined);
        }}
        headerPanelTitle={t("mrp.materialReturns.headerPanelTitle")}
        detailPanelTitle={t("mrp.materialReturns.detailPanelTitle")}
        historyTable={returnTable}
        historyRecordId={editingReturn?.id || selectedReturn?.id}
        detailItems={[
          {
            key: "attachments",
            label: t("attachments.title"),
            disabled: !(editingReturn?.id || selectedReturn?.id),
            children: <BizAttachments bizType="material_return" bizId={editingReturn?.id || selectedReturn?.id} />,
          },
        ]}
        workflowDocumentType={DOCUMENT_TYPE}
        onDataChanged={fetchReturns}
        form={form}
        detailData={details}
        detailExtra={
          <Button
            type="link"
            size="small"
            disabled={!!selectedReturn && isPosted(selectedReturn)}
            onClick={handleAddDetail}
            icon={<PlusOutlined />}
          >
            {t("mrp.materialReturns.addDetail")}
          </Button>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.materialReturns.returnNo")}
                  name="return_no"
                  rules={[{ required: true, message: t("mrp.materialReturns.returnNoPrompt") }]}
                >
                  <Input placeholder={t("mrp.materialReturns.returnNoPrompt")} disabled={!!editingReturn} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.materialReturns.returnDate")}
                  name="return_date"
                  rules={[{ required: true, message: t("mrp.materialReturns.returnDatePrompt") }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("mrp.materialReturns.sourceIssue")} name="issue_id">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    placeholder={t("mrp.materialReturns.issuePlaceholder")}
                    onChange={handleIssueChange}
                  >
                    {returnableIssues.map((i) => (
                      <Option key={i.id} value={i.id}>
                        {i.issue_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.materialReturns.productionOrder")}
                  name="production_order_id"
                >
                  <Select placeholder={t("mrp.materialReturns.productionOrderPrompt")} allowClear showSearch optionFilterProp="children">
                    {orders.map((o) => (
                      <Option key={o.id} value={o.id}>
                        {o.order_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.materialReturns.warehouse")}
                  name="warehouse_id"
                  rules={[{ required: true, message: t("mrp.materialReturns.warehousePrompt") }]}
                >
                  <Select
                    placeholder={t("mrp.materialReturns.warehousePrompt")}
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number) => {
                      setHeaderWarehouseId(value);
                      form.setFieldsValue({ location_id: undefined });
                    }}
                  >
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t("mrp.materialReturns.totalAmount")} name="total_amount" initialValue={0}>
                  <InputNumber disabled precision={2} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("common.status")} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t("mrp.materialReturns.statusDraft")}</Option>
                    <Option value="cancelled">{t("mrp.materialReturns.statusCancelled")}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label={t("mrp.materialReturns.reason")} name="reason">
              <Input.TextArea rows={2} placeholder={t("mrp.materialReturns.reasonPrompt")} />
            </Form.Item>
            <Form.Item label={t("mrp.materialReturns.remark")} name="remark">
              <Input.TextArea rows={2} placeholder={t("mrp.materialReturns.remarkPrompt")} />
            </Form.Item>
          </Form>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={5} align="right">
                  <strong>{t("mrp.materialReturns.totalText")}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} colSpan={2} align="right">
                  <strong>{formatMoney(detailTotal)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={3} />
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"80%"}
        height={"80%"}
      />

      <SimpleModal
        title={editingDetail ? t("mrp.materialReturns.editDetailTitle") : t("mrp.materialReturns.addDetailTitle")}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={680}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit}>
          {!watchedIssueId && (
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t("mrp.materialReturns.noSourceHint")} />
          )}
          <Form.Item label={t("mrp.materialReturns.source")} name="issue_detail_id">
            <Select
              allowClear
              disabled={!watchedIssueId}
              placeholder={t("mrp.materialReturns.sourcePlaceholder")}
              onChange={handleIssueDetailChange}
            >
              {issueDetails.map((d) => {
                const info = getIssueDetailInfo(d.id);
                return (
                  <Option key={d.id} value={d.id}>
                    {info?.label} {t("mrp.materialReturns.issueQty", { qty: d.quantity || 0 })}
                  </Option>
                );
              })}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("mrp.materialReturns.material")}
            name="material_id"
            rules={[{ required: true, message: t("mrp.materialReturns.materialPrompt") }]}
          >
            <Select placeholder={t("mrp.materialReturns.materialPrompt")} showSearch optionFilterProp="children">
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
                label={t("mrp.materialReturns.quantity")}
                name="quantity"
                initialValue={0}
                rules={[{ required: true, message: t("mrp.materialReturns.quantityPrompt") }]}
              >
                <InputNumber min={0} step={0.000001} precision={6} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t("mrp.materialReturns.unitCost")} name="unit_cost" initialValue={0}>
                <InputNumber min={0} step={0.0001} precision={4} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("mrp.materialReturns.batchNo")} name="batch_no">
            <Input placeholder={t("mrp.materialReturns.batchNoPrompt")} />
          </Form.Item>
          <Form.Item
            label={t("mrp.materialReturns.location")}
            name="location_id"
            extra={
              currentWarehouseId == null
                ? t("mrp.materialReturns.locationNeedWarehouse")
                : t("mrp.materialReturns.locationHint")
            }
          >
            <Select
              allowClear
              placeholder={t("mrp.materialReturns.locationPrompt")}
              disabled={currentWarehouseId == null}
              showSearch
              optionFilterProp="children"
            >
              {detailBinOptions.map((b) => (
                <Option key={b.id} value={b.id}>
                  {b.code} - {b.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label={t("mrp.materialReturns.remark")} name="remark">
            <Input.TextArea rows={2} placeholder={t("mrp.materialReturns.remarkPrompt")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

export default MaterialReturns;
