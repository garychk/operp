import type { BaqDefinition, BaqJoin, BaqRelation } from "./types";

/**
 * BAQ 关联（joins）的依赖关系工具。
 *
 * definition.joins 的顺序 = 生成 SQL 时的 JOIN 顺序，因此**每条 join 的左别名
 * 必须排在它前面出现过**（要么是主表，要么是更靠前的一条 join 的别名）。
 * 这层约束原来散落在界面里（拖线只允许「靠前 → 靠后」、添加表恒定挂主表），
 * 结果就是子表没法再关联子表。这里把它收敛成纯函数：
 * 任何改动完 joins 后跑一次 sortJoinsByDependency，顺序就一定合法。
 *
 * execute_baq 本身对层数没有任何限制（左别名只校验格式），所以多级关联
 * 不需要改 SQL。
 */

export interface BaqSourceRef {
  alias: string;
  table: string;
}

export interface JoinSortResult {
  joins: BaqJoin[];
  /** 顺序被调整过 */
  changed: boolean;
  /** 存在循环依赖（含自引用），此时原样返回 joins */
  cycle: boolean;
}

/** 别名 → 物理表名 */
export function aliasTableMap(
  source: BaqSourceRef,
  joins: BaqJoin[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (source.alias && source.table) map.set(source.alias, source.table);
  joins.forEach((join) => {
    if (join.alias && join.table) map.set(join.alias, join.table);
  });
  return map;
}

/**
 * 稳定拓扑排序：能把每条 join 排到「左别名已就绪」的位置就排，
 * 保证结果仍是合法 JOIN 顺序；兄弟节点保持原有相对顺序。
 */
export function sortJoinsByDependency(
  source: BaqSourceRef,
  joins: BaqJoin[],
): JoinSortResult {
  const known = new Set<string>([source.alias, ...joins.map((j) => j.alias)]);
  const ready = new Set<string>([source.alias]);
  const remaining = [...joins];
  const out: BaqJoin[] = [];

  while (remaining.length > 0) {
    // 左别名悬空（指向不存在的别名）时不再等它，交给 execute_baq 报错，
    // 免得一条坏数据把整张画布的顺序卡死
    const index = remaining.findIndex(
      (join) => ready.has(join.leftAlias) || !known.has(join.leftAlias),
    );
    if (index < 0) {
      // 剩下的互相依赖成环或自引用
      return { joins, changed: false, cycle: true };
    }
    const [join] = remaining.splice(index, 1);
    out.push(join);
    ready.add(join.alias);
  }

  return {
    joins: out,
    changed: out.some((join, index) => join !== joins[index]),
    cycle: false,
  };
}

/** 把 childAlias 的父表改成 parentAlias 是否会形成环 */
export function wouldCreateCycle(
  source: BaqSourceRef,
  joins: BaqJoin[],
  childAlias: string,
  parentAlias: string,
): boolean {
  if (!childAlias || !parentAlias) return false;
  if (childAlias === parentAlias) return true;
  if (parentAlias === source.alias) return false;
  const parentOf = new Map<string, string>();
  joins.forEach((join) => parentOf.set(join.alias, join.leftAlias));
  parentOf.set(childAlias, parentAlias);
  const seen = new Set<string>();
  let cursor: string | undefined = parentAlias;
  while (cursor) {
    if (cursor === childAlias) return true;
    if (cursor === source.alias) return false;
    if (seen.has(cursor)) return true; // 原本就存在的环
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

/** alias 的全部下游别名（不含自身） */
export function descendantsOf(joins: BaqJoin[], alias: string): Set<string> {
  const children = new Map<string, string[]>();
  joins.forEach((join) => {
    children.set(join.leftAlias, [
      ...(children.get(join.leftAlias) ?? []),
      join.alias,
    ]);
  });
  const out = new Set<string>();
  const stack = [alias];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    (children.get(current) ?? []).forEach((child) => {
      if (out.has(child)) return;
      out.add(child);
      stack.push(child);
    });
  }
  return out;
}

/** 别名 → 层级（主表 0，直接挂在主表下 1，依次递增）；有环时该分支回退到 1 */
export function joinDepths(
  source: BaqSourceRef,
  joins: BaqJoin[],
): Map<string, number> {
  const parentOf = new Map<string, string>();
  joins.forEach((join) => parentOf.set(join.alias, join.leftAlias));
  const depths = new Map<string, number>();
  if (source.alias) depths.set(source.alias, 0);
  const resolve = (alias: string, seen: Set<string>): number => {
    const cached = depths.get(alias);
    if (cached !== undefined) return cached;
    if (alias === source.alias) return 0;
    if (seen.has(alias)) return 1; // 环：给它一个稳定值，别无限递归
    seen.add(alias);
    const parent = parentOf.get(alias);
    const depth = parent ? resolve(parent, seen) + 1 : 1;
    depths.set(alias, depth);
    return depth;
  };
  joins.forEach((join) => resolve(join.alias, new Set<string>()));
  return depths;
}

/** 按已有 join 反推「该表应该挂在谁下面」——同层里出现次数最多的父表优先（无则空） */
export function mostCommonParent(
  joins: BaqJoin[],
  table: string,
): string | null {
  const counts = new Map<string, number>();
  joins
    .filter((join) => join.table === table)
    .forEach((join) =>
      counts.set(join.leftAlias, (counts.get(join.leftAlias) ?? 0) + 1),
    );
  let best: string | null = null;
  let bestCount = 0;
  counts.forEach((count, alias) => {
    if (count > bestCount) {
      best = alias;
      bestCount = count;
    }
  });
  return best;
}

/**
 * 新加一张表时自动挑父表：优先挑「目标表用外键指向它」的画布表
 * （下钻最常见：详情 → 主档），其次挑「它用外键指向目标表」的；
 * 都没命中就返回 null（调用方回退到主表）。
 */
export function suggestParentAlias(
  source: BaqSourceRef,
  joins: BaqJoin[],
  targetTable: string,
  relations: BaqRelation[],
): string | null {
  if (!targetTable) return null;
  const entries = [
    { alias: source.alias, table: source.table },
    ...joins.map((join) => ({ alias: join.alias, table: join.table })),
  ].filter((entry) => !!entry.table);
  const scored: { alias: string; score: number }[] = [];
  entries.forEach((entry, index) => {
    const downstream = relations.some(
      (rel) => rel.table === targetTable && rel.refTable === entry.table,
    );
    const upstream = relations.some(
      (rel) => rel.table === entry.table && rel.refTable === targetTable,
    );
    if (!downstream && !upstream) return;
    // 下钻优先；同分取画布顺序更靠后的（层级更深的表）
    scored.push({ alias: entry.alias, score: (downstream ? 2 : 1) * 100 + index });
  });
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].alias;
}

/**
 * 一次性把 definition 的 joins 修成「依赖顺序合法」。
 * 用于保存 / 预览前的兜底（人工编辑、历史数据都可能留下乱序）。
 */
export function normalizeDefinition(definition: BaqDefinition): BaqDefinition {
  const result = sortJoinsByDependency(definition.source, definition.joins);
  if (!result.changed || result.cycle) return definition;
  return { ...definition, joins: result.joins };
}

/** 下一个未被占用的别名 t{n}（删过 join 也不会撞名） */
export function nextAlias(used: Iterable<string>): string {
  const taken = new Set(used);
  let index = 1;
  while (taken.has(`t${index}`)) index += 1;
  return `t${index}`;
}
