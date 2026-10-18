import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";

type Vehicle = Tables["erp_vehicles_s_539dcf81_b"]["Row"];

const { Option } = Select;

const vehicleTable = "erp_vehicles_s_539dcf81_b";

/**
 * 货车主数据（`erp_vehicles`，deploy_136 新增）。
 *
 * 3D 工厂驾驶舱新增了「货车」场景对象，它需要绑定一条货车主数据；
 * 这张表就是那个绑定源。系统此前没有货车对象，本页补上维护入口。
 *
 * 车牌号（plate_no）是主键级标识（租户内唯一），3D 场景对象的展示 label。
 * `status` 是启用位：active 启用 / inactive 停用，列表不过滤 status。
 */
export function Vehicles() {
  const { t } = useTranslation();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    void fetchVehicles();
  }, []);

  const fetchVehicles = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(vehicleTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setVehicles(data || []);
    } catch (error) {
      console.error("Error fetching vehicles:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    const payload = {
      plate_no: String(values.plate_no || "").trim(),
      name: values.name?.trim() || null,
      status: values.status || "active",
      remark: values.remark?.trim() || null,
    };

    try {
      if (editingVehicle) {
        await logWithTiming(
          t("mrp.vehicles.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(vehicleTable)
              .update(payload)
              .eq("id", editingVehicle.id);
            if (error) throw error;
          },
          { table: vehicleTable, recordId: editingVehicle.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(
          t("mrp.vehicles.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase
              .from(vehicleTable)
              .insert([payload]);
            if (error) throw error;
          },
          { table: vehicleTable },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingVehicle(null);
      void fetchVehicles();
    } catch (error) {
      console.error("Error saving vehicle:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: Vehicle) => {
    setEditingVehicle(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingVehicle(null);
    form.setFieldsValue({
      plate_no: "",
      name: "",
      status: "active",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.vehicles.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.vehicles.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(vehicleTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: vehicleTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          void fetchVehicles();
        } catch (error) {
          console.error("Error deleting vehicle:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const filteredVehicles = vehicles.filter((v) => {
    const kw = searchTerm.toLowerCase();
    return (
      (v.plate_no || "").toLowerCase().includes(kw) ||
      (v.name || "").toLowerCase().includes(kw)
    );
  });

  const columns: SuperTableColumn<Vehicle>[] = [
    {
      title: t("mrp.vehicles.plateNo"),
      dataIndex: "plate_no",
      key: "plate_no",
      width: 180,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
      render: (v: string | null) => v || "-",
    },
    {
      title: t("common.remark"),
      dataIndex: "remark",
      key: "remark",
      render: (v: string | null) => v || "-",
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (status: string | null) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("common.disabled")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 180,
      fixed: "right",
      render: (_: any, record: Vehicle) => (
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
            onClick={() => void handleDelete(record.id)}
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
        dataSource={filteredVehicles}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="vehicles"
        headerTitle={t("mrp.vehicles.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.vehicles.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.vehicles.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchVehicles}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={
          editingVehicle ? t("mrp.vehicles.edit") : t("mrp.vehicles.add")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingVehicle(null);
        }}
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
        width={520}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginTop: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.vehicles.plateNo")}
                name="plate_no"
                rules={[
                  { required: true, message: t("mrp.vehicles.plateNoPrompt") },
                ]}
              >
                <Input
                  placeholder={t("mrp.vehicles.plateNoPrompt")}
                  disabled={!!editingVehicle}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t("common.name")} name="name">
                <Input placeholder={t("mrp.vehicles.namePrompt")} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label={t("common.status")}
            name="status"
            initialValue="active"
          >
            <Select>
              <Option value="active">{t("common.enabled")}</Option>
              <Option value="inactive">{t("common.disabled")}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t("common.remark")} name="remark">
            <Input.TextArea
              rows={2}
              placeholder={t("mrp.vehicles.remarkPrompt")}
            />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
