"use strict";
// 学习时长、科目归类、今日面板。
const { today } = require("./util.cjs");
const fsrs = require("./fsrs.cjs");
const { leaves } = require("./syllabus.cjs");

const STAGES = [
  { name: "① 基础奠基", from: "2026-09-01", to: "2026-12-31" },
  { name: "② 基础精讲", from: "2027-01-01", to: "2027-06-30" },
  { name: "③ 强化提升", from: "2027-07-01", to: "2027-09-30" },
  { name: "④ 冲刺实战", from: "2027-10-01", to: "2027-11-30" },
  { name: "⑤ 终极冲刺", from: "2027-12-01", to: "2027-12-31" },
];

const EXTRA_KW = {
  英语: ["英语", "单词", "阅读", "完形", "翻译", "作文", "长难句", "english", "reading", "essay"],
  政治: ["政治", "马原", "毛中特", "史纲", "思修", "形势与政策", "马克思", "唯物", "辩证"],
  数学: ["高数", "线代", "概率", "数学", "极限", "积分", "微分", "导数", "矩阵"],
  408: ["数据结构", "计组", "组成原理", "操作系统", "计算机网络", "c语言", "算法", "链表", "指针"],
};

function createStats({ ctx, store, vault, bank }) {
  const leafList = leaves();
  const kwBySubject = { 数学: [...EXTRA_KW.数学], 408: [...EXTRA_KW["408"]], 英语: EXTRA_KW.英语, 政治: EXTRA_KW.政治 };
  for (const l of leafList) kwBySubject[l.subject].push(...l.kw.filter((k) => k.length >= 2));

  function classify(text) {
    const t = String(text || "").toLowerCase();
    let best = "其他";
    let bestScore = 0;
    for (const [s, kws] of Object.entries(kwBySubject)) {
      let score = 0;
      for (const k of kws) if (t.includes(k.toLowerCase())) score += k.length;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    return best;
  }

  const cache = new Map(); // chatId → {updatedAt, minutesByDay, subject}

  function firstUserText(record) {
    const m = (record.messages || []).find((x) => x.role === "user");
    if (!m) return "";
    return typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
  }

  function sessionInfo(summary) {
    const hit = cache.get(summary.id);
    if (hit && hit.updatedAt === summary.updatedAt) return hit;
    const record = ctx.learning.getSession(summary.id);
    const minutesByDay = {};
    const ts = (record?.messages || []).map((m) => m.timestamp).filter((t) => typeof t === "number").sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) {
      const gap = (ts[i] - ts[i - 1]) / 60000;
      const add = gap <= 15 ? gap : 1; // 超过 15 分钟没动静视为离开
      const day = today(new Date(ts[i]));
      minutesByDay[day] = (minutesByDay[day] || 0) + add;
    }
    const info = { updatedAt: summary.updatedAt, minutesByDay, subject: classify(`${summary.title} ${record ? firstUserText(record).slice(0, 500) : ""}`) };
    cache.set(summary.id, info);
    return info;
  }

  function studyTime() {
    const settings = store.value("settings", {});
    const overrides = settings.sessionSubjects || {};
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(today(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    const weekStartIdx = (() => { const d = now.getDay() || 7; return Math.max(0, 7 - d); })();
    const weekDays = days.slice(weekStartIdx);
    const byDay = Object.fromEntries(days.map((d) => [d, {}]));
    const add = (day, subject, min) => { if (byDay[day]) byDay[day][subject] = (byDay[day][subject] || 0) + min; };
    let sessions = [];
    try { sessions = ctx.learning.listSessions() || []; } catch { sessions = []; }
    const cutoff = Date.parse(days[0]);
    const recent = [];
    for (const s of sessions) {
      if (Date.parse(s.updatedAt) < cutoff) continue;
      const info = sessionInfo(s);
      const subject = overrides[s.id] || info.subject;
      recent.push({ id: s.id, title: s.title, subject, kind: s.kind, updatedAt: s.updatedAt });
      for (const [day, min] of Object.entries(info.minutesByDay)) add(day, subject, min);
    }
    for (const a of store.list("activity")) {
      const day = today(new Date(a.at));
      add(day, a.subject || "其他", a.minutes || 0);
    }
    const sum = (list) => {
      const out = {};
      for (const d of list) for (const [s, m] of Object.entries(byDay[d] || {})) out[s] = (out[s] || 0) + m;
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v)]));
    };
    return { today: sum([days[6]]), week: sum(weekDays), byDay: days.map((d) => ({ day: d, ...Object.fromEntries(Object.entries(byDay[d]).map(([k, v]) => [k, Math.round(v)])) })), recent };
  }

  function stageOf(dateStr, examDate) {
    for (const s of STAGES) if (dateStr >= s.from && dateStr <= s.to) return s;
    if (dateStr > examDate) return { name: "初试已结束" };
    return { name: "备考准备" };
  }

  function todaySummary() {
    const settings = store.value("settings", {});
    const examDate = settings.examDate || "2027-12-18";
    const d = today();
    const daysLeft = Math.ceil((Date.parse(`${examDate}T00:00:00`) - Date.parse(`${d}T00:00:00`)) / 86400000);
    let plan = { found: false };
    let planError = "";
    try { plan = vault.dayPlan(); } catch (err) { planError = err.message; }
    const doneToday = new Set((store.value("dailyDone", {})[d]) || []);
    for (const s of plan.subjects || []) for (const t of s.tasks) if (t.kind === "daily") t.done = doneToday.has(t.key);
    const now = Date.now();
    const mistakes = store.list("mistakes");
    const vocab = store.list("vocab");
    return {
      date: d, examDate, daysLeft, stage: stageOf(d, examDate), stages: STAGES,
      plan, planError,
      due: {
        mistakes: mistakes.filter((m) => !m.archived && fsrs.isDue(m.card, now)).length,
        mistakesTotal: mistakes.filter((m) => !m.archived).length,
        vocab: vocab.filter((v) => fsrs.isDue(v.card, now)).length,
        vocabTotal: vocab.length,
      },
      time: studyTime(),
    };
  }


  /** 每日型任务（每天都要做的）只记在插件数据里，不改周计划文件。 */
  function toggleDaily(key, done) {
    const d = today();
    const all = store.value("dailyDone", {});
    const keep = Object.fromEntries(Object.entries(all).filter(([k]) => k >= today(new Date(Date.now() - 30 * 86400000))));
    const set = new Set(keep[d] || []);
    if (done) set.add(key); else set.delete(key);
    keep[d] = [...set];
    store.saveValue("dailyDone", keep);
    return { done };
  }

  return { classify, studyTime, todaySummary, toggleDaily };
}

module.exports = { createStats };
