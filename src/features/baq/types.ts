export type Aggregate = 'none' | 'sum' | 'count' | 'avg' | 'min' | 'max';
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'is_null' | 'not_null';
export interface BaqColumn { name: string; type: string }
export interface BaqTable { table: string; label: string; columns: BaqColumn[] }
/** 一对关联字段。两端都可以是任意列，不限于外键（例如 code = code） */
export interface BaqJoinCondition { leftField: string; rightField: string }
/**
 * 一条关联。conditions 是**完整**条件列表（含第一对），多对之间用 AND 连接；
 * leftField / rightField 保留为 conditions[0] 的镜像，兼容旧版 execute_baq 与
 * AI 设计链路（它们只读这一对）。读取一律走 joinGraph.joinConditions()。
 */
export interface BaqJoin {
  id: string; type: 'inner' | 'left'; table: string; alias: string; leftAlias: string;
  leftField: string; rightField: string;
  conditions?: BaqJoinCondition[];
}
export interface BaqField { id: string; tableAlias: string; field: string; alias: string; aggregate: Aggregate; groupBy: boolean }
export interface BaqFilter { id: string; tableAlias: string; field: string; operator: FilterOperator; value: string }
export interface BaqSort { id: string; fieldAlias: string; direction: 'asc' | 'desc' }
/** 表间外键关系（baq_relations RPC），用于图形化设计器自动发现可连的主子表 */
export interface BaqRelation { table: string; column: string; refTable: string; refColumn: string }
/** 图形化设计器的卡片坐标，随 definition 一起持久化（execute_baq 不读它） */
export type BaqLayout = Record<string, { x: number; y: number }>;
export interface BaqDefinition { source: { table: string; alias: string }; joins: BaqJoin[]; fields: BaqField[]; filters: BaqFilter[]; sorts: BaqSort[]; layout?: BaqLayout }
export interface BaqQuery { id?: number; code: string; name: string; description?: string | null; status: 'draft' | 'published'; definition: BaqDefinition; updated_at?: string }
export interface BaqResult { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; columns?: string[] }
export const emptyBaq = (): BaqQuery => ({ code: `baq_${Date.now()}`, name: '未命名查询', description: '', status: 'draft', definition: { source: { table: '', alias: 't0' }, joins: [], fields: [], filters: [], sorts: [] } });
