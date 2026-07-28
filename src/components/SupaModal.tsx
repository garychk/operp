import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  Space,
  Button,
  Collapse,
  Splitter,
  Timeline,
  Tag,
  Empty,
  Spin,
  message,
  Card,
  Switch,
} from 'antd';
import {
  CompressOutlined,
  FullscreenOutlined,
  LeftOutlined,
  RightOutlined,
  CaretRightOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';
import PrintDesigner from 'operp-print-designer';
import 'operp-print-designer/dist/operp-print-designer.css';
import { supabase } from '../utils/supabase';
import type { SysFormsInsert } from '../types/database';
import type { PrintDesignerDataSource } from 'operp-print-designer';
import { WorkflowHistoryCard } from './WorkflowHistoryCard';
import { WorkflowActionBar } from './WorkflowActionBar';

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
  tableEle?: ReactNode;
  disabled?: boolean;
  detailData?: any[];
  historyTable?: string;
  historyRecordId?: string | number | null;
  workflowDocumentType?: string;
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
  tableEle,
  disabled,
  detailData,
  historyTable,
  historyRecordId,
  workflowDocumentType,
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
  const [printDataSource, setPrintDataSource] = useState<PrintDesignerDataSource>();
  const [templateLoading, setTemplateLoading] = useState(false);
  const [designerInstanceKey, setDesignerInstanceKey] = useState(0);
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const currentFormName = formTable || historyTable;
  const currentStatus = form?.getFieldValue('status') || '';
  const resolvedDisabled = disabled ?? ['approved', 'partially_received', 'received', 'closed'].includes(currentStatus);

  useEffect(() => {
    const fetchDocumentHistory = async () => {
      if (!open || !historyTable || historyRecordId === null || historyRecordId === undefined) {
        setHistoryLogs([]);
        return;
      }

      setHistoryLoading(true);
      const { data, error } = await supabase
        .from('sys_logs')
        .select('id, username, operation, method, status, error_msg, created_at')
        .eq('is_deleted', 'n')
        .eq('params->>table', historyTable)
        .eq('params->>recordId', String(historyRecordId))
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) {
        console.error('Failed to fetch document history:', error);
        setHistoryLogs([]);
      } else {
        setHistoryLogs(data || []);
      }
      setHistoryLoading(false);
    };

    void fetchDocumentHistory();
  }, [open, historyTable, historyRecordId]);

  const handleCancel = () => {
    setIsExpand(false);
    onCancel();
  };

  const handleReset = () => {
    form?.resetFields();
  };

  const loadTemplate = async (formName: string) => {
    const { data, error } = await supabase
      .from('sys_forms')
      .select('print_template_json')
      .eq('is_deleted', 'n')
      .eq('form_name', formName)
      .maybeSingle();

    if (error) {
      console.error('Failed to fetch print template:', error);
      message.error(t('modal.messages.fetchTemplateFailed', { message: error.message }));
      return undefined;
    }

    if (!data?.print_template_json) return undefined;

    try {
      return JSON.parse(data.print_template_json);
    } catch (parseError) {
      console.error('Failed to parse print template:', parseError);
      message.error(t('modal.messages.templateInvalid'));
      return undefined;
    }
  };

  const handleOpenDesigner = async () => {
    if (!currentFormName) {
      message.error(t('modal.messages.missingFormName'));
      return;
    }

    setOpenDesigner(true);
    setTemplateData(undefined);
    setPrintDataSource({
      data: form?.getFieldsValue() || {},
      list: detailData || [],
    });
    setTemplateLoading(true);

    const loadedTemplate = await loadTemplate(currentFormName);
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
      message.error(t('modal.messages.missingFormNameSave'));
      return;
    }

    const templateJson = JSON.stringify(data);
    const formSettings: SysFormsInsert = {
      table_name: formName,
      form_name: formName,
      description: formDescription || formName,
      print_template_json: templateJson,
      form_config: {
        headerPanelTitle: headerPanelTitle || t('modal.headerPanelTitle'),
        detailPanelTitle: detailPanelTitle || t('modal.detailPanelTitle'),
        hasDetail: Boolean(tableEle),
      },
      status: '1',
      sort_order: 0,
      is_deleted: 'n',
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('sys_forms').upsert(formSettings, { onConflict: 'form_name' });
    if (error) {
      console.error('Failed to save print template:', error);
      message.error(t('modal.messages.saveTemplateFailed', { message: error.message }));
      return;
    }

    message.success(t('modal.messages.saveTemplateSuccess'));
    handleCloseDesigner();
  };

  const combinedOnCancel = () => {
    handleReset();
    handleCancel();
  };

  const historyItems = historyLogs.map((log) => ({
    color: log.status === '1' || log.status === 'success' ? 'green' : 'red',
    content: (
      <Space direction="vertical" size={2}>
        <Space wrap>
          <span>{log.operation}</span>
          {log.method && <Tag>{log.method}</Tag>}
          <span style={{ color: '#666' }}>{log.username || 'anonymous'}</span>
        </Space>
        <span style={{ color: '#999', fontSize: 12 }}>
          {log.created_at ? new Date(log.created_at).toLocaleString() : '-'}
        </span>
        {log.error_msg && <span style={{ color: '#cf1322', fontSize: 12 }}>{log.error_msg}</span>}
      </Space>
    ),
  }));


  return (
    <>
      <Modal
        title={
          <Space>
            {title}
            <Button type="default" size="small" icon={isExpand ? <CompressOutlined /> : <FullscreenOutlined />} onClick={() => setIsExpand(!isExpand)} />
            <Button type="default" size="small" icon={<LeftOutlined />} />
            <Button type="default" size="small" icon={<RightOutlined />} />
            <WorkflowActionBar documentType={workflowDocumentType} documentId={historyRecordId} currentStatus={form?.getFieldValue('status')} onActionDone={combinedOnCancel} disabled={resolvedDisabled} />
            <Switch checked={isPreview} onChange={setIsPreview} checkedChildren="P" unCheckedChildren="D" size="middle" disabled={resolvedDisabled} />
            <Button type="default" size="small" icon={<PrinterOutlined />} onClick={handleOpenDesigner} />
            <Tag color="magenta">{t('modal.pressEscToClose')}</Tag>
          </Space>
        }
        open={open}
        onCancel={combinedOnCancel}
        footer={footer}
        width={isExpand ? '100%' : width}
        styles={{
          body: isExpand ? { height: 'calc(90vh - 50px)', overflow: 'auto' } : { height, overflow: 'auto' },
        }}
        style={{ top: isExpand ? 16 : 100 }}
        keyboard
      >
        <div>
          {children || (
            <Collapse
              defaultActiveKey={['1', '2']}
              expandIcon={({ isActive }) => <CaretRightOutlined rotate={isActive ? 90 : 0} />}
              size="small"              
            >
              <Collapse.Panel header={headerPanelTitle || t('modal.headerPanelTitle')} key="1" extra={headerExtra} >
                <Splitter>
                  <Splitter.Panel defaultSize="70%" min="20%" max="70%">
                    {formEle}
                  </Splitter.Panel>
                  <Splitter.Panel>
                    <Card title={t('modal.documentHistory')} size="small" variant="borderless" style={{ borderRadius: 0 }}>
                      <Spin spinning={historyLoading}>
                        {historyItems.length > 0 ? (
                          <Timeline items={historyItems} style={{ height: '300px', overflowY: 'auto' }} />
                        ) : (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('modal.noHistoryRecords')} />
                        )}
                      </Spin>
                    </Card>
                    <WorkflowHistoryCard open={open} documentType={workflowDocumentType} documentId={historyRecordId} />
                  </Splitter.Panel>
                </Splitter>
              </Collapse.Panel>
              {tableEle && (
                <Collapse.Panel header={detailPanelTitle || t('modal.detailPanelTitle')} key="2" extra={detailExtra}>
                  {tableEle}
                </Collapse.Panel>
              )}
            </Collapse>
          )}
        </div>
      </Modal>
      <Modal
        title={t('modal.printDesigner')}
        open={openDesigner}
        onCancel={handleCloseDesigner}
        width="80%"
        destroyOnHidden
        styles={{
          body: { height: 'calc(90vh - 50px)', overflow: 'auto' },
        }}
        style={{ top: 16 }}
        keyboard
        footer={null}
      >
        <Spin spinning={templateLoading}>
          {!templateLoading && (
            <PrintDesigner
              key={`${currentFormName || 'unknown'}-${designerInstanceKey}`}
              isPreview={isPreview}
              initialTemplateData={templateData}
              dataSource={printDataSource}
              onSave={handleSaveTemplate}
            />
          )}
        </Spin>
      </Modal>
    </>
  );
}

export default SupaModal;

