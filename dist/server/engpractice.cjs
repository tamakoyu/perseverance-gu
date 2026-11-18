"use strict";
// 英语真题专项：总览（年份 × 部分的完成情况）、提交后的 AI 复盘（错因 / 讲解 / 生词 / 强化训练）。
const { fail, uid, nowIso, str } = require("./util.cjs");
const fsrs = require("./fsrs.cjs");
const { UNITS } = require("./engimport.cjs");

const numKey = (n) => { const m = String(n).match(/\d+/); return m ? Number(m[0]) : 9999; };

function createEngPractice({ store, llm, bank }) {
  const isReal = (q) => q.subject === "英语" && q.part && / 英语一$/.test(q.paper || "");

  /** 每道题最近一次的作答结果 + 每个单元的练习记录。 */
  function history() {
    const perQ = new Map();
    const perUnit = new Map();
    const attempts = store.list("attempts").filter((a) => a.status === "done" && a.results);
    for (const a of attempts) {
      for (const [qid, r] of Object.entries(a.results)) {
        const prev = perQ.get(qid);
        if (!prev || prev.at < a.finishedAt) perQ.set(qid, { correct: r.correct, score: r.score, max: r.max, at: a.finishedAt, attemptId: a.id });
      }
      for (const [unit, sec] of Object.entries(a.unitTimes || {})) {
        const list = perUnit.get(unit) || [];
        list.push({ attemptId: a.id, at: a.finishedAt, seconds: sec });
        perUnit.set(unit, list);
      }
    }
    return { perQ, perUnit };
  }

  function overview() {
    const { perQ, perUnit } = history();
    const papers = new Map();
    for (const q of bank.all()) {
      if (!isReal(q)) continue;
      if (!papers.has(q.paper)) papers.set(q.paper, { paper: q.paper, year: q.year, units: {} });
      const p = papers.get(q.paper);
      const def = UNITS.find((u) => u.key === q.part);
      const u = p.units[q.part] || (p.units[q.part] = { key: q.part, unitId: q.materialKey, part: def?.part || q.part, minutes: def?.minutes || 15, questions: [] });
      const h = perQ.get(q.id);
      u.questions.push({ id: q.id, number: q.number, topics: q.topics, hasAnswer: !!q.answer, last: h ? { correct: h.correct, score: h.score, max: h.max, at: h.at } : null });
    }
    for (const p of papers.values()) {
      for (const u of Object.values(p.units)) {
        u.questions.sort((a, b) => numKey(a.number) - numKey(b.number));
        const done = u.questions.filter((x) => x.last);
        u.done = done.length;
        u.total = u.questions.length;
        u.score = done.reduce((s, x) => s + (x.last.score || 0), 0);
        u.max = done.reduce((s, x) => s + (x.last.max || 0), 0);
        u.correct = done.filter((x) => x.last.correct).length;
        const times = perUnit.get(u.unitId) || [];
        u.practiced = times.length;
        u.lastSeconds = times.length ? times.sort((a, b) => (a.at < b.at ? 1 : -1))[0].seconds : null;
      }
    }
    const list = [...papers.values()].sort((a, b) => b.year - a.year);
    return { papers: list, units: UNITS.map(({ key, part, minutes }) => ({ key, part, minutes })) };
  }

  function unitInfo(ids) {
    const want = new Set(ids);
    return store.list("engUnits").filter((u) => want.has(u.id));
  }

  /** 提交判分之后：按单元复盘。 */
  async function review({ attemptId, progress = () => {}, signal }) {
    const attempt = store.list("attempts").find((a) => a.id === attemptId);
    if (!attempt?.results) fail("找不到这次练习的判分结果");
    const byId = new Map(bank.all().map((q) => [q.id, q]));
    const qs = attempt.questionIds.map((id) => byId.get(id)).filter(Boolean);
    const groups = new Map();
    for (const q of qs) {
      const k = q.materialKey || q.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }
    const materials = bank.materialsOf(qs);
    const infos = new Map(store.list("engUnits").map((u) => [u.id, u]));
    const known = new Set(store.list("vocab").map((w) => w.word.toLowerCase()));
    const out = {};
    let i = 0;
    for (const [key, list] of groups) {
      if (signal?.aborted) fail("已取消");
      progress(i++, groups.size, `复盘 ${list[0].paper || ""} ${list[0].part || list[0].type}`);
      const def = UNITS.find((u) => u.key === list[0].part);
      const limit = Math.round((def?.minutes || 15) * 60 * list.length / Math.max(1, (def ? def.to - def.from + 1 : list.length)));
      const used = attempt.unitTimes?.[key] ?? null;
      const material = materials[key] || "";
      const info = infos.get(key);
      const lines = list.map((q) => {
        const r = attempt.results[q.id] || {};
        const a = attempt.answers?.[q.id] || {};
        return `【第 ${q.number} 题】${q.type}${q.topics?.length ? `（${q.topics.join("、")}）` : ""}
题目：${q.stem}
${q.options.map((o) => `${o.key}. ${o.text}`).join("\n")}
参考答案：${q.answer || "（无）"}
解析书：${(q.analysis || "（无）").slice(0, 1500)}
考生作答：${a.choice || a.text || (a.hasImages ? "（手写，见判分意见）" : "未作答")}
判分：${r.correct === true ? "对" : r.correct === false ? "错" : "未判"} ${r.score ?? 0}/${r.max ?? q.score}${r.feedback ? `；判分意见：${r.feedback}` : ""}${r.errorType ? `；初判错因：${r.errorType}` : ""}`;
      }).join("\n\n");
      const res = await llm.json({
        system: `你是考研英语一的一对一老师。学生刚做完一组真题，你根据题目、解析书和学生的作答，给出复盘。要具体到这篇文章和这几道题，不要空话。
阅读/新题型的错因从这些里选：${bank.READING_ERRORS.join("、")}；完形可用：词义辨析不清、逻辑关系没抓住、固定搭配不熟、上下文没读、词汇量不足；翻译/作文可用：句子结构没拆清、词义选择不当、漏译、语序/中文表达、语法错误、要点缺失、用词单一。用时超过限时也要作为问题指出（比如「定位太慢」「逐词读」）。
输出 JSON：
{"summary":"两三句话的总体评价（含用时）",
 "errorCauses":[{"cause":"错因名","questions":["21","24"],"detail":"在这篇里具体表现为…"}],
 "teaching":[{"number":"21","explain":"Markdown：定位句（引原文）→ 句意 → 为什么选正确项 → 学生选的项错在哪（干扰项类型）"}],
 "method":"Markdown：针对这次暴露的问题，教一个可操作的方法（比如态度题怎么找态度词、因果题怎么找因果标志词），并用本文的一个句子示范",
 "vocab":[{"word":"…","phonetic":"…","pos":"…","meaning":"在本文中的意思","sentence":"本文中含这个词的原句"}],
 "drillFocus":"下一步强化什么（一句话，比如「推理题：不脑补，答案必须有原文依据」）"}
teaching 只写做错或没作答的题；全对就写空数组并在 method 里讲一个提分技巧。vocab 从本文挑 8–12 个考研高频或影响理解的词（不要太简单的词${known.size ? "，也不要这些已在生词本里的：" + [...known].slice(0, 300).join(", ") : ""}）；作文/翻译挑可积累的好词好表达。`,
        text: `试卷：${list[0].paper}；部分：${list[0].part || list[0].type}；限时：${Math.round(limit / 60)} 分钟；实际用时：${used == null ? "未记录" : `${Math.floor(used / 60)} 分 ${used % 60} 秒`}
${info?.directions ? `题目要求：${info.directions}\n` : ""}${material ? `文章：\n${material.slice(0, 9000)}\n` : ""}
${lines}`,
        slot: "strong",
        maxTokens: 10000,
        signal,
      });
      out[key] = {
        paper: list[0].paper, part: list[0].part || list[0].type, limitSec: limit, usedSec: used,
        summary: String(res.summary || ""), errorCauses: Array.isArray(res.errorCauses) ? res.errorCauses : [],
        teaching: Array.isArray(res.teaching) ? res.teaching : [], method: String(res.method || ""),
        vocab: (Array.isArray(res.vocab) ? res.vocab : []).filter((w) => w?.word && !known.has(String(w.word).toLowerCase())),
        drillFocus: String(res.drillFocus || ""),
        translation: info?.translation || "",
        drills: recommend(list, res.errorCauses),
      };
    }
    progress(groups.size, groups.size, "完成");
    store.update("attempts", attemptId, { review: out });
    return out;
  }

  /** 推荐同部分、还没做过的真题单元；错题考点相同的排前面。 */
  function recommend(list, causes) {
    const part = list[0].part;
    if (!part) return [];
    const { perQ } = history();
    const topics = new Set(list.flatMap((q) => q.topics || []));
    const units = new Map();
    for (const q of bank.all()) {
      const same = (x) => (String(x).startsWith("Text") ? "阅读" : x);
      if (!isReal(q) || same(q.part) !== same(part) || q.materialKey === list[0].materialKey) continue;
      const u = units.get(q.materialKey) || { unitId: q.materialKey, paper: q.paper, year: q.year, part: q.part, ids: [], done: 0, hits: 0 };
      u.ids.push(q.id);
      u.part = q.part;
      if (perQ.has(q.id)) u.done++;
      if ((q.topics || []).some((t) => topics.has(t))) u.hits++;
      units.set(q.materialKey, u);
    }
    return [...units.values()].filter((u) => u.done === 0)
      .sort((a, b) => b.hits - a.hits || b.year - a.year).slice(0, 3)
      .map(({ unitId, paper, year, part: p, ids }) => ({ unitId, paper, year, part: p, ids }));
  }

  /** AI 出一组强化题（短文 + 3–4 题，针对错因），存进题库，返回题目 id。 */
  async function aiDrill({ attemptId, unitId, signal }) {
    const attempt = store.list("attempts").find((a) => a.id === attemptId);
    const rv = attempt?.review?.[unitId];
    if (!rv) fail("先完成复盘再生成强化题");
    const part = String(rv.part).replace(/^AI-/, "");
    const kind = part.startsWith("Text") || part === "阅读" ? "阅读" : part === "完形" ? "完形" : part === "新题型" ? "新题型" : part === "翻译" ? "翻译" : "阅读";
    const shape = {
      阅读: "一篇 350–450 词、考研英语一阅读风格（外刊题材：科技 / 社会 / 经济 / 文化）的原创短文，配 4 道单选题（A–D），题型要覆盖错因对应的题型。",
      完形: "一篇约 250 词的原创短文，挖 10 个空（写成 **__1__** … **__10__**），每空 4 个选项，重点考错因对应的能力。",
      新题型: "一篇约 400 词的原创短文，挖 3 个空（写成 **[1]** **[2]** **[3]**），给 5 个备选句 A–E（2 个干扰项），每道题的 options 都是这 5 项。",
      翻译: "一段约 150 词的原创英文短文，其中 3 个划线长难句（写成 **(1) …**），每题 stem 是那个划线句，answer 是参考译文，analysis 讲句子结构和译法。",
    }[kind];
    const res = await llm.json({
      system: `你是考研英语一命题老师。根据学生这次暴露的问题出一组强化题，难度贴近真题。${shape}
每题给 answer 和 analysis（Markdown：定位句 → 解题思路 → 各干扰项为什么错，点明对应的错因）。
输出 JSON：{"material":"短文 Markdown","questions":[{"number":"1","stem":"…","options":[{"key":"A","text":"…"}],"answer":"B","analysis":"…","topics":["推理题"]}]}`,
      text: `学生的错因：${rv.errorCauses.map((c) => `${c.cause}：${c.detail}`).join("；") || "无明显错因"}\n下一步强化：${rv.drillFocus}`,
      slot: "strong",
      maxTokens: 10000,
      signal,
    });
    const key = `AI强化#${uid()}`;
    const items = bank.all();
    const qs = (res.questions || []).map((q, i) => ({
      id: uid(), subject: "英语", paper: "", year: null, number: String(q.number || i + 1), type: kind,
      stem: String(q.stem || "").trim() || (kind === "完形" ? `第 ${i + 1} 空` : ""),
      options: (q.options || []).filter((o) => o?.key).map((o) => ({ key: String(o.key).toUpperCase().slice(0, 1), text: String(o.text || "") })),
      answer: String(q.answer || ""), analysis: String(q.analysis || ""), answerSource: "AI", analysisSource: "AI",
      score: kind === "完形" ? 0.5 : 2, topics: (q.topics || []).map(String).slice(0, 2),
      material: i === 0 ? String(res.material || "") : "", materialKey: key, part: `AI-${kind}`,
      hasFigure: false, images: [], source: "AI生成", drillFor: unitId, createdAt: nowIso(),
    }));
    if (!qs.length) fail("AI 没有出出题目，请重试");
    items.push(...qs);
    store.saveList("bank", items);
    return { ids: qs.map((q) => q.id), title: `AI 强化 · ${kind}` };
  }

  /** 直接把复盘里挑好的词加进生词本（释义已有，不再调用模型）。 */
  function addWords({ words, source }) {
    const items = store.list("vocab");
    let added = 0;
    for (const w of words || []) {
      const word = str(w.word, 100).trim();
      if (!word) continue;
      const ctxItem = { sentence: str(w.sentence, 2000), source: str(source, 200), meaning: str(w.meaning, 500), at: nowIso() };
      const dup = items.find((x) => x.word.toLowerCase() === word.toLowerCase());
      if (dup) { dup.contexts = [...(dup.contexts || []), ctxItem]; continue; }
      items.push({ id: uid(), word, phonetic: str(w.phonetic, 100), pos: str(w.pos, 50), meaning: str(w.meaning, 500), otherMeanings: "", collocations: "", contexts: [ctxItem], card: fsrs.newCard(), createdAt: nowIso() });
      added++;
    }
    store.saveList("vocab", items);
    return { added };
  }

  return { overview, review, aiDrill, addWords, unitInfo };
}

module.exports = { createEngPractice };
