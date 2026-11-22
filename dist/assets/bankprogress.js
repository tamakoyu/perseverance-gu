// 数学 / 408 真题完成情况：年份 × 题型的格子图（像英语专项总览），点题选中后直接开练。
// 「做过」包括快练 / 模考、教学和练习会话里用真题出的题（kaoyan_bank_record）、错题本重做。
import { put, reset, el, btn, errorBox, toast, fmtTime } from "./ui.js";

const SUBJECTS = [["数学", "数学一"], ["408", "408"]];
const PER_MIN = { 数学: { 单选: 4, 填空: 4, 解答: 14 }, 408: { 单选: 2, 解答: 15 } };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function status(q) {
  if (!q.last) return "ky-s-todo";
  if (q.last.correct === true) return "ky-s-good";
  if (q.last.correct === false) {
    const r = q.last.max ? q.last.score / q.last.max : 0;
    return r >= 0.5 ? "ky-s-mid" : "ky-s-bad";
  }
  return "ky-s-mid";
}

export function mountBankProgress(ctx, host, signal) {
  const root = el("div", "ky-eng ky-bp");
  put(host, root);
  let subject = "数学";
  try { subject = localStorage.getItem("ky-bp-subject") || "数学"; } catch { /* 忽略 */ }
  const picked = new Set();
  let focus = null;
  let filter = "";

  async function load() {
    reset(root, el("p", "ky-muted", "加载中…"));
    let data;
    try { data = await ctx.call("bank.overview", { subject }); } catch (err) { reset(root, errorBox(err)); return; }
    if (signal.aborted) return;
    draw(data);
  }

  function draw(data) {
    picked.clear(); focus = null;
    const all = data.papers.flatMap((p) => p.questions.map((q) => ({ ...q, paper: p.paper, year: p.year })));
    const byId = new Map(all.map((q) => [q.id, q]));
    const types = ["单选", "多选", "填空", "解答"].filter((t) => data.types.includes(t)).concat(data.types.filter((t) => !["单选", "多选", "填空", "解答"].includes(t)));
    const done = all.filter((q) => q.last);
    const right = done.filter((q) => q.last.correct === true).length;
    const mistakes = all.filter((q) => q.mistake).length;

    const subjBtns = el("div", "ky-bp-subj", ...SUBJECTS.map(([k, label]) =>
      btn(label, () => { subject = k; try { localStorage.setItem("ky-bp-subject", k); } catch { /* 忽略 */ } load(); }, `ky-btn ky-btn-sm${k === subject ? " ky-btn-primary" : ""}`)));
    const summary = el("section", "ky-card ky-eng-summary",
      el("div", "ky-eng-sumhead",
        el("div", null, el("h3", "ky-h3", `${subject === "数学" ? "数学一" : "408"}真题完成情况`),
          el("div", "ky-muted", `${data.papers.length} 套 · ${all.length} 题 · 已做 ${done.length} 题（${pct(done.length, all.length)}%）${done.length ? ` · 最近一次做对 ${pct(right, done.length)}%` : ""}${mistakes ? ` · 错题本里 ${mistakes} 题` : ""}`)),
        el("div", "ky-row", subjBtns, btn("刷新", load, "ky-btn ky-btn-sm"))),
      el("div", "ky-eng-bars", ...types.map((t) => {
        const qs = all.filter((q) => q.type === t);
        const d = qs.filter((q) => q.last);
        const ok = d.filter((q) => q.last.correct === true).length;
        return el("div", "ky-eng-bar",
          el("div", "ky-eng-bar-top", el("span", null, t), el("span", "ky-muted", `${d.length}/${qs.length}`)),
          el("div", "ky-progress ky-progress-static",
            el("div", { class: "ky-progress-done", style: `width:${pct(ok, qs.length)}%` }),
            el("div", { class: "ky-bp-wrong", style: `width:${pct(d.length - ok, qs.length)}%` })));
      })));

    if (!all.length) {
      reset(root, summary, el("p", "ky-empty", "题库里还没有这一科的真题。去「导入」导入真题。"));
      return;
    }

    const search = el("input", { class: "ky-input ky-bp-filter", placeholder: "按考点筛选，如：反常积分 / 二叉树", value: filter });
    const match = (q) => !filter || filter.split(/\s+/).filter(Boolean).every((w) => `${q.topics.join(" ")} ${q.type}`.toLowerCase().includes(w.toLowerCase()));
    const chips = new Map();

    const table = el("table", "ky-eng-grid ky-bp-grid");
    put(table, el("thead", null, el("tr", null, el("th", null, "年份"),
      ...types.map((t) => el("th", null, el("button", { type: "button", class: "ky-eng-colbtn", title: `选中所有没做过的${t}题（受筛选影响）`, onclick: () => pickMany(all.filter((q) => q.type === t)) }, t))))));
    const tbody = el("tbody");
    const rows = [];
    for (const p of data.papers) {
      const qs = p.questions.map((q) => byId.get(q.id));
      const d = qs.filter((q) => q.last).length;
      const tr = el("tr", null, el("th", null,
        el("button", { type: "button", class: "ky-eng-yearbtn", title: "选中这一年没做过的题", onclick: () => pickMany(qs) }, String(p.year || p.paper)),
        el("div", "ky-bp-yearsub", `${d}/${qs.length}`)));
      for (const t of types) {
        const cell = el("td", "ky-bp-cell");
        for (const q of qs.filter((x) => x.type === t)) put(cell, chip(q));
        put(tr, cell);
      }
      rows.push([tr, qs]);
      put(tbody, tr);
    }
    put(table, tbody);

    function chip(q) {
      const b = el("button", { type: "button", class: "ky-bp-chip" });
      const paint = () => {
        b.className = `ky-bp-chip ${status(q)}${picked.has(q.id) ? " ky-sel" : ""}${focus === q.id ? " ky-focus" : ""}${match(q) ? "" : " ky-bp-dim"}${q.mistake ? " ky-bp-mis" : ""}`;
        b.title = `${q.paper} 第${q.number}题 · ${q.topics.join("、") || "（无考点）"}${q.last ? ` · 上次${q.last.correct === true ? "做对" : q.last.correct === false ? "做错" : "已做"}（${q.last.source}）` : " · 没做过"}`;
        reset(b, String(q.number).replace(/^第/, "").replace(/题$/, ""), q.count > 1 ? el("sup", null, `×${q.count}`) : null);
      };
      b.addEventListener("click", () => {
        if (picked.has(q.id) && focus === q.id) picked.delete(q.id);
        else picked.add(q.id);
        focus = picked.has(q.id) ? q.id : null;
        refresh();
      });
      chips.set(q.id, paint);
      return b;
    }
    function pickMany(qs) {
      const pool = qs.filter((q) => !q.last && match(q));
      if (!pool.length) { toast(root, filter ? "符合筛选的都做过了" : "都做过了"); return; }
      const allOn = pool.every((q) => picked.has(q.id));
      for (const q of pool) { if (allOn) picked.delete(q.id); else picked.add(q.id); }
      focus = null;
      refresh();
    }

    const detail = el("div", "ky-eng-detail");
    const action = el("div", "ky-eng-action");
    function drawDetail() {
      const q = focus && byId.get(focus);
      if (!q) { reset(detail); return; }
      reset(detail, el("div", "ky-eng-detail-in",
        el("div", "ky-eng-detail-head", el("b", null, `${q.paper} 第${q.number}题`),
          el("span", "ky-muted", `${q.type} · ${q.score || "?"} 分${q.hasAnswer ? "" : " · 题库无答案"}`)),
        el("div", null, el("span", "ky-muted", "考点："), q.topics.join("、") || "—"),
        el("div", "ky-muted", q.last
          ? `做过 ${q.count} 次（${q.sources.join("、")}）；最近 ${fmtTime(q.last.at)}：${q.last.correct === true ? "做对" : q.last.correct === false ? "做错" : "已做"}${q.last.max && q.last.score != null ? ` ${q.last.score}/${q.last.max}` : ""}${q.mistake ? " · 在错题本里" : ""}`
          : "还没做过")));
    }
    function drawAction() {
      const sel = [...picked].map((id) => byId.get(id)).filter(Boolean);
      if (!sel.length) {
        reset(action, el("span", "ky-muted", "点题号选题，点年份 / 题型选没做过的"),
          btn("随机 5 道没做过的", () => {
            const pool = all.filter((q) => !q.last && match(q));
            if (!pool.length) { toast(root, "没有符合条件的没做过的题"); return; }
            for (let i = 0; i < 5 && pool.length; i++) picked.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
            focus = null; refresh();
          }, "ky-btn"));
        action.classList.remove("ky-on");
        return;
      }
      action.classList.add("ky-on");
      const minutes = Math.max(1, Math.round(sel.reduce((s, q) => s + (PER_MIN[subject]?.[q.type] || 8), 0)));
      const minEl = el("input", { type: "number", class: "ky-input ky-eng-min", value: String(minutes), min: "0", max: "300" });
      reset(action,
        el("span", null, el("b", null, `已选 ${sel.length} 题`)),
        el("label", "ky-eng-minwrap", "限时", minEl, "分钟"),
        btn("清空", () => { picked.clear(); focus = null; refresh(); }, "ky-btn ky-btn-ghost"),
        btn("开始练习", () => {
          // 按年份新→旧、题目原顺序排
          const order = new Map(all.map((q, i) => [q.id, i]));
          const ids = sel.map((q) => q.id).sort((a, b) => order.get(a) - order.get(b));
          const title = sel.length === 1 ? `${sel[0].paper} 第${sel[0].number}题` : `${subject === "数学" ? "数学一" : "408"}真题 ${sel.length} 题`;
          try { sessionStorage.setItem("ky-exam-preset", JSON.stringify({ mode: "ids", subject, ids, minutes: Number(minEl.value) || 0, title })); }
          catch { toast(root, "无法开始练习", "error"); return; }
          ctx.app.openView("exam");
        }, "ky-btn ky-btn-primary ky-btn-lg"));
    }
    function refresh() {
      for (const p of chips.values()) p();
      for (const [tr, qs] of rows) tr.hidden = !!filter && !qs.some(match);
      drawDetail();
      drawAction();
    }
    search.addEventListener("input", () => { filter = search.value.trim(); refresh(); });

    reset(root, summary,
      el("section", "ky-card ky-eng-gridcard",
        el("div", "ky-eng-legend",
          el("span", null, el("i", "ky-eng-dot ky-s-todo"), "没做"), el("span", null, el("i", "ky-eng-dot ky-s-good"), "✓ 做对"),
          el("span", null, el("i", "ky-eng-dot ky-s-mid"), "½ 部分得分"), el("span", null, el("i", "ky-eng-dot ky-s-bad"), "✗ 做错"),
          el("span", null, el("i", "ky-eng-dot ky-bp-misdot"), "在错题本"),
          el("span", "ky-muted", "颜色按最近一次；×n = 做过 n 次。会话里用真题出的题、快练模考、错题重做都会算进来")),
        search,
        el("div", "ky-eng-gridwrap", table), detail),
      action);
    refresh();
  }

  load();
}
