import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
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
import { executeBaq, listBaqs, listTableLabels, loadCatalog, removeBaq, saveBaq, updateTableLabels } from "./api";
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
const aggregateOptions = ["none", "sum", "count", "avg", "min", "max"].map(
  (value) => ({
    value,
    label: value === "none" ? "不聚合" : value.toUpperCase(),
  }),
);
const operatorOptions = [
  { value: "eq", label: "等于" },
  { value: "neq", label: "不等于" },
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
  { value: "like", label: "包含" },
  { value: "is_null", label: "为空" },
  { value: "not_null", label: "不为空" },
];

export function BaqDesigner() {
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
      .catch((e) => message.error(`数据目录加载失败：${e.message}`));
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
  const tableOptions = catalog.map((t) => ({
    value: t.table,
    label: `${t.label}`,
  }));
  const columns = (alias: string) =>
    catalog.find(
      (t) => t.table === aliases.find((a) => a.alias === alias)?.table,
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
        status === "published" ? "已发布，可供页面设计器使用" : "草稿已保存",
      );
      return saved;
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
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
      message.error(e instanceof Error ? e.message : "执行失败");
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
      message.error(e instanceof Error ? e.message : "表名称加载失败");
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
      message.success(`已更新 ${changed.length} 个表名称`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "表名称保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="baq-page">
      <Card
        title={
          <Space>
            <Typography.Title level={4}>BAQ 设计管理</Typography.Title>
            <Tag color={baq.status === "published" ? "green" : "default"}>
              {baq.status === "published" ? "已发布" : "草稿"}
            </Tag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<DatabaseOutlined />} loading={busy} onClick={() => void openTableLabels()}>
              表名称维护
            </Button>
            <Select
              className="baq-picker"
              value={baq.id || "new"}
              options={[
                { value: "new", label: "新建 BAQ" },
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
                title="删除此 BAQ？"
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
              预览
            </Button>
            <Button
              icon={<SaveOutlined />}
              loading={busy}
              onClick={() => void save("draft")}
            >
              保存
            </Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={busy}
              onClick={() => void save("published")}
            >
              发布
            </Button>
          </Space>
        }
      >
        <Form layout="vertical">
          <div className="baq-meta">
            <Form.Item label="名称" required>
              <Input
                value={baq.name}
                onChange={(e) => setBaq({ ...baq, name: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="编码" required>
              <Input
                disabled={!!baq.id}
                value={baq.code}
                onChange={(e) => setBaq({ ...baq, code: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="描述">
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
              label: "数据源与关联",
              children: (
                <>
                  <div className="baq-source">
                    <Typography.Text strong>主表</Typography.Text>
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
                    <Tag>别名 t0</Tag>
                  </div>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.joins}
                    columns={[
                      {
                        title: "类型",
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
                        title: "关联表",
                        render: (_, r, i) => (
                          <Select
                            className="wide"
                            showSearch
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
                        title: "别名",
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
                        title: "左表",
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
                        title: "左字段",
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
                        title: "右字段",
                        width: 260,
                        render: (_, r, i) => (
                          <Select
                            className="join-field-select"
                            showSearch
                            value={r.rightField}
                            options={(
                              catalog.find((t) => t.table === r.table)
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
                    添加关联
                  </Button>
                </>
              ),
            },
            {
              key: "fields",
              label: `输出字段 (${baq.definition.fields.length})`,
              children: (
                <>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.fields}
                    columns={[
                      {
                        title: "表",
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
                        title: "字段",
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
                        title: "输出别名",
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
                        title: "聚合",
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
                        title: "分组",
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
                        title: "顺序",
                        width: 132,
                        render: (_, __, i) => (
                          <Space size={0}>
                            <Tooltip title="上移">
                              <Button
                                type="text"
                                icon={<ArrowUpOutlined />}
                                disabled={i === 0}
                                onClick={() => moveField(i, -1)}
                              />
                            </Tooltip>
                            <Tooltip title="下移">
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
                    添加字段
                  </Button>
                </>
              ),
            },
            {
              key: "filters",
              label: `筛选 (${baq.definition.filters.length})`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message="MVP 阶段筛选条件之间使用 AND 连接"
                  />
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.filters}
                    columns={[
                      {
                        title: "表",
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
                        title: "字段",
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
                        title: "条件",
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
                        title: "值",
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
                    添加条件
                  </Button>
                </>
              ),
            },
            {
              key: "sorts",
              label: `排序 (${baq.definition.sorts.length})`,
              children: (
                <>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="id"
                    dataSource={baq.definition.sorts}
                    columns={[
                      {
                        title: "输出字段",
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
                        title: "方向",
                        render: (_, r, i) => (
                          <Select
                            value={r.direction}
                            options={[
                              { value: "asc", label: "升序" },
                              { value: "desc", label: "降序" },
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
                    添加排序
                  </Button>
                </>
              ),
            },
          ]}
        />
      </Card>
      <Card
        title="结果预览"
        extra={
          result && (
            <Typography.Text type="secondary">
              共 {result.total} 行，最多显示 100 行
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
          <Empty description="保存并预览 BAQ 查看结果" />
        )}
      </Card>
      <Modal
        title="表名称维护"
        open={tableLabelOpen}
        width={860}
        confirmLoading={busy}
        okText="保存修改"
        cancelText="取消"
        onOk={() => void saveTableLabels()}
        onCancel={() => setTableLabelOpen(false)}
      >
        <Input.Search
          allowClear
          placeholder="搜索真实表名或显示名称"
          value={tableLabelSearch}
          onChange={(event) => setTableLabelSearch(event.target.value)}
          style={{ marginBottom: 12 }}
        />
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
              title: "模块",
              dataIndex: "module_name",
              width: 100,
              render: (value) => <Tag>{value}</Tag>,
            },
            {
              title: "数据库表名",
              dataIndex: "table_name",
              width: 330,
              ellipsis: true,
            },
            {
              title: "显示名称",
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
