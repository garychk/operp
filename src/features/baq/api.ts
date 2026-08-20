import { supabase } from '../../utils/supabase';
import type { BaqQuery, BaqResult, BaqTable } from './types';

export interface TableLabelRow { id: number; table_name: string; table_label: string; module_name: string }

export async function listBaqs(publishedOnly = false) {
  let query = supabase.from('sys_baq_queries').select('*').eq('is_deleted', 'n').order('updated_at', { ascending: false });
  if (publishedOnly) query = query.eq('status', 'published');
  const { data, error } = await query; if (error) throw error; return (data || []) as BaqQuery[];
}
export async function loadCatalog() {
  const { data, error } = await supabase.rpc('baq_catalog'); if (error) throw error; return (data || []) as BaqTable[];
}
export async function listTableLabels() {
  const { data, error } = await supabase.from('sys_tables').select('id, table_name, table_label, module_name').eq('is_deleted', 'n').eq('status', '1').order('module_name').order('table_name');
  if (error) throw error;
  return (data || []) as TableLabelRow[];
}
export async function refreshSysTables() {
  const { error } = await supabase.rpc('refresh_sys_tables');
  if (error) throw error;
}
export async function updateTableLabels(rows: Array<Pick<TableLabelRow, 'id' | 'table_label'>>) {
  const results = await Promise.all(rows.map(row => supabase.rpc('update_table_label', { target_table_id: row.id, new_label: row.table_label })));
  const failed = results.find(result => result.error);
  if (failed?.error) throw failed.error;
}
export async function saveBaq(baq: BaqQuery) {
  const payload = { code: baq.code, name: baq.name, description: baq.description || null, status: baq.status, definition: baq.definition, updated_at: new Date().toISOString() };
  const response = baq.id ? await supabase.from('sys_baq_queries').update(payload).eq('id', baq.id).select().single() : await supabase.from('sys_baq_queries').insert(payload).select().single();
  if (response.error) throw response.error; return response.data as BaqQuery;
}
export async function removeBaq(id: number) { const { error } = await supabase.from('sys_baq_queries').update({ is_deleted: 'y', updated_at: new Date().toISOString() }).eq('id', id); if (error) throw error; }
export async function executeBaq(code: string, page = 1, pageSize = 100) {
  const [execution, query] = await Promise.all([
    supabase.rpc('execute_baq', { query_code: code, page_number: page, page_size: pageSize }),
    supabase.from('sys_baq_queries').select('definition').eq('code', code).eq('is_deleted', 'n').single(),
  ]);
  if (execution.error) throw execution.error;
  if (query.error) throw query.error;
  const result = execution.data as BaqResult;
  const definition = (query.data as { definition: BaqQuery['definition'] }).definition;
  return { ...result, columns: definition.fields.map(field => field.alias || field.field) };
}
