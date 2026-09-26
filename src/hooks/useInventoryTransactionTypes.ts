import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../utils/supabase';
import type { Tables } from '../utils/supabase';
import {
  INVENTORY_TRANSACTION_TYPE_LABELS,
  INVENTORY_TRANSACTION_TYPE_OPTIONS,
} from '../constants/inventoryTransactionTypes';

type TransactionTypeRow = Tables['sys_inventory_transaction_types']['Row'];

export type InventoryTransactionTypeOption = {
  value: string;
  label: string;
  direction: string;
};

/**
 * Business types are configured per DocType in
 * sys_inventory_transaction_types / sys_document_transaction_types.
 * The bundled constant file stays as an offline fallback so the page still
 * renders labels when the metadata tables are empty or unreachable.
 */
export function useInventoryTransactionTypes() {
  const [rows, setRows] = useState<TransactionTypeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('sys_inventory_transaction_types')
        .select('*')
        .eq('is_deleted', 'n')
        .order('sort_order')
        .order('id');
      if (!active) return;
      if (error) {
        console.error('Failed to load inventory transaction types:', error.message);
        setRows([]);
      } else {
        setRows((data || []) as TransactionTypeRow[]);
      }
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo<InventoryTransactionTypeOption[]>(() => {
    if (rows.length === 0) {
      return INVENTORY_TRANSACTION_TYPE_OPTIONS.map((item) => ({
        value: item.value,
        label: item.label,
        direction: item.value.endsWith('_out') ? 'out' : item.value.endsWith('_in') ? 'in' : 'neutral',
      }));
    }
    return rows
      .filter((row) => row.status !== '0')
      .map((row) => ({
        value: row.code,
        label: row.name,
        direction: row.direction,
      }));
  }, [rows]);

  const labels = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = { ...INVENTORY_TRANSACTION_TYPE_LABELS as Record<string, string> };
    for (const option of options) {
      map[option.value] = option.label;
    }
    return map;
  }, [options]);

  return {
    loading,
    options,
    labels,
    getLabel: (value: string | null | undefined) => {
      if (!value) return '-';
      return labels[value] || value;
    },
  };
}
