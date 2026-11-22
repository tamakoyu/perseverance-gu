// 错题本：今日重做（FSRS）、全部错题、问题清单、录入（手动 / 拍照识别）。
import { put, reset, optionsBlock, el, btn, select, field, md, errorBox, toast, photoPicker, storedImages, runJob, tabs, fmtTime, SUBJECTS, RATINGS, inkPad, padBoard } from "./ui.js";

export function mountMistakes(ctx, container, signal) {
  const root = el("div", "ky-root");
  put(container, root);
  let tab = "due";
  let data = { items: [], reports: [], reviews: [] };
  let errorTypes = [];
  let filter = { subject: "", errorType: "", source: "", q: "", archived: false };
  const body = el("div");
  // 「今日重做」共用一块新窗口白板（可拖到 iPad）：换到下一道错题时白板自动跟过去
  const board = padBoard(ctx, { key: "mistakes:redo", title: "错题重做", when: "判分时", tip: "在系统浏览器里开一块白板（可拖到 iPad）。只开一次，做完一道换下一道时白板会自动跟过去；写完点「发送到本题」" });
  const stripKey = (t) => String(t || "").replace(/^\s*[(（]?[A-G][)）.．、]\s*/, "");

  async function load() {
    try {
      data = await ctx.call("mistakes.list");
      if (!errorTypes.length) errorTypes = (await ctx.call("settings.get")).errorTypes;
    } catch (err) { reset(body, errorBox(err)); return; }
    if (!signal.aborted) render();
  }

  const due = () => data.items.filter((m) => !m.archived && Date.parse(m.card?.due) <= Date.now());

  function render() {
    reset(root, 
      el("h2", "ky-h2", "错题本"),
      tabs([["due", `今日重做（${due().length}）`], ["all", `全部（${data.items.filter((m) => !m.archived).length}）`], ["reviews", `讲题记录（${(data.reviews || []).length}）`], ["reports", `问题清单（${data.reports.length}）`], ["add", "录入错题"]], tab, (k) => { tab = k; render(); }),
      body);
    reset(body);
    if (tab === "due") renderDue();
    else if (tab === "all") renderAll();
    else if (tab === "reviews") renderReviews();
    else if (tab === "reports") renderReports();
    else renderAdd();
  }

  function questionBlock(m, pick) {
    return el("div", "ky-q",
      el("div", "ky-meta-row", el("span", "ky-tag", m.subject), el("span", "ky-tag", m.errorType), el("b", null, m.topic), el("span", "ky-muted", m.source)),
      md(ctx, m.question, signal),
      pick && m.options?.length ? choiceBlock(m, pick) : optionsBlock(ctx, m.options, signal),
      m.images?.length ? storedImages(ctx, m.images) : null);
  }

  // 选择题重做：可以直接点选项（单选；再点一次取消）
  function choiceBlock(m, pick) {
    const opts = el("div", "ky-options");
    for (const o of m.options) {
      const input = el("input", { type: "radio", name: `redo-${m.id}`, value: o.key });
      input.addEventListener("click", () => {
        if (pick.get() === o.key) { input.checked = false; pick.set(""); } else pick.set(o.key);
      });
      put(opts, el("label", "ky-option", input, el("span", "ky-opt-key", o.key), md(ctx, stripKey(o.text), signal, "ky-md ky-inline")));
    }
    return opts;
  }

  // 错因 / 作答里也有 LaTeX，统一按 Markdown 渲染
  const reasonBlock = (m) => md(ctx, `**${m.errorType || "其他"}**：${m.diagnosis || "—"}`, signal);
  const answerBlock = (label, text) => (text ? el("div", "ky-muted", el("span", null, `${label}：`), md(ctx, text, signal, "ky-md ky-inline")) : null);

  // ── 今日重做 ─────────────────────────────────────────
  function renderDue() {
    const list = due().sort((a, b) => Date.parse(a.card.due) - Date.parse(b.card.due));
    if (!list.length) { put(body, el("p", "ky-empty", "今天没有到期的错题 🎉")); return; }
    const m = list[0];
    const started = Date.now();
    // 每次重做一个新槽位：同一道错题下次再到期时白板是干净的
    const qid = `${m.id}:${m.history?.length || 0}`;
    put(body, el("div", "ky-row", el("span", "ky-muted", `还剩 ${list.length} 道`), board.button));
    const card = el("section", "ky-card");
    const isChoice = !!m.options?.length;
    let chosen = "";
    const pick = { get: () => chosen, set: (k) => { chosen = k; } };
    const answer = el("textarea", { class: "ky-input ky-ta", placeholder: isChoice ? "点上面的选项作答；想写理由或草稿也可以写在这里" : "重新做一遍，写下答案或关键步骤；也可以在下面的画板 / 新窗口白板手写，或拍照" });
    const answerText = () => [chosen ? `选 ${chosen}` : "", answer.value.trim()].filter(Boolean).join("\n");
    const pad = inkPad({ height: 420, label: "手写作答（判分时一起提交）" });
    const photos = photoPicker("拍照作答");
    const reveal = el("div");
    const actions = el("div", "ky-row");
    put(card, questionBlock(m, isChoice ? pick : null), field(isChoice ? "补充说明（可不填）" : "这次的作答", answer), board.slot(qid), pad.node, photos.node, actions, reveal);
    put(body, card);
    board.focus({
      qid,
      title: `错题重做 · ${[m.subject, m.topic].filter(Boolean).join(" · ")}`,
      stem: [m.question || "", ...(m.options || []).map((o) => `${o.key}. ${stripKey(o.text)}`)].filter(Boolean).join("\n"),
      mode: "answer",
      index: 0,
      total: 1,
    });
    const handwriting = () => { const ink = pad.get(); return [...board.get(qid), ...(ink ? [ink] : []), ...photos.get()]; };

    const showAnswer = (feedback) => {
      reset(actions);
      reset(reveal, 
        feedback ? el("div", { class: `ky-verdict ${feedback.correct ? "ky-ok" : "ky-bad"}` }, `${feedback.correct ? "✓ 做对了" : "✗ 还有问题"}（${feedback.score ?? ""}）`) : null,
        feedback ? md(ctx, feedback.feedback, signal) : null,
        feedback?.transcript ? el("details", "ky-material", el("summary", null, "手写识别结果"), md(ctx, feedback.transcript, signal)) : null,
        el("h4", "ky-h4", "正确答案"), md(ctx, m.correctAnswer || "（未记录）", signal),
        el("h4", "ky-h4", "上次的错因"), reasonBlock(m),
        answerBlock("上次的作答", m.learnerAnswer),
        el("h4", "ky-h4", "这次掌握得怎么样？"),
        el("div", "ky-row", ...RATINGS.map(([r, label, cls]) => btn(label, async () => {
          try {
            const said = [answerText(), feedback?.transcript ? `【手写】${feedback.transcript}` : ""].filter(Boolean).join("\n");
            await ctx.call("mistakes.rate", { id: m.id, rating: r, correct: feedback ? !!feedback.correct : r > 1, answer: said, feedback: feedback?.feedback || "" });
            board.forget(qid);
            await ctx.call("activity.log", { subject: m.subject, minutes: Math.round((Date.now() - started) / 60000), kind: "redo" });
          } catch (err) { toast(root, err.message, "error"); }
          load();
        }, `ky-btn ${cls}`))));
    };
    put(actions, 
      btn("AI 判分", async () => {
        const imgs = handwriting();
        if (!answerText() && !imgs.length) { toast(root, isChoice ? "先选一个选项" : "先写下作答、手写或拍照"); return; }
        try {
          const res = await runJob(ctx, reveal, () => ctx.call("mistakes.check", { id: m.id, answer: answerText(), images: imgs }), "判分");
          showAnswer(res);
        } catch (err) { reset(reveal, errorBox(err)); }
      }, "ky-btn ky-btn-primary"),
      btn("直接看答案（自评）", () => showAnswer(null)));
  }

  // ── 全部错题 ─────────────────────────────────────────
  function renderAll() {
    const bar = el("div", "ky-row ky-filters",
      select([["", "全部科目"], ...SUBJECTS], filter.subject, (v) => { filter.subject = v; render(); }),
      select([["", "全部错因"], ...[...new Set([...errorTypes, ...data.items.map((m) => m.errorType)])]], filter.errorType, (v) => { filter.errorType = v; render(); }),
      select([["", "全部来源"], ...[...new Set(data.items.map((m) => m.source).filter(Boolean))]], filter.source, (v) => { filter.source = v; render(); }),
      (() => { const i = el("input", { class: "ky-input", placeholder: "搜索题目 / 考点", value: filter.q }); i.addEventListener("change", () => { filter.q = i.value; render(); }); return i; })(),
      el("label", "ky-check", (() => { const c = el("input", { type: "checkbox", checked: filter.archived }); c.addEventListener("change", () => { filter.archived = c.checked; render(); }); return c; })(), " 显示已归档"));
    put(body, bar);
    const items = data.items.filter((m) => (filter.archived || !m.archived)
      && (!filter.subject || m.subject === filter.subject)
      && (!filter.errorType || m.errorType === filter.errorType)
      && (!filter.source || m.source === filter.source)
      && (!filter.q || `${m.topic} ${m.question}`.includes(filter.q))).reverse();
    const counts = {};
    for (const m of items) counts[m.errorType] = (counts[m.errorType] || 0) + 1;
    put(body, el("div", "ky-pills", ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => el("span", "ky-pill", `${k} ${v}`))));
    if (!items.length) { put(body, el("p", "ky-empty", "没有符合条件的错题")); return; }
    for (const m of items) {
      const det = el("details", { class: `ky-card${m.archived ? " ky-dim" : ""}` });
      const nextDue = m.card?.due ? `下次 ${fmtTime(m.card.due)}` : "";
      put(det, el("summary", "ky-sum", el("span", "ky-tag", m.subject), el("span", "ky-tag", m.errorType), el("b", null, m.topic), el("span", "ky-muted", `${m.source} · ${nextDue} · 重做 ${m.history?.length || 0} 次`)));
      det.addEventListener("toggle", () => {
        if (!det.open || det.dataset.filled) return;
        det.dataset.filled = "1";
        put(det, questionBlock(m),
          el("h4", "ky-h4", "正确答案"), md(ctx, m.correctAnswer || "（未记录）", signal),
          el("h4", "ky-h4", "诊断"), reasonBlock(m),
          answerBlock("当时作答", m.learnerAnswer),
          el("div", "ky-row",
            m.chatId ? btn("打开来源会话", () => ctx.app.openSession(m.chatId), "ky-btn ky-btn-ghost") : null,
            btn(m.archived ? "取消归档" : "归档（已彻底掌握）", async () => { await ctx.call("mistakes.update", { id: m.id, patch: { archived: !m.archived } }); load(); }),
            btn("编辑", () => editDialog(m)),
            btn("删除", async () => { if (confirm("删除这道错题？")) { await ctx.call("mistakes.delete", { id: m.id }); load(); } }, "ky-btn ky-btn-danger")));
      });
      put(body, det);
    }
  }

  function editDialog(m) {
    const f = {
      options: el("textarea", { class: "ky-input ky-ta", placeholder: "选择题每行一个选项，如：A. 能，1 仍是它的周期（不是选择题就留空）" }, (m.options || []).map((o) => `${o.key}. ${stripKey(o.text)}`).join("\n")),
      topic: el("input", { class: "ky-input", value: m.topic }),
      errorType: el("input", { class: "ky-input", value: m.errorType, list: "ky-errtypes" }),
      question: el("textarea", { class: "ky-input ky-ta" }, m.question),
      correctAnswer: el("textarea", { class: "ky-input ky-ta" }, m.correctAnswer),
      diagnosis: el("textarea", { class: "ky-input" }, m.diagnosis),
    };
    const subj = select(SUBJECTS, m.subject, () => {});
    const handle = ctx.ui.openDialog({
      title: "编辑错题",
      content: el("div", "ky-dialog",
        el("h3", "ky-h3", "编辑错题"),
        el("datalist", { id: "ky-errtypes" }, ...errorTypes.map((t) => el("option", { value: t }))),
        field("科目", subj), field("考点", f.topic), field("错因", f.errorType), field("题目", f.question), field("选项", f.options), field("正确答案", f.correctAnswer), field("诊断", f.diagnosis),
        el("div", "ky-row", btn("保存", async () => {
          const options = f.options.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
            const k = l.match(/^\s*[(（]?([A-Ga-g])[)）.．、:：]\s*/);
            return { key: k ? k[1].toUpperCase() : String.fromCharCode(65 + i), text: k ? l.slice(k[0].length) : l };
          });
          await ctx.call("mistakes.update", { id: m.id, patch: { options, subject: subj.value, topic: f.topic.value, errorType: f.errorType.value, question: f.question.value, correctAnswer: f.correctAnswer.value, diagnosis: f.diagnosis.value } });
          handle.dispose();
          load();
        }, "ky-btn ky-btn-primary"), btn("取消", () => handle.dispose()))),
    }, { signal });
  }

  // ── 问题清单 ─────────────────────────────────────────
  // ── 讲题记录：会话里拍照交卷、老师判卷后的批改表 ─────────
  function renderReviews() {
    const list = (data.reviews || []).slice().sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    if (!list.length) { put(body, el("p", "ky-empty", "在讲课 / 练习会话里直接发做完的试卷或题目照片（也可以以「【讲题】」开头），老师判完卷后批改表会出现在这里，错题自动进错题本。")); return; }
    const byId = new Map(data.items.map((m) => [m.id, m]));
    for (const r of list) {
      const wrong = r.items.filter((x) => !x.correct).length;
      const det = el("details", "ky-card");
      put(det, el("summary", "ky-sum",
        r.subject ? el("span", "ky-tag", r.subject) : null,
        el("b", null, r.title || "讲题"),
        el("span", "ky-muted", `${fmtTime(r.updatedAt || r.createdAt)} · ${r.items.length} 题 · 错 ${wrong} 题${r.total != null ? ` · ${r.got}/${r.total} 分` : ""}`)));
      det.addEventListener("toggle", () => {
        if (!det.open || det.dataset.filled) return;
        det.dataset.filled = "1";
        const counts = {};
        for (const x of r.items) if (!x.correct && x.errorType) counts[x.errorType] = (counts[x.errorType] || 0) + 1;
        put(det,
          Object.keys(counts).length ? el("div", "ky-pills", ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => el("span", "ky-pill", `${k} ${v}`))) : null,
          el("table", "ky-table",
            el("tr", null, el("th", null, "题号"), el("th", null, "对错"), el("th", null, "得分"), el("th", null, "知识点"), el("th", null, "错因")),
            ...r.items.map((x) => el("tr", null,
              el("td", null, x.number),
              el("td", { class: x.correct ? "ky-ok" : "ky-bad" }, x.correct ? "✓" : "✗"),
              el("td", null, x.score != null ? `${x.score}${x.fullScore != null ? `/${x.fullScore}` : ""}` : "—"),
              el("td", null, x.topic || "—"),
              el("td", null, x.correct ? "" : md(ctx, [x.errorType, byId.get(x.mistakeId)?.diagnosis].filter(Boolean).join("：") || "—", signal, "ky-md ky-md-cell"))))),
          el("div", "ky-row",
            btn("打开会话", () => ctx.app.openSession(r.chatId), "ky-btn ky-btn-ghost"),
            wrong ? btn("在错题本里看这些错题", () => { filter = { ...filter, source: "讲题会话", q: "" }; tab = "all"; render(); }, "ky-btn ky-btn-ghost") : null,
            btn("删除这条记录", async () => { if (confirm("只删除批改记录，错题本里的错题保留。确定？")) { await ctx.call("reviews.delete", { id: r.id }); load(); } }, "ky-btn ky-btn-danger")));
      });
      put(body, det);
    }
  }

  function renderReports() {
    if (!data.reports.length) { put(body, el("p", "ky-empty", "完成一次学习模式（【学习】开头的讲课会话）的综合小测后，问题清单会出现在这里。")); return; }
    for (const r of data.reports.slice().reverse()) {
      put(body, el("section", "ky-card",
        el("div", "ky-meta-row", el("b", null, r.goal), el("span", "ky-muted", `${fmtTime(r.createdAt)}${r.quizScore ? ` · 小测 ${r.quizScore}` : ""}`)),
        el("p", null, r.summary),
        r.weakPoints?.length ? el("div", null, el("h4", "ky-h4", "薄弱点"), el("ul", "ky-ul", ...r.weakPoints.map((w) => el("li", null, el("span", "ky-tag", w.errorType), ` ${w.point} —— `, el("span", "ky-muted", w.advice))))) : null,
        r.mastered?.length ? el("div", null, el("h4", "ky-h4", "已掌握"), el("p", null, r.mastered.join("；"))) : null,
        r.reviewList?.length ? el("div", null, el("h4", "ky-h4", "复习建议"), el("ul", "ky-ul", ...r.reviewList.map((x) => el("li", null, x)))) : null,
        btn("打开会话", () => ctx.app.openSession(r.chatId), "ky-btn ky-btn-ghost")));
    }
  }

  // ── 录入 ─────────────────────────────────────────────
  function renderAdd() {
    const source = el("input", { class: "ky-input", placeholder: "如：660 题 第 123 题 / 1000 题 A 组 / 王道课后题" });
    const photos = photoPicker("拍题目照片（可多张）");
    const out = el("div");
    put(body, el("section", "ky-card",
      el("h3", "ky-h3", "拍照识别（纸质书上的错题）"),
      el("p", "ky-muted", "拍下题目（最好连同自己的错误作答），AI 识别成文字，你检查修改后保存。照片会一起保存，方便看原图。"),
      field("来源", source), photos.node,
      btn("识别", async () => {
        if (!photos.get().length) { toast(root, "请先添加照片"); return; }
        const shots = photos.get();
        try {
          const res = await runJob(ctx, out, () => ctx.call("mistakes.ocr", { images: shots, source: source.value }), "识别");
          reset(out, ...(res.items.length ? res.items : [{}]).map((it) => draftForm({ ...it, source: source.value || "纸质书" }, shots)));
        } catch (err) { reset(out, errorBox(err)); }
      }, "ky-btn ky-btn-primary"),
      out));
    put(body, el("section", "ky-card", el("h3", "ky-h3", "手动录入"), draftForm({ source: "手动录入" }, [])));
  }

  function draftForm(it, shots) {
    const subj = select(SUBJECTS, it.subject || "数学", () => {});
    const f = {
      topic: el("input", { class: "ky-input", value: it.topic || "", placeholder: "考点，如：反常积分" }),
      question: el("textarea", { class: "ky-input ky-ta", placeholder: "题目（支持 Markdown / LaTeX）" }, it.question || ""),
      learnerAnswer: el("textarea", { class: "ky-input", placeholder: "我当时的作答 / 思路" }, it.learnerAnswer || ""),
      correctAnswer: el("textarea", { class: "ky-input ky-ta", placeholder: "正确答案与关键步骤" }, it.correctAnswer || ""),
      errorType: el("input", { class: "ky-input", list: "ky-errtypes2", value: it.errorType || "", placeholder: "错因类型" }),
      diagnosis: el("textarea", { class: "ky-input", placeholder: "错在哪、为什么错" }, it.diagnosis || ""),
    };
    const keepPhotos = el("input", { type: "checkbox", checked: shots.length > 0 });
    const extra = shots.length ? null : photoPicker("附加照片");
    const msg = el("div");
    const form = el("div", "ky-draft",
      el("datalist", { id: "ky-errtypes2" }, ...errorTypes.map((t) => el("option", { value: t }))),
      el("div", "ky-grid2", field("科目", subj), field("考点", f.topic)),
      field("题目", f.question), field("我的作答", f.learnerAnswer), field("正确答案", f.correctAnswer),
      el("div", "ky-grid2", field("错因", f.errorType), field("诊断", f.diagnosis)),
      shots.length ? el("label", "ky-check", keepPhotos, " 保存原始照片") : extra.node,
      el("div", "ky-row",
        btn("AI 分析错因", async () => {
          try {
            const r = await runJob(ctx, msg, () => ctx.call("mistakes.diagnose", { question: f.question.value, learnerAnswer: f.learnerAnswer.value, correctAnswer: f.correctAnswer.value, images: shots.length ? shots : extra.get() }), "分析");
            f.errorType.value = r.errorType || f.errorType.value;
            f.diagnosis.value = r.diagnosis || f.diagnosis.value;
            if (!f.correctAnswer.value && r.correctAnswer) f.correctAnswer.value = r.correctAnswer;
          } catch (err) { reset(msg, errorBox(err)); }
        }),
        btn("保存到错题本", async () => {
          try {
            const imgs = shots.length ? (keepPhotos.checked ? shots : []) : extra.get();
            const ids = [];
            for (const d of imgs) ids.push((await ctx.call("image.save", { data: d })).id);
            await ctx.call("mistakes.add", { subject: subj.value, topic: f.topic.value, source: it.source, question: f.question.value, learnerAnswer: f.learnerAnswer.value, correctAnswer: f.correctAnswer.value, errorType: f.errorType.value, diagnosis: f.diagnosis.value, images: ids });
            reset(form, el("p", "ky-ok", `✓ 已保存：${f.topic.value || "错题"}`));
            data = await ctx.call("mistakes.list");
          } catch (err) { reset(msg, errorBox(err)); }
        }, "ky-btn ky-btn-primary")),
      msg);
    return form;
  }

  const off = ctx.onNotification((n) => { if (n.topic === "changed" && ["mistakes", "reviews"].includes(n.data?.what) && tab !== "due" && tab !== "add") load(); });
  signal.addEventListener("abort", off);
  put(root, el("p", "ky-muted", "加载中…"));
  load();
}
