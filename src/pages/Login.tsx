import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs } from 'antd';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';

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

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError('');
    setSuccess('');

    const successLogin = await login(values.username, values.password);

    if (successLogin) {
      navigate('/');
    } else {
      setError('登录失败，请检查用户名和密码');
    }

    setLoading(false);
  };

  const onRegister = async (values: { email: string; password: string; confirmPassword: string }) => {
    setLoading(true);
    setError('');
    setSuccess('');

    if (values.password !== values.confirmPassword) {
      setError('两次输入的密码不一致');
      setLoading(false);
      return;
    }

    if (values.password.length < 6) {
      setError('密码长度至少6位');
      setLoading(false);
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
    });

    if (signUpError) {
      setError('注册失败: ' + signUpError.message);
      setLoading(false);
      return;
    }

    if (data.user) {
      setSuccess('注册成功！请使用邮箱和密码登录');
      setActiveTab('login');
      registerForm.resetFields();
      form.setFieldsValue({ username: values.email });
    }

    setLoading(false);
  };

  const items = [
    {
      key: 'login',
      label: '登录',
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
              label="邮箱"
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '请输入有效的邮箱地址' },
              ]}
            >
              <Input
                placeholder="请输入邮箱"
                size="large"
              />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
              ]}
            >
              <Input.Password
                placeholder="请输入密码"
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
                登录
              </Button>
            </Form.Item>
          </Form>
        </>
      ),
    },
    {
      key: 'register',
      label: '注册',
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
              label="邮箱"
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '请输入有效的邮箱地址' },
              ]}
            >
              <Input
                placeholder="请输入邮箱（将作为登录账号）"
                size="large"
              />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 6, message: '密码长度至少6位' },
              ]}
            >
              <Input.Password
                placeholder="请输入密码（至少6位）"
                size="large"
              />
            </Form.Item>

            <Form.Item
              name="confirmPassword"
              label="确认密码"
              dependencies={['password']}
              rules={[
                { required: true, message: '请确认密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'));
                  },
                }),
              ]}
            >
              <Input.Password
                placeholder="请再次输入密码"
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
                注册
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
          radial-gradient(circle at 15% 15%, rgba(56, 189, 248, 0.38), transparent 28%),
          radial-gradient(circle at 85% 20%, rgba(168, 85, 247, 0.34), transparent 30%),
          radial-gradient(circle at 50% 100%, rgba(16, 185, 129, 0.24), transparent 36%),
          linear-gradient(135deg, #020617 0%, #0f172a 45%, #312e81 100%)
        `,
      }}
    >
      <Card
        className="relative z-10"
        style={{
          width: 'min(450px, 100%)',
          boxShadow: '0 24px 70px rgba(2, 6, 23, 0.38)',
          borderRadius: '16px',
          border: '1px solid rgba(255,255,255,0.42)',
          background: 'rgba(255,255,255,0.9)',
          backdropFilter: 'blur(18px)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 8 }}>
            Supabase ERP
          </Title>
          <p style={{ color: '#666' }}>
            {activeTab === 'login' ? '请登录您的账户' : '创建新账户'}
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
