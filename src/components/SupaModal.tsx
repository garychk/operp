import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ConfigProvider,
  Modal,
  Space,
  Button,
  Splitter,
  Timeline,
  Tag,
  Empty,
  Spin,
  message,
  Card,
  Switch,
  Tabs,
} from "antd";
import {
  CompressOutlined,
  FullscreenOutlined,
  LeftOutlined,
  RightOutlined,
  PrinterOutlined,
  ApartmentOutlined,
} from "@ant-design/icons";
import type { FormInstance } from "antd/es/form";
import PrintDesigner from "operp-print-designer";
import "operp-print-designer/dist/operp-print-designer.css";
import { supabase } from "../utils/supabase";
import type { SysFormsInsert } from "../types/database";
import type { PrintDesignerDataSource } from "operp-print-designer";
import { WorkflowHistoryCard } from "./WorkflowHistoryCard";
import { WorkflowActionBar } from "./WorkflowActionBar";
import { DocFlowGenerateButton } from "./DocFlowGenerateButton";
import { DocFlowConnectionsModal } from "./DocFlowConnectionsModal";

interface HistoryLog {
  id: number;
  username: string | null;
  operation: string;
  method: string | null;
  status: string | null;
  error_msg: string | null;
  created_at: string | null;
}

interface SupaModalProps {
  open: boolean;
  footer?: ReactNode;
  onCancel: () => void;
  title?: ReactNode;
  form?: FormInstance;
  formEle?: ReactNode;
  headerExtra?: ReactNode;
  headerPanelTitle?: string;
  detailPanelTitle?: string;
  detailExtra?: ReactNode;
  detailItems?: {
    key?: string;
    label: ReactNode;
    children: ReactNode;
    disabled?: boolean;
  }[];
  tableEle?: ReactNode;
  disabled?: boolean;
  detailData?: any[];
  historyTable?: string;
  historyRecordId?: string | number | null;
  workflowDocumentType?: string;
  /** Called after a workflow action changed the document, so the page can refetch its list. */
  onDataChanged?: () => void;
  /** 单据号，仅用于下推弹窗标题。 */
  documentNo?: string;
  /** 下推弹窗里物料单位的用途，默认 purchase。 */
  docFlowUsageType?: string;
  /** 下推源明细里的物料字段名，默认 product_id。 */
  docFlowProductField?: string;
  formTable?: string;
  formDescription?: string;
  width?: string | number;
  height?: string | number;
  children?: ReactNode;
}

export function SupaModal({
  open,
  footer,
  onCancel,
  title,
  form,
  formEle,
  headerExtra,
  headerPanelTitle,
  detailPanelTitle,
  detailExtra,
  detailItems,
  tableEle,
  disabled,
  detailData,
  historyTable,
  historyRecordId,
  workflowDocumentType,
  onDataChanged,
  documentNo,
  docFlowUsageType,
  docFlowProductField,
  formTable,
  formDescription,
  width = 1200,
  height = 800,
  children,
}: SupaModalProps) {
  const { t } = useTranslation();
  const [isExpand, setIsExpand] = useState(false);
  const [openDesigner, setOpenDesigner] = useState(false);
  const [isPreview, setIsPreview] = useState(true);
  const [templateData, setTemplateData] = useState<any>();
  const [printDataSource, setPrintDataSource] =
    useState<PrintDesignerDataSource>();
  const [templateLoading, setTemplateLoading] = useState(false);
  const [designerInstanceKey, setDesignerInstanceKey] = useState(0);
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  const currentFormName = formTable || historyTable;
  const currentStatus = form?.getFieldValue("status") || "";
  const resolvedDisabled =
    disabled ??
    ["approved", "partially_received", "received", "closed"].includes(
      currentStatus,
    );

  useEffect(() => {
    const fetchDocumentHistory = async () => {
      if (
        !open ||
        !historyTable ||
        historyRecordId === null ||
        historyRecordId === undefined
      ) {
        setHistoryLogs([]);
        return;
      }

      setHistoryLoading(true);
      const { data, error } = await supabase
        .from("sys_logs")
        .select(
          "id, username, operation, method, status, error_msg, created_at",
        )
        .eq("is_deleted", "n")
        .eq("params->>table", historyTable)
        .eq("params->>recordId", String(historyRecordId))
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        console.error("Failed to fetch document history:", error);
        setHistoryLogs([]);
      } else {
        setHistoryLogs(data || []);
      }
      setHistoryLoading(false);
    };

    void fetchDocumentHistory();
  }, [open, historyTable, historyRecordId, historyRefreshKey]);

  // After a workflow action succeeds, keep the modal open and refresh
  // everything in place: form status, document logs, workflow history,
  // and the page list (via onDataChanged).
  const handleWorkflowActionDone = (result?: {
    status?: string | null;
  }) => {
    if (result?.status) {
      form?.setFieldValue("status", result.status);
    }
    setHistoryRefreshKey((key) => key + 1);
    onDataChanged?.();
  };

  const handleCancel = () => {
    setIsExpand(false);
    setConnectionsOpen(false);
    onCancel();
  };

  const handleReset = () => {
    form?.resetFields();
  };

  const loadTemplate = async (formName: string) => {
    const { data, error } = await supabase
      .from("sys_forms")
      .select("print_template_json")
      .eq("is_deleted", "n")
      .eq("form_name", formName)
      .maybeSingle();

    if (error) {
      console.error("Failed to fetch print template:", error);
      message.error(
        t("modal.messages.fetchTemplateFailed", { message: error.message }),
      );
      return undefined;
    }

    if (!data?.print_template_json) return undefined;

    try {
      return JSON.parse(data.print_template_json);
    } catch (parseError) {
      console.error("Failed to parse print template:", parseError);
      message.error(t("modal.messages.templateInvalid"));
      return undefined;
    }
  };

  const handleOpenDesigner = async () => {
    if (!currentFormName) {
      message.error(t("modal.messages.missingFormName"));
      return;
    }

    setOpenDesigner(true);
    setTemplateData(undefined);
    setPrintDataSource({
      data: form?.getFieldsValue() || {},
      list: detailData || [],
    });
    setTemplateLoading(true);

    let loadedTemplate = await loadTemplate(currentFormName);
    if (!loadedTemplate) {
      loadedTemplate = {
        version: "1.0",
        templateName: "title",
        pageSettings: {
          "paperSize": "A4",
          "customWidth": 180,
          "customHeight": 97,
          "orientation": "portrait",
          "marginTop": 10,
          "marginRight": 10,
          "marginBottom": 10,
          "marginLeft": 10
        },
        components: [],
      };
    }
    if (!loadedTemplate.dataSources) {      
      loadedTemplate.dataSources = [
        {
          name: "MainData",
          type: "object",
          data: JSON.stringify(form?.getFieldsValue() || {}),
          createdAt: Date.now(),
        },
        {
          name: "DetailData",
          type: "array",
          data: JSON.stringify(detailData?.length ? [detailData[0]] : []),
          createdAt: Date.now(),
        },
      ];
    }

    setTemplateData(loadedTemplate);
    setDesignerInstanceKey((key) => key + 1);
    setTemplateLoading(false);
  };

  const handleCloseDesigner = () => {
    setOpenDesigner(false);
    setTemplateData(undefined);
    setPrintDataSource(undefined);
    setTemplateLoading(false);
  };

  const handleSaveTemplate = async (data: any) => {
    const formName = currentFormName;
    if (!formName) {
      message.error(t("modal.messages.missingFormNameSave"));
      return;
    }

    const templateJson = JSON.stringify(data);
    const formSettings: SysFormsInsert = {
      table_name: formName,
      form_name: formName,
      description: formDescription || formName,
      print_template_json: templateJson,
      form_config: {
        headerPanelTitle: headerPanelTitle || t("modal.headerPanelTitle"),
        detailPanelTitle: detailPanelTitle || t("modal.detailPanelTitle"),
        hasDetail: Boolean(tableEle),
      },
      status: "1",
      sort_order: 0,
      is_deleted: "n",
      updated_at: new Date().toISOString(),
    };

    // 唯一键已改成 (tenant_id, form_name) 的部分索引，upsert 的 onConflict
    // 命中不了，改成「先查后写」：查得到（本租户私有行或平台基线行）就更新，
    // 查不到就新建一条归属本租户的。
    const { data: existing, error: lookupError } = await supabase
      .from("sys_forms")
      .select("id")
      .eq("form_name", formName)
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error("Failed to lookup print template:", lookupError);
      message.error(
        t("modal.messages.saveTemplateFailed", { message: lookupError.message }),
      );
      return;
    }

    const { error } = existing?.id
      ? await supabase.from("sys_forms").update(formSettings).eq("id", existing.id)
      : await supabase.from("sys_forms").insert(formSettings);

    if (error) {
      console.error("Failed to save print template:", error);
      message.error(
        t("modal.messages.saveTemplateFailed", { message: error.message }),
      );
      return;
    }

    message.success(t("modal.messages.saveTemplateSuccess"));
    handleCloseDesigner();
  };

  const combinedOnCancel = () => {
    handleReset();
    handleCancel();
  };

  const historyItems = historyLogs.map((log) => ({
    color: log.status === "1" || log.status === "success" ? "green" : "red",
    content: (
      <Space direction="vertical" size={2}>
        <Space wrap>
          <span>{log.operation}</span>
          {log.method && <Tag>{log.method}</Tag>}
          <span style={{ color: "#666" }}>{log.username || "anonymous"}</span>
        </Space>
        <span style={{ color: "#999", fontSize: 12 }}>
          {log.created_at ? new Date(log.created_at).toLocaleString() : "-"}
        </span>
        {log.error_msg && (
          <span style={{ color: "#cf1322", fontSize: 12 }}>
            {log.error_msg}
          </span>
        )}
      </Space>
    ),
  }));

  return (
    <ConfigProvider variant="underlined">
      <Modal
        title={
          <Space>
            {title}
            <Button
              type="default"
              size="small"
              icon={isExpand ? <CompressOutlined /> : <FullscreenOutlined />}
              onClick={() => setIsExpand(!isExpand)}
            />
            <Button type="default" size="small" icon={<LeftOutlined />} />
            <Button type="default" size="small" icon={<RightOutlined />} />
            <WorkflowActionBar
              documentType={workflowDocumentType}
              documentId={historyRecordId}
              currentStatus={form?.getFieldValue("status")}
              onActionDone={handleWorkflowActionDone}
              disabled={resolvedDisabled}
            />
            {workflowDocumentType && historyRecordId != null && (
              <DocFlowGenerateButton
                sourceDocumentType={workflowDocumentType}
                sourceDocumentId={Number(historyRecordId)}
                sourceDocumentNo={documentNo}
                sourceStatus={form?.getFieldValue("status")}
                label={t("docFlow.button.push")}
                usageType={docFlowUsageType}
                productField={docFlowProductField}
                onSuccess={onDataChanged}
              />
            )}
            {workflowDocumentType && historyRecordId != null && (
              <Button
                type="text"
                icon={<ApartmentOutlined />}
                onClick={() => setConnectionsOpen(true)}
              >
                {t("docFlow.connections.button")}
              </Button>
            )}
            <Switch
              checked={isPreview}
              onChange={setIsPreview}
              checkedChildren="P"
              unCheckedChildren="D"
              size="small"
              disabled={resolvedDisabled}
            />
            <Button
              type="default"
              size="small"
              icon={<PrinterOutlined />}
              onClick={handleOpenDesigner}
            />
            <Tag color="magenta">{t("modal.pressEscToClose")}</Tag>
          </Space>
        }
        open={open}
        onCancel={combinedOnCancel}
        footer={footer}
        width={isExpand ? "100%" : width}
        styles={{
          body: isExpand
            ? { height: "calc(90vh - 50px)", overflow: "auto" }
            : { height, overflow: "auto" },
        }}
        style={{ top: isExpand ? 16 : 100 }}
        keyboard
      >
        <div className="supamodal-content">
          {children || (
            <Tabs
              size="small"
              defaultActiveKey="1"
              tabBarExtraContent={headerExtra}
              items={[
                {
                  key: "1",
                  label: headerPanelTitle || t("modal.headerPanelTitle"),
                  children: (
                    <Splitter>
                      <Splitter.Panel defaultSize="70%" min="20%" max="70%">
                        <div style={{ marginRight: 16 }}>
                          {formEle}
                          </div>
                      </Splitter.Panel>
                      <Splitter.Panel>
                        <Card
                          title={t("modal.documentHistory")}
                          size="small"
                          variant="borderless"
                          style={{ borderRadius: 0 }}
                        >
                          <Spin spinning={historyLoading}>
                            {historyItems.length > 0 ? (
                              <Timeline
                                items={historyItems}
                                style={{ height: "300px", overflowY: "auto" }}
                              />
                            ) : (
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={t("modal.noHistoryRecords")}
                              />
                            )}
                          </Spin>
                        </Card>
                        <WorkflowHistoryCard
                          open={open}
                          documentType={workflowDocumentType}
                          documentId={historyRecordId}
                          refreshKey={historyRefreshKey}
                        />
                      </Splitter.Panel>
                    </Splitter>
                  ),
                },
                ...(tableEle
                  ? [
                      {
                        key: "2",
                        label: detailPanelTitle || t("modal.detailPanelTitle"),
                        children: (
                          <>
                            {detailExtra && (
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "flex-end",
                                  marginBottom: 8,
                                }}
                              >
                                {detailExtra}
                              </div>
                            )}
                            {tableEle}
                          </>
                        ),
                      },
                    ]
                  : []),
                ...(detailItems?.map((item, index) => ({
                  key: item.key ?? `detail-${index + 1}`,
                  label: item.label,
                  children: item.children,
                  disabled: item.disabled,
                })) ?? []),
              ]}
            />
          )}
        </div>
      </Modal>
      <DocFlowConnectionsModal
        open={connectionsOpen}
        documentType={workflowDocumentType}
        documentId={historyRecordId}
        onCancel={() => setConnectionsOpen(false)}
      />
      <Modal
        title={t("modal.printDesigner")}
        open={openDesigner}
        onCancel={handleCloseDesigner}
        width="90%"
        destroyOnHidden
        styles={{
          body: { height: "calc(90vh - 50px)", overflow: "auto" },
        }}
        style={{ top: 16 }}
        keyboard
        footer={null}
      >
        <Spin spinning={templateLoading}>
          {!templateLoading && (
            <PrintDesigner
              locale="auto"
              key={`${currentFormName || "unknown"}-${designerInstanceKey}`}
              isPreview={isPreview}
              initialTemplateData={templateData}
              dataSource={printDataSource}
              onSave={handleSaveTemplate}
            />
          )}
        </Spin>
      </Modal>
    </ConfigProvider>
  );
}

export default SupaModal;
