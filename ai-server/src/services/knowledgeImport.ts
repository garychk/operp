/**
 * 知识库文件导入：把上传的文档抽取成纯文本。
 *
 * 支持的类型
 *   .docx                                   → mammoth（OOXML，只取纯文本，忽略样式）
 *   .pdf                                    → pdf-parse v2（pdfjs-dist 内核，按页取文本）
 *   .txt .text .md .markdown .log .csv      → 直接按文本解码
 * 明确不支持
 *   .doc 老式二进制 Word —— mammoth 只认 OOXML，无解，报错让用户另存为 .docx
 *
 * 设计约束
 * 1. 只做「文件 → 文本」，不碰数据库。入库仍由前端带 JWT 直连 PostgREST 写
 *    sys_ai_knowledge_docs，租户隔离继续由 RLS + tenant_id DEFAULT 保证 ——
 *    绝不让 ai-server 用 service_role 代写，否则又绕开 RLS 了。
 * 2. 逐个文件独立 try/catch：一个坏文件不能带崩整批，失败原因逐条回传前端。
 * 3. 文本长度上限保护：content 落库后要按段落切分逐块 embedding，
 *    超大文档会把 reindex 拖到分钟级并吃满模型配额，故截断 + truncated 标记，
 *    由前端显式提示「已截断」而不是静默丢内容。
 */
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import iconv from "iconv-lite";

/** 单篇文档正文上限（字符）。超出即截断，仅保留前 N 个字符 */
export const MAX_CONTENT_CHARS = 200_000;

/** 纯文本族：直接解码即可，不需要解析器 */
const PLAIN_TEXT_EXTS = new Set(["txt", "text", "md", "markdown", "log", "csv"]);

/** 前端 accept 与校验共用的白名单 */
export const SUPPORTED_UPLOAD_EXTS = ["txt", "text", "md", "markdown", "log", "csv", "docx", "pdf"] as const;

export interface KnowledgeFileInput {
  /** 原始文件名（含扩展名） */
  name: string;
  buffer: Buffer;
}

export interface ParsedKnowledgeFile {
  /** 原始文件名，前端用来对齐预览行 */
  name: string;
  ext: string;
  ok: boolean;
  /** 默认标题 = 文件名去扩展名（解析失败时为空串） */
  title: string;
  content: string;
  chars: number;
  /** 正文被截断到 MAX_CONTENT_CHARS */
  truncated: boolean;
  error?: string;
}

const stripBom = (value: string) => value.replace(/^\uFEFF/, "");

const countReplacementChars = (value: string) => {
  const matched = value.match(/\uFFFD/g);
  return matched ? matched.length : 0;
};

/**
 * 纯文本解码。
 *
 * UTF-8 优先；若解出替换字符（U+FFFD），说明原文大概率是 Windows 记事本存出来的
 * GBK/GB18030 —— 这是中文 txt 最常见的坑，直接按 UTF-8 读会得到满屏乱码。
 * 只有在回退结果「更干净」时才采用，避免把本来正常的文本改坏。
 */
function decodePlainText(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  const utf8Broken = countReplacementChars(utf8);
  if (utf8Broken > 0 && iconv.encodingExists("gb18030")) {
    const gb18030 = iconv.decode(buffer, "gb18030");
    if (countReplacementChars(gb18030) < utf8Broken) {
      return stripBom(gb18030);
    }
  }
  return stripBom(utf8);
}

/** 统一换行、压掉行尾空白与连续空行，让正文更适合切块检索 */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * busboy 默认按 latin1 解析 multipart 的文件名，中文名会变成「æ–‡æ¡£.docx」。
 * 这里按 latin1→utf8 还原；若还原后出现替换字符说明原名本来就是好的，保持不动。
 */
export function decodeUploadFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return countReplacementChars(decoded) > 0 ? name : decoded;
  } catch {
    return name;
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // pdf-parse v2 会「接管」传入的 TypedArray（转移到 worker 线程），
  // 所以必须复制一份，不能把 multer 的 buffer 直接交出去。
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // pageJoiner 默认会插入「-- 1 of 12 --」页标记，对知识库检索是噪声，关掉。
    const result = await parser.getText({ pageJoiner: "" });
    return result.text || "";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** 把单个文件抽取为纯文本。任何失败都收敛成 ok:false + error，不向上抛。 */
export async function parseKnowledgeFile({
  name,
  buffer,
}: KnowledgeFileInput): Promise<ParsedKnowledgeFile> {
  const ext = path.extname(name).replace(/^\./, "").toLowerCase();
  const extname = path.extname(name);
  const fallbackTitle = path.basename(name, extname).trim() || name.trim();
  const base: ParsedKnowledgeFile = {
    name,
    ext,
    ok: false,
    title: fallbackTitle,
    content: "",
    chars: 0,
    truncated: false,
  };

  try {
    if (ext === "doc") {
      throw new Error("不支持老式 .doc 格式，请在 Word 中「另存为 .docx」后再上传。");
    }
    if (!(SUPPORTED_UPLOAD_EXTS as readonly string[]).includes(ext)) {
      throw new Error(`不支持的文件类型 .${ext || "(无扩展名)"}，目前支持：${SUPPORTED_UPLOAD_EXTS.join(" / ")}`);
    }

    let raw: string;
    if (PLAIN_TEXT_EXTS.has(ext)) {
      raw = decodePlainText(buffer);
    } else if (ext === "docx") {
      raw = (await mammoth.extractRawText({ buffer })).value;
    } else {
      raw = await extractPdfText(buffer);
    }

    const normalized = normalizeWhitespace(raw);
    if (!normalized) {
      throw new Error(
        ext === "pdf"
          ? "该 PDF 提取不到文字，可能是扫描件/图片型 PDF（本功能不做 OCR），请改用可选中文字的版本。"
          : "该文件没有可提取的文本内容（空文档？）。",
      );
    }

    const truncated = normalized.length > MAX_CONTENT_CHARS;
    const content = truncated ? normalized.slice(0, MAX_CONTENT_CHARS) : normalized;

    return { ...base, ok: true, content, chars: content.length, truncated };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 顺序解析一批文件（顺序执行：并发解析大 PDF 会把内存和 CPU 打满） */
export async function parseKnowledgeFiles(
  files: KnowledgeFileInput[],
): Promise<ParsedKnowledgeFile[]> {
  const results: ParsedKnowledgeFile[] = [];
  for (const file of files) {
    results.push(await parseKnowledgeFile(file));
  }
  return results;
}
