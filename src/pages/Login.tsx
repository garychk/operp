import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs, Dropdown, Row, Col } from 'antd';
import { TranslationOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';
import type { SupportedLanguage } from '../i18n';

const { Title } = Typography;

export const Login: React.FC = () => {
  const [form] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('login');
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN') as SupportedLanguage;

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError('');
    setSuccess('');

    const successLogin = await login(values.username, values.password);

    if (successLogin) {
      navigate('/');
    } else {
      setError(t('login.loginFailed'));
    }

    setLoading(false);
  };

  type RegisterTenantValues = {
    tenantName: string;
    tenantCode: string;
    adminName?: string;
    adminUsername?: string;
    email: string;
    password: string;
    confirmPassword: string;
  };

  // 自助开通租户：注册登录账号 -> 建租户 -> 在该租户下建默认管理员 -> 登录进租户。
  // 建租户这一步必须由数据库侧 SECURITY DEFINER 函数 bootstrap_tenant 完成：
  // sys_tenants 的 INSERT 策略只放 super_admin，刚注册的账号插不进去。
  const onRegisterTenant = async (values: RegisterTenantValues) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const email = values.email.trim().toLowerCase();
      const tenantCode = values.tenantCode.trim().toLowerCase();
      const adminUsername = values.adminUsername?.trim() || email;

      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password: values.password,
        // 带上元数据，AuthProvider 自动建档时就能直接用上，避免二次改名
        options: {
          data: {
            username: adminUsername,
            real_name: values.adminName?.trim() || null,
          },
        },
      });

      if (signUpError) {
        setError(t('login.signupFailed', { message: signUpError.message }));
        return;
      }

      // 邮箱已注册时 Supabase 出于安全会返回一个「混淆的」user：id 是假的、
      // identities 为空数组。拿它去开通租户会得到一个永远登不上的管理员。
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setError(t('login.emailTaken'));
        return;
      }

      if (!data.user) {
        setError(t('login.signupFailed', { message: 'no user returned' }));
        return;
      }

      const { error: bootstrapError } = await supabase.rpc('bootstrap_tenant', {
        p_tenant_code: tenantCode,
        p_tenant_name: values.tenantName.trim(),
        p_admin_real_name: values.adminName?.trim() || null,
        p_admin_username: adminUsername,
        p_admin_phone: null,
        p_tenant_remark: null,
      });

      if (bootstrapError) {
        setError(t('login.bootstrapFailed', { message: bootstrapError.message }));
        return;
      }

      // 刷新 token：让 Custom Access Token Hook 把 tenant_id 写进 app_metadata，
      // 否则本次会话的 JWT 里还是没有租户信息。失败不影响登录，忽略即可。
      await supabase.auth.refreshSession().catch(() => undefined);

      const successLogin = await login(email, values.password);

      if (successLogin) {
        navigate('/');
      } else {
        setSuccess(t('login.registerTenantSuccessRelogin', { name: values.tenantName.trim() }));
        setActiveTab('login');
        registerForm.resetFields();
        form.setFieldsValue({ username: email });
      }
    } catch (err) {
      setError(t('login.bootstrapFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  };

  const alerts = (
    <>
      {error && (
        <Alert
          message={error}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {success && (
        <Alert
          message={success}
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}
    </>
  );

  const items = [
    {
      key: 'login',
      label: t('login.login'),
      children: (
        <>
          {alerts}

          <Form
            form={form}
            name="login"
            onFinish={onFinish}
            layout="vertical"
          >
            <Form.Item
              name="username"
              label={t('login.email')}
              rules={[
                { required: true, message: t('login.emailRequired') },
                { type: 'email', message: t('login.invalidEmail') },
              ]}
            >
              <Input
                placeholder={t('login.emailPlaceholder')}
                size="large"
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={t('login.password')}
              rules={[
                { required: true, message: t('login.passwordRequired') },
              ]}
            >
              <Input.Password
                placeholder={t('login.passwordPlaceholder')}
                size="large"
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={loading}
              >
                {t('login.login')}
              </Button>
            </Form.Item>
          </Form>
        </>
      ),
    },
    {
      key: 'register',
      label: t('login.registerTenant'),
      children: (
        <>
          {alerts}

          <Form
            form={registerForm}
            name="register"
            onFinish={onRegisterTenant}
            layout="vertical"
          >
            <Row gutter={16}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="tenantName"
                  label={t('login.tenantName')}
                  rules={[
                    { required: true, message: t('login.tenantNameRequired') },
                  ]}
                >
                  <Input
                    placeholder={t('login.tenantNamePlaceholder')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} sm={12}>
                <Form.Item
                  name="tenantCode"
                  label={t('login.tenantCode')}
                  rules={[
                    { required: true, message: t('login.tenantCodeRequired') },
                    {
                      pattern: /^[a-z][a-z0-9_-]{1,30}$/,
                      message: t('login.tenantCodeInvalid'),
                    },
                  ]}
                >
                  <Input
                    placeholder={t('login.tenantCodePlaceholder')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} sm={12}>
                <Form.Item
                  name="adminName"
                  label={t('login.adminName')}
                >
                  <Input
                    placeholder={t('login.adminNamePlaceholder')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} sm={12}>
                <Form.Item
                  name="adminUsername"
                  label={t('login.adminUsername')}
                >
                  <Input
                    placeholder={t('login.adminUsernamePlaceholder')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col span={24}>
                <Form.Item
                  name="email"
                  label={t('login.email')}
                  rules={[
                    { required: true, message: t('login.emailRequired') },
                    { type: 'email', message: t('login.invalidEmail') },
                  ]}
                >
                  <Input
                    placeholder={t('login.emailPlaceholderRegister')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} sm={12}>
                <Form.Item
                  name="password"
                  label={t('login.password')}
                  rules={[
                    { required: true, message: t('login.passwordRequired') },
                    { min: 6, message: t('login.passwordTooShort') },
                  ]}
                >
                  <Input.Password
                    placeholder={t('login.passwordPlaceholderRegister')}
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} sm={12}>
                <Form.Item
                  name="confirmPassword"
                  label={t('login.confirmPassword')}
                  dependencies={['password']}
                  rules={[
                    { required: true, message: t('login.confirmPasswordRequired') },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error(t('login.passwordMismatch')));
                      },
                    }),
                  ]}
                >
                  <Input.Password
                    placeholder={t('login.confirmPasswordPlaceholder')}
                    size="large"
                  />
                </Form.Item>
              </Col>
            </Row>

            <div style={{ marginBottom: 16, fontSize: 12, color: '#8c8c8c' }}>
              {t('login.registerTenantHint')}
            </div>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={loading}
              >
                {t('login.registerTenant')}
              </Button>
            </Form.Item>
          </Form>
        </>
      ),
    },
  ];

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8"
      style={{
        background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 35%, #eef2ff 100%)',
      }}
    >
      <div className="login-bg" aria-hidden>
        <span className="login-bg__blob login-bg__blob--sky" />
        <span className="login-bg__blob login-bg__blob--violet" />
        <span className="login-bg__blob login-bg__blob--mint" />
        <span className="login-bg__sheen" />
      </div>

      <div style={{ position: 'absolute', top: 24, right: 24, zIndex: 20 }}>
        <Dropdown
          trigger={['click']}
          menu={{
            selectable: true,
            selectedKeys: [language],
            onClick: ({ key }) => {
              void i18n.changeLanguage(key as SupportedLanguage);
            },
            items: [
              { key: 'zh-CN', label: t('language.zhCN') },
              { key: 'en-US', label: t('language.enUS') },
            ],
          }}
        >
          <TranslationOutlined
            title={t('language.switch')}
            style={{ fontSize: 20, color: '#475569', cursor: 'pointer', padding: 8 }}
          />
        </Dropdown>
      </div>

      <Card
        className="relative z-10"
        style={{
          width: '100%',
          // 注册租户是两列布局，420 挤放不下，切到该 tab 时把卡片放宽
          maxWidth: activeTab === 'register' ? 720 : 420,
          boxShadow: '0 24px 70px rgba(59, 130, 246, 0.16)',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.8)',
          background: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 8, color: '#0f172a' }}>
            OPERP
          </Title>
          <p style={{ color: '#64748b', marginBottom: 0 }}>
            {activeTab === 'login' ? t('login.loginPrompt') : t('login.registerTenantPrompt')}
          </p>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            setError('');
            setSuccess('');
          }}
          items={items}
          centered
        />
      </Card>
    </div>
  );
};
