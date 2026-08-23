import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Skeleton, Statistic, Table, Typography } from 'antd';
import { Column, Line, Pie } from '@ant-design/charts';
import GridLayout, { WidthProvider } from 'react-grid-layout';
import { useParams } from 'react-router-dom';
import { supabase } from '../../utils/supabase';
import { getCustomPage } from './api';
import type { CustomPage, PageWidget } from './types';
import { executeBaq } from '../baq/api';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './page-builder.css';

const ResponsiveGrid = WidthProvider(GridLayout);

function WidgetBody({ widget }: { widget: PageWidget }) {
  const [data, setData] = useState<Record<string, unknown>[]>(() => (widget.dataSource.staticData || []) as Record<string, unknown>[]);
  const [loading, setLoading] = useState(widget.dataSource.mode !== 'static');
  const [error, setError] = useState('');
  const [columnOrder, setColumnOrder] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    const source = widget.dataSource;

    if (source.mode === 'static') {
      setData((source.staticData || []).slice(0, source.limit || 100) as Record<string, unknown>[]);
      setColumnOrder([]);
      setError('');
      setLoading(false);
      return () => { active = false; };
    }

    if (source.mode === 'supabase' && !source.table?.trim()) {
      setData([]);
      setColumnOrder([]);
      setError('请先配置 Supabase 表名');
      setLoading(false);
      return () => { active = false; };
    }

    setLoading(true);
    setError('');
    const request: Promise<{ data: unknown[]; error: { message: string; code?: string } | null; columns: string[] }> = (async () => {
      if (source.mode === 'baq') {
        if (!source.baqCode) return { data: [], error: { message: '未选择 BAQ' }, columns: [] };
        const result = await executeBaq(source.baqCode, 1, source.limit || 100);
        return { data: result.rows, error: null, columns: result.columns || [] };
      }
      const result = await supabase
        .from(source.table!.trim())
        .select(source.select?.trim() || '*')
        .limit(source.limit || 100);
      return { data: (result.data || []) as unknown[], error: result.error, columns: [] };
    })();
    request
      .then(({ data: rows, error: queryError, columns: orderedColumns }) => {
        if (!active) return;
        if (queryError) {
          setData([]);
          setColumnOrder([]);
          const queryCode = 'code' in queryError ? queryError.code : undefined;
          setError(`${queryError.message}${queryCode ? ` (${queryCode})` : ''}`);
        } else {
          setData((rows || []) as unknown as Record<string, unknown>[]);
          setColumnOrder(orderedColumns);
        }
        setLoading(false);
      })
      .catch((queryError: unknown) => {
        if (!active) return;
        setData([]);
        setColumnOrder([]);
        setError(queryError instanceof Error ? queryError.message : '数据查询失败');
        setLoading(false);
      });

    return () => { active = false; };
  }, [widget.dataSource]);
  const columns = useMemo(() => {
    const keys = columnOrder.length ? columnOrder : Object.keys(data[0] || {}).slice(0, 8);
    return keys.map(key => ({ title: key, dataIndex: key, key, ellipsis: true }));
  }, [data, columnOrder]);
  if (loading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (error) return <Alert type="error" showIcon message="数据加载失败" description={error} />;
  if (widget.type === 'text') return <Typography.Paragraph>{widget.content}</Typography.Paragraph>;
  if (widget.type === 'button') return <Button type="primary">{widget.content || widget.title}</Button>;
  if (widget.type === 'statistic') return <Statistic title={String(data[0]?.[widget.xField || 'label'] || widget.title)} value={Number(data[0]?.[widget.yField || 'value'] || 0)} />;
  if (!data.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  if (widget.type === 'table') return <Table size="small" rowKey={(_, index) => String(index)} columns={columns} dataSource={data} pagination={{ pageSize: widget.pageSize || 10, hideOnSinglePage: true, showSizeChanger: false }} scroll={{ x: true }} />;
  if (widget.type === 'line') return <Line data={data} xField={widget.xField || 'name'} yField={widget.yField || 'value'} autoFit />;
  if (widget.type === 'column') return <Column data={data} xField={widget.xField || 'name'} yField={widget.yField || 'value'} autoFit />;
  return <Pie data={data} angleField={widget.yField || 'value'} colorField={widget.colorField || widget.xField || 'name'} innerRadius={0.55} autoFit />;
}

export function PageCanvas({ page, editable = false, selectedId, onSelect, onLayoutChange }: { page: CustomPage; editable?: boolean; selectedId?: string; onSelect?: (id: string) => void; onLayoutChange?: (layout: GridLayout.Layout[]) => void }) {
  const layout = page.config.widgets.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h, minW: 2, minH: 2 }));
  return (
    <ResponsiveGrid className={`custom-page-grid${editable ? ' is-editing' : ''}`} layout={layout} cols={12} rowHeight={72} margin={[12, 12]} isDraggable={editable} isResizable={editable} onLayoutChange={onLayoutChange} draggableHandle=".widget-drag-handle">
      {page.config.widgets.map(widget => (
        <div key={widget.id} onClick={() => onSelect?.(widget.id)}>
          <Card size="small" className={selectedId === widget.id ? 'page-widget selected' : 'page-widget'} title={widget.title} classNames={{ header: 'widget-drag-handle' }}>
            <WidgetBody widget={widget} />
          </Card>
        </div>
      ))}
    </ResponsiveGrid>
  );
}

export function CustomPageRenderer() {
  const { slug = '' } = useParams();
  const [page, setPage] = useState<CustomPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getCustomPage(slug).then(setPage).catch(err => setError(err.message)); }, [slug]);
  if (error) return <Alert type="error" showIcon message="页面加载失败" description={error} />;
  if (!page) return <Skeleton active />;
  return <div className="published-page"><div className="published-page-heading"><Typography.Title level={4}>{page.name}</Typography.Title>{page.description && <Typography.Text type="secondary">{page.description}</Typography.Text>}</div><PageCanvas page={page} /></div>;
}
