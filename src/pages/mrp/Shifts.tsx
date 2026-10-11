import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key } from "react";
import {
  Alert,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Switch,
  Tag,
  TimePicker,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import { nextDocumentNo } from "../../utils/documentNaming";

type Shift = Tables["erp_shifts_s_539dcf81_b"]["Row"];

const shiftTable = "erp_shifts_s_539dcf81_b";

/** TIME 列经 PostgREST 回来是 "HH:MM:SS"，列表里只留到分钟 */
const hhmm = (v: string | null | undefined): string =>
  typeof v === "string" && v.length >= 5 ? v.slice(0, 5) : "-";

/** dayjs(TimePicker 值) → "HH:MM"；DATE/TIME 列都必须显式格式化，不能把 dayjs 对象丢给 supabase */
const toTimeText = (v: Dayjs | null | undefined): string | null =>
  v ? dayjs(v).format("HH:mm") : null;

/**
 * 净工时 = 跨零点展开后的时长 − 休息分钟。
 *
 * ⚠️ 这里刻意**不做**「跨零点」开关给用户填：end <= start 就是跨零点，
 *    让用户手填会出现「时间填了夜班但忘了勾跨零点」→ 净工时算成负数
 *    这种录入事故。判断收敛到代码里，界面上只读回显。
 */
export const computeNetHours = (
  start: Dayjs | null | undefined,
  end: Dayjs | null | undefined,
  breakMinutes: number | null | undefined,
  crossMidnight: boolean,
): number => {
  if (!start || !end) return 0;
  const s = start.hour() * 60 + start.minute();
  const e = end.hour() * 60 + end.minute();
  let minutes = e - s;
  if (crossMidnight) minutes += 24 * 60;
  minutes -= Math.max(0, Number(breakMinutes) || 0);
  return Math.round((minutes / 60) * 100) / 100;
};

/**
 * 班次主档（`erp_shifts`）—— 排班地基。
 *
 * 为什么需要它：工作日历只回答「这一天开不开工」（布尔），回答不了
 * 「这天开几班、每班几点到几点、每班净工时多少」。排班的最小单位是
 * 「人 × 日期 × 班次 × 工位」这一格，缺了班次这一维就排不了。
 *
 * 被两处消费：
 *   · 工作中心 → **基准班次 + 每天班次数** 推导日产能（净工时 × 班次数）
 *   · 员工 → **默认班次**（排班预填）
 * 工作中心没配班次时，产能回退到人工填的 `capacity_per_day` —— 这是
 * 「可缺省」契约：老租户不维护班次时，产能数值与升级前保持一致。
 *
 * 本表是**租户业务主数据**（erp_*），不是平台基线字典，因此不预置数据；
 * 新建环境拿到空表是正常的，页面负责把空态说清楚。
 */
export function Shifts() {
  const { t } = useTranslation();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    void fetchShifts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchShifts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(shiftTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("shift_no", { ascending: true });
      if (error) throw error;
      setShifts((data || []) as unknown as Shift[]);
    } catch (error) {
      console.error("Error fetching shifts:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 起止时间/休息分钟变化时实时回显净工时（真正落库的值也由这里算，只此一处口径）
  //
  // ⚠️ 这里**必须**拆成三次单字段 useWatch，不能写成
  //    `const [a, b, c] = Form.useWatch([...], form)` 解构：
  //    底层 rc-field-form 把 watch 值放在 useState 里、靠 useEffect 回填，
  //    **首次渲染必然返回 undefined**（初值是空），数组解构当场抛
  //    「undefined is not iterable」把整页打崩。
  //    单字段形式即使首帧拿到 undefined 也只是普通变量值，不做解构就不会有事
  //    —— 全项目其余 20+ 处也都是这么写的。
  const watchedStart = Form.useWatch("start_time", form) as Dayjs | undefined;
  const watchedEnd = Form.useWatch("end_time", form) as Dayjs | undefined;
  const watchedBreak = Form.useWatch("break_minutes", form) as
    | number
    | undefined;

  const previewNetHours = useMemo(() => {
    if (!watchedStart || !watchedEnd) return 0;
    const cross = deriveCrossMidnight(watchedStart, watchedEnd);
    return computeNetHours(watchedStart, watchedEnd, watchedBreak, cross);
  }, [watchedStart, watchedEnd, watchedBreak]);

  const filtered = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    if (!kw) return shifts;
    return shifts.filter(
      (s) =>
        s.shift_no.toLowerCase().includes(kw) ||
        s.shift_name.toLowerCase().includes(kw),
    );
  }, [shifts, searchTerm]);

  const handleAdd = async () => {
    let shiftNo: string;
    try {
      shiftNo = await nextDocumentNo("work_shift");
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      shift_no: shiftNo,
      shift_name: "",
      start_time: dayjs("08:00", "HH:mm"),
      end_time: dayjs("17:00", "HH:mm"),
      break_minutes: 60,
      is_active: true,
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleEdit = (record: Shift) => {
    setEditing(record);
    form.setFieldsValue({
      shift_no: record.shift_no,
      shift_name: record.shift_name,
      start_time: dayjs(hhmm(record.start_time), "HH:mm"),
      end_time: dayjs(hhmm(record.end_time), "HH:mm"),
      break_minutes: record.break_minutes ?? 0,
      is_active: record.is_active !== false,
      remark: record.remark || "",
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    const start = values.start_time as Dayjs;
    const end = values.end_time as Dayjs;
    const breakMinutes = Number(values.break_minutes) || 0;
    const netHours = computeNetHours(start, end, breakMinutes, deriveCrossMidnight(start, end));

    if (netHours <= 0) {
      message.error(t("mrp.shifts.netHoursInvalid"));
      return;
    }

    const payload = {
      shift_no: String(values.shift_no || "").trim(),
      shift_name: String(values.shift_name || "").trim(),
      start_time: toTimeText(start),
      end_time: toTimeText(end),
      cross_midnight: deriveCrossMidnight(start, end),
      break_minutes: breakMinutes,
      net_hours: netHours,
      is_active: values.is_active !== false,
      remark: (values.remark as string) || null,
    };

    try {
      setSaving(true);
      await logWithTiming(
        editing ? t("mrp.shifts.logUpdate") : t("mrp.shifts.logCreate"),
        editing ? "UPDATE" : "INSERT",
        async () => {
          if (editing) {
            const { error } = await supabase
              .from(shiftTable)
              .update(payload)
              .eq("id", editing.id);
            if (error) throw error;
          } else {
            const { error } = await supabase.from(shiftTable).insert([payload]);
            if (error) throw error;
          }
        },
        editing ? { table: shiftTable, recordId: editing.id } : { table: shiftTable },
      );
      message.success(
        editing ? t("common.updateSuccess") : t("common.createSuccess"),
      );
      setIsModalOpen(false);
      form.resetFields();
      setEditing(null);
      await fetchShifts();
    } catch (error) {
      console.error("Error saving shift:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.shifts.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.shifts.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(shiftTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: shiftTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          await fetchShifts();
        } catch (error) {
          console.error("Error deleting shift:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const columns: SuperTableColumn<Shift>[] = [
    {
      title: t("mrp.shifts.code"),
      dataIndex: "shift_no",
      key: "shift_no",
      width: 160,
    },
    {
      title: t("mrp.shifts.name"),
      dataIndex: "shift_name",
      key: "shift_name",
      width: 160,
    },
    {
      title: t("mrp.shifts.period"),
      key: "period",
      width: 190,
      render: (_: unknown, record: Shift) => (
        <Space size={4}>
          <span>{`${hhmm(record.start_time)} - ${hhmm(record.end_time)}`}</span>
          {record.cross_midnight ? (
            <Tag color="blue">{t("mrp.shifts.nextDay")}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("mrp.shifts.netHours"),
      dataIndex: "net_hours",
      key: "net_hours",
      width: 110,
      align: "center",
      render: (v: number | null) => (v == null ? "-" : `${v} h`),
    },
    {
      title: t("mrp.shifts.breakMinutes"),
      dataIndex: "break_minutes",
      key: "break_minutes",
      width: 110,
      align: "center",
      render: (v: number | null) => (v == null ? "-" : String(v)),
    },
    {
      title: t("common.status"),
      dataIndex: "is_active",
      key: "is_active",
      width: 100,
      align: "center",
      render: (v: boolean | null) => (
        <Tag color={v === false ? "default" : "success"}>
          {v === false ? t("common.disabled") : t("common.enabled")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 180,
      fixed: "right",
      render: (_: unknown, record: Shift) => (
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
      {/* 管理员第一次进来会问「班次用来干什么」——把下游口径写在页面上 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("mrp.shifts.hint")}
      />
      <SuperTable
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="shifts"
        headerTitle={t("mrp.shifts.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.shifts.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.shifts.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchShifts}
              style={{ width: 240 }}
            />
          </Space>
        }
        locale={{ emptyText: t("mrp.shifts.empty") }}
      />

      <SimpleModal
        title={editing ? t("mrp.shifts.edit") : t("mrp.shifts.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditing(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="primary" loading={saving} onClick={() => form.submit()}>
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
                label={t("mrp.shifts.code")}
                name="shift_no"
                extra={t("mrp.shifts.codeAuto")}
                rules={[{ required: true, message: t("mrp.shifts.codePrompt") }]}
              >
                <Input
                  placeholder={t("mrp.shifts.codePrompt")}
                  disabled={!!editing}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.shifts.name")}
                name="shift_name"
                rules={[{ required: true, message: t("mrp.shifts.namePrompt") }]}
              >
                <Input placeholder={t("mrp.shifts.namePrompt")} />
              </Form.Item>
              <Form.Item
                label={t("mrp.shifts.startTime")}
                name="start_time"
                rules={[{ required: true, message: t("mrp.shifts.timePrompt") }]}
              >
                <TimePicker style={{ width: "100%" }} format="HH:mm" minuteStep={5} />
              </Form.Item>
              <Form.Item
                label={t("mrp.shifts.endTime")}
                name="end_time"
                rules={[{ required: true, message: t("mrp.shifts.timePrompt") }]}
              >
                <TimePicker style={{ width: "100%" }} format="HH:mm" minuteStep={5} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.shifts.breakMinutes")}
                name="break_minutes"
                initialValue={60}
              >
                <InputNumber style={{ width: "100%" }} min={0} max={1439} />
              </Form.Item>
              <Form.Item label={t("mrp.shifts.netHours")} extra={t("mrp.shifts.netHoursAuto")}>
                <Input
                  value={previewNetHours}
                  readOnly
                  suffix="h"
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item label={t("mrp.shifts.crossMidnight")}>
                <Input
                  readOnly
                  value={t("mrp.shifts.crossMidnightAuto")}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label={t("common.status")}
                name="is_active"
                valuePropName="checked"
                initialValue={true}
              >
                <Switch
                  checkedChildren={t("common.enabled")}
                  unCheckedChildren={t("common.disabled")}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("common.remark")} name="remark">
            <Input.TextArea rows={2} placeholder={t("mrp.shifts.remarkPrompt")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

/**
 * 跨零点判定：结束时间不晚于开始时间即为跨零点班（含满 24 小时班）。
 * 与 DB 侧 ck_erp_shifts_time_order 完全同一口径，改一处必须改两处。
 */
function deriveCrossMidnight(
  start: Dayjs | null | undefined,
  end: Dayjs | null | undefined,
): boolean {
  if (!start || !end) return false;
  const s = start.hour() * 60 + start.minute();
  const e = end.hour() * 60 + end.minute();
  return e <= s;
}
