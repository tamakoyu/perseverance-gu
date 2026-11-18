"use strict";
// 题库包：把已经识别好的题库（题目、英语单元信息、题目引用的图片）打成一个 .zip，
// 别人一键导入即可，不用再 OCR / 识别。纯 Node 实现 zip 读写，不依赖系统工具（macOS / Windows 通用）。
// 只打包题库，不含错题、作答记录、生词、设置等个人数据。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { fail, nowIso } = require("./util.cjs");

const FORMAT = "kaoyan-bank-pack";
const ID_RE = /^[0-9a-f-]{36}$/;

// ── CRC32 ──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── zip 写入（JPEG 直接存储，JSON 用 deflate） ─────────
function writeZip(file, entries) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  try {
    for (const { name, data, compress } of entries) {
      const nameBuf = Buffer.from(name, "utf8");
      const body = compress ? zlib.deflateRawSync(data) : data;
      const method = compress ? 8 : 0;
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
      fs.writeSync(fd, local); fs.writeSync(fd, nameBuf); fs.writeSync(fd, body);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14);
      cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);
      offset += 30 + nameBuf.length + body.length;
      if (offset > 0xffffffff) fail("题库包超过 4GB，无法打包");
    }
    const cenBuf = Buffer.concat(central);
    fs.writeSync(fd, cenBuf);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, end);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

// ── zip 读取（支持存储 / deflate；兼容系统「压缩」重新打的包） ──
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail("不是有效的 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail("zip 目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(dataStart, dataStart + compSize);
    out.set(name, () => (method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : fail(`不支持的压缩方式：${method}`)));
  }
  return out;
}

/** 打开题库包：.zip 文件，或解压后的文件夹。返回 { pack, image(id) }。 */
function openPack(src) {
  if (!src) fail("请填写题库包路径");
  if (!fs.existsSync(src)) fail(`找不到：${src}`);
  if (fs.statSync(src).isDirectory()) {
    let dir = src;
    if (!fs.existsSync(path.join(dir, "pack.json"))) {
      const sub = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((d) => fs.existsSync(path.join(d, "pack.json")));
      if (!sub) fail("这个文件夹里没有 pack.json，不是题库包");
      dir = sub;
    }
    return {
      pack: JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8")),
      image: (id) => { const f = path.join(dir, "images", `${id}.jpg`); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    };
  }
  const zip = readZip(src);
  const packName = [...zip.keys()].find((k) => k === "pack.json" || k.endsWith("/pack.json"));
  if (!packName) fail("zip 里没有 pack.json，不是题库包");
  const prefix = packName.slice(0, -"pack.json".length);
  return {
    pack: JSON.parse(zip.get(packName)().toString("utf8")),
    image: (id) => { const g = zip.get(`${prefix}images/${id}.jpg`); return g ? g() : null; },
  };
}

const imageIds = (q) => [...(q.images || []), ...(q.figures || [])].filter((x) => typeof x === "string" && ID_RE.test(x));
const keyOf = (q) => `${q.subject}|${q.paper}|${q.part || ""}|${q.number}`;

function createPack({ store, imageDir, version }) {
  function defaultDir() {
    const home = os.homedir();
    for (const d of ["Downloads", "Desktop"]) if (fs.existsSync(path.join(home, d))) return path.join(home, d);
    return home;
  }

  function summary() {
    const qs = store.list("bank");
    const papers = new Map();
    for (const q of qs) papers.set(q.paper, (papers.get(q.paper) || 0) + 1);
    const subjects = {};
    for (const q of qs) subjects[q.subject] = (subjects[q.subject] || 0) + 1;
    return { questions: qs.length, papers: papers.size, subjects, defaultDir: defaultDir() };
  }

  /** 导出：subjects 为空表示全部。 */
  function exportPack({ dir, subjects } = {}) {
    let qs = store.list("bank");
    if (subjects?.length) qs = qs.filter((q) => subjects.includes(q.subject));
    if (!qs.length) fail("题库是空的，没有可导出的题目");
    const papers = new Set(qs.map((q) => q.paper));
    const engUnits = store.list("engUnits").filter((u) => papers.has(u.paper));
    const ids = [...new Set(qs.flatMap(imageIds))];
    const entries = [];
    let missing = 0;
    for (const id of ids) {
      const f = path.join(imageDir, `${id}.jpg`);
      if (fs.existsSync(f)) entries.push({ name: `images/${id}.jpg`, data: fs.readFileSync(f) });
      else missing++;
    }
    const pack = {
      format: FORMAT, version: 1, pluginVersion: version, createdAt: nowIso(),
      counts: { questions: qs.length, engUnits: engUnits.length, images: entries.length, papers: papers.size },
      papers: [...papers].sort(),
      questions: qs, engUnits,
    };
    entries.unshift({ name: "pack.json", data: Buffer.from(JSON.stringify(pack), "utf8"), compress: true });
    const outDir = dir || defaultDir();
    if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) fail(`找不到文件夹：${outDir}`);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const file = path.join(outDir, `考研题库包-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.zip`);
    writeZip(file, entries);
    return { file, size: fs.statSync(file).size, ...pack.counts, missingImages: missing };
  }

  /** 在下载 / 桌面里找题库包，方便一键选。 */
  function findPacks() {
    const home = os.homedir();
    const out = [];
    for (const d of ["Downloads", "Desktop", "Documents"]) {
      const dir = path.join(home, d);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (/^考研题库包.*\.zip$/i.test(n)) {
        const f = path.join(dir, n);
        try { out.push({ file: f, name: n, size: fs.statSync(f).size, mtime: fs.statSync(f).mtimeMs }); } catch { /* ignore */ }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  }

  function readPack(src) {
    const opened = openPack(src);
    const { pack } = opened;
    if (pack?.format !== FORMAT || !Array.isArray(pack.questions)) fail("不是考研工具箱的题库包");
    if (pack.version > 1) fail("题库包版本比插件新，请先更新插件");
    return opened;
  }

  function previewPack(src) {
    const { pack } = readPack(src);
    const existing = new Set(store.list("bank").map(keyOf));
    const fresh = pack.questions.filter((q) => !existing.has(keyOf(q))).length;
    return { ...pack.counts, papers: pack.papers, createdAt: pack.createdAt, fresh, dup: pack.questions.length - fresh };
  }

  /** 导入：已有的题（同科目 + 试卷 + 部分 + 题号）跳过，不覆盖自己导入或改过的题。 */
  function importPack(src) {
    const { pack, image } = readPack(src);
    const items = store.list("bank");
    const ids = new Set(items.map((q) => q.id));
    const keys = new Set(items.map(keyOf));
    fs.mkdirSync(imageDir, { recursive: true });
    let added = 0, skipped = 0, images = 0, missingImages = 0;
    for (const q of pack.questions) {
      if (!q || typeof q !== "object" || typeof q.id !== "string" || !q.paper || ids.has(q.id) || keys.has(keyOf(q))) { skipped++; continue; }
      for (const id of imageIds(q)) {
        const f = path.join(imageDir, `${id}.jpg`);
        if (fs.existsSync(f)) continue;
        const data = image(id);
        if (data) { fs.writeFileSync(f, data); images++; } else missingImages++;
      }
      items.push(q); ids.add(q.id); keys.add(keyOf(q)); added++;
    }
    if (added) store.saveList("bank", items);
    const units = store.list("engUnits");
    const unitIds = new Set(units.map((u) => u.id));
    let unitsAdded = 0;
    for (const u of pack.engUnits || []) if (u && u.id && !unitIds.has(u.id)) { units.push(u); unitIds.add(u.id); unitsAdded++; }
    if (unitsAdded) store.saveList("engUnits", units);
    return { added, skipped, images, missingImages, unitsAdded };
  }

  return { summary, exportPack, findPacks, previewPack, importPack };
}

module.exports = { createPack, writeZip, readZip };
