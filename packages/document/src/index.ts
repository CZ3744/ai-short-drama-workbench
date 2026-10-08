import fs from "node:fs/promises";
import path from "node:path";

export interface DocumentInput {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}

export interface ParsedDocument {
  id: string;
  name: string;
  type: "txt" | "md" | "pdf" | "docx" | "unknown";
  status: "parsed" | "failed" | "partial";
  wordCount: number;
  extractedText: string;
  extractedTextPath?: string;
  warnings: string[];
  metadata?: Record<string, any>;
}

export interface DocumentParseResult {
  success: boolean;
  documents: ParsedDocument[];
  mergedText?: string;
  mergedTextPath?: string;
  totalWordCount: number;
  errors: string[];
}

function detectFileType(filename: string, mimeType?: string): ParsedDocument["type"] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".txt") return "txt";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (mimeType) {
    if (mimeType.includes("text/plain")) return "txt";
    if (mimeType.includes("text/markdown")) return "md";
    if (mimeType.includes("application/pdf")) return "pdf";
    if (mimeType.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) return "docx";
  }
  return "unknown";
}

function countWords(text: string): number {
  // 中文按字符计数，英文按单词计数
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const englishWords = text.replace(/[一-鿿]/g, " ").split(/\s+/).filter(w => w.length > 0).length;
  return chineseChars + englishWords;
}

async function parseTxt(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  const text = buffer.toString("utf-8");
  return { text, warnings: [] };
}

async function parseMd(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  const text = buffer.toString("utf-8");
  // 简单的 Markdown 清理
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, "") // 移除标题标记
    .replace(/\*\*(.*?)\*\*/g, "$1") // 移除粗体
    .replace(/\*(.*?)\*/g, "$1") // 移除斜体
    .replace(/\[(.*?)\]\(.*?\)/g, "$1") // 移除链接，保留文本
    .replace(/```[\s\S]*?```/g, "") // 移除代码块
    .replace(/`(.*?)`/g, "$1") // 移除行内代码
    .replace(/^[-*+]\s+/gm, "") // 移除列表标记
    .replace(/^\d+\.\s+/gm, "") // 移除有序列表标记
    .replace(/^>\s+/gm, "") // 移除引用
    .replace(/\n{3,}/g, "\n\n"); // 压缩多余空行
  return { text: cleaned, warnings: [] };
}

async function parsePdf(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    const warnings: string[] = [];

    if (data.numpages === 0) {
      warnings.push("PDF 文件没有页面");
    }

    // 检查是否是扫描型 PDF（文本很少）
    if (data.text.length < 100 && data.numpages > 0) {
      warnings.push("当前优先支持文本型 PDF。扫描件、图片型 PDF 和 OCR 会在后续版本支持。");
    }

    return { text: data.text, warnings };
  } catch (error) {
    return {
      text: "",
      warnings: [`PDF 解析失败: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function parseDocx(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    const warnings: string[] = [];

    if (result.messages && result.messages.length > 0) {
      for (const msg of result.messages) {
        if (msg.type === "warning") {
          warnings.push(msg.message);
        }
      }
    }

    return { text: result.value, warnings };
  } catch (error) {
    return {
      text: "",
      warnings: [`DOCX 解析失败: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

export async function parseDocument(input: DocumentInput): Promise<ParsedDocument> {
  const type = detectFileType(input.filename, input.mimeType);
  const id = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // v0.2.4: reject oversize buffers before any parser loads them. mammoth /
  // pdf-parse will happily ingest 100+ MB and spike to several GB of heap
  // during extraction, OOM-ing the entire Node process. 50 MB is well past
  // any realistic textual document.
  const MAX_DOC_BYTES = 50 * 1024 * 1024;
  if (input.buffer.byteLength > MAX_DOC_BYTES) {
    return {
      id,
      name: input.filename,
      type,
      status: "failed",
      wordCount: 0,
      extractedText: "",
      warnings: [`文件过大（${(input.buffer.byteLength / 1024 / 1024).toFixed(1)} MB），超过 50 MB 上限。请拆分后上传。`]
    };
  }

  if (type === "unknown") {
    return {
      id,
      name: input.filename,
      type,
      status: "failed",
      wordCount: 0,
      extractedText: "",
      warnings: ["不支持的文件类型。当前支持 TXT、MD、PDF、DOCX。"]
    };
  }

  let text = "";
  let warnings: string[] = [];

  try {
    switch (type) {
      case "txt":
        ({ text, warnings } = await parseTxt(input.buffer));
        break;
      case "md":
        ({ text, warnings } = await parseMd(input.buffer));
        break;
      case "pdf":
        ({ text, warnings } = await parsePdf(input.buffer));
        break;
      case "docx":
        ({ text, warnings } = await parseDocx(input.buffer));
        break;
    }
  } catch (error) {
    return {
      id,
      name: input.filename,
      type,
      status: "failed",
      wordCount: 0,
      extractedText: "",
      warnings: [`解析失败: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  const wordCount = countWords(text);
  const status = text.length > 0 ? "parsed" : "failed";

  if (text.length === 0 && warnings.length === 0) {
    warnings.push("未能提取到文本内容");
  }

  return {
    id,
    name: input.filename,
    type,
    status,
    wordCount,
    extractedText: text,
    warnings
  };
}

export async function parseMultipleDocuments(inputs: DocumentInput[]): Promise<DocumentParseResult> {
  const documents: ParsedDocument[] = [];
  const errors: string[] = [];

  for (const input of inputs) {
    try {
      const doc = await parseDocument(input);
      documents.push(doc);
    } catch (error) {
      errors.push(`${input.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const parsedDocs = documents.filter(d => d.status === "parsed");
  const mergedText = parsedDocs.map(d => d.extractedText).join("\n\n---\n\n");
  const totalWordCount = parsedDocs.reduce((sum, d) => sum + d.wordCount, 0);

  return {
    success: parsedDocs.length > 0,
    documents,
    mergedText: mergedText || undefined,
    totalWordCount,
    errors
  };
}

export async function saveExtractedText(text: string, outputDir: string, filename: string): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, text, "utf-8");
  return outputPath;
}

export async function saveDocumentParseResult(result: DocumentParseResult, outputDir: string): Promise<{
  documentsPath: string;
  mergedTextPath?: string;
}> {
  await fs.mkdir(outputDir, { recursive: true });

  // 保存文档解析结果
  const documentsPath = path.join(outputDir, "documents.json");
  await fs.writeFile(documentsPath, JSON.stringify(result.documents, null, 2), "utf-8");

  // 保存合并文本
  let mergedTextPath: string | undefined;
  if (result.mergedText) {
    mergedTextPath = path.join(outputDir, "merged_source.txt");
    await fs.writeFile(mergedTextPath, result.mergedText, "utf-8");
  }

  return { documentsPath, mergedTextPath };
}
