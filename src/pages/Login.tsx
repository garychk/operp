import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs } from 'antd';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();

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

    if (values.password !== values.confirmPassword) {
      setError(t('login.passwordMismatch'));
      setLoading(false);
      return;
    }

    if (values.password.length < 6) {
      setError(t('login.passwordTooShort'));
      setLoading(false);
      return;
    }

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

  const items = [
    {
      key: 'login',
      label: t('login.login'),
      children: (
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

            <Form.Item>
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

            <Form.Item>
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
          radial-gradient(circle at 12% 18%, rgba(125, 211, 252, 0.5), transparent 30%),
          radial-gradient(circle at 86% 16%, rgba(196, 181, 253, 0.42), transparent 32%),
          radial-gradient(circle at 50% 96%, rgba(167, 243, 208, 0.42), transparent 36%),
          linear-gradient(135deg, #f8fafc 0%, #e0f2fe 42%, #ede9fe 100%)
        `,
      }}
    >
      <Card
        className="relative z-10"
        style={{
          width: 'min(450px, 100%)',
          boxShadow: '0 24px 70px rgba(59, 130, 246, 0.18)',
          borderRadius: '16px',
          border: '1px solid rgba(255,255,255,0.78)',
          background: 'rgba(255,255,255,0.86)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 8 }}>
            {t('login.title')}
          </Title>
          <p style={{ color: '#666' }}>
            {activeTab === 'login' ? t('login.loginPrompt') : t('login.registerPrompt')}
          </p>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={items}
          centered
        />
      </Card>
    </div>
  );
};
