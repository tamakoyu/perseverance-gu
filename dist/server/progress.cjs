"use strict";
// 数学 / 408 真题完成情况：把快练 / 模考、教学和练习会话、错题本重做里做过的题汇总到每道真题上。
const { uid, nowIso, str } = require("./util.cjs");

const SOURCE_BY_MODE = { quick: "快练", section: "专项", full: "模考", english: "英语专项" };

function createProgress({ store, bank }) {
  /** 会话里用真题出的题，学习者作答后由智能体调用记录。 */
  function record({ id, correct, score, learnerAnswer, agent, chatId }) {
    const q = bank.all().find((x) => x.id === id);
    if (!q) return null;
    const max = Number(q.score) || null;
    const sc = score == null || score === "" ? null : Math.max(0, Math.min(max || 1000, Number(score)));
    const entry = {
      id: uid(), qid: q.id, at: nowIso(),
      correct: correct === true ? true : correct === false ? false : null,
      score: sc == null && max ? (correct === true ? max : correct === false ? 0 : null) : sc,
      max,
      source: agent === "practice" ? "练习会话" : "教学会话",
      chatId: chatId || null,
      answer: str(learnerAnswer, 2000),
    };
    const list = store.list("bankLog");
    list.push(entry);
    store.saveList("bankLog", list);
    return { entry, q };
  }

  /** 每道题的全部作答事件，按时间排序。 */
  function events() {
    const map = new Map();
    const add = (qid, e) => { if (!map.has(qid)) map.set(qid, []); map.get(qid).push(e); };
    for (const a of store.list("attempts")) {
      if (a.status !== "done" || !a.results) continue;
      for (const [qid, r] of Object.entries(a.results)) {
        const ans = a.answers?.[qid];
        if (!ans || !(ans.choice || ans.text || ans.hasImages)) continue; // 没作答的不算做过
        add(qid, { at: a.finishedAt, correct: r.correct ?? null, score: r.score ?? null, max: r.max ?? null, source: SOURCE_BY_MODE[a.mode] || "练习" });
      }
    }
    for (const e of store.list("bankLog")) add(e.qid, { at: e.at, correct: e.correct, score: e.score, max: e.max, source: e.source, chatId: e.chatId });
    const open = new Set();
    for (const m of store.list("mistakes")) {
      if (!m.bankId) continue;
      for (const h of m.history || []) if (h.correct === true || h.correct === false) add(m.bankId, { at: h.at, correct: h.correct, score: null, max: null, source: "错题重做" });
      if (!m.archived) open.add(m.bankId);
      // 会话里记了错题但没单独记录作答的，也算做过一次（做错）
      if (!map.has(m.bankId)) add(m.bankId, { at: m.createdAt, correct: false, score: null, max: null, source: m.source || "错题本" });
    }
    for (const list of map.values()) list.sort((x, y) => (x.at < y.at ? -1 : 1));
    return { map, open };
  }

  function overview(subject) {
    const { map, open } = events();
    const papers = new Map();
    for (const q of bank.all()) {
      if (q.subject !== subject || q.source === "AI生成" || !q.paper) continue;
      if (!papers.has(q.paper)) papers.set(q.paper, { paper: q.paper, year: q.year, questions: [] });
      const ev = map.get(q.id) || [];
      const last = ev[ev.length - 1] || null;
      papers.get(q.paper).questions.push({
        id: q.id, number: q.number, type: q.type, score: q.score, topics: q.topics || [],
        hasAnswer: !!q.answer, count: ev.length, mistake: open.has(q.id),
        last: last ? { correct: last.correct, score: last.score, max: last.max, at: last.at, source: last.source } : null,
        sources: [...new Set(ev.map((e) => e.source))],
      });
    }
    const list = [...papers.values()].sort((a, b) => (b.year || 0) - (a.year || 0));
    const types = [...new Set(list.flatMap((p) => p.questions.map((q) => q.type)))];
    return { subject, papers: list, types };
  }

  return { record, overview };
}

module.exports = { createProgress };
