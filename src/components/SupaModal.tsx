import { useState } from 'react';
import { Modal, Space, Button, Collapse, Splitter, Timeline, Tag, Divider } from 'antd';
import { CompressOutlined, FullscreenOutlined, LeftOutlined, RightOutlined, CaretRightOutlined, HistoryOutlined, CheckOutlined, PrinterOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';

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
  width = 1200,
  height = 800,
  children,
}: SupaModalProps) {
  const [isExpand, setIsExpand] = useState(false);

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

  return (
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
          <Button type='default' size="small" icon={<PrinterOutlined />} />
          <Tag>按ESC键可关闭</Tag>
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
                    <Timeline
                      items={[
                        {
                          content: 'Create a services site 2015-09-01',
                        },
                        {
                          content: 'Solve initial network problems 2015-09-01',
                        },
                        {
                          content: 'Technical testing 2015-09-01',
                        },
                        {
                          content: 'Network problems being solved 2015-09-01',
                        },
                      ]}
                    />
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
  );
}

export default SupaModal;
