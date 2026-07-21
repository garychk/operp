export type Aggregate = 'none' | 'sum' | 'count' | 'avg' | 'min' | 'max';
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'is_null' | 'not_null';
export interface BaqColumn { name: string; type: string }
export interface BaqTable { table: string; label: string; columns: BaqColumn[] }
export interface BaqJoin { id: string; type: 'inner' | 'left'; table: string; alias: string; leftAlias: string; leftField: string; rightField: string }
export interface BaqField { id: string; tableAlias: string; field: string; alias: string; aggregate: Aggregate; groupBy: boolean }
export interface BaqFilter { id: string; tableAlias: string; field: string; operator: FilterOperator; value: string }
export interface BaqSort { id: string; fieldAlias: string; direction: 'asc' | 'desc' }
export interface BaqDefinition { source: { table: string; alias: string }; joins: BaqJoin[]; fields: BaqField[]; filters: BaqFilter[]; sorts: BaqSort[] }
export interface BaqQuery { id?: number; code: string; name: string; description?: string | null; status: 'draft' | 'published'; definition: BaqDefinition; updated_at?: string }
export interface BaqResult { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; columns?: string[] }
export const emptyBaq = (): BaqQuery => ({ code: `baq_${Date.now()}`, name: '未命名查询', description: '', status: 'draft', definition: { source: { table: '', alias: 't0' }, joins: [], fields: [], filters: [], sorts: [] } });
