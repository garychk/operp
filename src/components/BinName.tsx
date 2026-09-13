import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { supabase } from '../utils/supabase';

export interface BinNameInfo {
  id: number;
  code: string;
  name: string;
  location?: string | null;
}

// 跨组件实例的库位缓存：同一 binId 只查一次，避免表格多行重复请求。
const binCache = new Map<number, BinNameInfo | null>();

export interface BinNameProps {
  /** 库位（bin）id；为空时显示占位符 */
  binId?: number | null;
}

/**
 * 库位名展示组件：传入库位 id，自动按 id 查询并显示「编码 - 名称（位置）」。
 *
 * 适用于表格列、详情展示等只需展示库位名、无需下拉选择的场景。
 * 与 WarehouseBinSelect（下拉选择）互补，二者共享 erp_bins 数据源。
 * 内部带 module 级缓存，同 id 不重复请求。
 */
export function BinName({ binId }: BinNameProps) {
  const [bin, setBin] = useState<BinNameInfo | null | undefined>(
    binId == null ? undefined : binCache.get(binId),
  );

  useEffect(() => {
    if (binId == null) {
      setBin(undefined);
      return;
    }
    const cached = binCache.get(binId);
    if (cached !== undefined) {
      setBin(cached);
      return;
    }
    let cancelled = false;
    supabase
      .from('erp_bins_s_539dcf81_b')
      .select('id, code, name, location')
      .eq('id', binId)
      .eq('is_deleted', 'n')
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Error fetching bin', binId, error);
          binCache.set(binId, null);
          setBin(null);
          return;
        }
        const info = (data as BinNameInfo) ?? null;
        binCache.set(binId, info);
        setBin(info);
      });
    return () => {
      cancelled = true;
    };
  }, [binId]);

  if (binId == null) return <span>-</span>;
  if (bin === undefined) return <Spin size="small" />;
  if (bin === null) return <span>-</span>;
  return (
    <span>
      {bin.code} - {bin.name}
      {bin.location ? `（${bin.location}）` : ''}
    </span>
  );
}
