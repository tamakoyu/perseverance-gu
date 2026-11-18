// 今日学习面板：倒计时、阶段、今日任务（从周计划挑出今天的）、到期复习、学习时长。
import { put, reset, el, btn, select, errorBox, SUBJECTS, copy, toast } from "./ui.js";

const COLORS = { 数学: "#4f7cff", 408: "#18a058", 英语: "#e8a33d", 政治: "#d0505b", 其他: "#8a8f98" };
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`);

export function mountToday(ctx, container, signal) {
  const root = el("div", "ky-root");
  put(container, root);

  async function load() {
    let d;
    try { d = await ctx.call("today"); } catch (err) { reset(root, errorBox(err)); return; }
    if (signal.aborted) return;
    reset(root, header(d), planBlock(d), dueRow(d), timeBlock(d), tipBlock());
  }

  function header(d) {
    return el("div", "ky-hero",
      el("div", "ky-hero-num", d.daysLeft > 0 ? String(d.daysLeft) : "—"),
      el("div", "ky-hero-text",
        el("div", "ky-hero-title", d.daysLeft > 0 ? "天后初试" : "初试日期已过，请在设置里更新"),
        el("div", "ky-muted", `${d.date} · 当前阶段：${d.stage.name} · 初试 ${d.examDate}`),
        el("div", "ky-stages", ...d.stages.map((s) => el("span", { class: `ky-stage${s.name === d.stage.name ? " ky-on" : ""}` }, s.name)))));
  }

  function dueRow(d) {
    const card = (title, n, total, action, label) => el("div", "ky-stat",
      el("div", "ky-stat-n", String(n)),
      el("div", "ky-stat-t", title),
      el("div", "ky-muted", `共 ${total}`),
      n ? btn(label, action, "ky-btn ky-btn-primary") : el("div", "ky-muted", "今天没有到期"));
    return el("div", "ky-stats",
      card("到期错题", d.due.mistakes, d.due.mistakesTotal, () => ctx.app.openView("mistakes"), "开始重做"),
      card("到期生词", d.due.vocab, d.due.vocabTotal, () => ctx.app.openView("english"), "开始复习"),
      el("div", "ky-stat",
        el("div", "ky-stat-n", "🃏"),
        el("div", "ky-stat-t", "记忆卡"),
        el("div", "ky-muted", "在侧边栏 Flashcards 复习"),
        btn("去模考 / 快练", () => ctx.app.openView("exam"), "ky-btn")));
  }

  // 把一条任务拆成「标题 / 补充说明 / 小标签」
  function splitTask(text) {
    const parts = text.split(/\s*·\s+|\s+·\s*/);
    let title = parts.shift();
    let detail = "";
    const colon = title.search(/[：:]/);
    if (colon > 0) { detail = title.slice(colon + 1).trim(); title = title.slice(0, colon).trim(); }
    else {
      const m = title.match(/^(.*?)（([^（）]{9,})）$/);
      if (m) { title = m[1].trim(); detail = m[2]; }
    }
    return { title, detail, chips: parts };
  }

  function taskRow(d, t, subject, { showDate = false } = {}) {
    const { title, detail, chips } = splitTask(t.text);
    const cb = el("input", { type: "checkbox", class: "ky-tcheck", checked: t.done });
    const row = el("label", { class: `ky-titem${t.done ? " ky-done" : ""}`, style: `--c:${COLORS[subject] || COLORS.其他}` },
      cb,
      el("div", "ky-tbody",
        el("div", "ky-ttitle",
          showDate ? el("span", "ky-tchip ky-tchip-warn", t.mmdd) : null,
          el("span", null, title),
          t.kind === "daily" ? el("span", "ky-tchip", "每日") : null,
          ...chips.map((c) => el("span", "ky-tchip", c))),
        detail ? el("div", "ky-tdetail", detail) : null));
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        if (t.kind === "daily") await ctx.call("plan.toggleDaily", { key: t.key, done: cb.checked });
        else t.raw = (await ctx.call("plan.toggle", { path: d.plan.path, line: t.line, raw: t.raw, done: cb.checked })).raw;
        t.done = cb.checked;
        row.classList.toggle("ky-done", cb.checked);
        refreshProgress();
      } catch (err) { cb.checked = !cb.checked; toast(root, err.message, "error"); }
      cb.disabled = false;
    });
    return row;
  }

  let refreshProgress = () => {};

  function planBlock(d) {
    const box = el("section", "ky-card ky-plan");
    const p = d.plan;
    const [, mm, dd] = d.date.split("-").map(Number);
    const head = (extra) => el("div", "ky-plan-head",
      el("div", null,
        el("h3", "ky-h3", "今日任务"),
        el("div", "ky-muted", `${p.weekday ? `${p.weekday} · ` : ""}${mm}月${dd}日`)),
      extra);
    if (d.planError) { put(box, head(), el("p", "ky-muted", d.planError)); return box; }
    if (!p.found) { put(box, head(), el("p", "ky-muted", "在 Obsidian 的 计划/ 里没找到覆盖今天的周计划。")); return box; }

    const all = p.subjects.flatMap((s) => s.tasks);
    const ring = el("div", "ky-ring");
    const ringText = el("div", "ky-ring-text");
    const ringWrap = el("div", "ky-ring-wrap", ring, ringText);
    put(box, head(all.length ? ringWrap : null));

    const restDay = p.subjects.length && p.subjects.filter((s) => s.rest).length >= p.subjects.length - 1 && p.subjects.some((s) => s.rest);
    if (restDay) put(box, el("div", "ky-restday", "☕ 今天是休息日，只留每日任务"));
    if (!p.inTable) put(box, el("p", "ky-hint", "周计划的「每日安排」表里没有今天这一行，下面按日期和「下一项」推测。"));

    const list = el("div", "ky-tlist");
    for (const s of p.subjects) {
      if (!s.tasks.length && !s.rest) continue;
      const done = s.tasks.filter((t) => t.done).length;
      const sec = el("div", { class: "ky-tsec", style: `--c:${COLORS[s.subject] || COLORS.其他}` },
        el("div", "ky-tsec-head",
          el("span", "ky-tdot"),
          el("span", "ky-tsec-name", s.subject === "其他" ? s.group : s.subject),
          s.rest ? el("span", "ky-tchip", "休息") : el("span", "ky-muted ky-tsec-count", `${done}/${s.tasks.length}`)));
      for (const t of s.tasks) put(sec, taskRow(d, t, s.subject));
      put(list, sec);
    }
    put(box, list);

    if (p.overdue.length) {
      const det = el("details", "ky-overdue",
        el("summary", "ky-sum", el("span", null, `之前没完成的 ${p.overdue.length} 项`)));
      for (const t of p.overdue) put(det, taskRow(d, t, t.subject, { showDate: true }));
      put(box, det);
    }

    put(box, el("div", "ky-plan-foot ky-hint", `来自 ${p.path}`));

    refreshProgress = () => {
      const n = all.filter((t) => t.done).length;
      const pct = all.length ? Math.round((n / all.length) * 100) : 0;
      ring.style.setProperty("--p", pct);
      reset(ringText, el("b", null, `${n}/${all.length}`));
      ringWrap.classList.toggle("ky-ring-full", all.length > 0 && n === all.length);
      for (const sec of list.children) {
        const items = sec.querySelectorAll(".ky-titem");
        const c = sec.querySelector(".ky-tsec-count");
        if (c) c.textContent = `${sec.querySelectorAll(".ky-titem.ky-done").length}/${items.length}`;
      }
    };
    refreshProgress();
    return box;
  }

  function timeBlock(d) {
    const t = d.time;
    const box = el("section", "ky-card", el("h3", "ky-h3", "学习时长"));
    const pills = (obj) => {
      const entries = Object.entries(obj).filter(([, v]) => v > 0);
      if (!entries.length) return el("span", "ky-muted", "还没有记录");
      return el("div", "ky-pills", ...entries.map(([k, v]) => el("span", { class: "ky-pill", style: `--c:${COLORS[k] || COLORS.其他}` }, `${k} ${fmtMin(v)}`)));
    };
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    put(box, el("div", "ky-row", el("b", null, `今天 ${fmtMin(sum(t.today))}`), pills(t.today)));
    put(box, el("div", "ky-row", el("b", null, `本周 ${fmtMin(sum(t.week))}`), pills(t.week)));
    const max = Math.max(60, ...t.byDay.map((r) => sum(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "day")))));
    const chart = el("div", "ky-bars");
    for (const r of t.byDay) {
      const col = el("div", "ky-bar-col");
      const stack = el("div", "ky-bar-stack");
      for (const [k, v] of Object.entries(r)) {
        if (k === "day" || !v) continue;
        put(stack, el("div", { class: "ky-bar-seg", style: `height:${(v / max) * 100}%;background:${COLORS[k] || COLORS.其他}`, title: `${k} ${fmtMin(v)}` }));
      }
      put(col, stack, el("div", "ky-bar-label", r.day.slice(5)));
      put(chart, col);
    }
    put(box, chart);
    if (t.recent.length) {
      put(box, el("div", "ky-group", "最近的会话（科目分错了可以改）"));
      for (const s of t.recent.slice(0, 8)) {
        put(box, el("div", "ky-row",
          el("button", { type: "button", class: "ky-link", onclick: () => ctx.app.openSession(s.id) }, s.title || "未命名会话"),
          select([...SUBJECTS, "其他"], s.subject, async (v) => {
            await ctx.call("settings.save", { sessionSubject: { id: s.id, subject: v } });
            load();
          }, "ky-input ky-input-sm")));
      }
    }
    put(box, el("p", "ky-hint", "时长按会话消息时间估算（超过 15 分钟没动静视为离开），加上快练 / 模考 / 错题重做的用时。"));
    return box;
  }

  function tipBlock() {
    const input = el("input", { class: "ky-input", placeholder: "例如：比较判别法" });
    return el("section", "ky-card",
      el("h3", "ky-h3", "学习模式"),
      el("p", "ky-muted", "新建讲课会话，第一句以「【学习】」开头：跳过测底，先讲后考，错题自动进错题本，讲完生成问题清单并询问是否导出到 Obsidian。"),
      el("div", "ky-row", input, btn("复制开场白", async () => {
        const text = `【学习】${input.value.trim() || "（知识点）"}`;
        toast(root, (await copy(text)) ? `已复制：${text}，去新建讲课会话粘贴` : text);
      })));
  }

  const off = ctx.onNotification((n) => { if (n.topic === "changed") load(); });
  signal.addEventListener("abort", off);
  put(root, el("p", "ky-muted", "加载中…"));
  load();
}
