import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { useDict } from '../hooks/useDict';

export interface DictSelectProps extends SelectProps {
  /** 字典类型编码，对应 sys_dict_types.code */
  dictType: string;
}

/**
 * 从系统数据字典加载选项的 Select。
 *
 * 取数逻辑统一收口在 `useDict`（见 src/hooks/useDict.ts）；本组件只负责把
 * items 映射成 options 并透传其余 Select 属性。
 *
 * 注意：**value 存的是字典项的 `code`，不是 `label`**。需要把已有值显示成
 * 显示名时（列表列、详情页），用同一个 hook 的 `labelOf()` 做映射，不要另起一套取数。
 */
export function DictSelect({ dictType, loading, ...selectProps }: DictSelectProps) {
  const { options, loading: fetching } = useDict(dictType);

  return <Select {...selectProps} loading={loading || fetching} options={options} />;
}

export default DictSelect;
