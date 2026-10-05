/**
 * 法务静态页（服务条款 / 隐私政策）的内容结构。
 *
 * 页面是纯静态展示，不做数据请求。内容按语言拆成 content.zh.ts / content.en.ts，
 * 两边结构必须一致（同一组 section id），由 LegalPage.tsx 统一渲染。
 */

export type LegalBlock =
  /** 普通段落 */
  | { kind: 'p'; text: string }
  /** 带项目符号的列表 */
  | { kind: 'list'; items: string[] }
  /** 两列或三列表格 */
  | { kind: 'table'; head: string[]; rows: string[][] }
  /** 需要强调的提示框 */
  | { kind: 'callout'; text: string }
  /** 小标题（三级，用于 2.1 / 2.2 这类分节） */
  | { kind: 'sub'; text: string };

export interface LegalSection {
  /** 锚点 id，同时用于右侧目录 */
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  /** 路由 slug：/terms 或 /privacy */
  slug: 'terms' | 'privacy';
  title: string;
  /** 标题下方的一句话说明 */
  summary: string;
  /** 「最后更新」显示的日期文案 */
  updatedAt: string;
  /** 开篇引言 */
  intro: string;
  sections: LegalSection[];
  /** 文末签署行 */
  footer: string;
}

export type LegalSlug = LegalDoc['slug'];
