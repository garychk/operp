/**
 * 金额输入框：自动带币种符号前缀，与 formatMoney 共用同一份币别元数据。
 *
 * 用法（替换原来的 `prefix="¥"` 硬编码）：
 *   <MoneyInput currency={form.getFieldValue('currency')} style={{ width: '100%' }} />
 *   <MoneyInput currency={record.currency} precision={4} />   // 单价等需要更多小数位
 *
 * 刻意**不**强制 precision：金额 2 位、单价 4 位、汇率 8 位由调用方按字段定，
 * 只在未显式传 precision 时套用币别默认小数位。
 */
import { InputNumber } from 'antd';
import type { InputNumberProps } from 'antd';
import { useCurrencyRegistry } from '../utils/money';

export interface MoneyInputProps
  extends Omit<InputNumberProps<number>, 'prefix'> {
  /** 该字段所属币种；不传则用本位币 */
  currency?: string | null;
  /** 覆盖符号前缀（例如汇率字段想显示「1 外币 =」而不是符号） */
  prefixOverride?: string;
}

export function MoneyInput({ currency, prefixOverride, precision, ...rest }: MoneyInputProps) {
  const { getMeta } = useCurrencyRegistry();
  const meta = getMeta(currency);

  return (
    <InputNumber<number>
      {...rest}
      precision={precision ?? meta.decimalPlaces}
      prefix={prefixOverride ?? meta.symbol}
    />
  );
}

export default MoneyInput;
