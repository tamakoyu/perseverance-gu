// 导出到 Obsidian：按仓库《笔记格式规范》把会话内容补进章节笔记 / 题型笔记 / 公式速查，看差异、预览、改内容后写入。
// 用插件自己的浮动窗口（可拖动、缩放、最小化），点窗口外面不会关掉；生成在后台跑，草稿落盘，关了也能回来接着改。
import { put, reset, el, btn, md, errorBox, waitJob } from "./ui.js";

const wins = new Map(); // chatId → 打开着的窗口
const GEO_KEY = "kaoyan.exportWin";

const loadGeo = () => { try { return JSON.parse(localStorage.getItem(GEO_KEY)) || null; } catch { return null; } };
const saveGeo = (g) => { try { localStorage.setItem(GEO_KEY, JSON.stringify(g)); } catch { /* 忽略 */ } };
/** 行级差异（LCS）：返回 [{t:" "|"+"|"-", s}]。笔记几百行，O(n·m) 够用。 */
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: " ", s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: A[i++] });
    else out.push({ t: "+", s: B[j++] });
  }
  while (i < n) out.push({ t: "-", s: A[i++] });
  while (j < m) out.push({ t: "+", s: B[j++] });
  return out;
}

/** 差异视图：只显示改动和前后 2 行，中间没变的折叠。 */
function diffView(a, b) {
  const d = lineDiff(a, b);
  const keep = d.map((x, k) => x.t !== " " || d.slice(Math.max(0, k - 2), k + 3).some((y) => y.t !== " "));
  const box = el("div", "ky-diff ky-mono");
  let added = 0, removed = 0, skipped = 0;
  const flush = () => { if (skipped) { box.append(el("div", "ky-diff-skip", `… ${skipped} 行未改动 …`)); skipped = 0; } };
  d.forEach((x, k) => {
    if (x.t === "+") added++;
    if (x.t === "-") removed++;
    if (!keep[k]) { skipped++; return; }
    flush();
    box.append(el("div", x.t === "+" ? "ky-diff-add" : x.t === "-" ? "ky-diff-del" : "ky-diff-ctx", `${x.t} ${x.s}`));
  });
  flush();
  if (!added && !removed) box.append(el("div", "ky-muted", "没有改动"));
  return { box, added, removed };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** 浮动窗口：标题栏拖动，右下角缩放，— 最小化成小条，□ 放大/还原，× 关闭。 */
function floatingWindow(title, { onClose }) {
  const geo = loadGeo() || {};
  const w = Math.min(geo.w || 620, innerWidth - 40);
  const h = Math.min(geo.h || 560, innerHeight - 60);
  const win = el("div", { class: "ky-root ky-fwin", role: "dialog", "aria-label": title });
  win.style.width = `${w}px`;
  win.style.height = `${h}px`;
  win.style.left = `${Math.max(10, Math.min(geo.x ?? innerWidth - w - 24, innerWidth - 120))}px`;
  win.style.top = `${Math.max(10, Math.min(geo.y ?? 70, innerHeight - 60))}px`;

  const status = el("span", "ky-fwin-status");
  const titleEl = el("span", "ky-fwin-title", title);
  const minBtn = el("button", { type: "button", class: "ky-fwin-btn", title: "最小化（后台继续）" }, "—");
  const maxBtn = el("button", { type: "button", class: "ky-fwin-btn", title: "放大 / 还原" }, "□");
  const closeBtn = el("button", { type: "button", class: "ky-fwin-btn", title: "关闭（生成会在后台继续）" }, "×");
  const bar = el("div", "ky-fwin-bar", titleEl, status, el("span", "ky-fwin-sp"), minBtn, maxBtn, closeBtn);
  const body = el("div", "ky-fwin-body ky-dialog");
  win.append(bar, body);
  document.body.append(win);

  const remember = () => {
    if (win.classList.contains("ky-fwin-min") || win.classList.contains("ky-fwin-max")) return;
    const r = win.getBoundingClientRect();
    saveGeo({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  };
  new ResizeObserver(() => remember()).observe(win);

  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || win.classList.contains("ky-fwin-max")) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      win.style.left = `${Math.max(0, Math.min(ev.clientX - dx, innerWidth - 80))}px`;
      win.style.top = `${Math.max(0, Math.min(ev.clientY - dy, innerHeight - 36))}px`;
    };
    const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); remember(); };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
  const toggleMin = () => { win.classList.remove("ky-fwin-max"); win.classList.toggle("ky-fwin-min"); };
  minBtn.onclick = toggleMin;
  bar.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) toggleMin(); });
  maxBtn.onclick = () => { win.classList.remove("ky-fwin-min"); win.classList.toggle("ky-fwin-max"); };

  let closed = false;
  const close = () => { if (closed) return; closed = true; win.remove(); onClose?.(); };
  closeBtn.onclick = close;
  return {
    body,
    setStatus: (t) => { status.textContent = t || ""; },
    minimize: () => { win.classList.remove("ky-fwin-max"); win.classList.add("ky-fwin-min"); },
    restore: () => { win.classList.remove("ky-fwin-min"); win.style.zIndex = String(Date.now() % 1e6 + 9000); },
    close,
    get closed() { return closed; },
  };
}

export function openExportDialog(ctx, chatId, { auto = false } = {}) {
  const existing = wins.get(chatId);
  if (existing && !existing.closed) { existing.restore(); return existing; }

  const ctl = new AbortController();
  const signal = ctl.signal;
  let folders = [];
  let working = false; // 生成中：关闭时提示会在后台继续
  ctx.call("vault.folders").then((f) => { folders = f; }, () => {});

  const win = floatingWindow("导出到 Obsidian", {
    onClose: () => {
      ctl.abort();
      wins.delete(chatId);
      if (working) notifyWhenDone();
    },
  });
  wins.set(chatId, win);
  const body = win.body;

  // 关掉窗口后生成完了：右下角提示，点一下重新打开
  let watchingJob = null;
  function notifyWhenDone() {
    if (!watchingJob) return;
    waitJob(ctx, watchingJob).then(() => {
      if (wins.has(chatId)) return;
      const t = el("button", { type: "button", class: "ky-toast ky-toast-btn" }, "✓ 笔记草稿已生成，点这里查看");
      t.onclick = () => { t.remove(); openExportDialog(ctx, chatId); };
      document.body.append(t);
      setTimeout(() => t.remove(), 30000);
    }, () => {});
  }

  const choose = (lead) => {
    working = false;
    win.setStatus("");
    reset(body,
      lead,
      el("p", "ky-muted", auto ? "这次学习模式已经讲完。要把这个知识点整理进 Obsidian 笔记吗？" : "把这次会话讲过、考过的内容整理进 Obsidian 笔记。"),
      el("div", "ky-choice-grid",
        choiceCard("整理到笔记", "按仓库「笔记规范」补进对应的章节笔记；跨章节的方法写成题型笔记，新公式补进公式速查。写入前先看差异", () => generate()),
        choiceCard("不导出", "这次先不整理", async () => {
          await ctx.call("export.dismiss", { chatId }).catch(() => {});
          win.close();
        })));
  };

  function choiceCard(title, desc, onclick) {
    return el("button", { type: "button", class: "ky-choice", onclick }, el("b", null, title), el("span", "ky-muted", desc));
  }

  /** 分步进度：每一步打勾，模型那一步显示已用时间，进度条按预计时长慢慢走。 */
  async function follow(job) {
    working = true;
    watchingJob = job;
    const steps = ["读取会话记录", "规划要更新哪些笔记", "模型写笔记", "整理生成结果"];
    const items = steps.map((s) => el("li", "ky-step", el("span", "ky-step-dot"), el("span", null, s)));
    const fill = el("div", "ky-progress-fill ky-progress-smooth");
    const detail = el("div", "ky-muted");
    const elapsed = el("span", "ky-muted");
    const started = Date.parse(job.startedAt) || Date.now();
    let stepAt = Date.now();
    let cur = 0;
    const paint = () => {
      const secs = (Date.now() - started) / 1000;
      elapsed.textContent = `已用 ${mmss(secs)}`;
      items.forEach((li, i) => { li.classList.toggle("ky-step-done", i < cur - 1); li.classList.toggle("ky-step-on", i === cur - 1); });
      // 第 2 步（规划）按 30 秒估计走到 14%；第 3 步（写笔记）按 2–3 分钟估计，渐近地走到 92%
      const t = (Date.now() - stepAt) / 1000;
      let pct = cur <= 1 ? 3 : cur === 2 ? 4 + 10 * (1 - Math.exp(-t / 25)) : cur === 3 ? 14 + 78 * (1 - Math.exp(-t / 90)) : 96;
      fill.style.width = `${Math.round(pct)}%`;
      win.setStatus(`${Math.round(pct)}% · ${mmss(secs)}`);
    };
    const tick = setInterval(paint, 500);
    reset(body,
      el("div", "ky-row", el("b", null, job.label || "生成笔记"), elapsed),
      el("div", "ky-progress ky-progress-lg", fill),
      el("ol", "ky-steps", ...items),
      detail,
      el("p", "ky-muted", "可以最小化或关掉这个窗口去做别的，生成会在后台继续；完成后右下角会提示，草稿也会保存，下次点「导出到 Obsidian」还能接着改。"),
      el("div", "ky-row",
        btn("最小化", () => win.minimize(), "ky-btn ky-btn-ghost"),
        btn("取消生成", async () => { await ctx.call("jobs.cancel", { id: job.id }).catch(() => {}); }, "ky-btn ky-btn-ghost")));
    try {
      const draft = await waitJob(ctx, job, (j) => {
        if (j.done && j.done !== cur) { cur = j.done; stepAt = Date.now(); }
        detail.textContent = j.message || "";
        paint();
      });
      clearInterval(tick);
      working = false;
      if (!win.closed) review(draft, null);
    } catch (err) {
      clearInterval(tick);
      working = false;
      if (!win.closed) reset(body, errorBox(err), el("div", "ky-row", btn("重新选择", () => choose()), btn("关闭", () => win.close(), "ky-btn ky-btn-ghost")));
    }
  }

  async function generate() {
    reset(body, el("div", "ky-muted", "正在开始…"));
    try {
      follow(await ctx.call("export.draft", { chatId }));
    } catch (err) {
      reset(body, errorBox(err), el("div", "ky-row", btn("返回", () => choose()), btn("关闭", () => win.close(), "ky-btn ky-btn-ghost")));
    }
  }

  function review(draft, at) {
    win.setStatus(`${draft.notes.length} 篇`);
    const list = el("datalist", { id: "ky-folders" }, ...folders.map((f) => el("option", { value: f })));
    const rows = draft.notes.map((n) => {
      const isUpdate = n.original != null;
      const include = el("input", { type: "checkbox", checked: true });
      const folder = el("input", { class: "ky-input", value: n.folder, list: "ky-folders", disabled: isUpdate });
      const name = el("input", { class: "ky-input", value: n.name, disabled: isUpdate });
      const content = el("textarea", { class: "ky-input ky-ta-lg ky-mono" }, n.content);
      const view = el("div");
      const stat = el("span", "ky-muted");
      const show = (mode) => {
        content.classList.toggle("ky-hidden", mode !== "edit");
        if (mode === "edit") { reset(view); return; }
        if (mode === "diff") {
          const d = diffView(n.original || "", content.value);
          stat.textContent = `+${d.added} −${d.removed} 行`;
          reset(view, d.box);
        } else reset(view, el("div", "ky-preview", md(ctx, content.value.replace(/^---[\s\S]*?---\n/, ""), signal)));
        tabs.forEach(([m, b]) => b.classList.toggle("ky-btn-primary", m === mode));
      };
      const tabs = [
        ...(isUpdate ? [["diff", "差异"]] : []), ["preview", "预览"], ["edit", "编辑"],
      ].map(([m, label]) => [m, btn(label, () => { show(m); if (m === "edit") tabs.forEach(([k, b]) => b.classList.toggle("ky-btn-primary", k === "edit")); }, "ky-btn ky-btn-ghost ky-btn-sm")]);
      const box = el("details", { class: "ky-card", open: true },
        el("summary", "ky-sum", include,
          el("span", "ky-tag", isUpdate ? "修改" : "新建"), n.kind ? el("span", "ky-tag", n.kind) : null,
          el("b", null, n.name), el("span", "ky-muted", `${n.folder}/`)),
        n.reason ? el("div", "ky-muted", n.reason) : null,
        n.warn ? el("div", "ky-warnbox", n.warn) : null,
        isUpdate ? null : el("div", "ky-grid2", el("label", "ky-field", el("span", "ky-label", "文件夹（可改）"), folder), el("label", "ky-field", el("span", "ky-label", "笔记名"), name)),
        el("div", "ky-row", ...tabs.map(([, b]) => b), stat), content, view);
      show(isUpdate ? "diff" : "preview");
      return { n, include, folder, name, content, box };
    });
    const msg = el("div");
    const save = async (overwrite = []) => {
      const notes = rows.filter((r) => r.include.checked).map((r) => ({ folder: r.folder.value.trim(), name: r.name.value.trim(), content: r.content.value, original: r.n.original ?? null }));
      if (!notes.length) { reset(msg, el("div", "ky-error", "至少勾选一篇")); return; }
      try {
        const r = await ctx.call("export.save", { chatId, notes, overwrite });
        const blocked = r.results.filter((x) => x.exists || x.conflict);
        if (blocked.length) {
          // 已经写进去的取消勾选，再点「仍然覆盖」时只处理没写入的
          const written = new Set(r.results.filter((x) => x.written).map((x) => x.key));
          rows.forEach((row) => { if (written.has(`${row.folder.value.trim()}/${row.name.value.trim()}`)) row.include.checked = false; });
          const lines = blocked.map((x) => el("li", null, x.conflict ? `${x.path}：生成草稿之后在 Obsidian 里改过，直接覆盖会丢掉那些改动` : `${x.path}：已经存在`));
          const done = r.results.filter((x) => x.written).map((x) => x.path);
          reset(msg, el("div", "ky-warnbox",
            done.length ? el("div", "ky-ok", `✓ 已写入：${done.join("、")}`) : null,
            el("div", null, "这些没有写入："), el("ul", "ky-ul", ...lines),
            el("div", "ky-row",
              btn("仍然覆盖（原文会备份）", () => save([...overwrite, ...blocked.map((x) => x.key)]), "ky-btn ky-btn-danger"),
              btn("重新生成", async () => { await ctx.call("export.discard", { chatId }).catch(() => {}); choose(); }),
              btn("先不写", () => reset(msg)))));
          return;
        }
        win.setStatus("已写入");
        reset(body, el("div", "ky-ok", "✓ 已写入 Obsidian："),
          el("ul", "ky-ul", ...r.results.map((x) => el("li", null, `${x.updated ? "修改" : "新建"} ${x.path}`))),
          r.results.some((x) => x.updated) ? el("p", "ky-muted", "修改前的原文已备份到插件数据目录 noteBackups/。") : null,
          btn("完成", () => win.close(), "ky-btn ky-btn-primary"));
      } catch (err) { reset(msg, errorBox(err)); }
    };
    reset(body, list,
      at ? el("div", "ky-warnbox", `这是 ${new Date(at).toLocaleString()} 生成、还没写入的草稿。`) : null,
      el("div", "ky-muted", `科目：${draft.subject || "?"} · 课程：${draft.course || "?"} · 共 ${draft.notes.length} 篇。修改的笔记默认显示差异（绿色新增、红色删除），内容都可以改，不想要的取消勾选。`),
      ...rows.map((r) => r.box),
      msg,
      el("div", "ky-row",
        btn("写入 Obsidian", () => save(), "ky-btn ky-btn-primary"),
        btn("重新生成", async () => { await ctx.call("export.discard", { chatId }).catch(() => {}); choose(); }),
        btn("关闭（草稿保留）", () => win.close(), "ky-btn ky-btn-ghost")));
  }

  // 先看有没有在跑的任务或没写入的草稿
  reset(body, el("div", "ky-muted", "读取中…"));
  (async () => {
    let st = null;
    try { st = await ctx.call("export.status", { chatId }); } catch { /* 旧后端没有这个接口 */ }
    if (win.closed) return;
    if (st?.job) return follow(st.job);
    if (st?.draft) return review(st.draft, st.at);
    // 后端还没重启（旧版本）时：从内存里的任务列表找刚生成完的导出结果
    if (!st) {
      try {
        const list = await ctx.call("jobs.list");
        const running = list.find((j) => j.kind === "export" && j.status === "running");
        if (running) return follow(running);
        const done = list.filter((j) => j.kind === "export" && j.status === "succeeded" && j.result?.notes?.length);
        if (done.length) {
          return choose(el("div", "ky-warnbox", "找到之前生成好、还没写入的草稿：",
            ...done.map((j) => el("div", "ky-row", el("span", null, `${j.result.title || "未命名会话"} · ${j.result.notes.length} 篇 · ${new Date(j.startedAt).toLocaleTimeString()}`), btn("打开", () => review(j.result, j.startedAt), "ky-btn ky-btn-primary ky-btn-sm")))));
        }
      } catch { /* 忽略 */ }
    }
    if (st?.error) return choose(el("div", "ky-error", `上次生成失败：${st.error}`));
    choose();
  })();

  return win;
}
