import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Splitter,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../../utils/supabase";
import { useTranslation } from "react-i18next";

type FieldOption = { label: string; value: string };

type RuleRow = {
  id: number;
  rule_code: string;
  rule_name: string;
  source_document_type: string;
  target_document_type: string;
  source_quantity_field: string;
  target_quantity_field: string;
  source_detail_key_field: string;
  target_source_ref_field: string | null;
  source_detail_parent_field: string;
  target_no_field: string;
  target_detail_parent_field: string;
  target_initial_status: string;
  allow_partial: boolean;
  require_source_approved: boolean;
  is_active: boolean;
  description: string | null;
};

type MapLevel = "header" | "line";
type SourceType = "field" | "const" | "sys";

type MapRow = {
  target_field: string;
  source_type: SourceType;
  source_field: string | null;
  const_value: string | null;
  is_required: boolean;
  sequence_no: number;
};

type TransferRow = {
  id: number;
  source_detail_id: number | null;
  target_detail_id: number | null;
  quantity: number;
  transfer_kind: "convert" | "reverse";
  reversed_transfer_id: number | null;
  reason: string | null;
  created_at: string;
};

const SYS_VALUE_OPTIONS: FieldOption[] = [
  { label: "today", value: "today" },
  { label: "now", value: "now" },
  { label: "current_user_id", value: "current_user_id" },
  { label: "source_id", value: "source_id" },
  { label: "source_no", value: "source_no" },
];

const EMPTY_MAP: MapRow = {
  target_field: "",
  source_type: "field",
  source_field: null,
  const_value: null,
  is_required: false,
  sequence_no: 0,
};

const RULE_COLUMNS = "id, rule_code, rule_name, source_document_type, target_document_type, " +
  "source_quantity_field, target_quantity_field, source_detail_key_field, target_source_ref_field, " +
  "source_detail_parent_field, target_no_field, target_detail_parent_field, target_initial_status, " +
  "allow_partial, require_source_approved, is_active, description";

function MapEditor({
  rows,
  targetOptions,
  sourceOptions,
  onChange,
}: {
  rows: MapRow[];
  targetOptions: FieldOption[];
  sourceOptions: FieldOption[];
  onChange: (next: MapRow[]) => void;
}) {
  const { t } = useTranslation();

  const patch = (index: number, changes: Partial<MapRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  };

  const columns: ColumnsType<MapRow> = [
    {
      title: t("docFlow.targetField"),
      dataIndex: "target_field",
      width: 190,
      render: (_value: unknown, row: MapRow, index: number) => (
        <Select
          style={{ width: "100%" }}
          showSearch
          allowClear
          value={row.target_field || undefined}
          options={targetOptions}
          onChange={(value) => patch(index, { target_field: value ?? "" })}
        />
      ),
    },
    {
      title: t("docFlow.sourceType"),
      dataIndex: "source_type",
      width: 120,
      render: (_value: unknown, row: MapRow, index: number) => (
        <Select
          style={{ width: "100%" }}
          value={row.source_type}
          onChange={(value: SourceType) => patch(index, { source_type: value })}
          options={[
            { label: t("docFlow.typeField"), value: "field" },
            { label: t("docFlow.typeConst"), value: "const" },
            { label: t("docFlow.typeSys"), value: "sys" },
          ]}
        />
      ),
    },
    {
      title: t("docFlow.sourceField"),
      dataIndex: "source_field",
      render: (_value: unknown, row: MapRow, index: number) => {
        if (row.source_type === "const") {
          return (
            <Input
              value={row.const_value ?? ""}
              placeholder={t("docFlow.constValue")}
              onChange={(event) => patch(index, { const_value: event.target.value })}
            />
          );
        }
        if (row.source_type === "sys") {
          return (
            <Select
              style={{ width: "100%" }}
              value={row.source_field || undefined}
              options={SYS_VALUE_OPTIONS}
              onChange={(value) => patch(index, { source_field: value })}
            />
          );
        }
        return (
          <Select
            style={{ width: "100%" }}
            showSearch
            allowClear
            value={row.source_field || undefined}
            options={sourceOptions}
            onChange={(value) => patch(index, { source_field: value ?? null })}
          />
        );
      },
    },
    {
      title: t("docFlow.required"),
      dataIndex: "is_required",
      width: 70,
      render: (_value: unknown, row: MapRow, index: number) => (
        <Switch size="small" checked={row.is_required} onChange={(checked) => patch(index, { is_required: checked })} />
      ),
    },
    {
      title: t("docFlow.sortOrder"),
      dataIndex: "sequence_no",
      width: 80,
      render: (_value: unknown, row: MapRow, index: number) => (
        <InputNumber size="small" value={row.sequence_no} onChange={(value) => patch(index, { sequence_no: value ?? 0 })} />
      ),
    },
    {
      title: "",
      width: 50,
      render: (_value: unknown, _row: MapRow, index: number) => (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => onChange(rows.filter((_, i) => i !== index))}
        />
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Button size="small" icon={<PlusOutlined />} onClick={() => onChange([...rows, { ...EMPTY_MAP }])}>
        {t("docFlow.addMap")}
      </Button>
      <Table<MapRow>
        rowKey={(_record: MapRow, index?: number) => String(index)}
        size="small"
        pagination={false}
        dataSource={rows}
        columns={columns}
      />
    </Space>
  );
}

export function DocFlowConfig() {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [documentTypes, setDocumentTypes] = useState<FieldOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [headerMaps, setHeaderMaps] = useState<MapRow[]>([]);
  const [lineMaps, setLineMaps] = useState<MapRow[]>([]);
  const [sourceHeaderFields, setSourceHeaderFields] = useState<FieldOption[]>([]);
  const [sourceLineFields, setSourceLineFields] = useState<FieldOption[]>([]);
  const [targetHeaderFields, setTargetHeaderFields] = useState<FieldOption[]>([]);
  const [targetLineFields, setTargetLineFields] = useState<FieldOption[]>([]);
  const [ledger, setLedger] = useState<TransferRow[]>([]);

  const sourceDoc = Form.useWatch("source_document_type", form);
  const targetDoc = Form.useWatch("target_document_type", form);

  const fetchDocumentTypes = useCallback(async () => {
    const { data, error } = await supabase
      .from("sys_document_types")
      .select("document_type, document_name")
      .eq("is_deleted", "n")
      .eq("status", "1")
      .order("sort_order", { ascending: true });
    if (error) {
      message.error(error.message);
      return;
    }
    setDocumentTypes((data ?? []).map((item) => ({ label: item.document_name as string, value: item.document_type as string })));
  }, []);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("doc_flow_rules")
        .select(RULE_COLUMNS)
        .eq("is_deleted", "n")
        .order("id", { ascending: true });
      if (error) throw error;
      setRules((data ?? []) as unknown as RuleRow[]);
    } catch {
      message.error(t("docFlow.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadFields = useCallback(async (documentType: string, level: MapLevel): Promise<FieldOption[]> => {
    const { data, error } = await supabase.rpc("doc_flow_list_fields", {
      p_document_type: documentType,
      p_level: level,
    });
    if (error) {
      message.error(error.message);
      return [];
    }
    return (data ?? []).map((item: { field_name: string; data_type: string }) => ({
      label: `${item.field_name} (${item.data_type})`,
      value: item.field_name,
    }));
  }, []);

  useEffect(() => {
    void fetchDocumentTypes();
    void fetchRules();
  }, [fetchDocumentTypes, fetchRules]);

  useEffect(() => {
    if (!sourceDoc) return;
    void loadFields(sourceDoc, "header").then(setSourceHeaderFields);
    void loadFields(sourceDoc, "line").then(setSourceLineFields);
  }, [sourceDoc, loadFields]);

  useEffect(() => {
    if (!targetDoc) return;
    void loadFields(targetDoc, "header").then(setTargetHeaderFields);
    void loadFields(targetDoc, "line").then(setTargetLineFields);
  }, [targetDoc, loadFields]);

  const loadMaps = useCallback(async (ruleId: number) => {
    const { data, error } = await supabase
      .from("doc_flow_field_maps")
      .select("map_level, target_field, source_type, source_field, const_value, is_required, sequence_no")
      .eq("rule_id", ruleId)
      .eq("is_deleted", "n")
      .order("sequence_no", { ascending: true })
      .order("id", { ascending: true });
    if (error) {
      message.error(error.message);
      return;
    }
    type MapRecord = {
      map_level: string;
      target_field: string;
      source_type: string;
      source_field: string | null;
      const_value: string | null;
      is_required: boolean | null;
      sequence_no: number | null;
    };
    const records = (data ?? []) as MapRecord[];
    const toRow = (item: MapRecord): MapRow => ({
      target_field: item.target_field,
      source_type: item.source_type as SourceType,
      source_field: item.source_field,
      const_value: item.const_value,
      is_required: Boolean(item.is_required),
      sequence_no: Number(item.sequence_no ?? 0),
    });
    setHeaderMaps(records.filter((item) => item.map_level === "header").map(toRow));
    setLineMaps(records.filter((item) => item.map_level === "line").map(toRow));
  }, []);

  const loadLedger = useCallback(async (ruleId: number) => {
    const { data, error } = await supabase
      .from("doc_flow_transfers")
      .select("id, source_detail_id, target_detail_id, quantity, transfer_kind, reversed_transfer_id, reason, created_at")
      .eq("rule_id", ruleId)
      .eq("is_deleted", "n")
      .order("id", { ascending: false })
      .limit(200);
    if (error) {
      message.error(error.message);
      return;
    }
    setLedger((data ?? []) as TransferRow[]);
  }, []);

  const handleSelect = async (record: RuleRow) => {
    setSelectedId(record.id);
    setIsNew(false);
    form.setFieldsValue(record);
    await Promise.all([loadMaps(record.id), loadLedger(record.id)]);
  };

  const handleAdd = () => {
    setSelectedId(null);
    setIsNew(true);
    form.resetFields();
    form.setFieldsValue({
      source_quantity_field: "quantity",
      target_quantity_field: "quantity",
      source_detail_key_field: "id",
      source_detail_parent_field: "order_id",
      target_detail_parent_field: "receipt_id",
      target_no_field: "document_no",
      target_initial_status: "draft",
      allow_partial: true,
      require_source_approved: true,
      is_active: true,
    });
    setHeaderMaps([]);
    setLineMaps([]);
    setLedger([]);
  };

  const persistMaps = async (ruleId: number, level: MapLevel, rows: MapRow[]) => {
    await supabase
      .from("doc_flow_field_maps")
      .update({ is_deleted: "y" })
      .eq("rule_id", ruleId)
      .eq("map_level", level);

    for (const row of rows) {
      if (!row.target_field) continue;
      const { error } = await supabase.from("doc_flow_field_maps").upsert(
        {
          rule_id: ruleId,
          map_level: level,
          target_field: row.target_field,
          source_type: row.source_type,
          source_field: row.source_type === "field" ? row.source_field : null,
          const_value: row.source_type === "const" ? row.const_value : null,
          is_required: row.is_required,
          sequence_no: row.sequence_no,
          is_deleted: "n",
        },
        { onConflict: "rule_id,map_level,target_field" },
      );
      if (error) throw error;
    }
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      let ruleId = selectedId;
      if (isNew || !ruleId) {
        const { data, error } = await supabase
          .from("doc_flow_rules")
          .insert({ ...values, is_deleted: "n" })
          .select("id")
          .single();
        if (error) throw error;
        ruleId = data.id as number;
      } else {
        const { error } = await supabase
          .from("doc_flow_rules")
          .update({ ...values, updated_at: new Date().toISOString() })
          .eq("id", ruleId);
        if (error) throw error;
      }
      await persistMaps(ruleId, "header", headerMaps);
      await persistMaps(ruleId, "line", lineMaps);
      message.success(t("docFlow.saveSuccess"));
      setIsNew(false);
      setSelectedId(ruleId);
      await fetchRules();
      await loadLedger(ruleId);
    } catch (error) {
      const err = error as { message?: string };
      message.error(err.message ?? t("docFlow.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const ruleColumns: ColumnsType<RuleRow> = [
    { title: t("docFlow.ruleName"), dataIndex: "rule_name" },
    {
      title: t("docFlow.sourceDoc"),
      dataIndex: "source_document_type",
      width: 170,
      render: (value: string, record: RuleRow) => `${value} → ${record.target_document_type}`,
    },
  ];

  const ledgerColumns: ColumnsType<TransferRow> = [
    { title: t("docFlow.kind"), dataIndex: "transfer_kind", width: 90, render: (value: string) => (
      <Tag color={value === "reverse" ? "red" : "blue"}>
        {value === "reverse" ? t("docFlow.kindReverse") : t("docFlow.kindConvert")}
      </Tag>
    ) },
    { title: t("docFlow.qty"), dataIndex: "quantity", width: 110, align: "right" },
    { title: t("docFlow.sourceLine"), dataIndex: "source_detail_id", width: 100 },
    { title: t("docFlow.targetLine"), dataIndex: "target_detail_id", width: 100 },
    { title: t("docFlow.reverseOf"), dataIndex: "reversed_transfer_id", width: 100 },
    { title: t("docFlow.reason"), dataIndex: "reason" },
    { title: t("docFlow.actedAt"), dataIndex: "created_at", width: 180, render: (value: string) => value?.slice(0, 19).replace("T", " ") },
  ];

  const hasRule = selectedId !== null || isNew;

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<PlusOutlined />} onClick={handleAdd}>{t("docFlow.addRule")}</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void fetchRules()}>{t("docFlow.refresh")}</Button>
        <Button type="primary" loading={saving} disabled={!hasRule} onClick={() => void handleSave()}>
          {t("common.save")}
        </Button>
        <Tooltip title={t("docFlow.tipNoExpr")}>
          <Tag color="orange">no expression</Tag>
        </Tooltip>
      </Space>

      <Splitter style={{ height: "calc(100vh - 190px)" }}>
        <Splitter.Panel defaultSize="28%" min="20%" max="45%">
          <Table<RuleRow>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={rules}
            columns={ruleColumns}
            pagination={false}
            onRow={(record) => ({
              onClick: () => void handleSelect(record),
              style: { cursor: "pointer", background: record.id === selectedId ? "rgba(0,0,0,0.04)" : undefined },
            })}
          />
        </Splitter.Panel>

        <Splitter.Panel>
          <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
            {!hasRule ? (
              <div style={{ padding: 40, textAlign: "center", color: "#888" }}>{t("docFlow.pickRule")}</div>
            ) : (
              <Tabs
                defaultActiveKey="basic"
                items={[
                  {
                    key: "basic",
                    label: t("docFlow.basicTab"),
                    children: (
                      <Form form={form} layout="vertical">
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item name="rule_code" label={t("docFlow.ruleCode")} rules={[{ required: true }]}>
                              <Input disabled={!isNew} />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="rule_name" label={t("docFlow.ruleName")} rules={[{ required: true }]}>
                              <Input />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="description" label={t("docFlow.description")}>
                              <Input />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item name="source_document_type" label={t("docFlow.sourceDoc")} rules={[{ required: true }]}>
                              <Select options={documentTypes} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="target_document_type" label={t("docFlow.targetDoc")} rules={[{ required: true }]}>
                              <Select options={documentTypes} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="target_initial_status" label={t("docFlow.initialStatus")}>
                              <Input />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item name="source_quantity_field" label={t("docFlow.sourceQtyField")} rules={[{ required: true }]}>
                              <Select options={sourceLineFields} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="target_quantity_field" label={t("docFlow.targetQtyField")} rules={[{ required: true }]}>
                              <Select options={targetLineFields} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item name="target_source_ref_field" label={t("docFlow.targetSourceRef")}>
                              <Select options={targetLineFields} showSearch allowClear />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Row gutter={16}>
                          <Col span={6}>
                            <Form.Item name="source_detail_key_field" label={t("docFlow.sourceDetailKey")} rules={[{ required: true }]}>
                              <Select options={sourceLineFields} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name="source_detail_parent_field" label={t("docFlow.sourceDetailParent")} rules={[{ required: true }]}>
                              <Select options={sourceLineFields} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name="target_no_field" label={t("docFlow.targetNoField")} rules={[{ required: true }]}>
                              <Select options={targetHeaderFields} showSearch />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name="target_detail_parent_field" label={t("docFlow.targetDetailParent")} rules={[{ required: true }]}>
                              <Select options={targetLineFields} showSearch />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Row gutter={16}>
                          <Col span={6}>
                            <Form.Item name="allow_partial" label={t("docFlow.allowPartial")} valuePropName="checked">
                              <Switch />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name="require_source_approved" label={t("docFlow.requireApproved")} valuePropName="checked">
                              <Switch />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name="is_active" label={t("docFlow.isActive")} valuePropName="checked">
                              <Switch />
                            </Form.Item>
                          </Col>
                        </Row>
                      </Form>
                    ),
                  },
                  {
                    key: "header",
                    label: t("docFlow.headerMapTab"),
                    children: targetDoc ? (
                      <MapEditor
                        rows={headerMaps}
                        targetOptions={targetHeaderFields}
                        sourceOptions={sourceHeaderFields}
                        onChange={setHeaderMaps}
                      />
                    ) : (
                      <div style={{ color: "#888" }}>{t("docFlow.pickTargetDoc")}</div>
                    ),
                  },
                  {
                    key: "line",
                    label: t("docFlow.lineMapTab"),
                    children: targetDoc ? (
                      <MapEditor
                        rows={lineMaps}
                        targetOptions={targetLineFields}
                        sourceOptions={sourceLineFields}
                        onChange={setLineMaps}
                      />
                    ) : (
                      <div style={{ color: "#888" }}>{t("docFlow.pickTargetDoc")}</div>
                    ),
                  },
                  {
                    key: "ledger",
                    label: t("docFlow.ledgerTab"),
                    children: (
                      <Table<TransferRow>
                        rowKey="id"
                        size="small"
                        dataSource={ledger}
                        columns={ledgerColumns}
                        pagination={{ pageSize: 10 }}
                      />
                    ),
                  },
                ]}
              />
            )}
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}
