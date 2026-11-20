"use strict";
// 分数判断机：按「考点分值 × 掌握度 × 记忆保持」估算现在能考多少分，并预测考试那天。
//
// 掌握度来自证据，按时间顺序逐条回放（每次都从原始记录重算，不会越算越偏）。
// 每条证据给出一个目标值（上限 × 表现），掌握度是这些目标值的加权累积平均，
// 并带一个「还没证据＝0」的先验：考点分值越大，需要的证据越多才能涨上去（做对 2 道细节题不等于阅读会了）。
//   讲解听懂（会话结算）      最多到 40%
//   练习题 / 自出题 / 错题    最多到 70%
//   真题（会话记录、快练、模考、错题重做） 最多到 90%；隔 ≥3 天再做还对 → 100%
// 遗忘：每个考点有记忆稳定度 S（天），保持率 R = (1 + t / 9S)^-1（t=S 时 R=0.9）；
//   分数 = 分值 × 掌握度 × (0.6 + 0.4R)，学会的东西最多掉到 60%（重新捡起来很快）。
//   第一次讲懂 S≈10 天、练对≈20 天、真题做对≈30 天；隔开复习成功一次 S 变成约 1.6–2.6 倍。
const { uid, nowIso, today, str, fail } = require("./util.cjs");
const { buildFrame } = require("./scoreframe.cjs");

const DAY = 86400000;
const KIND = {
  taught: { cap: 0.4, S0: 10, label: "讲解" },
  practice: { cap: 0.7, S0: 20, label: "练习" },
  real: { cap: 0.9, S0: 30, label: "真题" },
};
const WMAX = 8; // 最多按最近约 8 份证据平均，后来的进步能体现出来
const prior = (points) => 1.5 + points / 4;
const RESULT_Q = { 没懂: 0.1, 勉强: 0.4, 基本会: 0.75, 熟练: 1 };
const FLOOR = 0.6;
const DUE_R = 0.85;
const Rf = (days, S) => (S > 0 ? 1 / (1 + Math.max(0, days) / (9 * S)) : 0);
const keep = (R) => FLOOR + (1 - FLOOR) * R;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function createScore({ ctx, store, bank, llm, progress, momo, getSettings, transcriptText, classify }) {
  // ── 框架（考点分值）缓存：题库或 AI 归类变了才重建 ──
  let frameCache = null;
  function frame() {
    const items = bank.all();
    const ai = store.value("scoreMap", { map: {}, at: null });
    const sig = `${items.length}|${ai.at}`;
    if (frameCache?.sig === sig) return frameCache;
    const built = buildFrame(items, ai.map || {});
    const leaves = new Map();
    for (const s of built.frame) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) leaves.set(l.id, { ...l, subject: s.key, module: m.name, chapter: c.name, ref: l });
    const qMap = new Map();
    for (const q of items) qMap.set(q.id, q);
    frameCache = { sig, ...built, leaves, qMap, aiAt: ai.at, aiCount: Object.keys(ai.map || {}).length };
    return frameCache;
  }

  const settlements = () => store.list("settlements");

  // ── 证据收集 ──
  function collect() {
    const f = frame();
    const obs = []; // {leaf, at(ms), kind, q, w, label, src}
    const push = (leaf, o) => { if (f.leaves.has(leaf)) obs.push({ leaf, ...o }); };
    // 1) 真题 / 题库题：快练、模考、英语专项、会话里记录的真题、带真题的错题与重做
    const { map } = progress.events();
    for (const [qid, evs] of map) {
      const q = f.qMap.get(qid);
      if (!q) continue;
      const hits = f.mapQ(q);
      if (!hits.length) continue;
      const kind = q.source === "AI生成" ? "practice" : "real";
      for (const e of evs) {
        let quality = null;
        if (e.score != null && e.max) quality = Math.max(0, Math.min(1, e.score / e.max));
        else if (e.correct === true) quality = 1;
        else if (e.correct === false) quality = 0;
        if (quality == null) continue;
        const at = Date.parse(e.at);
        if (!at) continue;
        for (const h of hits) push(h.id, { at, kind, q: quality, w: h.w, label: `${q.paper || "题库"}${q.number ? ` 第${q.number}题` : ""}`, src: e.source || "练习" });
      }
    }
    // 2) 不带真题的错题（会话里出的题、手动录入）：记错题算一次做错，重做按结果
    const settled = new Set(settlements().map((s) => s.chatId));
    for (const m of store.list("mistakes")) {
      if (m.bankId) continue;
      const hits = f.matcher.text(["数学", "408", "英语", "政治"].includes(m.subject) ? m.subject : null, m.topic, m.question);
      if (!hits.length) continue;
      const label = `错题 · ${m.topic}`;
      if (!(m.chatId && settled.has(m.chatId))) {
        const at = Date.parse(m.createdAt);
        if (at) for (const h of hits) push(h.id, { at, kind: "practice", q: 0, w: h.w, label, src: m.source || "错题本" });
      }
      for (const h of m.history || []) {
        const at = Date.parse(h.at);
        const qv = h.correct === true ? 1 : h.correct === false ? 0 : h.rating ? (h.rating >= 3 ? 1 : h.rating === 2 ? 0.5 : 0) : null;
        if (!at || qv == null) continue;
        for (const x of hits) push(x.id, { at, kind: "practice", q: qv, w: x.w, label: `${label}（重做）`, src: "错题重做" });
      }
    }
    // 3) 会话结算：讲解 / 练习
    for (const s of settlements()) {
      const at = Date.parse(s.at);
      for (const it of s.items || []) push(it.leaf, { at, kind: it.kind === "practice" ? "practice" : "taught", q: it.q, w: Math.min(5, 1.5 + 0.5 * (it.n || 0)), label: s.title || "学习会话", src: it.kind === "practice" ? "会话练习" : "会话讲解", note: it.note, chatId: s.chatId });
    }
    obs.sort((a, b) => a.at - b.at);
    return obs;
  }

  /** 回放一个考点的证据，得到 at 时刻的状态。 */
  function replay(list, at, points) {
    const st = { m: 0, S: 0, W: 0, last: null, lastGood: null, n: 0, real: 0, evidence: [] };
    const B = prior(points);
    for (const o of list) {
      if (o.at > at) break;
      const k = KIND[o.kind];
      const elapsed = st.last ? (o.at - st.last) / DAY : 0;
      const R = st.last ? Rf(elapsed, st.S) : 1;
      const cur = st.m * (st.last ? keep(R) : 1);
      let cap = k.cap;
      if (o.kind === "real" && o.q >= 0.8 && st.lastGood && (o.at - st.lastGood) / DAY >= 3) cap = 1;
      const target = cap * o.q;
      const w = Math.max(0.05, o.w);
      st.W = Math.min(WMAX, st.W + w);
      let m = cur + (target - cur) * (w / (B + st.W));
      m = Math.max(0, Math.min(1, m));
      if (o.q >= 0.6) {
        if (!st.S) st.S = k.S0;
        else {
          const gain = elapsed >= 1 ? 1 + 2 * (1 - R) + 0.6 : 1.03;
          st.S = Math.max(k.S0 * (o.kind === "taught" ? 1 : 0.8), st.S * gain);
        }
        if (o.q >= 0.8) st.lastGood = o.at;
      } else st.S = Math.max(3, (st.S || k.S0) * 0.5);
      st.evidence.push({ at: new Date(o.at).toISOString(), kind: o.kind, q: r2(o.q), label: o.label, src: o.src, note: o.note || "", delta: r2((m - cur) * points), decay: r2((st.m - cur) * points) });
      st.m = m;
      st.last = o.at;
      st.n++;
      if (o.kind === "real") st.real++;
    }
    return st;
  }

  function vocabNow(target, at = Date.now()) {
    const v = momo.vocabState(target, at);
    if (v.at) return v;
    // 没接墨墨：用插件自己的生词本
    const words = store.list("vocab");
    let sum = 0;
    for (const w of words) {
      const c = w.card;
      if (!c?.last || !c.stability) continue;
      sum += Math.pow(1 + (19 / 81) * ((at - Date.parse(c.last)) / DAY) / c.stability, -0.5);
    }
    return { at: null, local: true, target, total: words.length, learned: words.filter((w) => w.card?.last).length, effective: Math.round(sum), mastery: Math.min(1, sum / target), due: 0, strong: 0, weak: 0, error: v.error || "" };
  }

  /** 某一时刻的全部分数（history=true 时只要总分）。 */
  function evaluate(at = Date.now(), { obs = collect(), vocab, detail = true } = {}) {
    const f = frame();
    const s = getSettings();
    const target = Number(s.vocabTarget) || 5500;
    const byLeaf = new Map();
    for (const o of obs) { if (!byLeaf.has(o.leaf)) byLeaf.set(o.leaf, []); byLeaf.get(o.leaf).push(o); }
    const v = vocab || vocabNow(target, at);
    let total = 0;
    let varSum = 0;
    const subjects = [];
    for (const sub of f.frame) {
      const so = { key: sub.key, name: sub.name, max: sub.max, score: 0, modules: [] };
      for (const mod of sub.modules) {
        const mo = { name: mod.name, max: mod.max, score: 0, chapters: [] };
        for (const ch of mod.chapters) {
          const co = { name: ch.name, max: 0, score: 0, leaves: [] };
          for (const l of ch.leaves) {
            let view;
            if (l.kind === "vocab") {
              // 分值＝这一档的词数 / 目标词汇量 × 15；得分＝分值 × 这一档的平均记忆率（四档合计＝15 × 有效词汇 / 目标）
              const vmax = mod.max;
              const tgt = Math.max(1, v.target || target);
              let pts = 0, m = 0, n = 0, band = null;
              if (v.bands) {
                if (l.band === "new") { n = Math.max(0, tgt - (v.learned || 0)); pts = (vmax * n) / Math.max(tgt, v.learned || 0); m = 0; }
                else { band = v.bands[l.band] || { n: 0, sumR: 0, samples: [] }; n = band.n; pts = (vmax * n) / Math.max(tgt, v.learned || 0); m = n ? band.sumR / n : 0; }
              } else if (l.band === "easy") { pts = vmax; m = v.mastery; }
              const sc = pts * m;
              view = { id: l.id, name: l.name, band: l.band, points: r2(pts), score: r2(sc), m: r2(m), now: r2(m), R: r2(m), vocab: { ...v, bands: undefined }, words: band?.samples || [], due: l.band === "hard" && n > 0, n };
              varSum += (pts * 0.05) ** 2;
            } else {
              const st = replay(byLeaf.get(l.id) || [], at, l.points);
              const R = st.last ? Rf((at - st.last) / DAY, st.S) : 0;
              const mNow = st.m * (st.last ? keep(R) : 0);
              const sc = l.points * mNow;
              const sigma = st.n ? 0.28 / Math.sqrt(st.n + st.real) : 0;
              varSum += (l.points * sigma * Math.max(0.3, mNow)) ** 2;
              view = { id: l.id, name: l.name, points: l.points, score: r2(sc), m: r2(st.m), now: r2(mNow), R: r2(R), S: r1(st.S), n: st.n, real: st.real, realCount: l.realCount || 0, last: st.last ? new Date(st.last).toISOString() : null };
              if (st.last) {
                view.due = st.m >= 0.15 && R < DUE_R;
                // 保持率降到 85% 的日子：t = 9S(1/R - 1)
                view.dueAt = new Date(st.last + 9 * st.S * (1 / DUE_R - 1) * DAY).toISOString();
                view.loss = r2(l.points * st.m * (1 - keep(R)));
                if (detail) view.evidence = st.evidence.slice(-60).reverse();
              }
            }
            co.max += l.points; co.score += view.score; co.leaves.push(view);
          }
          co.max = r2(co.max); co.score = r2(co.score);
          mo.score += co.score; mo.chapters.push(co);
        }
        mo.score = r2(mo.score); so.score += mo.score; so.modules.push(mo);
      }
      so.score = r2(so.score); total += so.score; subjects.push(so);
    }
    const vocabMax = f.frame.find((x) => x.key === "英语").modules[0].max;
    const vocabScore = vocabMax * v.mastery;
    return { at: new Date(at).toISOString(), total: r1(total), max: 500, sigma: r1(Math.sqrt(varSum)), subjects, vocab: { ...v, bands: undefined }, vocabScore: r2(vocabScore), vocabMax };
  }

  // ── 历史与预测 ──
  function snapshotVocab(v) {
    const h = store.value("scoreHistory", { vocab: {} });
    const d = today();
    if (h.vocab[d] === r2(v.mastery)) return;
    h.vocab[d] = r2(v.mastery);
    store.saveValue("scoreHistory", h);
  }
  function vocabAt(dateStr, fallback) {
    const h = store.value("scoreHistory", { vocab: {} }).vocab;
    const days = Object.keys(h).sort();
    let val = null;
    for (const d of days) { if (d <= dateStr) val = h[d]; else break; }
    if (val == null) val = days.length ? h[days[0]] : fallback;
    return val;
  }

  function overview() {
    const obs = collect();
    const now = Date.now();
    const cur = evaluate(now, { obs });
    if (cur.vocab.at || cur.vocab.local) snapshotVocab(cur.vocab);
    const s = getSettings();
    const target = Number(s.vocabTarget) || 5500;
    const vocabPts = frame().frame.find((x) => x.key === "英语").modules[0].max;
    // 最近 60 天每天的总分（词汇用每天的快照）
    const first = obs.length ? obs[0].at : now;
    const startDay = Math.max(first - DAY, now - 90 * DAY);
    const history = [];
    for (let t = new Date(startDay).setHours(23, 59, 59, 999); t < now; t += DAY) {
      const d = today(new Date(t));
      const vm = vocabAt(d, cur.vocab.mastery);
      const e = evaluate(t, { obs, vocab: { mastery: vm, learned: 0, effective: 0, due: 0, target }, detail: false });
      history.push({ day: d, total: e.total, rest: e.total - e.vocabScore, subjects: Object.fromEntries(e.subjects.map((x) => [x.key, x.score])) });
    }
    history.push({ day: today(), total: cur.total, rest: cur.total - cur.vocabScore, subjects: Object.fromEntries(cur.subjects.map((x) => [x.key, x.score])) });
    // 预测考试那天：
    // - 单词以外：最近 14 天的净增长速度（数据不满 14 天的，之前按 0 算，避免刚开始几天外推得离谱），
    //   按「离满分越近越难涨」的曲线外推；不学了就只剩遗忘。
    // - 单词：按墨墨最近 28 天每天新学的词数外推，保持现在的平均记忆率。
    const examDate = s.examDate || "2027-12-18";
    const examAt = Date.parse(`${examDate}T09:00:00`);
    const daysLeft = Math.max(0, (examAt - now) / DAY);
    const win = 14;
    const pastDay = today(new Date(now - win * DAY));
    const hit = history.find((h) => h.day === pastDay);
    const pastRest = hit ? hit.rest : pastDay < history[0].day ? 0 : history[0].rest;
    const restNow = cur.total - cur.vocabScore;
    const restMax = 500 - cur.vocabMax;
    const slope = (restNow - pastRest) / win;
    const idle = evaluate(examAt, { obs, vocab: { ...cur.vocab, mastery: cur.vocab.mastery }, detail: false });
    const idleRest = idle.total - idle.vocabScore;
    let restProj = idleRest;
    if (slope > 0) {
      const head = restMax - restNow;
      restProj = restMax - head * Math.exp(-(slope / Math.max(1, head)) * daysLeft);
    }
    const words = momo.cache().words || [];
    const newPerDay = words.filter((w) => w.first && now - Date.parse(w.first) <= 28 * DAY).length / 28;
    const v = cur.vocab;
    const avgR = v.learned ? v.effective / v.learned : 0.9;
    const vocabProjM = Math.min(1, ((v.learned || 0) + newPerDay * daysLeft) * (avgR || 0.9) / target);
    const vocabIdleM = v.learned ? Math.min(1, v.effective * 0.7 / target) : 0;
    const projected = restProj + cur.vocabMax * Math.max(vocabProjM, v.mastery * 0.9);
    const idleTotal = idleRest + cur.vocabMax * vocabIdleM;
    const dataDays = Math.max(1, (now - first) / DAY);
    const spread = (6 + 0.2 * Math.abs(projected - cur.total)) * (1 + 1.5 * Math.max(0, 1 - dataDays / 30));
    const review = [];
    for (const sub of cur.subjects) for (const m of sub.modules) for (const c of m.chapters) for (const l of c.leaves) {
      if (l.due && !l.vocab && !l.band) review.push({ id: l.id, name: l.name, subject: sub.key, chapter: c.name, points: l.points, score: l.score, R: l.R, loss: l.loss || 0, last: l.last });
    }
    review.sort((a, b) => b.loss - a.loss);
    // 每天的学习量：证据条数 + 当天带来的加分（热力图用，最近 26 周）
    const daily = {};
    for (const o of obs) { const d = today(new Date(o.at)); if (o.at >= now - 182 * DAY) (daily[d] ||= { n: 0, gain: 0 }).n++; }
    for (const sub of cur.subjects) for (const m of sub.modules) for (const c of m.chapters) for (const l of c.leaves) for (const e of l.evidence || []) {
      if (e.delta > 0) { const d = today(new Date(e.at)); if (daily[d]) daily[d].gain = r2(daily[d].gain + e.delta); }
    }
    const f = frame();
    return {
      ...cur,
      daily,
      examDate, daysLeft: Math.ceil(daysLeft),
      projection: { value: r1(projected), low: r1(Math.max(idleTotal, projected - spread)), high: r1(Math.min(500, projected + spread)), slope: r2(slope), window: win, idle: r1(idleTotal), vocabPerDay: r1(newPerDay), dataDays: Math.round(dataDays) },
      history,
      review: review.slice(0, 20),
      reviewCount: review.length,
      frameInfo: { mapped: f.stats.mapped, total: f.stats.total, aiCount: f.aiCount, aiAt: f.aiAt, vocabPts },
      settlements: settlements().slice(-30).reverse().map((x) => ({ chatId: x.chatId, at: x.at, title: x.title, by: x.by, items: (x.items || []).length })),
    };
  }

  /** 平铺的考点分数，用来比较前后变化。 */
  function flat(e) {
    const out = new Map();
    for (const s of e.subjects) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) out.set(l.id, { name: l.name, subject: s.key, chapter: c.name, score: l.score, points: l.points });
    return out;
  }
  function diff(before, after) {
    const a = flat(before);
    const b = flat(after);
    const items = [];
    for (const [id, x] of b) {
      const d = x.score - (a.get(id)?.score || 0);
      if (Math.abs(d) >= 0.01) items.push({ id, name: x.name, subject: x.subject, chapter: x.chapter, delta: r2(d), score: x.score, points: r2(x.points) });
    }
    items.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));
    return { before: before.total, after: after.total, delta: r1(after.total - before.total), items };
  }
  /** 跑一个会改变证据的操作，返回它对分数的影响。 */
  function measure(fn) {
    const before = evaluate(Date.now(), { detail: false });
    const result = fn();
    const after = evaluate(Date.now(), { detail: false });
    return { result, impact: diff(before, after) };
  }

  // ── 会话结算 ──
  function leafCatalog(subjects) {
    const f = frame();
    const lines = [];
    const codes = new Map();
    let i = 0;
    for (const s of f.frame) {
      if (subjects && !subjects.includes(s.key)) continue;
      for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) {
        if (l.kind === "vocab") continue;
        const code = `K${++i}`;
        codes.set(code, l.id);
        lines.push(`${code} ${s.key} / ${m.name} / ${c.name} / ${l.name}`);
      }
    }
    return { text: lines.join("\n"), codes };
  }

  async function settle({ chatId, by = "button", signal, progress: report }) {
    const record = ctx.learning.getSession(chatId);
    if (!record) fail("找不到这个会话");
    const text = transcriptText(record, 50000);
    if (text.length < 80) fail("这个会话还没有什么内容可以结算");
    const ts = (record.messages || []).map((m) => m.timestamp).filter((t) => typeof t === "number");
    const at = ts.length ? Math.max(...ts) : Date.now();
    const subject = classify(`${record.title || ""} ${text.slice(0, 4000)}`);
    const subjects = ["数学", "408", "英语", "政治"].includes(subject) ? [subject] : null;
    const cat = leafCatalog(subjects);
    report?.(0, 2, "AI 评估这次学习");
    const res = await llm.json({
      system: `你是考研学习评估员。读一段学习会话记录（老师是 AI，学习者是考研学生），判断这次会话里学习者在哪些考点上有了什么程度的掌握，用于估算考研分数。
考点只能从下面的列表里选（用编号）：
${cat.text}

规则：
- 只评估这次会话里真正讲过或练过的考点；只是顺口提到的不算。一个知识点对应多个考点时，选最贴切的 1–2 个。
- kind：只听了讲解、没有做题检验 → "taught"；做了检查题 / 练习题 → "practice"。
- result（按学习者自己的作答表现判断，要保守，宁低勿高）：
  "没懂"＝答错、需要老师反复讲；"勉强"＝错过后在提示下才做对，或只答对简单题；"基本会"＝独立做对了大部分题，偶有小错；"熟练"＝考研难度的题也能独立、完整、快速做对。
  只有讲解、没有作答的考点，result 最多写"基本会"（按学习者的反馈和追问判断理解程度）。
- n：这个考点学习者实际作答的题数（没做题写 0）。
- 题库真题原题（会话里调用过 kaoyan_bank_record 的）系统会单独计分，不要把它们算进来；但同一考点的讲解和其他练习照常评估。
- note：一句话说明依据（例如「3 道检查题错 1 道，错在漏掉定义域」）。
输出 JSON：{"items":[{"code":"K12","kind":"practice","result":"基本会","n":3,"note":"…"}],"summary":"一两句话总结这次学了什么、哪里还弱"}`,
      text: `会话标题：${record.title || "（无）"}\n\n${text}`,
      maxTokens: 4000,
      signal,
    });
    const items = [];
    const seen = new Set();
    for (const it of res.items || []) {
      const leaf = cat.codes.get(String(it.code || "").trim().toUpperCase());
      if (!leaf || seen.has(leaf)) continue;
      seen.add(leaf);
      const result = RESULT_Q[it.result] != null ? it.result : "勉强";
      const kind = it.kind === "practice" && Number(it.n) > 0 ? "practice" : "taught";
      items.push({ leaf, kind, result, q: RESULT_Q[result], n: Math.max(0, Math.min(50, Math.round(Number(it.n) || 0))), note: str(String(it.note || ""), 300) });
    }
    report?.(1, 2, "计算分数变化");
    const { impact } = measure(() => {
      const list = settlements().filter((x) => x.chatId !== chatId);
      list.push({ id: uid(), chatId, at: new Date(at).toISOString(), settledAt: nowIso(), by, title: str(record.title || "", 200), subject, items, summary: str(String(res.summary || ""), 1000) });
      store.saveList("settlements", list);
    });
    const f = frame();
    return {
      chatId, title: record.title || "", summary: res.summary || "",
      items: items.map((x) => ({ ...x, name: f.leaves.get(x.leaf)?.name, chapter: f.leaves.get(x.leaf)?.chapter, subject: f.leaves.get(x.leaf)?.subject })),
      impact,
    };
  }

  function unsettled() {
    let sessions = [];
    try { sessions = ctx.learning.listSessions() || []; } catch { sessions = []; }
    const done = new Map(settlements().map((x) => [x.chatId, x.settledAt || x.at]));
    const cutoff = Date.now() - 7 * DAY;
    return sessions
      .filter((x) => ["teach", "teaching", "practice"].includes(x.kind) && Date.parse(x.updatedAt) >= cutoff)
      .filter((x) => !done.has(x.id) || Date.parse(x.updatedAt) > Date.parse(done.get(x.id)) + 5 * 60000)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 8)
      .map((x) => ({ id: x.id, title: x.title || "未命名会话", kind: x.kind, updatedAt: x.updatedAt, settled: done.has(x.id) }));
  }

  // ── AI 精确归类真题考点（一次性，可续跑） ──
  async function classifyBank({ progress: report, signal, force = false }) {
    const f = frame();
    const saved = store.value("scoreMap", { map: {}, at: null });
    const map = force ? {} : { ...(saved.map || {}) };
    const todo = bank.all().filter((q) => ["数学", "408"].includes(q.subject) && q.source !== "AI生成" && !map[q.id]);
    const total = todo.length;
    let done = 0;
    for (const subject of ["数学", "408"]) {
      const list = todo.filter((q) => q.subject === subject);
      const cat = leafCatalog([subject]);
      for (let i = 0; i < list.length; i += 25) {
        if (signal?.aborted) fail("已取消");
        const batch = list.slice(i, i + 25);
        report?.(done, total, `${subject}：归类 ${done + 1}–${done + batch.length} / ${total}`);
        const res = await llm.json({
          system: `把考研真题归到考试大纲的考点上。考点列表（编号 科目/模块/章节/考点）：\n${cat.text}\n\n每道题给 1–3 个考点编号，按这道题主要考查的内容排序（第一个是主考点）；综合题列出各小问的主要考点。输出 JSON：{"items":[{"i":题目序号,"codes":["K3","K17"]}]}`,
          text: batch.map((q, j) => `#${j} ${q.paper} 第${q.number}题（${q.type}，${q.score || "?"}分）考点标签：${(q.topics || []).join("、") || "无"}\n${String(q.stem || "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n"),
          maxTokens: 3000,
          slot: "cheap",
          signal,
        });
        for (const it of res.items || []) {
          const q = batch[Number(it.i)];
          if (!q) continue;
          const ids = (it.codes || []).map((c) => cat.codes.get(String(c).trim().toUpperCase())).filter(Boolean).slice(0, 3);
          if (ids.length) map[q.id] = [...new Set(ids)];
        }
        done += batch.length;
        store.saveValue("scoreMap", { map, at: saved.at, partial: true });
      }
    }
    store.saveValue("scoreMap", { map, at: nowIso() });
    frameCache = null;
    void f;
    return { mapped: Object.keys(map).length, total: bank.all().filter((q) => ["数学", "408"].includes(q.subject) && q.source !== "AI生成").length };
  }

  /** 一个考点对应的题库真题（用来「用真题练这个考点」）。 */
  function questionsOf(leafId, limit = 10) {
    const f = frame();
    const { map } = progress.events();
    const hits = [];
    for (const q of f.qMap.values()) {
      if (q.source === "AI生成") continue;
      const m = f.mapQ(q).find((h) => h.id === leafId);
      if (!m) continue;
      const ev = map.get(q.id) || [];
      const last = ev[ev.length - 1];
      hits.push({ id: q.id, paper: q.paper, number: q.number, type: q.type, score: q.score, year: q.year || 0, w: m.w, done: ev.length, lastCorrect: last ? last.correct : null });
    }
    // 没做过的、近年的、主考点的优先
    hits.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.w - a.w || b.year - a.year);
    return { total: hits.length, done: hits.filter((h) => h.done).length, items: hits.slice(0, limit) };
  }

  return { frame, overview, evaluate, measure, diff, settle, unsettled, classifyBank, questionsOf, collect };
}

module.exports = { createScore };
