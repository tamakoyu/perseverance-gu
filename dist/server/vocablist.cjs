"use strict";
// 考研词汇表 + 真题词频：每个词固定归到一档（核心高频 / 常考 / 偶见 / 大纲其余），四颗词汇星永远都在，越学越亮。
// 词表来自 KyleBing/english-vocabulary（BSD-3-Clause，见 wordlist/kaoyan-words.LICENSE），只取英文单词。
// 词频按当前题库里的英语一真题原文统计；题库里英语真题太少时用打包的默认值（2005–2026 年 22 套）。
const fs = require("node:fs");
const path = require("node:path");

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "wordlist", "kaoyan-words.json"), "utf8"));
const WORDS = DATA.words;
const SET = new Set(WORDS);
// 考研词表里属于初中词汇的部分（time、social、science…）：墨墨的考研词书里一般没有，默认按已掌握计
const BASIC = new Set(DATA.basic || []);
const BASIC_R = 0.95;

const BANDS = [
  { key: "core", name: "核心高频词", min: 8, weight: 3, desc: "在历年英语一真题里出现 8 次以上，阅读、完形、翻译里反复出现，最值得先拿下。" },
  { key: "common", name: "常考词", min: 3, weight: 2, desc: "真题里出现 3–7 次，常考但不算最高频。" },
  { key: "rare", name: "偶见词", min: 1, weight: 1.2, desc: "真题里只出现过 1–2 次。" },
  { key: "other", name: "大纲其余词", min: 0, weight: 0.6, desc: "考研大纲里有、但历年真题原文里还没出现过的词。" },
];

const RULES = [["ies", "y"], ["ied", "y"], ["ier", "y"], ["iest", "y"], ["ves", "f"], ["ves", "fe"], ["es", ""], ["s", ""], ["ed", ""], ["ed", "e"], ["d", ""], ["ing", ""], ["ing", "e"], ["er", ""], ["er", "e"], ["est", ""], ["ly", ""], ["ily", "y"]];
/** 把真题里的词形还原到词表里的词（简单规则：复数、过去式、-ing、比较级、-ly、双写辅音）。 */
function base(word) {
  const w = String(word || "").toLowerCase();
  if (SET.has(w)) return w;
  for (const [suf, rep] of RULES) {
    if (w.endsWith(suf) && w.length - suf.length >= 2) { const b = w.slice(0, -suf.length) + rep; if (SET.has(b)) return b; }
  }
  for (const suf of ["ed", "ing", "er", "est"]) {
    if (w.endsWith(suf) && w.length > suf.length + 2 && w[w.length - suf.length - 1] === w[w.length - suf.length - 2]) {
      const b = w.slice(0, -suf.length - 1); if (SET.has(b)) return b;
    }
  }
  return null;
}

let cache = null;
/** 每个词的真题出现次数（按题库重新统计，题库变了才重算）。 */
function freqOf(bankItems) {
  const eng = bankItems.filter((q) => q.subject === "英语" && q.source !== "AI生成");
  const papers = new Set(eng.map((q) => q.paper).filter(Boolean));
  const sig = `${eng.length}|${papers.size}`;
  if (cache?.sig === sig) return cache;
  let freq;
  if (papers.size >= 10) {
    const mats = new Map();
    for (const q of eng) if (q.material) mats.set(q.materialKey || q.id, q.material);
    const texts = [...mats.values(), ...eng.map((q) => q.stem || ""), ...eng.flatMap((q) => (q.options || []).map((o) => o.text || ""))];
    freq = {};
    for (const t of texts.join(" ").match(/[A-Za-z]+/g) || []) { const b = base(t); if (b) freq[b] = (freq[b] || 0) + 1; }
  } else freq = DATA.freq;
  const bandOf = new Map();
  const members = Object.fromEntries(BANDS.map((b) => [b.key, []]));
  for (const w of WORDS) {
    const f = freq[w] || 0;
    const b = BANDS.find((x) => f >= x.min);
    bandOf.set(w, b.key);
    members[b.key].push(w);
  }
  for (const k of Object.keys(members)) members[k].sort((a, b) => (freq[b] || 0) - (freq[a] || 0));
  cache = { sig, freq, bandOf, members, fromBank: papers.size >= 10, papers: papers.size };
  return cache;
}

module.exports = { BANDS, WORDS, BASIC, BASIC_R, base, freqOf };
