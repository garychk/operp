import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Tooltip,
} from "antd";
import { executeBaq, listBaqs, listTableLabels, loadCatalog, refreshSysTables, removeBaq, saveBaq, updateTableLabels } from "./api";
import type { TableLabelRow } from "./api";
import { emptyBaq } from "./types";
import type {
  Aggregate,
  BaqDefinition,
  BaqQuery,
  BaqResult,
  BaqTable,
  FilterOperator,
} from "./types";
import "./baq.css";

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export function BaqDesigner() {
  const { t } = useTranslation();
  const aggregateOptions = ["none", "sum", "count", "avg", "min", "max"].map(
    (value) => ({
      value,
      label:
        value === "none" ? t('baqDesigner.noAggregate') : value.toUpperCase(),
    }),
  );
  const operatorOptions = [
    { value: "eq", label: t('baqDesigner.equals') },
    { value: "neq", label: t('baqDesigner.notEquals') },
    { value: "gt", label: t('baqDesigner.greaterThan') },
    { value: "gte", label: t('baqDesigner.greaterThanOrEqual') },
    { value: "lt", label: t('baqDesigner.lessThan') },
    { value: "lte", label: t('baqDesigner.lessThanOrEqual') },
    { value: "like", label: t('baqDesigner.contains') },
    { value: "is_null", label: t('baqDesigner.isEmpty') },
    { value: "not_null", label: t('baqDesigner.isNotEmpty') },
  ];
  const [items, setItems] = useState<BaqQuery[]>([]);
  const [catalog, setCatalog] = useState<BaqTable[]>([]);
  const [baq, setBaq] = useState<BaqQuery>(emptyBaq);
  const [result, setResult] = useState<BaqResult>();
  const [busy, setBusy] = useState(false);
  const [tableLabelOpen, setTableLabelOpen] = useState(false);
  const [tableLabels, setTableLabels] = useState<TableLabelRow[]>([]);
  const [originalLabels, setOriginalLabels] = useState<Record<number, string>>({});
  const [tableLabelSearch, setTableLabelSearch] = useState("");
  const refresh = () =>
    listBaqs()
      .then(setItems)
      .catch((e) => message.error(e.message));
  useEffect(() => {
    void refresh();
    loadCatalog()
      .then(setCatalog)
      .catch((e) =>
        message.error(
          t('baqDesigner.catalogLoadFailed', { message: e.message }),
        ),
      );
  }, []);
  const aliases = useMemo(
    () => [
      {
        alias: baq.definition.source.alias,
        table: baq.definition.source.table,
      },
      ...baq.definition.joins.map((j) => ({ alias: j.alias, table: j.table })),
    ],
    [baq.definition],
  );
  const tableOptions = catalog.map((x) => ({
    value: x.table,
    label: `${x.label}`,
  }));
  const columns = (alias: string) =>
    catalog.find(
      (x) => x.table === aliases.find((a) => a.alias === alias)?.table,
    )?.columns || [];
  const patchDef = (patch: Partial<BaqDefinition>) =>
    setBaq((current) => ({
      ...current,
      definition: { ...current.definition, ...patch },
    }));
  const save = async (status = baq.status) => {
    setBusy(true);
    try {
      const saved = await saveBaq({ ...baq, status });
      setBaq(saved);
      await refresh();
      message.success(
        status === "published"
          ? t('baqDesigner.publishedReady')
          : t('baqDesigner.draftSaved'),
      );
      return saved;
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      setResult(await executeBaq(saved.code));
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('baqDesigner.executeFailed'));
    } finally {
      setBusy(false);
    }
  };
  const rowActions = (
    kind: "joins" | "fields" | "filters" | "sorts",
    index: number,
  ) => (
    <Button
      danger
      type="text"
      icon={<DeleteOutlined />}
      onClick={() =>
        patchDef({ [kind]: baq.definition[kind].filter((_, i) => i !== index) })
      }
    />
  );
  const moveField = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= baq.definition.fields.length) return;
    const fields = [...baq.definition.fields];
    [fields[index], fields[target]] = [fields[target], fields[index]];
    patchDef({ fields });
  };
  const openTableLabels = async () => {
    setBusy(true);
    try {
      const rows = await listTableLabels();
      setTableLabels(rows);
      setOriginalLabels(Object.fromEntries(rows.map(row => [row.id, row.table_label])));
      setTableLabelOpen(true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('baqDesigner.tableLabelsLoadFailed'));
    } finally {
      setBusy(false);
    }
  };
  const saveTableLabels = async () => {
    const changed = tableLabels.filter(row => row.table_label.trim() && row.table_label !== originalLabels[row.id]);
    if (!changed.length) { setTableLabelOpen(false); return; }
    setBusy(true);
    try {
      await updateTableLabels(changed.map(({ id, table_label }) => ({ id, table_label: table_label.trim() })));
      setCatalog(await loadCatalog());
      setTableLabelOpen(false);
      message.success(
        t('baqDesigner.tableLabelsUpdated', { count: changed.length }),
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('baqDesigner.tableLabelsSaveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const refreshTableList = async () => {
    setBusy(true);
    try {
      await refreshSysTables();
      const rows = await listTableLabels();
      setTableLabels(rows);
      setOriginalLabels(Object.fromEntries(rows.map(row => [row.id, row.table_label])));
      message.success(t('baqDesigner.sysTablesRefreshed'));
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('baqDesigner.sysTablesRefreshFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='mainContent'>
      <Card
        variant="borderless"
        title={
          <Space>
            <Typography.Title level={4}>
              {t('baqDesigner.pageTitle')}
            </Typography.Title>
            <Tag color={baq.status === "published" ? "green" : "default"}>
              {baq.status === "published"
                ? t('baqDesigner.published')
                : t('baqDesigner.draft')}
            </Tag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<DatabaseOutlined />} loading={busy} onClick={() => void openTableLabels()}>
              {t('baqDesigner.tableLabelsMaintenance')}
            </Button>
            <Select
              className="baq-picker"
              value={baq.id || "new"}
              options={[
                { value: "new", label: t('baqDesigner.newBaq') },
                ...items.map((x) => ({ value: x.id!, label: x.name })),
              ]}
              onChange={(v) => {
                setBaq(
                  v === "new"
                    ? emptyBaq()
                    : items.find((x) => x.id === v) || emptyBaq(),
                );
                setResult(undefined);
              }}
            />
            {baq.id && (
              <Popconfirm
                title={t('baqDesigner.deleteConfirm')}
                onConfirm={async () => {
                  await removeBaq(baq.id!);
                  setBaq(emptyBaq());
                  void refresh();
                }}
              >
                <Button danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
            <Button icon={<EyeOutlined />} loading={busy} onClick={preview}>
              {t('baqDesigner.preview')}
            </Button>
            <Button
              icon={<SaveOutlined />}
              loading={busy}
              onClick={() => void save("draft")}
            >
              {t('common.save')}
            </Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={busy}
              onClick={() => void save("published")}
            >
              {t('baqDesigner.publish')}
            </Button>
          </Space>
        }
      >
        <Form layout="vertical">
          <div className="baq-meta">
            <Form.Item label={t('common.name')} required>
              <Input
                value={baq.name}
                onChange={(e) => setBaq({ ...baq, name: e.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('common.code')} required>
              <Input
                disabled={!!baq.id}
                value={baq.code}
                onChange={(e) => setBaq({ ...baq, code: e.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('baqDesigner.description')}>
              <Input
                value={baq.description || ""}
                onChange={(e) =>
                  setBaq({ ...baq, description: e.target.value })
                }
              />
            </Form.Item>
          </div>
        </Form>
        <Tabs
          items={[
            {
              key: "source",
              label: t('baqDesigner.sourceTab'),
              children: (
                <>
                  <div className="baq-source">
                    <Typography.Text strong>{t('baqDesigner.mainTable')}</Typography.Text>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      value={baq.definition.source.table || undefined}
                      options={tableOptions}
                      onChange={(table) =>
                        patchDef({
                          source: { table, alias: "t0" },
                          joins: [],
                          fields: [],
                          filters: [],
                          sorts: [],
                        })
                      }
                    />
                    <Tag>{t('baqDesigner.alias')} t0</Tag>
                  </div>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.joins}
                    columns={[
                      {
                        title: t('common.type'),
                        render: (_, r, i) => (
                          <Select
                            value={r.type}
                            options={[
                              { value: "inner", label: "INNER JOIN" },
                              { value: "left", label: "LEFT JOIN" },
                            ]}
                            onChange={(type) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, type } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.joinTable'),
                        render: (_, r, i) => (
                          <Select
                            className="wide"
                            showSearch
                            style={{ width: 260 }}
                            optionFilterProp="label"
                            value={r.table}
                            options={tableOptions}
                            onChange={(table) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, table } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.alias'),
                        render: (_, r, i) => (
                          <Input
                            value={r.alias}
                            onChange={(e) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, alias: e.target.value } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.leftTable'),
                        render: (_, r, i) => (
                          <Select
                            value={r.leftAlias}
                            options={aliases
                              .slice(0, i + 1)
                              .map((a) => ({ value: a.alias, label: a.alias }))}
                            onChange={(leftAlias) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, leftAlias } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.leftField'),
                        width: 260,
                        render: (_, r, i) => (
                          <Select
                            className="join-field-select"
                            showSearch
                            value={r.leftField}
                            options={columns(r.leftAlias).map((c) => ({
                              value: c.name,
                              label: c.name,
                            }))}
                            style={{ width: 260 }}
                            onChange={(leftField) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, leftField } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.rightField'),
                        width: 260,
                        render: (_, r, i) => (
                          <Select
                            className="join-field-select"
                            showSearch
                            value={r.rightField}
                            style={{ width: 260 }}
                            options={(
                              catalog.find((x) => x.table === r.table)
                                ?.columns || []
                            ).map((c) => ({ value: c.name, label: c.name }))}
                            onChange={(rightField) =>
                              patchDef({
                                joins: baq.definition.joins.map((x, n) =>
                                  n === i ? { ...x, rightField } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: "",
                        render: (_, __, i) => rowActions("joins", i),
                      },
                    ]}
                  />
                  <Button
                    className="add-row"
                    icon={<PlusOutlined />}
                    disabled={!baq.definition.source.table}
                    onClick={() =>
                      patchDef({
                        joins: [
                          ...baq.definition.joins,
                          {
                            id: uid(),
                            type: "left",
                            table: "",
                            alias: `t${baq.definition.joins.length + 1}`,
                            leftAlias: "t0",
                            leftField: "id",
                            rightField: "id",
                          },
                        ],
                      })
                    }
                  >
                    {t('baqDesigner.addJoin')}
                  </Button>
                </>
              ),
            },
            {
              key: "fields",
              label: t('baqDesigner.outputFieldsTab', {
                count: baq.definition.fields.length,
              }),
              children: (
                <>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.fields}
                    columns={[
                      {
                        title: t('baqDesigner.tableCol'),
                        render: (_, r, i) => (
                          <Select
                            value={r.tableAlias}
                            options={aliases.map((a) => ({
                              value: a.alias,
                              label: a.alias,
                            }))}
                            onChange={(tableAlias) =>
                              patchDef({
                                fields: baq.definition.fields.map((x, n) =>
                                  n === i ? { ...x, tableAlias, field: "" } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.fieldCol'),
                        render: (_, r, i) => (
                          <Select
                            className="wide"
                            showSearch
                            value={r.field}
                            options={columns(r.tableAlias).map((c) => ({
                              value: c.name,
                              label: `${c.name} · ${c.type}`,
                            }))}
                            onChange={(field) =>
                              patchDef({
                                fields: baq.definition.fields.map((x, n) =>
                                  n === i ? { ...x, field, alias: field } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.outputAlias'),
                        render: (_, r, i) => (
                          <Input
                            value={r.alias}
                            onChange={(e) =>
                              patchDef({
                                fields: baq.definition.fields.map((x, n) =>
                                  n === i ? { ...x, alias: e.target.value } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.aggregate'),
                        render: (_, r, i) => (
                          <Select
                            value={r.aggregate}
                            options={aggregateOptions}
                            onChange={(aggregate: Aggregate) =>
                              patchDef({
                                fields: baq.definition.fields.map((x, n) =>
                                  n === i ? { ...x, aggregate } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.groupBy'),
                        render: (_, r, i) => (
                          <Switch
                            checked={r.groupBy}
                            onChange={(groupBy) =>
                              patchDef({
                                fields: baq.definition.fields.map((x, n) =>
                                  n === i ? { ...x, groupBy } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.order'),
                        width: 132,
                        render: (_, __, i) => (
                          <Space size={0}>
                            <Tooltip title={t('baqDesigner.moveUp')}>
                              <Button
                                type="text"
                                icon={<ArrowUpOutlined />}
                                disabled={i === 0}
                                onClick={() => moveField(i, -1)}
                              />
                            </Tooltip>
                            <Tooltip title={t('baqDesigner.moveDown')}>
                              <Button
                                type="text"
                                icon={<ArrowDownOutlined />}
                                disabled={i === baq.definition.fields.length - 1}
                                onClick={() => moveField(i, 1)}
                              />
                            </Tooltip>
                            {rowActions("fields", i)}
                          </Space>
                        ),
                      },
                    ]}
                  />
                  <Button
                    className="add-row"
                    icon={<PlusOutlined />}
                    disabled={!aliases[0].table}
                    onClick={() =>
                      patchDef({
                        fields: [
                          ...baq.definition.fields,
                          {
                            id: uid(),
                            tableAlias: "t0",
                            field: "",
                            alias: "",
                            aggregate: "none",
                            groupBy: false,
                          },
                        ],
                      })
                    }
                  >
                    {t('baqDesigner.addField')}
                  </Button>
                </>
              ),
            },
            {
              key: "filters",
              label: t('baqDesigner.filtersTab', {
                count: baq.definition.filters.length,
              }),
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message={t('baqDesigner.filtersMvpNote')}
                  />
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.filters}
                    columns={[
                      {
                        title: t('baqDesigner.tableCol'),
                        render: (_, r, i) => (
                          <Select
                            value={r.tableAlias}
                            options={aliases.map((a) => ({
                              value: a.alias,
                              label: a.alias,
                            }))}
                            onChange={(tableAlias) =>
                              patchDef({
                                filters: baq.definition.filters.map((x, n) =>
                                  n === i ? { ...x, tableAlias, field: "" } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.fieldCol'),
                        render: (_, r, i) => (
                          <Select
                            className="wide"
                            showSearch
                            value={r.field}
                            options={columns(r.tableAlias).map((c) => ({
                              value: c.name,
                              label: c.name,
                            }))}
                            onChange={(field) =>
                              patchDef({
                                filters: baq.definition.filters.map((x, n) =>
                                  n === i ? { ...x, field } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.condition'),
                        render: (_, r, i) => (
                          <Select
                            value={r.operator}
                            options={operatorOptions}
                            onChange={(operator: FilterOperator) =>
                              patchDef({
                                filters: baq.definition.filters.map((x, n) =>
                                  n === i ? { ...x, operator } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.value'),
                        render: (_, r, i) => (
                          <Input
                            disabled={["is_null", "not_null"].includes(
                              r.operator,
                            )}
                            value={r.value}
                            onChange={(e) =>
                              patchDef({
                                filters: baq.definition.filters.map((x, n) =>
                                  n === i ? { ...x, value: e.target.value } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: "",
                        render: (_, __, i) => rowActions("filters", i),
                      },
                    ]}
                  />
                  <Button
                    className="add-row"
                    icon={<PlusOutlined />}
                    onClick={() =>
                      patchDef({
                        filters: [
                          ...baq.definition.filters,
                          {
                            id: uid(),
                            tableAlias: "t0",
                            field: "",
                            operator: "eq",
                            value: "",
                          },
                        ],
                      })
                    }
                  >
                    {t('baqDesigner.addCondition')}
                  </Button>
                </>
              ),
            },
            {
              key: "sorts",
              label: t('baqDesigner.sortsTab', {
                count: baq.definition.sorts.length,
              }),
              children: (
                <>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.sorts}
                    columns={[
                      {
                        title: t('baqDesigner.outputFieldCol'),
                        render: (_, r, i) => (
                          <Select
                            className="wide"
                            value={r.fieldAlias}
                            options={baq.definition.fields
                              .filter((f) => f.alias)
                              .map((f) => ({ value: f.alias, label: f.alias }))}
                            onChange={(fieldAlias) =>
                              patchDef({
                                sorts: baq.definition.sorts.map((x, n) =>
                                  n === i ? { ...x, fieldAlias } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: t('baqDesigner.direction'),
                        render: (_, r, i) => (
                          <Select
                            value={r.direction}
                            options={[
                              { value: "asc", label: t('baqDesigner.ascending') },
                              { value: "desc", label: t('baqDesigner.descending') },
                            ]}
                            onChange={(direction) =>
                              patchDef({
                                sorts: baq.definition.sorts.map((x, n) =>
                                  n === i ? { ...x, direction } : x,
                                ),
                              })
                            }
                          />
                        ),
                      },
                      {
                        title: "",
                        render: (_, __, i) => rowActions("sorts", i),
                      },
                    ]}
                  />
                  <Button
                    className="add-row"
                    icon={<PlusOutlined />}
                    onClick={() =>
                      patchDef({
                        sorts: [
                          ...baq.definition.sorts,
                          { id: uid(), fieldAlias: "", direction: "asc" },
                        ],
                      })
                    }
                  >
                    {t('baqDesigner.addSort')}
                  </Button>
                </>
              ),
            },
          ]}
        />
      </Card>
      <Card
        title={t('baqDesigner.resultPreview')}
        extra={
          result && (
            <Typography.Text type="secondary">
              {t('baqDesigner.resultSummary', { total: result.total })}
            </Typography.Text>
          )
        }
      >
        {result ? (
          <Table
            className="baq-result-table"
            size="small"
            rowKey={(_, i) => String(i)}
            scroll={{
              x: Math.max(baq.definition.fields.length * 180, 900),
              y: 420,
            }}
            dataSource={result.rows}
            columns={baq.definition.fields.map((field) => ({
              title: field.alias || field.field,
              dataIndex: field.alias || field.field,
              key: field.id,
              width: 180,
              ellipsis: true,
            }))}
            pagination={false}
          />
        ) : (
          <Empty description={t('baqDesigner.emptyPreviewHint')} />
        )}
      </Card>
      <Modal
        title={t('baqDesigner.tableLabelsMaintenance')}
        open={tableLabelOpen}
        width={860}
        confirmLoading={busy}
        okText={t('baqDesigner.saveChanges')}
        cancelText={t('common.cancel')}
        onOk={() => void saveTableLabels()}
        onCancel={() => setTableLabelOpen(false)}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder={t('baqDesigner.tableLabelSearchPlaceholder')}
            value={tableLabelSearch}
            onChange={(event) => setTableLabelSearch(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button icon={<ReloadOutlined />} loading={busy} onClick={() => void refreshTableList()}>
            {t('baqDesigner.refreshTableList')}
          </Button>
        </div>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ y: 480 }}
          dataSource={tableLabels.filter((row) => {
            const keyword = tableLabelSearch.trim().toLowerCase();
            return !keyword || row.table_name.toLowerCase().includes(keyword) || row.table_label.toLowerCase().includes(keyword);
          })}
          columns={[
            {
              title: t('baqDesigner.moduleCol'),
              dataIndex: "module_name",
              width: 100,
              render: (value) => <Tag>{value}</Tag>,
            },
            {
              title: t('baqDesigner.dbTableName'),
              dataIndex: "table_name",
              width: 330,
              ellipsis: true,
            },
            {
              title: t('baqDesigner.displayName'),
              dataIndex: "table_label",
              render: (_, row) => (
                <Input
                  value={row.table_label}
                  status={row.table_label.trim() ? undefined : "error"}
                  onChange={(event) => setTableLabels(current => current.map(item => item.id === row.id ? { ...item, table_label: event.target.value } : item))}
                />
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
