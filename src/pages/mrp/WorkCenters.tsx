import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
  InputNumber,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  EnvironmentOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { useCurrencyRegistry } from "../../utils/money";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import SimpleModal from "../../components/SimpleModal";
import { Factory3dLayoutModal } from "../../components/Factory3dLayoutModal";

type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Department = Tables["erp_departments_s_539dcf81_b"]["Row"];
type Shift = Tables["erp_shifts_s_539dcf81_b"]["Row"];

const { Option } = Select;

const workCenterTable = "erp_work_centers_s_539dcf81_b";
const shiftTable = "erp_shifts_s_539dcf81_b";

/** TIME 列经 PostgREST 回来是 "HH:MM:SS"，展示只留到分钟 */
const timeText = (v: string | null | undefined): string =>
  typeof v === "string" && v.length >= 5 ? v.slice(0, 5) : "";

export function WorkCenters() {
  const { t } = useTranslation();
  // 工时/制费费率为本位币单价，符号跟随币别主数据
  const { getMeta } = useCurrencyRegistry();
  const baseCurrencySymbol = getMeta().symbol;
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  // 排班地基（deploy_119）：基准班次下拉的数据源
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // 3D 车间布局维护（deploy_135 布局表，独立组件可复用）
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [editingWorkCenter, setEditingWorkCenter] = useState<WorkCenter | null>(
    null,
  );
  const [form] = Form.useForm();

  useEffect(() => {
    fetchWorkCenters();
    fetchDepartments();
    fetchShifts();
  }, []);

  const fetchWorkCenters = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(workCenterTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error("Error fetching work centers:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchDepartments = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_departments_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setDepartments(data || []);
    } catch (error) {
      console.error("Error fetching departments:", error);
    }
  };

  /** 取全量（含停用班次），停用项在下拉里置灰保留，避免已配值的行编辑时变空 */
  const fetchShifts = async () => {
    try {
      const { data, error } = await supabase
        .from(shiftTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("shift_no");
      if (error) throw error;
      setShifts((data || []) as unknown as Shift[]);
    } catch (error) {
      console.error("Error fetching shifts:", error);
    }
  };

  const getShift = (shiftId: number | null | undefined) =>
    shifts.find((s) => s.id === shiftId);

  /**
   * 配了「基准班次 + 每天班次数」时的推导日产能。
   * 与 `vw_erp_capacity_load` 的口径必须一致：净工时 × 班次数，
   * 且只认**启用中**的班次（停用班次在视图里不贡献产能）。
   */
  const derivedDailyCapacity = (record: WorkCenter): number | null => {
    const shift = getShift(record.shift_id);
    if (!shift || shift.is_active === false) return null;
    const hours = Number(shift.net_hours) * Number(record.shift_count || 1);
    return hours > 0 ? hours : null;
  };

  const handleSubmit = async (values: any) => {
    // 显式构造 payload：Select/InputNumber 被清空时 form 给的是 undefined，
    // 直接透传会让 supabase 从 UPDATE 里省略该列 → 「清空基准班次」保存后不生效。
    const payload = {
      code: String(values.code || "").trim(),
      name: String(values.name || "").trim(),
      type: values.type || "machine",
      department_id: values.department_id ?? null,
      capacity_per_day: values.capacity_per_day ?? 0,
      labor_rate: values.labor_rate ?? 0,
      overhead_rate: values.overhead_rate ?? 0,
      status: values.status || "active",
      // 排班地基（deploy_119）
      shift_id: values.shift_id ?? null,
      shift_count: values.shift_count ?? 1,
    };

    try {
      if (editingWorkCenter) {
        await logWithTiming(t("mrp.workCenters.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(workCenterTable)
            .update(payload)
            .eq("id", editingWorkCenter.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("mrp.workCenters.logCreate"), "INSERT", async () => {
          const { error } = await supabase
            .from(workCenterTable)
            .insert([payload]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingWorkCenter(null);
      fetchWorkCenters();
    } catch (error) {
      console.error("Error saving work center:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: WorkCenter) => {
    setEditingWorkCenter(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.workCenters.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(t("mrp.workCenters.logDelete"), "DELETE", async () => {
            const { error } = await supabase
              .from(workCenterTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
          message.success(t("common.deleteSuccess"));
          fetchWorkCenters();
        } catch (error) {
          console.error("Error deleting work center:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingWorkCenter(null);
    form.setFieldsValue({
      code: "",
      name: "",
      type: "machine",
      department_id: undefined,
      capacity_per_day: 8,
      labor_rate: 0,
      overhead_rate: 0,
      status: "active",
      shift_id: undefined,
      shift_count: 1,
    });
    setIsModalOpen(true);
  };

  const getDepartmentName = (departmentId: number | null) => {
    const department = departments.find((d) => d.id === departmentId);
    return department?.name || "-";
  };

  const filteredWorkCenters = workCenters.filter(
    (w) =>
      w.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const typeLabels: Record<string, string> = {
    machine: t("mrp.workCenters.typeMachine"),
    labor: t("mrp.workCenters.typeLabor"),
    mixed: t("mrp.workCenters.typeMixed"),
    other: t("mrp.workCenters.typeOther"),
  };

  const columns: SuperTableColumn<WorkCenter>[] = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 200,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("common.type"),
      dataIndex: "type",
      key: "type",
      width: 100,
      align: "center",
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: t("mrp.workCenters.department"),
      dataIndex: "department_id",
      key: "department_id",
      render: (departmentId: number) => getDepartmentName(departmentId),
    },
    {
      title: t("mrp.workCenters.capacity"),
      dataIndex: "capacity_per_day",
      key: "capacity_per_day",
      width: 170,
      align: "center",
      // 配了基准班次 → 日产能由班次推导，capacity_per_day 不参与计算，必须让人一眼看出
      render: (v: number, record: WorkCenter) => {
        const derived = derivedDailyCapacity(record);
        if (derived == null) return v;
        return (
          <Tag color="blue">
            {t("mrp.workCenters.capacityByShift", { hours: derived })}
          </Tag>
        );
      },
    },
    {
      title: t("mrp.workCenters.shift"),
      dataIndex: "shift_id",
      key: "shift_id",
      width: 170,
      render: (shiftId: number | null, record: WorkCenter) => {
        const shift = getShift(shiftId);
        if (!shift) return "-";
        return `${shift.shift_name} × ${record.shift_count ?? 1}`;
      },
    },
    {
      title: t("mrp.workCenters.laborRate"),
      dataIndex: "labor_rate",
      key: "labor_rate",
      width: 120,
      align: "center",
      render: (rate: number) =>
        t("mrp.ratePerHour", {
          symbol: baseCurrencySymbol,
          rate: (rate ?? 0).toLocaleString(),
        }),
    },
    {
      title: t("mrp.workCenters.overheadRate"),
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      width: 120,
      align: "center",
      render: (rate: number) =>
        t("mrp.ratePerHour", {
          symbol: baseCurrencySymbol,
          rate: (rate ?? 0).toLocaleString(),
        }),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("mrp.inactive")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 200,
      render: (_: any, record: WorkCenter) => (
        <Space size="small">
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
            onClick={() => handleDelete(record.id)}
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
        dataSource={filteredWorkCenters}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="work-centers"
        headerTitle={t("mrp.workCenters.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.workCenters.add")}
            </Button>
            <Button
              icon={<EnvironmentOutlined />}
              onClick={() => setLayoutOpen(true)}
            >
              {t("mrp.workCenters.layout3dBtn")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.workCenters.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchWorkCenters}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      {/* 3D 车间布局维护：保存后无需刷新本页（布局表独立于工作中心字段） */}
      <Factory3dLayoutModal
        open={layoutOpen}
        onClose={() => setLayoutOpen(false)}
        workCenters={workCenters.map((w) => ({
          id: w.id,
          code: w.code,
          name: w.name,
        }))}
      />

      <SimpleModal
        title={
          editingWorkCenter
            ? t("mrp.workCenters.edit")
            : t("mrp.workCenters.add")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingWorkCenter(null);
        }}
        width={860}
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
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Row>
            <Col span={12}>
              <Form.Item
                label={t("common.code")}
                name="code"
                rules={[
                  { required: true, message: t("mrp.workCenters.codePrompt") },
                ]}
              >
                <Input
                  placeholder={t("mrp.workCenters.codePrompt")}
                  disabled={!!editingWorkCenter}
                />
              </Form.Item>              
              <Form.Item
                label={t("common.type")}
                name="type"
                initialValue="machine"
              >
                <Select>
                  <Option value="machine">
                    {t("mrp.workCenters.typeMachine")}
                  </Option>
                  <Option value="labor">
                    {t("mrp.workCenters.typeLabor")}
                  </Option>
                  <Option value="mixed">
                    {t("mrp.workCenters.typeMixed")}
                  </Option>
                  <Option value="other">
                    {t("mrp.workCenters.typeOther")}
                  </Option>
                </Select>
              </Form.Item>
              <Form.Item
                label={t("mrp.workCenters.department")}
                name="department_id"
              >
                <Select placeholder={t("mrp.workCenters.departmentPrompt")}>
                  {departments.map((d) => (
                    <Option key={d.id} value={d.id}>
                      {d.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item
                label={t("mrp.workCenters.capacity")}
                name="capacity_per_day"
                initialValue={8}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.workCenters.capacityPrompt")}
                />
              </Form.Item>
              {/* 排班地基（deploy_119）：配了班次后日产能改由「净工时 × 班次数」推导 */}
              <Form.Item
                label={t("mrp.workCenters.shift")}
                name="shift_id"
                extra={t("mrp.workCenters.shiftHint")}
              >
                <Select
                  placeholder={t("mrp.workCenters.shiftPrompt")}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  notFoundContent={t("mrp.shifts.empty")}
                  options={shifts.map((s) => ({
                    value: s.id,
                    label: `${s.shift_name}（${timeText(s.start_time)}-${timeText(s.end_time)}）`,
                    disabled: s.is_active === false,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
            <Form.Item
                label={t("common.name")}
                name="name"
                rules={[
                  { required: true, message: t("mrp.workCenters.namePrompt") },
                ]}
              >
                <Input placeholder={t("mrp.workCenters.namePrompt")} />
              </Form.Item>
              <Form.Item
                label={t("mrp.workCenters.shiftCount")}
                name="shift_count"
                initialValue={1}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  min={1}
                  max={4}
                  placeholder={t("mrp.workCenters.shiftCountPrompt")}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.workCenters.laborRate")}
                name="labor_rate"
                initialValue={0}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.workCenters.laborRatePrompt")}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.workCenters.overheadRate")}
                name="overhead_rate"
                initialValue={0}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.workCenters.overheadRatePrompt")}
                />
              </Form.Item>
              <Form.Item
                label={t("common.status")}
                name="status"
                initialValue="active"
              >
                <Select>
                  <Option value="active">{t("common.enabled")}</Option>
                  <Option value="inactive">{t("mrp.inactive")}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}
