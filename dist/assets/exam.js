// 快练 / 单科分题型 / 整套全真模考。
import { impactCard } from "./score.js";
import { put, reset, optionsBlock, el, btn, select, field, md, errorBox, toast, runJob, tabs, photoPicker, storedImages, fmtTime, SUBJECTS, inkOverlay, padBoard } from "./ui.js";

const TYPES = {
  数学: ["单选", "填空", "解答"],
  408: ["单选", "解答"],
  英语: ["完形", "阅读", "新题型", "翻译", "小作文", "大作文"],
  政治: ["单选", "多选", "分析"],
};
const CHOICE = ["单选", "多选", "完形", "阅读", "新题型"];
const FULL_MINUTES = 180;

function readPreset() {
  try { const p = JSON.parse(sessionStorage.getItem("ky-exam-preset") || "null"); sessionStorage.removeItem("ky-exam-preset"); return p; } catch { return null; }
}

export function mountExam(ctx, container, signal) {
  const root = el("div", "ky-root");
  put(container, root);
  const preset = readPreset();
  let tab = preset?.mode === "full" ? "full" : preset?.mode === "section" ? "section" : "quick";
  const body = el("div");

  function render() {
    reset(root,
      tabs([["quick", "选择题小套"], ["section", "单科分题型"], ["full", "整套全真模考"], ["history", "记录"]], tab, (k) => { tab = k; render(); }), body);
    reset(body);
    if (tab === "history") renderHistory();
    else if (tab === "full") renderFullSetup();
    else renderSetup(tab);
  }

  function renderSetup(mode) {
    const p = preset && preset.mode === mode ? preset : {};
    const subj = select(SUBJECTS, p.subject || "数学", (v) => { reset(typeBox, ...typeChecks(v, mode)); });
    const typeBox = el("div", "ky-checks");
    const typeChecks = (s, m) => (TYPES[s] || []).filter((t) => m === "section" || CHOICE.includes(t) || t === "填空").map((t) =>
      el("label", "ky-check", el("input", { type: "checkbox", value: t, checked: (p.types || []).includes(t) || (m === "quick" && CHOICE.includes(t)) }), ` ${t}`));
    put(typeBox, ...typeChecks(subj.value, mode));
    const topic = el("input", { class: "ky-input", placeholder: "考点（可留空），如：反常积分 / 二叉树", value: p.topic || "" });
    const count = el("input", { class: "ky-input", type: "number", min: "1", max: "100", value: String(p.count || (mode === "quick" ? 10 : 4)) });
    const minutes = el("input", { class: "ky-input", type: "number", min: "0", max: "300", value: String(p.minutes || (mode === "quick" ? 25 : 80)) });
    const years = el("input", { class: "ky-input", placeholder: "年份（可留空），如 2015-2024", value: p.years || "" });
    const allowGen = el("input", { type: "checkbox", checked: true });
    const out = el("div");
    put(body, el("section", "ky-card",
      el("p", "ky-muted", mode === "quick" ? "从题库随机抽选择 / 填空题限时速刷，交卷自动判分，错题进错题本（英语题不进）。" : "只练某一科的某几类题型（如英语阅读 4 篇限时 80 分钟），阅读按整篇抽取。主观题交卷时拍照作答，AI 按步骤给分。"),
      el("div", "ky-grid2", field("科目", subj), field("考点", topic)),
      field("题型", typeBox),
      el("div", "ky-grid3", field(mode === "section" ? "题数（阅读按篇计入）" : "题数", count), field("限时（分钟，0 = 不限）", minutes), field("年份", years)),
      el("label", "ky-check", allowGen, " 题库里题不够时，让 AI 按真题风格补题"),
      el("div", "ky-row", btn("开始", async () => {
        const types = [...typeBox.querySelectorAll("input:checked")].map((i) => i.value);
        const yr = years.value.match(/(\d{4})\s*[-~–]\s*(\d{4})/);
        const yearList = yr ? Array.from({ length: Number(yr[2]) - Number(yr[1]) + 1 }, (_, i) => Number(yr[1]) + i) : years.value.match(/\d{4}/g)?.map(Number) || [];
        try {
          const r = await runJob(ctx, out, () => ctx.call("quiz.start", { mode, subject: subj.value, types, topic: topic.value.trim(), count: Number(count.value), minutes: Number(minutes.value), years: yearList, allowGenerate: allowGen.checked, title: `${subj.value}${mode === "quick" ? "快练" : `专项·${types.join("/")}`}` }), "组卷");
          startExam(r, Number(minutes.value));
        } catch (err) { reset(out, errorBox(err)); }
      }, "ky-btn ky-btn-primary")),
      out));
  }

  async function renderFullSetup() {
    const out = el("div");
    let papers = [];
    try { papers = await ctx.call("bank.papers"); } catch (err) { put(body, errorBox(err)); return; }
    if (!papers.length) { put(body, el("p", "ky-empty", "题库里还没有整套试卷，先去「题库 → 导入」导入真题。")); return; }
    const pick = select(papers.map((p) => [p.paper, `${p.paper}（${p.count} 题）`]), preset?.paper || papers[0].paper, () => {});
    const minutes = el("input", { class: "ky-input", type: "number", value: String(FULL_MINUTES) });
    put(body, el("section", "ky-card",
      el("p", "ky-muted", "按真实考试：整卷限时 180 分钟，客观题自动判分，主观题拍照上传手写作答，AI 按步骤给分，最后出成绩单，错题自动进错题本（英语题不进）。建议在安静、不被打扰的时间做。"),
      el("div", "ky-grid2", field("试卷", pick), field("限时（分钟）", minutes)),
      btn("开始模考", async () => {
        try {
          const r = await runJob(ctx, out, () => ctx.call("quiz.start", { mode: "full", paper: pick.value, minutes: Number(minutes.value), title: pick.value }), "准备试卷");
          startExam(r, Number(minutes.value));
        } catch (err) { reset(out, errorBox(err)); }
      }, "ky-btn ky-btn-primary"), out));
  }

  async function renderHistory() {
    try {
      const list = await ctx.call("quiz.history");
      if (!list.length) { put(body, el("p", "ky-empty", "还没有完成的练习。")); return; }
      for (const a of list) {
        put(body, el("div", "ky-card ky-meta-row",
          el("b", null, a.title || a.paper || a.subject), el("span", "ky-tag", a.mode === "full" ? "模考" : a.mode === "section" ? "专项" : "快练"),
          el("span", null, `${Math.round(a.got * 10) / 10} / ${a.total} 分`), el("span", "ky-muted", `${fmtTime(a.finishedAt)} · 用时 ${Math.round((a.elapsedSec || 0) / 60)} 分钟`)));
      }
    } catch (err) { put(body, errorBox(err)); }
  }

  // ── 作答 ─────────────────────────────────────────────
  function startExam({ attempt, questions }, minutes) {
    const answers = {};
    const pickers = {};
    const startedAt = Date.now();
    let idx = 0;
    let finished = false;
    const timerEl = el("span", "ky-timer");
    const nav = el("div", "ky-qnav");
    const pane = el("div", "ky-qpane");
    // 批注：笔直接画在题目上（每题分开保存）；关掉才能点选项
    const notes = {};
    let overlay = null;
    let annotating = false;
    let annoTool = "pen";
    const annoBtn = btn("✏️ 批注", () => { annotating = !annotating; syncAnno(); }, "ky-btn ky-eng-annobtn");
    const toolBtn = (key, label) => { const b = btn(label, () => { annoTool = key; syncAnno(); }, "ky-btn ky-btn-sm ky-eng-tool"); b.dataset.tool = key; return b; };
    const annoBar = el("div", "ky-eng-annobar ky-hidden", toolBtn("pen", "红笔"), toolBtn("blue", "蓝笔"), toolBtn("hl", "荧光笔"), toolBtn("erase", "橡皮"),
      btn("撤销", () => overlay?.undo(), "ky-btn ky-btn-sm"), btn("清空本题", () => { if (confirm("清空这题的批注？")) overlay?.clear(); }, "ky-btn ky-btn-sm"));
    function syncAnno() {
      annoBtn.classList.toggle("ky-on", annotating);
      annoBar.classList.toggle("ky-hidden", !annotating);
      pane.classList.toggle("ky-annotating", annotating);
      annoBar.querySelectorAll(".ky-eng-tool").forEach((b) => b.classList.toggle("ky-on", b.dataset.tool === annoTool));
      overlay?.setEnabled(annotating);
      overlay?.setTool(annoTool);
    }
    // 整套题共用一块新窗口白板：换题自动跟过去；选择 / 填空当草稿，解答题「发送到本题」
    const board = padBoard(ctx, {
      key: `board:${attempt.id}`,
      title: attempt.title || attempt.paper || "练习",
      onNav: (dir, qid) => {
        if (finished) return;
        const to = qid ? questions.findIndex((x) => x.id === qid) : idx + dir;
        if (to >= 0 && to < questions.length && to !== idx) { idx = to; draw(); }
      },
      onChange: () => drawNav(),
    });
    const wrap = el("div", "ky-exam",
      el("div", "ky-exam-bar", el("b", null, attempt.title || attempt.paper || "练习"), board.button, annoBtn, timerEl,
        btn("交卷", () => submit(false), "ky-btn ky-btn-primary"),
        btn("放弃", () => { if (confirm("放弃这次练习？作答不会保存。")) { finished = true; clearInterval(tick); render(); } }, "ky-btn ky-btn-ghost")),
      annoBar,
      el("div", "ky-exam-main", nav, pane));
    reset(root, wrap);

    const tick = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      if (minutes > 0) {
        const left = minutes * 60 - sec;
        timerEl.textContent = `剩余 ${Math.floor(Math.max(0, left) / 60)}:${String(Math.max(0, left) % 60).padStart(2, "0")}`;
        timerEl.classList.toggle("ky-warn", left < 300);
        if (left <= 0 && !finished) { toast(root, "时间到，自动交卷"); submit(true); }
      } else timerEl.textContent = `已用 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }, 1000);
    signal.addEventListener("abort", () => clearInterval(tick));

    const answered = (q) => { const a = answers[q.id]; return !!(a && (a.choice || a.text?.trim() || pickers[q.id]?.get().length || !board.isEmpty(q.id))); };
    function drawNav() {
      reset(nav, ...questions.map((q, i) => el("button", { type: "button", class: `ky-qbtn${i === idx ? " ky-on" : ""}${answered(q) ? " ky-answered" : ""}`, onclick: () => { idx = i; draw(); } }, q.number || String(i + 1))));
    }
    function draw() {
      const q = questions[idx];
      answers[q.id] = answers[q.id] || {};
      const a = answers[q.id];
      reset(pane, 
        el("div", "ky-meta-row", el("span", "ky-tag", q.type), el("b", null, `第 ${q.number || idx + 1} 题`), el("span", "ky-muted", `${q.score || ""} 分`)),
        q.material ? el("details", { class: "ky-material", open: true }, el("summary", null, "阅读材料"), md(ctx, q.material, signal)) : null,
        md(ctx, q.hasFigures ? q.stem.replace(/\n*\[图[：:][^\]]*\]\n*/g, "\n\n").trim() : q.stem, signal),
        q.images?.length ? storedImages(ctx, q.images, q.hasFigures ? "ky-figures" : undefined) : null);
      const isChoice = CHOICE.includes(q.type) && q.options.length;
      if (isChoice) {
        const multi = q.type === "多选";
        const opts = el("div", "ky-options");
        for (const o of q.options) {
          const input = el("input", { type: multi ? "checkbox" : "radio", name: `q-${q.id}`, value: o.key, checked: (a.choice || "").includes(o.key) });
          input.addEventListener("change", () => {
            a.choice = multi ? [...opts.querySelectorAll("input:checked")].map((i) => i.value).join("") : o.key;
            drawNav();
          });
          const optText = md(ctx, String(o.text || "").replace(/^\s*[(（]?[A-G][)）.．、]\s*/, ""), signal, "ky-md ky-inline");
          put(opts, el("label", "ky-option", input, el("span", "ky-opt-key", o.key), optText));
        }
        put(pane, opts);
      } else {
        const ta = el("textarea", { class: "ky-input ky-ta", placeholder: q.type === "填空" ? "填写答案" : "可以写关键步骤 / 答案；也可以点上方「白板」在新窗口手写，或拍照" }, a.text || "");
        ta.addEventListener("input", () => { a.text = ta.value; drawNav(); });
        put(pane, ta);
        if (q.type !== "填空") {
          pickers[q.id] = pickers[q.id] || photoPicker("或拍照上传纸上的作答");
          put(pane, board.slot(q.id), pickers[q.id].node);
        }
      }
      put(pane, el("div", "ky-row",
        idx > 0 ? btn("← 上一题", () => { idx--; draw(); }) : null,
        idx < questions.length - 1 ? btn("下一题 →", () => { idx++; draw(); }, "ky-btn ky-btn-primary") : btn("交卷", () => submit(false), "ky-btn ky-btn-primary")));
      drawNav();
      pane.scrollTop = 0;
      overlay?.destroy();
      overlay = inkOverlay(pane, notes[q.id] || (notes[q.id] = []));
      syncAnno();
      const draft = isChoice || q.type === "填空";
      board.focus({
        qid: q.id,
        title: `第 ${q.number || idx + 1} 题 · ${q.type}${draft ? "（草稿）" : ""}`,
        stem: [q.material || "", q.stem, ...(isChoice ? q.options.map((o) => `${o.key}. ${String(o.text || "").replace(/^\s*[(（]?[A-G][)）.．、]\s*/, "")}`) : [])].filter(Boolean).join("\n"),
        mode: draft ? "draft" : "answer",
        index: idx,
        total: questions.length,
      });
    }

    async function submit(auto) {
      if (finished) return;
      const blank = questions.filter((q) => !answered(q)).length;
      if (!auto && blank && !confirm(`还有 ${blank} 题没作答，确定交卷？`)) return;
      finished = true;
      clearInterval(tick);
      const payload = {};
      for (const q of questions) {
        const a = answers[q.id] || {};
        payload[q.id] = { choice: a.choice || "", text: a.text || "", images: [...board.get(q.id), ...(pickers[q.id]?.get() || [])] };
      }
      const out = el("div");
      reset(root, el("h2", "ky-h2", "判分中"), out);
      try {
        const res = await runJob(ctx, out, () => ctx.call("quiz.submit", { attemptId: attempt.id, answers: payload, elapsedSec: Math.round((Date.now() - startedAt) / 1000) }), "判分");
        showResult(res, payload);
      } catch (err) { reset(out, errorBox(err), btn("返回", render)); }
    }
    draw();
  }

  function showResult(res, payload) {
    const pct = res.total ? Math.round((res.got / res.total) * 100) : 0;
    const byType = {};
    for (const q of res.questions) {
      const r = res.results[q.id];
      const t = (byType[q.type] = byType[q.type] || { got: 0, total: 0, n: 0, right: 0 });
      t.got += r.score || 0; t.total += r.max || 0; t.n++; if (r.correct) t.right++;
    }
    const list = el("div");
    reset(root, 
      el("h2", "ky-h2", "成绩单"),
      el("div", "ky-hero", el("div", "ky-hero-num", `${Math.round(res.got * 10) / 10}`), el("div", "ky-hero-text", el("div", "ky-hero-title", `/ ${res.total} 分（${pct}%）`), res.added ? el("div", "ky-muted", `错题 ${res.added} 道已进错题本`) : null)),
      el("table", "ky-table", el("tr", null, el("th", null, "题型"), el("th", null, "正确"), el("th", null, "得分")),
        ...Object.entries(byType).map(([k, v]) => el("tr", null, el("td", null, k), el("td", null, `${v.right}/${v.n}`), el("td", null, `${Math.round(v.got * 10) / 10}/${v.total}`)))),
      impactCard(ctx, res.impact),
      el("div", "ky-row", btn("再来一套", render, "ky-btn ky-btn-primary"), btn("去错题本", () => ctx.app.openView("mistakes"))),
      list);
    for (const q of res.questions) {
      const r = res.results[q.id];
      const a = payload[q.id] || {};
      const det = el("details", { class: `ky-card ${r.correct ? "" : "ky-wrong"}` },
        el("summary", "ky-sum", el("span", null, r.correct ? "✓" : r.correct === null ? "?" : "✗"), el("span", "ky-tag", q.type), el("b", null, `第 ${q.number} 题`), el("span", "ky-muted", `${Math.round((r.score || 0) * 10) / 10}/${r.max} 分${r.errorType ? ` · ${r.errorType}` : ""}`)));
      det.addEventListener("toggle", () => {
        if (!det.open || det.dataset.filled) return;
        det.dataset.filled = "1";
        put(det, md(ctx, q.stem, signal),
          optionsBlock(ctx, q.options, signal),
          el("p", null, `你的作答：${a.choice || a.text || (a.images?.length ? "（手写 / 照片）" : "未作答")}`),
          a.images?.length ? el("div", "ky-thumbs ky-thumbs-big", ...a.images.map((b64) => el("img", { src: `data:image/jpeg;base64,${b64}`, alt: "我的作答" }))) : null,
          el("h4", "ky-h4", "答案"), md(ctx, q.answer || "（题库无答案）", signal),
          q.analysis && q.analysisSource === "AI" ? el("span", "ky-tag ky-tag-ai", "解析为 AI 按标准答案补写 · 非官方") : null,
          q.analysis ? md(ctx, q.analysis, signal) : null,
          r.feedback || r.diagnosis ? el("h4", "ky-h4", "批改 / 错因") : null,
          r.feedback ? md(ctx, r.feedback, signal) : null,
          r.diagnosis ? el("p", null, r.diagnosis) : null);
      });
      put(list, det);
    }
  }

  // 从题库「完成情况」选好的题直接开练
  if (preset?.mode === "ids" && Array.isArray(preset.ids) && preset.ids.length) {
    const out = el("div");
    reset(root, out);
    runJob(ctx, out, () => ctx.call("quiz.start", { mode: "section", subject: preset.subject, ids: preset.ids, minutes: Number(preset.minutes) || 0, title: preset.title || "真题练习" }), "组卷")
      .then((r) => { if (!signal.aborted) startExam(r, Number(preset.minutes) || 0); })
      .catch((err) => { reset(root, errorBox(err)); });
    return;
  }
  render();
}
