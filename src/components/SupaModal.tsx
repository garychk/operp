import { useEffect, useState } from 'react';
import { Modal, Space, Button, Collapse, Splitter, Timeline, Tag, Divider, Empty, Spin, message } from 'antd';
import { CompressOutlined, FullscreenOutlined, LeftOutlined, RightOutlined, CaretRightOutlined, HistoryOutlined, CheckOutlined, PrinterOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';
import  PrintDesigner  from 'operp-print-designer';
import 'operp-print-designer/dist/operp-print-designer.css';
import { supabase } from '../utils/supabase';
import type { SysFormsInsert } from '../types/database';

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
  footer?: React.ReactNode;
  onCancel: () => void;
  title?: React.ReactNode;
  form?: FormInstance;
  formEle?: React.ReactNode;
  headerExtra?: React.ReactNode;
  headerPanelTitle?: string;
  detailPanelTitle?: string;
  detailExtra?: React.ReactNode;
  tableEle?: React.ReactNode;
  historyTable?: string;
  historyRecordId?: string | number | null;
  formTable?: string;
  formDescription?: string;
  width?: string | number;
  height?: string | number;
  children?: React.ReactNode;
}

export function SupaModal({
  open,
  footer,
  onCancel,
  title,
  form,
  formEle,
  headerExtra,
  headerPanelTitle = '单据头',
  detailPanelTitle = '单据明细',
  detailExtra,
  tableEle,
  historyTable,
  historyRecordId,
  formTable,
  formDescription,
  width = 1200,
  height = 800,
  children,
}: SupaModalProps) {
  const [isExpand, setIsExpand] = useState(false);
  const [openDesigner, setOpenDesigner] = useState(false);
  const [templateData, setTemplateData] = useState<any>();
  const [templateLoading, setTemplateLoading] = useState(false);
  const [designerInstanceKey, setDesignerInstanceKey] = useState(0);
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const currentFormName = formTable || historyTable;

  useEffect(() => {
    const fetchHistoryLogs = async () => {
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

    fetchHistoryLogs();
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
      message.error(`获取打印模板失败: ${error.message}`);
      return undefined;
    }

    if (!data?.print_template_json) {
      return undefined;
    }

    try {
      return JSON.parse(data.print_template_json);
    } catch (parseError) {
      console.error('Failed to parse print template:', parseError);
      message.error('打印模板数据格式不正确');
      return undefined;
    }
  };

  const handleOpenDesigner = async () => {
    if (!currentFormName) {
      message.error('缺少当前表单表名，无法打开打印设计');
      return;
    }

    setOpenDesigner(true);
    setTemplateData(undefined);
    setTemplateLoading(true);

    const loadedTemplate = await loadTemplate(currentFormName);

    setTemplateData(loadedTemplate);
    setDesignerInstanceKey((key) => key + 1);
    setTemplateLoading(false);
  };

  const handleCloseDesigner = () => {
    setOpenDesigner(false);
    setTemplateData(undefined);
    setTemplateLoading(false);
  };

  const handleSaveTemplate = async (data: any) => {
    const formName = currentFormName;

    if (!formName) {
      message.error('缺少当前表单表名，无法保存打印模板');
      return;
    }

    const templateJson = JSON.stringify(data);

    const formSettings: SysFormsInsert = {
      table_name: formName,
      form_name: formName,
      description: formDescription || formName,
      print_template_json: templateJson,
      form_config: {
        headerPanelTitle,
        detailPanelTitle,
        hasDetail: Boolean(tableEle),
      },
      status: '1',
      sort_order: 0,
      is_deleted: 'n',
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('sys_forms')
      .upsert(
        formSettings,
        { onConflict: 'form_name' },
      );

    if (error) {
      console.error('Failed to save print template:', error);
      message.error(`保存模板失败: ${error.message}`);
      return;
    }

    message.success('打印模板保存成功');
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
        {log.error_msg && (
          <span style={{ color: '#cf1322', fontSize: 12 }}>{log.error_msg}</span>
        )}
      </Space>
    ),
  }));

  return (
    <>
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
          <Button type='default' size="small" icon={<CheckOutlined />} color="purple" />
          <Button type='default' size="small" icon={<PrinterOutlined />} onClick={handleOpenDesigner} />
          <Tag color="magenta">按ESC键可关闭</Tag>
        </Space>
      }
      open={open}
      onCancel={combinedOnCancel}
      footer={footer}
      width={isExpand ? '100%' : width}
      styles={{
        body: isExpand ? { height: 'calc(90vh - 50px)', overflow: 'auto' } : { height: height, overflow: 'auto' },
      }}
      style={{ top: isExpand ? 16 : 100 }}
      keyboard
    >
      <div>
        {children || (
          <Collapse defaultActiveKey={['1']} expandIcon={({ isActive }) => <CaretRightOutlined rotate={isActive ? 90 : 0} />}>
            <Collapse.Panel header={headerPanelTitle} key="1" extra={headerExtra}>
              <Splitter>
                <Splitter.Panel defaultSize="80%" min="20%" max="80%">
                  {formEle}
                </Splitter.Panel>
                <Splitter.Panel>
                  <div style={{ padding: '0 0 0 16px' }}>
                    <Space>
                      <HistoryOutlined />
                      <span style={{ textDecoration: 'underline' }}>单据历史</span>
                    </Space>
                    <Divider />
                    <Spin spinning={historyLoading}>
                      {historyItems.length > 0 ? (
                        <Timeline items={historyItems} />
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史记录" />
                      )}
                    </Spin>
                  </div>
                </Splitter.Panel>
              </Splitter>
            </Collapse.Panel>
            {tableEle && (
              <Collapse.Panel header={detailPanelTitle} key="2" extra={detailExtra}>
                {tableEle}
              </Collapse.Panel>
            )}
          </Collapse>
        )}
      </div>
    </Modal>
    <Modal
      title="打印设计"
      open={openDesigner}
      onCancel={handleCloseDesigner}
      width={'80%'}
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
          isPreview={false}
          initialTemplateData={templateData}
          onSave={handleSaveTemplate}
        />
      )}
    </Spin>
    </Modal>
    </>
  );
}

export default SupaModal;
