"use strict";
// 用 macOS 自带 PDFKit（通过 Swift）把 PDF 页面渲染成 JPEG，供视觉模型 OCR。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const SWIFT = `import Foundation
import PDFKit
import AppKit
let a = CommandLine.arguments
guard a.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("ERR open"); exit(1) }
let out = a[2]
let maxSide: CGFloat = a.count > 3 ? CGFloat(Double(a[3]) ?? 1800) : 1800
let first = a.count > 4 ? max(1, Int(a[4]) ?? 1) : 1
let last = min(doc.pageCount, a.count > 5 ? Int(a[5]) ?? doc.pageCount : doc.pageCount)
print("PAGES \\(doc.pageCount)")
if first <= last { for i in first...last {
  guard let page = doc.page(at: i - 1) else { continue }
  let b = page.bounds(for: .mediaBox); let s = maxSide / max(b.width, b.height)
  let img = page.thumbnail(of: NSSize(width: b.width * s, height: b.height * s), for: .mediaBox)
  guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else { continue }
  let p = "\\(out)/p\\(String(format: "%04d", i)).jpg"; try? jpg.write(to: URL(fileURLWithPath: p)); print("OK \\(p)")
} }
`;

const TEXT_SWIFT = `import Foundation
import PDFKit
let a = CommandLine.arguments
guard a.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("ERR open"); exit(1) }
print("PAGES \\(doc.pageCount)")
for i in 0..<doc.pageCount { print("<!-- 第\\(i + 1)页 -->"); print(doc.page(at: i)?.string ?? "") }
`;

function run(cmd, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function createPdf(dataDir) {
  const bin = path.join(dataDir, "bin", "pdfpages");

  async function ensureBinary() {
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const src = path.join(path.dirname(bin), "pdfpages.swift");
    fs.writeFileSync(src, SWIFT);
    try {
      await run("/usr/bin/swiftc", ["-O", src, "-o", bin], 300000);
    } catch (err) {
      throw new Error(`编译 PDF 渲染工具失败（需要 Xcode 命令行工具）：${err.message}`);
    }
    return bin;
  }

  const textBin = path.join(dataDir, "bin", "pdftext");
  async function ensureTextBinary() {
    if (fs.existsSync(textBin)) return textBin;
    fs.mkdirSync(path.dirname(textBin), { recursive: true });
    const src = path.join(path.dirname(textBin), "pdftext.swift");
    fs.writeFileSync(src, TEXT_SWIFT);
    try { await run("/usr/bin/swiftc", ["-O", src, "-o", textBin], 300000); }
    catch (err) { throw new Error(`编译 PDF 文字提取工具失败（需要 Xcode 命令行工具）：${err.message}`); }
    return textBin;
  }

  /** 读 PDF 自带的文字层（扫描版没有文字层，返回的几乎是空的）。页之间有 <!-- 第N页 --> 标记。 */
  async function text(file) {
    const exe = await ensureTextBinary();
    const out = await run(exe, [file], 120000);
    return { pages: Number((out.match(/PAGES (\d+)/) || [])[1] || 0), text: out.replace(/^PAGES \d+\n/, "") };
  }

  /** 返回 [{page, file}]；调用方用完后删除 dir。 */
  async function render(pdfBuffer, { first = 1, last = 999, maxSide = 1800 } = {}) {
    const exe = await ensureBinary();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaoyan-pdf-"));
    const pdfFile = path.join(dir, "in.pdf");
    fs.writeFileSync(pdfFile, pdfBuffer);
    const out = await run(exe, [pdfFile, dir, String(maxSide), String(first), String(last)]);
    const total = Number((out.match(/PAGES (\d+)/) || [])[1] || 0);
    const pages = out.split("\n").filter((l) => l.startsWith("OK ")).map((l) => {
      const file = l.slice(3).trim();
      return { page: Number(path.basename(file).replace(/\D/g, "")), file };
    });
    return { dir, total, pages };
  }

  /** 用 macOS 自带 sips 从一页图片里裁出一块；box 是 0–1 的相对坐标 [x1,y1,x2,y2]。返回 base64 JPEG。 */
  async function crop(base64, box) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaoyan-crop-"));
    try {
      const src = path.join(dir, "in.jpg");
      const out = path.join(dir, "out.jpg");
      fs.writeFileSync(src, Buffer.from(base64, "base64"));
      const info = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", src], 30000);
      const W = Number((info.match(/pixelWidth: (\d+)/) || [])[1]);
      const H = Number((info.match(/pixelHeight: (\d+)/) || [])[1]);
      if (!W || !H) throw new Error("读不出图片尺寸");
      const x = Math.max(0, Math.floor(box[0] * W)), y = Math.max(0, Math.floor(box[1] * H));
      const w = Math.min(W - x, Math.ceil((box[2] - box[0]) * W)), h = Math.min(H - y, Math.ceil((box[3] - box[1]) * H));
      await run("/usr/bin/sips", ["-c", String(h), String(w), "--cropOffset", String(y), String(x), src, "--out", out], 30000);
      return fs.readFileSync(out).toString("base64");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { render, crop, text };
}

module.exports = { createPdf };
