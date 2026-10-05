import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Segmented } from 'antd';
import { ArrowLeftOutlined, TranslationOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SupportedLanguage } from '../../i18n';
import type { LegalBlock, LegalDoc, LegalSlug } from './types';

interface LegalPageProps {
  slug: LegalSlug;
  /** 两种语言的完整文档集，用于顶栏切换标签时取另一个文档的标题 */
  docsZh: Record<LegalSlug, LegalDoc>;
  docsEn: Record<LegalSlug, LegalDoc>;
}

/** 单个内容块的渲染。表格走手写 table，避免为静态内容引入 antd Table 的分页/排序开销。 */
function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'p':
      return (
        <p className="mb-4 text-[15px] leading-[1.9] text-slate-600">{block.text}</p>
      );

    case 'sub':
      return (
        <h3 className="mb-3 mt-6 text-[15px] font-semibold text-slate-800">{block.text}</h3>
      );

    case 'list':
      return (
        <ul className="mb-4 list-none space-y-2 pl-1">
          {block.items.map((item, i) => (
            <li key={i} className="relative list-none pl-5 text-[15px] leading-[1.9] text-slate-600">
              <span className="absolute left-0 top-[11px] h-1.5 w-1.5 rounded-full bg-slate-300" />
              {item}
            </li>
          ))}
        </ul>
      );

    case 'table':
      return (
        <div className="mb-5 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="bg-slate-50">
                {block.head.map((h, i) => (
                  <th
                    key={i}
                    className="border-b border-slate-200 px-4 py-3 text-left font-semibold text-slate-700"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className={r % 2 === 1 ? 'bg-slate-50/60' : undefined}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="border-b border-slate-100 px-4 py-3 align-top leading-[1.7] text-slate-600 last:border-b-0"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'callout':
      return (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
          <p className="m-0 text-[14px] leading-[1.8] text-amber-900">{block.text}</p>
        </div>
      );

    default:
      return null;
  }
}

/**
 * 法务静态页外壳：与登录页一致的浅色渐变背景 + 顶栏（切换文档 / 语言 / 返回登录）
 * + 左侧目录 + 右侧正文。无需登录即可访问。
 */
export const LegalPage: React.FC<LegalPageProps> = ({ slug, docsZh, docsEn }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const language = (i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN') as SupportedLanguage;
  const docs = language === 'en-US' ? docsEn : docsZh;
  const doc = docs[slug];
  const [activeId, setActiveId] = useState(doc.sections[0]?.id ?? '');

  const sectionIds = useMemo(() => doc.sections.map((s) => s.id), [doc]);

  // 页面自持滚动：滚动发生在 scrollerRef 这个容器里，不依赖宿主页面的文档流滚动
  // （嵌在 iframe/预览面板里时文档流滚动可能被宿主吞掉）。
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 目录高亮跟随滚动位置：直接按「最后一个越过阈值线的章节」计算，
  // 比 IntersectionObserver 在章节跨界时更稳。
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const update = () => {
      const scrollerTop = scroller.getBoundingClientRect().top;
      const threshold = 88; // 吸顶栏高度

      // 滚到页尾时直接高亮最后一节，否则结尾几节永远抢不到高亮
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        setActiveId(sectionIds[sectionIds.length - 1] ?? '');
        return;
      }

      let current = sectionIds[0] ?? '';
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - scrollerTop <= threshold) {
          current = id;
        } else {
          break;
        }
      }
      setActiveId(current);
    };

    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [sectionIds]);

  const jumpTo = (id: string, behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollerRef.current;
    const el = document.getElementById(id);
    if (!scroller || !el) return;
    const top =
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      88;
    scroller.scrollTo({ top, behavior });
  };

  // 支持 /terms#fees 这类锚点深链：渲染完成后直接定位（不做平滑动画）
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash && sectionIds.includes(hash)) {
      const raf = requestAnimationFrame(() => jumpTo(hash, 'auto'));
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="relative h-screen overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 35%, #eef2ff 100%)' }}
    >
      <div className="login-bg" aria-hidden>
        <span className="login-bg__blob login-bg__blob--sky" />
        <span className="login-bg__blob login-bg__blob--violet" />
        <span className="login-bg__blob login-bg__blob--mint" />
        <span className="login-bg__sheen" />
      </div>

      <div ref={scrollerRef} className="relative z-10 h-full overflow-y-auto">
      {/* 顶栏 */}
      <header className="sticky top-0 z-20 border-b border-white/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-4 px-5">
          <Link to="/login" className="flex shrink-0 items-center gap-2 no-underline">
            <span className="text-lg font-semibold tracking-tight text-slate-900">OPERP</span>
          </Link>

          <div className="flex flex-1 justify-center">
            <Segmented
              value={slug}
              onChange={(value) => navigate(`/${value as LegalSlug}`)}
              options={[
                { label: docs.terms.title, value: 'terms' as LegalSlug },
                { label: docs.privacy.title, value: 'privacy' as LegalSlug },
              ]}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Dropdown
              trigger={['click']}
              menu={{
                selectable: true,
                selectedKeys: [language],
                onClick: ({ key }) => {
                  void i18n.changeLanguage(key as SupportedLanguage);
                },
                items: [
                  { key: 'zh-CN', label: t('language.zhCN') },
                  { key: 'en-US', label: t('language.enUS') },
                ],
              }}
            >
              <TranslationOutlined
                title={t('language.switch')}
                style={{ fontSize: 18, color: '#475569', cursor: 'pointer', padding: 6 }}
              />
            </Dropdown>

            <Link to="/login">
              <Button type="text" size="small" icon={<ArrowLeftOutlined />}>
                {t('legal.backToLogin')}
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* 正文 */}
      <div className="relative z-10 mx-auto grid max-w-[1120px] gap-8 px-5 py-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav className="sticky top-24">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t('legal.toc')}
            </p>
            <ul className="list-none space-y-1 border-l border-slate-200">
              {doc.sections.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(s.id)}
                    className={[
                      'w-full border-l-2 py-1.5 pl-3 pr-2 text-left text-[13px] leading-snug transition-colors',
                      activeId === s.id
                        ? '-ml-px border-slate-800 font-medium text-slate-900'
                        : 'border-transparent text-slate-500 hover:text-slate-800',
                    ].join(' ')}
                  >
                    {s.heading}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <main className="min-w-0 rounded-2xl border border-white/80 bg-white/90 p-6 shadow-[0_20px_60px_rgba(59,130,246,0.10)] backdrop-blur-md sm:p-9">
          <p className="mb-2 inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
            {t('legal.lastUpdated')}：{doc.updatedAt}
          </p>
          <h1 className="mb-3 text-[28px] font-semibold tracking-tight text-slate-900 sm:text-[32px]">
            {doc.title}
          </h1>
          <p className="mb-6 border-b border-slate-100 pb-6 text-[15px] leading-relaxed text-slate-500">
            {doc.summary}
          </p>

          <div className="mb-8 rounded-xl bg-slate-50 px-5 py-4">
            <p className="m-0 text-[15px] leading-[1.9] text-slate-600">{doc.intro}</p>
          </div>

          {doc.sections.map((section) => (
            <section key={section.id} id={section.id} className="mb-9 scroll-mt-24">
              <h2 className="mb-4 text-[18px] font-semibold text-slate-900">{section.heading}</h2>
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </section>
          ))}

          <div className="mt-10 border-t border-slate-100 pt-6">
            <p className="m-0 text-[13px] text-slate-400">{doc.footer}</p>
          </div>
        </main>
      </div>
      </div>
    </div>
  );
};
