// 导出到 Obsidian：选原子笔记 / 普通笔记 / 不导出，预览、改文件夹和内容后写入仓库。
// 用插件自己的浮动窗口（可拖动、缩放、最小化），点窗口外面不会关掉；生成在后台跑，草稿落盘，关了也能回来接着改。
import { put, reset, el, btn, md, errorBox, waitJob } from "./ui.js";

const wins = new Map(); // chatId → 打开着的窗口
const GEO_KEY = "kaoyan.exportWin";

const loadGeo = () => { try { return JSON.parse(localStorage.getItem(GEO_KEY)) || null; } catch { return null; } };
const saveGeo = (g) => { try { localStorage.setItem(GEO_KEY, JSON.stringify(g)); } catch { /* 忽略 */ } };
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
      el("p", "ky-muted", auto ? "这次学习模式已经讲完。要把这个知识点整理成笔记放进 Obsidian 吗？" : "把这次会话讲过、考过的内容整理成笔记放进 Obsidian。"),
      el("div", "ky-choice-grid",
        choiceCard("原子笔记", "一页一个概念，放 concepts/<科目>/<课程>/，适合双链和复习", () => generate("atomic")),
        choiceCard("普通笔记", "一篇完整梳理（导航、例题、做题步骤、易错辨析），放 笔记/<科目>/<课程>/<主题>/", () => generate("normal")),
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
    const steps = ["读取会话记录", "整理已有文件夹和笔记", "模型写笔记", "整理生成结果"];
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
      // 前两步很快；第 3 步（模型）按 120 秒估计，渐近地走到 92%
      let pct = cur <= 2 ? cur * 4 : cur === 3 ? 8 + 84 * (1 - Math.exp(-((Date.now() - stepAt) / 1000) / 70)) : 96;
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

  async function generate(mode) {
    reset(body, el("div", "ky-muted", "正在开始…"));
    try {
      follow(await ctx.call("export.draft", { chatId, mode }));
    } catch (err) {
      reset(body, errorBox(err), el("div", "ky-row", btn("返回", () => choose()), btn("关闭", () => win.close(), "ky-btn ky-btn-ghost")));
    }
  }

  function review(draft, at) {
    win.setStatus(`${draft.notes.length} 篇草稿`);
    const list = el("datalist", { id: "ky-folders" }, ...folders.map((f) => el("option", { value: f })));
    const rows = draft.notes.map((n) => {
      const include = el("input", { type: "checkbox", checked: true });
      const folder = el("input", { class: "ky-input", value: n.folder, list: "ky-folders" });
      const name = el("input", { class: "ky-input", value: n.name });
      const content = el("textarea", { class: "ky-input ky-ta-lg ky-mono" }, n.content);
      const preview = el("div", "ky-preview ky-hidden");
      const toggle = btn("预览", () => {
        const showing = !preview.classList.contains("ky-hidden");
        if (showing) { preview.classList.add("ky-hidden"); content.classList.remove("ky-hidden"); toggle.textContent = "预览"; }
        else { reset(preview, md(ctx, content.value.replace(/^---[\s\S]*?---\n/, ""), signal)); preview.classList.remove("ky-hidden"); content.classList.add("ky-hidden"); toggle.textContent = "编辑"; }
      }, "ky-btn ky-btn-ghost ky-btn-sm");
      const box = el("details", { class: "ky-card", open: draft.notes.length === 1 },
        el("summary", "ky-sum", include, el("b", null, n.name), el("span", "ky-muted", `${n.folder}/`)),
        el("div", "ky-grid2", el("label", "ky-field", el("span", "ky-label", "文件夹（可改）"), folder), el("label", "ky-field", el("span", "ky-label", "笔记名"), name)),
        el("div", "ky-row", toggle), content, preview);
      return { include, folder, name, content, box };
    });
    const msg = el("div");
    const save = async (overwrite = []) => {
      const notes = rows.filter((r) => r.include.checked).map((r) => ({ folder: r.folder.value.trim(), name: r.name.value.trim(), content: r.content.value }));
      if (!notes.length) { reset(msg, el("div", "ky-error", "至少勾选一篇")); return; }
      try {
        const r = await ctx.call("export.save", { chatId, notes, overwrite });
        const exists = r.results.filter((x) => x.exists);
        if (exists.length) {
          reset(msg, el("div", "ky-warnbox", `这些笔记已存在：${exists.map((x) => x.path).join("、")}`,
            el("div", "ky-row", btn("覆盖它们", () => save(notes.map((n) => `${n.folder}/${n.name}`)), "ky-btn ky-btn-danger"), btn("我去改名", () => reset(msg)))));
          return;
        }
        win.setStatus("已写入");
        reset(body, el("div", "ky-ok", `✓ 已写入 Obsidian：`), el("ul", "ky-ul", ...r.results.map((x) => el("li", null, x.path))), btn("完成", () => win.close(), "ky-btn ky-btn-primary"));
      } catch (err) { reset(msg, errorBox(err)); }
    };
    reset(body, list,
      at ? el("div", "ky-warnbox", `这是 ${new Date(at).toLocaleString()} 生成、还没写入的草稿。`) : null,
      el("div", "ky-muted", `科目：${draft.subject || "?"} · 课程：${draft.course || "?"} · 主题：${draft.topic || "?"} · 共 ${draft.notes.length} 篇。文件夹、名字、内容都可以改，不想要的取消勾选。`),
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
