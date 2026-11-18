"use strict";
// 英语一真题导入：试卷（文字层 / 扫描件 OCR）→ 按部分拆成练习单元；速查答案；黄皮书逐题解析、全文翻译、范文。
// 每一步结果缓存在 data/eng-cache/，中断或失败后再导入不会重复花钱。
const fs = require("node:fs");
const path = require("node:path");
const { fail, uid, nowIso } = require("./util.cjs");

// 练习单元：key → 部分、题型、题号范围、默认限时（分钟）、每题分值
const UNITS = [
  { key: "完形", part: "完形", type: "完形", from: 1, to: 20, minutes: 15, score: 0.5 },
  { key: "Text1", part: "阅读", type: "阅读", from: 21, to: 25, minutes: 18, score: 2 },
  { key: "Text2", part: "阅读", type: "阅读", from: 26, to: 30, minutes: 18, score: 2 },
  { key: "Text3", part: "阅读", type: "阅读", from: 31, to: 35, minutes: 18, score: 2 },
  { key: "Text4", part: "阅读", type: "阅读", from: 36, to: 40, minutes: 18, score: 2 },
  { key: "新题型", part: "新题型", type: "新题型", from: 41, to: 45, minutes: 15, score: 2 },
  { key: "翻译", part: "翻译", type: "翻译", from: 46, to: 50, minutes: 20, score: 2 },
  { key: "小作文", part: "小作文", type: "小作文", from: 51, to: 51, minutes: 15, score: 10 },
  { key: "大作文", part: "大作文", type: "大作文", from: 52, to: 52, minutes: 30, score: 20 },
];
const unitOfNumber = (n) => UNITS.find((u) => n >= u.from && n <= u.to);

const COMMON = `你是考研英语一真题录入员。输入是一整份试卷的文字（PDF 文字层或 OCR，页之间有 <!-- 第N页 --> 标记，可能有识别噪声，如 [AJ→[A]、多余空格、断行、页眉页脚）。
只整理我指定的部分，忠实照抄原文（修正明显的识别噪声和断行），不要改写、不要省略、不要编造。
- 文章用 Markdown 段落（段与段之间空一行），保留原段落划分；文章里的粗体、下划线标记用 **…** 表示。
- options 写成 [{"key":"A","text":"…"}]，选项文字里不要再带 [A] 或 A.。
- topics：阅读题写题型（细节题 / 推理题 / 主旨题 / 态度题 / 词义题 / 例证题 / 段落作用题 之一）；完形写考点（词义辨析 / 逻辑关系 / 固定搭配 / 语法结构 之一）；其他部分留空数组。
- page：这一部分开始所在的页码。`;

const PART_PROMPTS = {
  cloze: `只整理 Section I Use of English（完形填空，第 1–20 题）。
material：整篇文章，空格写成 **__1__**、**__2__** … 这样的格式（题号放在两条下划线之间并加粗）。
questions：20 道题，每题 number、stem 写空着（""），options 是 A–D 四个选项。
输出 JSON：{"units":[{"key":"完形","directions":"题目要求原文","material":"…","page":N,"questions":[{"number":"1","stem":"","options":[…],"topics":[…]}]}]}`,
  reading12: `只整理 Section II Part A 的 Text 1 和 Text 2（第 21–30 题）。
每篇一个 unit：key 写 "Text1"/"Text2"；material 是该篇文章全文；questions 是该篇 5 道题（number、stem 题干、options A–D）。
输出 JSON：{"units":[{"key":"Text1","directions":"","material":"…","page":N,"questions":[…]}]}`,
  reading34: `只整理 Section II Part A 的 Text 3 和 Text 4（第 31–40 题）。
每篇一个 unit：key 写 "Text3"/"Text4"；material 是该篇文章全文；questions 是该篇 5 道题（number、stem 题干、options A–D）。
输出 JSON：{"units":[{"key":"Text3","directions":"","material":"…","page":N,"questions":[…]}]}`,
  rest: `只整理 Section II Part B（新题型，第 41–45 题）、Part C（翻译，第 46–50 题）和 Section III Writing（第 51、52 题）。
- 新题型 unit（key "新题型"）：directions 写题目要求原文；material 是文章（空位写成 **[41]** … 这种格式；排序题把给出的固定段落也放进来；小标题/匹配题把左边的项目列表放进来）；sharedOptions 是右边/下面的全部备选项 A–G（或 A–H），每个是 {"key","text"}；questions 是 41–45 五道题，stem 写该空的说明（比如「第 41 空」或匹配题左边对应的那一项），options 留空数组。
- 翻译 unit（key "翻译"）：material 是整篇文章，划线句前面标上题号写成 **(46) 划线句…**；questions 是 46–50，每题 stem 是那一个划线句原文。若这一年的翻译是整段翻译（没有 46–50 五个划线句），就只出一道题 number "46"，stem 是要翻译的整段。
- 小作文 unit（key "小作文"）：questions 只有一道 number "51"，stem 是题目要求原文（Directions 全部内容）。
- 大作文 unit（key "大作文"）：questions 只有一道 number "52"，stem 是题目要求原文；有图画/图表的，在 stem 末尾加「[图：…]」，图的内容从题目文字能推断多少写多少（看不到图就写「[图：见原卷]」），并设 hasFigure true。
输出 JSON：{"units":[{"key":"新题型","directions":"…","material":"…","sharedOptions":[…],"page":N,"questions":[…]},{"key":"翻译",…},{"key":"小作文",…},{"key":"大作文","hasFigure":true,…}]}`,
};

const KEY_PROMPT = `下面是一份考研英语一的参考答案（速查版）。整理出每道题的答案。
- 1–45：选项字母（新题型排序题也写字母）。
- 46–50：参考译文（中文）。若是整段翻译只有 46，写整段参考译文。
- 51、52：如果有范文，answer 写范文原文；没有就省略。
输出 JSON：{"answers":[{"number":"1","answer":"D"},…]}`;

const ANALYSIS_PROMPT = `你在整理考研英语一某一年真题的权威解析书（如黄皮书）中的一段（OCR/文字层，可能有噪声）。把这一段里出现的内容，按题号整理成结构化数据，忠实于原书，修正识别噪声，不要自己编。
- items：这一段里出现的每道题的解析：{"number":"21","answer":"B","analysis":"Markdown：**考点** … / **解题思路**（定位句、推理过程）… / **干扰项排除**（逐个说明 A/C/D 错在哪）…"}。完形题同理。翻译题 analysis 写「句子结构分析 + 译文处理要点」，answer 写参考译文。作文题 answer 写范文原文，analysis 写写作思路、亮点表达。
- translations：这一段里出现的文章全文翻译，{"key":"完形|Text1|Text2|Text3|Text4|新题型|翻译","text":"按段落的中文全文翻译（Markdown 段落）"}；只出现一部分就给那一部分。
- vocab：这一段里原书列出的重点词汇/超纲词，{"key":"Text1 等","words":[{"word":"…","meaning":"…"}]}，没有就空数组。
- 段首段尾被截断、看不出属于哪道题的半截内容直接忽略（相邻段会完整出现）。
输出 JSON：{"items":[…],"translations":[…],"vocab":[…]}`;

function createEngImport({ store, llm, pdf, images, bank, getSettings }) {
  const cacheDir = path.join(store.dir, "eng-cache");
  const readCache = (name) => { try { return JSON.parse(fs.readFileSync(path.join(cacheDir, `${name}.json`), "utf8")); } catch { return null; } };
  const writeCache = (name, v) => { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, `${name}.json`), JSON.stringify(v)); };
  async function cachedStep(name, fn) {
    const hit = readCache(name);
    if (hit) return hit;
    const v = await fn();
    writeCache(name, v);
    return v;
  }

  /** 文字层太少（扫描件）就逐页 OCR；返回带页标记的全文，以及原卷页面图片 id。 */
  async function readPdf(file, { label, keepPages, progress, signal }) {
    const t = await pdf.text(file);
    const letters = (t.text.match(/[A-Za-z一-龥]/g) || []).length;
    const scanned = letters < t.pages * 150;
    if (!scanned && !keepPages) return { text: t.text, pageIds: [] };
    const { dir, pages } = await pdf.render(fs.readFileSync(file), {});
    try {
      const imgs = pages.map((p) => ({ data: fs.readFileSync(p.file).toString("base64"), mimeType: "image/jpeg" }));
      const pageIds = keepPages ? imgs.map((img) => images.save(img.data)) : [];
      if (!scanned) return { text: t.text, pageIds };
      const texts = new Array(imgs.length);
      let next = 0;
      let doneN = 0;
      const conc = Number(getSettings().importConcurrency) || 6;
      const worker = async () => {
        while (next < imgs.length) {
          const i = next++;
          if (signal?.aborted) fail("已取消");
          try { texts[i] = await bank.transcribe(imgs[i], signal); }
          catch (err) { if (signal?.aborted || /\b(401|402|403)\b|invalid.?api.?key|不可用/i.test(err.message)) throw err; texts[i] = ""; }
          progress(`${label}：识别第 ${++doneN}/${imgs.length} 页`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, imgs.length) }, worker));
      return { text: texts.map((x, i) => `<!-- 第${i + 1}页 -->\n${x}`).join("\n\n"), pageIds };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function chunks(text, size = 22000, overlap = 2500) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + size);
      if (end < text.length) { const mark = text.lastIndexOf("<!-- 第", end); if (mark > i + size / 2) end = mark; }
      out.push(text.slice(Math.max(0, i - (i ? overlap : 0)), end));
      i = end;
    }
    return out;
  }

  const normNo = (n) => String(n ?? "").replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  const cleanOpts = (opts) => (Array.isArray(opts) ? opts : []).filter((o) => o && o.key).map((o) => ({ key: String(o.key).trim().toUpperCase().replace(/[^A-H]/g, "").slice(0, 1), text: String(o.text || "").replace(/^\s*[[(（]?[A-H][\])）.．、J]\s*/, "").trim() })).filter((o) => o.key);

  async function importYear(it, { progress, signal }) {
    const year = Number(it.year);
    const paper = it.paper || `${year} 英语一`;
    const tag = `${year}`;
    const say = (m) => progress(`${paper}：${m}`);

    // 1. 试卷文字（保留页面图片，大作文的图要从原卷裁）
    say("读取试卷");
    const paperRead = await readPdf(it.paperFile, { label: "试卷", keepPages: true, progress: say, signal });
    // 2. 拆成单元（4 段并行）
    say("拆分题目");
    const parts = await Promise.all(Object.entries(PART_PROMPTS).map(([k, prompt]) => cachedStep(`${tag}-paper-${k}`, () =>
      llm.json({ system: `${COMMON}\n\n${prompt}`, text: `试卷：${paper}\n\n${paperRead.text}`, maxTokens: 24000, signal }))));
    const units = parts.flatMap((p) => p.units || []);
    if (!units.length) fail("没有拆出任何题目");

    // 3. 速查答案
    let keyAnswers = [];
    if (it.keyFile && fs.existsSync(it.keyFile)) {
      say("读取参考答案");
      const k = await readPdf(it.keyFile, { label: "答案", progress: say, signal });
      keyAnswers = (await cachedStep(`${tag}-key`, () => llm.json({ system: KEY_PROMPT, text: k.text, maxTokens: 8000, signal }))).answers || [];
    }

    // 4. 黄皮书解析（分段）
    let analyses = [];
    let translations = [];
    let vocab = [];
    if (it.analysisFile && fs.existsSync(it.analysisFile)) {
      say("读取解析书");
      const a = await cachedStep(`${tag}-analysis-text`, async () => ({ text: (await readPdf(it.analysisFile, { label: "解析书", progress: say, signal })).text }));
      const cs = chunks(a.text);
      let n = 0;
      const results = new Array(cs.length);
      let next = 0;
      const worker = async () => {
        while (next < cs.length) {
          const i = next++;
          if (signal?.aborted) fail("已取消");
          results[i] = await cachedStep(`${tag}-analysis-${i}`, () => llm.json({ system: ANALYSIS_PROMPT, text: `${paper} 解析书第 ${i + 1}/${cs.length} 段：\n\n${cs[i]}`, maxTokens: 24000, signal }));
          say(`整理解析 ${++n}/${cs.length}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, cs.length) }, worker));
      for (const r of results) {
        analyses.push(...(r.items || []));
        translations.push(...(r.translations || []));
        vocab.push(...(r.vocab || []));
      }
    }

    // 5. 写入题库（同卷同题号更新，保留 id，练习记录不丢）
    say("写入题库");
    const pickLonger = (list, num, field) => list.filter((x) => normNo(x.number) === num && x[field]).map((x) => String(x[field])).sort((a, b) => b.length - a.length)[0] || "";
    const items = store.list("bank");
    const existing = new Map(items.filter((q) => q.paper === paper).map((q) => [normNo(q.number), q]));
    const unitInfo = store.list("engUnits").filter((u) => u.paper !== paper);
    let added = 0;
    let updated = 0;
    for (const u of units) {
      const def = UNITS.find((d) => d.key === u.key);
      if (!def) continue;
      const materialKey = `${paper}#${def.key}`;
      const shared = cleanOpts(u.sharedOptions);
      const qs = (u.questions || []).filter((q) => normNo(q.number));
      qs.sort((a, b) => Number(normNo(a.number)) - Number(normNo(b.number)));
      qs.forEach((raw, idx) => {
        const num = normNo(raw.number);
        const keyAns = pickLonger(keyAnswers, num, "answer");
        const bookAns = pickLonger(analyses, num, "answer");
        const choice = ["完形", "阅读", "新题型"].includes(def.type);
        let answer = keyAns || bookAns;
        if (choice) answer = String(answer).toUpperCase().replace(/[^A-H]/g, "").slice(0, 1);
        const q = {
          subject: "英语", paper, year, number: num, type: def.type,
          stem: String(raw.stem || "").trim() || (def.type === "完形" ? `第 ${num} 空` : ""),
          options: cleanOpts(raw.options).length ? cleanOpts(raw.options) : shared,
          answer, answerSource: answer ? (keyAns ? "官方" : "解析书") : "",
          analysis: pickLonger(analyses, num, "analysis"), analysisSource: "解析书",
          score: def.score, topics: Array.isArray(raw.topics) ? raw.topics.map(String).slice(0, 2) : [],
          material: idx === 0 ? String(u.material || "").trim() : "", materialKey, part: def.key,
          hasFigure: !!(u.hasFigure || raw.hasFigure), images: [], source: "真题",
        };
        if (def.key === "大作文" && q.hasFigure && paperRead.pageIds.length) {
          const pg = Math.max(1, Math.min(paperRead.pageIds.length, Number(u.page) || paperRead.pageIds.length));
          q.images = [paperRead.pageIds[pg - 1]];
        }
        const old = existing.get(num);
        if (old) { Object.assign(old, q, { figures: old.figures }); updated++; }
        else { items.push({ id: uid(), ...q, createdAt: nowIso() }); added++; }
      });
      const tr = translations.filter((t) => t.key === def.key).map((t) => String(t.text || "")).join("\n\n").trim();
      const words = vocab.filter((v) => v.key === def.key).flatMap((v) => v.words || []);
      unitInfo.push({ id: materialKey, paper, year, key: def.key, directions: String(u.directions || ""), translation: tr, bookVocab: words.slice(0, 40) });
    }
    store.saveList("bank", items);
    store.saveList("engUnits", unitInfo);
    // 大作文插图：用题库已有的裁图流程
    try { await bank.cropFigures({ paper, signal, progress: () => {} }); } catch (err) { if (signal?.aborted) throw err; }
    const mine = items.filter((q) => q.paper === paper);
    return { paper, added, updated, total: mine.length, answered: mine.filter((q) => q.answer).length, analysed: mine.filter((q) => q.analysis).length };
  }

  async function importManifest({ folder, progress, signal, readProgress, saveProgress }) {
    const file = path.join(folder, "manifest.json");
    if (!fs.existsSync(file)) fail(`找不到 ${file}`);
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = (m.items || []).map((x) => ({ ...x, paperFile: path.resolve(folder, x.paperFile), keyFile: x.keyFile ? path.resolve(folder, x.keyFile) : "", analysisFile: x.analysisFile ? path.resolve(folder, x.analysisFile) : "" }));
    const st = readProgress();
    const todo = list.filter((x) => !st.done.includes(x.paper));
    let finished = list.length - todo.length;
    const summary = { done: [], failed: [] };
    let next = 0;
    let stop = null;
    const worker = async () => {
      while (next < todo.length && !stop) {
        if (signal?.aborted) fail("已取消（做完的年份不会重做，再点一次会继续）");
        const it = todo[next++];
        try {
          const r = await importYear(it, { signal, progress: (msg) => progress(finished, list.length, msg) });
          st.done.push(it.paper);
          delete st.failed[it.paper];
          summary.done.push(r);
        } catch (err) {
          if (signal?.aborted) throw err;
          st.failed[it.paper] = err.message;
          summary.failed.push(`${it.paper}：${err.message}`);
          if (/\b(401|402|403)\b|invalid.?api.?key|unauthori[sz]ed|insufficient|quota|余额/i.test(err.message)) stop = new Error(`模型调用被拒绝，已停止（做完的年份不受影响）：${err.message}`);
        } finally {
          finished++;
          saveProgress(st);
          progress(finished, list.length, `已完成 ${finished}/${list.length}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (stop) throw stop;
    return { ...summary, total: list.length, doneCount: st.done.length };
  }

  return { importYear, importManifest, UNITS, unitOfNumber };
}

module.exports = { createEngImport, UNITS };
