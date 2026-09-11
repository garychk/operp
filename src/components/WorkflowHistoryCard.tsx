import { useEffect, useState } from 'react';
import { Card, Empty, Spin, Timeline, Tag, Space, Descriptions } from 'antd';
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

interface WorkflowProcessDefinition {
  process_name: string | null;
  process_code: string | null;
  version: number | null;
}

interface WorkflowInstance {
  id: number;
  status: string | null;
  current_node_name: string | null;
  process_id: number | null;
  wf_process_definitions: WorkflowProcessDefinition | null;
}

const STATUS_TAG: Record<string, { color: string; i18nKey: string }> = {
  draft: { color: 'default', i18nKey: 'workflow.status.draft' },
  pending: { color: 'warning', i18nKey: 'workflow.status.pending' },
  approved: { color: 'success', i18nKey: 'workflow.status.approved' },
};

interface WorkflowHistoryCardProps {
  open: boolean;
  documentType?: string;
  documentId?: string | number | null;
  title?: string;
  /** Bump this value to force a refetch (e.g. after a workflow action). */
  refreshKey?: number;
}

export function WorkflowHistoryCard({
  open,
  documentType,
  documentId,
  title,
  refreshKey = 0,
}: WorkflowHistoryCardProps) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<WorkflowAction[]>([]);
  const [instance, setInstance] = useState<WorkflowInstance | null>(null);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchWorkflowHistory = async () => {
      setInstance(null);
      setNodeNames({});
      setActions([]);
      if (!open || !documentType || documentId === null || documentId === undefined) {
        return;
      }

      setLoading(true);
      const { data: instanceData, error: instanceError } = await supabase
        .from('wf_process_instances')
        .select('id, status, current_node_name, process_id, wf_process_definitions(process_name, process_code, version)')
        .eq('is_deleted', 'n')
        .eq('document_type', documentType)
        .eq('document_id', documentId)
        .maybeSingle();

      if (instanceError || !instanceData) {
        setLoading(false);
        return;
      }

      // PostgREST returns the embedded definition as an object; some client
      // typings widen it to an array, so normalize both shapes.
      const rawProcess = (instanceData as { wf_process_definitions?: unknown }).wf_process_definitions;
      const process = Array.isArray(rawProcess) ? rawProcess[0] : rawProcess;
      setInstance({ ...instanceData, wf_process_definitions: (process as WorkflowProcessDefinition) ?? null });

      // Fetch node display names for this process so the timeline can show
      // node names instead of raw node keys.
      if (instanceData.process_id) {
        const { data: nodeData } = await supabase
          .from('wf_process_nodes')
          .select('node_key, node_name')
          .eq('process_id', instanceData.process_id)
          .eq('is_deleted', 'n');
        if (nodeData) {
          const map: Record<string, string> = {};
          for (const node of nodeData) {
            if (node.node_key) map[node.node_key] = node.node_name || node.node_key;
          }
          setNodeNames(map);
        }
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
  }, [open, documentType, documentId, refreshKey]);

  const nodeName = (key: string | null) => (key ? nodeNames[key] || key : null);

  const statusTag = instance?.status ? STATUS_TAG[instance.status] : undefined;
  const process = instance?.wf_process_definitions;

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
          {nodeName(item.from_node_key) || '-'} → {nodeName(item.to_node_key) || '-'}
        </span>
        {item.comment && <span style={{ color: '#555', fontSize: 12 }}>{item.comment}</span>}
      </Space>
    ),
  }));

  return (
    <Card title={title || t('workflow.workflowHistory.title')} size="small" variant="borderless" style={{ borderRadius: 0, marginTop: 12 }}>
      <Spin spinning={loading}>
        {instance ? (
          <Descriptions
            size="small"
            column={1}
            style={{ marginBottom: 12 }}
            items={[
              {
                key: 'process',
                label: t('workflow.instance.process'),
                children: process ? (
                  <Space wrap size={4}>
                    <span style={{ fontWeight: 600 }}>{process.process_name || process.process_code || '-'}</span>
                    {process.version != null && <Tag>v{process.version}</Tag>}
                    {process.process_code && <span style={{ color: '#999', fontSize: 12 }}>{process.process_code}</span>}
                  </Space>
                ) : (
                  '-'
                ),
              },
              {
                key: 'node',
                label: t('workflow.instance.currentNode'),
                children: instance.current_node_name || '-',
              },
              {
                key: 'status',
                label: t('common.status'),
                children: statusTag ? (
                  <Tag color={statusTag.color}>{t(statusTag.i18nKey)}</Tag>
                ) : (
                  instance.status || '-'
                ),
              },
            ]}
          />
        ) : null}
        {items.length > 0 ? (
          <Timeline items={items} style={{ height: '300px', overflowY: 'auto' }} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workflow.workflowHistory.empty')} />
        )}
      </Spin>
    </Card>
  );
}
