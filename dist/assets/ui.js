// 考研工具箱前端公共工具。
export const SUBJECTS = ["数学", "408", "英语", "政治"];

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (typeof attrs === "string") node.className = attrs;
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "value") node.value = v;
      else if (k === "checked") node.checked = !!v;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const btn = (label, onclick, cls = "ky-btn") => el("button", { type: "button", class: cls, onclick }, label);

export function select(options, value, onchange, cls = "ky-input") {
  const s = el("select", { class: cls, onchange: (e) => onchange?.(e.target.value) });
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    s.append(el("option", { value: v, selected: String(v) === String(value) }, label));
  }
  return s;
}

export function field(label, control, hint) {
  return el("label", "ky-field", el("span", "ky-label", label), control, hint ? el("span", "ky-hint", hint) : null);
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 用宿主 Markdown（含 LaTeX）渲染。 */
export function md(ctx, text, signal, cls = "ky-md") {
  const box = el("div", cls);
  if (!text) return box;
  try { ctx.ui.mountMarkdown(box, { text: String(text) }, { signal }); }
  catch { box.textContent = String(text); }
  return box;
}

export function toast(root, message, kind = "info") {
  const t = el("div", `ky-toast ky-toast-${kind}`, message);
  (root || document.body).append(t);
  setTimeout(() => t.remove(), 4000);
}

export function errorBox(err) {
  return el("div", "ky-error", `出错了：${err?.message || err}`);
}

/** 压缩图片为 JPEG base64（不带 data: 前缀）。 */
export async function imageToBase64(file, maxSide = 1800, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
      i.src = url;
    });
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 照片选择器：返回 {node, get(): base64[] , clear()} */
export function photoPicker(label = "添加照片", { multiple = true } = {}) {
  const shots = [];
  const list = el("div", "ky-thumbs");
  const input = el("input", { type: "file", accept: "image/*", multiple, class: "ky-hidden" });
  const render = () => {
    list.replaceChildren(...shots.map((b64, i) => el("div", "ky-thumb",
      el("img", { src: `data:image/jpeg;base64,${b64}` }),
      el("button", { type: "button", class: "ky-thumb-x", onclick: () => { shots.splice(i, 1); render(); } }, "×"))));
  };
  input.addEventListener("change", async () => {
    for (const f of input.files) shots.push(await imageToBase64(f));
    input.value = "";
    render();
  });
  const node = el("div", "ky-photos", btn(`📷 ${label}`, () => input.click(), "ky-btn ky-btn-ghost"), input, list);
  return { node, get: () => shots.slice(), clear: () => { shots.length = 0; render(); } };
}

/** 显示已存储图片（按编号从后端取）。 */
export function storedImages(ctx, ids, cls = "ky-thumbs ky-thumbs-big") {
  const wrap = el("div", cls);
  for (const id of ids || []) {
    const img = el("img", { alt: "题目图片" });
    img.addEventListener("click", () => img.classList.toggle("ky-zoom"));
    wrap.append(img);
    ctx.call("image.get", { id }).then((r) => { img.src = `data:image/jpeg;base64,${r.data}`; }, () => { img.alt = "图片丢失"; });
  }
  return wrap;
}

/** 等待后端长任务完成；onProgress(job) 实时回调。 */
export function waitJob(ctx, job, onProgress) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (j) => {
      if (done) return;
      onProgress?.(j);
      if (j.status === "running") return;
      done = true;
      off?.();
      clearInterval(timer);
      if (j.status === "succeeded") resolve(j.result);
      else reject(new Error(j.error || (j.status === "cancelled" ? "已取消" : "任务失败")));
    };
    const off = ctx.onNotification((n) => { if (n.topic === "job" && n.data?.id === job.id) finish(n.data); });
    const poll = () => ctx.call("jobs.get", { id: job.id }).then((j) => j && finish(j), () => {});
    const timer = setInterval(poll, 2000);
    finish(job);
    // 任务可能在订阅通知之前就结束了，立刻查一次
    if (!done) poll();
  });
}

/** 带进度条的任务执行：在 host 里显示进度，完成后返回结果。 */
export async function runJob(ctx, host, start, label = "处理中") {
  const bar = el("div", "ky-progress", el("div", "ky-progress-fill"));
  const msg = el("span", "ky-progress-msg", `${label}…`);
  const box = el("div", "ky-job", msg, bar);
  host.replaceChildren(box);
  try {
    const job = await start();
    return await waitJob(ctx, job, (j) => {
      msg.textContent = `${j.label || label}：${j.message || ""}${j.total ? `（${j.done}/${j.total}）` : ""}`;
      bar.firstChild.style.width = j.total ? `${Math.round((j.done / j.total) * 100)}%` : "15%";
      bar.firstChild.classList.toggle("ky-progress-smooth", !!j.total); // 知道进度就不再闪
    });
  } finally {
    box.remove();
  }
}

export function tabs(items, current, onPick) {
  return el("div", { class: "ky-tabs", role: "tablist" }, ...items.map(([key, label]) => el("button", { type: "button", role: "tab", "aria-selected": key === current ? "true" : "false", class: `ky-tab${key === current ? " ky-on" : ""}`, onclick: () => onPick(key) }, label)));
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export const RATINGS = [[1, "再来", "ky-r1"], [2, "困难", "ky-r2"], [3, "良好", "ky-r3"], [4, "简单", "ky-r4"]];

/** append / replaceChildren，但跳过 null / undefined / false（原生方法会把它们变成文字）。 */
const clean = (kids) => kids.flat().filter((c) => c !== null && c !== undefined && c !== false);
export function put(parent, ...kids) { parent.append(...clean(kids)); return parent; }
export function reset(parent, ...kids) { parent.replaceChildren(...clean(kids)); return parent; }

/** 选择题选项：每个选项一行，字母徽标 + 渲染后的内容。 */
export function optionsBlock(ctx, options, signal) {
  if (!options?.length) return null;
  return el("div", "ky-opts", ...options.map((o) => el("div", "ky-opt", el("span", "ky-opt-key", o.key), md(ctx, String(o.text || "").replace(/^\s*[(（]?[A-G][)）.．、]\s*/, ""), signal, "ky-md ky-inline"))));
}

/**
 * 手写画板：笔 / 橡皮 / 撤销 / 清空 / 加长。笔、鼠标、手指都能写（镜像到 iPad 时 Apple Pencil 也走这里）。
 * 返回 {node, get(): base64 JPEG（白底黑字）或 null, isEmpty(), clear()}。
 */
export function inkPad({ height = 380, label = "手写作答" } = {}) {
  const strokes = [];
  let mode = "pen";
  let h = height;
  const canvas = el("canvas", "ky-ink-canvas");
  const box = el("div", "ky-ink-box", canvas);
  const g = canvas.getContext("2d");
  const dpr = () => window.devicePixelRatio || 1;
  const width = () => box.clientWidth || 600;
  const ink = () => getComputedStyle(box).color || "#111";

  function paint(ctx2, list, color, scale = 1) {
    ctx2.lineCap = "round";
    ctx2.lineJoin = "round";
    for (const s of list) {
      ctx2.globalCompositeOperation = s.mode === "erase" ? "destination-out" : "source-over";
      ctx2.strokeStyle = color;
      ctx2.fillStyle = color;
      const pts = s.pts;
      if (pts.length === 1) {
        ctx2.beginPath();
        ctx2.arc(pts[0][0] * scale, pts[0][1] * scale, (s.mode === "erase" ? 9 : 1.4) * scale, 0, Math.PI * 2);
        ctx2.fill();
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0, p0] = pts[i - 1];
        const [x1, y1, p1] = pts[i];
        ctx2.lineWidth = (s.mode === "erase" ? 18 : 1.2 + 2.2 * ((p0 + p1) / 2)) * scale;
        ctx2.beginPath();
        ctx2.moveTo(x0 * scale, y0 * scale);
        ctx2.lineTo(x1 * scale, y1 * scale);
        ctx2.stroke();
      }
    }
    ctx2.globalCompositeOperation = "source-over";
  }
  function redraw() {
    const w = width();
    const r = dpr();
    if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(h * r)) {
      canvas.width = Math.round(w * r);
      canvas.height = Math.round(h * r);
      canvas.style.height = `${h}px`;
    }
    g.setTransform(r, 0, 0, r, 0, 0);
    g.clearRect(0, 0, w, h);
    paint(g, strokes, ink());
  }

  let cur = null;
  const pos = (e) => {
    const rc = canvas.getBoundingClientRect();
    const p = e.pointerType === "pen" || (e.pressure > 0 && e.pressure !== 0.5) ? e.pressure : 0.5;
    return [e.clientX - rc.left, e.clientY - rc.top, p];
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const erase = mode === "erase" || e.button === 5 || (e.buttons & 32);
    cur = { mode: erase ? "erase" : "pen", pts: [pos(e)] };
    strokes.push(cur);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) cur.pts.push(pos(ev));
    redraw();
  });
  const end = () => { cur = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const tool = (name, text, m) => {
    const b = el("button", { type: "button", class: `ky-btn ky-btn-sm${mode === m ? " ky-on" : ""}`, title: name }, text);
    b.addEventListener("click", () => { mode = m; bar.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("ky-on", x.dataset.tool === m)); });
    b.dataset.tool = m;
    return b;
  };
  const bar = el("div", "ky-ink-bar",
    el("span", "ky-label", `✍️ ${label}`),
    tool("笔", "笔", "pen"), tool("橡皮", "橡皮", "erase"),
    btn("撤销", () => { strokes.pop(); redraw(); }, "ky-btn ky-btn-sm"),
    btn("清空", () => { if (!strokes.length || confirm("清空画板？")) { strokes.length = 0; redraw(); } }, "ky-btn ky-btn-sm"),
    btn("加长", () => { h += 240; redraw(); }, "ky-btn ky-btn-sm"));
  const node = el("div", "ky-ink", bar, box);
  new ResizeObserver(() => redraw()).observe(box);
  requestAnimationFrame(redraw);

  function get() {
    if (!strokes.some((s) => s.mode === "pen")) return null;
    // 只导出有字的区域，白底黑字
    let maxY = 0;
    for (const s of strokes) for (const p of s.pts) maxY = Math.max(maxY, p[1]);
    const w = width();
    const outH = Math.min(h, Math.ceil(maxY + 30));
    const scale = Math.min(2, 1800 / Math.max(w, outH));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(outH * scale);
    const x = c.getContext("2d");
    const layer = document.createElement("canvas");
    layer.width = c.width;
    layer.height = c.height;
    paint(layer.getContext("2d"), strokes, "#111", scale);
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(layer, 0, 0);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }
  return { node, get, isEmpty: () => !strokes.some((s) => s.mode === "pen"), clear: () => { strokes.length = 0; redraw(); } };
}

/** mm:ss；负数表示超时。 */
export function clock(sec) {
  const s = Math.abs(Math.round(sec));
  return `${sec < 0 ? "+" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 批注层：盖在一个可滚动元素（host，需 position:relative）的整个内容上，随内容一起滚动。
 * 开启时笔 / 荧光笔 / 橡皮直接画在文字上；关闭时不拦截点击和选字。
 * strokes 由调用方保存（切换题组再回来还在）。
 */
export function inkOverlay(host, strokes = []) {
  const canvas = el("canvas", "ky-anno");
  host.append(canvas);
  const g = canvas.getContext("2d");
  let tool = "pen";
  let cur = null;
  let w = 0, h = 0;
  const COLORS = { pen: "#e0453a", blue: "#3a6ee0", hl: "rgba(255, 205, 0, 0.38)" };

  function measure() {
    canvas.style.height = "0px";
    const nw = host.clientWidth;
    const nh = Math.max(host.scrollHeight, host.clientHeight);
    const r = window.devicePixelRatio || 1;
    if (nw !== w || nh !== h) {
      w = nw; h = nh;
      canvas.width = Math.round(w * r);
      canvas.height = Math.round(h * r);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    g.setTransform(r, 0, 0, r, 0, 0);
    redraw();
  }
  function redraw() {
    g.clearRect(0, 0, w, h);
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of strokes) {
      g.strokeStyle = COLORS[s.tool] || COLORS.pen;
      g.lineWidth = s.tool === "hl" ? 16 : s.width || 2;
      g.beginPath();
      s.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
      g.stroke();
    }
  }
  const pos = (e) => { const rc = canvas.getBoundingClientRect(); return [e.clientX - rc.left, e.clientY - rc.top]; };
  function eraseAt([x, y]) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const r = s.tool === "hl" ? 12 : 10;
      if (s.pts.some(([a, b]) => (a - x) ** 2 + (b - y) ** 2 < r * r)) { strokes.splice(i, 1); redraw(); }
    }
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (tool === "erase" || (e.buttons & 32)) { cur = { erase: true }; eraseAt(pos(e)); return; }
    const p = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    cur = { tool, width: 1.2 + 2 * p, pts: [pos(e)], t: Date.now() };
    strokes.push(cur);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (cur.erase) { for (const ev of evs) eraseAt(pos(ev)); return; }
    for (const ev of evs) cur.pts.push(pos(ev));
    // 荧光笔拉成水平直线，方便划整行
    if (cur.tool === "hl" && cur.pts.length > 2) {
      const [x0, y0] = cur.pts[0];
      const [x1, y1] = cur.pts[cur.pts.length - 1];
      if (Math.abs(y1 - y0) < 14 && Math.abs(x1 - x0) > 20) cur.pts = [[x0, y0], [x1, y0]];
    }
    redraw();
  });
  const end = () => { cur = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const ro = new ResizeObserver(() => measure());
  ro.observe(host);
  for (const c of host.children) if (c !== canvas) ro.observe(c);
  requestAnimationFrame(measure);
  setTimeout(measure, 600);

  return {
    setEnabled(on) { canvas.classList.toggle("ky-anno-on", !!on); },
    setTool(t) { tool = t; },
    undo() { strokes.pop(); redraw(); },
    clear() { strokes.length = 0; redraw(); },
    measure,
    destroy() { ro.disconnect(); canvas.remove(); },
  };
}

/**
 * 「新窗口手写」：在系统浏览器里打开一块白板（可拖到 iPad 上写），提交后图片自动回到这里。
 * 返回 {node, get(): base64[], isEmpty()}。
 */
export function remotePad(ctx, { key, title, stem = "", onChange } = {}) {
  let images = [];
  let id = null;
  let poll = null;
  let last = 0;
  const status = el("span", "ky-muted", "");
  const thumbs = el("div", "ky-thumbs");
  const render = () => {
    reset(thumbs, ...images.map((b64, i) => el("div", "ky-thumb",
      el("img", { src: `data:image/jpeg;base64,${b64}`, alt: `第 ${i + 1} 页`, onclick: (e) => e.target.classList.toggle("ky-zoom") }))));
    if (images.length) put(thumbs, btn("移除", () => { images = []; last = Date.now(); render(); onChange?.(); }, "ky-btn ky-btn-sm ky-btn-ghost"));
    status.textContent = images.length ? `✓ 已收到新窗口的手写（${images.length} 页），交卷时一起提交` : id ? "等你在白板里点「提交为答案」…" : "";
  };
  async function fetchNow() {
    if (!id) return;
    try {
      const r = await ctx.call("pad.take", { id });
      if (r.images && r.submittedAt > last) { last = r.submittedAt; images = r.images; render(); onChange?.(); }
    } catch { /* 忽略 */ }
  }
  const off = ctx.onNotification((n) => { if (n.topic === "pad" && n.data?.id === id) fetchNow(); });
  const openBtn = btn("🖥 新窗口手写（可拖到 iPad）", async () => {
    try {
      const r = await ctx.call("pad.open", { key, title, stem });
      id = r.id;
      window.open(r.url, "_blank");
      render();
      clearInterval(poll);
      poll = setInterval(() => { if (!node.isConnected) { clearInterval(poll); off?.(); return; } fetchNow(); }, 3000);
    } catch (err) { status.textContent = `打不开白板：${err.message}`; }
  }, "ky-btn");
  const node = el("div", "ky-remote", el("div", "ky-row", openBtn, status), thumbs);
  return { node, get: () => images.slice(), isEmpty: () => !images.length };
}

/**
 * 整套练习共用一块「新窗口白板」：只打开一次，换题时白板自动跟到当前题。
 * 选择 / 填空题在白板上是草稿；解答题点白板里的「发送到本题」，图片回到对应那题。
 * 返回 {button, focus(q), slot(qid), get(qid), isEmpty(qid)}。
 */
export function padBoard(ctx, { key, title, onNav, onChange, when = "交卷时", tip } = {}) {
  let id = null;
  let current = null;
  const images = {};
  const last = {};
  const slots = {};
  const status = el("span", "ky-muted ky-pad-status", "");
  const say = (t) => { status.textContent = t; };
  async function sendFocus() {
    if (!id || !current) return;
    try { await ctx.call("pad.focus", { id, ...current }); } catch (err) { say(`白板同步失败：${err.message}`); }
  }
  async function fetchNow(qid) {
    if (!id || !qid) return;
    try {
      const r = await ctx.call("pad.take", { id, qid });
      if (r.images && r.submittedAt > (last[qid] || 0)) { last[qid] = r.submittedAt; images[qid] = r.images; renderSlot(qid); onChange?.(qid); }
    } catch { /* 忽略 */ }
  }
  function renderSlot(qid) {
    const s = slots[qid];
    if (!s) return;
    const imgs = images[qid] || [];
    reset(s.thumbs, ...imgs.map((b64, i) => el("div", "ky-thumb",
      el("img", { src: `data:image/jpeg;base64,${b64}`, alt: `第 ${i + 1} 页`, onclick: (e) => e.target.classList.toggle("ky-zoom") }))));
    if (imgs.length) put(s.thumbs, btn("移除", () => {
      delete images[qid]; last[qid] = Date.now(); renderSlot(qid); onChange?.(qid);
      if (id) ctx.call("pad.drop", { id, qid }).catch(() => {});
    }, "ky-btn ky-btn-sm ky-btn-ghost"));
    s.status.textContent = imgs.length ? `✓ 已收到白板的手写（${imgs.length} 页），${when}一起提交` : id ? "在白板里写完点「发送到本题」" : "点上方「🖥 白板」在新窗口手写（可拖到 iPad），写完点「发送到本题」";
  }
  // 页面重画时按钮会短暂离开文档（或切到别的标签页），所以通知订阅 / 轮询可以停了再接上
  let off = null;
  let poll = null;
  function watch() {
    if (!off) off = ctx.onNotification((n) => {
      if (n.topic !== "pad" || n.data?.id !== id) return;
      if (n.data.nav) onNav?.(n.data.dir, n.data.qid);
      else fetchNow(n.data.qid);
    });
    if (!poll) poll = setInterval(() => {
      if (!button.isConnected) { clearInterval(poll); poll = null; off?.(); off = null; return; }
      if (current?.mode === "answer") fetchNow(current.qid);
    }, 3000);
  }
  const button = btn("🖥 白板", async () => {
    try {
      const r = await ctx.call("pad.board", { key, title });
      id = r.id;
      await sendFocus();
      if (r.opened) say("白板已经在浏览器里开着，换题会自动跟过去");
      else { window.open(r.url, "_blank"); say("白板已在浏览器打开，换题会自动跟过去"); }
      Object.keys(slots).forEach(renderSlot);
      watch();
      if (current?.mode === "answer") fetchNow(current.qid);
    } catch (err) { say(`打不开白板：${err.message}`); }
  }, "ky-btn");
  button.title = tip || "在系统浏览器里开一块白板（可拖到 iPad）。整套题只开一次：选择 / 填空当草稿纸，解答题写完点「发送到本题」";
  return {
    button: el("span", "ky-pad-board", button, status),
    focus(q) { current = q; sendFocus(); if (id) { watch(); fetchNow(q.qid); } },
    slot(qid) {
      if (!slots[qid]) slots[qid] = { status: el("span", "ky-muted", ""), thumbs: el("div", "ky-thumbs") };
      const s = slots[qid];
      renderSlot(qid);
      return el("div", "ky-remote", el("div", "ky-row", s.status), s.thumbs);
    },
    get: (qid) => (images[qid] || []).slice(),
    isEmpty: (qid) => !images[qid]?.length,
    /** 这题收到的手写已经用掉了（如错题评分后）：本地和白板都清掉 */
    forget(qid) { delete images[qid]; delete slots[qid]; if (id) ctx.call("pad.drop", { id, qid }).catch(() => {}); },
  };
}
