import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs, Dropdown } from 'antd';
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

  const onRegister = async (values: { email: string; password: string; confirmPassword: string }) => {
    setLoading(true);
    setError('');
    setSuccess('');

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
    });

    if (signUpError) {
      setError(t('login.registerFailed', { message: signUpError.message }));
      setLoading(false);
      return;
    }

    if (data.user) {
      setSuccess(t('login.registerSuccess'));
      setActiveTab('login');
      registerForm.resetFields();
      form.setFieldsValue({ username: values.email });
    }

    setLoading(false);
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
      label: t('login.register'),
      children: (
        <>
          {alerts}

          <Form
            form={registerForm}
            name="register"
            onFinish={onRegister}
            layout="vertical"
          >
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

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={loading}
              >
                {t('login.register')}
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
        background: `
          radial-gradient(circle at 12% 18%, rgba(125, 211, 252, 0.45), transparent 28%),
          radial-gradient(circle at 86% 16%, rgba(196, 181, 253, 0.38), transparent 30%),
          radial-gradient(circle at 50% 96%, rgba(167, 243, 208, 0.34), transparent 36%),
          linear-gradient(135deg, #f8fafc 0%, #e2e8f0 35%, #eef2ff 100%)
        `,
      }}
    >
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
          maxWidth: 420,
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
            {activeTab === 'login' ? t('login.loginPrompt') : t('login.registerPrompt')}
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
