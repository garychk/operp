/**
 * 工作日历（P0-4 · deploy_114）
 *
 * 为什么需要它：MRP 的提前期倒排此前按**自然日**回退，计划下达日会落在周末
 * 或节假日（计划员看到的采购下单日是周日，实际没人下单）。有了工作日历，
 * 引擎按工作日倒推下达日，并把非工作日的需求提前到前一个工作日。
 *
 * 数据模型：周规律（`work_days` = ISO 星期数组 1..7）+ 例外日
 * （节假日放假 / 周末调休上班）。例外日优先于周规律。
 *
 * 生效条件：**默认 + 启用**。每租户至多一个默认日历（部分唯一索引强制），
 * 所以保存为默认时会先把其他日历的默认标记清掉 —— 否则会撞唯一索引，
 * 用户看到的是「duplicate key」这种没法自己解决的报错。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  message,
} from "antd";
import {
  CalendarOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { supabase } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import { logWithTiming } from "../../utils/logger";
import { nextDocumentNo } from "../../utils/documentNaming";

const calendarTable = "erp_work_calendars_s_539dcf81_b";
const calendarDayTable = "erp_work_calendar_days_s_539dcf81_b";

interface WorkCalendarRow {
  id: number;
  calendar_no: string;
  calendar_name: string;
  work_days: number[] | null;
  is_default: boolean | null;
  is_active: boolean | null;
  remark: string | null;
}

interface CalendarDayRow {
  id: number;
  calendar_id: number;
  calendar_date: string;
  is_workday: boolean;
  remark: string | null;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function WorkCalendars() {
  const { t } = useTranslation();
  const [calendars, setCalendars] = useState<WorkCalendarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkCalendarRow | null>(null);
  const [editingDays, setEditingDays] = useState<WorkCalendarRow | null>(null);
  const [days, setDays] = useState<CalendarDayRow[]>([]);
  const [daysLoading, setDaysLoading] = useState(false);
  const [form] = Form.useForm();
  const [dayForm] = Form.useForm();

  useEffect(() => {
    void fetchCalendars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCalendars = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(calendarTable)
        .select("id, calendar_no, calendar_name, work_days, is_default, is_active, remark")
        .eq("is_deleted", "n")
        .order("calendar_no", { ascending: true });
      if (error) throw error;
      setCalendars((data || []) as unknown as WorkCalendarRow[]);
    } catch (error) {
      console.error("Error fetching work calendars:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const weekdayLabel = (day: number) =>
    t(`mrp.workCalendars.weekday${day}` as const);

  /** 没有任何「默认 + 启用」的日历 → 引擎按自然日计算，必须明确提示 */
  const hasActiveDefault = useMemo(
    () => calendars.some((c) => c.is_default && c.is_active),
    [calendars],
  );

  const filtered = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    if (!kw) return calendars;
    return calendars.filter(
      (c) =>
        c.calendar_no.toLowerCase().includes(kw) ||
        c.calendar_name.toLowerCase().includes(kw),
    );
  }, [calendars, searchTerm]);

  const handleAdd = async () => {
    let calendarNo: string;
    try {
      calendarNo = await nextDocumentNo("work_calendar");
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      calendar_no: calendarNo,
      calendar_name: "",
      work_days: [1, 2, 3, 4, 5],
      is_default: calendars.length === 0,
      is_active: true,
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleEdit = (record: WorkCalendarRow) => {
    setEditing(record);
    form.setFieldsValue({
      calendar_no: record.calendar_no,
      calendar_name: record.calendar_name,
      work_days: record.work_days && record.work_days.length ? record.work_days : [1, 2, 3, 4, 5],
      is_default: Boolean(record.is_default),
      is_active: record.is_active !== false,
      remark: record.remark || "",
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    const workDays = ((values.work_days as number[]) || []).slice().sort((a, b) => a - b);
    const isDefault = Boolean(values.is_default);
    const payload = {
      calendar_name: values.calendar_name,
      work_days: workDays,
      is_default: isDefault,
      is_active: values.is_active !== false,
      remark: (values.remark as string) || null,
    };

    try {
      setSaving(true);
      await logWithTiming(editing ? "更新工作日历" : "新增工作日历", editing ? "UPDATE" : "POST", async () => {
        if (editing) {
          // 先把其他日历的默认标记清掉：唯一索引 uq_erp_work_calendars_default
          // 只允许每租户一个默认，不先清就会撞 23505（用户无从解决的报错）
          if (isDefault) {
            const { error: clearErr } = await supabase
              .from(calendarTable)
              .update({ is_default: false })
              .eq("is_deleted", "n")
              .neq("id", editing.id)
              .eq("is_default", true);
            if (clearErr) throw clearErr;
          }
          const { error } = await supabase
            .from(calendarTable)
            .update(payload)
            .eq("id", editing.id);
          if (error) throw error;
        } else {
          if (isDefault) {
            const { error: clearErr } = await supabase
              .from(calendarTable)
              .update({ is_default: false })
              .eq("is_deleted", "n")
              .eq("is_default", true);
            if (clearErr) throw clearErr;
          }
          const { error } = await supabase
            .from(calendarTable)
            .insert([{ ...payload, calendar_no: values.calendar_no }]);
          if (error) throw error;
        }
      });
      message.success(editing ? t("common.updateSuccess") : t("common.createSuccess"));
      setIsModalOpen(false);
      form.resetFields();
      setEditing(null);
      await fetchCalendars();
    } catch (error) {
      console.error("Error saving work calendar:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (record: WorkCalendarRow) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.workCalendars.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming("删除工作日历", "DELETE", async () => {
            const { error } = await supabase
              .from(calendarTable)
              .update({ is_deleted: "y" })
              .eq("id", record.id);
            if (error) throw error;
            // 例外日是软删的，日历本身也软删 → 一起标记，避免留下看不见的孤儿行
            const { error: dayErr } = await supabase
              .from(calendarDayTable)
              .update({ is_deleted: "y" })
              .eq("calendar_id", record.id);
            if (dayErr) throw dayErr;
          });
          message.success(t("common.deleteSuccess"));
          await fetchCalendars();
        } catch (error) {
          console.error("Error deleting work calendar:", error);
          message.error(`${t("common.deleteFailed")}：${(error as Error).message}`);
        }
      },
    });
  };

  const openDays = async (record: WorkCalendarRow) => {
    setEditingDays(record);
    dayForm.resetFields();
    try {
      setDaysLoading(true);
      const { data, error } = await supabase
        .from(calendarDayTable)
        .select("id, calendar_id, calendar_date, is_workday, remark")
        .eq("calendar_id", record.id)
        .eq("is_deleted", "n")
        .order("calendar_date", { ascending: true });
      if (error) throw error;
      setDays((data || []) as unknown as CalendarDayRow[]);
    } catch (error) {
      console.error("Error fetching calendar days:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setDaysLoading(false);
    }
  };

  const handleAddDay = async (values: Record<string, unknown>) => {
    if (!editingDays) return;
    const calendarDate = dayjs(values.calendar_date as never).format("YYYY-MM-DD");
    if (days.some((d) => d.calendar_date === calendarDate)) {
      message.warning(t("mrp.workCalendars.exceptionDuplicate"));
      return;
    }
    try {
      setSaving(true);
      const { error } = await supabase.from(calendarDayTable).insert([
        {
          calendar_id: editingDays.id,
          calendar_date: calendarDate,
          is_workday: values.is_workday !== false,
          remark: (values.remark as string) || null,
        },
      ]);
      if (error) throw error;
      message.success(t("common.createSuccess"));
      dayForm.resetFields();
      await openDays(editingDays);
    } catch (error) {
      console.error("Error adding calendar day:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteDay = async (id: number) => {
    if (!editingDays) return;
    try {
      const { error } = await supabase
        .from(calendarDayTable)
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      await openDays(editingDays);
    } catch (error) {
      console.error("Error deleting calendar day:", error);
      message.error(`${t("common.deleteFailed")}：${(error as Error).message}`);
    }
  };

  const columns: SuperTableColumn<WorkCalendarRow>[] = [
    { title: t("mrp.workCalendars.calendarNo"), dataIndex: "calendar_no", key: "calendar_no", width: 160 },
    { title: t("mrp.workCalendars.calendarName"), dataIndex: "calendar_name", key: "calendar_name", width: 200 },
    {
      title: t("mrp.workCalendars.workDays"),
      dataIndex: "work_days",
      key: "work_days",
      render: (value: number[] | null) => (
        <Space size={4} wrap>
          {(value && value.length ? value : []).map((day) => (
            <Tag key={day}>{weekdayLabel(day)}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t("common.status"),
      dataIndex: "is_active",
      key: "is_active",
      width: 150,
      align: "center",
      render: (_: unknown, record: WorkCalendarRow) => (
        <Space size={4}>
          {record.is_default ? <Tag color="blue">{t("mrp.workCalendars.defaultTag")}</Tag> : null}
          {record.is_active ? (
            <Tag color="success">{t("common.enabled")}</Tag>
          ) : (
            <Tag>{t("mrp.workCalendars.inactiveTag")}</Tag>
          )}
        </Space>
      ),
    },
    { title: t("common.remark"), dataIndex: "remark", key: "remark", ellipsis: true },
    {
      title: t("common.actions"),
      key: "action",
      width: 260,
      fixed: "right",
      render: (_: unknown, record: WorkCalendarRow) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t("common.edit")}
          </Button>
          <Button type="text" icon={<CalendarOutlined />} onClick={() => void openDays(record)}>
            {t("mrp.workCalendars.openExceptions")}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)}>
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {!loading && !hasActiveDefault && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.workCalendars.noDefaultWarning")}
        />
      )}

      <SuperTable
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="mrp-work-calendars"
        headerTitle={t("mrp.workCalendars.title")}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAdd()}>
              {t("mrp.workCalendars.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.workCalendars.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editing ? t("mrp.workCalendars.edit") : t("mrp.workCalendars.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditing(null);
        }}
        width={760}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
                form.resetFields();
                setEditing(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" loading={saving} onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        <Card size="small">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("mrp.workCalendars.defaultHint")}
          />
          <Form form={form} layout="horizontal" labelCol={{ span: 8 }} wrapperCol={{ span: 16 }} onFinish={handleSubmit}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.workCalendars.calendarNo")}
                  name="calendar_no"
                  rules={[{ required: true, message: t("mrp.workCalendars.codePrompt") }]}
                >
                  {/* 编号走 generate_document_no('work_calendar')，编辑时不允许改号 */}
                  <Input placeholder={t("mrp.workCalendars.codePrompt")} disabled={!!editing} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.workCalendars.calendarName")}
                  name="calendar_name"
                  rules={[{ required: true, message: t("mrp.workCalendars.namePrompt") }]}
                >
                  <Input placeholder={t("mrp.workCalendars.namePrompt")} />
                </Form.Item>
              </Col>

              <Col span={24}>
                <Form.Item
                  label={t("mrp.workCalendars.workDays")}
                  name="work_days"
                  labelCol={{ span: 4 }}
                  wrapperCol={{ span: 20 }}
                  rules={[
                    {
                      validator: (_rule, value: number[]) =>
                        value && value.length > 0
                          ? Promise.resolve()
                          : Promise.reject(new Error(t("mrp.workCalendars.workDaysPrompt"))),
                    },
                  ]}
                >
                  <Checkbox.Group
                    options={WEEKDAYS.map((day) => ({ label: weekdayLabel(day), value: day }))}
                  />
                </Form.Item>
              </Col>

              <Col span={12}>
                <Form.Item
                  label={t("mrp.workCalendars.isDefault")}
                  name="is_default"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.workCalendars.isActive")}
                  name="is_active"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>

              <Col span={24}>
                <Form.Item label={t("common.remark")} name="remark">
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </SimpleModal>

      <SimpleModal
        title={t("mrp.workCalendars.exceptionTitle", {
          name: editingDays ? `${editingDays.calendar_no} ${editingDays.calendar_name}` : "",
        })}
        open={!!editingDays}
        onCancel={() => {
          setEditingDays(null);
          setDays([]);
          dayForm.resetFields();
        }}
        width={760}
        footer={
          <Button
            onClick={() => {
              setEditingDays(null);
              setDays([]);
              dayForm.resetFields();
            }}
          >
            {t("common.close")}
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("mrp.workCalendars.exceptionHint")}
        />
        <Card size="small" style={{ marginBottom: 12 }}>
          <Form form={dayForm} layout="inline" onFinish={handleAddDay}>
            <Form.Item
              label={t("mrp.workCalendars.exceptionDate")}
              name="calendar_date"
              rules={[{ required: true, message: t("mrp.workCalendars.exceptionDatePrompt") }]}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item
              label={t("mrp.workCalendars.exceptionIsWorkday")}
              name="is_workday"
              initialValue={false}
            >
              <Select
                style={{ width: 120 }}
                options={[
                  { value: false, label: t("mrp.workCalendars.holiday") },
                  { value: true, label: t("mrp.workCalendars.workday") },
                ]}
              />
            </Form.Item>
            <Form.Item label={t("common.remark")} name="remark">
              <Input style={{ width: 160 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={saving} icon={<PlusOutlined />}>
                {t("mrp.workCalendars.addException")}
              </Button>
            </Form.Item>
          </Form>
        </Card>

        <SuperTable
          columns={[
            { title: t("mrp.workCalendars.exceptionDate"), dataIndex: "calendar_date", key: "calendar_date", width: 140 },
            {
              title: t("mrp.workCalendars.exceptionIsWorkday"),
              dataIndex: "is_workday",
              key: "is_workday",
              width: 110,
              align: "center",
              render: (value: boolean) =>
                value ? (
                  <Tag color="success">{t("mrp.workCalendars.workday")}</Tag>
                ) : (
                  <Tag color="default">{t("mrp.workCalendars.holiday")}</Tag>
                ),
            },
            { title: t("common.remark"), dataIndex: "remark", key: "remark" },
            {
              title: t("common.actions"),
              key: "action",
              width: 90,
              render: (_: unknown, record: CalendarDayRow) => (
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => void handleDeleteDay(record.id)}
                />
              ),
            },
          ]}
          dataSource={days}
          rowKey="id"
          loading={daysLoading}
          pagination={false}
          storageKey="mrp-calendar-days"
        />
      </SimpleModal>
    </div>
  );
}

export default WorkCalendars;
