"use strict";
// 分数判断机：按「考点分值 × 掌握度 × 记忆保持」估算现在能考多少分，并预测考试那天。
//
// 掌握度来自证据，按时间顺序逐条回放（每次都从原始记录重算，不会越算越偏）。
// 每道题（真题、习题、会话里出的题、错题重做、讲题批改）都带一个难度档 1–5（AI 判断），每档有上限：
//   基础 30% · 简单 50% · 中档 70% · 较难 85% · 压轴 100%
// 做对一题：掌握度向这一档的上限靠近一截（rate × 权重 × 作答质量 × (上限 − 当前)）。
//   所以刚开始简单题也能加分；分越高，简单题加得越少（超过它那档上限就不加了），要更难的题才能继续涨；
//   从易到难各档都做对过，才能到满。考点分值越大，每题加得越少（rate = 0.4 / (1 + 分值/8)）。
// 做错一题：掌握度往下一档的上限回落一截——简单题做错说明基础不牢，扣得多；难题做错，在难题水平以下不扣。
//   计算失误 / 审题错误这类粗心错，扣分减半。
// 同一道题 3 天内重复做只算 0.3 倍；会话讲解（只听没做题）按「基础」档算。
// 遗忘：每个考点有记忆稳定度 S（天），保持率 R = (1 + t / 9S)^-1（t=S 时 R=0.9）；
//   分数 = 分值 × 掌握度 × (0.6 + 0.4R)，学会的东西最多掉到 60%（重新捡起来很快）。
//   难度越高的题做对，S 起点越长；隔开复习成功一次 S 变成约 1.6–2.6 倍。
const { uid, nowIso, today, str, fail } = require("./util.cjs");
const { buildFrame } = require("./scoreframe.cjs");
const { points, byId, byLeaf: pointsByLeaf, exactPoints, validPointIds } = require("./knowledge.cjs");
const { weights } = require("./question-knowledge.cjs");
const { itemsOfPoint } = require("./outline.cjs");
const vocablist = require("./vocablist.cjs");
const { retention } = require("./momo.cjs");

const DAY = 86400000;
const TIERS = [null,
  { d: 1, name: "基础", cap: 0.3, S0: 8, desc: "直接套定义或公式，一两步就出结果" },
  { d: 2, name: "简单", cap: 0.5, S0: 12, desc: "常规变形，两三步，方法一眼能看出" },
  { d: 3, name: "中档", cap: 0.7, S0: 20, desc: "考研选择 / 填空的常见难度，有一个陷阱或要选对方法" },
  { d: 4, name: "较难", cap: 0.85, S0: 28, desc: "真题解答题，综合两三个考点、步骤较长" },
  { d: 5, name: "压轴", cap: 1, S0: 35, desc: "真题压轴 / 难题，需要构造或较深的思路" },
];
const tierOf = (d) => TIERS[Math.max(1, Math.min(5, Math.round(Number(d) || 3)))];
const KIND_LABEL = { taught: "讲解", practice: "练习", real: "真题" };
const RATE_DOWN = 0.25;
const SLIPS = new Set(["计算失误", "审题错误"]); // 粗心类错误：扣分减半
const rateOf = (points) => 0.4 / (1 + (points || 0) / 8);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const RESULT_Q = { 没懂: 0.1, 勉强: 0.4, 基本会: 0.75, 熟练: 1 };
const FLOOR = 0.6;
const DUE_R = 0.85;
const Rf = (days, S) => (S > 0 ? 1 / (1 + Math.max(0, days) / (9 * S)) : 0);
const keep = (R) => FLOOR + (1 - FLOOR) * R;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function createScore({ ctx, store, bank, llm, progress, coverage, momo, getSettings, transcriptText, classify, onChange = () => {} }) {
  // ── 框架（考点分值）缓存：题库或 AI 归类变了才重建 ──
  let frameCache = null;
  function frame() {
    const items = bank.all();
    const ai = store.value("scoreMap", { map: {}, at: null });
    const sig = `${items.length}|${ai.at}`;
    if (frameCache?.sig === sig) return frameCache;
    const built = buildFrame(items, ai.map || {}, ai.points || {});
    const leaves = new Map();
    for (const s of built.frame) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) leaves.set(l.id, { ...l, subject: s.key, module: m.name, chapter: c.name, ref: l });
    const qMap = new Map();
    for (const q of items) qMap.set(q.id, q);
    frameCache = { sig, ...built, leaves, qMap, aiAt: ai.at, aiCount: Object.keys(ai.map || {}).length };
    return frameCache;
  }

  const settlements = () => store.list("settlements");

  // ── 题目难度（1–5）：AI 评过的用 AI 的，没评过的按题型和位置估 ──
  const diffMap = () => store.value("difficulty", { map: {}, at: null }).map || {};
  let lastNumCache = null;
  /** 每份试卷里最后两道解答题的题号（压轴）。 */
  function lastSolveNums() {
    const f = frame();
    if (lastNumCache?.sig === f.sig) return lastNumCache.map;
    const by = new Map();
    for (const q of f.qMap.values()) {
      if (!q.paper || !["解答", "分析"].includes(q.type)) continue;
      const n = numKey(q.number);
      if (!by.has(q.paper)) by.set(q.paper, []);
      by.get(q.paper).push(n);
    }
    const map = new Map([...by].map(([k, v]) => [k, new Set([...new Set(v)].sort((a, b) => b - a).slice(0, 2))]));
    lastNumCache = { sig: f.sig, map };
    return map;
  }
  function numKey(n) { const m = String(n).match(/\d+/); return m ? Number(m[0]) : 0; }
  /** 一道题库题的难度档。 */
  function qDiff(q, map = diffMap()) {
    const ai = Number(map[q.id]);
    if (ai >= 1 && ai <= 5) return ai;
    if (q.source === "AI生成") return 2;
    if (q.source === "习题") {
      // 习题书：基础篇 / 660 起点 2，强化篇 / 综合篇起点 3；解答题再高一档
      const base = /强化|综合|提高|测试卷/.test(q.paper || "") ? 3 : 2;
      return Math.min(5, base + (["解答", "分析"].includes(q.type) ? 1 : 0));
    }
    if (q.subject === "英语") return ["小作文", "完形"].includes(q.part) ? 2 : 3;
    if (["解答", "分析"].includes(q.type)) return lastSolveNums().get(q.paper)?.has(numKey(q.number)) ? 5 : 4;
    if (q.subject === "数学" && numKey(q.number) <= 2) return 2;
    return 3;
  }
  const d15 = (x, dflt = 3) => { const n = Math.round(Number(x)); return n >= 1 && n <= 5 ? n : dflt; };

  // ── 证据收集 ──
  function collect() {
    const f = frame();
    const dm = diffMap();
    const obs = []; // {leaf, at(ms), kind, q, w, d, label, src, qid}
    const push = (leaf, o) => { if (f.leaves.has(leaf)) obs.push({ leaf, ...o }); };
    const inLeaf = (ids, leaf) => (ids || []).filter((id) => byId.get(id)?.leaf === leaf);
    const quality = (e) => (e.score != null && e.max ? Math.max(0, Math.min(1, e.score / e.max)) : e.correct === true ? 1 : e.correct === false ? 0 : null);
    // 1) 题库题：快练、模考、英语专项、会话里记录的原题、带题库 id 的错题与重做
    const { map } = progress.events();
    for (const [qid, evs] of map) {
      const q = f.qMap.get(qid);
      if (!q) continue;
      let hits = f.mapQ(q);
      if (!hits.length) hits = f.matcher.questionFallback(q);
      if (!hits.length) continue;
      const pooled = hits[0].level && hits[0].level !== "leaf" ? `没对上具体考点，按${{ chapter: "章", module: "模块", subject: "科目" }[hits[0].level]}「${hits[0].pool}」整体计` : "";
      const kind = q.source === "AI生成" || q.source === "习题" ? "practice" : "real";
      const base = qDiff(q, dm);
      const testedAll = f.knowledge.get(qid)?.tested || [];
      for (const e of evs) {
        const qv = quality(e);
        if (qv == null) continue;
        const at = Date.parse(e.at);
        if (!at) continue;
        const d = d15(e.difficulty, base);
        const ids = validPointIds(e.pointIds, q.subject);
        const assessed = weights(ids);
        const used = ids.length ? ids : testedAll;
        for (const h of assessed.length ? assessed : hits) push(h.id, { at, kind, q: e.hinted && qv === 1 ? 0.6 : qv, w: h.w, d, qid, pts: inLeaf(used, h.id), label: `${q.paper || "题库"}${q.number ? ` 第${q.number}题` : ""}`, src: e.source || "练习", note: pooled });
      }
    }
    // 旧版结算（v<2）的练习评估里已经包含了那次会话的错题，避免重复计入
    const oldSettled = new Set(settlements().filter((x) => (x.v || 1) < 2).map((x) => x.chatId));
    const textHits = (subject, topic, body) => matchText(f, subject, topic, body);
    // 没对上具体考点、按章 / 模块 / 科目整体计的，在证据里注明
    const poolNote = (hits, note = "") => { const h = hits[0]; const p = h && h.level && h.level !== "leaf" ? `没对上具体考点，按${{ chapter: "章", module: "模块", subject: "科目" }[h.level]}「${h.pool}」整体计` : ""; return [p, note].filter(Boolean).join("；"); };
    // 2) 不带题库 id 的错题（会话里出的题、讲题批改、手动录入）：记错题算一次做错，重做按结果
    for (const m of store.list("mistakes")) {
      if (m.bankId) continue;
      const mIds = validPointIds(m.pointIds, m.subject);
      const assessed = weights(mIds);
      const hits = assessed.length ? assessed : textHits(m.subject, m.topic, m.question);
      if (!hits.length) continue;
      const label = `错题 · ${m.topic}`;
      const d = d15(m.difficulty);
      const qid = `m:${m.id}`;
      if (!(m.chatId && oldSettled.has(m.chatId))) {
        const at = Date.parse(m.createdAt);
        if (at) for (const h of hits) push(h.id, { at, kind: "practice", q: 0, w: h.w, d, qid, pts: inLeaf(mIds, h.id), label, src: m.source || "错题本", soft: SLIPS.has(m.errorType), note: poolNote(hits) });
      }
      for (const h of m.history || []) {
        const at = Date.parse(h.at);
        const qv = h.correct === true ? 1 : h.correct === false ? 0 : h.rating ? (h.rating >= 3 ? 1 : h.rating === 2 ? 0.5 : 0) : null;
        if (!at || qv == null) continue;
        for (const x of hits) push(x.id, { at, kind: "practice", q: qv, w: x.w, d, qid, pts: inLeaf(mIds, x.id), label: `${label}（重做）`, src: "错题重做", note: poolNote(hits) });
      }
    }
    // 3) 会话里逐题记录的题（kaoyan_record_question：答对 / 提示后对 / 部分对）
    for (const r of store.list("qlog")) {
      const at = Date.parse(r.at);
      const rIds = validPointIds(r.pointIds, r.subject);
      const assessed = weights(rIds);
      const hits = assessed.length ? assessed : textHits(r.subject, r.topic, r.question);
      if (!at || !hits.length) continue;
      for (const h of hits) push(h.id, { at, kind: "practice", q: r.q, w: h.w, d: d15(r.difficulty), pts: inLeaf(rIds, h.id), label: r.topic, src: r.src || "会话", note: poolNote(hits, r.note || "") });
    }
    // 4) 讲题批改里做对的题（做错的已经进了错题本）
    for (const rev of store.list("reviews")) {
      const at = Date.parse(rev.createdAt);
      if (!at) continue;
      for (const it of rev.items || []) {
        if (!it.correct) continue;
        const hits = textHits(rev.subject, it.topic, "");
        const qv = it.score != null && it.fullScore ? Math.max(0, Math.min(1, it.score / it.fullScore)) : 1;
        for (const h of hits) push(h.id, { at, kind: "practice", q: qv, w: h.w, d: d15(it.difficulty), label: `${rev.title || "讲题"} 第${it.number}题`, src: "讲题批改", note: poolNote(hits) });
      }
    }
    // 5) 会话结算：讲解按「基础」档；没有逐题记录的练习按结算给的难度档
    for (const s of settlements()) {
      const at = Date.parse(s.at);
      for (const it of s.items || []) {
        const practice = it.kind === "practice";
        push(it.leaf, { at, kind: practice ? "practice" : "taught", q: it.q, w: practice ? Math.min(2, 1 + 0.3 * (it.n || 0)) : 1, d: practice ? d15(it.level, 2) : 1, label: s.title || "学习会话", src: practice ? "会话练习" : "会话讲解", note: it.note, chatId: s.chatId });
      }
    }
    obs.sort((a, b) => a.at - b.at);
    return obs;
  }

  /** 自由文本 → 考点（对不上具体考点时逐级归到章 / 模块 / 科目）。科目不明时先按文本分类，保证有归属。 */
  function matchText(f, subject, topic, body) {
    let s = ["数学", "408", "英语", "政治"].includes(subject) ? subject : null;
    if (!s) { const c = classify(`${topic || ""} ${body || ""}`); s = ["数学", "408", "英语", "政治"].includes(c) ? c : null; }
    return f.matcher.text(s, topic, body);
  }

  /** 回放一个考点的证据，得到 at 时刻的状态。 */
  // 广度：考点下有 size 个知识点。某道题只练到已经做对过的知识点、而这个考点还有没做对过的知识点时，加分减半，
  // 避免反复刷同一个小点就把整颗星点满。没有知识点信息的旧记录不受影响。
  const REPEAT_POINT = 0.5;
  function replay(list, at, points, size = 0) {
    const st = { m: 0, S: 0, last: null, n: 0, real: 0, top: 0, evidence: [], covered: new Set() };
    const rate = rateOf(points);
    const seen = new Map();
    for (const o of list) {
      if (o.at > at) break;
      const T = tierOf(o.d);
      const elapsed = st.last ? (o.at - st.last) / DAY : 0;
      const R = st.last ? Rf(elapsed, st.S) : 1;
      const cur = st.m * (st.last ? keep(R) : 1);
      let w = Math.max(0.005, Math.min(2, o.w)); // 按章 / 模块整体计时每个考点只分到一小份，下限不能高，否则摊开后总量被放大
      if (o.qid) {
        const prev = seen.get(o.qid);
        if (prev != null && (o.at - prev) / DAY < 3) w *= 0.3; // 刚做过的题还记得答案
        seen.set(o.qid, o.at);
      }
      const lower = T.d > 1 ? TIERS[T.d - 1].cap : 0;
      let breadth = 1;
      if (o.pts?.length && size && st.covered.size < size && o.pts.every((id) => st.covered.has(id))) breadth = REPEAT_POINT;
      const up = Math.min(1, rate * w) * o.q * Math.max(0, T.cap - cur) * breadth;
      const down = Math.min(1, RATE_DOWN * w) * (1 - o.q) * Math.max(0, cur - lower) * (o.soft ? 0.5 : 1);
      const m = clamp01(cur + up - down);
      if (o.q >= 0.6) {
        for (const id of o.pts || []) st.covered.add(id);
        if (!st.S) st.S = T.S0;
        else {
          const gain = elapsed >= 1 ? 1 + 2 * (1 - R) + 0.6 : 1.03;
          st.S = Math.max(T.S0 * 0.8, st.S * gain);
        }
        if (o.q >= 0.8 && o.kind !== "taught" && T.d > st.top) st.top = T.d;
      } else st.S = Math.max(3, (st.S || T.S0) * 0.5);
      st.evidence.push({ at: new Date(o.at).toISOString(), kind: o.kind, d: T.d, tier: T.name, q: r2(o.q), label: o.label, src: o.src, note: [o.note, breadth < 1 ? `这个知识点已做对过，本考点还有 ${size - st.covered.size} 个知识点没做对，加分减半` : ""].filter(Boolean).join("；"), delta: r2((m - cur) * points), decay: r2((st.m - cur) * points) });
      st.m = m;
      st.last = o.at;
      st.n++;
      if (o.kind === "real") st.real++;
    }
    return st;
  }

  /** 词汇：考研词表里的每个词按真题词频固定分四档；每档的掌握度＝这一档里每个词还记得的概率之和 / 这一档的词数。 */
  function vocabNow(target, at = Date.now()) {
    const mv = momo.vocabState(target, at);
    let base, learnedWords;
    if (mv.at) {
      base = mv;
      learnedWords = (momo.cache().words || []).filter((w) => w.last).map((w) => ({ s: w.s, R: retention(w, at), n: w.n }));
    } else {
      // 没接墨墨：用插件自己的生词本
      const words = store.list("vocab");
      learnedWords = words.filter((w) => w.card?.last && w.card.stability).map((w) => ({ s: w.word, n: w.card.reps || 1, R: Math.pow(1 + (19 / 81) * ((at - Date.parse(w.card.last)) / DAY) / w.card.stability, -0.5) }));
      base = { at: null, local: true, total: words.length, due: 0, strong: 0, weak: 0, error: mv.error || "" };
    }
    const vl = vocablist.freqOf(bank.all());
    const bands = Object.fromEntries(vocablist.BANDS.map((b) => [b.key, { key: b.key, name: b.name, desc: b.desc, size: vl.members[b.key].length, weight: b.weight, learned: 0, sumR: 0, list: [], seen: new Set() }]));
    for (const w of learnedWords) {
      const b = vocablist.base(w.s);
      if (!b) continue;
      const band = bands[vl.bandOf.get(b)];
      if (band.seen.has(b)) continue;
      band.seen.add(b);
      band.learned++; band.sumR += w.R;
      band.list.push({ s: b, R: Math.round(w.R * 100) / 100, n: w.n, f: vl.freq[b] || 0 });
    }
    // 初中基础词：背过的用实际记忆率，没背过的默认已掌握
    for (const b of Object.values(bands)) {
      b.basic = 0;
      for (const w of vl.members[b.key]) if (vocablist.BASIC.has(w) && !b.seen.has(w)) { b.basic++; b.sumR += vocablist.BASIC_R; b.seen.add(w); }
    }
    const totalW = Object.values(bands).reduce((a, b) => a + b.size * b.weight, 0) || 1;
    let mastery = 0, learned = 0, effective = 0;
    for (const b of Object.values(bands)) {
      b.share = (b.size * b.weight) / totalW; // 这一档占词汇分的比例
      b.m = b.size ? b.sumR / b.size : 0;
      mastery += b.share * b.m; learned += b.learned; effective += b.sumR;
      b.weakest = b.list.sort((x, y) => x.R - y.R).slice(0, 24);
      b.todo = vl.members[b.key].filter((w) => !b.seen.has(w)).slice(0, 24).map((s) => ({ s, f: vl.freq[s] || 0 }));
      delete b.seen; delete b.list;
    }
    return { ...base, target: vocablist.WORDS.length, learned, basic: Object.values(bands).reduce((a, b) => a + b.basic, 0), effective: Math.round(effective), mastery: Math.min(1, mastery), bands, freqFromBank: vl.fromBank, freqPapers: vl.papers };
  }

  const leafSize = (id) => (pointsByLeaf.get(id) || []).filter((p) => !p.name.includes("待核")).length;

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
              // 分值＝15 × 这一档的权重占比（固定）；得分＝分值 × 这一档的掌握度
              const vmax = mod.max;
              let pts = 0, m = 0, band = null;
              if (v.bands?.[l.band]) { band = v.bands[l.band]; pts = vmax * band.share; m = band.m; }
              else if (l.band === "core") { pts = vmax; m = v.mastery; } // 只有总掌握度时（历史曲线）全部算在第一颗
              const sc = pts * m;
              view = { id: l.id, name: l.name, band: l.band, points: r2(pts), score: r2(sc), m: r2(m), now: r2(m), R: r2(m), vocab: { ...v, bands: undefined }, size: band?.size || 0, learnedN: band?.learned || 0, desc: band?.desc || "", basicN: band?.basic || 0, words: band?.weakest || [], todo: band?.todo || [], due: false, n: band?.learned || 0 };
              varSum += (pts * 0.05) ** 2;
            } else {
              const st = replay(byLeaf.get(l.id) || [], at, l.points, leafSize(l.id));
              const R = st.last ? Rf((at - st.last) / DAY, st.S) : 0;
              const mNow = st.m * (st.last ? keep(R) : 0);
              const sc = l.points * mNow;
              const sigma = st.n ? 0.28 / Math.sqrt(st.n + st.real) : 0;
              varSum += (l.points * sigma * Math.max(0.3, mNow)) ** 2;
              view = { id: l.id, name: l.name, points: l.points, score: r2(sc), m: r2(st.m), now: r2(mNow), R: r2(R), S: r1(st.S), n: st.n, real: st.real, top: st.top, next: (TIERS.find((T) => T && T.cap > st.m + 0.03) || TIERS[5]).d, realCount: l.realCount || 0, last: st.last ? new Date(st.last).toISOString() : null };
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
    const val = Math.round(v.mastery * 1e4) / 1e4; // 4 位小数：一天背的词带来的变化在 2 位小数下常常看不出来
    if (h.vocab[d] === val) return;
    h.vocab[d] = val;
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
    // 词汇预测：按墨墨最近的新学速度，把还没背的词逐渐补上（按当前平均记忆率），掌握度按同样的比例往上走
    const vt = v.target || target;
    const remain = Math.max(0, vt - (v.learned || 0) - (v.basic || 0));
    const vocabProjM = Math.min(1, v.mastery + (remain ? Math.min(1, (newPerDay * daysLeft) / remain) : 0) * (1 - v.mastery) * (avgR || 0.9));
    const vocabIdleM = Math.min(1, v.mastery * 0.85);
    const projected = restProj + cur.vocabMax * Math.max(vocabProjM, v.mastery * 0.9);
    const idleTotal = idleRest + cur.vocabMax * vocabIdleM;
    const dataDays = Math.max(1, (now - first) / DAY);
    const spread = (6 + 0.2 * Math.abs(projected - cur.total)) * (1 + 1.5 * Math.max(0, 1 - dataDays / 30));
    const review = [];
    for (const sub of cur.subjects) for (const m of sub.modules) for (const c of m.chapters) for (const l of c.leaves) {
      if (l.due && !l.vocab && !l.band) review.push({ id: l.id, name: l.name, subject: sub.key, chapter: c.name, points: l.points, score: l.score, R: l.R, loss: l.loss || 0, last: l.last });
    }
    review.sort((a, b) => b.loss - a.loss);
    // 每天的学习量（热力图用，最近 26 周）：n＝做题 / 讲解 / 重做等证据条数，words＝墨墨里这天新学或复习的词，gain＝这天带来的加分
    const daily = {};
    const since = now - 182 * DAY;
    const day = (d) => (daily[d] ||= { n: 0, words: 0, gain: 0 });
    for (const o of obs) if (o.at >= since) day(today(new Date(o.at))).n++;
    for (const sub of cur.subjects) for (const m of sub.modules) for (const c of m.chapters) for (const l of c.leaves) for (const e of l.evidence || []) {
      if (e.delta > 0 && Date.parse(e.at) >= since) { const x = day(today(new Date(e.at))); x.gain = r2(x.gain + e.delta); }
    }
    // 墨墨只记每个词的首次学习日和最近一次复习日，所以更早的日子只能数到「新学 + 最近一次复习落在这天」的词
    for (const w of momo.cache().words || []) {
      const days = new Set([w.first, w.last].filter(Boolean).map((t) => Date.parse(t)).filter((t) => t >= since).map((t) => today(new Date(t))));
      for (const d of days) day(d).words++;
    }
    // 词汇分的变化（墨墨同步后每天一个快照），也算进「变化」和当天加分
    const changes = [];
    const vh = store.value("scoreHistory", { vocab: {} }).vocab;
    const vdays = Object.keys(vh).sort();
    for (let i = 1; i < vdays.length; i++) {
      const delta = r2((vh[vdays[i]] - vh[vdays[i - 1]]) * cur.vocabMax);
      if (!delta) continue;
      const at = vdays[i] === today() && cur.vocab.at ? cur.vocab.at : new Date(`${vdays[i]}T21:00:00`).toISOString();
      changes.push({ at, kind: "vocab", leafId: null, name: "英语词汇（墨墨）", subject: "英语", delta, label: `词汇掌握 ${Math.round(vh[vdays[i - 1]] * 1000) / 10}% → ${Math.round(vh[vdays[i]] * 1000) / 10}%`, src: "墨墨背单词" });
      if (delta > 0 && Date.parse(at) >= since) { const x = day(vdays[i]); x.gain = r2(x.gain + delta); }
    }
    const f = frame();
    return {
      ...cur,
      daily,
      changes,
      examDate, daysLeft: Math.ceil(daysLeft),
      projection: { value: r1(projected), low: r1(Math.max(idleTotal, projected - spread)), high: r1(Math.min(500, projected + spread)), slope: r2(slope), window: win, idle: r1(idleTotal), vocabPerDay: r1(newPerDay), dataDays: Math.round(dataDays) },
      history,
      review: review.slice(0, 20),
      reviewCount: review.length,
      frameInfo: { mapped: f.stats.mapped, total: f.stats.total, fineReal: [...f.qMap.values()].filter((q) => ["数学", "408"].includes(q.subject) && isReal(q) && f.knowledge.get(q.id)?.tested.length).length, aiCount: f.aiCount, aiAt: f.aiAt, vocabPts, diffCount: Object.keys(diffMap()).length, bankTotal: f.qMap.size },
      tiers: TIERS.slice(1).map((T) => ({ d: T.d, name: T.name, cap: T.cap, desc: T.desc })),
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
- 已经逐题记录过的题（记录里标着【已逐题记录…】或【讲题批改】的那些题）系统会单独计分，不要把它们算进来。只评估：讲解，以及没有逐题记录的练习。某个考点的题全都逐题记录过、又没有单独讲解，就不要列这个考点。
- level：这个考点上学习者独立做对的题里最难的一档（1 基础：直接套定义或公式；2 简单：常规变形两三步；3 中档：考研选择 / 填空常见难度；4 较难：真题解答题、综合两三个点；5 压轴）。只有讲解时写 1。
- note：一句话说明依据（例如「3 道检查题错 1 道，错在漏掉定义域」）。
输出 JSON：{"items":[{"code":"K12","kind":"practice","result":"基本会","n":3,"level":3,"note":"…"}],"summary":"一两句话总结这次学了什么、哪里还弱"}`,
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
      items.push({ leaf, kind, result, q: RESULT_Q[result], n: Math.max(0, Math.min(50, Math.round(Number(it.n) || 0))), level: kind === "practice" ? d15(it.level, 2) : 1, note: str(String(it.note || ""), 300) });
    }
    report?.(1, 2, "计算分数变化");
    const { impact } = measure(() => {
      const list = settlements().filter((x) => x.chatId !== chatId);
      list.push({ id: uid(), v: 2, chatId, at: new Date(at).toISOString(), settledAt: nowIso(), by, title: str(record.title || "", 200), subject, items, summary: str(String(res.summary || ""), 1000) });
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

  // ── AI 细归类：把数学一 / 408 的题目归到考纲知识点（knowledge.cjs） ──
  // 规则写在 CLASSIFY_RULES（给模型）和前端「归类规则」里（给人看），两处一起改。
  const CLASSIFY_BATCH = 20;
  const CLASSIFY_PARALLEL = 3;
  const CLASSIFY_RULES = `你在给考研题目标注考纲知识点。下面每道题给出出处、原标签、题干、选项和解析，最后附知识点编号表。
规则：
1. tested（直接考查）：题目的考查目标，不会这个知识点就做不出来或必然做错。methods（解题方法）：解题时用到、但不是这道题考查目标的知识点。
2. 按小问分别判断再合并；每题 tested 一般 1–3 个，最多 6 个；methods 最多 6 个；同一个知识点不要同时出现在两边。
3. 选最细、最贴切的条目：知识点已按考试大纲拆细（如「检错编码」与「纠错编码」、「滑动窗口机制」与「停止-等待协议」、「文件的打开」与「文件的读」分开），只选题目真正涉及的那一项，不要把同一考点下的细项全选上。
4. 「下列说法正确的是」这类逐项判断的选择题，每个选项考到的知识点都算 tested。
5. 以题干、选项和解析为准，原标签只作参考；习题的出处（书名·章名）可以帮助判断范围，但不能代替看题。
6. 名称带「待核」的条目只在题目明确考查时才选。408 区分组成原理（硬件实现）和操作系统（管理策略），只有题目确实跨科时才跨科选。
7. 实在找不到对应知识点（超纲、纯计算练习、题目残缺）时 tested 给空数组。
输出 JSON：{"items":[{"i":题号序号,"tested":["P1"],"methods":["P2"]}]}，每道题都要有一项。`;
  const classifyModel = () => { const m = getSettings().classifyModel; return m?.provider && m?.id ? { provider: m.provider, id: m.id } : null; };
  const catalogCache = new Map();
  function catalogOf(subject) {
    if (catalogCache.has(subject)) return catalogCache.get(subject);
    const list = points.filter((point) => point.subject === subject);
    const codes = new Map(list.map((point, index) => [`P${index + 1}`, point.id]));
    const text = [...codes].map(([code, id]) => `${code} ${byId.get(id).leaf.split("/").slice(2).join("·")} / ${byId.get(id).name}`).join("\n");
    const out = { codes, text };
    catalogCache.set(subject, out);
    return out;
  }
  /** 每 20 题一次调用、同时 3 批；每批归完立即保存。某一批失败（多半是开着思考的模型输出被截断）就对半拆开重归，
   *  拆到 2 题还失败才记为失败（留着下次再归）。 */
  async function classifyList(todo, { report, signal } = {}) {
    const batches = [];
    for (const subject of ["数学", "408"]) {
      const list = todo.filter((q) => q.subject === subject);
      for (let i = 0; i < list.length; i += CLASSIFY_BATCH) batches.push({ subject, qs: list.slice(i, i + CLASSIFY_BATCH) });
    }
    const model = classifyModel();
    const stat = { done: 0, ok: 0, empty: 0, failed: 0, error: "" };
    let next = 0;
    let fatal = null; // 模型不可用、没配置等：拆批也没用，整个任务停下
    const splittable = (err) => err?.truncated || /JSON|解析|截断/.test(String(err?.message || err));
    const worker = async () => {
      while (next < batches.length && !signal?.aborted && !fatal) {
        const { subject, qs } = batches[next++];
        const { codes, text } = catalogOf(subject);
        try {
          const res = await llm.json({
            system: `${CLASSIFY_RULES}\n\n知识点编号表（编号 章·考点 / 知识点）：\n${text}`,
            text: qs.map((q, j) => `#${j} ${q.source === "习题" ? `习题·${q.book || ""}·` : ""}${q.paper || ""} 第${q.number}题（${q.type}） 原标签：${(q.topics || []).join("、") || "无"}\n${String(q.stem || "").slice(0, 2200)}${q.options?.length ? `\n选项：${q.options.map((o) => `${o.key}. ${o.text}`).join("；").slice(0, 800)}` : ""}${q.analysis ? `\n解析：${String(q.analysis).slice(0, 1200)}` : ""}`).join("\n\n"),
            maxTokens: 32000, // 开着思考的模型，思考也算在上限里（deepseek flash 20 题常用到 12k 以上）
            slot: "cheap",
            model,
            signal,
            splitOnTruncate: true,
          });
          const decode = (ids) => validPointIds(Array.isArray(ids) ? ids.map((code) => codes.get(String(code).trim().toUpperCase())) : [], subject).slice(0, 6);
          // 重读再写：后台归类和手动归类可能同时在写
          const cur = store.value("scoreMap", { map: {}, at: null });
          const pointMap = { ...(cur.points || {}) };
          const at = nowIso();
          for (const item of Array.isArray(res?.items) ? res.items : []) {
            const q = qs[Number(item.i)];
            if (!q) continue;
            const tested = decode(item.tested);
            if (tested.length) { pointMap[q.id] = { tested, methods: decode(item.methods).filter((id) => !tested.includes(id)), at }; stat.ok++; }
            else { pointMap[q.id] = { tested: [], methods: [], empty: true, at }; stat.empty++; }
          }
          store.saveValue("scoreMap", { ...cur, points: pointMap, at, partial: true });
          frameCache = null;
        } catch (err) {
          if (signal?.aborted) break;
          if (!splittable(err)) { fatal = err; break; }
          if (qs.length > 2) {
            const half = Math.ceil(qs.length / 2);
            batches.push({ subject, qs: qs.slice(0, half) }, { subject, qs: qs.slice(half) });
            continue;
          }
          stat.failed += qs.length;
          stat.error = err?.message || String(err);
        }
        stat.done += qs.length;
        report?.(stat.done, todo.length, `已归 ${stat.done} / ${todo.length}${stat.failed ? ` · 失败 ${stat.failed}` : ""}`);
      }
    };
    report?.(0, todo.length, `准备归类 ${todo.length} 道`);
    await Promise.all(Array.from({ length: Math.min(CLASSIFY_PARALLEL, batches.length) }, worker));
    if (signal?.aborted) fail("已暂停");
    if (fatal) fail(`归类停止：${fatal.message || fatal}（已归 ${stat.ok + stat.empty} 道已保存）`);
    return stat;
  }

  /** 每类题还有多少道没归（已人工核对、AI 归过、AI 判断无可归的都算归过）。 */
  function classifyStatus() {
    const f = frame();
    const out = { 真题: { pending: 0, done: 0 }, 习题: { pending: 0, done: 0 } };
    for (const q of f.qMap.values()) {
      if (!["数学", "408"].includes(q.subject) || q.source === "AI生成") continue;
      const k = q.source === "习题" ? "习题" : "真题";
      if (f.knowledge.get(q.id)?.status === "待核对") out[k].pending++; else out[k].done++;
    }
    return out;
  }

  let manualClassify = false;
  /** 手动归类：先真题（新年份在前）后习题，只归还没归过的。 */
  async function classifyBank({ progress: report, signal }) {
    const known = frame().knowledge;
    const pending = bank.all().filter((q) => ["数学", "408"].includes(q.subject) && q.source !== "AI生成" && known.get(q.id)?.status === "待核对");
    const real = pending.filter((q) => q.source !== "习题").sort((a, b) => (b.year || 0) - (a.year || 0));
    const todo = [...real, ...pending.filter((q) => q.source === "习题")];
    manualClassify = true;
    try {
      const r = await classifyList(todo, { report, signal });
      frameCache = null;
      return { ...r, total: todo.length };
    } finally { manualClassify = false; }
  }

  // 新导入的题（习题书等）导完一份就在后台归一次考点，做题加分才会加到对的星上
  const clsQueue = new Set();
  let clsTimer = null, classifying = false;
  function queueClassify(ids) {
    const knowledge = frame().knowledge;
    for (const id of ids || []) if (id && knowledge.get(id)?.status === "待核对") clsQueue.add(id);
    if (!clsQueue.size || clsTimer || classifying) return;
    clsTimer = setTimeout(runClassify, 3000);
  }
  async function runClassify() {
    clsTimer = null;
    if (classifying || !clsQueue.size) return;
    if (manualClassify) { clsTimer = setTimeout(runClassify, 60000); return; } // 手动归类在跑，等它结束
    classifying = true;
    const byId = new Map(bank.all().map((q) => [q.id, q]));
    const list = [...clsQueue].map((id) => byId.get(id)).filter((q) => q && ["数学", "408"].includes(q.subject));
    clsQueue.clear();
    try {
      await classifyList(list, { signal: ctx.signal });
      const cur = store.value("scoreMap", { map: {}, at: null });
      store.saveValue("scoreMap", { ...cur, at: nowIso() }); // 改时间戳，让考点框架重建
      frameCache = null;
      onChange();
    } catch (err) { console.warn(`[kaoyan] 后台归类考点失败：${err?.message || err}`); }
    finally { classifying = false; if (clsQueue.size) clsTimer = setTimeout(runClassify, 3000); }
  }

  // ── AI 评定题库题目难度（一次性，可续跑；以后导入的新题点一下补评） ──
  const TIER_RUBRIC = TIERS.slice(1).map((T) => `${T.d} ${T.name}：${T.desc}`).join("\n");
  /** 给一批题评难度，每 30 道一次调用，评完一批就存一批（中途停下不丢）。 */
  async function rateList(todo, { report, signal } = {}) {
    const total = todo.length;
    let done = 0;
    // 每批 30 题；失败（多半是输出被截断）就对半拆开重评，拆到 2 题还失败就跳过，下次再评
    const queue = [];
    for (let i = 0; i < todo.length; i += 30) queue.push(todo.slice(i, i + 30));
    while (queue.length) {
      if (signal?.aborted) fail("已取消");
      const batch = queue.shift();
      report?.(done, total, `评定难度 ${done + 1}–${done + batch.length} / ${total}`);
      let res;
      try {
        res = await llm.json({
        system: `你是考研命题老师。按考研考生的视角给每道题评难度档（1–5）：
${TIER_RUBRIC}
参考：同一份真题卷里越靠后的解答题通常越难；选择 / 填空多数是 2–3，个别陷阱多或计算量大的到 4；解答题多数 3–4，压轴小问 5；英语阅读按推理深度和干扰项强度判断。输出 JSON：{"items":[{"i":题目序号,"d":难度}]}`,
        text: batch.map((q, j) => `#${j} ${q.subject} ${q.paper || q.source || ""} 第${q.number}题（${q.type}${q.part ? `·${q.part}` : ""}，${q.score || "?"}分）考点：${(q.topics || []).join("、") || "无"}\n${String(q.stem || "").replace(/\s+/g, " ").slice(0, 350)}${q.options?.length ? `\n选项：${q.options.map((o) => `${o.key}. ${String(o.text).slice(0, 60)}`).join("  ")}` : ""}`).join("\n\n"),
        maxTokens: 32000,
        slot: "cheap",
        signal,
        splitOnTruncate: true,
      });
      } catch (err) {
        if (signal?.aborted) fail("已取消");
        if (!(err?.truncated || /JSON|解析|截断/.test(String(err?.message || err)))) throw err;
        if (batch.length > 2) { const half = Math.ceil(batch.length / 2); queue.unshift(batch.slice(0, half), batch.slice(half)); continue; }
        console.warn(`[kaoyan] 难度评定跳过 ${batch.length} 题：${err?.message || err}`);
        done += batch.length;
        continue;
      }
      // 重新读一次再写：后台评定和按钮评定可能同时在跑
      const cur = store.value("difficulty", { map: {}, at: null });
      const map = { ...(cur.map || {}) };
      for (const it of res.items || []) {
        const q = batch[Number(it.i)];
        const d = Math.round(Number(it.d));
        if (q && d >= 1 && d <= 5) map[q.id] = d;
      }
      store.saveValue("difficulty", { ...cur, map });
      done += batch.length;
    }
  }
  async function rateBank({ progress: report, signal, force = false }) {
    if (force) store.saveValue("difficulty", { map: {}, at: null });
    const map = diffMap();
    const todo = bank.all().filter((q) => ["数学", "408", "英语", "政治"].includes(q.subject) && !map[q.id]);
    await rateList(todo, { report, signal });
    const cur = store.value("difficulty", { map: {}, at: null });
    store.saveValue("difficulty", { ...cur, at: nowIso() });
    return { rated: Object.keys(cur.map || {}).length, total: bank.all().length };
  }

  // 做到还没评过的题时，在后台顺手评（不用先把整个题库评一遍）。分数每次都从原始记录重算，所以晚评的题，以前的加分也会跟着更新。
  const rateQueue = new Set();
  let rateTimer = null, rating = false;
  function queueRate(ids) {
    const map = diffMap();
    for (const id of ids || []) if (id && !map[id]) rateQueue.add(id);
    if (!rateQueue.size || rateTimer || rating) return;
    rateTimer = setTimeout(runQueue, 3000);
  }
  async function runQueue() {
    rateTimer = null;
    if (rating || !rateQueue.size) return;
    rating = true;
    const byId = new Map(bank.all().map((q) => [q.id, q]));
    const list = [...rateQueue].map((id) => byId.get(id)).filter(Boolean);
    rateQueue.clear();
    try { await rateList(list, { signal: ctx.signal }); onChange(); }
    catch (err) { console.warn(`[kaoyan] 后台评定难度失败：${err?.message || err}`); }
    finally { rating = false; if (rateQueue.size) rateTimer = setTimeout(runQueue, 3000); }
  }

  /** 会话里逐题记录（不是题库原题的题）。result：独立做对 / 提示后做对 / 部分对。 */
  const RECORD_Q = { 独立做对: 1, 提示后做对: 0.6, 部分对: 0.5, 做错: 0 }; // 做错只由英语题（不进错题本）写入
  function recordQuestion({ subject, topic, question, difficulty, result, note, chatId, src, pointIds }) {
    const f = frame();
    pointIds = validPointIds(pointIds, subject);
    const hits = pointIds.length ? weights(pointIds) : matchText(f, subject, topic, question);
    const entry = { id: uid(), at: nowIso(), chatId: chatId || null, subject: subject || "", topic: str(topic, 200), question: str(question, 600), difficulty: d15(difficulty), result: RECORD_Q[result] != null ? result : "独立做对", q: RECORD_Q[result] ?? 1, note: str(note || "", 300), src: src || "会话", pointIds };
    const list = store.list("qlog");
    list.push(entry);
    store.saveList("qlog", list);
    coverage?.record({ subject, pointIds, status: result === "部分对" ? "部分做对" : result, chatId, question });
    const pooled = hits[0]?.level && hits[0].level !== "leaf";
    return { entry, leaves: pooled ? [`${hits[0].pool}（没对上具体考点，按${{ chapter: "章", module: "模块", subject: "科目" }[hits[0].level]}整体计）`] : hits.map((h) => f.leaves.get(h.id)?.name).filter(Boolean) };
  }

  /** 一个考点对应的题库真题（用来「用真题练这个考点」）。 */
  function questionsOf(leafId, limit = 10) {
    const f = frame();
    const { map } = progress.events();
    const hits = [];
    for (const q of f.qMap.values()) {
      if (q.source === "AI生成" || q.source === "习题") continue;
      const m = f.mapQ(q).find((h) => h.id === leafId);
      if (!m) continue;
      const ev = map.get(q.id) || [];
      const last = ev[ev.length - 1];
      hits.push({ id: q.id, paper: q.paper, number: q.number, type: q.type, score: q.score, year: q.year || 0, w: m.w, d: qDiff(q), done: ev.length, lastCorrect: last ? last.correct : null });
    }
    // 没做过的、近年的、主考点的优先
    hits.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.w - a.w || b.year - a.year);
    return { total: hits.length, done: hits.filter((h) => h.done).length, items: hits.slice(0, limit) };
  }

  // ── 考点频率表（给出题智能体规划用）──────────────────
  const RECENT_YEARS = 15;
  const isReal = (q) => q.source !== "AI生成" && q.source !== "习题";
  let statCache = null;
  /** 每个考点：真题题数（按归类权重计）、近 15 年题数 / 分值 / 题型、近年真题。 */
  function leafStats() {
    const f = frame();
    if (statCache?.sig === f.sig) return statCache.map;
    const from = new Date().getFullYear() - RECENT_YEARS;
    const map = new Map();
    for (const q of f.qMap.values()) {
      if (!isReal(q) || !["数学", "408"].includes(q.subject)) continue;
      for (const h of f.mapQ(q)) {
        if (!map.has(h.id)) map.set(h.id, { all: 0, recent: 0, pts: 0, types: {}, qs: [], lastYear: 0 });
        const st = map.get(h.id);
        st.all += h.w;
        const y = Number(q.year) || 0;
        if (y > st.lastYear) st.lastYear = y;
        if (y >= from) {
          st.recent += h.w;
          st.pts += (Number(q.score) || 0) * h.w;
          st.types[q.type] = (st.types[q.type] || 0) + h.w;
          if (h.w >= 0.34) st.qs.push(q);
        }
      }
    }
    for (const st of map.values()) st.qs.sort((a, b) => (b.year || 0) - (a.year || 0));
    statCache = { sig: f.sig, map };
    return map;
  }

  /** 按章节 / 考点查频率表。query 先对章节、考点名和关键词打分，取最相关的 1–2 章，列出章内全部考点。 */
  function focus({ query, subject } = {}) {
    const f = frame();
    const raw = String(query || "").toLowerCase().split(/[\s,，、;；/]+/).filter(Boolean);
    const terms = new Set(raw);
    for (const t of raw) if (/^[一-龥]{3,}$/.test(t)) for (let i = 0; i < t.length - 1; i++) terms.add(t.slice(i, i + 2));
    const exactLeaves = new Set((subject ? [subject] : ["数学", "408"]).flatMap((s) => exactPoints(s, [query, ...raw]).map((point) => point.leaf)));
    const chapters = new Map();
    for (const l of f.leaves.values()) {
      if (subject && l.subject !== subject) continue;
      const key = `${l.subject}/${l.module}/${l.chapter}`;
      let s = exactLeaves.has(l.id) ? 45 : 0;
      for (const t of terms) {
        const w = t.length;
        if (l.chapter.toLowerCase().includes(t)) s += 3 * w;
        if (l.name.toLowerCase().includes(t)) s += 4 * w;
        if ((l.kw || []).some((k) => k.toLowerCase().includes(t) || (k.length >= 2 && t.includes(k.toLowerCase())))) s += 2 * w;
        if (l.module.toLowerCase().includes(t)) s += 0.5 * w;
      }
      const c = chapters.get(key) || { key, subject: l.subject, module: l.module, chapter: l.chapter, score: 0 };
      c.score += s; // 章内命中的考点越多越相关（「极限」主要指 函数、极限、连续，而不是 中心极限定理）
      chapters.set(key, c);
    }
    let picked = [...chapters.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
    if (picked.length) picked = picked.filter((c) => c.score >= picked[0].score * 0.6).slice(0, 2);
    else {
      const hits = f.matcher.text(subject || null, query, query).filter((h) => h.level === "leaf" || h.level === "chapter"); // 模块 / 科目级兜底对「查章节」没意义
      const keys = [...new Set(hits.map((h) => { const l = f.leaves.get(h.id); return l && `${l.subject}/${l.module}/${l.chapter}`; }).filter(Boolean))];
      picked = keys.slice(0, 2).map((k) => chapters.get(k)).filter(Boolean);
    }
    if (!picked.length) return { text: `没找到和「${query}」对应的考纲章节。换成章节名或考点名再查（如「函数 极限 连续」「一元函数微分学」「栈和队列」）；太细的点（如某个具体技巧）不在考纲考点表里，用 kaoyan_bank_search 搜它，看近 15 年命中几道。`, leaves: [] };

    const ev = evaluate(Date.now(), { detail: false });
    const view = new Map();
    for (const s of ev.subjects) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) view.set(l.id, l);
    const stats = leafStats();
    const subjects = new Set(picked.map((c) => c.subject));
    const recent = [...f.qMap.values()].filter((q) => isReal(q) && subjects.has(q.subject) && q.year >= new Date().getFullYear() - RECENT_YEARS);
    const pending = recent.filter((q) => f.knowledge.get(q.id)?.status === "待核对").length;
    const done = progress.events().map;
    const doneTag = (q) => { const ev = done.get(q.id) || []; const last = ev[ev.length - 1]; return ev.length ? `做过·上次${last.correct === true ? "对" : last.correct === false ? "错" : "未判"}` : "没做过"; };
    const pct = (x) => `${Math.round((x || 0) * 100)}%`;
    const out = [`考点频率表（「${query}」；自 ${new Date().getFullYear() - RECENT_YEARS} 年起；题数按归类权重估计）`, `涉及科目有 ${pending}/${recent.length} 道近期真题尚待细归类；低频与零命中仍要核对覆盖清单。`];
    const leaves = [];
    for (const c of picked) {
      const rows = [...f.leaves.values()].filter((l) => l.subject === c.subject && l.module === c.module && l.chapter === c.chapter).map((l) => {
        const st = stats.get(l.id) || { all: 0, recent: 0, pts: 0, types: {}, qs: [], lastYear: 0 };
        const v = view.get(l.id) || {};
        const m = v.now || 0;
        return { id: l.id, name: l.name, points: l.points || 0, m, n: v.n || 0, due: !!v.due, top: v.top || 0, next: v.next || 1, st, priority: (l.points || 0) * (1 - m) };
      }).sort((a, b) => b.priority - a.priority);
      out.push("", `## ${c.subject === "数学" ? "数学一" : c.subject} · ${c.module} · ${c.chapter}`);
      out.push("考点｜近15年题数｜近15年分值｜常见题型｜预测分里的分值｜你的掌握｜做对过的最难档｜要继续涨需要的难度｜优先级");
      for (const r of rows) {
        const types = Object.entries(r.st.types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}${Math.round(n * 10) / 10}`).join(" ") || "—";
        const rare = r.st.recent < 1.5 ? (r.st.recent < 0.5 ? "（当前频率表未命中）" : "（少考）") : "";
        out.push(`- ${r.name}${rare}｜${r.st.recent.toFixed(1)}｜${Math.round(r.st.pts)}｜${types}｜${r.points.toFixed(1)}｜${r.n ? pct(r.m) : "没有记录"}${r.due ? "·该复习" : ""}｜${r.top ? `${r.top} ${TIERS[r.top].name}` : "—"}｜${r.next} ${TIERS[r.next].name}及以上｜${r.priority.toFixed(1)}`);
        for (const q of r.st.qs.slice(0, 3)) out.push(`    · id=${q.id} ${q.paper || q.year || ""} 第${q.number}题（${q.type}·难度${qDiff(q)}·${doneTag(q)}）${String(q.stem || "").replace(/\s+/g, " ").slice(0, 90)}`);
        leaves.push(r);
      }
    }
    out.push("", `难度档：${TIERS.slice(1).map((T) => `${T.d} ${T.name}（掌握度上限 ${Math.round(T.cap * 100)}%）`).join("、")}。掌握度已经超过某档上限，再做这一档的题几乎不加分，出题要用「要继续涨需要的难度」及以上的题。`);
    out.push("", "用法：复习会话按优先级（分值 ×（1 − 掌握））从高到低排节点；重点复习优先高频，按考纲查漏时也保留低频必考范围。上面列的真题可以直接用 kaoyan_bank_get 取来当原型。");
    return { text: out.join("\n"), leaves, pending, coverage: coverageList(leaves.map((l) => l.id)) };
  }

  // ── 考纲知识点覆盖：会话记录 + 快练 / 模考 / 题库作答 / 错题重做 合并 ──
  const covStatus = (qv, hinted) => (qv >= 1 ? (hinted ? "提示后做对" : "独立做对") : qv > 0 ? "部分做对" : "答错待复测");
  const qualityOf = (e) => (e.score != null && e.max ? Math.max(0, Math.min(1, e.score / e.max)) : e.correct === true ? 1 : e.correct === false ? 0 : null);
  function coverageEvents() {
    const f = frame();
    const out = [];
    for (const [qid, evs] of progress.events().map) {
      const q = f.qMap.get(qid);
      if (!q || !["数学", "408"].includes(q.subject)) continue;
      const tested = f.knowledge.get(qid)?.tested || [];
      for (const e of evs) {
        const qv = qualityOf(e);
        if (qv == null || !e.at) continue;
        const ids = validPointIds(e.pointIds, q.subject);
        for (const pointId of ids.length ? ids : tested) out.push({ pointId, status: covStatus(qv, e.hinted), at: e.at, question: `${q.paper || "题库"} 第${q.number}题` });
      }
    }
    for (const m of store.list("mistakes")) {
      if (m.bankId) continue;
      for (const pointId of validPointIds(m.pointIds, m.subject)) {
        if (m.createdAt) out.push({ pointId, status: "答错待复测", at: m.createdAt, question: m.question });
        for (const h of m.history || []) if ((h.correct === true || h.correct === false) && h.at) out.push({ pointId, status: h.correct ? "独立做对" : "答错待复测", at: h.at, question: `${m.topic}（重做）` });
      }
    }
    return out;
  }
  /** 每个知识点近 15 年被真题直接考查的题数（只算已细归类 / 已核对的题）。 */
  let freqCache = null;
  function pointFreq() {
    const f = frame();
    if (freqCache?.f === f) return freqCache.map;
    const map = new Map();
    const from = new Date().getFullYear() - RECENT_YEARS;
    for (const q of f.qMap.values()) {
      if (!isReal(q) || !(q.year >= from)) continue;
      for (const id of f.knowledge.get(q.id)?.tested || []) map.set(id, (map.get(id) || 0) + 1);
    }
    freqCache = { f, map };
    return map;
  }
  function coverageList(leafIds) {
    if (!coverage) return [];
    const freq = pointFreq();
    return coverage.list(leafIds, coverageEvents()).map((r) => ({
      ...r,
      recent: freq.get(r.id) || 0,
      outline: (itemsOfPoint.get(r.id) || []).map((i) => i.item),
      extension: !itemsOfPoint.has(r.id),
      pending: r.name.includes("待核"),
    }));
  }

  /** 关键词和 AI 都还没归上考点的数学 / 408 题（交给后台 AI 归类；归上之前计分时按章 / 模块 / 科目兜底）。 */
  function unmappedIds() {
    const f = frame();
    return [...f.qMap.values()].filter((q) => ["数学", "408"].includes(q.subject) && !f.mapQ(q).length).map((q) => q.id);
  }
  return { frame, invalidateFrame: () => { frameCache = null; statCache = null; }, overview, evaluate, measure, diff, settle, unsettled, classifyBank, questionsOf, collect, focus, rateBank, queueRate, queueClassify, classifyStatus, recordQuestion, unmappedIds, coverageList, pointFreq, TIERS, qDiff };
}

module.exports = { createScore };
