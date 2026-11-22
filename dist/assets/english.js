// 英语专项：真题刷题（总览 / 选题 / 限时 / AI 复盘）、生词本（推送到墨墨背）、长难句拆解、作文批改。
import { mountEnglishPractice } from "./engpractice.js";
import { put, reset, el, btn, select, field, md, errorBox, toast, runJob, tabs, photoPicker, fmtTime } from "./ui.js";

export function mountEnglish(ctx, container, signal) {
  const root = el("div", "ky-root");
  put(container, root);
  let tab = "real";
  const body = el("div");

  function render() {
    reset(root,
      tabs([["real", "真题"], ["vocab", "生词本"], ["sentence", "长难句"], ["essay", "作文批改"]], tab, (k) => { tab = k; render(); }), body);
    reset(body);
    if (tab === "real") mountEnglishPractice(ctx, body, signal);
    else if (tab === "vocab") renderVocab();
    else if (tab === "sentence") renderSentence();
    else renderEssay();
  }

  // ── 生词本：只做记录，单词都推送到墨墨里背 ───────────────────
  const MOMO_LABEL = { added: ["已加入墨墨", "ky-tag-ok"], exists: ["墨墨里已在背", "ky-tag-ok"], notfound: ["墨墨词库查不到", "ky-tag-warn"], error: ["推送失败", "ky-tag-warn"] };
  async function renderVocab() {
    let words = [];
    let s = {};
    try { [words, s] = await Promise.all([ctx.call("vocab.list"), ctx.call("settings.get").then((r) => r.settings)]); } catch (err) { put(body, errorBox(err)); return; }
    const hasToken = !!s.momoTokenSet;
    const pending = words.filter((w) => !w.momo || w.momo.status === "error");
    const word = el("input", { class: "ky-input", placeholder: "单词 / 词组" });
    const sentence = el("textarea", { class: "ky-input", placeholder: "原句（精读时遇到它的那句话）" });
    const src = el("input", { class: "ky-input", placeholder: "出处，如：2014 Text 1" });
    const msg = el("div");
    const pushOut = el("div");

    put(body, el("section", "ky-card",
      el("h3", "ky-h3", "生词都在墨墨里背"),
      el("p", "ky-muted", hasToken
        ? "加进生词本的词会自动推送到墨墨的学习计划（真题复盘挑的词、阅读时划的词、手动添加的都算），之后打开墨墨背就行；这里只留释义和原句做记录。"
        : "还没填墨墨 token：在 设置 → 考研工具箱 里填好后，生词会自动推送到墨墨。"),
      hasToken && pending.length ? el("div", "ky-row",
        btn(`把还没推送的 ${pending.length} 个词加到墨墨`, async () => {
          try {
            const r = await runJob(ctx, pushOut, () => ctx.call("vocab.pushMomo"), "推送到墨墨");
            reset(pushOut, el("div", "ky-ok", `完成：新加入 ${r.added} 个，墨墨里本来就在背 ${r.exists} 个${r.notfound ? `，墨墨词库查不到 ${r.notfound} 个` : ""}。`));
            setTimeout(render, 1500);
          } catch (err) { reset(pushOut, errorBox(err)); }
        }, "ky-btn ky-btn-primary")) : null,
      pushOut));

    put(body, el("section", "ky-card", el("h3", "ky-h3", "添加生词"),
      el("div", "ky-grid2", field("单词", word), field("出处", src)), field("原句", sentence),
      btn(hasToken ? "添加并推送到墨墨" : "添加（AI 补全释义）", async () => {
        if (!word.value.trim()) return;
        reset(msg, el("span", "ky-muted", "查询中…"));
        try {
          const r = await ctx.call("vocab.add", { word: word.value, sentence: sentence.value, source: src.value });
          reset(msg, el("div", "ky-ok", `${r.merged ? "已在生词本，补充了新例句" : "已添加"}：${r.item.word} ${r.item.phonetic} ${r.item.meaning}${hasToken ? "，正在推送到墨墨" : ""}`));
          word.value = ""; sentence.value = "";
          setTimeout(render, 2500);
        } catch (err) { reset(msg, errorBox(err)); }
      }, "ky-btn ky-btn-primary"), msg));

    const list = el("section", "ky-card", el("h3", "ky-h3", `全部生词（${words.length}）`));
    put(list, ...words.slice().reverse().map((w) => {
      const [label, cls] = w.momo ? MOMO_LABEL[w.momo.status] || ["", ""] : ["未推送", "ky-tag-muted"];
      const ctxSent = w.contexts?.[w.contexts.length - 1];
      return el("div", "ky-vocab-row",
        el("div", "ky-vocab-main", el("b", null, w.word), el("span", "ky-muted", `${w.phonetic || ""} ${w.pos || ""}`), el("span", null, w.meaning),
          ctxSent?.sentence ? el("div", "ky-vocab-sent", ctxSent.sentence, ctxSent.source ? el("span", "ky-muted", ` — ${ctxSent.source}`) : null) : null),
        el("span", { class: `ky-tag ${cls}`, title: w.momo?.error || undefined }, label),
        btn("删除", async () => { await ctx.call("vocab.delete", { id: w.id }); render(); }, "ky-btn ky-btn-ghost ky-btn-sm"));
    }));
    if (!words.length) put(list, el("p", "ky-empty", "还没有生词。在真题复盘、阅读划词或上面手动添加。"));
    put(body, list);
  }

  // ── 长难句 ───────────────────────────────────────────
  async function renderSentence() {
    const s = el("textarea", { class: "ky-input ky-ta", placeholder: "粘贴一个长难句" });
    const structure = el("textarea", { class: "ky-input ky-ta", placeholder: "你的结构划分：主干是什么？哪些是从句 / 非谓语 / 插入语，各修饰谁？" });
    const trans = el("textarea", { class: "ky-input ky-ta", placeholder: "你的翻译" });
    const out = el("div");
    put(body, el("section", "ky-card", el("p", "ky-muted", "先自己拆、自己译，再让 AI 批改并给出标准拆解。"),
      field("句子", s), field("结构划分", structure), field("翻译", trans),
      btn("批改", async () => {
        if (!s.value.trim()) return;
        try {
          const r = await runJob(ctx, out, () => ctx.call("sentence.grade", { sentence: s.value, structure: structure.value, translation: trans.value }), "批改");
          reset(out, sentenceResult(r));
        } catch (err) { reset(out, errorBox(err)); }
      }, "ky-btn ky-btn-primary"), out));
    try {
      const hist = await ctx.call("sentence.list");
      if (hist.length) {
        const det = el("details", "ky-card", el("summary", "ky-sum", el("b", null, `历史（${hist.length}）`)));
        put(det, ...hist.map((h) => { const d = el("details", "ky-sub", el("summary", null, `${h.result?.score ?? "?"}/10 · ${h.sentence.slice(0, 80)}…`)); put(d, sentenceResult(h)); return d; }));
        put(body, det);
      }
    } catch { /* 历史读不到不影响 */ }
  }

  function sentenceResult(h) {
    const r = h.result || {};
    return el("div", "ky-result",
      el("div", "ky-verdict", `得分 ${r.score ?? "?"}/10`),
      el("h4", "ky-h4", "主干"), el("p", null, r.mainClause || ""),
      el("h4", "ky-h4", "结构拆解"), md(ctx, r.structure, signal),
      el("h4", "ky-h4", "考点"), md(ctx, r.keyPoints, signal),
      el("h4", "ky-h4", "参考译文"), el("p", null, r.reference || ""),
      el("h4", "ky-h4", "结构批改"), md(ctx, r.structureFeedback, signal),
      el("h4", "ky-h4", "翻译批改"), md(ctx, r.translationFeedback, signal));
  }

  // ── 阅读 ─────────────────────────────────────────────
  // ── 作文 ─────────────────────────────────────────────
  async function renderEssay() {
    const kind = select([["small", "小作文（应用文，10 分）"], ["large", "大作文（图画/图表，20 分）"]], "large", () => {});
    const prompt = el("textarea", { class: "ky-input", placeholder: "题目要求（可选，建议填写）" });
    const text = el("textarea", { class: "ky-input ky-ta-lg", placeholder: "你的作文（或拍照上传手写稿）" });
    const photos = photoPicker("拍照上传手写作文");
    const out = el("div");
    put(body, el("section", "ky-card", field("类型", kind), field("题目", prompt), field("作文", text), photos.node,
      btn("批改", async () => {
        try {
          const r = await runJob(ctx, out, () => ctx.call("essay.grade", { kind: kind.value, prompt: prompt.value, text: text.value, images: photos.get() }), "批改");
          reset(out, essayResult(r));
        } catch (err) { reset(out, errorBox(err)); }
      }, "ky-btn ky-btn-primary"), out));
    try {
      const hist = await ctx.call("essay.list");
      if (hist.length) {
        const det = el("details", "ky-card", el("summary", "ky-sum", el("b", null, `历史（${hist.length}）`)));
        put(det, ...hist.map((h) => { const d = el("details", "ky-sub", el("summary", null, `${fmtTime(h.createdAt)} · ${h.kind === "small" ? "小作文" : "大作文"} · ${h.result?.score}/${h.max}`)); put(d, essayResult(h)); return d; }));
        put(body, det);
      }
    } catch { /* 忽略 */ }
  }

  function essayResult(h) {
    const r = h.result || {};
    return el("div", "ky-result",
      el("div", "ky-verdict", `${r.score}/${h.max} 分 · ${r.band || ""}`),
      el("p", null, r.summary || ""),
      r.strengths?.length ? el("div", null, el("h4", "ky-h4", "亮点"), el("ul", "ky-ul", ...r.strengths.map((s) => el("li", null, s)))) : null,
      r.issues?.length ? el("div", null, el("h4", "ky-h4", "问题与修改"), el("table", "ky-table", el("tr", null, el("th", null, "类型"), el("th", null, "原文"), el("th", null, "修改"), el("th", null, "原因")),
        ...r.issues.map((i) => el("tr", null, el("td", null, i.type), el("td", null, i.original), el("td", null, i.fix), el("td", null, i.why))))) : null,
      el("h4", "ky-h4", "修改后的版本"), md(ctx, r.revised, signal),
      h.text ? el("details", "ky-sub", el("summary", null, "原文"), el("pre", "ky-pre", h.text)) : null);
  }

  render();
}
