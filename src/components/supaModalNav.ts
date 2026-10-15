/**
 * SupaModal 标题栏「上一条 / 下一条」按钮的导航数据。
 * 由页面通过 buildModalNav() 构造后传给 SupaModal 的 navigation 属性。
 */
export interface SupaModalNavigation {
  canPrev: boolean;
  canNext: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 当前记录序号（1 开始）与列表总条数，用于标题栏展示 n/total。 */
  position?: { current: number; total: number };
}

/**
 * 根据页面主表数据构造上一条/下一条导航。
 *
 * @param rows      页面主表数据源（与表格 dataSource 同源，自动跟随筛选）
 * @param currentId 当前打开记录的 id（与 historyRecordId 同一表达式；新增时为 null）
 * @param onSelect  切换记录时打开单据的回调（通常是 handleEdit / openDocument）
 * @param getId     行 id 取值函数，默认取 row.id（如 Batches 用 batch_id 时需自定义）
 */
export function buildModalNav<T>(
  rows: T[] | undefined | null,
  currentId: string | number | null | undefined,
  onSelect: (row: T) => void,
  getId: (row: T) => string | number | null | undefined = (row) =>
    (row as { id?: string | number | null })?.id,
): SupaModalNavigation {
  if (!rows || rows.length === 0 || currentId === null || currentId === undefined) {
    return { canPrev: false, canNext: false };
  }
  const index = rows.findIndex((row) => getId(row) === currentId);
  if (index < 0) {
    return { canPrev: false, canNext: false };
  }
  return {
    position: { current: index + 1, total: rows.length },
    canPrev: index > 0,
    canNext: index < rows.length - 1,
    onPrev: index > 0 ? () => onSelect(rows[index - 1]) : undefined,
    onNext: index < rows.length - 1 ? () => onSelect(rows[index + 1]) : undefined,
  };
}
