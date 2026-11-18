"use strict";
// FSRS-4.5 默认参数的精简实现。评分：1 再来 / 2 困难 / 3 良好 / 4 简单。
const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const RETENTION = 0.9;
const DAY = 86400000;
const clampD = (d) => Math.min(10, Math.max(1, d));
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
const retrievability = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
const interval = (s) => Math.max(1, Math.round(s / FACTOR * (Math.pow(RETENTION, 1 / DECAY) - 1)));

function newCard(now = Date.now()) {
  return { state: "new", due: new Date(now).toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0, last: null };
}

function review(card, rating, now = Date.now()) {
  const g = Math.min(4, Math.max(1, Math.round(Number(rating))));
  const c = { ...(card || newCard(now)) };
  if (c.state === "new" || !c.stability) {
    c.stability = W[g - 1];
    c.difficulty = initD(g);
  } else {
    const elapsed = Math.max(0, (now - Date.parse(c.last || c.due)) / DAY);
    const r = retrievability(elapsed, c.stability);
    const d = clampD(W[7] * initD(4) + (1 - W[7]) * (c.difficulty - W[6] * (g - 3)));
    if (g === 1) {
      c.stability = Math.min(c.stability, W[11] * Math.pow(c.difficulty, -W[12]) * (Math.pow(c.stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
      c.lapses += 1;
    } else {
      const hard = g === 2 ? W[15] : 1;
      const easy = g === 4 ? W[16] : 1;
      c.stability = c.stability * (Math.exp(W[8]) * (11 - c.difficulty) * Math.pow(c.stability, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
    }
    c.difficulty = d;
  }
  // 答错：当天稍后或明天再来一次
  const days = g === 1 ? 1 : interval(c.stability);
  c.state = "review";
  c.reps += 1;
  c.last = new Date(now).toISOString();
  c.due = new Date(now + days * DAY).toISOString();
  c.lastRating = g;
  return c;
}

function isDue(card, now = Date.now()) {
  return !!card && Date.parse(card.due) <= now;
}

module.exports = { newCard, review, isDue };
