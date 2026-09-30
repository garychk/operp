import { Card } from 'antd';
import { AIChatPanel } from '../components/AIChatPanel';

/**
 * 首页即 AI Agent 对话页。与右上角 AI 抽屉共用同一个 AIChatPanel 组件，
 * 只是这里用整页（variant="page"）形态渲染，空间更大。
 */
export function Dashboard() {
  return (
    <Card
      variant="borderless"
    >
    <div className="ai-chat-page">
      <AIChatPanel variant="page" />
    </div>
    </Card>
  );
}
