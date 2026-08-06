import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs, Row, Col, Space, Tag, Dropdown } from 'antd';
import {
  AppstoreOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  RobotOutlined,
  SafetyOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';
import type { SupportedLanguage } from '../i18n';

const { Title, Text } = Typography;

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
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN') as SupportedLanguage;

  const featureSlides = [
    {
      badge: t('login.hero.badgeCore'),
      title: t('login.hero.titleCore'),
      desc: t('login.hero.descCore'),
      bullets: [t('login.hero.bullet1Core'), t('login.hero.bullet2Core'), t('login.hero.bullet3Core')],
    },
    {
      badge: t('login.hero.badgeAI'),
      title: t('login.hero.titleAI'),
      desc: t('login.hero.descAI'),
      bullets: [t('login.hero.bullet1AI'), t('login.hero.bullet2AI'), t('login.hero.bullet3AI')],
    },
    {
      badge: t('login.hero.badgeData'),
      title: t('login.hero.titleData'),
      desc: t('login.hero.descData'),
      bullets: [t('login.hero.bullet1Data'), t('login.hero.bullet2Data'), t('login.hero.bullet3Data')],
    },
  ];

  const featureCards = [
    { icon: <AppstoreOutlined />, title: t('login.features.baqTitle'), desc: t('login.features.baqDesc') },
    { icon: <RobotOutlined />, title: t('login.features.aiTitle'), desc: t('login.features.aiDesc') },
    { icon: <DatabaseOutlined />, title: t('login.features.supabaseTitle'), desc: t('login.features.supabaseDesc') },
    { icon: <LineChartOutlined />, title: t('login.features.dynamicTitle'), desc: t('login.features.dynamicDesc') },
  ];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % featureSlides.length);
    }, 4500);

    return () => window.clearInterval(timer);
  }, [featureSlides.length]);

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
            {/* <Form.Item>
               <Divider><WechatFilled style={{fontSize:20,color: '#1aad19'}} /></Divider>
               <Divider><GithubOutlined /></Divider>
            </Form.Item> */}
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
      <div className="relative z-10 w-full" style={{ width: '70%' }}>
        <Space orientation="vertical" size={20} style={{ marginBottom: 20 }}>
          <Space size={10} wrap>
                  <Tag color="blue" style={{ marginInlineEnd: 0, padding: '4px 12px' }}>
                    {t('login.tag.operp')}
                  </Tag>
                  <Tag color="cyan" style={{ marginInlineEnd: 0, padding: '4px 12px' }}>
                    {t('login.tag.aiErp')}
                  </Tag>
                </Space>

                <Title level={1} style={{ margin: 0, color: '#0f172a', lineHeight: 1.12 }}>
                  {t('login.heroHeading1')}
                  <span style={{ color: '#2563eb' }}>{t('login.heroHeading2')}</span>
                </Title>
        </Space>
        <Row gutter={[28, 28]} align="stretch">
          <Col xs={24} lg={15}>
            <div style={{ color: '#0f172a' }}>
              <Space orientation="vertical" size={20} style={{ width: '100%' }}> 
                 <div
                  style={{
                    position: 'relative',
                    minHeight: 330,
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
                  <Tag color="geekblue" style={{ padding: '6px 12px' }}>{t('login.tag.supabase')}</Tag>
                  <Tag color="processing" style={{ padding: '6px 12px' }}>{t('login.tag.llm')}</Tag>
                  <Tag color="success" style={{ padding: '6px 12px' }}>{t('login.tag.baq')}</Tag>
                </div>
              </Space>
            </div>
          </Col>

          <Col xs={24} lg={9}>
            <Card
              className="relative z-10"
              style={{
                width: '100%',
                boxShadow: '0 24px 70px rgba(59, 130, 246, 0.16)',
                borderRadius: '20px',
                border: '1px solid rgba(255,255,255,0.8)',
                background: 'rgba(255,255,255,0.88)',
                backdropFilter: 'blur(18px)',
                minHeight: 570,
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


