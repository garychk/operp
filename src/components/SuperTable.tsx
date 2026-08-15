import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Drawer, Input, Select, Space, Switch, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ReloadOutlined,
  SettingOutlined,
  LockOutlined,
  UnlockOutlined,
  LayoutOutlined,
  DeleteOutlined,
  DownloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns, ProTableProps } from "@ant-design/pro-components";
import { useTranslation } from "react-i18next";

export type SuperTableColumn<RecordType> = ColumnsType<RecordType>[number] & {
  key: string;
  defaultHidden?: boolean;
  defaultFixed?: "left" | "right" | false;
  lockWidth?: boolean;
};

export interface SuperTableProps<
  RecordType extends object,
  Query extends Record<string, any> = Record<string, any>,
> extends Omit<ProTableProps<RecordType, Query>, "columns"> {
  columns: SuperTableColumn<RecordType>[];
  storageKey: string;
  tableName?: string;
  queryBar?: ReactNode;
  onResetColumns?: () => void;
  toolbarActions?: ("delete" | "export" | "import")[];
}

interface ColumnSettingsState {
  order: string[];
  hidden: Record<string, boolean>;
  fixed: Record<string, "left" | "right" | false>;
  width: Record<string, number | undefined>;
}

function moveItem<T>(items: T[], from: number, to: number) {
  if (from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function buildInitialSettings<RecordType>(columns: SuperTableColumn<RecordType>[]): ColumnSettingsState {
  return {
    order: columns.map((item) => item.key),
    hidden: Object.fromEntries(columns.filter((item) => item.defaultHidden).map((item) => [item.key, true])),
    fixed: Object.fromEntries(columns.filter((item) => item.defaultFixed !== undefined).map((item) => [item.key, item.defaultFixed as "left" | "right" | false])),
    width: Object.fromEntries(columns.filter((item) => typeof item.width === "number").map((item) => [item.key, item.width as number])),
  };
}

export function SuperTable<
  RecordType extends object,
  Query extends Record<string, any> = Record<string, any>,
>({
  columns,
  storageKey,
  queryBar,
  onResetColumns,
  toolbarActions = ["delete", "export", "import"],
  actionRef,
  toolBarRender,
  cardProps,
  headerTitle,
  rowSelection,
  ...rest
}: SuperTableProps<RecordType, Query>) {
  const { t } = useTranslation();
  const internalActionRef = useRef<ActionType | undefined>(undefined);
  const mergedActionRef = actionRef ?? internalActionRef;
    const mergedCardProps =
    cardProps === false
      ? false
      : {
          ...cardProps,
          styles: {
            ...cardProps?.styles,
            body: {
              paddingInline: 0,
              paddingBlock: 0,
              marginTop: -14,
              ...cardProps?.styles?.body,
            },
          },
        };
const storageColumns = `${storageKey}:columns`;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draggedColumnKey, setDraggedColumnKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<ColumnSettingsState>(() => buildInitialSettings(columns));

  useEffect(() => {
    const raw = localStorage.getItem(storageColumns);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<ColumnSettingsState>;
      setSettings((current) => ({
        order: Array.isArray(parsed.order) && parsed.order.length ? parsed.order : current.order,
        hidden: parsed.hidden ?? current.hidden,
        fixed: parsed.fixed ?? current.fixed,
        width: parsed.width ?? current.width,
      }));
    } catch {
      // ignore invalid cache
    }
  }, [storageColumns]);

  useEffect(() => {
    localStorage.setItem(storageColumns, JSON.stringify(settings));
  }, [settings, storageColumns]);

  const filteredColumns = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return columns.filter((column) => {
      if (!keyword) return true;
      const titleText = typeof column.title === "string" ? column.title : String(column.key);
      return titleText.toLowerCase().includes(keyword) || column.key.toLowerCase().includes(keyword);
    });
  }, [columns, search]);

  const orderedColumns = useMemo(() => {
    const byKey = new Map(filteredColumns.map((item) => [item.key, item]));
    const ordered: SuperTableColumn<RecordType>[] = [];
    settings.order.forEach((key) => {
      const column = byKey.get(key);
      if (column) ordered.push(column);
    });
    filteredColumns.forEach((column) => {
      if (!settings.order.includes(column.key)) ordered.push(column);
    });
    return ordered.filter((column) => !settings.hidden[column.key]);
  }, [filteredColumns, settings.hidden, settings.order]);

  const visibleColumns = useMemo(() => {
    return orderedColumns.map((column) => {
      const width = settings.width[column.key] ?? column.width;
      return {
        ...column,
        fixed: settings.fixed[column.key] ?? column.fixed,
        width,
        title: (
          <div style={{ display: "flex", alignItems: "stretch", minHeight: 22 }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {column.title as ReactNode}
            </span>
            {!column.lockWidth && (
              <span
                aria-label={t('superTable.resizeColumn', { name: String(column.title) })}
                role="separator"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const startX = event.clientX;
                  const startWidth = typeof width === "number" ? width : 160;
                  const resize = (moveEvent: MouseEvent) => {
                    setSettings((current) => ({
                      ...current,
                      width: {
                        ...current.width,
                        [column.key]: Math.max(72, startWidth + moveEvent.clientX - startX),
                      },
                    }));
                  };
                  const stopResize = () => {
                    window.removeEventListener("mousemove", resize);
                    window.removeEventListener("mouseup", stopResize);
                  };
                  window.addEventListener("mousemove", resize);
                  window.addEventListener("mouseup", stopResize);
                }}
                style={{
                  width: 10,
                  cursor: "col-resize",
                  marginRight: -8,
                  borderRight: "2px solid transparent",
                }}
              />
            )}
          </div>
        ),
      } as unknown as ProColumns<RecordType>;
    });
  }, [orderedColumns, settings.fixed, settings.width]);

  const resetColumns = () => {
    setSettings(buildInitialSettings(columns));
    onResetColumns?.();
    internalActionRef.current?.reload();
  };

  const settingsRows = useMemo(
    () =>
      columns.map((column) => {
        const position = settings.order.indexOf(column.key);
        const isVisible = !settings.hidden[column.key];
        const fixedValue = settings.fixed[column.key] ?? column.fixed ?? false;
        const widthValue = settings.width[column.key] ?? column.width;
        return (
          <div
            key={column.key}
            draggable
            onDragStart={() => setDraggedColumnKey(column.key)}
            onDragOver={(event) => event.preventDefault()}
            onDragEnd={() => setDraggedColumnKey(null)}
            onDrop={() => {
              if (!draggedColumnKey || draggedColumnKey === column.key) return;
              setSettings((current) => {
                const from = current.order.indexOf(draggedColumnKey);
                const to = current.order.indexOf(column.key);
                if (from < 0 || to < 0) return current;
                return { ...current, order: moveItem(current.order, from, to) };
              });
              setDraggedColumnKey(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderBottom: "1px solid rgba(0,0,0,0.06)",
              cursor: "grab",
              opacity: draggedColumnKey === column.key ? 0.45 : 1,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text strong>{column.title as ReactNode}</Typography.Text>
              <div style={{ color: "#8c8c8c", fontSize: 12 }}>{column.key}</div>
            </div>
            <Space wrap>
              <Switch
                checked={isVisible}
                checkedChildren={t('superTable.show')}
                unCheckedChildren={t('superTable.hide')}
                onChange={(checked) =>
                  setSettings((current) => ({
                    ...current,
                    hidden: { ...current.hidden, [column.key]: !checked },
                  }))
                }
              />
              <Select
                value={fixedValue}
                style={{ width: 92 }}
                options={[
                  { value: false, label: t('superTable.unfixed') },
                  { value: "left", label: t('superTable.fixedLeft') },
                  { value: "right", label: t('superTable.fixedRight') },
                ]}
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    fixed: { ...current.fixed, [column.key]: value },
                  }))
                }
              />
              <Input
                value={widthValue}
                disabled={column.lockWidth}
                style={{ width: 94 }}
                addonBefore={t('superTable.width')}
                onChange={(event) => {
                  const nextWidth = Number(event.target.value);
                  if (Number.isNaN(nextWidth)) return;
                  setSettings((current) => ({
                    ...current,
                    width: { ...current.width, [column.key]: nextWidth },
                  }));
                }}
              />
              <Button
                icon={<ArrowUpOutlined />}
                disabled={position <= 0}
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    order: moveItem(current.order, position, position - 1),
                  }))
                }
              />
              <Button
                icon={<ArrowDownOutlined />}
                disabled={position < 0 || position >= settings.order.length - 1}
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    order: moveItem(current.order, position, position + 1),
                  }))
                }
              />
              <Button
                icon={column.lockWidth ? <LockOutlined /> : <UnlockOutlined />}
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    width: { ...current.width, [column.key]: current.width[column.key] ?? (typeof widthValue === "number" ? widthValue : undefined) },
                  }))
                }
              />
            </Space>
          </div>
        );
      }),
    [columns, draggedColumnKey, settings.fixed, settings.hidden, settings.order, settings.width],
  );

  function deleteRows(): void {
    console.log("deleteRows");
  }
  const exportData = () => {
    console.log("exportData");
  };
  const importData = () => {
    console.log("importData");
  };

  return (
    <>
      <ProTable<RecordType, Query>
        actionRef={mergedActionRef}
        columns={visibleColumns}
        options={false}
        search={false}        
        cardProps={mergedCardProps}
        headerTitle={
          headerTitle ? (
            <Space style={{ marginLeft: 8 }}><LayoutOutlined />{headerTitle}</Space>
          ) : undefined
        }
        rowSelection={
          rowSelection
            ? {
                columnWidth: 48,
                ...rowSelection,
              }
            : undefined
        }
        pagination={{ pageSize: 10, ...rest.pagination }}
        scroll={{ x: "max-content", ...(typeof rest.scroll === "object" ? rest.scroll : {}) }}
        toolBarRender={() => [
          queryBar ? <div key="query-bar">{queryBar}</div> : null,
          toolbarActions.includes("delete") ? (
            <Button key="delete" danger ghost icon={<DeleteOutlined />} onClick={deleteRows}>
              {t('superTable.delete')}
            </Button>
          ) : null,
          toolbarActions.includes("export") ? (
            <Button key="export" icon={<UploadOutlined />} onClick={exportData}>
              {t('superTable.export')}
            </Button>
          ) : null,
          toolbarActions.includes("import") ? (
            <Button key="import" icon={<DownloadOutlined />} onClick={importData}>
              {t('superTable.import')}
            </Button>
          ) : null,
          <Button key="settings" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}></Button>,
          ...(toolBarRender ? toolBarRender(undefined as never, {}) : []),
        ]}
        {...rest}
      />
      <Drawer
        open={settingsOpen}
        size={560}
        title={t('superTable.columnSettings')}
        onClose={() => setSettingsOpen(false)}
      >
        <Typography.Paragraph type="secondary">
          {t('superTable.columnSettingsDesc')}
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12 }}>
          <Button key="reset" icon={<ReloadOutlined />} onClick={resetColumns}>
            {t('superTable.resetColumns')}
          </Button>
          <Input.Search
            allowClear
            placeholder={t('superTable.searchColumns')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}            
          />
        </Space>
        
        {settingsRows}
      </Drawer>
    </>
  );
}
