import { APP_BUILD_TIME, APP_VERSION } from "../version.generated";

/**
 * 全局统一的版本展示入口。
 *
 * 数值来源：scripts/bump-version.cjs 在构建前写入的 src/version.generated.ts，
 * 而该文件又取自 package.json —— 也就是说全项目只有一个版本号，
 * 任何界面需要显示版本时都从这里取，不要写死字符串。
 */
export { APP_BUILD_TIME, APP_VERSION };

/** 界面统一使用的版本号（带 V 前缀），如 V1.0.1 */
export const APP_VERSION_TAG = `V${APP_VERSION}`;

/** 带构建日期的完整版本，如 V1.0.1（2026-10-13） */
export const APP_VERSION_FULL = `${APP_VERSION_TAG}（${APP_BUILD_TIME.slice(0, 10)}）`;
