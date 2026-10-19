import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Modal, Select, Space, Table, theme, message } from 'antd';
import { CloseCircleFilled, EllipsisOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { supabase } from '../utils/supabase';

/**
 * 物料（erp_products）的一条记录，供弹窗表格与回填使用。
 * 字段与 erp_products_s_539dcf81_b 表对齐（deploy_01）。
 */
export interface ProductSearchItem {
  id: number;
  code: string;
  name: string;
  short_name?: string | null;
  specification?: string | null;
  category_id?: number | null;
  unit?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

/**
 * 物料快捷查询组件。
 *
 * 以 antd `Input.Search` 为基类：点击右侧搜索图标弹出「物料搜索框 + Table 列表」弹窗，
 * 弹窗内可按 编码 / 名称 / 类别 / 规格 检索，并支持分页。
 *
 * - `mode="single"`（默认）：单选，选中即回填到 input 并关闭弹窗。
 * - `mode="multiple"`：多选，弹窗内勾选后点「确定」返回数组。
 *
 * 返回值字段由 `valueField` 决定，默认 `"code"`（物料编码）。可设为 `"id"`、`"name"` 等
 * 任意物料字段。组件兼容 antd Form.Item 的 `value` / `onChange` 受控写法。
 */
export interface ProductSearchSelectProps {
  /** 受控值：单选为单个字段值，多选为字段值数组；由 Form.Item 自动注入 */
  value?: string | number | (string | number)[] | null;
  /** 值变更回调，由 Form.Item 自动注入 */
  onChange?: (value: string | number | (string | number)[] | null) => void;
  /** 选择模式，默认 single */
  mode?: 'single' | 'multiple';
  /** 返回值取自物料的哪个字段，默认 code（物料编码） */
  valueField?: string;
  /** input 占位符 */
  placeholder?: string;
  /** 仅显示启用状态的物料，默认 true */
  onlyActive?: boolean;
  /** 仅显示可生产（is_manufactured=true）的物料，默认 false */
  manufacturedOnly?: boolean;
  /** 排除某个物料（按 id），列表中不显示该物料，默认 undefined */
  excludeProductId?: number | string | null;
  /** 弹窗表格每页条数，默认 10 */
  pageSize?: number;
  disabled?: boolean;
  allowClear?: boolean;
  style?: React.CSSProperties;
}

interface Category {
  id: number;
  name: string;
  code: string;
}

const PAGE_SIZES = [10, 20, 50];

export function ProductSearchSelect({
  value,
  onChange,
  mode = 'single',
  valueField = 'code',
  placeholder,
  onlyActive = true,
  manufacturedOnly = false,
  excludeProductId,
  pageSize: propPageSize = 10,
  disabled,
  allowClear = true,
  style,
}: ProductSearchSelectProps) {
  const { t } = useTranslation();
  // 清除图标颜色走 antd token（跟随 darkAlgorithm，暗色下自动变亮，避免硬编码看不清）
  const { token } = theme.useToken();

  // 弹窗状态
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ProductSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(propPageSize);

  // 弹窗内检索条件
  const [keyword, setKeyword] = useState(''); // 编码 / 名称 联合关键字
  const [spec, setSpec] = useState(''); // 规格
  const [categoryId, setCategoryId] = useState<number | undefined>(); // 类别

  // 多选暂存
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const justClearedRef = useRef(false);

  // 类别下拉数据
  const [categories, setCategories] = useState<Category[]>([]);

  // 已选中项的回显文本（用于 input 展示）
  const [displayText, setDisplayText] = useState('');

  // 拉取类别（用于弹窗内类别筛选下拉）
  const fetchCategories = useCallback(async () => {
    const { data, error } = await supabase
      .from('erp_product_categories_s_539dcf81_b')
      .select('id, name, code')
      .eq('is_deleted', 'n')
      .order('code');
    if (error) {
      console.error('Error fetching categories:', error);
      return;
    }
    setCategories((data as Category[]) || []);
  }, []);

  // 打开弹窗时初始化
  useEffect(() => {
    if (open) {
      void fetchCategories();
      // 同步当前值到多选勾选态
      if (mode === 'multiple') {
        setSelectedKeys(Array.isArray(value) ? (value as React.Key[]) : []);
      }
    }
  }, [open, fetchCategories, mode, value]);

  // 回显：根据当前 value（可能是 code）反查物料，展示「编码 名称」
  const syncDisplayText = useCallback(
    async (val: typeof value) => {
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        setDisplayText('');
        return;
      }
      const vals = Array.isArray(val) ? val : [val];
      const { data, error } = await supabase
        .from('erp_products_s_539dcf81_b')
        .select('id, code, name, short_name, specification, category_id, unit, status')
        .in(valueField, vals as (string | number)[])
        .eq('is_deleted', 'n');
      if (error) {
        console.error('Error syncing product display:', error);
        return;
      }
      const items = (data as ProductSearchItem[]) || [];
      setDisplayText(
        items.map((p) => (p.code ? `${p.code} ${p.name}` : p.name)).join('、'),
      );
    },
    [valueField],
  );

  useEffect(() => {
    void syncDisplayText(value);
  }, [value, syncDisplayText]);

  // 弹窗内列表查询（编码/名称/类别/规格 + 分页）
  const fetchRows = useCallback(
    async (p = page, ps = pageSize) => {
      setLoading(true);
      try {
        let query = supabase
          .from('erp_products_s_539dcf81_b')
          .select('id, code, name, short_name, specification, category_id, unit, status', {
            count: 'exact',
          })
          .eq('is_deleted', 'n');

        if (onlyActive) query = query.eq('status', 'active');
        if (manufacturedOnly) query = query.eq('is_manufactured', true);
        if (excludeProductId != null && excludeProductId !== '')
          query = query.neq('id', excludeProductId);
        if (categoryId != null) query = query.eq('category_id', categoryId);
        if (spec.trim()) query = query.ilike('specification', `%${spec.trim()}%`);

        const kw = keyword.trim();
        if (kw) {
          // 编码 / 名称 / 简称 联合模糊匹配
          query = query.or(
            `code.ilike.%${kw}%,name.ilike.%${kw}%,short_name.ilike.%${kw}%`,
          );
        }

        query = query
          .order('code', { ascending: true })
          .range((p - 1) * ps, p * ps - 1);

        const { data, error, count } = await query;
        if (error) throw error;
        setRows((data as ProductSearchItem[]) || []);
        setTotal(count ?? 0);
      } catch (err) {
        console.error('Error fetching products:', err);
        message.error(t('productSearch.messages.fetchFailed'));
      } finally {
        setLoading(false);
      }
    },
    [keyword, spec, categoryId, page, pageSize, onlyActive, manufacturedOnly, excludeProductId, t],
  );

  useEffect(() => {
    if (open) void fetchRows();
  }, [open, fetchRows]);

  // 触发检索（重置到第一页）
  const handleSearch = () => {
    setPage(1);
    void fetchRows(1, pageSize);
  };

  // 重置检索条件
  const handleReset = () => {
    setKeyword('');
    setSpec('');
    setCategoryId(undefined);
    setPage(1);
    void fetchRows(1, pageSize);
  };

  // 单选：点击行直接选中并回填
  const handleRowSelect = (record: ProductSearchItem) => {
    const v = record[valueField];
    onChange?.((v ?? null) as string | number | null);
    setOpen(false);
  };

  // 多选确定
  const handleConfirm = () => {
    const vals = selectedKeys as (string | number)[];
    onChange?.(vals.length ? vals : null);
    setOpen(false);
  };

  // 清空
  const handleClear = () => {
    justClearedRef.current = true; // 清除图标点击会冒泡到 input 的 onClick，防止清空后又弹窗
    setTimeout(() => { justClearedRef.current = false; }, 300);
    setDisplayText('');
    setSelectedKeys([]);
    onChange?.(mode === 'multiple' ? [] : null);
  };

  const getCategoryName = (categoryId: number | null | undefined) =>
    categories.find((c) => c.id === categoryId)?.name || '-';

  const columns: ColumnsType<ProductSearchItem> = useMemo(
    () => [
      {
        title: t('common.code'),
        dataIndex: 'code',
        key: 'code',
        width: 140,
      },
      {
        title: t('common.name'),
        dataIndex: 'name',
        key: 'name',
        width: 180,
        ellipsis: true,
      },
      {
        title: t('productSearch.columns.category'),
        dataIndex: 'category_id',
        key: 'category_id',
        width: 120,
        render: (v: number | null) => getCategoryName(v),
      },
      {
        title: t('productSearch.columns.spec'),
        dataIndex: 'specification',
        key: 'specification',
        width: 160,
        ellipsis: true,
        render: (v: string | null) => v || '-',
      },
      {
        title: t('productSearch.columns.unit'),
        dataIndex: 'unit',
        key: 'unit',
        width: 80,
        render: (v: string | null) => v || '-',
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, t],
  );

  const rowSelection =
    mode === 'multiple'
      ? {
          selectedRowKeys: selectedKeys,
          onChange: (keys: React.Key[]) => setSelectedKeys(keys),
        }
      : undefined;

  const selectCategoryOptions = categories.map((c) => ({
    value: c.id,
    label: `${c.code} ${c.name}`,
  }));

  return (
    <>
      {/* readOnly 受控下 antd 的 allowClear 清除事件不可靠（v6 clear 图标不会触发可用的
          onChange/onClear），所以清除图标自己渲染：有值时显示，点击只清值不弹窗 */}
      <Input.Search
        value={displayText}
        readOnly
        disabled={disabled}
        placeholder={placeholder || t('productSearch.placeholder')}
        enterButton={<Button icon={<EllipsisOutlined />} />}
        onSearch={() => setOpen(true)}
        onClick={() => {
          if (!justClearedRef.current) setOpen(true);
        }}
        suffix={
          allowClear && !disabled && displayText ? (
            <CloseCircleFilled
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
              style={{
                color: token.colorIcon,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = token.colorIconHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = token.colorIcon;
              }}
            />
          ) : null
        }
        style={style}
      />

      <Modal
        open={open}
        title={t('productSearch.modalTitle')}
        width={860}
        onCancel={() => setOpen(false)}
        footer={
          mode === 'multiple' ? (
            <Space>
              <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" onClick={handleConfirm}>
                {t('productSearch.confirm')} ({selectedKeys.length})
              </Button>
            </Space>
          ) : null
        }
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }} size={12}>
          {/* 检索栏 */}
          <Space wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder={t('productSearch.keywordPlaceholder')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={handleSearch}
              style={{ width: 220 }}
            />
            <Input
              allowClear
              placeholder={t('productSearch.specPlaceholder')}
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              onPressEnter={handleSearch}
              style={{ width: 160 }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('productSearch.categoryPlaceholder')}
              value={categoryId}
              onChange={(v) => setCategoryId(v)}
              options={selectCategoryOptions}
              style={{ width: 180 }}
            />
            <Space>
              <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
                {t('common.search')}
              </Button>
              <Button onClick={handleReset}>{t('common.reset')}</Button>
            </Space>
          </Space>

          {/* 列表 */}
          <Table<ProductSearchItem>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={rows}
            rowSelection={rowSelection}
            locale={{
              emptyText: <Empty description={t('productSearch.empty')} />,
            }}
            onRow={(record) =>
              mode === 'single'
                ? {
                    onClick: () => handleRowSelect(record),
                    style: { cursor: 'pointer' },
                  }
                : {}
            }
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: PAGE_SIZES,
              showTotal: (n) => t('productSearch.total', { count: n }),
              onChange: (p, ps) => {
                setPage(p);
                setPageSize(ps);
                void fetchRows(p, ps);
              },
            }}
          />
        </Space>
      </Modal>
    </>
  );
}

export default ProductSearchSelect;
