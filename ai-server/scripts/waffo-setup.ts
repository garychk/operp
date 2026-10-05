/**
 * Waffo Pancake 订阅初始化脚本。
 *
 * 一次性跑：创建「按月订阅」商品（test 环境），打印 Product ID，
 * 把它回填到 ai-server/.env 的 WAFFO_MONTHLY_PRODUCT_ID；可选注册 webhook。
 *
 * 用法（在 ai-server 目录）：
 *   npx tsx scripts/waffo-setup.ts                       # 只创建商品
 *   PRICE=19.99 CURRENCY=USD npx tsx scripts/waffo-setup.ts
 *   WAFFO_WEBHOOK_URL=https://xxx.ngrok.app/api/subscription/webhook npx tsx scripts/waffo-setup.ts
 *   npx tsx scripts/waffo-setup.ts --publish             # 顺带把商品发布到生产（上线时才用）
 *
 * 依赖 .env 里的 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY / WAFFO_STORE_ID。
 */
import "../src/config/loadEnv.js";
import { WaffoPancake, WaffoPancakeError } from "@waffo/pancake-ts";

const merchantId = process.env.WAFFO_MERCHANT_ID;
const storeId = process.env.WAFFO_STORE_ID;
const privateKeyBase = process.env.WAFFO_PRIVATE_KEY_BASE64
  ? Buffer.from(process.env.WAFFO_PRIVATE_KEY_BASE64, "base64").toString("utf-8")
  : process.env.WAFFO_PRIVATE_KEY;

if (!merchantId || !privateKeyBase || !storeId) {
  console.error("缺少 WAFFO_MERCHANT_ID / 私钥 / WAFFO_STORE_ID，请先配置 ai-server/.env");
  process.exit(1);
}

const price = process.env.PRICE ?? "19.99";
const currency = process.env.CURRENCY ?? "USD";
const publish = process.argv.includes("--publish");
const webhookUrl = process.env.WAFFO_WEBHOOK_URL;

const client = new WaffoPancake({ merchantId, privateKey: privateKeyBase });

async function main() {
  // 商品 ID 稳定的话可以重复跑（先查再建）；这里简单起见每次新建一个测试商品
  const { product } = await client.subscriptionProducts.create({
    storeId,
    name: "OPERP 租户订阅（按月）",
    description: "OPERP ERP 系统租户月度订阅，支付成功后自动延长一个月使用期限。",
    billingPeriod: "monthly",
    prices: {
      [currency]: { amount: price, taxIncluded: true, taxCategory: "saas" },
    },
    metadata: { tenant_scope: "per_tenant", months: 1 },
  });

  console.log("✅ 已创建按月订阅商品（当前环境：test）");
  console.log("   Product ID:", product.id);
  console.log(`   价格: ${currency} ${price} / 月`);
  console.log("→ 把 Product ID 回填到 ai-server/.env：");
  console.log(`   WAFFO_MONTHLY_PRODUCT_ID=${product.id}`);

  if (publish) {
    const { product: published } = await client.subscriptionProducts.publish({ id: product.id });
    console.log("✅ 已发布到生产环境:", published.id);
  } else {
    console.log("ℹ️ 商品当前只在 test 环境；上线时加 --publish 发布到 prod。");
  }

  if (webhookUrl) {
    const { webhook } = await client.webhooks.add({
      storeId,
      channel: "http",
      url: webhookUrl,
      events: ["subscription.activated", "subscription.payment_succeeded"],
      testMode: !publish,
    });
    console.log("✅ 已注册 webhook:", webhook.id, "->", webhookUrl);
  } else {
    console.log("ℹ️ 未设置 WAFFO_WEBHOOK_URL，跳过 webhook 注册（本地调试建议先用 ngrok）。");
  }
}

main().catch((err) => {
  if (err instanceof WaffoPancakeError) {
    console.error(`Waffo API 错误 status=${err.status}:`, JSON.stringify(err.errors, null, 2));
  } else {
    console.error("初始化失败:", err);
  }
  process.exit(1);
});
