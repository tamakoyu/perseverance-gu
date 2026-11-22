// 题库：试卷列表、浏览题目、导入（PDF 文字层 / PDF OCR / 照片 / 粘贴文字）。
import { mountBankProgress } from "./bankprogress.js";
import { put, reset, optionsBlock, el, btn, select, field, md, errorBox, toast, runJob, tabs, fileToBase64, imageToBase64, storedImages, SUBJECTS, copy } from "./ui.js";

export function mountBank(ctx, container, signal) {
  const root = el("div", "ky-root");
  put(container, root);
  let tab = "progress";
  let papers = [];
  let current = null;
  const body = el("div");

  async function load() {
    try { papers = await ctx.call("bank.papers"); } catch (err) { reset(body, errorBox(err)); return; }
    if (!signal.aborted) render();
  }

  function render() {
    reset(root, el("h2", "ky-h2", "题库"), tabs([["progress", "完成情况"], ["papers", `试卷（${papers.length}）`], ["import", "导入"], ["search", "搜索题目"]], tab, (k) => { tab = k; current = null; render(); }), body);
    reset(body);
    if (tab === "progress") mountBankProgress(ctx, body, signal);
    else if (tab === "papers") current ? renderPaper(current) : renderPapers();
    else if (tab === "import") renderImport();
    else renderSearch();
  }

  function renderPapers() {
    if (!papers.length) {
      put(body, el("p", "ky-empty", "题库还是空的。去「导入」导入真题 PDF / 照片 / 文字，或在模考里让 AI 按考点出题。"));
      return;
    }
    put(body, missingBox(null), figureBox(null));
    const card = (p, title) => el("button", { type: "button", class: "ky-paper", title: p.paper, onclick: () => { current = p.paper; render(); } },
      el("b", null, title), el("span", "ky-muted", `${p.count} 题 · ${p.answered} 题有答案`));
    for (const s of SUBJECTS) {
      const real = papers.filter((p) => p.subject === s && p.source !== "习题");
      if (real.length) {
        put(body, el("div", "ky-group", `${s} · 真题`));
        put(body, el("div", "ky-paper-grid", ...real.map((p) => card(p, p.paper))));
      }
      // 习题书：每本书一组，书里按「篇·科目」或「科目·题型」分小组，格子里只写章节 / 主题名
      const books = [...new Set(papers.filter((p) => p.subject === s && p.source === "习题").map((p) => p.book))];
      for (const book of books) {
        const list = papers.filter((p) => p.subject === s && p.source === "习题" && p.book === book);
        const sub = new Map();
        for (const p of list) {
          const rest = p.paper.replace(/^[^·]*·/, ""); // 去掉书名前缀「张宇1000题·」「660题·」
          const sp = rest.indexOf(" ");
          const [g, title] = sp > 0 ? [rest.slice(0, sp), rest.slice(sp + 1)] : ["", rest];
          if (!sub.has(g)) sub.set(g, []);
          sub.get(g).push(card(p, title));
        }
        const total = list.reduce((a, p) => a + p.count, 0), answered = list.reduce((a, p) => a + p.answered, 0);
        put(body, el("div", "ky-group", `${book || "习题"} · 习题`, el("span", "ky-muted ky-group-sub", `${list.length} 份 · ${total} 题 · ${answered} 题有答案`)));
        for (const [g, cards] of sub) put(body, g ? el("div", "ky-subgroup", g) : null, el("div", "ky-paper-grid", ...cards));
      }
    }
  }

  /** 缺答案 / 缺解析提示：paper 为 null 时统计全部。 */
  function missingBox(paper) {
    const box = el("div");
    ctx.call("bank.missingAnalysis").then((m) => {
      const pick = (o) => (paper ? { [paper]: o[paper] || 0 } : o);
      const ana = pick(m.byPaper), noAns = pick(m.noAnswerByPaper);
      const nAna = Object.values(ana).reduce((a, b) => a + b, 0), nAns = Object.values(noAns).reduce((a, b) => a + b, 0);
      if (!nAna && !nAns) return;
      const list = (o) => { const e = Object.entries(o).filter(([, v]) => v); return e.slice(0, 6).map(([k, v]) => `${k} ${v} 题`).join("、") + (e.length > 6 ? ` 等 ${e.length} 份` : ""); };
      const parts = [];
      if (nAns) parts.push(`${nAns} 道题没有答案${paper ? "" : `（${list(noAns)}）`}`);
      if (nAna) parts.push(`${nAna} 道题有答案、没有解析${paper ? "" : `（${list(ana)}）`}`);
      const total = nAna + nAns;
      reset(box, el("div", "ky-notice",
        el("div", null, `${paper ? "这套" : ""}有 ${parts.join("，")}。`),
        el("div", "ky-hint", "还在导入的年份，等解析文件导完通常就有官方答案和解析了。确定没有的，可以让 AI 补全：有标准答案的按答案写解析；没有答案的由 AI 独立解题、写出答案和解析（都会标明「非官方」，之后导入的官方答案 / 解析会自动替换）。"),
        el("div", "ky-row", btn(`AI 补全（${total} 题）`, async () => {
          if (!confirm(`让 AI 补全 ${total} 道题？${nAns ? `其中 ${nAns} 道要 AI 自己解题，答案可能有误。` : ""}每题调用一次模型。`)) return;
          try {
            const r = await runJob(ctx, box, () => ctx.call("bank.fillAnalysis", paper ? { paper } : {}), "AI 补全");
            toast(root, `已补全 ${r.done} 题${r.solved ? `（其中 ${r.solved} 题是 AI 解答）` : ""}${r.failed.length ? `，${r.failed.length} 题失败` : ""}`);
            render();
          } catch (err) { reset(box, errorBox(err)); }
        }, "ky-btn ky-btn-primary"))));
    }, () => {});
    return box;
  }

  /** 有图但还没裁出插图的题。 */
  function figureBox(paper) {
    const box = el("div");
    ctx.call("bank.missingFigures").then((m) => {
      const n = paper ? m.byPaper[paper] || 0 : m.total;
      if (!n) return;
      reset(box, el("div", "ky-notice",
        el("div", null, `${paper ? "这套" : ""}有 ${n} 道题带图，现在显示的是整页原卷截图。可以让 AI 在原卷上找到图的位置，把图单独裁出来放进题目里。`),
        el("div", "ky-row", btn(`裁出插图（${n} 题）`, async () => {
          try {
            const r = await runJob(ctx, box, () => ctx.call("bank.cropFigures", paper ? { paper } : {}), "裁出插图");
            toast(root, `已裁出 ${r.done} 题的插图${r.failed.length ? `，${r.failed.length} 题没找到图（仍显示原卷页面）` : ""}`);
            render();
          } catch (err) { reset(box, errorBox(err)); }
        }, "ky-btn ky-btn-primary"))));
    }, () => {});
    return box;
  }

  /** 题干：有裁好的插图时，把「[图：…]」文字描述换成真正的图。 */
  function stemBlock(q) {
    if (!q.figures?.length) return md(ctx, q.stem, signal);
    const stem = q.stem.replace(/\n*\[图[：:][^\]]*\]\n*/g, "\n\n").trim();
    return el("div", null, md(ctx, stem, signal), storedImages(ctx, q.figures, "ky-figures"));
  }

  function questionCard(q, { editable = true } = {}) {
    const det = el("details", "ky-card");
    put(det, el("summary", "ky-sum", el("span", "ky-tag", q.type), el("b", null, `第 ${q.number || "?"} 题`), el("span", "ky-muted", `${q.score || ""} 分 · ${(q.topics || []).join("、")}${q.answer ? "" : " · 缺答案"}${q.source === "AI生成" ? " · AI 生成" : q.source === "习题" ? " · 习题" : ""}`)));
    det.addEventListener("toggle", () => {
      if (!det.open || det.dataset.filled) return;
      det.dataset.filled = "1";
      if (q.material) put(det, el("details", "ky-material", el("summary", null, "阅读材料"), md(ctx, q.material, signal)));
      put(det, stemBlock(q));
      put(det, optionsBlock(ctx, q.options, signal));
      if (q.images?.length) {
        const page = el("details", "ky-material", el("summary", null, q.figures?.length ? "原卷页面" : "原卷页面（含图）"));
        page.addEventListener("toggle", () => { if (page.open && !page.dataset.filled) { page.dataset.filled = "1"; put(page, storedImages(ctx, q.images)); } });
        if (!q.figures?.length) page.open = true;
        put(det, page);
      }
      const ans = el("textarea", { class: "ky-input ky-ta", placeholder: "答案" }, q.answer || "");
      const ana = el("textarea", { class: "ky-input ky-ta", placeholder: "解析" }, q.analysis || "");
      const topics = el("input", { class: "ky-input", value: (q.topics || []).join("、") });
      if (editable) {
        // 默认渲染公式；点「编辑」才显示源码输入框
        const view = el("div");
        const aiBox = el("div");
        const showView = () => reset(view,
          el("h4", "ky-h4", "答案", q.answerSource === "AI" ? el("span", "ky-tag ky-tag-ai", "AI 解答 · 非官方") : null), md(ctx, q.answer || "（暂无）", signal),
          el("h4", "ky-h4", "解析", q.analysisSource === "AI" ? el("span", "ky-tag ky-tag-ai", q.answerSource === "AI" ? "AI 解答 · 非官方" : "AI 按标准答案补写 · 非官方") : null),
          md(ctx, q.analysis || "（暂无）", signal),
          !q.analysis?.trim() || !q.answer?.trim() ? el("div", "ky-row", btn(q.answer?.trim() ? "AI 按标准答案写解析" : "AI 解题（写答案和解析）", async () => {
            try {
              const r = await runJob(ctx, aiBox, () => ctx.call("bank.fillAnalysis", { ids: [q.id] }), q.answer?.trim() ? "写解析" : "解题");
              if (r.failed?.length) throw new Error(r.failed[0]);
              await refresh();
              reset(aiBox);
              showView();
            } catch (err) { reset(aiBox, errorBox(err)); }
          }, "ky-btn ky-btn-primary")) : null,
          aiBox,
          q.hasFigure && q.images?.length ? el("div", "ky-row", btn(q.figures?.length ? "图裁得不对？重新裁图" : "裁出插图", async () => {
            try {
              const r = await runJob(ctx, aiBox, () => ctx.call("bank.cropFigures", { ids: [q.id], force: true }), "裁图");
              if (r.failed?.length) throw new Error(r.failed[0]);
              await refresh();
              reset(aiBox);
              toast(root, "已更新插图，重新展开这题查看");
              det.open = false; delete det.dataset.filled;
              for (const c of [...det.children]) if (c.tagName !== "SUMMARY") c.remove();
            } catch (err) { reset(aiBox, errorBox(err)); }
          }, "ky-btn ky-btn-ghost")) : null,
          (q.topics || []).length ? el("div", "ky-muted", `考点：${q.topics.join("、")}`) : null);
        const refresh = async () => {
          const fresh = (await ctx.call("bank.list", q.paper ? { paper: q.paper, limit: 500 } : { q: q.stem.slice(0, 20), limit: 100 })).items.find((x) => x.id === q.id);
          if (fresh) Object.assign(q, fresh);
          ans.value = q.answer || ""; ana.value = q.analysis || "";
          showView();
        };
        const editor = el("div", "ky-hidden", field("答案（Markdown / LaTeX）", ans), field("解析", ana), field("考点（顿号分隔）", topics));
        const saveBtn = btn("保存修改", async () => {
          try {
            const patch = { answer: ans.value, analysis: ana.value, topics: topics.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) };
            await ctx.call("bank.update", { id: q.id, patch });
            Object.assign(q, patch);
            showView();
            editor.classList.add("ky-hidden"); view.classList.remove("ky-hidden"); saveBtn.classList.add("ky-hidden"); editBtn.textContent = "编辑";
            toast(root, "已保存");
          } catch (err) { toast(root, err.message, "error"); }
        }, "ky-btn ky-btn-primary ky-hidden");
        const editBtn = btn("编辑", () => {
          const editing = editor.classList.toggle("ky-hidden") === false;
          view.classList.toggle("ky-hidden", editing);
          saveBtn.classList.toggle("ky-hidden", !editing);
          editBtn.textContent = editing ? "取消编辑" : "编辑";
          if (!editing) { ans.value = q.answer || ""; ana.value = q.analysis || ""; topics.value = (q.topics || []).join("、"); }
        });
        showView();
        put(det, view, editor,
          el("div", "ky-row", editBtn, saveBtn,
            btn("删除这题", async () => { if (confirm("删除这道题？")) { await ctx.call("bank.delete", { id: q.id }); det.remove(); } }, "ky-btn ky-btn-danger")));
      } else {
        put(det, el("h4", "ky-h4", "答案"), md(ctx, q.answer || "—", signal), q.analysis ? md(ctx, q.analysis, signal) : null);
      }
    });
    return det;
  }

  async function renderPaper(paper) {
    put(body, el("div", "ky-row", btn("← 返回", () => { current = null; render(); }, "ky-btn ky-btn-ghost"), el("h3", "ky-h3", paper),
      btn("整套模考", () => { sessionStorage.setItem("ky-exam-preset", JSON.stringify({ mode: "full", paper })); ctx.app.openView("exam"); }, "ky-btn ky-btn-primary"),
      btn("删除整套", async () => { if (confirm(`删除「${paper}」的全部题目？`)) { await ctx.call("bank.deletePaper", { paper }); current = null; load(); } }, "ky-btn ky-btn-danger")));
    put(body, missingBox(paper), figureBox(paper));
    const list = el("div");
    put(body, list);
    try {
      const r = await ctx.call("bank.list", { paper, limit: 500 });
      const sorted = r.items.sort((a, b) => (parseInt(a.number, 10) || 999) - (parseInt(b.number, 10) || 999));
      reset(list, ...sorted.map((q) => questionCard(q)));
    } catch (err) { reset(list, errorBox(err)); }
  }

  function renderSearch() {
    const q = el("input", { class: "ky-input", placeholder: "关键词（题干 / 考点）" });
    const subj = select([["", "全部科目"], ...SUBJECTS], "", () => {});
    const out = el("div");
    const go = async () => {
      try {
        const r = await ctx.call("bank.list", { q: q.value.trim(), subject: subj.value, limit: 100 });
        reset(out, el("div", "ky-muted", `共 ${r.total} 题${r.total > 100 ? "，显示前 100" : ""}`), ...r.items.map((x) => questionCard(x)));
      } catch (err) { reset(out, errorBox(err)); }
    };
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    put(body, el("div", "ky-row", subj, q, btn("搜索", go, "ky-btn ky-btn-primary")), out);
  }

  /** 识别用的 OCR 模型 + 并行页数，改了立即保存。 */
  function speedRow() {
    const row = el("div", "ky-grid2");
    const conc = el("input", { class: "ky-input", type: "number", min: "1", max: "12" });
    const hint = el("div", "ky-hint");
    Promise.all([ctx.call("settings.get"), ctx.call("models.list")]).then(([{ settings: s }, models]) => {
      const score = (m) => (/ocr/i.test(m.id) ? 0 : /vl|omni/i.test(m.id) ? 1 : 2);
      const sorted = models.slice().sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
      const cur = s.ocrModel ? `${s.ocrModel.provider}::${s.ocrModel.id}` : "";
      const pick = select([["", "跟随「视觉」模型槽"], ...sorted.map((m) => [`${m.provider}::${m.id}`, `${m.id}${score(m) === 0 ? "（OCR 专用，推荐）" : score(m) === 1 ? "（视觉）" : ""}`])], cur, async (v) => {
        const [provider, id] = v ? v.split("::") : [];
        await ctx.call("settings.save", { ocrModel: v ? { provider, id } : null });
        toast(root, v ? `识别改用 ${id}` : "识别跟随视觉模型槽");
      });
      conc.value = String(s.importConcurrency || 6);
      reset(row, field("识别用的模型（逐页转文字）", pick), field("同时识别几页", conc));
      reset(hint, "OCR 专用模型（如 qwen3.5-ocr、qwen-vl-ocr）只输出文字、不思考，比通用大模型快很多也便宜；拆题这一步仍用「强」模型。同时识别页数太高可能触发限流，6 左右比较稳。改动对下一份文件生效。");
    }, (err) => reset(row, errorBox(err)));
    conc.addEventListener("change", () => ctx.call("settings.save", { importConcurrency: Number(conc.value) }).then(() => toast(root, `同时识别 ${conc.value} 页`)));
    return el("div", null, row, hint);
  }

  function renderBatch() {
    const box = el("section", "ky-card");
    const pauseBtn = btn("暂停", async () => {
      try { await ctx.call("bank.batchPause"); toast(root, "正在暂停：手上这几页识别完就停，已完成的文件不会重做"); } catch (err) { toast(root, err.message, "error"); }
    }, "ky-btn ky-btn-ghost");
    pauseBtn.style.display = "none";
    const folder = el("input", { class: "ky-input" });
    const status = el("div");
    const out = el("div");
    const watch = async (job) => {
      try {
        const r = await runJob(ctx, out, () => Promise.resolve(job), "批量导入");
        reset(out, el("div", "ky-ok", r.files || r.failed.length ? `✓ 本次完成 ${r.files} 个文件：新增 ${r.added} 题，更新 ${r.updated} 题，合并答案 ${r.answered} 题。总进度 ${r.done}/${r.total}。` : `✓ 这个文件夹（${folder.value}）已经全部导入完了（${r.done}/${r.total}）。要导别的文件夹，先把上面的路径改掉。`),
          r.failed.length ? el("div", "ky-error", `失败 ${r.failed.length} 个（再点「继续」会重试）：\n${r.failed.join("\n")}`) : null);
      } catch (err) { reset(out, /已取消/.test(err.message) ? el("div", "ky-muted", "已暂停。点「开始 / 继续」会从没做完的文件接着导。") : errorBox(err)); }
      pauseBtn.style.display = "none";
      refresh();
    };
    const promptBox = el("div");
    const showPrompt = async () => {
      try {
        const { prompt } = await ctx.call("papers.prompt");
        const ta = el("textarea", { class: "ky-input ky-ta-lg", readonly: true, rows: 14 });
        ta.value = prompt;
        const doCopy = async () => {
          if (!(await copy(prompt))) { ta.focus(); ta.select(); document.execCommand("copy"); }
          toast(root, "已复制，粘贴给 Claude Code 等能操作本机文件的 agent 即可");
        };
        reset(promptBox,
          el("p", "ky-hint", "手里的真题 PDF 还没整理？把下面的提示词复制给能读写本机文件的 AI agent（如 Claude Code）。它会先问你考哪些科目、PDF 在哪、整理到哪，再按插件要求的格式复制改名并生成 manifest.json（原文件不动）。整理好后把文件夹填到上面，点「开始 / 继续」。"),
          ta,
          el("div", "ky-row", btn("复制提示词", doCopy, "ky-btn ky-btn-primary"), btn("收起", () => reset(promptBox), "ky-btn ky-btn-ghost")));
        ta.focus(); ta.select();
      } catch (err) { reset(promptBox, errorBox(err)); }
    };
    const refresh = async () => {
      try {
        const s = await ctx.call("bank.batchStatus", { folder: folder.value });
        if (!folder.value) folder.value = s.folder;
        const failed = Object.keys(s.failed || {}).length;
        reset(status, el("div", "ky-muted", s.total ? `进度：${s.done}/${s.total} 个文件已导入${failed ? `，${failed} 个失败待重试` : ""}` : "这个文件夹里没有 manifest.json"));
        if (s.running?.status === "running" && !out.firstChild) watch(s.running);
        pauseBtn.style.display = s.running?.status === "running" ? "" : "none";
      } catch (err) { reset(status, errorBox(err)); }
    };
    put(box,
      el("h3", "ky-h3", "批量导入整理好的文件夹（真题 / 习题书）"),
      el("p", "ky-muted", "按文件夹里的 manifest.json 逐个导入（每份 PDF 渲染成图片，用视觉模型识别，3 页并行）。先导题目、再导解析并按题号合并答案。可以随时关掉，已完成的文件不会重做，再点「开始 / 继续」会接着导。"),
      field("文件夹", folder), speedRow(), status, promptBox,
      el("div", "ky-row",
        btn("开始 / 继续", async () => {
          try { reset(out, el("div", "ky-muted", "准备中…")); const job = await ctx.call("bank.batchImport", { folder: folder.value }); reset(out); pauseBtn.style.display = ""; watch(job); } catch (err) { reset(out, errorBox(err)); }
        }, "ky-btn ky-btn-primary"),
        pauseBtn,
        btn("AI 整理真题", showPrompt, "ky-btn ky-btn-ghost"),
        btn("清空进度从头导", async () => {
          if (!confirm("清空导入进度并从头开始？（已导入的题会按题号更新，不会重复）")) return;
          try { watch(await ctx.call("bank.batchImport", { folder: folder.value, reset: true })); } catch (err) { reset(out, errorBox(err)); }
        }, "ky-btn ky-btn-ghost")),
      out);
    refresh();
    return box;
  }

  function renderPack() {
    const box = el("section", "ky-card");
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    // 导入
    const file = el("input", { class: "ky-input", placeholder: "题库包 .zip 的路径（或解压后的文件夹），如 ~/Downloads/考研题库包-20261118-1030.zip" });
    const found = el("div", "ky-row");
    const info = el("div");
    const out = el("div");
    const preview = async () => {
      if (!file.value.trim()) { reset(info); return; }
      try {
        const r = await ctx.call("pack.preview", { file: file.value.trim() });
        reset(info, el("div", "ky-muted", `题库包：${r.papers.length} 套试卷、${r.questions} 题、${r.images} 张图（${String(r.createdAt || "").slice(0, 10)} 导出）。将新增 ${r.fresh} 题${r.dup ? `，${r.dup} 题已有会跳过` : ""}。`));
      } catch (err) { reset(info, errorBox(err)); }
    };
    file.addEventListener("change", preview);
    const scan = async () => {
      try {
        const { packs } = await ctx.call("pack.find");
        reset(found, packs.length ? el("span", "ky-muted", "在下载 / 桌面 / 文稿里找到：") : null,
          ...packs.map((p) => btn(`${p.name}（${mb(p.size)}）`, () => { file.value = p.file; preview(); }, "ky-btn ky-btn-ghost")));
      } catch { reset(found); }
    };
    // 导出
    const subjChecks = SUBJECTS.map((s) => [s, el("input", { type: "checkbox", checked: true })]);
    const subjInfo = el("span", "ky-muted");
    const dir = el("input", { class: "ky-input", placeholder: "保存到哪个文件夹（默认 下载）" });
    const outExp = el("div");
    ctx.call("pack.summary").then((s) => {
      dir.placeholder = `保存到哪个文件夹（默认 ${s.defaultDir}）`;
      reset(subjInfo, `当前题库 ${s.papers} 套、${s.questions} 题：${Object.entries(s.subjects).map(([k, v]) => `${k} ${v}`).join("，") || "空"}`);
    }, () => {});
    put(box,
      el("h3", "ky-h3", "题库包（免识别，直接导入）"),
      el("p", "ky-muted", "别人已经识别整理好的题库，导出成一个 .zip 发给你，在这里一键导入，不用再 OCR、不花模型额度。只包含题目、答案、解析、插图和英语单元信息，不含错题、作答记录、生词和设置。已有的题（同一套试卷同一题号）会跳过，不会覆盖你改过的内容。"),
      field("导入题库包", file), found, info,
      el("div", "ky-row",
        btn("导入", async () => {
          if (!file.value.trim()) { toast(root, "先填题库包路径", "error"); return; }
          try {
            reset(out, el("div", "ky-muted", "正在导入…"));
            const r = await ctx.call("pack.import", { file: file.value.trim() });
            reset(out, el("div", "ky-ok", `✓ 新增 ${r.added} 题、${r.images} 张图、${r.unitsAdded} 个英语单元${r.skipped ? `；${r.skipped} 题已有，已跳过` : ""}${r.missingImages ? `；包里缺 ${r.missingImages} 张图` : ""}。`));
            toast(root, "导入完成");
          } catch (err) { reset(out, errorBox(err)); }
        }, "ky-btn ky-btn-primary"),
        btn("找找题库包", scan, "ky-btn ky-btn-ghost")),
      out,
      el("details", "ky-details",
        el("summary", null, "把我的题库导出成题库包"),
        el("div", "ky-row", ...subjChecks.map(([s, c]) => el("label", "ky-check", c, ` ${s}`)), subjInfo),
        field("保存位置", dir),
        el("p", "ky-hint", "真题题目本身可以分享；第三方解析书（如黄皮书等）的解析和译文有版权，分享给别人请注意范围。"),
        el("div", "ky-row", btn("导出题库包", async () => {
          const subjects = subjChecks.filter(([, c]) => c.checked).map(([s]) => s);
          if (!subjects.length) { toast(root, "至少选一个科目", "error"); return; }
          try {
            reset(outExp, el("div", "ky-muted", "正在打包…"));
            const r = await ctx.call("pack.export", { dir: dir.value.trim(), subjects: subjects.length === SUBJECTS.length ? [] : subjects });
            reset(outExp, el("div", "ky-ok", `✓ 已导出 ${r.papers} 套、${r.questions} 题、${r.images} 张图（${mb(r.size)}）：`), el("div", "ky-muted", r.file),
              r.missingImages ? el("div", "ky-muted", `有 ${r.missingImages} 张图在本机找不到，没打进去`) : null);
          } catch (err) { reset(outExp, errorBox(err)); }
        }, "ky-btn")),
        outExp));
    scan();
    return box;
  }

  function renderImport() {
    put(body, renderPack());
    put(body, renderBatch());
    const subj = select(SUBJECTS, "数学", () => {});
    const year = el("input", { class: "ky-input", type: "number", placeholder: "如 2024", min: "1987", max: "2030" });
    const paper = el("input", { class: "ky-input", placeholder: "试卷名，如：2024 数学一 / 2023 408 / 2022 英语一" });
    const kind = select([["questions", "题目（可含答案）"], ["answers", "只有答案解析（合并到已导入的同名试卷）"]], "questions", () => {});
    const source = select([["真题", "真题"], ["模拟题", "模拟题 / 教辅"]], "真题", () => {});
    const syncName = () => { if (!paper.value && year.value) paper.value = `${year.value} ${subj.value === "数学" ? "数学一" : subj.value === "英语" ? "英语一" : subj.value}`; };
    year.addEventListener("change", syncName);

    const fileInput = el("input", { type: "file", accept: ".pdf,.md,.txt,.markdown,image/*", multiple: true, class: "ky-input" });
    const method = select([["auto", "自动（有文字层用文字，否则 OCR）"], ["ocr", "强制 OCR（公式多、文字层乱码时选这个）"], ["text", "只用文字层"]], "auto", () => {});
    const pages = el("input", { class: "ky-input", placeholder: "页码范围，如 1-12（留空 = 全部）" });
    const paste = el("textarea", { class: "ky-input ky-ta", placeholder: "或者直接粘贴试卷文字 / Markdown" });
    const out = el("div");

    const metaOf = () => {
      syncName();
      if (!paper.value.trim()) throw new Error("请填写试卷名");
      return { subject: subj.value, paper: paper.value.trim(), year: Number(year.value) || null, kind: kind.value, source: source.value };
    };
    const done = (r) => {
      reset(out, el("div", "ky-ok", `✓ 导入完成：新增 ${r.added} 题，更新 ${r.updated} 题${r.answered ? `，合并答案 ${r.answered} 题` : ""}。`),
        btn("查看这套题", () => { tab = "papers"; current = paper.value.trim(); load(); }));
      ctx.call("bank.papers").then((p) => {
        papers = p;
        const t = root.querySelector(".ky-tab");
        if (t) t.textContent = `试卷（${papers.length}）`;
      }, () => {});
    };

    const start = async () => {
      let meta;
      try { meta = metaOf(); } catch (err) { toast(root, err.message, "error"); return; }
      const files = [...fileInput.files];
      try {
        if (!files.length) {
          if (!paste.value.trim()) { toast(root, "请选择文件或粘贴文字"); return; }
          done(await runJob(ctx, out, () => ctx.call("bank.import", { ...meta, format: "text", text: paste.value }), "导入"));
          return;
        }
        const imgs = files.filter((f) => f.type.startsWith("image/"));
        if (imgs.length) {
          const data = [];
          for (const f of imgs.sort((a, b) => a.name.localeCompare(b.name, "zh"))) data.push(await imageToBase64(f, 2000));
          done(await runJob(ctx, out, () => ctx.call("bank.import", { ...meta, format: "images", images: data }), "识别照片"));
          return;
        }
        const f = files[0];
        if (/\.pdf$/i.test(f.name)) {
          const [first, last] = (pages.value.match(/(\d+)\s*[-~–]\s*(\d+)/) || []).slice(1).map(Number);
          let useOcr = method.value === "ocr";
          if (method.value !== "ocr") {
            const conv = await ctx.documents.toMarkdown(f);
            const textLen = conv.markdown.replace(/\s/g, "").length;
            if (method.value === "text" || textLen > 800) {
              done(await runJob(ctx, out, () => ctx.call("bank.import", { ...meta, format: "text", text: conv.markdown }), "导入"));
              return;
            }
            useOcr = true;
            toast(root, "PDF 没有可用的文字层，改用 OCR");
          }
          if (useOcr) {
            if (f.size > 40 * 1024 * 1024) { toast(root, "PDF 太大（>40MB），请拆分后导入", "error"); return; }
            const pdf = await fileToBase64(f);
            done(await runJob(ctx, out, () => ctx.call("bank.import", { ...meta, format: "pdf", pdf, first, last }), "OCR 导入"));
          }
          return;
        }
        const text = await f.text();
        done(await runJob(ctx, out, () => ctx.call("bank.import", { ...meta, format: "text", text }), "导入"));
      } catch (err) { reset(out, errorBox(err)); }
    };

    put(body, el("section", "ky-card",
      el("h3", "ky-h3", "导入试卷"),
      el("p", "ky-muted", "支持：真题 PDF（文字版或扫描版）、多张照片（按文件名排序当作页序）、Markdown/文本。AI 会逐题结构化（题号、题型、选项、答案、考点），同一试卷重复导入会按题号更新。答案在单独文件里的，先导题目，再用「只有答案解析」导入答案。"),
      el("div", "ky-grid2", field("科目", subj), field("年份", year)),
      field("试卷名", paper), el("div", "ky-grid2", field("内容", kind), field("类型", source)),
      field("文件", fileInput), el("div", "ky-grid2", field("PDF 识别方式", method), field("页码", pages)),
      field("粘贴文字", paste),
      el("div", "ky-row", btn("开始导入", start, "ky-btn ky-btn-primary"), btn("测试视觉模型", async () => {
        try {
          const r = await runJob(ctx, out, () => ctx.call("vision.test"), "测试");
          reset(out, el("div", "ky-ok", `视觉模型 ${r.model.provider}/${r.model.id} 回复：${r.reply}`));
        } catch (err) { reset(out, errorBox(err)); }
      })),
      el("p", "ky-hint", "OCR 每页调用一次视觉模型（设置 → 模型 里的「视觉」槽），会产生费用；30 页的卷子大约 30 次调用。"),
      out));
  }

  put(root, el("p", "ky-muted", "加载中…"));
  load();
}
