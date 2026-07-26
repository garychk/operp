import { Button, Space, message } from 'antd';
import type { ReactNode } from 'react';
import { CheckOutlined, CloseOutlined, RollbackOutlined, SendOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { runBusinessAction } from '../utils/businessEngine';

type WorkflowAction = 'submit' | 'approve' | 'reject' | 'withdraw';

type WorkflowActionBarProps = {
  documentType?: string;
  documentId?: string | number | null;
  currentStatus?: string | null;
  onActionDone?: () => void;
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

export function WorkflowActionBar({ documentType, documentId, currentStatus, onActionDone }: WorkflowActionBarProps) {
  const { t } = useTranslation();

  const handleWorkflowAction = async (action: WorkflowAction) => {
    if (!documentType || documentId === null || documentId === undefined) {
      message.error(t('workflow.actionBar.missingTarget'));
      return;
    }

    try {
      await runBusinessAction({
        action,
        documentType: documentType as any,
        documentId: Number(documentId),
      });
      message.success(t('workflow.actionBar.success.' + action));
      onActionDone?.();
    } catch (error) {
      const fallback = t('workflow.actionBar.failed.' + action);
      const msg = error instanceof Error ? error.message : fallback;
      message.error(msg || fallback);
    }
  };

  const actions = getAllowedActions(currentStatus);
  if (!actions.length) return null;

  return (
    <Space>
      {actions.map((action) => (
        <Button
          key={action}
          type={ACTION_CONFIG[action].type}
          danger={ACTION_CONFIG[action].danger}
          icon={ACTION_CONFIG[action].icon}
          onClick={() => void handleWorkflowAction(action)}
          size="small"
        >
          {t('workflow.actionBar.' + ACTION_CONFIG[action].key)}
        </Button>
      ))}
    </Space>
  );
}

export default WorkflowActionBar;
