import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { Key } from "react";
import {
  Alert,
  Button,
  Col,
  DatePicker,
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
import dayjs from "dayjs";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import { DictSelect } from "../../components/DictSelect";
import { useDict } from "../../hooks/useDict";

/**
 * 岗位取自**数据字典 `Jobs`**（`sys_dict_types.code = 'Jobs'`）。
 * 存的是字典项的 `code`，列表里再用同一份字典映射回显示名 —— 口径见 useDict。
 */
const JOB_DICT_TYPE = "Jobs";

type Employee = Tables["erp_employees_s_539dcf81_b"]["Row"];
type Department = Tables["erp_departments_s_539dcf81_b"]["Row"];

const { Option } = Select;

const employeeTable = "erp_employees_s_539dcf81_b";
const departmentTable = "erp_departments_s_539dcf81_b";

/**
 * 员工主数据（`erp_employees`）。
 *
 * 这张表一直被「消费」但从来没地方「维护」——
 *   · 生产订单 → 工序页签的**派工对象**（`erp_production_order_operations.assignee_id`）
 *   · 生产报工 → **操作工**（`erp_production_reports.operator_id`）
 *   · 仓库管理 → **负责人**（`erp_warehouses.manager_id`）
 * 三个下拉都读它，但全库没有员工页面、菜单里也没有入口，表本身还是空的
 * → 派工/报工的操作工下拉永远是空的。本页补的就是这个缺口。
 *
 * 两个刻意的口径：
 *   1. `status` 是本表的启用位（**不是** `is_active`，本表没有这个列）。
 *      停用 = 离职/借调，用 `status='active'` 过滤 —— 与「仓库管理」的既有写法一致。
 *   2. 列表**不过滤** status，停用的也要看得见，否则离职员工无法重新启用、也搜不到历史责任人。
 */
export function Employees() {
  const { t } = useTranslation();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [form] = Form.useForm();
  // 岗位字典：编辑框用它的 options，列表用它的 labelOf 把 code 还原成显示名
  const jobsDict = useDict(JOB_DICT_TYPE);

  useEffect(() => {
    void fetchEmployees();
    void fetchDepartments();
  }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(employeeTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setEmployees(data || []);
    } catch (error) {
      console.error("Error fetching employees:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchDepartments = async () => {
    try {
      const { data, error } = await supabase
        .from(departmentTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("code");
      if (error) throw error;
      setDepartments(data || []);
    } catch (error) {
      console.error("Error fetching departments:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    // DATE 列显式格式化：dayjs 对象直接交给 supabase 会按 UTC 序列化，
    // 在 UTC+8 下会整体差一天落库
    const payload = {
      code: String(values.code || "").trim(),
      name: String(values.name || "").trim(),
      department_id: values.department_id ?? null,
      // position 存的是字典项的 code（Jobs 字典），不是手输文本
      position: values.position || null,
      phone: values.phone?.trim() || null,
      email: values.email?.trim() || null,
      entry_date: values.entry_date
        ? dayjs(values.entry_date).format("YYYY-MM-DD")
        : null,
      status: values.status || "active",
    };

    try {
      if (editingEmployee) {
        await logWithTiming(
          t("mrp.employees.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(employeeTable)
              .update(payload)
              .eq("id", editingEmployee.id);
            if (error) throw error;
          },
          { table: employeeTable, recordId: editingEmployee.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(
          t("mrp.employees.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase
              .from(employeeTable)
              .insert([payload]);
            if (error) throw error;
          },
          { table: employeeTable },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingEmployee(null);
      void fetchEmployees();
    } catch (error) {
      console.error("Error saving employee:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: Employee) => {
    setEditingEmployee(record);
    form.setFieldsValue({
      ...record,
      entry_date: record.entry_date ? dayjs(record.entry_date) : undefined,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingEmployee(null);
    form.setFieldsValue({
      code: "",
      name: "",
      department_id: undefined,
      position: undefined,
      phone: "",
      email: "",
      entry_date: undefined,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.employees.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.employees.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(employeeTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: employeeTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          void fetchEmployees();
        } catch (error) {
          console.error("Error deleting employee:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const getDepartmentName = (departmentId: number | null) => {
    if (!departmentId) return "-";
    const department = departments.find((d) => d.id === departmentId);
    return department?.name || "-";
  };

  const filteredEmployees = employees.filter((e) => {
    const kw = searchTerm.toLowerCase();
    return (
      e.name.toLowerCase().includes(kw) ||
      e.code.toLowerCase().includes(kw) ||
      (e.phone || "").toLowerCase().includes(kw)
    );
  });

  const columns: SuperTableColumn<Employee>[] = [
    {
      title: t("mrp.employees.code"),
      dataIndex: "code",
      key: "code",
      width: 160,
    },
    {
      title: t("mrp.employees.name"),
      dataIndex: "name",
      key: "name",
      width: 140,
    },
    {
      title: t("mrp.employees.department"),
      dataIndex: "department_id",
      key: "department_id",
      width: 180,
      render: (departmentId: number | null) =>
        getDepartmentName(departmentId),
    },
    {
      title: t("mrp.employees.position"),
      dataIndex: "position",
      key: "position",
      width: 150,
      // 库里存 code，列表显示 labelOf(code)；字典项被删/停用则原样兜底显示旧 code
      render: (v: string | null) => jobsDict.labelOf(v) || "-",
    },
    {
      title: t("mrp.employees.phone"),
      dataIndex: "phone",
      key: "phone",
      width: 150,
      render: (v: string | null) => v || "-",
    },
    {
      title: t("mrp.employees.entryDate"),
      dataIndex: "entry_date",
      key: "entry_date",
      width: 130,
      render: (v: string | null) => v || "-",
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
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
      render: (_: any, record: Employee) => (
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
      {/* 这张表被三处下拉消费，管理员首次进来会问「填了有什么用」——把口径写在页面上；
          岗位又依赖数据字典，顺手给出维护入口，免得再来问「岗位下拉怎么是空的」 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <div>
            <div>{t("mrp.employees.hint")}</div>
            <div style={{ marginTop: 4 }}>
              {t("mrp.employees.positionDictPageHint")}
              <Link to="/system/dictionaries">
                {t("mrp.employees.goPositionDictionary")}
              </Link>
            </div>
          </div>
        }
      />
      <SuperTable
        columns={columns}
        dataSource={filteredEmployees}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="employees"
        headerTitle={t("mrp.employees.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.employees.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.employees.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchEmployees}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingEmployee ? t("mrp.employees.edit") : t("mrp.employees.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingEmployee(null);
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
        width={760}
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
                label={t("mrp.employees.code")}
                name="code"
                rules={[
                  { required: true, message: t("mrp.employees.codePrompt") },
                ]}
              >
                <Input
                  placeholder={t("mrp.employees.codePrompt")}
                  disabled={!!editingEmployee}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.employees.name")}
                name="name"
                rules={[
                  { required: true, message: t("mrp.employees.namePrompt") },
                ]}
              >
                <Input placeholder={t("mrp.employees.namePrompt")} />
              </Form.Item>
              <Form.Item
                label={t("mrp.employees.department")}
                name="department_id"
              >
                <Select
                  placeholder={t("mrp.employees.departmentPrompt")}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={departments.map((d) => ({
                    value: d.id,
                    label: d.name,
                  }))}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.employees.position")}
                name="position"
                extra={t("mrp.employees.positionDictHint")}
              >
                <DictSelect
                  dictType={JOB_DICT_TYPE}
                  placeholder={t("mrp.employees.positionPrompt")}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  notFoundContent={t("mrp.employees.positionDictEmpty")}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t("mrp.employees.phone")} name="phone">
                <Input placeholder={t("mrp.employees.phonePrompt")} />
              </Form.Item>
              <Form.Item
                label={t("mrp.employees.email")}
                name="email"
                rules={[{ type: "email", message: t("mrp.employees.emailInvalid") }]}
              >
                <Input placeholder={t("mrp.employees.emailPrompt")} />
              </Form.Item>
              <Form.Item label={t("mrp.employees.entryDate")} name="entry_date">
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
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
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}
