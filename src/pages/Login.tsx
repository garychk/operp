import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs, Row, Col, Space, Tag, Divider } from 'antd';
import {
  AppstoreOutlined,
  DatabaseOutlined,
  GithubOutlined,
  LineChartOutlined,
  RobotOutlined,
  SafetyOutlined,
  WechatFilled,
} from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';

const { Title, Text } = Typography;

const featureSlides = [
  {
    badge: '核心能力',
    title: '面向中小型企业的一体化 ERP 平台',
    desc: '统一承载财务、进销存、生产制造与系统管理，帮助企业用更少的系统完成更多协同。',
    bullets: ['财务、库存、生产全链路打通', '标准化权限与组织管理', '可视化业务查询BAQ，动态页面设置'],
  },
  {
    badge: 'AI 亮点',
    title: '支持本地与远程模型的智能对话',
    desc: '可以连接 Ollama 或代理接口，结合真实 ERP 数据完成分析、问答与辅助决策。',
    bullets: ['多模型配置，灵活切换', 'ERP 数据增强回答', '自然语言创建业务数据'],
  },
  {
    badge: '数据能力',
    title: '围绕业务场景的真实数据驱动',
    desc: '通过 Supabase 直接连接数据库与认证体系，让业务数据、权限和审计保持统一。',
    bullets: ['Supabase 原生集成', '财务、库存、生产分析', '快速扩展，减少后端维护'],
  },
];

const featureCards = [
  {
    icon: <AppstoreOutlined />,
    title: 'BAQ 业务查询',
    desc: '可视化配置主表、关联表、筛选、聚合与排序的业务查询。',
  },
  {
    icon: <RobotOutlined />,
    title: 'AI 智能对话',
    desc: '支持模型切换、业务分析和自然语言创建常用业务数据。',
  },
  {
    icon: <DatabaseOutlined />,
    title: 'Supabase 驱动',
    desc: '认证、数据库、业务表统一管理，开发效率更高。',
  },
  {
    icon: <LineChartOutlined />,
    title: 'Dynamic 动态页面',
    desc: '支持组件化页面，接入静态或BAQ数据快速发布业务看板。',
  },
];

export const Login: React.FC = () => {
  const [form] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('login');
  const [activeSlide, setActiveSlide] = useState(0);
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % featureSlides.length);
    }, 4500);

    return () => window.clearInterval(timer);
  }, []);

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
            <Form.Item>
               <Divider><WechatFilled style={{fontSize:20,color: '#1aad19'}} /></Divider>
              <Divider><GithubOutlined /></Divider>
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
          radial-gradient(circle at 12% 18%, rgba(125, 211, 252, 0.45), transparent 28%),
          radial-gradient(circle at 86% 16%, rgba(196, 181, 253, 0.38), transparent 30%),
          radial-gradient(circle at 50% 96%, rgba(167, 243, 208, 0.34), transparent 36%),
          linear-gradient(135deg, #f8fafc 0%, #e2e8f0 35%, #eef2ff 100%)
        `,
      }}
    >
      <div className="relative z-10 w-full" style={{ width: 'min(1180px, 100%)' }}>
        <Row gutter={[28, 28]} align="stretch">
          <Col xs={24} lg={13}>
            <div style={{ color: '#0f172a' }}>
              <Space direction="vertical" size={20} style={{ width: '100%' }}>
                <Space size={10} wrap>
                  <Tag color="blue" style={{ marginInlineEnd: 0, padding: '4px 12px' }}>
                    OPERP 管理系统
                  </Tag>
                  <Tag color="cyan" style={{ marginInlineEnd: 0, padding: '4px 12px' }}>
                    AI + ERP
                  </Tag>
                </Space>

                <Title level={1} style={{ margin: 0, color: '#0f172a', lineHeight: 1.12 }}>
                  一套更适合成长型企业
                  <span style={{ color: '#2563eb' }}>智能管理平台</span>
                </Title>

                <div
                  style={{
                    position: 'relative',
                    minHeight: 300,
                    borderRadius: 22,
                    overflow: 'hidden',
                    background: 'linear-gradient(135deg, rgba(15,23,42,0.96), rgba(30,41,59,0.92))',
                    boxShadow: '0 22px 60px rgba(15, 23, 42, 0.16)',
                  }}
                >
                  {featureSlides.map((slide, index) => {
                    const active = index === activeSlide;
                    return (
                      <div
                        key={slide.title}
                        style={{
                          position: 'absolute',
                          inset: 0,
                          padding: 28,
                          opacity: active ? 1 : 0,
                          transform: active ? 'translateX(0)' : 'translateX(16px)',
                          transition: 'opacity 520ms ease, transform 520ms ease',
                          pointerEvents: active ? 'auto' : 'none',
                        }}
                      >
                        <Space direction="vertical" size={14} style={{ width: '100%' }}>
                          <Tag color="processing" style={{ width: 'fit-content', marginInlineEnd: 0, padding: '4px 12px' }}>
                            {slide.badge}
                          </Tag>
                          <Title level={3} style={{ margin: 0, color: '#fff' }}>
                            {slide.title}
                          </Title>
                          <Text style={{ color: '#cbd5e1', fontSize: 15, lineHeight: 1.7, maxWidth: 640 }}>
                            {slide.desc}
                          </Text>
                          <div style={{ display: 'grid', gap: 10, marginTop: 6 }}>
                            {slide.bullets.map((bullet) => (
                              <Space key={bullet} align="start" size={10}>
                                <SafetyOutlined style={{ color: '#38bdf8', marginTop: 4 }} />
                                <Text style={{ color: '#f8fafc' }}>{bullet}</Text>
                              </Space>
                            ))}
                          </div>
                        </Space>
                      </div>
                    );
                  })}
                  <div
                    style={{
                      position: 'absolute',
                      left: 28,
                      right: 28,
                      bottom: 18,
                      display: 'flex',
                      gap: 8,
                    }}
                  >
                    {featureSlides.map((_, index) => (
                      <div
                        key={index}
                        style={{
                          height: 4,
                          flex: 1,
                          borderRadius: 999,
                          background: index === activeSlide ? 'linear-gradient(90deg, #38bdf8, #60a5fa)' : 'rgba(255,255,255,0.18)',
                          transition: 'background 320ms ease',
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 16,
                  }}
                >
                  {featureCards.map((item) => (
                    <Card
                      key={item.title}
                      bordered={false}
                      style={{
                        borderRadius: 16,
                        background: 'rgba(255,255,255,0.72)',
                        boxShadow: '0 16px 40px rgba(15, 23, 42, 0.08)',
                        backdropFilter: 'blur(12px)',
                      }}
                    >
                      <Space align="start" size={14}>
                        <div
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: 12,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#2563eb',
                            background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.12), rgba(14, 165, 233, 0.08))',
                            flexShrink: 0,
                            fontSize: 20,
                          }}
                        >
                          {item.icon}
                        </div>
                        <div>
                          <Text strong style={{ display: 'block', color: '#0f172a', fontSize: 15 }}>
                            {item.title}
                          </Text>
                          <Text style={{ color: '#475569', lineHeight: 1.65 }}>
                            {item.desc}
                          </Text>
                        </div>
                      </Space>
                    </Card>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#334155' }}>
                  <Tag color="geekblue" style={{ padding: '6px 12px' }}>Supabase 后端即服务</Tag>
                  <Tag color="processing" style={{ padding: '6px 12px' }}>本地或远程大模型接入</Tag>
                  <Tag color="success" style={{ padding: '6px 12px' }}>BAQ 动态业务查询</Tag>
                </div>
              </Space>
            </div>
          </Col>

          <Col xs={24} lg={11}>
            <Card
              className="relative z-10"
              style={{
                width: '100%',
                boxShadow: '0 24px 70px rgba(59, 130, 246, 0.16)',
                borderRadius: '20px',
                border: '1px solid rgba(255,255,255,0.8)',
                background: 'rgba(255,255,255,0.88)',
                backdropFilter: 'blur(18px)',
                minHeight: 574,
                marginTop: 110,
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
                onChange={setActiveTab}
                items={items}
                centered
              />
            </Card>
          </Col>
        </Row>
      </div>
    </div>
  );
};


