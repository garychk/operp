#!/usr/bin/env node
/**
 * 版本号统一管理脚本
 *
 * 唯一真相源：package.json 的 version 字段。
 * 每次构建前自动递增 patch，并把结果写入 src/version.generated.ts 供前端引用，
 * 从而保证界面所有显示版本的地方都来自同一个数字。
 *
 * 用法：
 *   node scripts/bump-version.cjs              # 递增 patch（build 前自动调用）
 *   node scripts/bump-version.cjs --sync       # 只按当前 package.json 重新生成，不自增
 *   node scripts/bump-version.cjs --set 1.2.3  # 强制指定版本号
 *   node scripts/bump-version.cjs --print      # 只打印当前版本（CI 打 tag 用）
 *
 * 版本基线为 1.0.1：当 package.json 里的版本低于基线时（例如初始的 0.0.0），
 * 一次性抬到基线，保证「从 1.0.1 开始、之后每次构建 +1」。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");
const OUT_PATH = path.join(ROOT, "src", "version.generated.ts");

/** 版本基线：首个构建产物从 1.0.1 开始 */
const BASE = "1.0.1";

function parseVersion(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a、b 均为 [major, minor, patch]，返回 -1 / 0 / 1 */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const isSync = argv.includes("--sync");
  const isPrint = argv.includes("--print");
  const setIndex = argv.indexOf("--set");
  const forcedRaw = setIndex >= 0 ? argv[setIndex + 1] : undefined;

  if (setIndex >= 0 && !forcedRaw) {
    throw new Error("--set 需要一个版本号参数，例如 --set 1.2.3");
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const current = parseVersion(pkg.version);
  const base = parseVersion(BASE);

  if (isPrint) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  let next;
  if (forcedRaw !== undefined) {
    const forced = parseVersion(forcedRaw);
    if (!forced) throw new Error(`--set 的值不是合法的 x.y.z 版本号：${forcedRaw}`);
    next = forced.join(".");
  } else if (isSync) {
    // 只同步，不自增：保证生成文件与 package.json 一致
    next = current ? current.join(".") : BASE;
  } else if (!current || compare(current, base) < 0) {
    // 低于基线（含初始的 0.0.0）→ 一次性抬到基线
    next = BASE;
  } else {
    next = [current[0], current[1], current[2] + 1].join(".");
  }

  if (!isSync && pkg.version !== next) {
    pkg.version = next;
    fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const buildTime = new Date().toISOString();
  fs.writeFileSync(
    OUT_PATH,
    [
      "// 本文件由 scripts/bump-version.cjs 自动生成，请勿手动修改。",
      "// 版本号唯一真相源：package.json 的 version（每次构建前自动递增 patch）。",
      `export const APP_VERSION = "${next}";`,
      `export const APP_BUILD_TIME = "${buildTime}";`,
      "",
    ].join("\n"),
  );

  const before = current ? current.join(".") : String(pkg.version);
  const action = isSync ? "同步" : forcedRaw !== undefined ? "指定" : "递增";
  console.log(`[version] ${action}：${before} → ${next}`);
  if (!isSync && !forcedRaw) {
    console.log(`[version] 本次构建产物版本为 V${next}，下次构建将产出 V${next} 的下一号`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[version] 失败：${error.message}`);
  process.exit(1);
}
