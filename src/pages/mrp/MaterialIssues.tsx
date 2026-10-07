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
import { voucherNotice, type InventoryVoucherResult } from "../../utils/inventoryVoucher";
import { SuperTable } from "../../components/SuperTable";
import { formatMoney } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

type MaterialIssue = Tables["erp_material_issues_s_539dcf81_b"]["Row"];
type MaterialIssueDetail = Tables["erp_material_issue_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const { Option } = Select;
const materialIssueTable = "erp_material_issues_s_539dcf81_b";
const materialIssueDetailTable = "erp_material_issue_details_s_539dcf81_b";

// 与 deploy_56 的 post_production_document / reverse_production_document 对应
const POST_DOCUMENT_RPC = "post_production_document";
const REVERSE_DOCUMENT_RPC = "reverse_production_document";
const DOCUMENT_TYPE = "material_issue";
// RPC 允许过账的来源状态；cancelled 与 posted 不在其中
const POSTABLE_STATUSES = ["draft", "approved", "issued"];
const POSTED_STATUS = "posted";
// 与 deploy_57 对应：把生产订单未领的物料需求带进当前领料单
const PULL_ORDER_LINES_RPC = "pull_order_lines_into_issue";

const isPosted = (record: { status: string | null }) =>
  record.status === POSTED_STATUS;

const formatDateTime = (value: string | null | undefined) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";

export function MaterialIssues() {
  const { t } = useTranslation();
  const [issues, setIssues] = useState<MaterialIssue[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingIssue, setEditingIssue] = useState<MaterialIssue | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<MaterialIssue | null>(null);
  const [details, setDetails] = useState<MaterialIssueDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<MaterialIssueDetail | null>(null);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [pulling, setPulling] = useState(false);
  // 明细的库位下拉要按「本单的领料仓库」过滤，所以把表头仓库提成受控值；
  // 直接读 selectedIssue.warehouse_id 会在「改了仓库还没重载」时拿到旧值。
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();

  useEffect(() => {
    fetchIssues();
    fetchProducts();
    fetchOrders();
    fetchWarehouses();
    fetchBins();
  }, []);

  const fetchIssues = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(materialIssueTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("issue_date", { ascending: false });

      if (error) throw error;
      setIssues(data || []);
    } catch (error) {
      console.error("Error fetching material issues:", error);
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

  const fetchBins = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_bins_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setBins(data || []);
    } catch (error) {
      console.error("Error fetching bins:", error);
    }
  };

  const fetchDetails = async (issueId: number) => {
    try {
      const { data, error } = await supabase
        .from(materialIssueDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("issue_id", issueId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching material issue details:", error);
      message.error(t("mrp.materialIssues.fetchDetailsFailed"));
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingIssue) {
        await logWithTiming("更新生产领料单", "UPDATE", async () => {
          const { error } = await supabase
            .from(materialIssueTable)
            .update(values)
            .eq("id", editingIssue.id);
          if (error) throw error;
        }, { table: materialIssueTable, recordId: editingIssue.id });
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: materialIssueTable,
        };
        const data = await logWithTiming("新增生产领料单", "INSERT", async () => {
          const { data, error } = await supabase
            .from(materialIssueTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedIssue(data);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingIssue(null);
      setHeaderWarehouseId(undefined);
      fetchIssues();
    } catch (error) {
      console.error("Error saving material issue:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedIssue) {
        message.warning(t("mrp.materialIssues.saveHeaderFirst"));
        return;
      }

      values.amount = Number(values.quantity || 0) * Number(values.unit_cost || 0);

      if (editingDetail) {
        await supabase
          .from(materialIssueDetailTable)
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo =
          details.length > 0
            ? Math.max(...details.map((d) => d.line_no || 0))
            : 0;
        values.issue_id = selectedIssue.id;
        values.line_no = maxLineNo + 1;
        values.is_deleted = "n";

        const { error } = await supabase
          .from(materialIssueDetailTable)
          .insert([values]);
        if (error) throw error;
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedIssue.id);
      updateIssueTotal(selectedIssue.id);
    } catch (error) {
      console.error("Error saving material issue detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const updateIssueTotal = async (issueId: number) => {
    try {
      const { data, error } = await supabase
        .from(materialIssueDetailTable)
        .select("amount")
        .eq("is_deleted", "n")
        .eq("issue_id", issueId);
      if (error) throw error;

      const totalAmount =
        data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;

      await supabase
        .from(materialIssueTable)
        .update({ total_amount: totalAmount })
        .eq("id", issueId);

      form.setFieldValue("total_amount", totalAmount);
      fetchIssues();
    } catch (error) {
      console.error("Error updating material issue total:", error);
    }
  };

  const handleEdit = async (record: MaterialIssue) => {
    if (isPosted(record)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    setEditingIssue(record);
    setSelectedIssue(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({
      ...record,
      issue_date: dayjs(record.issue_date),
    });
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = issues.find((issue) => issue.id === id);
    if (target && isPosted(target)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.materialIssues.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming("删除生产领料单", "DELETE", async () => {
            const { error } = await supabase
              .from(materialIssueTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(materialIssueDetailTable)
              .update({ is_deleted: "y" })
              .eq("issue_id", id);
            if (detailError) throw detailError;
          }, { table: materialIssueTable, recordId: id });
          message.success(t("common.deleteSuccess"));
          fetchIssues();
        } catch (error) {
          console.error("Error deleting material issue:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  // 过账 / 反过账走工具栏按钮，作用于当前勾选的领料单（支持多选批量）。
  // 逐单执行而非单事务批处理：一张失败不影响其它张，失败原因逐条汇总。
  const runSequential = async (
    targets: MaterialIssue[],
    action: (record: MaterialIssue) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running material issue batch action:", error);
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
      message.warning(t("mrp.materialIssues.postNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.materialIssues.post"),
      content: t("mrp.materialIssues.postConfirmContentMany", {
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
              // deploy_87：库存过账会顺带生成会计凭证；会计侧问题不阻断过账，但要提示。
              const notice = voucherNotice(data as { voucher?: InventoryVoucherResult } | null, t);
              if (notice) voucherGaps.push(`${record.issue_no}：${notice}`);
            },
            t("mrp.materialIssues.postFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.materialIssues.postSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.materialIssues.postPartialFailed", {
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
      message.warning(t("mrp.materialIssues.reverseNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.materialIssues.reverse"),
      content: t("mrp.materialIssues.reverseConfirmContentMany", {
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
              // deploy_87：反过账会顺带作废对应凭证；作废失败要在界面上看得见。
              const notice = voucherNotice(data as { voucher?: InventoryVoucherResult } | null, t);
              if (notice) voucherGaps.push(`${record.issue_no}：${notice}`);
            },
            t("mrp.materialIssues.reverseFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.materialIssues.reverseSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.materialIssues.reversePartialFailed", {
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
      issueNo = await nextDocumentNo("material_issue");
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditingIssue(null);
    setSelectedIssue(null);
    setDetails([]);
    setHeaderWarehouseId(undefined);
    form.setFieldsValue({
      issue_no: issueNo,
      issue_date: dayjs(new Date()),
      production_order_id: undefined,
      warehouse_id: undefined,
      total_amount: 0,
      remark: "",
      status: "draft",
    });
    setIsModalOpen(true);
  };

  // 把生产订单里还没领的物料需求带进当前领料单。
  // 带出的行写入 order_detail_id，流转台账据此回写订单的已领数量 —— 所以手工
  // 录入的行只要带了来源行，账也是准的。
  const handlePullFromOrder = () => {
    if (!selectedIssue) {
      message.warning(t("mrp.materialIssues.saveHeaderFirst"));
      return;
    }
    if (isPosted(selectedIssue)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    const orderId = form.getFieldValue("production_order_id");
    if (!orderId) {
      message.warning(t("mrp.materialIssues.pullNoOrder"));
      return;
    }
    Modal.confirm({
      title: t("mrp.materialIssues.pullFromOrder"),
      content: t("mrp.materialIssues.pullConfirm"),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setPulling(true);
        try {
          const { data, error } = await supabase.rpc(PULL_ORDER_LINES_RPC, {
            p_issue_id: selectedIssue.id,
            p_order_id: Number(orderId),
          });
          if (error) throw error;
          const result = data as { inserted_lines?: number };
          message.success(
            t("mrp.materialIssues.pullSuccess", {
              count: result?.inserted_lines ?? 0,
            }),
          );
          await fetchDetails(selectedIssue.id);
          await fetchIssues();
          // 主表金额与来源订单由 RPC 落库，回读一次把表单同步过来
          const { data: header } = await supabase
            .from(materialIssueTable)
            .select("*")
            .eq("id", selectedIssue.id)
            .single();
          if (header) {
            setSelectedIssue(header);
            setHeaderWarehouseId(header.warehouse_id ?? undefined);
            form.setFieldsValue({
              production_order_id: header.production_order_id,
              warehouse_id: header.warehouse_id,
              total_amount: header.total_amount,
            });
          }
        } catch (error: any) {
          console.error("Error pulling production order lines:", error);
          message.error(error?.message || t("mrp.materialIssues.pullFailed"));
        } finally {
          setPulling(false);
        }
      },
    });
  };

  const handleAddDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!selectedIssue) {
      message.warning(t("mrp.materialIssues.saveHeaderFirst"));
      return;
    }
    if (isPosted(selectedIssue)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      line_no: details.length + 1,
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

  const handleEditDetail = (record: MaterialIssueDetail) => {
    if (selectedIssue && isPosted(selectedIssue)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedIssue && isPosted(selectedIssue)) {
      message.warning(t("mrp.materialIssues.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.materialIssues.itemDeleteConfirm"),
      onOk: async () => {
        try {
          await supabase
            .from(materialIssueDetailTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success(t("common.deleteSuccess"));
          if (selectedIssue) {
            fetchDetails(selectedIssue.id);
            updateIssueTotal(selectedIssue.id);
          }
        } catch (error) {
          console.error("Error deleting material issue detail:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getOrderLabel = (orderId: number | null) => {
    const order = orders.find((o) => o.id === orderId);
    return order?.order_no || "-";
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

  // 明细的库位下拉只列「本单领料仓库」下的货位。
  // 过账时会用 erp_bins.warehouse_id 校验，这里先过滤掉必然失败的选项。
  const detailBinOptions = bins.filter(
    (b) => headerWarehouseId != null && b.warehouse_id === headerWarehouseId,
  );

  const filteredIssues = issues.filter(
    (i) =>
      i.issue_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderLabel(i.production_order_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  // posted 只由过账动作产生，表单里不提供；approved / issued 保留用于渲染存量数据
  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.materialIssues.statusDraft"), color: "default" },
    approved: { text: t("mrp.materialIssues.statusApproved"), color: "blue" },
    issued: { text: t("mrp.materialIssues.statusIssued"), color: "success" },
    posted: { text: t("mrp.materialIssues.statusPosted"), color: "green" },
    cancelled: { text: t("mrp.materialIssues.statusCancelled"), color: "error" },
  };

  const columns = [
    {
      title: t("mrp.materialIssues.issueNo"),
      dataIndex: "issue_no",
      key: "issue_no",
    },
    {
      title: t("mrp.materialIssues.issueDate"),
      dataIndex: "issue_date",
      key: "issue_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.materialIssues.productionOrder"),
      dataIndex: "production_order_id",
      key: "production_order_id",
      render: (orderId: number) => getOrderLabel(orderId),
    },
    {
      title: t("mrp.materialIssues.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: t("mrp.materialIssues.totalAmount"),
      dataIndex: "total_amount",
      key: "total_amount",
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("common.status"),
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
      title: t("mrp.materialIssues.postedAt"),
      dataIndex: "posted_at",
      key: "posted_at",
      render: (text: string) => formatDateTime(text),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: MaterialIssue) => (
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
    {
      title: t("mrp.materialIssues.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
      width: 80,
    },
    {
      title: t("mrp.materialIssues.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (materialId: number) => getProductName(materialId),
    },
    {
      title: t("mrp.materialIssues.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => Number(qty || 0).toLocaleString(),
    },
    {
      title: t("mrp.materialIssues.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      render: (cost: number) => formatMoney(cost),
    },
    {
      title: t("mrp.materialIssues.amount"),
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("mrp.materialIssues.batchNo"),
      dataIndex: "batch_no",
      key: "batch_no",
      width: 120,
      ellipsis: true,
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.materialIssues.location"),
      dataIndex: "location_id",
      key: "location_id",
      render: (binId: number | null) =>
        binId ? (
          getBinLabel(binId)
        ) : (
          <Tag color="orange">{t("mrp.materialIssues.locationUnset")}</Tag>
        ),
    },
    {
      title: t("mrp.materialIssues.source"),
      dataIndex: "order_detail_id",
      key: "order_detail_id",
      width: 110,
      render: (orderDetailId: number | null) =>
        orderDetailId ? (
          <Tag color="blue">{t("mrp.materialIssues.sourceOrder")}</Tag>
        ) : (
          <Tag>{t("mrp.materialIssues.sourceManual")}</Tag>
        ),
    },
    {
      title: t("mrp.materialIssues.remark"),
      dataIndex: "remark",
      key: "remark",
      width: 100,
      ellipsis: true,
      render: (text: string) => text || "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 160,
      render: (_: any, record: MaterialIssueDetail) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} 
          onClick={() => handleDeleteDetail(record.id)} />
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce(
    (sum, d) => sum + (d.amount || 0),
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
        storageKey="material-issues"
        headerTitle={t("mrp.materialIssues.title")}
        toolbarActions={["delete" , "export"]}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.materialIssues.add")}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t("mrp.materialIssues.post")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t("mrp.materialIssues.reverse")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.materialIssues.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchIssues}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingIssue ? t("mrp.materialIssues.editTitle") : t("mrp.materialIssues.addTitle")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingIssue(null);
          setSelectedIssue(null);
        }}
        headerPanelTitle={t("mrp.materialIssues.headerPanelTitle")}
        detailPanelTitle={t("mrp.materialIssues.detailPanelTitle")}
        historyTable={materialIssueTable}
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
                  label={t("mrp.materialIssues.issueNo")}
                  name="issue_no"
                  rules={[{ required: true, message: t("mrp.materialIssues.issueNoPrompt") }]}
                >
                  <Input placeholder={t("mrp.materialIssues.issueNoPrompt")} disabled={!!editingIssue} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.materialIssues.issueDate")}
                  name="issue_date"
                  rules={[{ required: true, message: t("mrp.materialIssues.issueDatePrompt") }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.materialIssues.productionOrder")}
                  name="production_order_id"
                >
                  <Select
                    placeholder={t("mrp.materialIssues.productionOrderPrompt")}
                    allowClear
                    showSearch
                    optionFilterProp="children"
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
                  label={t("mrp.materialIssues.warehouse")}
                  name="warehouse_id"
                  rules={[{ required: true, message: t("mrp.materialIssues.warehousePrompt") }]}
                >
                  <Select
                    placeholder={t("mrp.materialIssues.warehousePrompt")}
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
                <Form.Item label={t("mrp.materialIssues.totalAmount")} name="total_amount" initialValue={0}>
                  <InputNumber
                    disabled
                    precision={2}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item label={t("common.status")} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t("mrp.materialIssues.statusDraft")}</Option>
                    <Option value="cancelled">{t("mrp.materialIssues.statusCancelled")}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t("mrp.materialIssues.remark")} name="remark">
                  <Input.TextArea rows={3} placeholder={t("mrp.materialIssues.remarkPrompt")} />
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
              {t("mrp.materialIssues.pullFromOrder")}
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!!selectedIssue && isPosted(selectedIssue)}
              onClick={handleAddDetail}
              icon={<PlusOutlined />}
            >
              {t("mrp.materialIssues.addDetail")}
            </Button>
          </Space>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={4} align="right">
                  <strong>{t("mrp.materialIssues.totalText")}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} colSpan={2} align="right">
                  <strong>{formatMoney(detailTotal)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={4} />
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
        title={editingDetail ? t("mrp.materialIssues.editDetailTitle") : t("mrp.materialIssues.addDetailTitle")}
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
          <Form.Item label={t("mrp.materialIssues.lineNo")} name="line_no">
            <InputNumber min={1} style={{ width: "100%" }} disabled />
          </Form.Item>
          <Form.Item
            label={t("mrp.materialIssues.material")}
            name="material_id"
            rules={[{ required: true, message: t("mrp.materialIssues.materialPrompt") }]}
          >
            <Select
              placeholder={t("mrp.materialIssues.materialPrompt")}
              showSearch
              optionFilterProp="children"
            >
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
                label={t("mrp.materialIssues.quantity")}
                name="quantity"
                initialValue={0}
                rules={[{ required: true, message: t("mrp.materialIssues.quantityPrompt") }]}
              >
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.materialIssues.quantityPrompt")}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.materialIssues.unitCost")}
                name="unit_cost"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.materialIssues.unitCostPrompt")}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("mrp.materialIssues.batchNo")} name="batch_no">
            <Input placeholder={t("mrp.materialIssues.batchNoPrompt")} />
          </Form.Item>
          <Form.Item
            label={t("mrp.materialIssues.location")}
            name="location_id"
            extra={
              headerWarehouseId == null
                ? t("mrp.materialIssues.locationNeedWarehouse")
                : t("mrp.materialIssues.locationHint")
            }
          >
            <Select
              allowClear
              placeholder={t("mrp.materialIssues.locationPrompt")}
              disabled={headerWarehouseId == null}
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
          <Form.Item label={t("mrp.materialIssues.remark")} name="remark">
            <Input.TextArea rows={2} placeholder={t("mrp.materialIssues.remarkPrompt")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
