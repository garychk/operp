import { useEffect, useState } from 'react';
import { Select, message } from 'antd';
import type { SelectProps } from 'antd';
import { supabase } from '../utils/supabase';

export interface DictSelectProps extends SelectProps {
  /** 字典类型编码，对应 sys_dict_types.code */
  dictType: string;
}

interface DictItemRow {
  code: string;
  label: string;
  sort_order: number | null;
}

/**
 * 从系统数据字典加载选项的 Select。
 * 传入的 Select 属性会原样透传，options 由数据字典自动生成。
 */
export function DictSelect({ dictType, loading, ...selectProps }: DictSelectProps) {
  const [options, setOptions] = useState<NonNullable<SelectProps['options']>>([]);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchOptions = async () => {
      if (!dictType) {
        setOptions([]);
        return;
      }

      setFetching(true);
      try {
        const { data, error } = await supabase
          .from('sys_dict_types')
          .select('id, sys_dict_items(code, label, sort_order)')
          .eq('code', dictType)
          .eq('status', '1')
          .eq('is_deleted', 'n')
          .eq('sys_dict_items.status', '1')
          .eq('sys_dict_items.is_deleted', 'n')
          .maybeSingle();

        if (error) throw error;
        if (cancelled) return;

        const items = ((data?.sys_dict_items ?? []) as DictItemRow[])
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((item) => ({ value: item.code, label: item.label }));
        setOptions(items);
      } catch (error) {
        if (!cancelled) {
          setOptions([]);
          message.error('获取数据字典失败');
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    };

    fetchOptions();
    return () => {
      cancelled = true;
    };
  }, [dictType]);

  return <Select {...selectProps} loading={loading || fetching} options={options} />;
}

export default DictSelect;
