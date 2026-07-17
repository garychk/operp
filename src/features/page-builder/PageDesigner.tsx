import { useEffect, useMemo, useState } from 'react';
import { AppstoreAddOutlined, BarChartOutlined, DeleteOutlined, EyeOutlined, LineChartOutlined, PieChartOutlined, PlusOutlined, SaveOutlined, SendOutlined, TableOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Drawer, Empty, Form, Input, InputNumber, message, Modal, Popconfirm, Segmented, Select, Space, Typography } from 'antd';
import type { Layout } from 'react-grid-layout';
import { listCustomPages, publishCustomPage, saveCustomPage } from './api';
import { PageCanvas } from './PageRenderer';
import type { CustomPage, PageWidget, WidgetType } from './types';
import { widgetDefaults } from './types';
import './page-builder.css';

const palette: Array<{ type: WidgetType; label: string; icon: React.ReactNode }> = [
  { type: 'text', label: '文本', icon: <AppstoreAddOutlined /> }, { type: 'statistic', label: '指标', icon: <AppstoreAddOutlined /> },
  { type: 'button', label: '按钮', icon: <AppstoreAddOutlined /> }, { type: 'table', label: '表格', icon: <TableOutlined /> },
  { type: 'line', label: '折线图', icon: <LineChartOutlined /> }, { type: 'column', label: '柱状图', icon: <BarChartOutlined /> }, { type: 'pie', label: '饼图', icon: <PieChartOutlined /> },
];

const emptyPage = (): CustomPage => ({ name: '未命名页面', slug: `page-${Date.now()}`, description: '', status: 'draft', config: { widgets: [] } });

export function PageDesigner() {
  const [pages, setPages] = useState<CustomPage[]>([]);
  const [page, setPage] = useState<CustomPage>(emptyPage);
  const [selectedId, setSelectedId] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const selected = useMemo(() => page.config.widgets.find(item => item.id === selectedId), [page, selectedId]);

  const refresh = () => listCustomPages().then(setPages).catch(() => message.error('页面列表加载失败'));
  useEffect(() => { void refresh(); }, []);

  const patchWidget = (patch: Partial<PageWidget>) => setPage(current => ({ ...current, config: { widgets: current.config.widgets.map(item => item.id === selectedId ? { ...item, ...patch } : item) } }));
  const addWidget = (type: WidgetType) => {
    const defaults = widgetDefaults[type];
    const widget: PageWidget = { ...defaults, id: `${type}-${Date.now()}`, type, x: 0, y: Infinity };
    setPage(current => ({ ...current, config: { widgets: [...current.config.widgets, widget] } }));
    setSelectedId(widget.id);
  };
  const save = async () => {
    setSaving(true);
    try { const saved = await saveCustomPage(page); setPage(saved); message.success('草稿已保存'); refresh(); } catch (error) { message.error(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); }
  };
  const publish = async (values: Pick<CustomPage, 'name' | 'slug' | 'description'>) => {
    setSaving(true);
    try { const saved = await publishCustomPage({ ...page, ...values }); setPage(saved); setPublishOpen(false); message.success('发布成功，菜单已生成'); refresh(); } catch (error) { message.error(error instanceof Error ? error.message : '发布失败'); } finally { setSaving(false); }
  };
  const updateLayout = (layout: Layout[]) => setPage(current => ({ ...current, config: { widgets: current.config.widgets.map(widget => { const item = layout.find(entry => entry.i === widget.id); return item ? { ...widget, x: item.x, y: item.y, w: item.w, h: item.h } : widget; }) } }));

  return <div className="page-designer">
    <div className="designer-toolbar">
      <Space><Typography.Title level={4}>页面设计器</Typography.Title><Select value={page.id || 'new'} style={{ width: 220 }} onChange={value => { if (value === 'new') setPage(emptyPage()); else setPage(pages.find(item => item.id === value) || emptyPage()); setSelectedId(undefined); }} options={[{ value: 'new', label: '新建页面' }, ...pages.map(item => ({ value: item.id!, label: `${item.name}${item.status === 'published' ? ' · 已发布' : ''}` }))]} /></Space>
      <Space><Button icon={<EyeOutlined />} onClick={() => setPreview(true)}>预览</Button><Button icon={<SaveOutlined />} loading={saving} onClick={save}>保存</Button><Button type="primary" icon={<SendOutlined />} onClick={() => setPublishOpen(true)}>发布</Button></Space>
    </div>
    <div className="designer-workspace">
      <aside className="component-palette"><Typography.Text strong>组件</Typography.Text><div className="palette-grid">{palette.map(item => <Button key={item.type} icon={item.icon} onClick={() => addWidget(item.type)}>{item.label}</Button>)}</div><Divider /><Typography.Text strong>页面</Typography.Text><Input value={page.name} onChange={event => setPage({ ...page, name: event.target.value })} placeholder="页面名称" /><Input value={page.description || ''} onChange={event => setPage({ ...page, description: event.target.value })} placeholder="页面描述" /></aside>
      <main className="designer-canvas">{page.config.widgets.length ? <PageCanvas page={page} editable selectedId={selectedId} onSelect={setSelectedId} onLayoutChange={updateLayout} /> : <Empty description="从左侧添加组件" />}</main>
      <aside className="property-panel">{selected ? <><div className="property-title"><Typography.Text strong>组件属性</Typography.Text><Popconfirm title="删除此组件？" onConfirm={() => { setPage(current => ({ ...current, config: { widgets: current.config.widgets.filter(item => item.id !== selected.id) } })); setSelectedId(undefined); }}><Button danger type="text" icon={<DeleteOutlined />} /></Popconfirm></div><Form layout="vertical" size="small">
        <Form.Item label="标题"><Input value={selected.title} onChange={event => patchWidget({ title: event.target.value })} /></Form.Item>
        {(selected.type === 'text' || selected.type === 'button') && <Form.Item label="内容"><Input.TextArea value={selected.content} onChange={event => patchWidget({ content: event.target.value })} /></Form.Item>}
        <Space><Form.Item label="列坐标 X"><InputNumber min={0} max={Math.max(0, 12 - selected.w)} value={selected.x} onChange={value => patchWidget({ x: value ?? 0 })} /></Form.Item><Form.Item label="行坐标 Y"><InputNumber min={0} value={selected.y} onChange={value => patchWidget({ y: value ?? 0 })} /></Form.Item></Space>
        <Space><Form.Item label="宽度"><InputNumber min={2} max={12} value={selected.w} onChange={value => { const w = value || 2; patchWidget({ w, x: Math.min(selected.x, 12 - w) }); }} /></Form.Item><Form.Item label="高度"><InputNumber min={2} max={12} value={selected.h} onChange={value => patchWidget({ h: value || 2 })} /></Form.Item></Space>
        <Divider>数据源</Divider><Form.Item><Segmented block value={selected.dataSource.mode} options={[{ label: '静态 JSON', value: 'static' }, { label: 'Supabase', value: 'supabase' }]} onChange={mode => patchWidget({ dataSource: { ...selected.dataSource, mode: mode as 'static' | 'supabase' } })} /></Form.Item>
        {selected.dataSource.mode === 'static' ? <Form.Item label="JSON 数组"><Input.TextArea rows={6} value={JSON.stringify(selected.dataSource.staticData || [], null, 2)} onBlur={event => { try { const value = JSON.parse(event.target.value); if (!Array.isArray(value)) throw new Error(); patchWidget({ dataSource: { ...selected.dataSource, staticData: value } }); } catch { message.error('请输入合法的 JSON 数组'); } }} onChange={event => { try { patchWidget({ dataSource: { ...selected.dataSource, staticData: JSON.parse(event.target.value) } }); } catch { /* validate on blur */ } }} /></Form.Item> : <><Form.Item label="表名"><Input value={selected.dataSource.table} onChange={event => patchWidget({ dataSource: { ...selected.dataSource, table: event.target.value } })} /></Form.Item><Form.Item label="查询字段"><Input value={selected.dataSource.select || '*'} onChange={event => patchWidget({ dataSource: { ...selected.dataSource, select: event.target.value } })} /></Form.Item></>}
        {['statistic', 'line', 'column', 'pie'].includes(selected.type) && <><Form.Item label={selected.type === 'pie' ? '分类字段' : 'X / 标签字段'}><Input value={selected.type === 'pie' ? selected.colorField : selected.xField} onChange={event => patchWidget(selected.type === 'pie' ? { colorField: event.target.value } : { xField: event.target.value })} /></Form.Item><Form.Item label="数值字段"><Input value={selected.yField} onChange={event => patchWidget({ yField: event.target.value })} /></Form.Item></>}
      </Form></> : <Empty description="选择一个组件编辑属性" />}</aside>
    </div>
    <Drawer open={preview} onClose={() => setPreview(false)} width="90%" title={`预览：${page.name}`}><PageCanvas page={page} /></Drawer>
    <Modal open={publishOpen} onCancel={() => setPublishOpen(false)} footer={null} title="发布页面"><Alert type="info" showIcon message="发布后将创建或更新菜单，路由地址为 /custom/页面标识" /><Form layout="vertical" initialValues={page} onFinish={publish} style={{ marginTop: 20 }}><Form.Item name="name" label="菜单及页面名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="slug" label="页面标识" rules={[{ required: true }, { pattern: /^[a-z0-9-]+$/, message: '仅支持小写字母、数字和连字符' }]}><Input addonBefore="/custom/" /></Form.Item><Form.Item name="description" label="描述"><Input.TextArea /></Form.Item><Button block type="primary" htmlType="submit" loading={saving} icon={<PlusOutlined />}>发布并生成菜单</Button></Form></Modal>
  </div>;
}
