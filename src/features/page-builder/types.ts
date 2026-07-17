export type WidgetType = 'text' | 'statistic' | 'button' | 'table' | 'line' | 'column' | 'pie';

export interface DataSourceConfig {
  mode: 'static' | 'supabase';
  table?: string;
  select?: string;
  limit?: number;
  staticData?: unknown[];
}

export interface PageWidget {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content?: string;
  xField?: string;
  yField?: string;
  colorField?: string;
  dataSource: DataSourceConfig;
}

export interface CustomPage {
  id?: number;
  name: string;
  slug: string;
  description?: string | null;
  status: 'draft' | 'published';
  menu_id?: number | null;
  config: { widgets: PageWidget[] };
  created_at?: string;
  updated_at?: string;
}

export const widgetDefaults: Record<WidgetType, Omit<PageWidget, 'id' | 'type' | 'x' | 'y'>> = {
  text: { title: '文本', content: '双击右侧属性进行编辑', w: 4, h: 2, dataSource: { mode: 'static', staticData: [] } },
  statistic: { title: '核心指标', xField: 'label', yField: 'value', w: 3, h: 2, dataSource: { mode: 'static', staticData: [{ label: '本月销售额', value: 128600 }] } },
  button: { title: '操作按钮', content: '立即执行', w: 2, h: 2, dataSource: { mode: 'static', staticData: [] } },
  table: { title: '数据表格', w: 6, h: 4, dataSource: { mode: 'static', staticData: [{ name: '示例数据', value: 100 }, { name: '另一条数据', value: 80 }] } },
  line: { title: '趋势折线图', xField: 'name', yField: 'value', w: 6, h: 4, dataSource: { mode: 'static', staticData: [{ name: '一月', value: 30 }, { name: '二月', value: 52 }, { name: '三月', value: 45 }] } },
  column: { title: '分类柱状图', xField: 'name', yField: 'value', w: 6, h: 4, dataSource: { mode: 'static', staticData: [{ name: '华东', value: 68 }, { name: '华南', value: 46 }, { name: '华北', value: 55 }] } },
  pie: { title: '占比饼图', colorField: 'name', yField: 'value', w: 5, h: 4, dataSource: { mode: 'static', staticData: [{ name: '已完成', value: 72 }, { name: '进行中', value: 20 }, { name: '待处理', value: 8 }] } },
};
