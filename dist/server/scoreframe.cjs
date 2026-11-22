"use strict";
// 分数判断机的框架：科目 → 模块 → 章节 → 考点，每个考点值多少分。
// 模块分值按考试大纲（数学一 高数约 60%、线代约 20%、概率约 20%；408 数据结构 45、组成原理 45、操作系统 35、计网 25；
// 英语一按题型；政治按 2026 大纲各课程比例），模块内各考点的分值按题库历年真题实际考到的分数统计（近年权重更高）。
const { SYLLABUS } = require("./syllabus.cjs");

const MODULE_MAX = {
  数学: { 高等数学: 90, 线性代数: 30, 概率论与数理统计: 30 },
  408: { 数据结构: 45, 计算机组成原理: 45, 操作系统: 35, 计算机网络: 25 },
};

// 英语一：在阅读、完形、翻译、新题型里划出 15 分作为「词汇」（单词量决定这几部分的上限），总分仍是 100。
const ENGLISH = {
  key: "英语", name: "英语一", max: 100, modules: [
    // 词汇：考研词表里的词按历年真题出现次数固定分四档（见 vocablist.cjs），越高频分值越高，四档合计 15 分
    { name: "词汇", max: 15, chapters: [{ name: "词汇量", leaves: [
      { name: "核心高频词", kind: "vocab", band: "core" },
      { name: "常考词", kind: "vocab", band: "common" },
      { name: "偶见词", kind: "vocab", band: "rare" },
      { name: "大纲其余词", kind: "vocab", band: "other" },
    ] }] },
    { name: "完形填空", max: 7, chapters: [{ name: "完形填空", leaves: [
      { name: "词义辨析", match: { part: "完形", topic: "词义辨析" }, share: 225 },
      { name: "固定搭配", match: { part: "完形", topic: "固定搭配" }, share: 134 },
      { name: "逻辑关系", match: { part: "完形", topic: "逻辑关系" }, share: 77 },
    ] }] },
    { name: "阅读理解", max: 32, chapters: [{ name: "阅读理解 A 节", leaves: [
      { name: "细节题", match: { read: true, topic: "细节题" }, share: 93 },
      { name: "推理题", match: { read: true, topic: "推理题|段落作用题" }, share: 56 },
      { name: "例证题", match: { read: true, topic: "例证题" }, share: 22 },
      { name: "主旨题", match: { read: true, topic: "主旨题" }, share: 19 },
      { name: "词义句意题", match: { read: true, topic: "词义题|语法结构" }, share: 19 },
      { name: "态度题", match: { read: true, topic: "态度题" }, share: 15 },
    ] }] },
    // 只有一种题型的部分按能力拆开，同一道题的得分平均记到这几颗星上
    { name: "新题型", max: 8, chapters: [{ name: "阅读理解 B 节", leaves: [
      { name: "篇章结构", match: { part: "新题型" }, share: 1 },
      { name: "逻辑衔接", match: { part: "新题型" }, share: 1 },
      { name: "语义复现", match: { part: "新题型" }, share: 1 },
    ] }] },
    { name: "翻译", max: 8, chapters: [{ name: "英译汉", leaves: [
      { name: "长难句拆分", match: { part: "翻译" }, share: 1.2 },
      { name: "词义与搭配", match: { part: "翻译" }, share: 1 },
      { name: "中文表达", match: { part: "翻译" }, share: 0.8 },
    ] }] },
    { name: "写作", max: 30, chapters: [{ name: "写作", leaves: [
      { name: "小作文·格式与语气", match: { part: "小作文" }, share: 4 },
      { name: "小作文·要点覆盖", match: { part: "小作文" }, share: 6 },
      { name: "大作文·图画描述", match: { part: "大作文" }, share: 5 },
      { name: "大作文·论证展开", match: { part: "大作文" }, share: 8 },
      { name: "大作文·语言表达", match: { part: "大作文" }, share: 7 },
    ] }] },
  ],
};

const P = (name, kw, share = 1) => ({ name, kw: kw.split(" "), share });
const POLITICS = {
  key: "政治", name: "政治", max: 100, modules: [
    { name: "马克思主义基本原理", max: 24, chapters: [
      { name: "马克思主义哲学", leaves: [
        P("世界的物质性及发展规律", "物质 意识 唯物论 辩证法 对立统一 质量互变 否定之否定 联系 发展 矛盾", 2),
        P("实践与认识及其发展规律", "实践 认识 真理 价值 认识论", 1.5),
        P("人类社会及其发展规律", "唯物史观 社会存在 社会意识 生产力 生产关系 经济基础 上层建筑 人民群众", 1.5),
      ] },
      { name: "政治经济学与科学社会主义", leaves: [
        P("资本主义的本质及规律", "商品 价值规律 剩余价值 资本积累 资本循环 资本周转 劳动价值论", 1.5),
        P("资本主义的发展及其趋势", "垄断 垄断资本主义 国家垄断 经济全球化", 1),
        P("社会主义与共产主义", "科学社会主义 社会主义 共产主义", 0.8),
      ] },
    ] },
    { name: "毛泽东思想和中国特色社会主义理论体系概论", max: 14, chapters: [
      { name: "毛泽东思想", leaves: [
        P("毛泽东思想及其历史地位", "毛泽东思想 实事求是 群众路线 独立自主", 1),
        P("新民主主义革命理论", "新民主主义革命 总路线 农村包围城市 三大法宝", 1.5),
        P("社会主义改造理论", "社会主义改造 过渡时期总路线 和平赎买", 1),
        P("社会主义建设道路初步探索", "论十大关系 正确处理人民内部矛盾", 0.8),
      ] },
      { name: "中国特色社会主义理论体系", leaves: [
        P("邓小平理论", "邓小平理论 社会主义本质 初级阶段 改革开放 一国两制", 1.2),
        P("“三个代表”重要思想", "三个代表", 0.7),
        P("科学发展观", "科学发展观 以人为本 全面协调可持续", 0.7),
      ] },
    ] },
    { name: "习近平新时代中国特色社会主义思想概论", max: 16, chapters: [
      { name: "总论与总任务", leaves: [
        P("新时代坚持和发展中国特色社会主义", "新时代 习近平新时代中国特色社会主义思想 主要矛盾 两个确立", 1.2),
        P("中国式现代化与中华民族伟大复兴", "中国式现代化 民族复兴 中国梦", 1),
      ] },
      { name: "五位一体与四个全面", leaves: [
        P("经济建设与新发展理念", "新发展理念 新发展格局 高质量发展 新质生产力 供给侧", 1.3),
        P("民主政治与全面依法治国", "全过程人民民主 依法治国 法治", 1),
        P("文化、社会与生态文明", "文化自信 民生 生态文明 绿水青山", 1),
        P("国家安全、国防与“一国两制”", "总体国家安全观 国防 强军 一国两制 祖国统一", 0.8),
        P("外交与人类命运共同体", "人类命运共同体 一带一路 大国外交", 0.8),
        P("全面从严治党", "从严治党 党的建设 自我革命", 0.9),
      ] },
    ] },
    { name: "中国近现代史纲要", max: 14, chapters: [
      { name: "近现代史", leaves: [
        P("旧民主主义革命时期（1840–1919）", "鸦片战争 洋务运动 戊戌维新 辛亥革命 太平天国", 1.2),
        P("新民主主义革命时期（1919–1949）", "五四运动 中国共产党成立 国民革命 土地革命 抗日战争 解放战争", 1.6),
        P("社会主义革命和建设时期", "新中国成立 社会主义改造 社会主义建设 过渡时期", 1),
        P("改革开放与新时代", "改革开放 新时代 十一届三中全会", 1),
      ] },
    ] },
    { name: "思想道德与法治", max: 16, chapters: [
      { name: "思想与道德", leaves: [
        P("人生观与理想信念", "人生观 人生价值 理想信念", 1),
        P("中国精神与核心价值观", "中国精神 爱国主义 改革创新 社会主义核心价值观", 1),
        P("社会主义道德", "道德 公民道德 职业道德 家庭美德 个人品德", 1),
      ] },
      { name: "法治", leaves: [
        P("宪法", "宪法 国家制度 基本权利", 0.5),
        P("法律体系与法治思维", "法治 法律体系 法治思维 依法治国 法治体系", 0.5),
        P("法律权利与法律义务", "法律权利 法律义务 民法 刑法", 0.4),
      ] },
    ] },
    { name: "形势与政策及当代世界经济与政治", max: 16, chapters: [
      { name: "时政", leaves: [
        P("国内时政", "时政 会议 全会 政府工作报告", 1.2),
        P("国际形势与当代世界", "国际 世界经济 世界政治 全球治理", 1),
      ] },
    ] },
  ],
};

/** 当前框架：[{key,name,max,modules:[{name,max,chapters:[{name,leaves:[{id,name,kw?,match?,kind?,share?}]}]}]}]（考点分值另算）。 */
function baseFrame() {
  const out = [];
  for (const s of SYLLABUS) {
    const subject = { key: s.subject, name: s.name, max: 150, modules: [] };
    for (const mod of s.children) {
      subject.modules.push({
        name: mod.name, max: MODULE_MAX[s.subject][mod.name],
        chapters: mod.children.map((ch) => ({
          name: ch.name,
          leaves: ch.children.map((l) => ({ id: `${s.subject}/${mod.name}/${ch.name}/${l.name}`, name: l.name, kw: l.kw })),
        })),
      });
    }
    out.push(subject);
  }
  for (const s of [ENGLISH, POLITICS]) {
    out.push({
      ...s,
      modules: s.modules.map((mod) => ({
        ...mod,
        chapters: mod.chapters.map((ch) => ({ ...ch, leaves: ch.leaves.map((l) => ({ ...l, id: `${s.key}/${mod.name}/${ch.name}/${l.name}` })) })),
      })),
    });
  }
  return out;
}

// ── 真题 → 考点 ───────────────────────────────────────────
const READ_PARTS = new Set(["Text1", "Text2", "Text3", "Text4"]);

/** 关键词匹配：返回 [{id, w}]（w 合计 1）；对不上返回 []。 */
function keywordMatcher(frame, corpus = []) {
  const bySubject = new Map();
  // 关键词区分度：在题库考点标签里出现得越普遍（如「函数」「微分方程」），权重越低
  const idf = new Map();
  if (corpus.length) {
    const texts = corpus.map((q) => (q.topics || []).join(" "));
    const cache = new Map();
    const df = (k) => { if (!cache.has(k)) cache.set(k, texts.reduce((n, t) => n + (t.includes(k) ? 1 : 0), 0)); return cache.get(k); };
    for (const s of frame) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) for (const k of l.kw || []) {
      if (idf.has(k)) continue;
      const f = df(k) / texts.length;
      idf.set(k, f > 0.04 ? Math.max(0.15, 0.04 / f) : 1);
    }
  }
  const kwWeight = (k) => idf.get(k) ?? 1;
  for (const s of frame) {
    const leaves = [];
    for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) leaves.push({ ...l, chapter: c.name, module: m.name });
    bySubject.set(s.key, leaves);
  }
  function scoreText(leaves, topicText, bodyText) {
    const scored = [];
    for (const l of leaves) {
      if (!l.kw) continue;
      let s = 0;
      if (topicText.includes(l.name)) s += 6 * l.name.length;
      for (const k of l.kw) {
        if (!k) continue;
        const len = Math.min(k.length, 6) * kwWeight(k);
        if (topicText.includes(k)) s += (k.length >= 2 ? 3 : 1.5) * len;
        else if (k.length >= 2 && bodyText.includes(k)) s += 0.6 * len;
      }
      if (s > 0) scored.push({ id: l.id, s });
    }
    if (!scored.length) return [];
    scored.sort((a, b) => b.s - a.s);
    const top = scored[0].s;
    if (top < 3) return [];
    const keep = scored.filter((x) => x.s >= top * 0.6).slice(0, 3);
    const sum = keep.reduce((a, b) => a + b.s, 0);
    return keep.map((x) => ({ id: x.id, w: x.s / sum }));
  }
  /** 一道题库题。 */
  function question(q) {
    const leaves = bySubject.get(q.subject);
    if (!leaves) return [];
    if (q.subject === "英语") {
      const topics = q.topics || [];
      const hits = [];
      for (const l of leaves) {
        const mt = l.match;
        if (!mt) continue;
        if (mt.part && mt.part !== q.part) continue;
        if (mt.read && !READ_PARTS.has(q.part)) continue;
        if (mt.topic) { if (topics.some((t) => new RegExp(`^(${mt.topic})$`).test(t))) return [{ id: l.id, w: 1 }]; continue; }
        hits.push(l);
      }
      if (hits.length) return hits.map((l) => ({ id: l.id, w: 1 / hits.length }));
      if (READ_PARTS.has(q.part)) return [{ id: leaves.find((l) => l.name === "细节题").id, w: 1 }];
      if (q.part === "完形") return [{ id: leaves.find((l) => l.name === "词义辨析").id, w: 1 }];
      return [];
    }
    return scoreText(leaves, (q.topics || []).join(" "), String(q.stem || "").slice(0, 600));
  }
  /** 自由文本（错题的考点名 + 题目）。subject 不确定时传 null。 */
  function text(subject, topic, body = "") {
    const subjects = subject && bySubject.has(subject) ? [subject] : [...bySubject.keys()];
    let best = [];
    let bestTop = 0;
    for (const s of subjects) {
      const r = scoreText(bySubject.get(s), String(topic || ""), String(body || "").slice(0, 600));
      if (r.length) {
        const top = r[0].w;
        if (!best.length || top > bestTop) { best = r; bestTop = top; }
      }
    }
    return best;
  }
  return { question, text, leavesOf: (s) => bySubject.get(s) || [] };
}

/** 用题库历年真题统计各考点分值。aiMap：{qid:[leafId…]}（AI 精确归类结果，优先）。 */
function buildFrame(bankItems, aiMap = {}) {
  const frame = baseFrame();
  const matcher = keywordMatcher(frame, bankItems.filter((q) => ["数学", "408"].includes(q.subject)));
  const mapQ = (q) => {
    const ai = aiMap[q.id];
    if (Array.isArray(ai) && ai.length) return ai.map((id) => ({ id, w: 1 / ai.length }));
    return matcher.question(q);
  };
  const raw = new Map();
  const realCount = new Map();
  let mapped = 0;
  let total = 0;
  for (const q of bankItems) {
    if (q.source === "AI生成" || q.source === "习题" || !["数学", "408"].includes(q.subject)) continue;
    total++;
    const hits = mapQ(q);
    if (!hits.length) continue;
    mapped++;
    const y = Number(q.year) || 2000;
    const yw = y >= 2009 ? 1 + (y - 2009) / 17 : 0.5;
    const pts = (Number(q.score) || 4) * yw;
    for (const h of hits) {
      raw.set(h.id, (raw.get(h.id) || 0) + pts * h.w);
      realCount.set(h.id, (realCount.get(h.id) || 0) + h.w);
    }
  }
  for (const s of frame) {
    for (const m of s.modules) {
      const leaves = m.chapters.flatMap((c) => c.leaves);
      let weights;
      if (["数学", "408"].includes(s.key)) {
        const vals = leaves.map((l) => raw.get(l.id) || 0);
        const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
        const prior = Math.max(0.5, mean * 0.15); // 真题里几乎没考到的考点也留一点分
        weights = vals.map((v) => v + prior);
      } else weights = leaves.map((l) => l.share || 1);
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      leaves.forEach((l, i) => {
        l.points = Math.round((m.max * weights[i] / sum) * 100) / 100;
        l.realCount = Math.round((realCount.get(l.id) || 0) * 10) / 10;
      });
    }
  }
  return { frame, matcher, mapQ, stats: { total, mapped } };
}

module.exports = { buildFrame, baseFrame, keywordMatcher };
