"use strict";
// 英语专项：生词本（FSRS）、长难句拆解批改、作文批改。
const { fail, uid, nowIso, str } = require("./util.cjs");
const fsrs = require("./fsrs.cjs");

function createEnglish({ store, llm }) {
  async function addWord({ word, sentence, source }) {
    const w = str(word, 100).trim();
    if (!w) fail("请输入单词或词组");
    const items = store.list("vocab");
    const dup = items.find((x) => x.word.toLowerCase() === w.toLowerCase());
    const info = await llm.json({
      system: "你是考研英语老师。给出单词在所给句子里的含义（考研英语一语境），简洁准确。输出 JSON：{\"phonetic\":\"音标\",\"pos\":\"词性\",\"meaning\":\"在本句中的意思\",\"otherMeanings\":\"其他常考义，分号分隔\",\"collocations\":\"常见搭配，分号分隔\",\"sentenceTranslation\":\"整句翻译\"}",
      text: `单词：${w}\n原句：${str(sentence, 2000) || "（无）"}`,
      slot: "cheap",
      maxTokens: 1500,
    });
    if (dup) {
      dup.contexts = [...(dup.contexts || []), { sentence: str(sentence, 2000), source: str(source, 200), meaning: info.meaning, at: nowIso() }];
      store.saveList("vocab", items);
      return { item: dup, merged: true };
    }
    const item = {
      id: uid(), word: w, phonetic: info.phonetic || "", pos: info.pos || "", meaning: info.meaning || "",
      otherMeanings: info.otherMeanings || "", collocations: info.collocations || "",
      contexts: [{ sentence: str(sentence, 2000), source: str(source, 200), meaning: info.meaning, translation: info.sentenceTranslation || "", at: nowIso() }],
      card: fsrs.newCard(), createdAt: nowIso(),
    };
    items.push(item);
    store.saveList("vocab", items);
    return { item, merged: false };
  }

  function rateWord({ id, rating }) {
    return store.update("vocab", id, (w) => ({ card: fsrs.review(w.card, rating) }));
  }

  async function gradeSentence({ sentence, structure, translation }) {
    const s = str(sentence, 3000).trim();
    if (!s) fail("请输入句子");
    const res = await llm.json({
      system: `你是考研英语一长难句老师。先给出标准拆解，再批改学生的结构划分和翻译。输出 JSON：
{"score":0-10,"mainClause":"主干（主谓宾）","structure":"逐层结构拆解（Markdown 列表：主句、各从句/非谓语/插入语及其修饰对象）","keyPoints":"本句考点（语法现象、难词）","reference":"参考译文","structureFeedback":"对学生结构划分的批改","translationFeedback":"对学生译文的批改（指出漏译、错译、语序问题）"}`,
      text: `句子：${s}\n\n学生的结构划分：${str(structure, 3000) || "（未写）"}\n学生的翻译：${str(translation, 3000) || "（未写）"}`,
      maxTokens: 4000,
    });
    const item = { id: uid(), sentence: s, structure: str(structure, 3000), translation: str(translation, 3000), result: res, createdAt: nowIso() };
    const items = store.list("sentences");
    items.push(item);
    store.saveList("sentences", items);
    return item;
  }

  async function gradeEssay({ kind, prompt, text, images = [] }) {
    if (!["small", "large"].includes(kind)) fail("请选择小作文或大作文");
    if (!str(text, 8000).trim() && !images.length) fail("请输入作文或上传照片");
    const max = kind === "small" ? 10 : 20;
    const res = await llm.json({
      system: `你是考研英语一作文阅卷老师，严格按官方评分标准：${kind === "small" ? "小作文（应用文）满分 10 分" : "大作文（图画/图表作文）满分 20 分"}，分五档（第五档最高）。考查：任务完成（要点是否齐全）、语言准确与丰富程度、连贯性、格式与语域。
输出 JSON：{"score":数字,"band":"第几档","summary":"总评","strengths":["…"],"issues":[{"type":"语法/拼写/用词/逻辑/格式/内容","original":"原文片段","fix":"修改后","why":"原因"}],"revised":"在学生原文基础上修改后的高分版本（保留其思路）","transcript":"如果是照片，先给出识别出的原文，否则留空"}`,
      text: `题目：${str(prompt, 4000) || "（未提供）"}\n\n学生作文：${str(text, 8000) || "（见图片）"}`,
      images: images.map((d) => ({ data: d, mimeType: "image/jpeg" })),
      maxTokens: 6000,
    });
    res.score = Math.max(0, Math.min(max, Number(res.score) || 0));
    const item = { id: uid(), kind, max, prompt: str(prompt, 4000), text: str(text, 8000) || res.transcript || "", result: res, createdAt: nowIso() };
    const items = store.list("essays");
    items.push(item);
    store.saveList("essays", items);
    return item;
  }

  return { addWord, rateWord, gradeSentence, gradeEssay };
}

module.exports = { createEnglish };
