/**
 * 自检脚本：核对 CFETS 中间价的三种报价形态是否都换算正确。
 *
 * 为什么值得留着：这个数据源的报价方向是**混着**的（外币/CNY 与 CNY/外币），
 * 还夹带 100JPY 这类百单位前缀。站点一旦改版或字段变更，错误会是**静默的**
 * —— 日元错 100 倍、泰铢错 25 倍，金额算错却不会抛任何异常。
 * 汇率页抓出来的数看着不对时，先跑这个脚本，30 秒定位是数据源问题还是前端问题。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs src/scripts/checkCfets.ts
 */
import { crossRateToBase, fetchCfetsQuotes } from "../services/fxSource.js";

async function main() {
  const snap = await fetchCfetsQuotes(true);
  console.log("publishedAt:", snap.publishedAt);
  console.log("publishedDate:", snap.publishedDate);
  console.log("count:", snap.quotes.length);
  console.log();

  // 三种形态各取代表：USD=外币/CNY 直取、JPY=百单位前缀、THB=CNY/外币 需倒数
  const probes = ["USD", "EUR", "HKD", "JPY", "THB", "KRW"];
  for (const code of probes) {
    const q = snap.quotes.find((x) => x.currency === code);
    if (!q) {
      console.log(code.padEnd(4), "NOT FOUND");
      continue;
    }
    console.log(
      code.padEnd(4),
      q.pair.padEnd(12),
      "raw=" + String(q.rawPrice).padEnd(10),
      "inverted=" + String(q.inverted).padEnd(6),
      "=> 1 " + code + " = " + q.rateToCny + " CNY",
    );
  }

  console.log();
  console.log("交叉换算（本位币非 CNY 时）：");
  console.log("  1 EUR = ? USD :", crossRateToBase(snap, "EUR", "USD"));
  console.log("  1 USD = ? EUR :", crossRateToBase(snap, "USD", "EUR"));
  console.log("  1 USD = ? CNY :", crossRateToBase(snap, "USD", "CNY"));
  console.log("  1 CNY = ? CNY :", crossRateToBase(snap, "CNY", "CNY"));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
