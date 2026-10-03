/**
 * 金额与币别格式化（多币别改造 · 第 1 期）
 *
 * 约定：
 *   · 一切金额展示都必须走本模块，**不要在页面里硬编码 ¥**。
 *   · 币别元数据（符号 / 小数位）来自 erp_currencies；未加载完成时用内置兜底清单，
 *     加载完成后自动触发订阅者重渲染，所以首屏即使闪一下兜底符号也会立刻纠正。
 *   · 本位币由 current_base_currency() 决定（后端 RPC），前端只缓存不判断。
 *   · 结构性事实留代码：币别 code 是数据（走库），不是 i18n 键。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import i18n from '../i18n';
import { supabase } from './supabase';

export const CURRENCY_TABLE = 'erp_currencies_s_539dcf81_b';
export const EXCHANGE_RATE_TABLE = 'erp_exchange_rates_s_539dcf81_b';

export interface CurrencyMeta {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isBase: boolean;
  status: string;
}

/** 内置兜底：与 deploy_65 的 seed_tenant_currencies() 清单保持一致 */
export const FALLBACK_CURRENCIES: CurrencyMeta[] = [
  { code: 'CNY', name: '人民币', symbol: '¥', decimalPlaces: 2, isBase: true, status: 'active' },
  { code: 'USD', name: '美元', symbol: '$', decimalPlaces: 2, isBase: false, status: 'active' },
  { code: 'EUR', name: '欧元', symbol: '€', decimalPlaces: 2, isBase: false, status: 'active' },
  { code: 'HKD', name: '港币', symbol: 'HK$', decimalPlaces: 2, isBase: false, status: 'active' },
  { code: 'JPY', name: '日元', symbol: 'JP¥', decimalPlaces: 0, isBase: false, status: 'active' },
  { code: 'GBP', name: '英镑', symbol: '£', decimalPlaces: 2, isBase: false, status: 'active' },
];

const DEFAULT_BASE_CURRENCY = 'CNY';

export interface CurrencyRegistryState {
  loaded: boolean;
  baseCurrency: string;
  currencies: CurrencyMeta[];
}

let state: CurrencyRegistryState = {
  loaded: false,
  baseCurrency: DEFAULT_BASE_CURRENCY,
  currencies: FALLBACK_CURRENCIES,
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CurrencyRegistryState {
  return state;
}

// 语言切换时让金额展示同步重渲染（千分位/小数点习惯随语言走）
i18n.on('languageChanged', () => {
  emit();
});

function normalizeCode(code?: string | null): string {
  return String(code ?? '').trim().toUpperCase();
}

/** 只认启用的币别；未登记的代码原样回退成「已停用/自定义」元数据，绝不抛错 */
export function resolveCurrencyMeta(code?: string | null): CurrencyMeta {
  const target = normalizeCode(code) || state.baseCurrency;
  const found = state.currencies.find((item) => item.code === target);
  if (found) return found;

  const fallback = FALLBACK_CURRENCIES.find((item) => item.code === target);
  if (fallback) return fallback;

  return {
    code: target || DEFAULT_BASE_CURRENCY,
    name: target || DEFAULT_BASE_CURRENCY,
    symbol: target ? `${target} ` : '¥',
    decimalPlaces: 2,
    isBase: target === state.baseCurrency,
    status: 'unknown',
  };
}

let loadPromise: Promise<void> | null = null;

/**
 * 当前租户作用域（纵深防御的第二层）。
 *
 * 第一层权威隔离在数据库：deploy_67 给币别/汇率装了 RESTRICTIVE 租户策略，
 * 连 super_admin 也只能看到自己租户的行。此前那两张表只有 PERMISSIVE 策略，
 * 而它的 super_admin 分支对 tenant_id 完全不设限 —— 超管打开币别页时整张表
 * 跨租户可见，表现为「每个币种出现两份」（tenant 1 与 tenant 2 各一份种子）。
 *
 * 这里再显式带一次 tenant_id 是防御性的：万一那条 RESTRICTIVE 策略被删掉或
 * 改回 PERMISSIVE，界面不会静默复发。
 *
 * 由 AuthContext 在 resolveTenantId() 之后注入 —— 那里才是租户的权威来源
 * （sys_users.tenant_id > JWT app_metadata.tenant_id）。传 null = 未分配租户/登出。
 */
let tenantScope: number | null = null;

export function setCurrencyTenantScope(tenantId: number | null): void {
  const next =
    typeof tenantId === 'number' && Number.isFinite(tenantId) ? tenantId : null;
  if (tenantScope === next) return;

  tenantScope = next;
  loadPromise = null;

  if (next === null) {
    // 登出 / 未分配租户：回到内置兜底，避免上一个租户的币别残留在界面上
    state = {
      loaded: false,
      baseCurrency: DEFAULT_BASE_CURRENCY,
      currencies: FALLBACK_CURRENCIES,
    };
    emit();
    return;
  }

  void loadCurrencyRegistry(true);
}

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string | null;
  decimal_places: number | null;
  is_base: boolean | null;
  status: string | null;
}

/**
 * 加载币别元数据 + 本位币。幂等：同一会话只真正请求一次。
 * 失败时保留兜底清单（不抛错），避免把整个界面打挂。
 */
export function loadCurrencyRegistry(force = false): Promise<void> {
  if (loadPromise && !force) return loadPromise;

  loadPromise = (async () => {
    try {
      // 租户过滤（纵深防御）：tenantScope 尚未注入时交给 RLS 兜底，
      // 注入后由 setCurrencyTenantScope() 强制重新加载并收敛到本租户
      const currencyQuery = supabase
        .from(CURRENCY_TABLE)
        .select('code, name, symbol, decimal_places, is_base, status')
        .eq('is_deleted', 'n')
        .order('sort_order');

      const [currencyResult, baseResult] = await Promise.all([
        tenantScope === null
          ? currencyQuery
          : currencyQuery.eq('tenant_id', tenantScope),
        supabase.rpc('current_base_currency'),
      ]);

      const rows = (currencyResult.data ?? []) as CurrencyRow[];
      const rpcBase = normalizeCode(
        typeof baseResult.data === 'string' ? baseResult.data : null
      );

      if (rows.length > 0) {
        state = {
          loaded: true,
          baseCurrency: rpcBase || rows.find((row) => row.is_base)?.code || DEFAULT_BASE_CURRENCY,
          currencies: rows.map((row) => ({
            code: normalizeCode(row.code),
            name: row.name,
            symbol: row.symbol ?? normalizeCode(row.code),
            decimalPlaces: Number(row.decimal_places ?? 2),
            isBase: Boolean(row.is_base),
            status: row.status ?? 'active',
          })),
        };
      } else {
        state = { ...state, loaded: true, baseCurrency: rpcBase || DEFAULT_BASE_CURRENCY };
      }

      emit();
    } catch (error) {
      // 币别元数据拿不到不应阻断业务界面；保留兜底并留痕
      console.error('Error loading currency registry:', error);
      state = { ...state, loaded: true };
      emit();
    }
  })();

  return loadPromise;
}

/** 强制重新加载（币别页保存后调用，让全站格式化立刻跟上） */
export function refreshCurrencyRegistry(): Promise<void> {
  loadPromise = null;
  return loadCurrencyRegistry(true);
}

export function getBaseCurrency(): string {
  return state.baseCurrency;
}

export function getCurrencyOptions(): CurrencyMeta[] {
  return state.currencies;
}

function currentLocale(): string {
  return i18n.resolvedLanguage || i18n.language || 'zh-CN';
}

export interface MoneyFormatOptions {
  /** 不显示币种符号（用于已经在币种列里展示过符号的表格） */
  hideSymbol?: boolean;
  /** 强制小数位；默认取币别的小数位 */
  decimalPlaces?: number;
  /** 空值展示；默认 '-' */
  fallback?: string;
}

/**
 * 金额格式化：`¥1,234.00` / `$1,234.00` / `JP¥1,234`
 * 第二个参数传该行/该单据的币种；不传则用本位币。
 */
export function formatMoney(
  value: number | string | null | undefined,
  currency?: string | null,
  options?: MoneyFormatOptions
): string {
  const fallback = options?.fallback ?? '-';
  if (value === null || value === undefined || value === '') return fallback;

  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;

  const meta = resolveCurrencyMeta(currency);
  const digits = options?.decimalPlaces ?? meta.decimalPlaces;
  const text = num.toLocaleString(currentLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  return options?.hideSymbol ? text : `${meta.symbol}${text}`;
}

/**
 * 汇率格式化：默认 8 位小数（与 erp_exchange_rates.rate 的 NUMERIC(18,8) 一致），
 * 末尾多余的 0 会裁掉，方便“1.0000”显示成“1”。
 */
export function formatRate(value: number | string | null | undefined, maxDigits = 8): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(currentLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDigits,
  });
}

/** 数量等非金额数字（保留 4 位，对齐 DECIMAL(18,4)） */
export function formatQuantity(value: number | string | null | undefined, digits = 4): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(currentLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export interface CurrencyRegistryHook {
  loaded: boolean;
  baseCurrency: string;
  currencies: CurrencyMeta[];
  /** 等价于 formatMoney，但已绑定当前语言，页面直接引用即可 */
  formatMoney: (value: number | string | null | undefined, currency?: string | null, options?: MoneyFormatOptions) => string;
  formatRate: (value: number | string | null | undefined, maxDigits?: number) => string;
  formatQuantity: (value: number | string | null | undefined, digits?: number) => string;
  getMeta: (code?: string | null) => CurrencyMeta;
}

/**
 * 订阅币别注册表。币别数据加载完成 / 强制刷新后会触发重渲染，
 * 因此页面只需 `const { formatMoney } = useCurrencyRegistry();` 即可。
 */
export function useCurrencyRegistry(): CurrencyRegistryHook {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const hookFormatMoney = useCallback(
    (value: number | string | null | undefined, currency?: string | null, options?: MoneyFormatOptions) =>
      formatMoney(value, currency, options),
    // snapshot 参与依赖：locale 或币别元数据变化时让引用失效，促使使用方重渲染
    [snapshot]
  );

  const getMeta = useCallback((code?: string | null) => resolveCurrencyMeta(code), [snapshot]);

  return useMemo(
    () => ({
      loaded: snapshot.loaded,
      baseCurrency: snapshot.baseCurrency,
      currencies: snapshot.currencies,
      formatMoney: hookFormatMoney,
      formatRate,
      formatQuantity,
      getMeta,
    }),
    [snapshot, hookFormatMoney, getMeta]
  );
}
