import { HomeOutlined, LogoutOutlined } from '@ant-design/icons';
import { Button, Result, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function Forbidden() {
  const navigate = useNavigate();
  const { logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div style={{ minHeight: 'calc(100vh - 180px)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Result
        status="403"
        title="403 Forbidden"
        subTitle="您没有权限访问此页面，请联系管理员分配相应的菜单权限。"
        extra={(
          <Space wrap>
            <Button type="primary" icon={<HomeOutlined />} onClick={() => navigate('/', { replace: true })}>
              返回首页
            </Button>
            <Button icon={<LogoutOutlined />} onClick={() => void handleLogout()}>
              退出登录
            </Button>
          </Space>
        )}
      />
    </div>
  );
}
