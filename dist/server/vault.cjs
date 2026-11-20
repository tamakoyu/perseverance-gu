"use strict";
// Obsidian 仓库读写：检索、读取、文件夹树、写笔记、周计划任务。
const fs = require("node:fs");
const path = require("node:path");
const { fail, today, atomicWrite } = require("./util.cjs");

const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules"]);
const SUBJECTS = ["数学", "408", "英语", "政治"];

function createVault(getRoot) {
  function root() {
    const r = getRoot();
    if (!r || !fs.existsSync(r) || !fs.statSync(r).isDirectory()) fail(`找不到 Obsidian 仓库：${r || "(未设置)"}，请在 设置 → 考研工具箱 里填写仓库路径（可点「自动检测 Obsidian 仓库」）`);
    return fs.realpathSync(r);
  }

  function inside(rel) {
    const base = root();
    const clean = String(rel || "").replace(/^\/+/, "");
    const abs = path.resolve(base, clean);
    if (abs !== base && !abs.startsWith(base + path.sep)) fail("路径超出仓库范围");
    return abs;
  }

  function walk(dir, out, filter) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || SKIP.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, out, filter);
      else if (ent.isFile() && ent.name.endsWith(".md") && (!filter || filter(p))) out.push(p);
    }
    return out;
  }

  function rel(abs) { return path.relative(root(), abs).split(path.sep).join("/"); }

  function terms(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    const parts = q.split(/[\s,，、;；]+/).filter(Boolean);
    const out = new Set(parts);
    // 连续中文长词再拆成二字词，提高召回
    for (const p of parts) {
      if (/^[一-龥]{4,}$/.test(p)) for (let i = 0; i < p.length - 1; i++) out.add(p.slice(i, i + 2));
    }
    return [...out];
  }

  function search(query, { limit = 8, includePlans = false } = {}) {
    const ts = terms(query);
    if (!ts.length) return [];
    const files = walk(root(), [], (p) => !/^(笔记规范|模板)\//.test(rel(p)) && (includePlans || !rel(p).startsWith("计划/")));
    const hits = [];
    for (const f of files) {
      const r = rel(f);
      const title = path.basename(f, ".md").toLowerCase();
      let body;
      try { body = fs.readFileSync(f, "utf8"); } catch { continue; }
      const lower = body.toLowerCase();
      let score = 0;
      let first = -1;
      for (const t of ts) {
        if (title.includes(t) || r.toLowerCase().includes(t)) score += 8 * t.length;
        let idx = lower.indexOf(t);
        let n = 0;
        while (idx >= 0 && n < 30) {
          if (first < 0 || idx < first) first = idx;
          n++;
          idx = lower.indexOf(t, idx + t.length);
        }
        score += n * t.length;
      }
      if (score > 0) {
        const at = Math.max(0, first - 80);
        hits.push({ path: r, title: path.basename(f, ".md"), score, snippet: body.slice(at, at + 260).replace(/\s+/g, " ") });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  function read(relPath, max = 24000) {
    const abs = inside(relPath.endsWith(".md") ? relPath : `${relPath}.md`);
    if (!fs.existsSync(abs)) fail(`笔记不存在：${relPath}`);
    const text = fs.readFileSync(abs, "utf8");
    return { path: rel(abs), text: text.length > max ? `${text.slice(0, max)}\n\n…（已截断，共 ${text.length} 字）` : text };
  }

  /** 各科目文件夹下的子文件夹（最多 4 层），用于导出时判定位置。 */
  function folders() {
    const base = root();
    const out = [];
    const visit = (abs, depth) => {
      if (depth > 4) return;
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const p = path.join(abs, ent.name);
        out.push(rel(p));
        visit(p, depth + 1);
      }
    };
    for (const top of SUBJECTS) {
      const p = path.join(base, top);
      if (fs.existsSync(p)) { out.push(top); visit(p, 1); }
    }
    return out;
  }

  function titles() {
    return walk(root(), [], (p) => !/^(计划|笔记规范|模板)\//.test(rel(p))).map((f) => rel(f));
  }

  function safeName(name) {
    return String(name || "未命名").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名";
  }

  /** 读整篇笔记原文（不截断）；不存在返回 null。导出更新章节笔记时用来比对和备份。 */
  function readFull(relPath) {
    const abs = inside(relPath.endsWith(".md") ? relPath : `${relPath}.md`);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  }

  /** 写一篇笔记；已存在且未允许覆盖时报错，由前端确认后再覆盖。 */
  function writeNote(folder, name, content, { overwrite = false } = {}) {
    const dir = inside(folder);
    const file = path.join(dir, `${safeName(name)}.md`);
    if (!file.startsWith(root() + path.sep)) fail("路径超出仓库范围");
    if (fs.existsSync(file) && !overwrite) return { exists: true, path: rel(file) };
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(file, content.endsWith("\n") ? content : `${content}\n`);
    return { exists: false, written: true, path: rel(file) };
  }

  // ── 周计划 ─────────────────────────────────────────────
  function weekFile(date = new Date()) {
    const base = root();
    const y = date.getFullYear();
    const cands = [];
    for (const off of [-1, 0, 1]) {
      const d = new Date(y, date.getMonth() + off, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const dir = path.join(base, "计划", ym);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (/周计划\.md$/.test(f)) cands.push({ file: path.join(dir, f), year: d.getFullYear() });
    }
    const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    for (const c of cands) {
      const head = fs.readFileSync(c.file, "utf8").split(/\r?\n/).find((l) => l.startsWith("# ")) || "";
      const m = head.match(/(\d{1,2})\/(\d{1,2})\s*[–\-~—]\s*(\d{1,2})\/(\d{1,2})/);
      if (!m) continue;
      const fileYm = path.basename(path.dirname(c.file)).split("-").map(Number);
      let sy = fileYm[0];
      let ey = fileYm[0];
      if (Number(m[1]) === 12 && fileYm[1] === 1) sy -= 1;
      if (Number(m[3]) === 1 && fileYm[1] === 12) ey += 1;
      const start = new Date(sy, Number(m[1]) - 1, Number(m[2])).getTime();
      const end = new Date(ey, Number(m[3]) - 1, Number(m[4])).getTime();
      if (t >= start && t <= end) return { file: c.file, title: head.replace(/^#\s*/, "") };
    }
    return null;
  }

  function weekPlan(date = new Date()) {
    const wf = weekFile(date);
    if (!wf) return { found: false };
    const lines = fs.readFileSync(wf.file, "utf8").split(/\r?\n/);
    const tasks = [];
    let inTasks = false;
    let group = "";
    lines.forEach((line, i) => {
      if (/^##\s/.test(line)) { inTasks = /本周任务/.test(line); return; }
      if (!inTasks) return;
      if (/^###\s/.test(line)) { group = line.replace(/^###\s*/, ""); return; }
      const m = line.match(/^(\s*)- \[( |x|X)\] (.*)$/);
      if (m && m[1].length === 0) tasks.push({ line: i, group, done: m[2] !== " ", text: m[3].replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*$/, ""), raw: line });
    });
    return { found: true, path: rel(wf.file), title: wf.title, tasks };
  }

  // ── 今日任务：从周计划里挑出今天该做的 ─────────────────
  const subjectOf = (s) => (/数学|高数|线代|概率/.test(s) ? "数学" : /408|C\s*语言|数据结构|计组|操作系统|计网/i.test(s) ? "408" : /英语/.test(s) ? "英语" : /政治/.test(s) ? "政治" : "");
  const norm = (s) => s.replace(/\*\*|[\s:：，,·]/g, "");
  const isRest = (s) => !norm(s) || /^[—\-–]+$/.test(norm(s)) || /休息/.test(s);
  function lcs(a, b) {
    let best = 0;
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let diag = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
        if (prev[j] > best) best = prev[j];
        diag = tmp;
      }
    }
    return best;
  }

  function dayPlan(date = new Date()) {
    const wf = weekFile(date);
    if (!wf) return { found: false };
    const lines = fs.readFileSync(wf.file, "utf8").split(/\r?\n/);
    const M = date.getMonth() + 1;
    const D = date.getDate();
    const dayRe = new RegExp(`(?<!\\d)${M}/${D}(?!\\d)`);
    const tAbs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dateOf = (m, d) => {
      let y = date.getFullYear();
      if (m - M > 6) y -= 1; else if (M - m > 6) y += 1;
      return new Date(y, m - 1, d).getTime();
    };

    // 任务（## 本周任务 下的 ### 分组）与每日安排表
    const tasks = [];
    let section = "";
    let group = "";
    let header = null;
    let row = null;
    lines.forEach((line, i) => {
      if (/^##\s/.test(line)) { section = line; return; }
      if (/本周任务/.test(section)) {
        if (/^###\s/.test(line)) { group = line.replace(/^###\s*/, ""); return; }
        const m = line.match(/^- \[( |x|X)\] (.*)$/);
        if (!m) return;
        const text = m[2].replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*$/, "");
        const dm = text.match(/^(\d{1,2})\/(\d{1,2})\s+/);
        tasks.push({ line: i, raw: line, group, subject: subjectOf(group), done: m[1] !== " ", text: dm ? text.slice(dm[0].length) : text, date: dm ? dateOf(+dm[1], +dm[2]) : null, mmdd: dm ? `${+dm[1]}/${+dm[2]}` : "" });
      } else if (/每日安排/.test(section) && line.trim().startsWith("|")) {
        const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!header && cells.some((c) => /日期/.test(c))) header = cells;
        else if (header && !row && dayRe.test(cells[0] || "")) row = cells;
      }
    });

    const arrange = {};
    let weekday = "";
    if (header && row) {
      weekday = (row[0].match(/周[一二三四五六日天]/) || [""])[0];
      header.forEach((h, k) => { const s = subjectOf(h); if (k > 0 && s) arrange[s] = row[k] || ""; });
    }

    const order = [];
    const bySubject = new Map();
    const bucket = (subject, group) => {
      const key = subject || group;
      if (!bySubject.has(key)) { bySubject.set(key, { subject: subject || "其他", group, arrange: arrange[subject] ?? null, rest: false, tasks: [] }); order.push(key); }
      return bySubject.get(key);
    };
    const overdue = [];
    const groups = [...new Set(tasks.map((t) => t.group))];
    for (const g of groups) {
      const list = tasks.filter((t) => t.group === g);
      const b = bucket(list[0].subject, g);
      if (b.arrange !== null && isRest(b.arrange)) { b.rest = true; continue; }
      for (const t of list) {
        if (t.date === null) continue;
        if (t.date === tAbs) b.tasks.push({ ...t, kind: "dated" });
        else if (t.date < tAbs && !t.done) overdue.push({ ...t, kind: "dated" });
      }
      for (const t of list) if (t.date === null && /每日|每天/.test(t.text)) b.tasks.push({ ...t, kind: "daily", key: `${b.subject}|${t.text}` });
      const rest = list.filter((t) => t.date === null && !/每日|每天/.test(t.text));
      if (b.arrange) {
        const cell = norm(b.arrange);
        const scored = rest.map((t) => ({ t, s: lcs(cell, norm(t.text)) }));
        const top = Math.max(0, ...scored.map((x) => x.s));
        if (top >= 4) for (const x of scored) if (x.s === top) b.tasks.push({ ...x.t, kind: "matched" });
      } else if (!header) {
        const next = rest.find((t) => !t.done);
        if (next) b.tasks.push({ ...next, kind: "next" });
      }
      if (!b.tasks.length && b.arrange) b.tasks.push({ kind: "daily", text: b.arrange.replace(/\*\*/g, ""), key: `${b.subject}|安排|${b.arrange}`, done: false });
    }
    // 表里有、任务列表里没有的科目
    for (const [s, cell] of Object.entries(arrange)) {
      if (bySubject.has(s)) continue;
      const b = bucket(s, s);
      if (isRest(cell)) b.rest = true;
      else b.tasks.push({ kind: "daily", text: cell.replace(/\*\*/g, ""), key: `${s}|安排|${cell}`, done: false });
    }
    const subjects = order.map((k) => bySubject.get(k)).map(({ subject, group, rest, tasks: ts }) => ({
      subject, group, rest,
      tasks: ts.map(({ line, raw, text, done, kind, key }) => ({ line, raw, text, done, kind, key })),
    }));
    return {
      found: true, path: rel(wf.file), title: wf.title, weekday, inTable: !!row,
      subjects,
      overdue: overdue.map(({ line, raw, text, done, mmdd, subject }) => ({ line, raw, text, done, mmdd, subject: subject || "其他", kind: "dated" })),
    };
  }

  function toggleTask(relPath, line, raw, done) {
    const abs = inside(relPath);
    const src = fs.readFileSync(abs, "utf8");
    const eol = src.includes("\r\n") ? "\r\n" : "\n"; // Windows 上保存的文件可能是 CRLF，写回时保持原样
    const lines = src.split(/\r?\n/);
    if (lines[line] !== raw) fail("周计划文件已被修改，请刷新后再勾选");
    let next = raw.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*$/, "");
    next = done ? next.replace("- [ ] ", "- [x] ") + ` ✅ ${today()}` : next.replace(/- \[[xX]\] /, "- [ ] ");
    lines[line] = next;
    atomicWrite(abs, lines.join(eol));
    return { raw: next };
  }

  return { root, search, read, readFull, folders, titles, writeNote, safeName, weekPlan, dayPlan, toggleTask, SUBJECTS };
}

module.exports = { createVault };
