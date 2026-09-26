import { useTranslation } from 'react-i18next';
import { Drawer } from "antd";
import { AIChatPanel } from "./AIChatPanel";

interface AIChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 抽屉形态的 AI 助手。交互逻辑全部在 AIChatPanel 里，
 * 和 Dashboard 的整页形态共用同一份实现。
 */
export function AIChatDrawer({ open, onClose }: AIChatDrawerProps) {
  const { t } = useTranslation();

  return (
    <Drawer
      size={560}
      open={open}
      onClose={onClose}
      title={t("aiChat.title")}
      className="ai-chat-drawer"
      destroyOnHidden={false}
    >
      <AIChatPanel active={open} variant="drawer" onNavigate={onClose} />
    </Drawer>
  );
}
