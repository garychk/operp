import { useEffect, useState } from 'react';
import { Card, Empty, Spin, Timeline, Tag, Space } from 'antd';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';

interface WorkflowAction {
  id: number;
  action: string;
  action_label: string;
  actor_username: string | null;
  comment: string | null;
  from_status: string | null;
  to_status: string | null;
  from_node_key: string | null;
  to_node_key: string | null;
  acted_at: string | null;
}

interface WorkflowHistoryCardProps {
  open: boolean;
  documentType?: string;
  documentId?: string | number | null;
  title?: string;
}

export function WorkflowHistoryCard({
  open,
  documentType,
  documentId,
  title,
}: WorkflowHistoryCardProps) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<WorkflowAction[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchWorkflowHistory = async () => {
      if (!open || !documentType || documentId === null || documentId === undefined) {
        setActions([]);
        return;
      }

      setLoading(true);
      const { data: instanceData, error: instanceError } = await supabase
        .from('wf_process_instances')
        .select('id')
        .eq('is_deleted', 'n')
        .eq('document_type', documentType)
        .eq('document_id', documentId)
        .maybeSingle();

      if (instanceError || !instanceData) {
        setActions([]);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('wf_process_actions')
        .select('id, action, action_label, actor_username, comment, from_status, to_status, from_node_key, to_node_key, acted_at')
        .eq('is_deleted', 'n')
        .eq('instance_id', instanceData.id)
        .order('acted_at', { ascending: false });

      if (error) {
        console.error('Failed to fetch workflow history:', error);
        setActions([]);
      } else {
        setActions(data || []);
      }
      setLoading(false);
    };

    void fetchWorkflowHistory();
  }, [open, documentType, documentId]);

  const items = actions.map((item) => ({
    color: item.action === 'approve' ? 'green' : item.action === 'reject' ? 'red' : 'blue',
    content: (
      <Space direction="vertical" size={2}>
        <Space wrap>
          <span>{item.action_label}</span>
          <Tag>{item.action}</Tag>
          <span style={{ color: '#666' }}>{item.actor_username || 'anonymous'}</span>
        </Space>
        <span style={{ color: '#999', fontSize: 12 }}>
          {item.acted_at ? new Date(item.acted_at).toLocaleString() : '-'}
        </span>
        <span style={{ color: '#666', fontSize: 12 }}>
          {item.from_status || '-'} → {item.to_status || '-'}
        </span>
        {item.comment && <span style={{ color: '#555', fontSize: 12 }}>{item.comment}</span>}
      </Space>
    ),
  }));

  return (
    <Card title={title || t('workflow.workflowHistory.title')} size="small" variant="borderless" style={{ borderRadius: 0, marginTop: 12 }}>
      <Spin spinning={loading}>
        {items.length > 0 ? (
          <Timeline items={items} style={{ height: '300px', overflowY: 'auto' }} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workflow.workflowHistory.empty')} />
        )}
      </Spin>
    </Card>
  );
}
