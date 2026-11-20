"use strict";
// 墨墨背单词开放 API：拉取学习记录，估算每个词现在还记得的概率。
// 文档 https://open.maimemo.com/document（学习数据接口为公测，需要在 App 里开启自动同步）。
const { nowIso } = require("./util.cjs");

const BASE = "https://open.maimemo.com/open/api/v1/memo/study";
const DAY = 86400000;

async function call(token, name, body, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: signal || AbortSignal.timeout(60000),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error("墨墨 token 无效或已过期，请在 设置 → 考研工具箱 里重新填写"), { fatal: true });
      if (!res.ok || !data?.success) throw new Error(`墨墨接口出错：${data?.errors?.[0]?.msg || res.status}`);
      return data.data;
    } catch (err) {
      if (err.fatal || signal?.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const iso = (t) => new Date(t).toISOString();

/** 按「下次学习日期」分段拉全部学习记录（单次请求太大墨墨会报内部错误，所以每段控制在 800 条内）。 */
async function fetchAllRecords(token, signal) {
  const out = new Map();
  const total = (await call(token, "query_study_records", { as_count: true, next_study_date: { start: iso(Date.UTC(2000, 0, 1)), end: iso(Date.UTC(2100, 0, 1)) } }, signal)).count || 0;
  const ranges = [[Date.UTC(2000, 0, 1), Date.now() - 180 * DAY], [Date.now() - 180 * DAY, Date.now() + 3 * 365 * DAY], [Date.now() + 3 * 365 * DAY, Date.UTC(2100, 0, 1)]];
  const visit = async (a, b, depth) => {
    const n = (await call(token, "query_study_records", { as_count: true, next_study_date: { start: iso(a), end: iso(b) } }, signal)).count || 0;
    if (!n) return;
    if (n > 800 && depth < 12 && b - a > DAY) {
      const mid = a + Math.floor((b - a) / 2);
      await visit(a, mid, depth + 1);
      await visit(mid + 1, b, depth + 1);
      return;
    }
    const r = await call(token, "query_study_records", { limit: 1000, next_study_date: { start: iso(a), end: iso(b) } }, signal);
    for (const x of r.records || []) out.set(x.voc_id, x);
  };
  for (const [a, b] of ranges) await visit(a, b, 0);
  return { records: [...out.values()], total };
}

/** 一个词现在还记得的概率：墨墨按记忆曲线排下次复习，间隔≈记忆稳定度 S；R = (1 + t / 9S)^-1。 */
function retention(w, now = Date.now()) {
  if (!w.last) return 0;
  const last = Date.parse(w.last);
  const next = w.next ? Date.parse(w.next) : last + DAY;
  const S = Math.max(1, (next - last) / DAY);
  const t = Math.max(0, (now - last) / DAY);
  let R = 1 / (1 + t / (9 * S));
  if (w.resp === "FORGET") R *= 0.6;
  else if (w.resp === "VAGUE") R *= 0.85;
  return R;
}

function createMomo({ store, getToken }) {
  const cache = () => store.value("momo", { at: null, words: [], progress: null, error: "" });

  async function sync({ signal, force = false } = {}) {
    const token = getToken();
    if (!token) return { ...cache(), error: "还没填墨墨 token" };
    const c = cache();
    if (!force && c.at && Date.now() - Date.parse(c.at) < 3 * 3600000 && c.words.length) return c;
    if (!force && c.failedAt && Date.now() - Date.parse(c.failedAt) < 30 * 60000) return c; // 刚失败过，半小时内不再自动重试
    try {
      const [{ records }, prog] = await Promise.all([
        fetchAllRecords(token, signal),
        call(token, "get_study_progress", {}, signal).catch(() => null),
      ]);
      const words = records.map((x) => ({ s: x.voc_spelling, first: x.first_study_date || null, last: x.last_study_date || null, next: x.next_study_date || null, resp: x.last_response || "", n: x.study_count || 0, stick: (x.tags || []).includes("STICKING") }));
      const value = { at: nowIso(), words, progress: prog?.progress || null, error: "" };
      store.saveValue("momo", value);
      return value;
    } catch (err) {
      const value = { ...c, error: err.message, failedAt: nowIso() };
      store.saveValue("momo", value);
      if (!c.words.length) throw err;
      return value;
    }
  }

  /** 词汇区：已学词的记忆总量 / 目标词汇量。 */
  function vocabState(target = 5500, now = Date.now()) {
    const c = cache();
    const words = c.words || [];
    let sumR = 0;
    let learned = 0;
    let strong = 0;
    let weak = 0;
    let due = 0;
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const bands = { easy: [], mid: [], hard: [] };
    for (const w of words) {
      if (!w.last) continue;
      learned++;
      const R = retention(w, now);
      sumR += R;
      if (R >= 0.9) strong++;
      else if (R < 0.7) weak++;
      if (w.next && Date.parse(w.next) <= endOfDay.getTime()) due++;
      // 难度：按墨墨给你排的复习间隔和上次的反馈
      const iv = w.next ? (Date.parse(w.next) - Date.parse(w.last)) / DAY : 1;
      const band = w.resp === "FORGET" || w.resp === "VAGUE" || iv < 7 ? "hard" : iv < 30 ? "mid" : "easy";
      bands[band].push({ s: w.s, R, n: w.n });
    }
    const pack = (list, order) => ({ n: list.length, sumR: list.reduce((a, b) => a + b.R, 0), samples: (order ? list.slice().sort(order) : list).slice(0, 30).map((x) => ({ s: x.s, R: Math.round(x.R * 100) / 100, n: x.n })) });
    return {
      bands: { easy: pack(bands.easy, (a, b) => b.n - a.n), mid: pack(bands.mid, (a, b) => a.R - b.R), hard: pack(bands.hard, (a, b) => a.R - b.R) },
      at: c.at, error: c.error, target, total: words.length, learned, strong, weak, due,
      effective: Math.round(sumR), mastery: Math.min(1, sumR / target),
      progress: c.progress,
    };
  }

  return { sync, vocabState, cache, retention };
}

module.exports = { createMomo, retention };
