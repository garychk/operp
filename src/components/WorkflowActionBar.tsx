import { Alert, Button, Space, message } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { CheckOutlined, CloseOutlined, RollbackOutlined, SendOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { runBusinessAction } from '../utils/businessEngine';
import { supabase } from '../utils/supabase';

type WorkflowAction = 'submit' | 'approve' | 'reject' | 'withdraw';

export interface WorkflowActionResult {
  ok?: boolean;
  status?: string | null;
  node_name?: string | null;
}

type WorkflowActionBarProps = {
  documentType?: string;
  documentId?: string | number | null;
  currentStatus?: string | null;
  onActionDone?: (result?: WorkflowActionResult) => void;
  disabled?: boolean;
};

const ACTION_CONFIG: Record<WorkflowAction, { icon: ReactNode; key: string; type?: 'primary' | 'default' | 'text'; danger?: boolean }> = {
  submit: { icon: <SendOutlined />, key: 'submit', type: 'primary' },
  approve: { icon: <CheckOutlined />, key: 'approve', type: 'default' },
  reject: { icon: <CloseOutlined />, key: 'reject', type: 'default', danger: true },
  withdraw: { icon: <RollbackOutlined />, key: 'withdraw', type: 'default' },
};

function getAllowedActions(status?: string | null): WorkflowAction[] {
  if (status === 'draft' || !status) return ['submit'];
  if (status === 'pending') return ['approve', 'reject', 'withdraw'];
  return [];
}

export function WorkflowActionBar({ documentType, documentId, currentStatus, onActionDone, disabled = false }: WorkflowActionBarProps) {
  const { t } = useTranslation();
  const [checkingWorkflow, setCheckingWorkflow] = useState(false);
  const [hasAvailableWorkflow, setHasAvailableWorkflow] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Existing instances must remain actionable if a process is later disabled.
    if (currentStatus && currentStatus !== 'draft') {
      setHasAvailableWorkflow(true);
      setCheckingWorkflow(false);
      return () => { cancelled = true; };
    }
    if (!documentType) {
      setHasAvailableWorkflow(null);
      setCheckingWorkflow(false);
      return () => { cancelled = true; };
    }

    setCheckingWorkflow(true);
    void supabase.rpc('workflow_get_active_process', { p_document_type: documentType }).then(({ data, error }) => {
      if (cancelled) return;
      setCheckingWorkflow(false);
      setHasAvailableWorkflow(!error && data !== null && data !== undefined);
    });

    return () => { cancelled = true; };
  }, [currentStatus, documentType]);

  const handleWorkflowAction = async (action: WorkflowAction) => {
    if (!documentType || documentId === null || documentId === undefined) {
      message.error(t('workflow.actionBar.missingTarget'));
      return;
    }

    try {
      const result = await runBusinessAction({
        action,
        documentType: documentType as any,
        documentId: Number(documentId),
      });
      message.success(t('workflow.actionBar.success.' + action));
      onActionDone?.(result as WorkflowActionResult);
    } catch (error) {
      const fallback = t('workflow.actionBar.failed.' + action);
      const msg = error instanceof Error ? error.message : fallback;
      message.error(msg || fallback);
    }
  };

  const actions = getAllowedActions(currentStatus);
  if (!actions.length) return null;
  if (!checkingWorkflow && hasAvailableWorkflow === false) {
    return <Alert type="warning" showIcon message={t('workflow.actionBar.workflowMissing', { documentType })} />;
  }

  return (
    <Space>
      {actions.map((action) => (
        <Button
          key={action}
          type={ACTION_CONFIG[action].type}
          danger={ACTION_CONFIG[action].danger}
          icon={ACTION_CONFIG[action].icon}
          onClick={() => void handleWorkflowAction(action)}
          disabled={disabled || checkingWorkflow || hasAvailableWorkflow !== true}
          loading={checkingWorkflow}          
        >
          {t('workflow.actionBar.' + ACTION_CONFIG[action].key)}
        </Button>
      ))}
    </Space>
  );
}

export default WorkflowActionBar;
