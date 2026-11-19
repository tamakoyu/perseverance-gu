"use strict";
// 题库：导入（文字 / 图片 / PDF OCR）、组卷、判分、错题诊断。
const fs = require("node:fs");
const { fail, uid, nowIso } = require("./util.cjs");

const SUBJECTS = ["数学", "408", "英语", "政治"];
const CHOICE_TYPES = ["单选", "多选", "完形", "阅读", "新题型"];
const DEFAULT_SCORE = {
  数学: { 单选: 5, 填空: 5, 解答: 12 },
  408: { 单选: 2, 解答: 10 },
  英语: { 完形: 0.5, 阅读: 2, 新题型: 2, 翻译: 10, 小作文: 10, 大作文: 20 },
  政治: { 单选: 1, 多选: 2, 分析: 10 },
};
const READING_ERRORS = ["偷换概念", "以偏概全", "无中生有", "正反混淆", "因果倒置", "过度推断", "答非所问", "定位错误", "词汇/长难句没读懂"];
const GENERAL_ERRORS = ["概念不清", "公式记错", "计算失误", "审题错误", "方法选择", "知识盲区", "其他"];

const TRANSCRIBE_SYSTEM = `你是试卷转写员。把这一页图片**逐字**转写成 Markdown，不做任何整理或解题。规则：
- 公式一律写成 LaTeX：行内 $...$，独立公式 $$...$$。矩阵、行列式、分段函数都用 LaTeX 环境。
- 保留原题号、大题标题（如「一、选择题：1～10 小题…」）、【答案】【解析】【详解】等标记，原样照抄。
- 选择题每个选项单独一行，写成 (A) …、(B) …。
- 图（函数图像、几何图、树、电路、流程图等）写成「[图：用一两句话描述图里有什么]」；表格写成 Markdown 表格。
- 页眉页脚、水印、广告、二维码、「公众号」之类的文字不要抄。
- 不要省略任何题目文字，不要加自己的评论。只输出转写结果。`;

const EXTRACT_SYSTEM = `你是考研试卷录入员。输入是一份试卷（或其中一段）的完整文字转写，页与页之间有 <!-- 第N页 --> 标记。把它逐题拆成结构化数据。规则：
- 跨页的题合并成一道完整的题（页标记只是分页，不是分题）。
- number：原题号（字符串，如 "1"、"17"）。老试卷按「大题」编号的，写成 "三(1)" 这样。
- type 只能是：单选、多选、填空、解答、完形、阅读、新题型、翻译、小作文、大作文、分析。按题目所在的大题判断。
- 所有数学式（含变量、上下标、\\frac、\\ln 等）都必须包在 $...$ 或 $$...$$ 里，原文漏了也要补上。
- stem 只放题目本身（Markdown + LaTeX）：**不要**包含选项、【答案】【解析】、大题说明（如「二、填空题：11～16 小题…」）、上一题解析的残留。
- options：选择题的**全部**选项 [{"key":"A","text":"…"}]，选项文字里不要再带 (A)；非选择题为空数组。
- answer 只写最终答案（选择题写字母，填空写结果，解答写结论）；analysis 写完整的解析 / 解题过程。原文里有【答案】【解析】【详解】等内容就拆到这两个字段；原文没有就留空字符串，不要自己编。
- hasFigure：题目里有「[图：…]」时为 true，并保留图的文字描述在 stem 里。page：这道题开始所在的页码（数字）。
- 英语阅读/完形/新题型：每道小题单独一项；同一篇文章用相同的 materialKey（如 "Text1"），文章原文放在该篇第一道小题的 material 字段，其余小题 material 留空。
- topics：1–3 个考点名（中文，如「反常积分」「二叉树的遍历」「细节题」）。
- 1987–1996 年的老数学卷分「试卷 I」和「试卷 II」（试卷 II 是另一类考生做的，大多写着「同试卷 I 第X题」）：**只录入试卷 I 的题**，「(试卷 II)」标题之后的内容全部跳过，不要输出。答案册里试卷 II 的答案也跳过。
- 段首如果是某道题的后半截、你看不到它的题号，直接忽略（它会在相邻段里完整出现）；段尾不完整的题也照样输出，能写多少写多少。
- 如果这份内容只有答案和解析（答案册），只输出 answers：[{"number":"1","answer":"…","analysis":"…"}]。
输出 JSON：{"questions":[{"number","type","stem","options","answer","analysis","score","topics","hasFigure","page","material","materialKey"}],"answers":[]}`;

function normalizeChoice(s) {
  return String(s || "").toUpperCase().replace(/[^A-G]/g, "").split("").sort().join("");
}
function normalizeText(s) {
  return String(s || "").replace(/\$|\\,|\\!|\\left|\\right|\s/g, "").replace(/，/g, ",").toLowerCase();
}

function createBank({ store, llm, pdf, images, getSettings = () => ({}), getPapersRoot = () => "" }) {
  const all = () => store.list("bank");

  function cleanQuestion(q, meta) {
    const type = ["单选", "多选", "填空", "解答", "完形", "阅读", "新题型", "翻译", "小作文", "大作文", "分析"].includes(q.type) ? q.type : "解答";
    const subject = SUBJECTS.includes(meta.subject) ? meta.subject : "数学";
    return {
      id: uid(),
      subject,
      paper: meta.paper || "",
      year: meta.year ? Number(meta.year) : null,
      number: String(q.number ?? ""),
      type,
      stem: String(q.stem || "").trim(),
      options: Array.isArray(q.options) ? q.options.filter((o) => o && o.key).map((o) => ({ key: String(o.key).trim().toUpperCase(), text: String(o.text || "").replace(/^\s*[(（]?[A-G][)）.．、]\s*/, "") })) : [],
      answer: String(q.answer || ""),
      analysis: String(q.analysis || ""),
      score: Number(q.score) || DEFAULT_SCORE[subject]?.[type] || 0,
      topics: Array.isArray(q.topics) ? q.topics.map(String).slice(0, 3) : [],
      material: String(q.material || ""),
      materialKey: q.materialKey ? `${meta.paper || ""}#${q.materialKey}` : "",
      hasFigure: !!q.hasFigure,
      images: [],
      source: meta.source || "导入",
      createdAt: nowIso(),
    };
  }

  // 题号统一：去空白和「第/题」，全角括号转半角，去前导 0（408 有的卷子写 01–09）
  const normNo = (n) => String(n ?? "").replace(/[\s第题.．、]/g, "").replace(/（/g, "(").replace(/）/g, ")").replace(/(^|[^\d])0+(?=\d)/g, "$1");

  // 旧数据迁移：把已存的「01」这类题号改成「1」，答案才能对上
  {
    const items = all();
    let changed = false;
    for (const q of items) { const n = normNo(q.number); if (q.number && n !== q.number) { q.number = n; changed = true; } }
    if (changed) store.saveList("bank", items);
  }
  // data/remove-questions.json：要删掉的题 id（比如误导入的试卷 II 题），读一次就删
  {
    const file = require("node:path").join(store.dir, "remove-questions.json");
    try {
      const ids = new Set(JSON.parse(fs.readFileSync(file, "utf8")));
      const items = all();
      const keep = items.filter((q) => !ids.has(q.id));
      if (keep.length !== items.length) store.saveList("bank", keep);
      fs.rmSync(file, { force: true });
    } catch { /* 没有就算了 */ }
  }
  const completeness = (q) => q.stem.length + q.options.length * 40 + (q.answer ? 30 : 0) + q.analysis.length / 4;

  /** 合并各段结果：同题号保留更完整的版本，并互相补全答案/解析/选项。 */
  function merge(parts, meta, pageImages) {
    const out = [];
    const answers = [];
    for (const part of parts) {
      for (const a of part.answers || []) answers.push({ ...a, number: normNo(a.number) });
      for (const raw of part.questions || []) {
        const q = cleanQuestion({ ...raw, number: normNo(raw.number) }, meta);
        if (!q.stem && !q.options.length) continue;
        const page = Number(raw.page);
        if (raw.hasFigure && pageImages?.[page - 1]) q.images.push(pageImages[page - 1]);
        const dup = out.findIndex((x) => x.number && x.number === q.number);
        if (dup < 0) { out.push(q); continue; }
        const [keep, other] = completeness(q) > completeness(out[dup]) ? [q, out[dup]] : [out[dup], q];
        if (!keep.answer) keep.answer = other.answer;
        if (!keep.analysis) keep.analysis = other.analysis;
        if (keep.options.length < other.options.length) keep.options = other.options;
        keep.images = [...new Set([...keep.images, ...other.images])];
        out[dup] = keep;
      }
    }
    const materials = {};
    for (const q of out) if (q.materialKey && q.material) materials[q.materialKey] = q.material;
    return { questions: out, answers, materials };
  }

  function applyAnswers(paper, answers) {
    if (!answers.length) return 0;
    const items = all();
    let n = 0;
    for (const a of answers) {
      const q = items.find((x) => x.paper === paper && normNo(x.number) === normNo(a.number));
      if (q) { if (a.answer) { q.answer = String(a.answer); q.answerSource = "官方"; } if (a.analysis) { q.analysis = String(a.analysis); q.analysisSource = "官方"; } n++; }
    }
    store.saveList("bank", items);
    return n;
  }

  function commit(meta, merged) {
    if (meta.kind === "answers") {
      // 解析文件里重述的题目只取答案和解析，不新增题目
      const answers = [...merged.answers, ...merged.questions.filter((q) => q.answer || q.analysis).map((q) => ({ number: q.number, answer: q.answer, analysis: q.analysis }))];
      return { added: 0, updated: 0, answered: applyAnswers(meta.paper, answers), total: 0 };
    }
    const items = all();
    // 同一试卷同题号已存在则更新，避免重复导入
    let added = 0;
    let updated = 0;
    for (const q of merged.questions) {
      const old = meta.paper && q.number ? items.find((x) => x.paper === meta.paper && x.number === q.number && x.type === q.type) : null;
      if (old) {
        // 重导题目文件时不能把已合并的答案 / 解析 / 裁好的插图冲掉（答案常常来自单独的解析文件）
        const keep = {};
        if (!q.answer?.trim() && old.answer?.trim()) Object.assign(keep, { answer: old.answer, answerSource: old.answerSource });
        if (!q.analysis?.trim() && old.analysis?.trim()) Object.assign(keep, { analysis: old.analysis, analysisSource: old.analysisSource });
        if (old.figures?.length && q.images.length && q.images.every((id) => old.images?.includes(id))) keep.figures = old.figures;
        if (!q.topics.length && old.topics?.length) keep.topics = old.topics;
        Object.assign(old, { ...q, ...keep, id: old.id, createdAt: old.createdAt });
        updated++;
      }
      else { items.push(q); added++; }
    }
    store.saveList("bank", items);
    const answered = applyAnswers(meta.paper, merged.answers);
    return { added, updated, answered, total: merged.questions.length };
  }

  /** 按页标记切段（每段约 size 字，相邻段重叠一页左右），保证跨页的题至少在一段里完整出现。 */
  function chunks(text, size = 14000, overlap = 2500) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + size);
      if (end < text.length) {
        const mark = text.lastIndexOf("<!-- 第", end);
        if (mark > i + size / 2) end = mark;
        else { const nl = text.lastIndexOf("\n", end); if (nl > i + size / 2) end = nl; }
      }
      out.push(text.slice(Math.max(0, i - (i ? overlap : 0)), end));
      i = end;
    }
    return out;
  }

  const metaLine = (m) => `试卷：${m.paper || "未知"}；科目：${m.subject}${m.kind === "answers" ? "；这是答案解析册" : ""}`;
  /** 答案册要对上已导入的题：把本卷题号和题目开头给模型，按内容对应题号。 */
  function numberHint(m) {
    if (m.kind !== "answers" || !m.paper) return "";
    const qs = all().filter((q) => q.paper === m.paper).sort((a, b) => numKey(a.number) - numKey(b.number));
    if (!qs.length) return "";
    return `\n\n【本卷已导入的题号】answers 里的 number 必须写成下面某一个题号（按题目内容对应；答案册里只写「(3)」的，要结合所在大题和内容判断是哪一道）：\n${qs.map((q) => `${q.number}｜${q.stem.replace(/\s+/g, " ").slice(0, 40)}`).join("\n")}`;
  }

  async function structure({ meta, text, pageImages, progress, signal }) {
    const parts = chunks(String(text || ""));
    if (!parts.length) fail("没有可导入的文字");
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      if (signal?.aborted) fail("已取消");
      progress(i, parts.length, `拆分题目 第 ${i + 1}/${parts.length} 段`);
      results.push(await llm.json({ system: EXTRACT_SYSTEM, text: `${metaLine(meta)}${numberHint(meta)}\n\n${parts[i]}`, maxTokens: 32000, signal }));
    }
    progress(parts.length, parts.length, "写入题库");
    const r = commit(meta, merge(results, meta, pageImages));
    if (meta.paper) {
      try { await fixMath({ paper: meta.paper, signal, progress: (d, t) => progress(parts.length, parts.length, `修复公式格式 ${d}/${t}`) }); }
      catch (err) { if (signal?.aborted) throw err; }
      if (meta.kind !== "answers") {
        try { await cropFigures({ paper: meta.paper, signal, progress: (d, t) => progress(parts.length, parts.length, `裁出插图 ${d}/${t}`) }); }
        catch (err) { if (signal?.aborted) throw err; }
      }
    }
    return r;
  }

  async function importText({ meta, text, progress, signal }) {
    return structure({ meta, text, progress, signal });
  }

  // 每页的转写缓存在 data/transcripts/，重新导入（比如改了拆题规则）不用再花钱识别
  const crypto = require("node:crypto");
  const pathMod = require("node:path");
  const cacheDir = () => pathMod.join(store.dir, "transcripts");
  function cached(hash) { try { return fs.readFileSync(pathMod.join(cacheDir(), `${hash}.md`), "utf8"); } catch { return null; } }
  function saveCache(hash, text) { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(pathMod.join(cacheDir(), `${hash}.md`), text); }

  /** 输出像是模型的思考过程而不是转写（"用户要求…"、"Let me…"、"首先识别…"）。 */
  function looksLikeReasoning(t) {
    const head = t.slice(0, 300);
    if (/^(用户(要求|希望|让我)|我需要|我来|好的[，,]|首先[，,]?(我|识别|看)|让我|Let me|I need|I'll|The user|Okay|OK,)/i.test(head.trim())) return true;
    const eng = (t.match(/\b(Let me|I'll|I will|check the image|the user|Next line|Actually|Wait,)\b/gi) || []).length;
    return eng >= 3;
  }

  async function transcribe(img, signal) {
    const hash = crypto.createHash("sha1").update(img.data).digest("hex");
    const hit = cached(hash);
    if (hit !== null && !looksLikeReasoning(hit)) return hit;
    const ocr = getSettings().ocrModel;
    let problem = "模型没有返回文字";
    for (let attempt = 0; attempt < 3; attempt++) {
      const maxTokens = attempt === 0 ? 6000 : 12000;
      const r = await llm.complete({ system: TRANSCRIBE_SYSTEM, text: "请逐字转写这一页。只输出转写结果，不要写分析过程。", images: [img], maxTokens, signal, model: ocr?.provider ? ocr : undefined, withMeta: true });
      const t = r.text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
      if (!t) { problem = "模型没有返回文字（可能把输出都用在思考上了）"; continue; }
      if (r.stopReason === "length") { problem = `输出超过 ${maxTokens} token 被截断`; continue; }
      if (looksLikeReasoning(t)) { problem = "模型输出的是思考过程而不是转写"; continue; }
      saveCache(hash, t);
      return t;
    }
    fail(`${problem}，已重试 3 次。可以在导入页把「识别用的模型」换成 OCR 专用模型`);
  }

  async function importImages({ meta, imgs, progress, signal, concurrency = Number(getSettings().importConcurrency) || 6 }) {
    const texts = new Array(imgs.length);
    const pageImages = imgs.map((img) => images.save(img.data));
    if (meta.paper && meta.kind !== "answers") savePageOrder(meta.paper, pageImages.map((id, i) => ({ id, sha: sha1(imgs[i].data) })));
    const pageErrors = [];
    let next = 0;
    let finished = 0;
    const worker = async () => {
      while (next < imgs.length) {
        const i = next++;
        if (signal?.aborted) fail("已取消");
        try { texts[i] = await transcribe(imgs[i], signal); }
        catch (err) {
          if (signal?.aborted || /\b(401|403|402)\b|invalid.?api.?key|InvalidApiKey|不可用/i.test(err.message)) throw err;
          texts[i] = "";
          pageErrors.push(`第 ${i + 1} 页：${err.message}`);
        }
        finished++;
        progress(finished, imgs.length, `识别第 ${finished}/${imgs.length} 页`);
      }
    };
    progress(0, imgs.length, `识别 ${imgs.length} 页`);
    await Promise.all(Array.from({ length: Math.min(concurrency, imgs.length) }, worker));
    if (pageErrors.length === imgs.length) fail(`所有页都识别失败：${pageErrors[0]}`);
    const full = texts.map((t, i) => `<!-- 第${i + 1}页 -->\n${t}`).join("\n\n");
    const r = await structure({ meta, text: full, pageImages, progress: (d, t, m) => progress(imgs.length, imgs.length, m), signal });
    return { ...r, pageErrors };
  }

  /** 按 manifest.json 批量导入整理好的真题文件夹；每个文件完成后记进度，中断后再点会从没做完的继续。 */
  async function importManifest({ folder, progress, signal, readProgress, saveProgress }) {
    const path = require("node:path");
    const manifestFile = path.join(folder, "manifest.json");
    if (!fs.existsSync(manifestFile)) fail(`找不到 ${manifestFile}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const items = manifest.items || [];
    const state = readProgress();
    // data/force-redo.json：需要重做的文件（比如发现转写有问题），读一次就删
    const redoFile = pathMod.join(store.dir, "force-redo.json");
    try {
      const redo = JSON.parse(fs.readFileSync(redoFile, "utf8"));
      state.done = state.done.filter((f) => !redo.includes(f));
      saveProgress(state);
      fs.rmSync(redoFile, { force: true });
    } catch { /* 没有就算了 */ }
    const todo = items.filter((it) => !state.done.includes(it.file));
    const summary = { files: 0, added: 0, updated: 0, answered: 0, failed: [] };
    // 两份文件同时处理；解析文件要等同一试卷的题目文件做完再合并答案
    const inflight = new Map(); // paper → 正在导题目的 Promise
    let next = 0;
    let finishedCount = items.length - todo.length;
    let stopError = null;
    const runOne = async (it) => {
      const label = `${it.paper}${it.kind === "answers" ? " 解析" : ""}`;
      try {
        if (it.kind === "answers" && inflight.has(it.paper)) await inflight.get(it.paper).catch(() => {});
        if (it.kind === "answers" && !all().some((q) => q.paper === it.paper)) fail("这套试卷的题目还没导入，等题目导完再合并答案");
        const buf = fs.readFileSync(path.join(folder, it.file));
        const { dir, pages } = await pdf.render(buf, {});
        let partial = null;
        try {
          const imgs = pages.map((p) => ({ data: fs.readFileSync(p.file).toString("base64"), mimeType: "image/jpeg" }));
          const meta = { subject: it.subject, paper: it.paper, year: it.year, kind: it.kind, source: "真题" };
          const r = await importImages({ meta, imgs, signal, progress: (d, t, m) => progress(finishedCount, items.length, `${label}：${m}`) });
          summary.files++; summary.added += r.added; summary.updated += r.updated; summary.answered += r.answered;
          const hard = (r.pageErrors || []).filter((e) => !e.includes("截断"));
          if (hard.length) partial = `部分页失败（已保存其余页）：${hard.join("；")}`;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        if (partial) {
          // 好的页已经存进题库；这个文件留在失败列表里，下次重试会按题号补全
          state.failed[it.file] = partial;
          summary.failed.push(`${it.file}：${partial}`);
        } else {
          state.done.push(it.file);
          delete state.failed[it.file];
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        state.failed[it.file] = err.message;
        summary.failed.push(`${it.file}：${err.message}`);
        // 密钥 / 权限 / 余额问题每个文件都会一样失败，直接停下
        if (/\b(401|403|402)\b|invalid.?api.?key|InvalidApiKey|unauthori[sz]ed|insufficient|quota|余额/i.test(err.message)) {
          stopError = new Error(`模型调用被拒绝，已停止批量导入（已完成的不受影响）：${err.message}`);
        }
      } finally {
        finishedCount++;
        saveProgress(state);
        progress(finishedCount, items.length, `已完成 ${finishedCount}/${items.length}：${label}`);
      }
    };
    const worker = async () => {
      while (next < todo.length && !stopError) {
        if (signal?.aborted) fail("已取消（已完成的文件不会重做，再点一次会继续）");
        const it = todo[next++];
        const p = runOne(it);
        if (it.kind !== "answers") inflight.set(it.paper, p);
        await p;
        if (inflight.get(it.paper) === p) inflight.delete(it.paper);
      }
    };
    await Promise.all([worker(), worker()]);
    if (stopError) throw stopError;
    progress(items.length, items.length, "完成");
    return { ...summary, total: items.length, done: state.done.length };
  }

  async function importPdf({ meta, pdfBase64, first, last, progress, signal }) {
    progress(0, 1, "渲染 PDF 页面（首次需编译渲染工具，约 1 分钟）");
    const { dir, pages } = await pdf.render(Buffer.from(pdfBase64, "base64"), { first, last });
    try {
      const imgs = pages.map((p) => ({ data: fs.readFileSync(p.file).toString("base64"), mimeType: "image/jpeg" }));
      if (!imgs.length) fail("PDF 没有渲染出页面");
      return await importImages({ meta, imgs, progress, signal });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 组卷 ─────────────────────────────────────────────
  /** 关键词检索真题（题干、考点、选项、解析），按相关度排序。 */
  function search(query, { subject, type, yearFrom, yearTo, limit = 8 } = {}) {
    const q = String(query || "").toLowerCase().trim();
    const parts = q.split(/[\s,，、;；]+/).filter(Boolean);
    const terms = new Set(parts);
    for (const t of parts) if (/^[一-龥]{3,}$/.test(t)) for (let i = 0; i < t.length - 1; i++) terms.add(t.slice(i, i + 2));
    const hits = [];
    for (const it of all()) {
      if (subject && it.subject !== subject) continue;
      if (type && it.type !== type) continue;
      if (yearFrom && (it.year || 0) < yearFrom) continue;
      if (yearTo && (it.year || 9999) > yearTo) continue;
      const topics = it.topics.join(" ").toLowerCase();
      const stem = it.stem.toLowerCase();
      const rest = `${it.options.map((o) => o.text).join(" ")} ${it.analysis}`.toLowerCase();
      let score = terms.size ? 0 : 1;
      let covered = 0;
      for (const t of terms) {
        let s = 0;
        if (topics.includes(t)) s += 10 * t.length;
        if (stem.includes(t)) s += 4 * t.length;
        if (rest.includes(t)) s += t.length;
        if (s) covered++;
        score += s;
      }
      // 命中的检索词越多越靠前：只沾到一个泛词（如「函数」）的题往后排
      if (terms.size > 1) score *= 0.4 + 0.6 * (covered / terms.size);
      if (score > 0) hits.push({ it, score: score + (it.source === "AI生成" ? -5 : 0) + (it.year || 0) / 10000 });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, limit))).map((h) => h.it);
  }

  function papers() {
    const map = new Map();
    for (const q of all()) {
      if (!q.paper) continue;
      const p = map.get(q.paper) || { paper: q.paper, subject: q.subject, year: q.year, count: 0, answered: 0 };
      p.count++;
      if (q.answer) p.answered++;
      map.set(q.paper, p);
    }
    return [...map.values()].sort((a, b) => (b.year || 0) - (a.year || 0));
  }

  function numKey(n) { const m = String(n).match(/\d+/); return m ? Number(m[0]) : 9999; }

  function select({ mode, subject, types = [], topic = "", years = [], paper, count = 10, includeAi = true }) {
    let qs = all();
    if (mode === "full") {
      if (!paper) fail("请选择一套试卷");
      return qs.filter((q) => q.paper === paper).sort((a, b) => numKey(a.number) - numKey(b.number));
    }
    qs = qs.filter((q) => q.subject === subject);
    if (types.length) qs = qs.filter((q) => types.includes(q.type));
    if (years.length) qs = qs.filter((q) => years.includes(q.year));
    if (!includeAi) qs = qs.filter((q) => q.source !== "AI生成");
    if (topic) qs = qs.filter((q) => q.topics.some((t) => t.includes(topic) || topic.includes(t)) || q.stem.includes(topic));
    // 阅读类按文章整组抽
    const groups = new Map();
    for (const q of qs) {
      const k = q.materialKey || q.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }
    const shuffled = [...groups.values()].sort(() => Math.random() - 0.5);
    const out = [];
    for (const g of shuffled) {
      if (out.length >= count) break;
      out.push(...g.sort((a, b) => numKey(a.number) - numKey(b.number)));
    }
    return out;
  }

  // ── 公式格式检查与修复 ───────────────────────────────
  const stripMath = (t) => String(t || "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/\$[^$]*\$/g, "");
  /** 有没有落在 $...$ 外面的 LaTeX（\ln、\frac、x_1、x^2 之类）。 */
  const bareMath = (t) => /\\[a-zA-Z]{2,}|[A-Za-z0-9)}\]]\s*[_^]\s*[{A-Za-z0-9(\\]/.test(stripMath(t));
  const mathFields = (q) => {
    const f = { stem: q.stem, answer: q.answer, analysis: q.analysis };
    q.options.forEach((o, i) => { f[`opt${i}`] = o.text; });
    return Object.fromEntries(Object.entries(f).filter(([, v]) => bareMath(v)));
  };
  /** 题目可能识别有误的迹象（给用户提示用）。 */
  function warnings(q) {
    const w = [];
    const norm = q.options.map((o) => String(o.text).replace(/\s|\$/g, ""));
    if (norm.length !== new Set(norm).size) w.push("有两个选项内容相同，可能识别错了");
    if (["单选", "多选"].includes(q.type) && norm.length && norm.length !== 4) w.push(`选项只有 ${norm.length} 个`);
    if (["单选", "多选"].includes(q.type) && !norm.length) w.push("选择题没有识别出选项");
    if (q.answer && ["单选"].includes(q.type) && !/^[A-D]$/.test(q.answer.trim())) w.push("单选题答案不是一个字母");
    if (Object.keys(mathFields(q)).length) w.push("有公式没有用 $ 包起来，显示会是源码");
    return w;
  }
  // 只允许添加 $ 和空白：去掉 $ 与空白后必须与原文完全一致
  const sameContent = (a, b) => String(a).replace(/[\s$]/g, "") === String(b).replace(/[\s$]/g, "");

  async function fixOne(q, signal) {
    const fields = mathFields(q);
    if (!Object.keys(fields).length) return false;
    const res = await llm.json({
      system: "你只做一件事：给文字里的数学式补上 LaTeX 定界符。行内式用 $...$，单独成行的长式子用 $$...$$。**不得改动、增删任何其他字符**（不要改写、不要纠错、不要翻译、不要加反斜杠）。输入是 JSON 对象，原样返回同样的键。",
      text: JSON.stringify(fields),
      slot: "cheap",
      maxTokens: 12000,
      signal,
    });
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      const nv = res?.[k];
      if (typeof nv !== "string" || !sameContent(v, nv)) continue; // 模型动了内容就不采用
      if (k.startsWith("opt")) q.options[Number(k.slice(3))].text = nv; else q[k] = nv;
      changed = true;
    }
    return changed;
  }

  /** 修复公式格式：ids / paper / 全部。 */
  async function fixMath({ ids, paper, progress = () => {}, signal, concurrency = 4 }) {
    const targets = all().filter((q) => (ids?.length ? ids.includes(q.id) : !paper || q.paper === paper) && Object.keys(mathFields(q)).length);
    let next = 0, fixed = 0, done = 0;
    const failed = [];
    const worker = async () => {
      while (next < targets.length) {
        if (signal?.aborted) fail("已取消（已修好的会保留）");
        const q = { ...targets[next++] };
        q.options = q.options.map((o) => ({ ...o }));
        try {
          if (await fixOne(q, signal)) {
            const items = all();
            const cur = items.find((x) => x.id === q.id);
            if (cur) { Object.assign(cur, { stem: q.stem, answer: q.answer, analysis: q.analysis, options: q.options }); store.saveList("bank", items); fixed++; }
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          failed.push(`${q.paper} 第${q.number}题：${err.message}`);
        }
        done++;
        progress(done, targets.length, `${q.paper} 第 ${q.number} 题`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return { total: targets.length, fixed, failed, stillBad: all().filter((q) => targets.some((t) => t.id === q.id) && Object.keys(mathFields(q)).length).length };
  }

  function problems() {
    const byPaper = {};
    for (const q of all()) {
      const w = warnings(q);
      if (!w.length) continue;
      const k = q.paper || "（无出处）";
      byPaper[k] = byPaper[k] || { math: 0, recog: 0 };
      if (w.some((x) => x.includes("公式"))) byPaper[k].math++;
      if (w.some((x) => !x.includes("公式"))) byPaper[k].recog++;
    }
    return byPaper;
  }

  // ── 插图：从原卷页面里裁出题目的图 ────────────────────
  const FIGURE_SYSTEM = `你在一页考研试卷的图片上定位插图。只框「图」本身（函数图像、几何图、坐标图、电路图、树、流程图等，含图里的坐标轴标注和图下的图号），不要框题目文字、选项、公式、表格。
坐标用相对于整张图片的 0–1000 归一化坐标：左上角 (0,0)，右下角 (1000,1000)。每张图一个框 [x1,y1,x2,y2]（左上、右下）。
输出 JSON：{"boxes":[[x1,y1,x2,y2]]}。这一页上没有该题的图就输出 {"boxes":[]}。`;
  const needsFigure = (q) => q.hasFigure && q.images?.length && !q.figures?.length && !q.figureMissing;

  /** 裁图用的模型：插件设置里指定的 → 目录里有 qwen3-vl-plus 就用它（定位准）→ 视觉模型槽。 */
  async function figureModel() {
    const pinned = getSettings().figureModel;
    if (pinned?.provider) return pinned;
    try {
      const list = await llm.catalogModels();
      const hit = list.find((m) => /qwen3(\.\d)?-vl-(plus|max)/i.test(m.id)) || list.find((m) => /qwen.*-vl-(plus|max)/i.test(m.id));
      if (hit) return { provider: hit.provider, id: hit.id };
    } catch { /* 用视觉槽 */ }
    return undefined;
  }

  function normBox(b) {
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(Number(v)))) return null;
    let [x1, y1, x2, y2] = b.map(Number);
    const scale = Math.max(x1, y1, x2, y2) <= 1.0001 ? 1 : 1000;
    [x1, y1, x2, y2] = [x1, y1, x2, y2].map((v) => v / scale);
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    const pad = 0.012;
    x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(1, x2 + pad); y2 = Math.min(1, y2 + pad);
    const w = x2 - x1, h = y2 - y1;
    if (w < 0.04 || h < 0.03 || w * h > 0.75) return null; // 太小或几乎整页，多半是框错了
    return [x1, y1, x2, y2];
  }

  // ── 每套卷子的页序（找相邻页用）：pages.json → {paper: [{id, sha}]} ──
  const sha1 = (b64) => crypto.createHash("sha1").update(Buffer.from(b64, "base64")).digest("hex");
  function savePageOrder(paper, list) {
    const all = store.value("pages", {});
    all[paper] = list;
    store.saveValue("pages", all);
  }
  /** 旧数据没记页序：按 manifest 重新渲染这套卷子的 PDF（不调模型），渲染结果和当初存的图逐字节相同。 */
  async function pageOrder(paper) {
    const known = store.value("pages", {})[paper];
    if (known?.length) return known;
    const folder = getPapersRoot();
    if (!folder) return [];
    let item;
    try { item = JSON.parse(fs.readFileSync(pathMod.join(folder, "manifest.json"), "utf8")).items.find((it) => it.paper === paper && it.kind !== "answers"); } catch { return []; }
    if (!item) return [];
    const { dir, pages } = await pdf.render(fs.readFileSync(pathMod.join(folder, item.file)), {});
    try {
      const list = pages.map((p) => { const data = fs.readFileSync(p.file).toString("base64"); return { id: images.save(data), sha: sha1(data) }; });
      savePageOrder(paper, list);
      return list;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  /** 要找图的页：题目起始页，再看下一页、上一页（题干说「上图」就先看上一页）。 */
  async function candidatePages(q) {
    const start = q.images?.[0];
    if (!start) return [];
    const out = [start];
    try {
      const order = await pageOrder(q.paper);
      const sha = sha1(images.get(start));
      const i = order.findIndex((p) => p.sha === sha || p.id === start);
      if (i >= 0) {
        const next = order[i + 1]?.id, prev = order[i - 1]?.id;
        const near = /上图|上页/.test(q.stem) ? [prev, next] : [next, prev];
        out.push(...near.filter(Boolean));
      }
    } catch { /* 找不到页序就只看起始页 */ }
    return [...new Set([...out, ...(q.images || []).slice(1)])];
  }

  async function cropOne(q, model, signal) {
    const desc = (q.stem.match(/\[图[：:][^\]]*\]/g) || []).join(" ");
    // 「详见第33题」「同第33题图」：直接用那道题裁好的图
    const ref = desc.match(/第\s*(\d+)\s*题/);
    if (ref) {
      const other = all().find((x) => x.paper === q.paper && normNo(x.number) === ref[1] && x.figures?.length);
      if (other) return other.figures;
    }
    for (const pid of await candidatePages(q)) {
      const page = images.get(pid);
      const res = await llm.json({
        system: FIGURE_SYSTEM,
        text: `找出第 ${q.number} 题的插图（这道题可能跨页，图可能在页首或页尾；只框属于这道题的图）。${desc ? `图的文字描述：${desc}` : ""}\n题目开头：${q.stem.slice(0, 120)}`,
        images: [{ data: page, mimeType: "image/jpeg" }],
        model,
        maxTokens: 2000,
        signal,
      });
      const boxes = (res.boxes || []).map(normBox).filter(Boolean).slice(0, 4);
      if (!boxes.length) continue;
      const ids = [];
      for (const b of boxes) ids.push(images.save(await pdf.crop(page, b)));
      return ids;
    }
    return [];
  }

  /** 给有图的题裁出插图；force 时连已裁过的也重裁。 */
  async function cropFigures({ ids, paper, force = false, progress = () => {}, signal, concurrency = 3 }) {
    const targets = all().filter((q) => q.hasFigure && q.images?.length && (force || (!q.figures?.length && !q.figureMissing)) && (ids?.length ? ids.includes(q.id) : !paper || q.paper === paper));
    if (!targets.length) return { done: 0, failed: [], total: 0 };
    // 「详见第33题」这类引用别题图的放第二轮，等被引用的题先裁好
    const refersOther = (q) => /\[图[：:][^\]]*第\s*\d+\s*题/.test(q.stem);
    const rounds = [targets.filter((q) => !refersOther(q)), targets.filter(refersOther)];
    const model = await figureModel();
    let next = 0, done = 0, list = [];
    const failed = [];
    const worker = async () => {
      while (next < list.length) {
        if (signal?.aborted) fail("已取消（已裁好的会保留）");
        const q = list[next++];
        try {
          const figs = await cropOne(q, model, signal);
          if (!figs.length) throw new Error("没在原卷页面上找到图");
          const items = all();
          const cur = items.find((x) => x.id === q.id);
          if (cur) { cur.figures = figs; delete cur.figureMissing; store.saveList("bank", items); }
          done++;
        } catch (err) {
          if (signal?.aborted) throw err;
          failed.push(`${q.paper} 第${q.number}题：${err.message}`);
          // 记下来，批量裁图不再反复花钱重试；单题「重新裁图」仍可强制再试
          if (/没在原卷页面上找到图/.test(err.message)) {
            const items = all();
            const cur = items.find((x) => x.id === q.id);
            if (cur) { cur.figureMissing = true; store.saveList("bank", items); }
          }
        }
        progress(done + failed.length, targets.length, `${q.paper} 第 ${q.number} 题`);
      }
    };
    progress(0, targets.length, `共 ${targets.length} 题`);
    for (const round of rounds) {
      list = round; next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    }
    return { done, failed, total: targets.length };
  }

  function missingFigures() {
    const byPaper = {};
    for (const q of all()) if (needsFigure(q)) byPaper[q.paper || "（无出处）"] = (byPaper[q.paper || "（无出处）"] || 0) + 1;
    return { byPaper, total: Object.values(byPaper).reduce((a, b) => a + b, 0) };
  }

  /** 题目配图：裁好的插图优先，没有就用原卷页面。 */
  const pictures = (q) => (q.figures?.length ? q.figures : q.images || []);

  // ── AI 补全：有答案缺解析 → 按标准答案写解析；连答案都没有 → 自己解题 ──
  const needsAnalysis = (q) => !!q.answer?.trim() && !q.analysis?.trim();
  const needsAnswer = (q) => !q.answer?.trim();
  const subjectHint = (q) => (q.subject === "408" ? "考研 408 计算机专业课" : q.subject === "英语" ? "考研英语一" : q.subject === "政治" ? "考研政治" : "考研数学一");
  const questionText = (q) => `【出处】${q.paper || "（无）"} 第 ${q.number} 题（${q.type}）\n【题目】\n${q.material ? `（阅读材料）\n${q.material}\n\n` : ""}${q.stem}\n${q.options.map((o) => `(${o.key}) ${o.text}`).join("\n")}`;
  const figureImages = (q) => {
    const out = [];
    for (const id of pictures(q).slice(0, 3)) { try { out.push({ data: images.get(id), mimeType: "image/jpeg" }); } catch { /* 图丢了就只用文字 */ } }
    return out;
  };

  async function writeAnalysis(q, signal) {
    const text = await llm.complete({
      system: `你是${subjectHint(q)}的资深辅导老师。根据题目和**标准答案**写一份详细解析。要求：
- 必须得出与标准答案一致的结论，不得改动标准答案。
- 结构：先用一两句点明考点和解题思路，再写完整的关键步骤（公式用 $...$ / $$...$$ LaTeX），选择题要说明其他选项为什么错，最后用「易错点」提醒一两条。
- 简洁清楚，像真题解析书那样，不要寒暄，不要复述题目。
- 如果你认为标准答案本身有误，仍按标准答案写，但在最后单独一行写「⚠️ 存疑：……」说明理由。
只输出解析正文（Markdown）。`,
      text: `${questionText(q)}\n\n【标准答案】${q.answer}`,
      images: figureImages(q),
      maxTokens: 8000,
      signal,
    });
    const out = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!out) fail("模型没有返回解析");
    return out;
  }

  async function writeSolution(q, signal) {
    const res = await llm.json({
      system: `你是${subjectHint(q)}的资深辅导老师。这道真题手头没有标准答案，请你认真独立求解，并验算一遍再下结论。
- answer：只写最终答案（选择题写选项字母，多选写全部字母如 "AC"，填空写结果，解答题写最终结论），公式用 $...$。
- analysis：完整解析——先一两句点明考点和思路，再写关键步骤（公式用 $...$ / $$...$$ LaTeX），选择题说明其他选项为什么错，最后「易错点」一两条。像真题解析书那样，不寒暄、不复述题目。
- 如果题目信息不全（比如缺图）导致没把握，在 analysis 最后单独一行写「⚠️ 存疑：……」。
输出 JSON：{"answer":"…","analysis":"…"}`,
      text: questionText(q),
      images: figureImages(q),
      maxTokens: 12000,
      signal,
    });
    const answer = String(res.answer || "").trim();
    const analysis = String(res.analysis || "").trim();
    if (!answer) fail("模型没有给出答案");
    return { answer, analysis };
  }

  /** 补全缺答案 / 缺解析的题；ids 为空时按 paper 筛选，都为空就处理全部。 */
  async function fillAnalyses({ ids, paper, progress, signal, concurrency = 4 }) {
    const targets = all().filter((q) => (needsAnalysis(q) || needsAnswer(q)) && (ids?.length ? ids.includes(q.id) : !paper || q.paper === paper));
    if (!targets.length) return { done: 0, solved: 0, failed: [], total: 0 };
    let next = 0;
    let done = 0;
    let solved = 0;
    const failed = [];
    const worker = async () => {
      while (next < targets.length) {
        if (signal?.aborted) fail("已取消（已写好的会保留）");
        const q = targets[next++];
        try {
          if (needsAnswer(q)) {
            const r = await writeSolution(q, signal);
            const items = all();
            const cur = items.find((x) => x.id === q.id);
            if (cur && !cur.answer?.trim()) {
              cur.answer = r.answer; cur.answerSource = "AI";
              if (!cur.analysis?.trim()) { cur.analysis = r.analysis; cur.analysisSource = "AI"; }
              store.saveList("bank", items);
            }
            solved++;
          } else {
            const analysis = await writeAnalysis(q, signal);
            const items = all();
            const cur = items.find((x) => x.id === q.id);
            if (cur && !cur.analysis?.trim()) { cur.analysis = analysis; cur.analysisSource = "AI"; store.saveList("bank", items); }
          }
          done++;
        } catch (err) {
          if (signal?.aborted) throw err;
          failed.push(`${q.paper} 第${q.number}题：${err.message}`);
        }
        progress(done + failed.length, targets.length, `${q.paper} 第 ${q.number} 题`);
      }
    };
    progress(0, targets.length, `共 ${targets.length} 题`);
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return { done, solved, failed, total: targets.length };
  }

  function missingAnalysis() {
    const byPaper = {};
    const noAnswerByPaper = {};
    for (const q of all()) {
      const k = q.paper || "（无出处）";
      if (needsAnswer(q)) noAnswerByPaper[k] = (noAnswerByPaper[k] || 0) + 1;
      else if (needsAnalysis(q)) byPaper[k] = (byPaper[k] || 0) + 1;
    }
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    return { byPaper, noAnswerByPaper, analysisOnly: sum(byPaper), noAnswer: sum(noAnswerByPaper), total: sum(byPaper) + sum(noAnswerByPaper) };
  }

  async function generate({ subject, types, topic, count, signal }) {
    const res = await llm.json({
      system: `你是考研命题专家，按历年真题的风格和难度出原创题。${EXTRACT_SYSTEM.split("\n")[1]}\n每题必须给出 answer 和详细 analysis。选择题给 4 个选项。`,
      text: `科目：${subject}；题型：${(types || []).join("、") || "按该科真题常见题型"}；考点：${topic || "该科核心考点"}；数量：${count}。\n输出 JSON：{"questions":[{"number","type","stem","options","answer","analysis","score","topics"}]}`,
      maxTokens: 16000,
      signal,
    });
    const meta = { subject, paper: "", source: "AI生成" };
    const qs = (res.questions || []).map((q, i) => cleanQuestion({ ...q, number: q.number || String(i + 1) }, meta));
    const items = all();
    items.push(...qs);
    store.saveList("bank", items);
    return qs;
  }

  /** 发给前端的题目（考试中不带答案）。 */
  function forExam(q, materials) {
    return {
      id: q.id, subject: q.subject, paper: q.paper, number: q.number, type: q.type, stem: q.stem, options: q.options,
      score: q.score, topics: q.topics, images: pictures(q), hasFigures: !!q.figures?.length, materialKey: q.materialKey, part: q.part || "", year: q.year,
      material: q.material || materials[q.materialKey] || "",
    };
  }
  function materialsOf(qs) {
    const m = {};
    for (const q of all()) if (q.materialKey && q.material) m[q.materialKey] = q.material;
    return m;
  }

  // ── 判分 ─────────────────────────────────────────────
  async function gradeOne(q, ans, signal) {
    const max = q.score || 1;
    const given = ans || {};
    if (CHOICE_TYPES.includes(q.type) && q.options.length) {
      if (!q.answer) return { correct: null, score: 0, max, feedback: "题库里没有这题的答案，无法判分" };
      const ok = normalizeChoice(given.choice) === normalizeChoice(q.answer);
      let score = ok ? max : 0;
      if (!ok && q.type === "多选" && given.choice && normalizeChoice(given.choice).split("").every((c) => normalizeChoice(q.answer).includes(c))) score = max / 2;
      return { correct: ok, score, max, feedback: ok ? "" : `正确答案：${q.answer}` };
    }
    const hasImages = Array.isArray(given.images) && given.images.length;
    if (!given.text?.trim() && !hasImages) return { correct: false, score: 0, max, feedback: "未作答" };
    if (q.type === "填空" && q.answer && given.text && normalizeText(given.text) === normalizeText(q.answer)) {
      return { correct: true, score: max, max, feedback: "" };
    }
    const essay = q.type === "小作文" || q.type === "大作文";
    const rubric = essay
      ? "按考研英语一评分标准：小作文满分 10 分、大作文满分 20 分，分五档；看任务完成度、内容要点、语言准确性与多样性、连贯性、格式。"
      : q.subject === "数学" || q.subject === "408"
        ? "按考研阅卷方式按步骤给分：关键步骤/思路正确给步骤分，结果错扣结果分；指出第一处出错的位置。"
        : "对照参考答案按要点给分。";
    const res = await llm.json({
      system: `你是严格但公正的考研阅卷老师。${rubric}\n输出 JSON：{"score":数字,"correct":是否完全正确,"feedback":"批改意见（中文，指出错在哪、怎么改）","errorType":"错因类型"}。错因类型从这些里选：${GENERAL_ERRORS.join("、")}。`,
      text: `题型：${q.type}；满分：${max}\n题目：\n${q.stem}\n${q.options.map((o) => `${o.key}. ${o.text}`).join("\n")}\n\n参考答案：${q.answer || "（题库无参考答案，请你先自己求解再判分）"}\n解析：${q.analysis || "无"}\n\n考生作答（文字）：${given.text || "（见图片）"}`,
      images: hasImages ? given.images.map((d) => ({ data: d, mimeType: "image/jpeg" })) : [],
      maxTokens: 4000,
      signal,
    });
    const score = Math.max(0, Math.min(max, Number(res.score) || 0));
    return { correct: !!res.correct && score >= max * 0.99, score, max, feedback: String(res.feedback || ""), errorType: res.errorType };
  }

  /** 对答错的客观题批量诊断错因（英语阅读用干扰项类型）。 */
  async function diagnose(wrong, signal) {
    if (!wrong.length) return {};
    const list = wrong.map(({ q, ans }, i) => `#${i}\n题型：${q.type}\n${q.material && i === 0 ? `文章：${q.material.slice(0, 3000)}\n` : ""}题目：${q.stem}\n${q.options.map((o) => `${o.key}. ${o.text}`).join("\n")}\n正确答案：${q.answer}\n考生选：${ans?.choice || "未作答"}`).join("\n\n");
    const res = await llm.json({
      system: `你帮考研学生分析选择题错因。英语阅读/完形/新题型的错因从这些里选：${READING_ERRORS.join("、")}；其他科目从这些里选：${GENERAL_ERRORS.join("、")}。\n输出 JSON：{"items":[{"index":数字,"errorType":"…","diagnosis":"一两句话说明为什么错、正确思路"}]}`,
      text: list,
      slot: "strong",
      maxTokens: 6000,
      signal,
    });
    const out = {};
    for (const it of res.items || []) out[it.index] = it;
    return out;
  }

  return { all, transcribe, search, fixMath, warnings, problems, fillAnalyses, missingAnalysis, cropFigures, missingFigures, pictures, papers, select, generate, forExam, materialsOf, importText, importImages, importPdf, importManifest, gradeOne, diagnose, CHOICE_TYPES, READING_ERRORS, GENERAL_ERRORS, SUBJECTS };
}

module.exports = { createBank };
