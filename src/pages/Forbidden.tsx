import { HomeOutlined, LogoutOutlined } from '@ant-design/icons';
import { Button, Result, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function Forbidden() {
  const { t } = useTranslation();
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
        title={t('forbidden.title')}
        subTitle={t('forbidden.description')}
        extra={(
          <Space wrap>
            <Button type="primary" icon={<HomeOutlined />} onClick={() => navigate('/', { replace: true })}>
              {t('forbidden.backToHome')}
            </Button>
            <Button icon={<LogoutOutlined />} onClick={() => void handleLogout()}>
              {t('common.logout')}
            </Button>
          </Space>
        )}
      />
    </div>
  );
}
