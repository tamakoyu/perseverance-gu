// 英语真题专项：总览（年份 × 部分）→ 选题 → 限时练习（文章 + 题目分栏、划词加生词、手写）→ 判分 → AI 复盘（错因 / 讲解 / 生词 / 强化训练）。
import { impactCard } from "./score.js";
import { put, reset, el, btn, md, errorBox, toast, runJob, waitJob, storedImages, inkPad, inkOverlay, remotePad, clock, copy } from "./ui.js";

const COLS = [
  ["完形", "完形"], ["Text1", "Text 1"], ["Text2", "Text 2"], ["Text3", "Text 3"], ["Text4", "Text 4"],
  ["新题型", "新题型"], ["翻译", "翻译"], ["小作文", "小作文"], ["大作文", "大作文"],
];
const PART_GROUPS = [["完形", ["完形"]], ["阅读", ["Text1", "Text2", "Text3", "Text4"]], ["新题型", ["新题型"]], ["翻译", ["翻译"]], ["写作", ["小作文", "大作文"]]];
const CHOICE = ["完形", "阅读", "新题型"];
const DEFAULT_MIN = { 完形: 15, Text1: 18, Text2: 18, Text3: 18, Text4: 18, 新题型: 15, 翻译: 20, 小作文: 15, 大作文: 30 };
const partLabel = (k) => (COLS.find((c) => c[0] === k) || [k, k])[1];
const round1 = (x) => Math.round(x * 10) / 10;
const stripFig = (s) => String(s || "").replace(/\n*\[图[：:][^\]]*\]\n*/g, "\n\n").trim();

export function mountEnglishPractice(ctx, host, signal, { onLeave } = {}) {
  const root = el("div", "ky-eng");
  put(host, root);
  // 选中的题：unitId → Set(题目 id)
  const picked = new Map();
  let focus = null;
  let data = null;

  // ── 总览 ─────────────────────────────────────────────
  async function overview() {
    reset(root, el("p", "ky-muted", "加载中…"));
    let st;
    try { [data, st] = await Promise.all([ctx.call("english.overview"), ctx.call("english.importStatus")]); }
    catch (err) { reset(root, errorBox(err)); return; }
    if (signal.aborted) return;
    const cells = new Map();
    const units = new Map();
    for (const p of data.papers) for (const u of Object.values(p.units)) units.set(u.unitId, { ...u, paper: p.paper, year: p.year });

    const summary = el("section", "ky-card ky-eng-summary");
    const allQ = [...units.values()].flatMap((u) => u.questions);
    const doneQ = allQ.filter((q) => q.last);
    const right = doneQ.filter((q) => q.last.correct).length;
    put(summary,
      el("div", "ky-eng-sumhead",
        el("div", null, el("h3", "ky-h3", "英语一真题"), el("div", "ky-muted", `${data.papers.length} 套 · ${allQ.length} 题 · 已做 ${doneQ.length} 题${doneQ.length ? ` · 正确率 ${Math.round((right / doneQ.length) * 100)}%` : ""}`)),
        btn("刷新", overview, "ky-btn ky-btn-sm")),
      el("div", "ky-eng-bars", ...PART_GROUPS.map(([name, keys]) => {
        const us = [...units.values()].filter((u) => keys.includes(u.key));
        const total = us.length;
        const done = us.filter((u) => u.done === u.total && u.total).length;
        const part = us.filter((u) => u.done && u.done < u.total).length;
        return el("div", "ky-eng-bar",
          el("div", "ky-eng-bar-top", el("span", null, name), el("span", "ky-muted", `${done}/${total} 组`)),
          el("div", "ky-progress ky-progress-static",
            el("div", { class: "ky-progress-done", style: `width:${total ? (done / total) * 100 : 0}%` }),
            el("div", { class: "ky-progress-part", style: `width:${total ? (part / total) * 100 : 0}%` })));
      })));
    reset(root, summary, importPanel(st));

    if (!data.papers.length) return;

    // 表格：年份 × 部分
    const table = el("table", "ky-eng-grid");
    put(table, el("thead", null, el("tr", null, el("th", null, "年份"),
      ...COLS.map(([k, label]) => el("th", null, el("button", { type: "button", class: "ky-eng-colbtn", title: `选中所有没做过的 ${label}`, onclick: () => pickColumn(k) }, label))))));
    const tbody = el("tbody");
    for (const p of data.papers) {
      const tr = el("tr", null, el("th", null, el("button", { type: "button", class: "ky-eng-yearbtn", title: "选中整套", onclick: () => pickYear(p) }, String(p.year))));
      for (const [k] of COLS) {
        const u = p.units[k];
        if (!u) { put(tr, el("td", null, el("span", "ky-eng-cell ky-eng-none", "·"))); continue; }
        put(tr, el("td", null, cell(units.get(u.unitId))));
      }
      put(tbody, tr);
    }
    put(table, tbody);
    const detail = el("div", "ky-eng-detail");
    const action = el("div", "ky-eng-action");
    put(root, el("section", "ky-card ky-eng-gridcard",
      el("div", "ky-eng-legend",
        el("span", null, el("i", "ky-eng-dot ky-s-todo"), "没做"), el("span", null, el("i", "ky-eng-dot ky-s-good"), "≥80%"),
        el("span", null, el("i", "ky-eng-dot ky-s-mid"), "50–80%"), el("span", null, el("i", "ky-eng-dot ky-s-bad"), "<50%"),
        el("span", "ky-muted", "点格子选中 / 取消；点年份选整套；点表头选该列没做过的")),
      el("div", "ky-eng-gridwrap", table), detail), action);

    function cell(u) {
      const b = el("button", { type: "button", class: "ky-eng-cell" });
      const paint = () => {
        const sel = picked.get(u.unitId);
        const pct = u.max ? u.score / u.max : null;
        b.className = `ky-eng-cell ${u.done ? (pct >= 0.8 ? "ky-s-good" : pct >= 0.5 ? "ky-s-mid" : "ky-s-bad") : "ky-s-todo"}${sel ? " ky-sel" : ""}${focus === u.unitId ? " ky-focus" : ""}`;
        const writing = u.key === "小作文" || u.key === "大作文" || u.key === "翻译";
        reset(b,
          el("span", "ky-eng-cell-main", u.done ? (writing ? `${round1(u.score)}/${u.max}` : `${u.correct}/${u.total}`) : u.total ? "—" : "空"),
          sel && sel.size < u.total ? el("span", "ky-eng-cell-sub", `选 ${sel.size}`) : u.practiced > 1 ? el("span", "ky-eng-cell-sub", `×${u.practiced}`) : null);
      };
      b.addEventListener("click", () => {
        if (picked.has(u.unitId) && focus === u.unitId) picked.delete(u.unitId);
        else if (!picked.has(u.unitId)) picked.set(u.unitId, new Set(u.questions.map((q) => q.id)));
        focus = picked.has(u.unitId) ? u.unitId : null;
        refresh();
      });
      cells.set(u.unitId, paint);
      paint();
      return b;
    }
    function pickYear(p) {
      const us = Object.values(p.units);
      const all = us.every((u) => picked.has(u.unitId));
      for (const u of us) { if (all) picked.delete(u.unitId); else picked.set(u.unitId, new Set(u.questions.map((q) => q.id))); }
      focus = null;
      refresh();
    }
    function pickColumn(k) {
      const us = data.papers.map((p) => p.units[k]).filter(Boolean).filter((u) => !u.done);
      if (!us.length) { toast(root, `${partLabel(k)} 都做过了`); return; }
      const all = us.every((u) => picked.has(u.unitId));
      for (const u of us) { if (all) picked.delete(u.unitId); else picked.set(u.unitId, new Set(u.questions.map((q) => q.id))); }
      focus = null;
      refresh();
    }
    function drawDetail() {
      const u = focus && units.get(focus);
      if (!u) { reset(detail); return; }
      const sel = picked.get(u.unitId);
      reset(detail, el("div", "ky-eng-detail-in",
        el("div", "ky-eng-detail-head", el("b", null, `${u.paper} · ${partLabel(u.key)}`),
          el("span", "ky-muted", `${u.total} 题 · 限时 ${u.minutes} 分钟${u.practiced ? ` · 练过 ${u.practiced} 次${u.lastSeconds != null ? `，上次用时 ${clock(u.lastSeconds)}` : ""}` : ""}`)),
        u.total > 1 ? el("div", "ky-eng-qpick", el("span", "ky-muted", "只做其中几题："),
          ...u.questions.map((q) => {
            const on = sel?.has(q.id);
            const s = q.last ? (q.last.correct ? "ky-s-good" : q.last.correct === false ? "ky-s-bad" : "ky-s-mid") : "ky-s-todo";
            return el("button", { type: "button", class: `ky-eng-qchip ${s}${on ? " ky-sel" : ""}`, title: q.topics?.join("、") || "",
              onclick: () => {
                const set = picked.get(u.unitId) || new Set();
                if (set.has(q.id)) set.delete(q.id); else set.add(q.id);
                if (set.size) picked.set(u.unitId, set); else { picked.delete(u.unitId); focus = null; }
                refresh();
              } }, q.number);
          })) : null));
    }
    function drawAction() {
      const sel = [...picked.entries()].filter(([id]) => units.has(id));
      if (!sel.length) {
        reset(action, el("span", "ky-muted", "选几组题开始练习"),
          btn("随机一篇没做过的阅读", () => {
            const pool = [...units.values()].filter((u) => u.key.startsWith("Text") && !u.done);
            if (!pool.length) { toast(root, "阅读都做过了"); return; }
            const u = pool[Math.floor(Math.random() * pool.length)];
            picked.set(u.unitId, new Set(u.questions.map((q) => q.id)));
            focus = u.unitId;
            refresh();
          }, "ky-btn"));
        action.classList.remove("ky-on");
        return;
      }
      action.classList.add("ky-on");
      const nQ = sel.reduce((s, [, set]) => s + set.size, 0);
      let minutes = sel.reduce((s, [id, set]) => { const u = units.get(id); return s + (u.minutes || DEFAULT_MIN[u.key] || 15) * (set.size / Math.max(1, u.total)); }, 0);
      minutes = Math.max(1, Math.round(minutes));
      const minEl = el("input", { type: "number", class: "ky-input ky-eng-min", value: String(minutes), min: "1", max: "300" });
      reset(action,
        el("span", null, el("b", null, `已选 ${sel.length} 组 · ${nQ} 题`)),
        el("label", "ky-eng-minwrap", "限时", minEl, "分钟"),
        btn("清空", () => { picked.clear(); focus = null; refresh(); }, "ky-btn ky-btn-ghost"),
        btn("开始练习", () => {
          const ordered = data.papers.flatMap((p) => COLS.map(([k]) => p.units[k]).filter(Boolean)).filter((u) => picked.has(u.unitId));
          const ids = ordered.flatMap((u) => u.questions.filter((q) => picked.get(u.unitId).has(q.id)).map((q) => q.id));
          const title = ordered.length === 1 ? `${ordered[0].paper ?? units.get(ordered[0].unitId).paper} ${partLabel(ordered[0].key)}` : `英语真题 ${ordered.length} 组`;
          start(ids, Number(minEl.value) || minutes, title);
        }, "ky-btn ky-btn-primary ky-btn-lg"));
    }
    function refresh() {
      for (const p of cells.values()) p();
      drawDetail();
      drawAction();
    }
    refresh();
    put(root, historyBlock());
  }

  function importPanel(st) {
    const box = el("section", "ky-card");
    const running = st.running?.status === "running";
    const failed = Object.entries(st.failed || {});
    if (!running && st.total && st.done >= st.total && !failed.length) return null;
    put(box, el("h3", "ky-h3", "导入英语一真题"),
      el("p", "ky-muted", st.total ? `整理好的文件夹：${st.folder}（${st.total} 套，已导入 ${st.done} 套）。试卷文字 → 按部分拆题 → 对官方答案 → 黄皮书逐题解析、全文翻译。扫描版（2025 试卷、2023–2026 解析书）会先 OCR。做完的年份会记住，中断后再点会接着导。` : `没找到 ${st.folder}/manifest.json`));
    const out = el("div");
    put(box, out);
    if (failed.length) put(box, el("details", "ky-warnbox", el("summary", null, `${failed.length} 套没导成功（再点一次会重试）`), ...failed.map(([k, v]) => el("div", "ky-muted", `${k}：${v}`))));
    const go = async (job) => {
      try { await runJob(ctx, out, () => job, "导入"); toast(root, "导入完成"); }
      catch (err) { put(out, errorBox(err)); }
      overview();
    };
    if (running) go(Promise.resolve(st.running));
    else if (st.total) put(box, el("div", "ky-row", btn(st.done ? "继续导入" : "开始导入", () => go(ctx.call("english.importAll", {})), "ky-btn ky-btn-primary")));
    return box;
  }

  function historyBlock() {
    const box = el("details", "ky-card", el("summary", "ky-sum", el("b", null, "练习记录")));
    box.addEventListener("toggle", async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = "1";
      try {
        const list = (await ctx.call("quiz.history")).filter((a) => a.mode === "english").slice(0, 30);
        if (!list.length) { put(box, el("p", "ky-muted", "还没有记录")); return; }
        for (const a of list) {
          put(box, el("div", "ky-meta-row ky-eng-hist",
            el("span", null, a.title || "英语练习"), el("span", "ky-muted", `${round1(a.got || 0)}/${a.total || 0} · ${clock(a.elapsedSec || 0)} · ${String(a.finishedAt || "").slice(0, 10)}`),
            btn("看复盘", () => openReview(a.id), "ky-btn ky-btn-sm")));
        }
      } catch (err) { put(box, errorBox(err)); }
    });
    return box;
  }

  // ── 练习 ─────────────────────────────────────────────
  async function start(ids, minutes, title) {
    const out = el("div");
    reset(root, out);
    let res;
    try { res = await runJob(ctx, out, () => ctx.call("quiz.start", { mode: "english", subject: "英语", ids, minutes, title }), "组卷"); }
    catch (err) { reset(root, errorBox(err), btn("返回", overview)); return; }
    let infos = [];
    try { infos = await ctx.call("english.units", { ids: [...new Set(res.questions.map((q) => q.materialKey).filter(Boolean))] }); } catch { infos = []; }
    run(res.attempt, res.questions, minutes, title, infos);
  }

  function run(attempt, questions, minutes, title, infos) {
    const groups = [];
    for (const q of questions) {
      const key = q.materialKey || q.id;
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, part: q.part || q.type, type: q.type, paper: q.paper, material: q.material, qs: [], info: infos.find((i) => i.id === key) }; groups.push(g); }
      if (!g.material && q.material) g.material = q.material;
      g.qs.push(q);
    }
    const answers = {};
    const pads = {};
    const remotes = {};
    const unitTimes = {};
    let gi = 0;
    let finished = false;
    const startedAt = Date.now();
    let lastTick = Date.now();

    const timerEl = el("span", "ky-eng-timer");
    const tabsEl = el("div", "ky-eng-tabs");
    const body = el("div", "ky-eng-run");

    // 批注：开启后笔直接画在文章和题目上；每组的笔迹分开保存
    const notes = {};
    let overlays = [];
    let annotating = false;
    let annoTool = "pen";
    const annoBtn = btn("✏️ 批注", () => setAnnotating(!annotating), "ky-btn ky-eng-annobtn");
    const toolBtn = (key, label) => { const b = btn(label, () => { annoTool = key; overlays.forEach((o) => o.setTool(key)); paintTools(); }, "ky-btn ky-btn-sm ky-eng-tool"); b.dataset.tool = key; return b; };
    const annoBar = el("div", "ky-eng-annobar ky-hidden",
      toolBtn("pen", "红笔"), toolBtn("blue", "蓝笔"), toolBtn("hl", "荧光笔"), toolBtn("erase", "橡皮"),
      btn("撤销", () => {
        const n = notes[groups[gi].key];
        if (!n) return;
        const last = (arr) => (arr.length ? arr[arr.length - 1].t || 0 : -1);
        (last(n.p) >= last(n.q) ? n.p : n.q).pop();
        overlays.forEach((o) => o.measure());
      }, "ky-btn ky-btn-sm"),
      btn("清空本组", () => {
        const n = notes[groups[gi].key];
        if (!n || (!n.p.length && !n.q.length) || !confirm("清空这一组的批注？")) return;
        n.p.length = 0; n.q.length = 0;
        overlays.forEach((o) => o.measure());
      }, "ky-btn ky-btn-sm"),
      el("span", "ky-hint", "批注时不能点选项；答题前再点一下「批注」关掉"));
    function paintTools() { annoBar.querySelectorAll(".ky-eng-tool").forEach((b) => b.classList.toggle("ky-on", b.dataset.tool === annoTool)); }
    function setAnnotating(on) {
      annotating = on;
      annoBtn.classList.toggle("ky-on", on);
      annoBar.classList.toggle("ky-hidden", !on);
      body.classList.toggle("ky-annotating", on);
      overlays.forEach((o) => { o.setEnabled(on); o.setTool(annoTool); });
      if (on) window.getSelection()?.removeAllRanges();
      paintTools();
    }

    // 字号（iPad 上读文章）
    let fs = 17;
    try { fs = Number(localStorage.getItem("ky-eng-fs")) || 17; } catch { /* 无痕模式 */ }
    const setFs = (v) => {
      fs = Math.max(14, Math.min(24, v));
      wrap.style.setProperty("--ky-eng-fs", `${fs}px`);
      try { localStorage.setItem("ky-eng-fs", String(fs)); } catch { /* 忽略 */ }
      const n = notes[groups[gi]?.key];
      if (n && (n.p.length || n.q.length)) toast(root, "字号变了，已有批注的位置可能对不上");
      requestAnimationFrame(() => overlays.forEach((o) => o.measure()));
    };
    const fsBox = el("span", "ky-eng-fs", btn("A−", () => setFs(fs - 1), "ky-btn ky-btn-sm"), btn("A+", () => setFs(fs + 1), "ky-btn ky-btn-sm"));

    const wrap = el("div", "ky-eng-runwrap",
      el("div", "ky-eng-topbar",
        el("b", "ky-eng-title", title),
        fsBox, annoBtn,
        timerEl,
        btn("交卷", () => submit(), "ky-btn ky-btn-primary"),
        btn("退出", () => { if (confirm("退出这次练习？作答不会保存。")) { finished = true; clearInterval(tick); overview(); } }, "ky-btn ky-btn-ghost")),
      annoBar, tabsEl, body);
    reset(root, wrap);
    setFs(fs);

    const update = () => {
      const now = Date.now();
      if (!document.hidden) { const k = groups[gi].key; unitTimes[k] = (unitTimes[k] || 0) + (now - lastTick) / 1000; }
      lastTick = now;
      const used = (now - startedAt) / 1000;
      const left = minutes * 60 - used;
      timerEl.textContent = left >= 0 ? `剩余 ${clock(left)}` : `超时 ${clock(left)}`;
      timerEl.classList.toggle("ky-warn", left < 120 && left >= 0);
      timerEl.classList.toggle("ky-over", left < 0);
    };
    const tick = setInterval(update, 1000);
    update();
    signal.addEventListener("abort", () => clearInterval(tick));

    const isAnswered = (q) => { const a = answers[q.id]; return !!(a && (a.choice || (a.mode !== "ink" && a.mode !== "remote" && a.text?.trim()) || (a.mode === "ink" && pads[q.id] && !pads[q.id].isEmpty()) || (a.mode === "remote" && remotes[q.id] && !remotes[q.id].isEmpty()))); };
    function drawTabs() {
      reset(tabsEl, ...groups.map((g, i) => {
        const n = g.qs.filter(isAnswered).length;
        return el("button", { type: "button", class: `ky-eng-tab${i === gi ? " ky-on" : ""}${n === g.qs.length ? " ky-done" : ""}`, onclick: () => { gi = i; draw(); } },
          `${groups.length > 1 && g.paper ? `${String(g.paper).slice(0, 4)} ` : ""}${partLabel(g.part)}`, el("span", "ky-eng-tab-n", `${n}/${g.qs.length}`));
      }));
    }

    function draw() {
      const g = groups[gi];
      const passage = g.material ? passageView(g) : null;
      const qbox = el("div", "ky-eng-qs");
      if (g.info?.directions && !CHOICE.includes(g.type)) put(qbox, el("div", "ky-eng-dir", md(ctx, g.info.directions, signal)));
      if (g.type === "新题型" && g.qs[0]?.options?.length) {
        put(qbox, el("div", "ky-eng-shared", el("div", "ky-label", "备选项"), ...g.qs[0].options.map((o) => el("div", "ky-eng-shared-opt", el("span", "ky-opt-key", o.key), md(ctx, o.text, signal, "ky-md ky-inline")))));
      }
      for (const q of g.qs) put(qbox, questionView(g, q));
      put(qbox, el("div", "ky-row ky-eng-nav",
        gi > 0 ? btn("← 上一组", () => { gi--; draw(); }) : null,
        gi < groups.length - 1 ? btn("下一组 →", () => { gi++; draw(); }, "ky-btn ky-btn-primary") : btn("交卷", () => submit(), "ky-btn ky-btn-primary")));
      body.className = `ky-eng-run${passage ? " ky-split" : ""}${annotating ? " ky-annotating" : ""}`;
      reset(body, passage, qbox);
      overlays.forEach((o) => o.destroy());
      const n = notes[g.key] || (notes[g.key] = { p: [], q: [] });
      overlays = [passage ? inkOverlay(passage, n.p) : null, inkOverlay(qbox, n.q)].filter(Boolean);
      overlays.forEach((o) => { o.setEnabled(annotating); o.setTool(annoTool); });
      drawTabs();
      body.scrollTop = 0;
    }

    function passageView(g) {
      const box = el("div", "ky-eng-passage");
      const text = md(ctx, g.material, signal, "ky-md ky-eng-text");
      put(box, el("div", "ky-eng-ptitle", `${g.paper || ""} ${partLabel(g.part)}`, el("span", "ky-hint", " · 选中单词可加入生词本")), text);
      wordPicker(box, `${g.paper || ""} ${partLabel(g.part)}`);
      // 点文章里的空号 / 题号，跳到对应的题
      text.addEventListener("click", (e) => {
        const n = e.target.closest("strong")?.textContent.replace(/[^\d]/g, "");
        const q = n && g.qs.find((x) => String(x.number) === n);
        const card = q && root.querySelector(`#q-${q.id}`);
        if (!card) return;
        // 竖屏时文章钉在上面，滚动要让开它；横屏时题目栏自己滚
        const qcol = card.closest(".ky-eng-qs");
        const scroller = qcol && qcol.scrollHeight > qcol.clientHeight + 4 && getComputedStyle(qcol).overflowY === "auto" ? qcol : body;
        const pinned = getComputedStyle(box).position === "sticky" ? box.offsetHeight : 0;
        scroller.scrollBy({ top: card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pinned - 10, behavior: "smooth" });
        card.classList.remove("ky-flash-q");
        void card.offsetWidth;
        card.classList.add("ky-flash-q");
      });
      return box;
    }

    function questionView(g, q) {
      const a = answers[q.id] = answers[q.id] || {};
      const card = el("div", { class: "ky-eng-q", id: `q-${q.id}` });
      const head = el("div", "ky-eng-qhead", el("span", "ky-eng-qno", q.number), q.type === "完形" ? null : md(ctx, stripFig(q.stem), signal, "ky-md ky-eng-stem"));
      put(card, head);
      if (q.images?.length) put(card, storedImages(ctx, q.images, q.hasFigures ? "ky-figures" : undefined));
      if (CHOICE.includes(q.type) && q.options?.length) {
        const opts = el("div", `ky-eng-opts${q.type === "新题型" ? " ky-eng-opts-letters" : ""}${q.type === "完形" ? " ky-eng-opts-cloze" : ""}`);
        const paint = () => opts.querySelectorAll("button").forEach((b) => b.classList.toggle("ky-on", b.dataset.k === a.choice));
        for (const o of q.options) {
          const b = el("button", { type: "button", class: "ky-eng-opt" },
            el("span", "ky-opt-key", o.key),
            q.type === "新题型" ? null : md(ctx, o.text, signal, "ky-md ky-inline"));
          b.dataset.k = o.key;
          b.addEventListener("click", () => { a.choice = a.choice === o.key ? "" : o.key; paint(); drawTabs(); });
          put(opts, b);
        }
        paint();
        put(card, opts);
      } else {
        const useInk = a.mode === "ink";
        const ta = el("textarea", { class: `ky-input ky-eng-ta${q.type === "大作文" || q.type === "小作文" ? " ky-eng-ta-lg" : ""}`, placeholder: q.type === "翻译" ? "写下你的译文" : "写作文（也可以切到手写）" }, a.text || "");
        ta.addEventListener("input", () => { a.text = ta.value; drawTabs(); });
        pads[q.id] = pads[q.id] || inkPad({ height: q.type === "翻译" ? 260 : 520, label: "手写" });
        remotes[q.id] = remotes[q.id] || remotePad(ctx, { key: `${attempt.id}:${q.id}`, title: `${g.paper || ""} ${partLabel(g.part)} 第 ${q.number} 题`, stem: q.stem, onChange: () => drawTabs() });
        const area = el("div", "ky-eng-answer");
        const toggle = el("div", "ky-eng-modes",
          btn("⌨️ 打字", () => { a.mode = "text"; show(); drawTabs(); }, "ky-btn ky-btn-sm"),
          btn("✍️ 手写", () => { a.mode = "ink"; show(); drawTabs(); }, "ky-btn ky-btn-sm"),
          btn("🖥 新窗口手写", () => { a.mode = "remote"; show(); drawTabs(); }, "ky-btn ky-btn-sm"));
        const show = () => {
          const m = a.mode === "ink" ? 1 : a.mode === "remote" ? 2 : 0;
          [...toggle.children].forEach((b, i) => b.classList.toggle("ky-on", i === m));
          reset(area, m === 1 ? pads[q.id].node : m === 2 ? remotes[q.id].node : ta);
        };
        a.mode = useInk ? "ink" : a.mode || "text";
        show();
        put(card, toggle, area);
      }
      return card;
    }

    async function submit() {
      if (finished) return;
      const blank = questions.filter((q) => !isAnswered(q)).length;
      if (blank && !confirm(`还有 ${blank} 题没作答，确定交卷？`)) return;
      finished = true;
      clearInterval(tick);
      const payload = {};
      for (const q of questions) {
        const a = answers[q.id] || {};
        const img = a.mode === "ink" ? pads[q.id]?.get() : null;
        const imgs = a.mode === "remote" ? remotes[q.id]?.get() || [] : img ? [img] : [];
        payload[q.id] = { choice: a.choice || "", text: a.mode === "ink" || a.mode === "remote" ? "" : a.text || "", images: imgs };
      }
      const out = el("div");
      reset(root, el("h2", "ky-h2", "判分 + AI 复盘"), out);
      try {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const times = Object.fromEntries(Object.entries(unitTimes).map(([k, v]) => [k, Math.round(v)]));
        await runJob(ctx, out, () => ctx.call("quiz.submit", { attemptId: attempt.id, answers: payload, elapsedSec, unitTimes: times }), "判分");
        await runJob(ctx, out, () => ctx.call("english.review", { attemptId: attempt.id }), "AI 复盘");
        openReview(attempt.id);
      } catch (err) {
        reset(out, errorBox(err), el("div", "ky-row", btn("看已有结果", () => openReview(attempt.id)), btn("返回总览", overview)));
      }
    }
    draw();
  }

  /** 在文章里选中单词 → 浮出「加入生词本」。 */
  function wordPicker(box, source) {
    const chip = el("button", { type: "button", class: "ky-eng-wordchip ky-hidden" });
    put(box, chip);
    let current = null;
    const check = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || !box.contains(sel.anchorNode) || text.split(/\s+/).length > 5 || !/[A-Za-z]/.test(text) || text.length > 60) { chip.classList.add("ky-hidden"); current = null; return; }
      const word = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
      const para = (sel.anchorNode.parentElement?.closest("p, li") || sel.anchorNode.parentElement)?.textContent || "";
      const sentence = (para.match(/[^.!?。！？]*[.!?。！？]?/g) || []).find((s) => s.includes(word))?.trim() || para.slice(0, 300);
      current = { word, sentence };
      const rc = sel.getRangeAt(0).getBoundingClientRect();
      const bb = box.getBoundingClientRect();
      chip.style.left = `${Math.max(0, rc.left - bb.left + box.scrollLeft)}px`;
      chip.style.top = `${rc.bottom - bb.top + box.scrollTop + 6}px`;
      chip.textContent = `＋ 生词本：${word}`;
      chip.classList.remove("ky-hidden");
    };
    box.addEventListener("mouseup", () => setTimeout(check, 10));
    box.addEventListener("touchend", () => setTimeout(check, 300));
    box.addEventListener("dblclick", () => setTimeout(check, 10));
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", async () => {
      if (!current) return;
      const { word, sentence } = current;
      chip.classList.add("ky-hidden");
      window.getSelection()?.removeAllRanges();
      toast(root, `正在查「${word}」…`);
      try {
        const r = await ctx.call("vocab.add", { word, sentence, source });
        toast(root, `${r.merged ? "已在生词本，补了例句" : "已加入生词本"}：${r.item.word} ${r.item.meaning}`);
      } catch (err) { toast(root, err.message, "error"); }
    });
  }

  // ── 复盘 ─────────────────────────────────────────────
  async function openReview(attemptId) {
    reset(root, el("p", "ky-muted", "加载复盘…"));
    let d;
    try { d = await ctx.call("attempt.get", { id: attemptId }); } catch (err) { reset(root, errorBox(err), btn("返回", overview)); return; }
    const a = d.attempt;
    if (!a.review) {
      const out = el("div");
      reset(root, out);
      try { await runJob(ctx, out, () => ctx.call("english.review", { attemptId }), "AI 复盘"); return openReview(attemptId); }
      catch (err) { put(out, errorBox(err), btn("返回", overview)); return; }
    }
    const groups = [];
    for (const q of d.questions) {
      const key = q.materialKey || q.id;
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, qs: [], material: "" }; groups.push(g); }
      if (q.material) g.material = q.material;
      g.qs.push(q);
    }
    const pct = a.total ? Math.round((a.got / a.total) * 100) : 0;
    reset(root,
      el("div", "ky-row", btn("← 返回总览", overview, "ky-btn")),
      el("div", "ky-hero",
        el("div", "ky-hero-num", String(round1(a.got || 0))),
        el("div", "ky-hero-text", el("div", "ky-hero-title", `/ ${a.total} 分（${pct}%）`), el("div", "ky-muted", `${a.title || ""} · 用时 ${clock(a.elapsedSec || 0)}${a.minutes ? ` / 限时 ${a.minutes} 分钟` : ""} · 错题已进错题本`))),
      impactCard(ctx, a.impact));
    for (const g of groups) put(root, unitReview(a, g, a.review[g.key]));
  }

  function unitReview(a, g, rv) {
    const box = el("section", "ky-card ky-eng-review");
    if (!rv) { put(box, el("p", "ky-muted", "这组没有复盘")); return box; }
    const right = g.qs.filter((q) => a.results[q.id]?.correct).length;
    const over = rv.usedSec != null && rv.limitSec && rv.usedSec > rv.limitSec;
    put(box,
      el("div", "ky-eng-rhead",
        el("h3", "ky-h3", `${rv.paper || "AI 强化"} · ${partLabel(rv.part)}`),
        el("span", "ky-tag", `${right}/${g.qs.length} 对`),
        rv.usedSec != null ? el("span", `ky-tag${over ? " ky-tag-over" : ""}`, `用时 ${clock(rv.usedSec)} / ${clock(rv.limitSec)}`) : null),
      rv.summary ? el("p", null, rv.summary) : null,
      rv.errorCauses?.length ? el("div", "ky-eng-causes", ...rv.errorCauses.map((c) => el("div", "ky-eng-cause",
        el("b", null, c.cause), c.questions?.length ? el("span", "ky-muted", ` 第 ${c.questions.join("、")} 题`) : null, el("div", null, c.detail)))) : null);

    // 逐题
    const qlist = el("div", "ky-eng-rqs");
    for (const q of g.qs) {
      const r = a.results[q.id] || {};
      const ans = a.answers?.[q.id] || {};
      const teach = (rv.teaching || []).find((t) => String(t.number) === String(q.number));
      const mine = ans.choice || ans.text || (ans.hasImages ? "（手写）" : "未作答");
      const det = el("details", { class: `ky-eng-rq ${r.correct ? "ky-ok-b" : r.correct === false ? "ky-bad-b" : ""}`, open: !r.correct && !!teach },
        el("summary", "ky-sum",
          el("span", "ky-eng-qno", q.number),
          CHOICE.includes(q.type) ? el("span", null, "你选 ", el("b", { class: r.correct ? "ky-ok" : "ky-bad" }, ans.choice || "—"), "，答案 ", el("b", null, q.answer || "?")) : el("span", null, `${round1(r.score || 0)}/${r.max} 分`),
          r.errorType ? el("span", "ky-tag", r.errorType) : null));
      det.addEventListener("toggle", () => {
        if (!det.open || det.dataset.filled) return;
        det.dataset.filled = "1";
        put(det,
          q.type !== "完形" && q.stem ? md(ctx, stripFig(q.stem), signal) : null,
          CHOICE.includes(q.type) && q.type !== "新题型" ? el("div", "ky-opts", ...q.options.map((o) => el("div", { class: `ky-opt${o.key === q.answer ? " ky-opt-right" : ""}${o.key === ans.choice && o.key !== q.answer ? " ky-opt-wrong" : ""}` }, el("span", "ky-opt-key", o.key), md(ctx, o.text, signal, "ky-md ky-inline")))) : null,
          !CHOICE.includes(q.type) ? el("div", null, el("div", "ky-label", "你的作答"), el("div", "ky-pre", mine)) : null,
          teach ? el("div", "ky-eng-teach", el("div", "ky-label", "AI 讲解"), md(ctx, teach.explain, signal)) : null,
          r.feedback && !CHOICE.includes(q.type) ? el("div", null, el("div", "ky-label", "批改"), md(ctx, r.feedback, signal)) : null,
          !CHOICE.includes(q.type) && q.answer ? el("div", null, el("div", "ky-label", q.type === "翻译" ? "参考译文" : "范文"), md(ctx, q.answer, signal)) : null,
          q.analysis ? el("details", "ky-eng-book", el("summary", null, q.analysisSource === "AI" ? "解析（AI 写的）" : "解析书原文"), md(ctx, q.analysis, signal)) : null);
      });
      put(qlist, det);
    }
    put(box, qlist);

    if (rv.method) put(box, el("div", "ky-eng-method", el("div", "ky-label", "方法课"), md(ctx, rv.method, signal)));
    if (g.material || rv.translation) {
      put(box, el("details", "ky-eng-book",
        el("summary", null, "原文 / 全文翻译"),
        el("div", "ky-eng-bilingual", g.material ? md(ctx, g.material, signal, "ky-md ky-eng-text") : null, rv.translation ? md(ctx, rv.translation, signal) : null)));
    }

    // 生词
    if (rv.vocab?.length) {
      const checks = rv.vocab.map((w) => ({ w, cb: el("input", { type: "checkbox", checked: true }) }));
      const vbox = el("div", "ky-eng-vocab", el("div", "ky-label", "这组的重点词（勾选后加入生词本）"),
        el("div", "ky-eng-words", ...checks.map(({ w, cb }) => el("label", "ky-eng-word", cb,
          el("span", null, el("b", null, w.word), ` ${w.phonetic || ""} ${w.pos || ""} ${w.meaning || ""}`),
          w.sentence ? el("div", "ky-muted ky-eng-wsent", w.sentence) : null))));
      const addBtn = btn("加入生词本", async () => {
        const words = checks.filter((c) => c.cb.checked).map((c) => c.w);
        if (!words.length) return;
        addBtn.disabled = true;
        try { const r = await ctx.call("vocab.addMany", { words, source: `${rv.paper || ""} ${partLabel(rv.part)}` }); toast(root, `已加入 ${r.added} 个（已有的补了例句）`); addBtn.textContent = "已加入"; }
        catch (err) { toast(root, err.message, "error"); addBtn.disabled = false; }
      }, "ky-btn ky-btn-primary");
      put(vbox, el("div", "ky-row", addBtn));
      put(box, vbox);
    }

    // 强化训练
    const drill = el("div", "ky-eng-drill", el("div", "ky-label", "强化训练"), rv.drillFocus ? el("p", null, rv.drillFocus) : null);
    const row = el("div", "ky-row");
    for (const d of rv.drills || []) row.append(btn(`真题 ${d.year} ${partLabel(d.part)}`, () => start(d.ids, DEFAULT_MIN[d.part] || 18, `${d.paper} ${partLabel(d.part)}`), "ky-btn"));
    const aiOut = el("div");
    row.append(btn("AI 出一组针对性强化题", async () => {
      try {
        const r = await runJob(ctx, aiOut, () => ctx.call("english.aiDrill", { attemptId: a.id, unitId: g.key }), "出题");
        start(r.ids, 12, r.title);
      } catch (err) { reset(aiOut, errorBox(err)); }
    }, "ky-btn ky-btn-primary"));
    row.append(btn("去讲课会话深入学", async () => {
      const text = `【学习】考研英语一 ${rv.paper || ""} ${partLabel(rv.part)}：${rv.drillFocus || rv.errorCauses?.map((c) => c.cause).join("、") || "这组题的解题方法"}`;
      toast(root, (await copy(text)) ? `已复制：${text}，去新建讲课会话粘贴` : text);
    }, "ky-btn ky-btn-ghost"));
    put(drill, row, aiOut);
    put(box, drill);
    return box;
  }

  overview();
  return { overview };
}
