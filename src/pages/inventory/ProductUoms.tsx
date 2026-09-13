import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import SimpleModal from "../../components/SimpleModal";

type Uom = Tables["erp_uoms_s_539dcf81_b"]["Row"];
type UomGroup = Tables["erp_uom_groups_s_539dcf81_b"]["Row"];
type ProductUom = Tables["erp_product_uoms_s_539dcf81_b"]["Row"];

const productUomTable = "erp_product_uoms_s_539dcf81_b";
const USAGE_TYPES = ["purchase", "sales", "inventory", "production", "cost"] as const;

interface ProductUomsProps {
  /** 已保存的产品 id；为空（新增产品未保存）时不可维护单位换算。 */
  productId?: number | null;
  /** 产品的基础单位 id，用于展示换算关系。 */
  baseUomId?: number | null;
  /** 全部计量单位，用于单位下拉与换算系数回填。 */
  uoms: Uom[];
  /** 计量单位分组，用于下拉展示分组名。 */
  groups: UomGroup[];
}

export function ProductUoms({ productId, baseUomId, uoms, groups }: ProductUomsProps) {
  const { t } = useTranslation();
  const [productUoms, setProductUoms] = useState<ProductUom[]>([]);
  const [isUnitModalOpen, setIsUnitModalOpen] = useState(false);
  const [editingProductUom, setEditingProductUom] = useState<ProductUom | null>(null);
  const [unitForm] = Form.useForm();
  const watchedUomId = Form.useWatch("uom_id", unitForm);

  const groupNameMap = new Map<number, string>(groups.map((g) => [g.id, g.name]));
  const uomMap = new Map<number, Uom>(uoms.map((u) => [u.id, u]));

  const uomOptions = uoms.map((u) => ({
    value: u.id,
    label: `${u.name}${u.symbol ? ` (${u.symbol})` : ""} · ${groupNameMap.get(u.group_id) || ""}`,
  }));

  const usageLabel = (u: string) =>
    t(`products.usage${u.charAt(0).toUpperCase() + u.slice(1)}` as "products.usagePurchase");

  const fetchProductUoms = async (id: number) => {
    try {
      const { data, error } = await supabase
        .from(productUomTable)
        .select("*")
        .eq("product_id", id)
        .eq("is_deleted", "n")
        .order("usage_type", { ascending: true });
      if (error) throw error;
      setProductUoms(data || []);
    } catch (error) {
      console.error("Error fetching product uoms:", error);
    }
  };

  useEffect(() => {
    if (productId) {
      fetchProductUoms(productId);
    } else {
      setProductUoms([]);
    }
  }, [productId]);

  const openAddUnit = () => {
    setEditingProductUom(null);
    unitForm.setFieldsValue({ usage_type: "purchase", is_default: false });
    setIsUnitModalOpen(true);
  };

  const openEditUnit = (record: ProductUom) => {
    setEditingProductUom(record);
    unitForm.setFieldsValue({
      usage_type: record.usage_type,
      uom_id: record.uom_id,
      conversion_factor: record.conversion_factor ?? undefined,
      is_default: record.is_default ?? false,
      barcode: record.barcode ?? "",
      remark: record.remark ?? "",
    });
    setIsUnitModalOpen(true);
  };

  const handleSubmitUnit = async (values: any) => {
    if (!productId) {
      message.warning(t("products.unitSaveHint"));
      return;
    }
    try {
      const payload = {
        product_id: productId,
        usage_type: values.usage_type,
        uom_id: values.uom_id,
        conversion_factor:
          values.conversion_factor === undefined || values.conversion_factor === null
            ? null
            : values.conversion_factor,
        is_default: !!values.is_default,
        barcode: values.barcode || null,
        remark: values.remark || null,
      };
      if (editingProductUom) {
        // edit: UPDATE by id
        if (payload.is_default) {
          await supabase
            .from(productUomTable)
            .update({ is_default: false })
            .eq("product_id", productId)
            .eq("usage_type", payload.usage_type)
            .eq("is_deleted", "n")
            .eq("is_default", true)
            .neq("id", editingProductUom.id);
        }
        const { error } = await supabase
          .from(productUomTable)
          .update(payload)
          .eq("id", editingProductUom.id);
        if (error) throw error;
        message.success(t("common.updateSuccess"));
      } else {
        // add: INSERT. The table uses a PARTIAL unique index (WHERE is_deleted='n')
        // for soft-delete safety; PostgreSQL cannot infer it via ON CONFLICT column
        // list, so we insert directly and translate a 23505 duplicate into a friendly msg.
        if (payload.is_default) {
          await supabase
            .from(productUomTable)
            .update({ is_default: false })
            .eq("product_id", productId)
            .eq("usage_type", payload.usage_type)
            .eq("is_deleted", "n")
            .eq("is_default", true);
        }
        const { error } = await supabase.from(productUomTable).insert([payload]);
        if (error) {
          if (error.code === "23505") {
            message.error(t("products.unitDuplicate"));
            return;
          }
          throw error;
        }
        message.success(t("common.createSuccess"));
      }
      setIsUnitModalOpen(false);
      unitForm.resetFields();
      setEditingProductUom(null);
      fetchProductUoms(productId);
    } catch (error: any) {
      console.error("Error saving product uom:", error);
      message.error(error?.message || t("common.saveFailed"));
    }
  };

  const handleDeleteUnit = (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("common.confirmDelete"),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(productUomTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          if (error) throw error;
          message.success(t("common.deleteSuccess"));
          if (productId) fetchProductUoms(productId);
        } catch (error) {
          console.error("Error deleting product uom:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const unitColumns = [
    {
      title: t("products.usageType"),
      dataIndex: "usage_type",
      key: "usage_type",
      width: 130,
      render: (u: string) => <Tag color="blue">{usageLabel(u)}</Tag>,
    },
    {
      title: t("products.unitUom"),
      dataIndex: "uom_id",
      key: "uom_id",
      width: 160,
      render: (id: number) => {
        const u = uomMap.get(id);
        return u ? `${u.name}${u.symbol ? ` (${u.symbol})` : ""}` : "-";
      },
    },
    {
      title: t("products.conversionFactor"),
      key: "conv",
      render: (_: any, pu: ProductUom) => {
        const u = uomMap.get(pu.uom_id);
        const base = baseUomId ? uomMap.get(baseUomId) : undefined;
        const factor = pu.conversion_factor ?? u?.factor ?? 1;
        return (
          <Space size={4}>
            <span>{`1 ${u?.symbol || u?.name || "?"} = ${factor} ${base?.symbol || base?.name || t("products.baseUnit")}`}</span>
            {pu.conversion_factor != null && (
              <Tag color="orange">{t("products.factorOverridden")}</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: t("products.isDefaultUnit"),
      dataIndex: "is_default",
      key: "is_default",
      width: 80,
      render: (d: boolean) => (d ? <Tag color="gold">{t("products.isDefaultUnit")}</Tag> : "-"),
    },
    {
      title: t("products.unitBarcode"),
      dataIndex: "barcode",
      key: "barcode",
      width: 140,
      render: (b: string) => b || "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 120,
      render: (_: any, record: ProductUom) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => openEditUnit(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteUnit(record.id)}>
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("products.unitConvHint")}
        />
        <Space style={{ marginBottom: 12 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!productId}
            onClick={openAddUnit}
          >
            {t("products.addUnit")}
          </Button>
        </Space>
        {!productId ? (
          <div style={{ color: "#999", padding: "12px 0" }}>
            {t("products.unitSaveHint")}
          </div>
        ) : productUoms.length === 0 ? (
          <div style={{ color: "#999", padding: "12px 0" }}>
            {t("products.noUnits")}
          </div>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            columns={unitColumns}
            dataSource={productUoms}
          />
        )}
      </div>

      <SimpleModal
        title={editingProductUom ? t("products.editUnit") : t("products.addUnit")}
        open={isUnitModalOpen}
        onCancel={() => {
          setIsUnitModalOpen(false);
          unitForm.resetFields();
          setEditingProductUom(null);
        }}
        onOk={() => unitForm.submit()}
        width={520}
        destroyOnClose
      >
        <Form form={unitForm} layout="vertical" onFinish={handleSubmitUnit} style={{ marginTop: 12 }}>
          <Form.Item
            label={t("products.usageType")}
            name="usage_type"
            rules={[{ required: true, message: t("products.usageType") }]}
          >
            <Select options={USAGE_TYPES.map((u) => ({ value: u, label: usageLabel(u) }))} />
          </Form.Item>
          <Form.Item
            label={t("products.unitUom")}
            name="uom_id"
            rules={[{ required: true, message: t("products.unitUom") }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={uomOptions}
              onChange={(val: number) => {
                const f = uomMap.get(val)?.factor;
                if (f != null && unitForm.getFieldValue("conversion_factor") == null) {
                  unitForm.setFieldValue("conversion_factor", f);
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label={t("products.conversionFactor")}
            name="conversion_factor"
            tooltip={t("products.conversionFactorTooltip")}
            extra={
              uomMap.get(watchedUomId as number)?.factor != null
                ? `${t("products.factorInherited")}: ${uomMap.get(watchedUomId as number)?.factor}`
                : undefined
            }
          >
            <InputNumber style={{ width: "100%" }} min={0.000000001} step={1} precision={9} placeholder="1" />
          </Form.Item>
          <Form.Item label={t("products.isDefaultUnit")} name="is_default" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label={t("products.unitBarcode")} name="barcode">
            <Input placeholder={t("products.unitBarcode")} />
          </Form.Item>
          <Form.Item label={t("products.unitRemark")} name="remark">
            <Input placeholder={t("products.unitRemark")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </>
  );
}

export default ProductUoms;
