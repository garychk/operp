import { useEffect, useMemo, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Table,
  Tag,
  Modal,
  Drawer,
  Form,
  Select,
  Space,
  message,
  InputNumber,
  Checkbox,
  Row,
  Col,
  DatePicker,
  Alert,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import dayjs from 'dayjs';
import { SupaModal, buildModalNav } from "../../components/SupaModal";
import { BizAttachments } from "../../components/BizAttachments";
import { useUoms, buildUomOptions, productUnitText, normalizeUnitText } from "../../hooks/useUoms";
import { BomEditableTreeGraph } from "../../components/BomEditableTreeGraph";
import SimpleModal from "../../components/SimpleModal";

// is_phantom 已在线上表中（mrpEngine/mrpService 也在消费），但生成的
// src/types/database.ts 里没同步这一列，先用交叉类型补上，避免改动生成文件。
type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"] & {
  is_phantom?: boolean | null;
};
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type BomDetail = Tables["erp_bom_details_s_539dcf81_b"]["Row"];

/** 有效期判定结果，用于列表标记与筛选。 */
type Validity = "valid" | "expired" | "pending" | "none";
/** 明细完整性筛选。 */
type DetailFilter = "all" | "empty" | "has";

const { Option } = Select;
const bomTable = "erp_boms_s_539dcf81_b";
const bomDetailTable = "erp_bom_details_s_539dcf81_b";

/** 按「日」比较两个日期（忽略时分秒）；任一为空返回 null。 */
const cmpDay = (a: any, b: any): number | null => {
  if (!a || !b) return null;
  const da = dayjs(a);
  const db = dayjs(b);
  if (!da.isValid() || !db.isValid()) return null;
  return da.startOf("day").diff(db.startOf("day"));
};

export function Boms() {
  const { t } = useTranslation();
  const [boms, setBoms] = useState<Bom[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingBom, setEditingBom] = useState<Bom | null>(null);
  const [selectedBom, setSelectedBom] = useState<Bom | null>(null);
  const [details, setDetails] = useState<BomDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<BomDetail | null>(null);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [treeMaterialCode, setTreeMaterialCode] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();

  // 列表筛选条件（原页面只有一个前端模糊搜索，缺状态/有效期/虚拟件/明细完整性维度）
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [validityFilter, setValidityFilter] = useState<"all" | Validity>("all");
  const [phantomFilter, setPhantomFilter] = useState<"all" | "phantom" | "physical">("all");
  const [detailFilter, setDetailFilter] = useState<DetailFilter>("all");
  // bom_id -> 有效子项行数：「明细行数」列 + 空 BOM 启用拦截都依赖它
  const [detailCountMap, setDetailCountMap] = useState<Record<number, number>>({});

  // 单位下拉的数据源 = 单位主数据表（erp_uoms），与物料管理页完全一致。
  // 历史问题：这里曾用 <DictSelect dictType="uom" />，而 sys_dict_items 里
  // 根本没有 `uom` 字典 → 下拉恒为空，只能靠手填，于是出现 "PCS" 这类
  // 与 erp_products.unit（"pcs"）对不上的值。
  const { uoms, uomMap, groupNameMap } = useUoms();
  const uomOptions = useMemo(
    () => buildUomOptions(uoms, groupNameMap, "symbol"),
    [uoms, groupNameMap],
  );

  useEffect(() => {
    fetchBoms();
    fetchProducts();
    fetchAllProducts();
    fetchOperations();
    fetchDetailCounts();
  }, []);

  const fetchBoms = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(bomTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setBoms(data || []);
    } catch (error) {
      console.error("Error fetching boms:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  /** 统计每条 BOM 的有效子项行数（一次全量拉 bom_id 后在前端汇总，避免 N 次 count）。 */
  const fetchDetailCounts = async () => {
    try {
      const { data, error } = await supabase
        .from(bomDetailTable)
        .select("bom_id")
        .eq("is_deleted", "n");
      if (error) throw error;
      const map: Record<number, number> = {};
      (data || []).forEach((row: { bom_id: number | null }) => {
        if (row.bom_id != null) map[row.bom_id] = (map[row.bom_id] || 0) + 1;
      });
      setDetailCountMap(map);
    } catch (error) {
      console.error("Error fetching bom detail counts:", error);
    }
  };

  const refreshAll = async () => {
    await Promise.all([fetchBoms(), fetchDetailCounts()]);
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

  const fetchAllProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setAllProducts(data || []);
    } catch (error) {
      console.error("Error fetching all products:", error);
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

  const fetchDetails = async (bomId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_bom_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("bom_id", bomId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error(t("mrp.fetchDetailsFailed"));
    }
  };

  const handleSubmit = async (values: any) => {
    // 保存前校验（问题 2「空 BOM 可启用」+ 问题 4「有效期无校验」）
    // ① 失效日期不得早于生效日期
    const spanDiff = cmpDay(values.expiry_date, values.effective_date);
    if (spanDiff != null && spanDiff < 0) {
      message.error(t("mrp.boms.expiryBeforeEffective"));
      return;
    }
    if (values.is_active) {
      // ② 空 BOM 不允许启用
      const cnt = activeDetailCount(editingBom?.id ?? null);
      if (cnt === 0) {
        message.error(t("mrp.boms.emptyCannotEnable"));
        return;
      }
      // ③ 已过期（失效日期早于今天）的 BOM 不允许启用
      const expiredDiff = cmpDay(values.expiry_date, dayjs());
      if (expiredDiff != null && expiredDiff < 0) {
        message.error(t("mrp.boms.expiredCannotEnable"));
        return;
      }
    }

    try {
      // 日期必须以 "YYYY-MM-DD" 字符串入库：直接把 dayjs 对象交给 supabase 会
      // 序列化成 UTC 时间戳（本地零点 → 前一天 16:00Z），PostgreSQL 按 UTC 取
      // date 部分，结果每保存一次日期就提前一天（UTC+8 环境实测踩坑）。
      const payload = { ...values };
      if (payload.effective_date) {
        payload.effective_date = dayjs(payload.effective_date).format("YYYY-MM-DD");
      }
      if (payload.expiry_date) {
        payload.expiry_date = dayjs(payload.expiry_date).format("YYYY-MM-DD");
      }

      if (editingBom) {
        await logWithTiming(t("mrp.boms.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(bomTable)
            .update(payload)
            .eq("id", editingBom.id);
          if (error) throw error;
        }, { table: bomTable, recordId: editingBom.id });
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: bomTable,
        };
        const data = await logWithTiming(t("mrp.boms.logCreate"), "INSERT", async () => {
          const { data, error } = await supabase
            .from(bomTable)
            .insert([payload])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedBom(data);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingBom(null);
      void refreshAll();
    } catch (error) {
      console.error("Error saving bom:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedBom) {
        message.error(t("mrp.boms.selectBomFirst"));
        return;
      }

      // 验证物料不能与 BOM 主档相同
      if (values.material_id === selectedBom.product_id) {
        message.error(t('mrp.boms.materialSameAsHeader'));
        return;
      }

      // 同一个 BOM 内行号必须唯一（问题 1）。编辑时要排除自己这一行。
      const lineNo = Number(values.line_no);
      const duplicated = details.some(
        (d) => Number(d.line_no) === lineNo && d.id !== editingDetail?.id,
      );
      if (duplicated) {
        message.error(t("mrp.boms.lineNoDuplicate"));
        return;
      }

      if (editingDetail) {
        await supabase
          .from("erp_bom_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t("common.updateSuccess"));
      } else {
        values.bom_id = selectedBom.id;
        // 行号以表单值为准（上面已校验唯一），不再用本地 state 的 max+1 —— 那个
        // 算法在「中间行被删掉」时会把新行号顶到最大号之后，且完全不知道库里
        // 是否已经有别处写入的同号行。
        values.line_no = lineNo;
        values.is_deleted = "n";

        const { error } = await supabase
          .from("erp_bom_details_s_539dcf81_b")
          .insert([values]);
        if (error) throw error;
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      await fetchDetails(selectedBom.id);
      void fetchDetailCounts();
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = async (record: Bom) => {
    setEditingBom(record);
    setSelectedBom(record);
    form.setFieldsValue({
      ...record,
      // 单位口径归一：历史脏值（如 "PCS"）→ 单位主数据的规范写法；
      // 完全没有单位时按母件的基本单位补默认值
      unit: normalizeUnitText(record.unit, uomMap) || getProductUnit(record.product_id),
      // 空值不能直接喂给 dayjs/DatePicker（dayjs(null) 是 Invalid Date，会渲染成报错）
      effective_date: record.effective_date ? dayjs(record.effective_date) : null,
      expiry_date: record.expiry_date ? dayjs(record.expiry_date) : null,
      is_default: record.is_default ?? true,
      is_active: record.is_active ?? true,
      is_phantom: record.is_phantom ?? false,
    });
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleViewTree = (record: Bom) => {
    const product = products.find((p) => p.id === record.product_id);
    if (!product?.code) {
      message.warning(t('mrp.boms.noMaterialCode'));
      return;
    }

    setTreeMaterialCode(product.code);
    setTreeDrawerOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.boms.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(t("mrp.boms.logDelete"), "DELETE", async () => {
            const { error } = await supabase
              .from(bomTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(bomDetailTable)
              .update({ is_deleted: "y" })
              .eq("bom_id", id);
            if (detailError) throw detailError;
          }, { table: bomTable, recordId: id });
          message.success(t("common.deleteSuccess"));
          void refreshAll();
        } catch (error) {
          console.error("Error deleting bom:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingBom(null);
    setSelectedBom(null);
    setDetails([]);
    form.setFieldsValue({
      bom_no: "",
      product_id: undefined,
      version: "1.0",
      quantity: 1,
      unit: "",
      is_default: true,
      // 新建 BOM 默认「停用」= 草稿态：空 BOM 不允许启用（handleSubmit 会拦截），
      // 先建主档 → 加子项 → 再回来勾「启用」，这是 BOM 的标准发布流程。
      is_active: false,
      is_phantom: false,
      effective_date: dayjs(new Date()),
      expiry_date: null,
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingDetail(null);
    detailForm.setFieldsValue({
      // 取「当前最小的未占用行号」，而不是 length+1：删掉中间行后 length+1 不会复用空号
      line_no: nextLineNo(),
      material_id: undefined,
      quantity: 0,
      unit: "",
      loss_rate: 0,
      operation_id: undefined,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleMaterialChange = (materialId: number) => {
    const unit = getMaterialUnit(materialId);
    detailForm.setFieldValue('unit', unit);

    // 验证物料不能与 BOM 主档相同
    if (selectedBom && materialId === selectedBom.product_id) {
      message.error(t('mrp.boms.materialSameAsHeader'));
      detailForm.setFieldValue('material_id', undefined);
      detailForm.setFieldValue('unit', '');
    }
  };

  const handleEditDetail = (record: BomDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue({
      ...record,
      // 历史脏值（如 "PCS"）归一到单位主数据的规范写法
      unit: normalizeUnitText(record.unit, uomMap),
    });
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.boms.itemDeleteConfirm"),
      onOk: async () => {
        try {
          await supabase
            .from("erp_bom_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success(t("common.deleteSuccess"));
          if (selectedBom) {
            await fetchDetails(selectedBom.id);
          }
          void fetchDetailCounts();
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getMaterialName = (materialId: number | null) => {
    const product = allProducts.find((p) => p.id === materialId);
    return product?.name || "-";
  };

  const getMaterialUnit = (materialId: number | null) => {
    const product = allProducts.find((p) => p.id === materialId);
    return productUnitText(product, uomMap);
  };

  const getProductUnit = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return productUnitText(product, uomMap);
  };

  const getOperationName = (operationId: number | null) => {
    const operation = operations.find((o) => o.id === operationId);
    return operation?.name || "-";
  };

  /** 当前 BOM 内最小的未占用行号（行号在同一 BOM 内必须唯一）。 */
  const nextLineNo = () => {
    const used = new Set(
      details.map((d) => Number(d.line_no)).filter((n) => Number.isFinite(n)),
    );
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  };

  /** 某条 BOM 的有效子项行数：正在编辑/选中的那条以已加载的 details 为准。 */
  const activeDetailCount = (bomId: number | null | undefined): number => {
    if (bomId == null) return 0;
    if (selectedBom?.id === bomId || editingBom?.id === bomId) return details.length;
    return detailCountMap[bomId] ?? 0;
  };

  /** 列表用：一律取全量汇总，避免受弹窗内临时状态影响。 */
  const listDetailCount = (bomId: number): number => detailCountMap[bomId] ?? 0;

  /** 按生效/失效日期判定有效期状态（expired = 失效日早于今天）。 */
  const validityOf = (record: Bom): Validity => {
    const today = dayjs().startOf("day");
    const eff = record.effective_date ? dayjs(record.effective_date).startOf("day") : null;
    const exp = record.expiry_date ? dayjs(record.expiry_date).startOf("day") : null;
    if (!eff && !exp) return "none";
    if (eff && eff.isAfter(today)) return "pending";
    if (exp && exp.isBefore(today)) return "expired";
    return "valid";
  };

  const validityMeta: Record<Validity, { text: string; color: string }> = {
    valid: { text: t("mrp.boms.validityValid"), color: "success" },
    expired: { text: t("mrp.boms.validityExpired"), color: "error" },
    pending: { text: t("mrp.boms.validityPending"), color: "warning" },
    none: { text: t("mrp.boms.validityNone"), color: "default" },
  };

  const filteredBoms = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    return boms.filter((b) => {
      if (kw) {
        const p = products.find((x) => x.id === b.product_id);
        const hay = `${b.bom_no ?? ""} ${p?.code ?? ""} ${p?.name ?? ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      if (statusFilter === "active" && !b.is_active) return false;
      if (statusFilter === "inactive" && b.is_active) return false;
      if (phantomFilter === "phantom" && !b.is_phantom) return false;
      if (phantomFilter === "physical" && b.is_phantom) return false;
      if (validityFilter !== "all" && validityOf(b) !== validityFilter) return false;
      const cnt = detailCountMap[b.id] ?? 0;
      if (detailFilter === "empty" && cnt > 0) return false;
      if (detailFilter === "has" && cnt === 0) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boms, searchTerm, products, statusFilter, phantomFilter, validityFilter, detailFilter, detailCountMap]);

  const columns = [
    {
      title: t("mrp.boms.bomNo"),
      dataIndex: "bom_no",
      key: "bom_no",
    },
    {
      title: t("mrp.boms.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t("mrp.boms.version"),
      dataIndex: "version",
      key: "version",
    },
    {
      title: t("mrp.boms.quantity"),
      dataIndex: "quantity",
      key: "quantity",
    },
    {
      title: t("mrp.boms.unit"),
      dataIndex: "unit",
      key: "unit",
      render: (unit: string) => normalizeUnitText(unit, uomMap) || "-",
    },
    {
      title: t("mrp.boms.defaultLabel"),
      dataIndex: "is_default",
      key: "is_default",
      render: (isDefault: boolean) => (isDefault ? t("common.yes") : t("common.no")),
    },
    {
      title: t("common.status"),
      dataIndex: "is_active",
      key: "is_active",
      render: (isActive: boolean) => (
        <Tag color={isActive ? "success" : "default"}>
          {isActive ? t("common.enabled") : t("mrp.inactive")}
        </Tag>
      ),
    },
    {
      title: t("mrp.boms.detailCount"),
      key: "detail_count",
      width: 110,
      sorter: (a: Bom, b: Bom) => listDetailCount(a.id) - listDetailCount(b.id),
      render: (_: any, record: Bom) => {
        const cnt = listDetailCount(record.id);
        return cnt > 0 ? (
          <span>{cnt}</span>
        ) : (
          <Tag color="red">{t("mrp.boms.emptyTag")}</Tag>
        );
      },
    },
    {
      title: t("mrp.boms.type"),
      key: "is_phantom",
      width: 100,
      render: (_: any, record: Bom) =>
        record.is_phantom ? (
          <Tooltip title={t("mrp.boms.phantomHint")}>
            <Tag color="purple">{t("mrp.boms.phantomItem")}</Tag>
          </Tooltip>
        ) : (
          <Tag>{t("mrp.boms.physicalItem")}</Tag>
        ),
    },
    {
      title: t("mrp.boms.validity"),
      key: "validity",
      width: 230,
      render: (_: any, record: Bom) => {
        const meta = validityMeta[validityOf(record)];
        const range = [record.effective_date, record.expiry_date]
          .filter(Boolean)
          .join(" ~ ");
        return (
          <Space size={6}>
            <Tag color={meta.color}>{meta.text}</Tag>
            <span style={{ color: "#999", fontSize: 12 }}>{range || "-"}</span>
          </Space>
        );
      },
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: Bom) => (
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
            onClick={() => handleViewTree(record)}
          >
            {t("mrp.boms.viewStructure")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
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
      title: t("mrp.boms.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
    },
    {
      title: t("mrp.boms.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (materialId: number) => getMaterialName(materialId),
    },
    {
      title: t("mrp.boms.quantity"),
      dataIndex: "quantity",
      key: "quantity",
    },
    {
      title: t("mrp.boms.unit"),
      dataIndex: "unit",
      key: "unit",
      render: (unit: string) => normalizeUnitText(unit, uomMap) || "-",
    },
    {
      title: t("mrp.boms.lossRate"),
      dataIndex: "loss_rate",
      key: "loss_rate",
      render: (rate: number) => (rate ? (rate * 100).toFixed(2) + "%" : "0%"),
    },
    {
      title: t("mrp.boms.operation"),
      dataIndex: "operation_id",
      key: "operation_id",
      render: (operationId: number) => getOperationName(operationId),
    },
    {
      title: t("mrp.boms.remark"),
      dataIndex: "remark",
      key: "remark",
      render: (text: string) => text || "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: BomDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
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
        dataSource={filteredBoms}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="boms"
        headerTitle={t("mrp.boms.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.boms.add")}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshAll()}>
              {t("common.refresh")}
            </Button>
            <Select
              value={statusFilter}
              style={{ width: 130 }}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: t("mrp.boms.filterAllStatus") },
                { value: "active", label: t("common.enabled") },
                { value: "inactive", label: t("mrp.inactive") },
              ]}
            />
            <Select
              value={validityFilter}
              style={{ width: 150 }}
              onChange={setValidityFilter}
              options={[
                { value: "all", label: t("mrp.boms.filterAllValidity") },
                { value: "valid", label: t("mrp.boms.validityValid") },
                { value: "expired", label: t("mrp.boms.validityExpired") },
                { value: "pending", label: t("mrp.boms.validityPending") },
                { value: "none", label: t("mrp.boms.validityNone") },
              ]}
            />
            <Select
              value={phantomFilter}
              style={{ width: 130 }}
              onChange={setPhantomFilter}
              options={[
                { value: "all", label: t("mrp.boms.filterAllType") },
                { value: "phantom", label: t("mrp.boms.phantomItem") },
                { value: "physical", label: t("mrp.boms.physicalItem") },
              ]}
            />
            <Select
              value={detailFilter}
              style={{ width: 150 }}
              onChange={setDetailFilter}
              options={[
                { value: "all", label: t("mrp.boms.filterAllDetail") },
                { value: "empty", label: t("mrp.boms.filterEmptyDetail") },
                { value: "has", label: t("mrp.boms.filterHasDetail") },
              ]}
            />
            <Input.Search
              allowClear
              placeholder={t("mrp.boms.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: 180 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingBom ? t("mrp.boms.edit") : t("mrp.boms.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingBom(null);
          setSelectedBom(null);
        }}
        headerPanelTitle={t("mrp.boms.headerPanelTitle")}
        detailPanelTitle={t("mrp.boms.detailPanelTitle")}
        historyTable={bomTable}
        historyRecordId={editingBom?.id || selectedBom?.id}
        navigation={buildModalNav(filteredBoms, editingBom?.id || selectedBom?.id, handleEdit)}
        detailItems={[
          {
            key: "attachments",
            label: t("attachments.title"),
            disabled: !(editingBom?.id || selectedBom?.id),
            children: (
              <BizAttachments
                bizType="bom"
                bizId={editingBom?.id || selectedBom?.id}
              />
            ),
          },
        ]}
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
                  label={t("mrp.boms.bomNo")}
                  name="bom_no"
                  rules={[{ required: true, message: t("mrp.boms.bomNoPrompt") }]}
                >
                  <Input placeholder={t("mrp.boms.bomNoPrompt")} disabled={!!editingBom} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.boms.product")}
                  name="product_id"
                  rules={[{ required: true, message: t("mrp.boms.productPrompt") }]}
                >
                  <Select
                    placeholder={t("mrp.boms.productPrompt")}
                    disabled={!!editingBom}
                    onChange={(value) => {
                      const product = products.find((p) => p.id === value);
                      if (product) {
                        form.setFieldValue(
                          "bom_no",
                          product.code || `BOM-${value}`,
                        );
                        // 主档单位 = 母件的基本单位，跟随物料带出（与明细同一口径）
                        form.setFieldValue("unit", productUnitText(product, uomMap));
                      }
                    }}
                  >
                    {products.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t("mrp.boms.version")} name="version" initialValue="1.0">
                  <Input placeholder={t("mrp.boms.versionPrompt")} />
                </Form.Item>
                <Form.Item label={t("mrp.boms.quantity")} name="quantity" initialValue={1}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("mrp.boms.quantityPrompt")}
                  />
                </Form.Item>
                <Form.Item label={t("mrp.boms.unit")} name="unit">
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={uomOptions}
                    placeholder={t("mrp.boms.unitEnterPrompt")}
                    allowClear
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.boms.effectiveDate")}
                  name="effective_date"
                  rules={[
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        const exp = getFieldValue("expiry_date");
                        if (
                          value &&
                          exp &&
                          dayjs(exp).startOf("day").isBefore(dayjs(value).startOf("day"))
                        ) {
                          return Promise.reject(
                            new Error(t("mrp.boms.expiryBeforeEffective")),
                          );
                        }
                        return Promise.resolve();
                      },
                    }),
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.boms.expiryDate")}
                  name="expiry_date"
                  dependencies={["effective_date"]}
                  rules={[
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        const eff = getFieldValue("effective_date");
                        if (
                          value &&
                          eff &&
                          dayjs(value).startOf("day").isBefore(dayjs(eff).startOf("day"))
                        ) {
                          return Promise.reject(
                            new Error(t("mrp.boms.expiryBeforeEffective")),
                          );
                        }
                        return Promise.resolve();
                      },
                    }),
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("mrp.boms.remark")} name="remark">
                  <Input.TextArea rows={2} placeholder={t("mrp.boms.remarkPrompt")} />
                </Form.Item>
                <Form.Item
                  label={t("common.enabled")}
                  name="is_active"
                  valuePropName="checked"
                  initialValue={false}
                  tooltip={t("mrp.boms.draftHint")}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item
                  label={t("mrp.boms.phantom")}
                  name="is_phantom"
                  valuePropName="checked"
                  initialValue={false}
                  tooltip={t("mrp.boms.phantomHint")}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item
                  label={t("mrp.boms.setDefault")}
                  name="is_default"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        detailExtra={
          <Button
            type="link"
            size="small"
            onClick={handleAddDetail}
            disabled={!editingBom && !selectedBom}
            icon={<PlusOutlined />}
          >
            {t("mrp.boms.addItem")}
          </Button>
        }
        tableEle={
          <>
            {!editingBom && !selectedBom ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                message={t("mrp.boms.saveHeaderFirst")}
              />
            ) : details.length === 0 ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={t("mrp.boms.emptyDetailAlert")}
              />
            ) : null}
            <Table
              columns={detailColumns}
              dataSource={details}
              rowKey="id"
              pagination={false}
            />
          </>
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"60%"}
        height={'80%'}
      />

      <SimpleModal
        title={editingDetail ? t("mrp.boms.editItemDetail") : t("mrp.boms.addItemDetail")}
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
        width={800}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.boms.lineNo")}
                name="line_no"
                rules={[{ required: true, message: t("mrp.boms.lineNoPrompt") }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.boms.lineNoPrompt")}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.boms.material")}
                name="material_id"
                rules={[{ required: true, message: t("mrp.boms.materialPrompt") }]}
              >
                <Select
                  placeholder={t("mrp.boms.materialPrompt")}
                  onChange={handleMaterialChange}
                >
                  {allProducts.map((p) => (
                    <Option
                      key={p.id}
                      value={p.id}
                      disabled={selectedBom && p.id === selectedBom.product_id}
                    >
                      {p.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t("mrp.boms.quantity")} name="quantity" initialValue={0}>
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.boms.quantityPrompt")}
                />
              </Form.Item>
              <Form.Item label={t("mrp.boms.unit")} name="unit">
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={uomOptions}
                  placeholder={t("mrp.boms.unitSelectPrompt")}
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t("mrp.boms.lossRate")} name="loss_rate" initialValue={0}>
                <InputNumber
                  min={0}
                  max={1}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.boms.lossRatePrompt")}
                />
              </Form.Item>
              <Form.Item label={t("mrp.boms.operation")} name="operation_id">
                <Select placeholder={t("mrp.boms.operationPrompt")} allowClear>
                  {operations.map((o) => (
                    <Option key={o.id} value={o.id}>
                      {o.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t("mrp.boms.remark")} name="remark">
                <Input.TextArea rows={3} placeholder={t("mrp.boms.remarkPrompt")} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>

      <Drawer
        title={t("mrp.boms.structureTitle")}
        open={treeDrawerOpen}
        onClose={() => {
          setTreeDrawerOpen(false);
          setTreeMaterialCode(null);
        }}
        size="95%"
        destroyOnHidden
      >
        <BomEditableTreeGraph materialCode={treeMaterialCode} />
      </Drawer>
    </div>
  );
}
