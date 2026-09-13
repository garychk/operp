import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  AppstoreOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";
import { SuperTable } from "../../components/SuperTable";

const { Option } = Select;
const docType = "uom";

type UomGroup = Tables["erp_uom_groups_s_539dcf81_b"]["Row"];
type Uom = Tables["erp_uoms_s_539dcf81_b"]["Row"];

interface UomFormValues {
  group_id: number;
  code: string;
  name: string;
  symbol?: string | null;
  factor: number;
  rounding: number;
  is_base: boolean;
  is_active: boolean;
}

interface UomGroupFormValues {
  code: string;
  name: string;
  sort_order?: number;
  status?: string;
}

export function Uoms() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<UomGroup[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupFilter, setGroupFilter] = useState<number | undefined>(undefined);
  const [keyword, setKeyword] = useState("");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUom, setEditingUom] = useState<Uom | null>(null);
  const [form] = Form.useForm();

  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [isGroupFormModalOpen, setIsGroupFormModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UomGroup | null>(null);
  const [groupForm] = Form.useForm();
  const [isBaseChecked, setIsBaseChecked] = useState(false);

  const fetchGroups = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("erp_uom_groups_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("sort_order");
      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error("Error fetching uom groups:", error);
      message.error(t("uom.groups.fetchFailed"));
    }
  }, [t]);

  const fetchUoms = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_uoms_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("group_id")
        .order("factor");
      if (error) throw error;
      setUoms(data || []);
    } catch (error) {
      console.error("Error fetching uoms:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchGroups();
    void fetchUoms();
  }, [fetchGroups, fetchUoms]);

  const groupMap = useMemo(() => {
    const map = new Map<number, UomGroup>();
    groups.forEach((g) => map.set(g.id, g));
    return map;
  }, [groups]);

  const baseUnitMap = useMemo(() => {
    const map = new Map<number, Uom>();
    uoms.forEach((u) => {
      if (u.is_base) map.set(u.group_id, u);
    });
    groups.forEach((g) => {
      if (g.base_uom_id && !map.has(g.id)) {
        const base = uoms.find((u) => u.id === g.base_uom_id);
        if (base) map.set(g.id, base);
      }
    });
    return map;
  }, [uoms, groups]);

  const filteredUoms = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return uoms.filter((u) => {
      if (groupFilter !== undefined && u.group_id !== groupFilter) return false;
      if (!kw) return true;
      return (
        u.code.toLowerCase().includes(kw) ||
        u.name.toLowerCase().includes(kw) ||
        (u.symbol ?? "").toLowerCase().includes(kw)
      );
    });
  }, [uoms, groupFilter, keyword]);

  const formatFactor = (factor: number | null) => {
    const value = Number(factor ?? 1);
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(9)));
  };

  const handleAddUom = () => {
    setEditingUom(null);
    setIsBaseChecked(false);
    form.setFieldsValue({
      group_id: groupFilter ?? groups[0]?.id,
      code: "",
      name: "",
      symbol: "",
      factor: 1,
      rounding: 2,
      is_base: false,
      is_active: true,
    });
    setIsModalOpen(true);
  };

  const handleEditUom = (record: Uom) => {
    setEditingUom(record);
    setIsBaseChecked(!!record.is_base);
    form.setFieldsValue({
      group_id: record.group_id,
      code: record.code,
      name: record.name,
      symbol: record.symbol ?? "",
      factor: Number(record.factor),
      rounding: record.rounding ?? 2,
      is_base: !!record.is_base,
      is_active: !!record.is_active,
    });
    setIsModalOpen(true);
  };

  const handleSubmitUom = async (values: UomFormValues) => {
    const payload = {
      ...values,
      factor: values.is_base ? 1 : values.factor,
    };
    let uomId = editingUom?.id ?? null;
    try {
      if (editingUom) {
        await logWithTiming(t("uom.log.update"), "UPDATE", async () => {
          const { error } = await supabase
            .from("erp_uoms_s_539dcf81_b")
            .update(payload)
            .eq("id", editingUom.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        const inserted = await logWithTiming(t("uom.log.create"), "INSERT", async () => {
          const { data, error } = await supabase
            .from("erp_uoms_s_539dcf81_b")
            .insert([payload])
            .select("id")
            .single();
          if (error) throw error;
          return data;
        });
        uomId = inserted.id;
        message.success(t("common.createSuccess"));
      }

      if (payload.is_base && uomId) {
        await supabase
          .from("erp_uoms_s_539dcf81_b")
          .update({ is_base: false })
          .eq("group_id", payload.group_id)
          .neq("id", uomId);
        await supabase
          .from("erp_uom_groups_s_539dcf81_b")
          .update({ base_uom_id: uomId })
          .eq("id", payload.group_id);
      }

      setIsModalOpen(false);
      form.resetFields();
      setEditingUom(null);
      await Promise.all([fetchUoms(), fetchGroups()]);
    } catch (error) {
      console.error("Error saving uom:", error);
      const text = String((error as { message?: string }).message ?? "");
      if (text.includes("uq_erp_uoms_one_base_per_group")) {
        message.error(t("uom.form.baseAlreadyExists"));
      } else if (text.includes("duplicate key")) {
        message.error(t("uom.form.codeExists"));
      } else {
        message.error(t("common.saveFailed"));
      }
    }
  };

  const handleToggleActive = async (record: Uom, checked: boolean) => {
    try {
      const { error } = await supabase
        .from("erp_uoms_s_539dcf81_b")
        .update({ is_active: checked })
        .eq("id", record.id);
      if (error) throw error;
      message.success(checked ? t("common.enabled") : t("common.disabled"));
      await fetchUoms();
    } catch (error) {
      console.error("Error toggling uom status:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDeleteUom = async (id: number) => {
    try {
      const { error } = await supabase
        .from("erp_uoms_s_539dcf81_b")
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      await fetchUoms();
    } catch (error) {
      console.error("Error deleting uom:", error);
      message.error(t("common.deleteFailed"));
    }
  };

  const handleAddGroup = () => {
    setEditingGroup(null);
    groupForm.setFieldsValue({
      code: "",
      name: "",
      sort_order: (groups.at(-1)?.sort_order ?? 0) + 1,
      status: "active",
    });
    setIsGroupFormModalOpen(true);
  };

  const handleEditGroup = (record: UomGroup) => {
    setEditingGroup(record);
    groupForm.setFieldsValue({
      code: record.code,
      name: record.name,
      sort_order: record.sort_order ?? 0,
      status: record.status ?? "active",
    });
    setIsGroupFormModalOpen(true);
  };

  const handleSubmitGroup = async (values: UomGroupFormValues) => {
    try {
      if (editingGroup) {
        await logWithTiming(t("uom.groups.log.update"), "UPDATE", async () => {
          const { error } = await supabase
            .from("erp_uom_groups_s_539dcf81_b")
            .update(values)
            .eq("id", editingGroup.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("uom.groups.log.create"), "INSERT", async () => {
          const { error } = await supabase
            .from("erp_uom_groups_s_539dcf81_b")
            .insert([values]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }
      setIsGroupFormModalOpen(false);
      groupForm.resetFields();
      setEditingGroup(null);
      await fetchGroups();
    } catch (error) {
      console.error("Error saving uom group:", error);
      const text = String((error as { message?: string }).message ?? "");
      if (text.includes("duplicate key")) {
        message.error(t("uom.groups.codeExists"));
      } else {
        message.error(t("common.saveFailed"));
      }
    }
  };

  const handleDeleteGroup = async (id: number) => {
    try {
      const hasUnits = uoms.some((u) => u.group_id === id);
      if (hasUnits) {
        message.warning(t("uom.groups.deleteHasUnits"));
        return;
      }
      const { error } = await supabase
        .from("erp_uom_groups_s_539dcf81_b")
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      if (groupFilter === id) setGroupFilter(undefined);
      await fetchGroups();
    } catch (error) {
      console.error("Error deleting uom group:", error);
      message.error(t("common.deleteFailed"));
    }
  };

  const unitCountByGroup = useMemo(() => {
    const counts = new Map<number, number>();
    uoms.forEach((u) => {
      counts.set(u.group_id, (counts.get(u.group_id) ?? 0) + 1);
    });
    return counts;
  }, [uoms]);

  const columns = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 110,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
      width: 130,
    },
    {
      title: t("uom.symbol"),
      dataIndex: "symbol",
      key: "symbol",
      width: 90,
      render: (symbol: string | null) => symbol || "-",
    },
    {
      title: t("uom.group"),
      dataIndex: "group_id",
      key: "group_id",
      width: 120,
      render: (groupId: number) => groupMap.get(groupId)?.name || "-",
    },
    {
      title: t("uom.conversion"),
      key: "conversion",
      width: 200,
      render: (_: unknown, record: Uom) => {
        if (record.is_base) {
          return <Tag color="gold">{t("uom.baseUnit")}</Tag>;
        }
        const base = baseUnitMap.get(record.group_id);
        if (!base) return "-";
        return (
          <span>
            1 {base.name} = {formatFactor(record.factor)} {record.name}
          </span>
        );
      },
    },
    {
      title: t("uom.rounding"),
      dataIndex: "rounding",
      key: "rounding",
      width: 100,
      render: (rounding: number | null) => `${rounding ?? 0} ${t("uom.decimals")}`,
    },
    {
      title: t("common.status"),
      dataIndex: "is_active",
      key: "is_active",
      width: 90,
      render: (active: boolean | null, record: Uom) => (
        <Switch
          checked={!!active}
          size="small"
          disabled={!!record.is_base}
          onChange={(checked) => handleToggleActive(record, checked)}
        />
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 180,
      render: (_: unknown, record: Uom) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditUom(record)}>
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirmDelete")}
            description={
              record.is_base
                ? t("uom.deleteBaseConfirm")
                : t("uom.deleteConfirm")
            }
            onConfirm={() => handleDeleteUom(record.id)}
            okText={t("common.ok")}
            cancelText={t("common.cancel")}
            disabled={!!record.is_base}
          >
            <Button type="text" danger icon={<DeleteOutlined />} disabled={!!record.is_base}>
              {t("common.delete")}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const groupColumns = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 110,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
      width: 130,
    },
    {
      title: t("uom.baseUnit"),
      key: "base_unit",
      width: 120,
      render: (_: unknown, record: UomGroup) => {
        const base = record.base_uom_id ? uoms.find((u) => u.id === record.base_uom_id) : undefined;
        return base ? `${base.name} (${base.code})` : "-";
      },
    },
    {
      title: t("uom.unitCount"),
      key: "unit_count",
      width: 90,
      render: (_: unknown, record: UomGroup) => unitCountByGroup.get(record.id) ?? 0,
    },
    {
      title: t("common.sortOrder"),
      dataIndex: "sort_order",
      key: "sort_order",
      width: 80,
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 150,
      render: (_: unknown, record: UomGroup) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditGroup(record)}>
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirmDelete")}
            description={t("uom.groups.deleteConfirm")}
            onConfirm={() => handleDeleteGroup(record.id)}
            okText={t("common.ok")}
            cancelText={t("common.cancel")}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              {t("common.delete")}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        headerTitle={t('uom.title')}
        columns={columns}
        dataSource={filteredUoms}
        rowKey="id"
        loading={loading}
        storageKey={docType}
        queryBar={<Space>
          <Select
            allowClear
            placeholder={t("uom.filter.groupPlaceholder")}
            style={{ width: 180 }}
            value={groupFilter}
            onChange={(value) => setGroupFilter(value)}
          >
            {groups.map((g) => (
              <Option key={g.id} value={g.id}>
                {g.name}
              </Option>
            ))}
          </Select>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t("uom.searchPlaceholder")}
            style={{ width: 220 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button icon={<AppstoreOutlined />} onClick={() => setIsGroupModalOpen(true)}>
            {t("uom.groups.manage")}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAddUom}>
            {t("uom.add")}
          </Button>
        </Space>}
        pagination={{ pageSize: 10, showTotal: (total) => t("uom.totalUnits", { total }) }}
      />

      <SimpleModal
        title={editingUom ? t("uom.edit") : t("uom.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingUom(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
                form.resetFields();
                setEditingUom(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={520}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmitUom}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label={t("uom.group")}
            name="group_id"
            rules={[{ required: true, message: t("uom.form.groupRequired") }]}
          >
            <Select
              placeholder={t("uom.form.groupPlaceholder")}
              disabled={!!editingUom?.is_base}
            >
              {groups.map((g) => (
                <Option key={g.id} value={g.id}>
                  {g.name} ({g.code})
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("common.code")}
            name="code"
            rules={[{ required: true, message: t("uom.form.codeRequired") }]}
          >
            <Input placeholder={t("uom.form.codePlaceholder")} disabled={!!editingUom} />
          </Form.Item>
          <Form.Item
            label={t("common.name")}
            name="name"
            rules={[{ required: true, message: t("uom.form.nameRequired") }]}
          >
            <Input placeholder={t("uom.form.namePlaceholder")} />
          </Form.Item>
          <Form.Item label={t("uom.symbol")} name="symbol">
            <Input placeholder={t("uom.form.symbolPlaceholder")} />
          </Form.Item>
          <Form.Item
            label={t("uom.factor")}
            name="factor"
            tooltip={t("uom.form.factorTooltip")}
            rules={[
              { required: true, message: t("uom.form.factorRequired") },
              {
                validator: (_, value: number) =>
                  value > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error(t("uom.form.factorPositive"))),
              },
            ]}
          >
            <InputNumber
              style={{ width: "100%" }}
              min={0.000000001}
              step={1}
              precision={9}
              placeholder="1"
              disabled={isBaseChecked}
            />
          </Form.Item>
          <Form.Item
            label={t("uom.rounding")}
            name="rounding"
            tooltip={t("uom.form.roundingTooltip")}
            rules={[{ required: true, message: t("uom.form.roundingRequired") }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} max={6} precision={0} />
          </Form.Item>
          <Space size="large">
            <Form.Item label={t("uom.isBase")} name="is_base" valuePropName="checked">
              <Switch
                disabled={!!editingUom?.is_base}
                onChange={(checked) => {
                  setIsBaseChecked(checked);
                  if (checked) form.setFieldValue("factor", 1);
                }}
              />
            </Form.Item>
            <Form.Item label={t("uom.active")} name="is_active" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={t("uom.groups.manageTitle")}
        open={isGroupModalOpen}
        onCancel={() => setIsGroupModalOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setIsGroupModalOpen(false)}>{t("common.close")}</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddGroup}>
              {t("uom.groups.add")}
            </Button>
          </Space>
        }
        width={720}
      >
        <Table
          columns={groupColumns}
          dataSource={groups}
          rowKey="id"
          size="small"
          pagination={false}
        />
      </SimpleModal>

      <SimpleModal
        title={editingGroup ? t("uom.groups.edit") : t("uom.groups.add")}
        open={isGroupFormModalOpen}
        onCancel={() => {
          setIsGroupFormModalOpen(false);
          groupForm.resetFields();
          setEditingGroup(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsGroupFormModalOpen(false);
                groupForm.resetFields();
                setEditingGroup(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => groupForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={460}
      >
        <Form
          form={groupForm}
          layout="vertical"
          onFinish={handleSubmitGroup}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label={t("common.code")}
            name="code"
            rules={[{ required: true, message: t("uom.groups.codeRequired") }]}
          >
            <Input placeholder={t("uom.groups.codePlaceholder")} disabled={!!editingGroup} />
          </Form.Item>
          <Form.Item
            label={t("common.name")}
            name="name"
            rules={[{ required: true, message: t("uom.groups.nameRequired") }]}
          >
            <Input placeholder={t("uom.groups.namePlaceholder")} />
          </Form.Item>
          <Form.Item label={t("common.sortOrder")} name="sort_order">
            <InputNumber style={{ width: "100%" }} precision={0} />
          </Form.Item>
          <Form.Item label={t("common.status")} name="status">
            <Select placeholder={t("uom.groups.statusPlaceholder")}>
              <Option value="active">{t("common.enabled")}</Option>
              <Option value="inactive">{t("common.disabled")}</Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

export default Uoms;
