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
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import dayjs from 'dayjs';
import { SupaModal } from "../../components/SupaModal";
import { BizAttachments } from "../../components/BizAttachments";
import { useUoms, buildUomOptions, productUnitText, normalizeUnitText } from "../../hooks/useUoms";
import { BomEditableTreeGraph } from "../../components/BomEditableTreeGraph";
import SimpleModal from "../../components/SimpleModal";

type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type BomDetail = Tables["erp_bom_details_s_539dcf81_b"]["Row"];

const { Option } = Select;
const bomTable = "erp_boms_s_539dcf81_b";
const bomDetailTable = "erp_bom_details_s_539dcf81_b";

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
    try {
      if (editingBom) {
        await logWithTiming(t("mrp.boms.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(bomTable)
            .update(values)
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
            .insert([values])
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
      fetchBoms();
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

      if (editingDetail) {
        await supabase
          .from("erp_bom_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no || 0)) : 0;
        values.bom_id = selectedBom.id;
        values.line_no = maxLineNo + 1;
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
      fetchDetails(selectedBom.id);
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
      effective_date: dayjs(record.effective_date),
      expiry_date: dayjs(record.expiry_date),
      is_default: record.is_default ?? true,
      is_active: record.is_active ?? true,
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
          fetchBoms();
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
      is_active: true,
      effective_date: dayjs(new Date()),
      expiry_date: "",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingDetail(null);
    detailForm.setFieldsValue({
      line_no: details.length + 1,
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
            fetchDetails(selectedBom.id);
          }
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

  const filteredBoms = boms.filter(
    (b) =>
      b.bom_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(b.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

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
            <Input.Search
              allowClear
              placeholder={t("mrp.boms.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchBoms}
              style={{ width: 240 }}
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
                <Form.Item label={t("mrp.boms.effectiveDate")} name="effective_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("mrp.boms.expiryDate")} name="expiry_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("mrp.boms.remark")} name="remark">
                  <Input.TextArea rows={2} placeholder={t("mrp.boms.remarkPrompt")} />
                </Form.Item>
                <Form.Item
                  label={t("common.enabled")}
                  name="is_active"
                  valuePropName="checked"
                  initialValue={true}
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
            icon={<PlusOutlined />}
          >
            {t("mrp.boms.addItem")}
          </Button>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
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
