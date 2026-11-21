"use strict";
// 讲题：学习者在会话里发来做完的试卷 / 题目照片，老师模型判卷后调用 kaoyan_log_paper，
// 这里把整张卷子的批改结果存成一条「讲题记录」，错题写进错题本，再在后台把每道错题从原图里裁出来。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { uid, nowIso, str, fail } = require("./util.cjs");

const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(String(stdout))));
});

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** 宿主存的图可能是 PNG / WebP：用 sips 统一转成 JPEG（插件图片库只存 .jpg）。 */
async function toJpeg(img) {
  const mime = String(img.mimeType || "").toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return img.data;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaoyan-paper-"));
  try {
    const src = path.join(dir, `in.${EXT[mime] || "png"}`);
    const out = path.join(dir, "out.jpg");
    fs.writeFileSync(src, Buffer.from(img.data, "base64"));
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", out], 30000);
    return fs.readFileSync(out).toString("base64");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 会话里学习者发过的所有图片，按发送顺序（第 1 张 = 下标 0）。 */
function sessionImages(record) {
  const out = [];
  for (const m of record?.messages || []) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === "image" && typeof b.data === "string" && b.data.length > 100) out.push({ data: b.data, mimeType: b.mimeType || "image/jpeg" });
  }
  return out;
}

const QUESTION_BOX_SYSTEM = `你在一张学生做过的试卷 / 练习题照片上定位某一道题。框住这道题的全部内容：题号、题干、选项、配图，以及学生在旁边写的作答和演算过程（含批改痕迹）。不要框到相邻的其他题。
照片可能是手机拍的，有倾斜、透视或阴影，按看到的位置框即可。
坐标用相对于整张图片的 0–1000 归一化坐标：左上角 (0,0)，右下角 (1000,1000)。框 [x1,y1,x2,y2]（左上、右下）。这道题被分成不连续的几块时（例如分两栏），每块一个框，最多 3 个。
输出 JSON：{"boxes":[[x1,y1,x2,y2]]}。这张图上没有这道题就输出 {"boxes":[]}。`;

function createPaper({ ctx, store, llm, pdf, images, bank, addMistake, changed }) {
  const reviews = () => store.list("reviews");

  /** 后台：把一道错题从原图里裁出来，替换掉错题里的整页图。失败就保留整页图。 */
  async function cropMistake({ mistakeId, number, question, pages, pageIds, pageData }) {
    const model = await bank.figureModel();
    const crops = [];
    for (const p of pages) {
      if (ctx.signal.aborted) return;
      const page = pageData[p];
      if (!page) continue;
      try {
        const res = await llm.json({
          system: QUESTION_BOX_SYSTEM,
          text: `找出第 ${number} 题。${question ? `题目开头：${String(question).replace(/\s+/g, " ").slice(0, 120)}` : ""}`,
          images: [{ data: page, mimeType: "image/jpeg" }],
          model,
          maxTokens: 2000,
          purpose: "background",
          signal: ctx.signal,
        });
        const boxes = (res.boxes || []).map(bank.normBox).filter(Boolean).slice(0, 3);
        // normBox 会丢掉几乎整页的框；这一页一个框都没有就不裁
        for (const b of boxes) crops.push(images.save(await pdf.crop(page, b)));
      } catch { /* 这一页定位失败：用整页 */ crops.push(pageIds[p]); }
    }
    if (!crops.length) return;
    const items = store.list("mistakes");
    const m = items.find((x) => x.id === mistakeId);
    if (!m) return;
    m.images = [...new Set(crops)];
    m.pageImages = pages.map((p) => pageIds[p]).filter(Boolean);
    store.saveList("mistakes", items);
    changed("mistakes");
  }

  /**
   * 记录一次讲题批改。同一会话再调用：按题号更新（错题本里同一道题不会重复）。
   * input.items: [{number, correct, score?, fullScore?, topic, pages?, question?, learnerAnswer?, correctAnswer?, errorType?, diagnosis?}]
   */
  async function log({ chatId, agent, input }) {
    if (!chatId) fail("拿不到会话编号");
    const record = ctx.learning.getSession(chatId);
    if (!record) fail("找不到这个会话");
    const pics = sessionImages(record);
    const items = (input.items || []).slice(0, 100);
    if (!items.length) fail("items 为空：至少要有一道题的批改结果");

    // 先检查错题的必填项，缺了让模型补，不要半截写入
    const missing = [];
    for (const it of items) {
      if (it.correct) continue;
      const need = ["topic", "question", "learnerAnswer", "correctAnswer", "errorType", "diagnosis"].filter((k) => !String(it[k] || "").trim());
      if (need.length) missing.push(`第 ${it.number} 题缺 ${need.join("、")}`);
    }
    if (missing.length) fail(`做错的题要写全字段：${missing.join("；")}。补齐后重新调用一次。`);

    const list = reviews();
    let rev = list.find((r) => r.chatId === chatId);
    if (!rev) { rev = { id: uid(), chatId, createdAt: nowIso(), items: [], pageIds: [] }; list.push(rev); }
    rev.updatedAt = nowIso();
    rev.title = str(input.title || rev.title || record.title || "讲题", 200);
    rev.subject = input.subject || rev.subject || "";

    // 整页图存一次：pageIds[i] 对应会话里第 i+1 张图
    const pageData = [];
    const usedPages = new Set();
    for (const it of items) for (const p of it.pages || []) if (Number.isInteger(p) && p >= 1 && p <= pics.length) usedPages.add(p - 1);
    for (const p of usedPages) {
      try {
        pageData[p] = await toJpeg(pics[p]);
        if (!rev.pageIds[p]) rev.pageIds[p] = images.save(pageData[p]);
      } catch { /* 转换失败：这页不存图 */ }
    }

    const mistakes = store.list("mistakes");
    const out = [];
    const cropJobs = [];
    for (const it of items) {
      const number = str(String(it.number ?? ""), 30) || "?";
      const old = rev.items.find((x) => x.number === number);
      // 纠正时没写的字段沿用上一次（分值、页码一般不会变）
      let pages = (it.pages || []).filter((p) => Number.isInteger(p) && p >= 1 && p <= pics.length).map((p) => p - 1);
      if (!pages.length && old?.pages?.length) pages = old.pages.map((p) => p - 1);
      const num = (v, prev) => (Number.isFinite(v) ? v : prev ?? null);
      const row = {
        number,
        correct: !!it.correct,
        score: num(it.score, it.correct && !Number.isFinite(it.score) && old?.fullScore != null ? old.fullScore : old?.score),
        fullScore: num(it.fullScore, old?.fullScore),
        topic: str(it.topic || old?.topic || "", 200),
        errorType: it.correct ? "" : str(it.errorType || "", 50),
        pages: pages.map((p) => p + 1),
      };
      row.mistakeId = old?.mistakeId || null;
      if (!row.correct) {
        const pageIds = pages.map((p) => rev.pageIds[p]).filter(Boolean);
        const fields = {
          subject: input.subject || it.subject,
          topic: it.topic,
          question: it.question,
          learnerAnswer: it.learnerAnswer,
          correctAnswer: it.correctAnswer,
          errorType: it.errorType,
          diagnosis: it.diagnosis,
        };
        const existing = row.mistakeId && mistakes.find((m) => m.id === row.mistakeId);
        if (existing) {
          Object.assign(existing, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, str(v, 20000)])));
          if (pageIds.length && !existing.images?.length) existing.images = pageIds;
          store.saveList("mistakes", mistakes);
        } else {
          // addMistake 写的是同一个缓存数组，不要再 push
          const m = addMistake({ ...fields, images: pageIds, source: "讲题会话", chatId });
          row.mistakeId = m.id;
        }
        // 已经裁过的错题（纠正时再调用）不重复裁
        const done = existing && existing.pageImages?.length;
        if (pages.length && !done) cropJobs.push({ mistakeId: row.mistakeId, number, question: it.question, pages, pageIds: rev.pageIds, pageData });
      } else if (row.mistakeId) {
        // 学习者纠正「其实做对了」：删掉之前记的错题（没重做过的才删）
        const i = mistakes.findIndex((m) => m.id === row.mistakeId);
        if (i >= 0 && !(mistakes[i].history || []).length) { mistakes.splice(i, 1); store.saveList("mistakes", mistakes); changed("mistakes"); }
        row.mistakeId = null;
      }
      if (old) Object.assign(old, row); else rev.items.push(row);
      out.push(row);
    }
    rev.items.sort((a, b) => String(a.number).localeCompare(String(b.number), "zh", { numeric: true }));
    const scored = rev.items.filter((x) => x.fullScore != null);
    rev.got = scored.length ? scored.reduce((s, x) => s + (x.score ?? (x.correct ? x.fullScore : 0)), 0) : null;
    rev.total = scored.length ? scored.reduce((s, x) => s + x.fullScore, 0) : null;
    rev.agent = agent;
    store.saveList("reviews", list);
    changed("reviews");

    // 裁图放后台，不耽误讲题；一次最多同时 3 道
    if (cropJobs.length) {
      (async () => {
        let next = 0;
        const worker = async () => { while (next < cropJobs.length && !ctx.signal.aborted) { const j = cropJobs[next++]; try { await cropMistake(j); } catch { /* 留整页图 */ } } };
        await Promise.all([worker(), worker(), worker()]);
      })().catch(() => {});
    }

    return { review: rev, rows: out, imageCount: pics.length };
  }

  return { log, reviews, sessionImages };
}

module.exports = { createPaper, sessionImages, toJpeg };
