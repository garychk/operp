import { useEffect, useState } from 'react';
import { Modal, Space, Button, Collapse, Splitter, Timeline, Tag, Divider, Empty, Spin } from 'antd';
import { CompressOutlined, FullscreenOutlined, LeftOutlined, RightOutlined, CaretRightOutlined, HistoryOutlined, CheckOutlined, PrinterOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';
import  PrintDesigner  from 'operp-print-designer';
import 'operp-print-designer/dist/operp-print-designer.css';
import { supabase } from '../utils/supabase';

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
  width = 1200,
  height = 800,
  children,
}: SupaModalProps) {
  const [isExpand, setIsExpand] = useState(false);
  const [openDesigner, setOpenDesigner] = useState(false);
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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
          <Button type='default' size="small" icon={<PrinterOutlined />} onClick={() => setOpenDesigner(true)} />
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
      onCancel={() => setOpenDesigner(false)}
      width={'80%'}
      styles={{
        body: { height: 'calc(90vh - 50px)', overflow: 'auto' },
      }}
      style={{ top: 16 }}
      keyboard
      footer={null}
    >
    <PrintDesigner
      isPreview={false}
      onSave={(data: any) => {
        console.log('保存模板:', data);
      }}
    />
    </Modal>
    </>
  );
}

export default SupaModal;
