import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertOutlined,
  AppstoreAddOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DotChartOutlined,
  EyeOutlined,
  InteractionOutlined,
  MinusOutlined,
  LineChartOutlined,
  OrderedListOutlined,
  PieChartOutlined,
  PlusOutlined,
  RetweetOutlined,
  SaveOutlined,
  SendOutlined,
  SoundOutlined,
  TableOutlined,
  TagsOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Typography,
} from "antd";
import type { Layout } from "react-grid-layout";
import { deleteCustomPage, listCustomPages, publishCustomPage, saveCustomPage } from "./api";
import { PageCanvas } from "./PageRenderer";
import type { CustomPage, PageWidget, WidgetType } from "./types";
import { createWidgetDefaults } from "./types";
import "./page-builder.css";
import { listBaqs } from "../baq/api";
import type { BaqQuery } from "../baq/types";

const emptyPage = (): CustomPage => ({
  name: "未命名页面",
  slug: `page-${Date.now()}`,
  description: "",
  status: "draft",
  config: { widgets: [] },
});

export function PageDesigner() {
  const { t } = useTranslation();
  const palette: Array<{
    type: WidgetType;
    label: string;
    icon: React.ReactNode;
  }> = [
    { type: "text", label: t("pageDesigner.widgetText"), icon: <AppstoreAddOutlined /> },
    { type: "statistic", label: t("pageDesigner.widgetStatistic"), icon: <AppstoreAddOutlined /> },
    { type: "button", label: t("pageDesigner.widgetButton"), icon: <AppstoreAddOutlined /> },
    { type: "table", label: t("pageDesigner.widgetTable"), icon: <TableOutlined /> },
    { type: "line", label: t("pageDesigner.widgetLine"), icon: <LineChartOutlined /> },
    { type: "column", label: t("pageDesigner.widgetColumn"), icon: <BarChartOutlined /> },
    { type: "pie", label: t("pageDesigner.widgetPie"), icon: <PieChartOutlined /> },
    { type: "divider", label: t("pageDesigner.widgetDivider"), icon: <MinusOutlined /> },
    { type: "progressRing", label: t("pageDesigner.widgetProgressRing"), icon: <CheckCircleOutlined /> },
    { type: "gauge", label: t("pageDesigner.widgetGauge"), icon: <DashboardOutlined /> },
    { type: "scatter", label: t("pageDesigner.widgetScatter"), icon: <DotChartOutlined /> },
    { type: "linkage", label: t("pageDesigner.widgetLinkage"), icon: <InteractionOutlined /> },
    { type: "ranking", label: t("pageDesigner.widgetRanking"), icon: <OrderedListOutlined /> },
    { type: "carouselTable", label: t("pageDesigner.widgetCarouselTable"), icon: <RetweetOutlined /> },
    { type: "liveStream", label: t("pageDesigner.widgetLiveStream"), icon: <ThunderboltOutlined /> },
    { type: "marquee", label: t("pageDesigner.widgetMarquee"), icon: <SoundOutlined /> },
    { type: "alertBanner", label: t("pageDesigner.widgetAlertBanner"), icon: <AlertOutlined /> },
    { type: "statusTag", label: t("pageDesigner.widgetStatusTag"), icon: <TagsOutlined /> },
    { type: "clock", label: t("pageDesigner.widgetClock"), icon: <ClockCircleOutlined /> },
  ];

  const defaults = useMemo(() => createWidgetDefaults(t), [t]);

  const [pages, setPages] = useState<CustomPage[]>([]);
  const [page, setPage] = useState<CustomPage>(emptyPage);
  const [selectedId, setSelectedId] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baqs, setBaqs] = useState<BaqQuery[]>([]);
  const selected = useMemo(
    () => page.config.widgets.find((item) => item.id === selectedId),
    [page, selectedId],
  );

  const refresh = () =>
    listCustomPages()
      .then(setPages)
      .catch(() => message.error(t("pageDesigner.pagesLoadFailed")));
  useEffect(() => {
    void refresh();
    listBaqs(true).then(setBaqs).catch(() => undefined);
  }, []);

  const patchWidget = (patch: Partial<PageWidget>) =>
    setPage((current) => ({
      ...current,
      config: {
        widgets: current.config.widgets.map((item) =>
          item.id === selectedId ? { ...item, ...patch } : item,
        ),
      },
    }));
  const addWidget = (type: WidgetType) => {
    const widget: PageWidget = {
      ...defaults[type],
      id: `${type}-${Date.now()}`,
      type,
      x: 0,
      y: Infinity,
    };
    setPage((current) => ({
      ...current,
      config: { widgets: [...current.config.widgets, widget] },
    }));
    setSelectedId(widget.id);
  };
  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveCustomPage(page);
      setPage(saved);
      message.success(t("pageDesigner.draftSaved"));
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const publish = async (
    values: Pick<CustomPage, "name" | "slug" | "description">,
  ) => {
    setSaving(true);
    try {
      const saved = await publishCustomPage({ ...page, ...values });
      setPage(saved);
      setPublishOpen(false);
      message.success(t("pageDesigner.publishSuccess"));
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("pageDesigner.publishFailed"));
    } finally {
      setSaving(false);
    }
  };
  const handleDeletePage = async () => {
    if (!page.id) return;
    try {
      const result = await deleteCustomPage(page);
      if (!result.ok && result.referenced) {
        message.error(
          t("pageDesigner.deletePageReferenced", { menu: result.menuName || "" }),
        );
        return;
      }
      message.success(t("pageDesigner.deletePageSuccess"));
      setPage(emptyPage());
      setSelectedId(undefined);
      refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.saveFailed"));
    }
  };
  const updateLayout = (layout: Layout[]) =>
    setPage((current) => ({
      ...current,
      config: {
        widgets: current.config.widgets.map((widget) => {
          const item = layout.find((entry) => entry.i === widget.id);
          return item
            ? { ...widget, x: item.x, y: item.y, w: item.w, h: item.h }
            : widget;
        }),
      },
    }));

  // ---------------------------------------------------------------
  // 属性面板字段渲染助手：统一新组件的属性编辑交互
  // ---------------------------------------------------------------
  const textField = (label: string, key: keyof PageWidget, placeholder?: string) => (
    <Form.Item label={label} key={key}>
      <Input
        value={(selected?.[key] as string | undefined) ?? ""}
        placeholder={placeholder}
        onChange={(event) =>
          patchWidget({ [key]: event.target.value } as Partial<PageWidget>)
        }
      />
    </Form.Item>
  );
  const numericField = (label: string, key: keyof PageWidget, min: number, max: number) => (
    <Form.Item label={label} key={key}>
      <InputNumber
        min={min}
        max={max}
        value={selected?.[key] as number | undefined}
        onChange={(value) =>
          patchWidget({ [key]: value ?? undefined } as Partial<PageWidget>)
        }
      />
    </Form.Item>
  );
  const boolField = (label: string, key: keyof PageWidget) => (
    <Form.Item label={label} key={key}>
      <Segmented
        block
        value={(selected?.[key] as boolean | undefined) === false ? "no" : "yes"}
        options={[
          { label: t("common.yes"), value: "yes" },
          { label: t("common.no"), value: "no" },
        ]}
        onChange={(value) =>
          patchWidget({ [key]: value === "yes" } as Partial<PageWidget>)
        }
      />
    </Form.Item>
  );
  const limitField = () => (
    <Form.Item label={t("pageDesigner.maxRecords")} key="limit">
      <InputNumber
        min={1}
        max={10000}
        value={selected?.dataSource.limit || 100}
        onChange={(value) =>
          patchWidget({
            dataSource: { ...selected!.dataSource, limit: value || 100 },
          })
        }
      />
    </Form.Item>
  );
  const selectField = (
    label: string,
    key: keyof PageWidget,
    options: Array<{ label: string; value: string }>,
    fallback: string,
  ) => (
    <Form.Item label={label} key={key}>
      <Select
        value={(selected?.[key] as string | undefined) || fallback}
        options={options}
        onChange={(value) =>
          patchWidget({ [key]: value } as Partial<PageWidget>)
        }
      />
    </Form.Item>
  );

  return (
    <div className="page-designer">
      <Card
        title={<Typography.Title level={4}>{t("pageDesigner.title")}</Typography.Title>}
        variant="borderless"
        styles={{ body: { padding: "1px 0px 0px 0px" } }}
        extra={
          <Space>
            <Input
              value={page.name}
              style={{ width: 200 }}
              onChange={(event) =>
                setPage({ ...page, name: event.target.value })
              }
              placeholder={t("pageDesigner.pageNamePlaceholder")}
            />
            <Input
              value={page.description || ""}
              style={{ width: 280 }}
              onChange={(event) =>
                setPage({ ...page, description: event.target.value })
              }
              placeholder={t("pageDesigner.pageDescriptionPlaceholder")}
            />
            <Select
              value={page.id || "new"}
              style={{ width: 220 }}
              onChange={(value) => {
                if (value === "new") setPage(emptyPage());
                else
                  setPage(
                    pages.find((item) => item.id === value) || emptyPage(),
                  );
                setSelectedId(undefined);
              }}
              options={[
                { value: "new", label: t("pageDesigner.newPage") },
                ...pages.map((item) => ({
                  value: item.id!,
                  label: `${item.name}${
                    item.status === "published" ? " · " + t("pageDesigner.published") : ""
                  }`,
                })),
              ]}
            />
            <Button icon={<EyeOutlined />} onClick={() => setPreview(true)}>
              {t("pageDesigner.preview")}
            </Button>
            <Button icon={<SaveOutlined />} loading={saving} onClick={save}>
              {t("common.save")}
            </Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => setPublishOpen(true)}
            >
              {t("pageDesigner.publish")}
            </Button>
            <Popconfirm
              title={t("pageDesigner.deletePageConfirm")}
              okText={t("common.confirm")}
              cancelText={t("common.cancel")}
              okButtonProps={{ danger: true }}
              disabled={!page.id}
              onConfirm={handleDeletePage}
            >
              <Button danger icon={<DeleteOutlined />} disabled={!page.id}>
                {t("pageDesigner.deletePage")}
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <div className="designer-workspace">
          <Card title={t("pageDesigner.widgets")} variant="borderless" size="small" className="component-palette">
            <div className="palette-grid">
              {palette.map((item) => (
                <Button
                  key={item.type}
                  icon={item.icon}
                  onClick={() => addWidget(item.type)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </Card>
          <main className="designer-canvas">
            {page.config.widgets.length ? (
              <PageCanvas
                page={page}
                editable
                selectedId={selectedId}
                onSelect={setSelectedId}
                onLayoutChange={updateLayout}
              />
            ) : (
              <Empty description={t("pageDesigner.emptyCanvas")} />
            )}
          </main>
          <Card
            title={t("pageDesigner.widgetProperties")}
            variant="borderless"
            size="small"
            className="property-panel"
            extra={
              <Popconfirm
                title={t("pageDesigner.deleteWidgetConfirm")}
                onConfirm={() => {
                  setPage((current) => ({
                    ...current,
                    config: {
                      widgets: current.config.widgets.filter(
                        (item) => item.id !== selected?.id,
                      ),
                    },
                  }));
                  setSelectedId(undefined);
                }}
              >
                <Button danger type="text" icon={<DeleteOutlined />} disabled={!selected}  />
              </Popconfirm>
            }
          >
            {selected ? (
              <Form layout="vertical" size="small">
                <Form.Item label={t("pageDesigner.widgetType")}>
                  <Input
                    value={palette.find((item) => item.type === selected.type)?.label || selected.type}
                    readOnly
                    disabled
                  />
                </Form.Item>
                <Form.Item label={t("pageDesigner.widgetTitle")}>
                  <Input
                    value={selected.title}
                    onChange={(event) =>
                      patchWidget({ title: event.target.value })
                    }
                  />
                </Form.Item>
                {(selected.type === "text" || selected.type === "button" || selected.type === "divider") && (
                  <Form.Item label={t("pageDesigner.widgetContent")}>
                    <Input.TextArea
                      value={selected.type === "divider" ? (selected.dividerText || "") : (selected.content || "")}
                      onChange={(event) =>
                        selected.type === "divider"
                          ? patchWidget({ dividerText: event.target.value })
                          : patchWidget({ content: event.target.value })
                      }
                    />
                  </Form.Item>
                )}
                {selected.type === "divider" && (
                  <>
                    <Form.Item label={t("pageDesigner.dashed")}>
                      <Segmented
                        block
                        value={selected.dashed ? "yes" : "no"}
                        options={[
                          { label: t("common.yes"), value: "yes" },
                          { label: t("common.no"), value: "no" },
                        ]}
                        onChange={(value) => patchWidget({ dashed: value === "yes" })}
                      />
                    </Form.Item>
                    <Form.Item label={t("pageDesigner.titlePlacement")}>
                      <Select
                        value={selected.titlePlacement || "center"}
                        onChange={(value) => patchWidget({ titlePlacement: value })}
                        options={[
                          { value: "start", label: t("pageDesigner.placementStart") },
                          { value: "center", label: t("pageDesigner.placementCenter") },
                          { value: "end", label: t("pageDesigner.placementEnd") },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item label={t("pageDesigner.orientation")}>
                      <Select
                        value={selected.orientation || "horizontal"}
                        onChange={(value) =>
                          patchWidget({
                            orientation: value,
                            titlePlacement:
                              value === "vertical"
                                ? undefined
                                : selected.titlePlacement || "center",
                          })
                        }
                        options={[
                          { value: "horizontal", label: t("pageDesigner.horizontal") },
                          { value: "vertical", label: t("pageDesigner.vertical") },
                        ]}
                      />
                    </Form.Item>
                    {selected.orientation !== "vertical" && (
                      <Form.Item label={t("pageDesigner.titlePlacement")}>
                        <Select
                          value={selected.titlePlacement || "center"}
                          onChange={(value) =>
                            patchWidget({ titlePlacement: value })
                          }
                          options={[
                            { value: "start", label: t("pageDesigner.placementStart") },
                            { value: "center", label: t("pageDesigner.placementCenter") },
                            { value: "end", label: t("pageDesigner.placementEnd") },
                          ]}
                        />
                      </Form.Item>
                    )}
                    <Form.Item label={t("pageDesigner.style")}>
                      <Select
                        value={selected.variant || "solid"}
                        onChange={(value) => patchWidget({ variant: value })}
                        options={[
                          { value: "solid", label: t("pageDesigner.lineSolid") },
                          { value: "dashed", label: t("pageDesigner.lineDashed") },
                          { value: "dotted", label: t("pageDesigner.lineDotted") },
                        ]}
                      />
                    </Form.Item>
                  </>
                )}
                <Space>
                  <Form.Item label={t("pageDesigner.columnX")}>
                    <InputNumber
                      min={0}
                      max={Math.max(0, 12 - selected.w)}
                      value={selected.x}
                      onChange={(value) => patchWidget({ x: value ?? 0 })}
                    />
                  </Form.Item>
                  <Form.Item label={t("pageDesigner.rowY")}>
                    <InputNumber
                      min={0}
                      value={selected.y}
                      onChange={(value) => patchWidget({ y: value ?? 0 })}
                    />
                  </Form.Item>
                </Space>
                <Space>
                  <Form.Item label={t("pageDesigner.width")}>
                    <InputNumber
                      min={2}
                      max={12}
                      value={selected.w}
                      onChange={(value) => {
                        const w = value || 2;
                        patchWidget({ w, x: Math.min(selected.x, 12 - w) });
                      }}
                    />
                  </Form.Item>
                  <Form.Item label={t("pageDesigner.height")}>
                    <InputNumber
                      min={2}
                      max={12}
                      value={selected.h}
                      onChange={(value) => patchWidget({ h: value || 2 })}
                    />
                  </Form.Item>
                </Space>
                <Divider>{t("pageDesigner.dataSource")}</Divider>
                <Form.Item>
                  <Segmented
                    block
                    value={selected.dataSource.mode}
                    options={[
                      { label: t("pageDesigner.staticJson"), value: "static" },
                      { label: "Supabase", value: "supabase" },
                      { label: "BAQ", value: "baq" },
                    ]}
                    onChange={(mode) =>
                      patchWidget({
                        dataSource: {
                          ...selected.dataSource,
                          mode: mode as "static" | "supabase" | "baq",
                        },
                      })
                    }
                  />
                </Form.Item>
                {selected.dataSource.mode !== "static" && (
                  <Form.Item
                    label={t("pageDesigner.refreshInterval")}
                    tooltip={t("pageDesigner.refreshIntervalTip")}
                  >
                    <InputNumber
                      min={0}
                      max={3600}
                      style={{ width: "100%" }}
                      value={selected.refreshInterval || 0}
                      onChange={(value) =>
                        patchWidget({ refreshInterval: value || 0 })
                      }
                    />
                  </Form.Item>
                )}
                {selected.dataSource.mode === "static" ? (
                  <Form.Item label={t("pageDesigner.jsonArray")}>
                    <Input.TextArea
                      rows={6}
                      value={JSON.stringify(
                        selected.dataSource.staticData || [],
                        null,
                        2,
                      )}
                      onBlur={(event) => {
                        try {
                          const value = JSON.parse(event.target.value);
                          if (!Array.isArray(value)) throw new Error();
                          patchWidget({
                            dataSource: {
                              ...selected.dataSource,
                              staticData: value,
                            },
                          });
                        } catch {
                          message.error(t("pageDesigner.invalidJsonArray"));
                        }
                      }}
                      onChange={(event) => {
                        try {
                          patchWidget({
                            dataSource: {
                              ...selected.dataSource,
                              staticData: JSON.parse(event.target.value),
                            },
                          });
                        } catch {
                          /* validate on blur */
                        }
                      }}
                    />
                  </Form.Item>
                ) : selected.dataSource.mode === "supabase" ? (
                  <>
                    <Form.Item label={t("pageDesigner.tableName")}>
                      <Input
                        value={selected.dataSource.table}
                        onChange={(event) =>
                          patchWidget({
                            dataSource: {
                              ...selected.dataSource,
                              table: event.target.value,
                            },
                          })
                        }
                      />
                    </Form.Item>
                    <Form.Item label={t("pageDesigner.queryFields")}>
                      <Input
                        value={selected.dataSource.select || "*"}
                        onChange={(event) =>
                          patchWidget({
                            dataSource: {
                              ...selected.dataSource,
                              select: event.target.value,
                            },
                          })
                        }
                      />
                    </Form.Item>
                  </>
                ) : (
                  <Form.Item label={t("pageDesigner.publishedBaq")}>
                    <Select showSearch optionFilterProp="label" value={selected.dataSource.baqCode} placeholder={t("pageDesigner.selectBaqPlaceholder")}
                      options={baqs.map((item) => ({ value: item.code, label: `${item.name} (${item.code})` }))}
                      onChange={(baqCode) => patchWidget({ dataSource: { ...selected.dataSource, baqCode } })} />
                  </Form.Item>
                )}
                {selected.type === "table" && (
                  <Space>
                    <Form.Item label={t("pageDesigner.pageSize")}>
                      <InputNumber
                        min={1}
                        max={100}
                        value={selected.pageSize || 10}
                        onChange={(value) => patchWidget({ pageSize: value || 10 })}
                      />
                    </Form.Item>
                    <Form.Item label={t("pageDesigner.maxRecords")}>
                      <InputNumber
                        min={1}
                        max={10000}
                        value={selected.dataSource.limit || 100}
                        onChange={(value) => patchWidget({
                          dataSource: { ...selected.dataSource, limit: value || 100 },
                        })}
                      />
                    </Form.Item>
                  </Space>
                )}                {["statistic", "line", "column", "pie"].includes(
                  selected.type,
                ) && (
                  <>
                    <Form.Item
                      label={
                        selected.type === "pie"
                          ? t("pageDesigner.categoryField")
                          : t("pageDesigner.xLabelField")
                      }
                    >
                      <Input
                        value={
                          selected.type === "pie"
                            ? selected.colorField
                            : selected.xField
                        }
                        onChange={(event) =>
                          patchWidget(
                            selected.type === "pie"
                              ? { colorField: event.target.value }
                              : { xField: event.target.value },
                          )
                        }
                      />
                    </Form.Item>
                    <Form.Item label={t("pageDesigner.valueField")}>
                      <Input
                        value={selected.yField}
                        onChange={(event) =>
                          patchWidget({ yField: event.target.value })
                        }
                      />
                    </Form.Item>
                  </>
                )}

                {/* ============ 增强组件属性 ============ */}
                {selected.type === "progressRing" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.valueField"), "yField")}
                    {numericField(t("pageDesigner.maxValue"), "maxValue", 1, 1000000)}
                    {numericField(t("pageDesigner.precision"), "precision", 0, 4)}
                    {textField(t("pageDesigner.unit"), "unit")}
                    {selectField(t("pageDesigner.ringShape"), "ringShape", [
                      { label: t("pageDesigner.ringCircle"), value: "circle" },
                      { label: t("pageDesigner.ringDashboard"), value: "dashboard" },
                    ], "circle")}
                    {textField(t("pageDesigner.accentColor"), "accentColor", t("pageDesigner.accentColorPlaceholder"))}
                  </>
                )}
                {selected.type === "gauge" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.valueField"), "yField")}
                    {numericField(t("pageDesigner.maxValue"), "maxValue", 1, 1000000)}
                    {numericField(t("pageDesigner.precision"), "precision", 0, 4)}
                    {textField(t("pageDesigner.unit"), "unit")}
                    {textField(t("pageDesigner.accentColor"), "accentColor", t("pageDesigner.accentColorPlaceholder"))}
                  </>
                )}
                {selected.type === "scatter" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.valueField"), "yField")}
                    {textField(t("pageDesigner.categoryField"), "colorField")}
                  </>
                )}
                {selected.type === "linkage" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.valueField"), "yField")}
                    {textField(t("pageDesigner.secondValueField"), "y2Field")}
                  </>
                )}
                {selected.type === "ranking" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.valueField"), "yField")}
                    {numericField(t("pageDesigner.displayRows"), "displayRows", 1, 20)}
                    {numericField(t("pageDesigner.precision"), "precision", 0, 4)}
                    {textField(t("pageDesigner.unit"), "unit")}
                    {textField(t("pageDesigner.accentColor"), "accentColor", t("pageDesigner.accentColorPlaceholder"))}
                  </>
                )}
                {selected.type === "carouselTable" && (
                  <>
                    {numericField(t("pageDesigner.pageSize"), "pageSize", 1, 50)}
                    {numericField(t("pageDesigner.interval"), "interval", 1, 60)}
                    {boolField(t("pageDesigner.autoPlay"), "autoPlay")}
                    {limitField()}
                  </>
                )}
                {selected.type === "liveStream" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.statusField"), "statusField")}
                    {numericField(t("pageDesigner.displayRows"), "displayRows", 1, 50)}
                    {numericField(t("pageDesigner.interval"), "interval", 2, 120)}
                    {boolField(t("pageDesigner.autoPlay"), "autoPlay")}
                  </>
                )}
                {selected.type === "marquee" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {numericField(t("pageDesigner.displayRows"), "displayRows", 1, 6)}
                    {numericField(t("pageDesigner.interval"), "interval", 4, 120)}
                    {boolField(t("pageDesigner.autoPlay"), "autoPlay")}
                    {selectField(t("pageDesigner.scrollDirection"), "scrollDirection", [
                      { label: t("pageDesigner.vertical"), value: "vertical" },
                      { label: t("pageDesigner.horizontal"), value: "horizontal" },
                    ], "vertical")}
                  </>
                )}
                {selected.type === "alertBanner" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.statusField"), "statusField")}
                    {textField(t("pageDesigner.statusMap"), "statusMap", t("pageDesigner.statusMapPlaceholder"))}
                    {numericField(t("pageDesigner.interval"), "interval", 2, 60)}
                    {boolField(t("pageDesigner.autoPlay"), "autoPlay")}
                  </>
                )}
                {selected.type === "statusTag" && (
                  <>
                    {textField(t("pageDesigner.xLabelField"), "xField")}
                    {textField(t("pageDesigner.statusField"), "statusField")}
                    {textField(t("pageDesigner.statusMap"), "statusMap", t("pageDesigner.statusMapPlaceholder"))}
                  </>
                )}
                {selected.type === "clock" && (
                  <>
                    {textField(t("pageDesigner.timeFormat"), "timeFormat")}
                    {textField(t("pageDesigner.dateFormat"), "dateFormat")}
                    {selectField(t("pageDesigner.orientation"), "orientation", [
                      { label: t("pageDesigner.horizontal"), value: "horizontal" },
                      { label: t("pageDesigner.vertical"), value: "vertical" },
                    ], "vertical")}
                    {textField(t("pageDesigner.accentColor"), "accentColor", t("pageDesigner.accentColorPlaceholder"))}
                  </>
                )}
              </Form>
            ) : (
              <Empty description={t("pageDesigner.emptyPropertyPanel")} />
            )}
          </Card>
        </div>
      </Card>
      <Drawer
        open={preview}
        onClose={() => setPreview(false)}
        width="90%"
        title={t("pageDesigner.previewTitle", { name: page.name })}
      >
        <PageCanvas page={page} />
      </Drawer>
      <Modal
        open={publishOpen}
        onCancel={() => setPublishOpen(false)}
        footer={null}
        title={t("pageDesigner.publishPage")}
      >
        <Alert
          type="info"
          showIcon
          message={t("pageDesigner.publishHint")}
        />
        <Form
          layout="vertical"
          initialValues={page}
          onFinish={publish}
          style={{ marginTop: 20 }}
        >
          <Form.Item
            name="name"
            label={t("pageDesigner.menuAndPageName")}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="slug"
            label={t("pageDesigner.pageSlug")}
            rules={[
              { required: true },
              {
                pattern: /^[a-z0-9-]+$/,
                message: t("pageDesigner.slugPatternHint"),
              },
            ]}
          >
            <Input addonBefore="/custom/" />
          </Form.Item>
          <Form.Item name="description" label={t("pageDesigner.description")}>
            <Input.TextArea />
          </Form.Item>
          <Button
            block
            type="primary"
            htmlType="submit"
            loading={saving}
            icon={<PlusOutlined />}
          >
            {t("pageDesigner.publishAndGenerateMenu")}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
