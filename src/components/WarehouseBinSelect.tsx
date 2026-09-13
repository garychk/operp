import { useEffect, useState } from 'react';
import { Select, Spin } from 'antd';
import { useTranslation } from 'react-i18next';
import { supabase } from '../utils/supabase';

export interface BinOption {
  id: number;
  code: string;
  name: string;
  warehouse_id: number;
  location?: string | null;
  status?: string | null;
}

export interface WarehouseBinSelectProps {
  /** 当前选中的仓库 id；未选时下拉禁用并提示先选仓库 */
  warehouseId?: number | null;
  /** 受控值（库位 id），由 antd Form.Item 自动注入 */
  value?: number | null;
  /** 值变更回调，由 antd Form.Item 自动注入 */
  onChange?: (value: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  allowClear?: boolean;
  /** 仅显示启用状态的库位，默认 true */
  onlyActive?: boolean;
}

/**
 * 仓库库位（bin/location）联动下拉组件。
 *
 * 用法：把本组件直接作为 antd Form.Item 的 children 传入即可，
 * 通过 warehouseId 联动当前仓库，自动拉取该仓库下的所有库位。
 * 业务单据（销售出库、采购入库等）无需各自实现仓库-库位联动逻辑。
 */
export function WarehouseBinSelect({
  warehouseId,
  value,
  onChange,
  disabled,
  placeholder,
  allowClear = true,
  onlyActive = true,
}: WarehouseBinSelectProps) {
  const { t } = useTranslation();
  const [bins, setBins] = useState<BinOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (warehouseId == null) {
      setBins([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    let query = supabase
      .from('erp_bins_s_539dcf81_b')
      .select('id, code, name, warehouse_id, location, status')
      .eq('warehouse_id', warehouseId)
      .eq('is_deleted', 'n');
    if (onlyActive) {
      query = query.eq('status', 'active');
    }
    query
      .order('sort_order')
      .then(({ data, error }) => {
        if (cancelled) return;
        setLoading(false);
        if (error) {
          console.error('Error fetching bins for warehouse', warehouseId, error);
          setBins([]);
          return;
        }
        setBins((data as BinOption[]) || []);
      });
    return () => {
      cancelled = true;
    };
  }, [warehouseId, onlyActive]);

  const noWarehouse = warehouseId == null;
  const selectWarehouseFirst = t('bin.selectWarehouseFirst');

  return (
    <Select
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      disabled={disabled || noWarehouse}
      loading={loading}
      placeholder={noWarehouse ? selectWarehouseFirst : (placeholder || t('bin.placeholder'))}
      allowClear={allowClear}
      showSearch
      optionFilterProp="label"
      notFoundContent={
        loading ? <Spin size="small" /> : (noWarehouse ? selectWarehouseFirst : t('bin.noBins'))
      }
    >
      {bins.map((b) => (
        <Select.Option key={b.id} value={b.id} label={`${b.code} ${b.name}`}>
          {b.code} - {b.name}
          {b.location ? `（${b.location}）` : ''}
        </Select.Option>
      ))}
    </Select>
  );
}
