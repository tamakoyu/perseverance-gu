"use strict";
// 考研工具箱后端入口。
const fs = require("node:fs");
const path = require("node:path");
const { Store, fail, uid, nowIso, str, obj } = require("./server/util.cjs");
const fsrs = require("./server/fsrs.cjs");
const { createLlm } = require("./server/llm.cjs");
const { createVault } = require("./server/vault.cjs");
const { createNotes } = require("./server/notes.cjs");
const { createPdf } = require("./server/pdf.cjs");
const { createJobs } = require("./server/jobs.cjs");
const { createBank } = require("./server/bank.cjs");
const { createEnglish } = require("./server/english.cjs");
const { createStats } = require("./server/stats.cjs");
const { createEngImport } = require("./server/engimport.cjs");
const { createEngPractice } = require("./server/engpractice.cjs");
const { createPadServer } = require("./server/padserver.cjs");
const { SETUP_PROMPT, PAPERS_PROMPT } = require("./server/setupprompt.cjs");
const { createPack } = require("./server/pack.cjs");
const { createProgress } = require("./server/progress.cjs");

// 路径默认留空：每个人在 设置 → 考研工具箱 里填（或点「自动检测」从 Obsidian 读取）。
const DEFAULT_SETTINGS = {
  vaultPath: "",
  papersPath: "",
  examDate: "2027-12-18",
  ocrModel: null,
  importConcurrency: 6,
  studyMode: true,
  autoExportPrompt: true,
  sessionSubjects: {},
  exportPrompted: {},
  models: {},
};

const ERROR_TYPES = ["概念不清", "公式记错", "计算失误", "审题错误", "方法选择", "知识盲区", "其他"];
const MARKER = "学习者第一条消息以「【学习】」「[学习]」或「/study」开头";

const PROBER_STUDY = `## 学习模式（考研工具箱插件）
判断：只有当本会话${MARKER}时，本节才生效；否则完全忽略本节，按原有测底规则执行。
学习模式下，学习者明确表示这个知识点没有学过，要求从零开始学。此时：
- 不要测底：不出任何摸底题，不调用 probe / recall。
- 只有当学习目标模糊到无法规划时（例如只写了一个学科名），才用一句话问清范围，且只问一次；否则直接进入下一步。
- 在你的第一个回合里直接调用 probe_done。assessment.strands 列出本课要依赖的每条知识线；每条的 assessment 写明：「学习模式：本知识点按零基础处理，地板=未学过；前置知识不假设熟练，讲到时简短回顾」。summary 写明学习目标，并注明「学习模式：先讲后考，不做预测题」。
- 调用成功后用一句中文告诉学习者马上开始讲，然后结束回合。`;

const TEACHER_STUDY = `## 学习模式（考研工具箱插件）
判断：只有当本会话${MARKER}，或测底评估里写有「学习模式」时，本节才生效；否则忽略本节。本节与通用教学规则冲突时，以本节为准。
学习者是零基础，流程固定为「先讲 → 再考 → 找问题 → 修复」：
1. 不出预测题：不要使用 quiz 的 type: "predict"。每一步默认用讲授式把内容讲清楚：定义、直观理解、关键条件，至少一个完整例题；不要指望学习者自己推出来。
2. 每讲完一步，用 quiz 出一道检查题（type: "check"），考应用不考背诵，难度贴近考研。
3. 答错或答得含糊时：判断错因类型（${ERROR_TYPES.join(" / ")}），调用 kaoyan_log_mistake 记录，然后针对错因重讲，再换一道不同的检查题确认修复。连错两次就退回到更基础的一步。
4. 计划里所有节点都讲完后，做一次综合小测：3–5 道检查题，每回合一道，混合考查本课各知识点，题面不提示用哪个知识点。每题都照第 3 条处理错题。
5. 综合小测结束后，调用 kaoyan_study_report 生成问题清单，再用中文向学习者总结，并建议之后开一个练习会话做变式题。
全程用中文。`;

const VAULT_TEXT = `## 学习者的 Obsidian 考研笔记（考研工具箱插件）
学习者在 Obsidian 里有自己的考研笔记仓库（科目：数学 / 408 / 英语 / 政治）。可用工具：
- kaoyan_vault_search：按关键词检索笔记，返回路径和片段。
- kaoyan_vault_read：读取一篇笔记全文。
每个计划节点开讲前用 kaoyan_vault_search 搜一次学习者自己的笔记（同一节点内不要重复搜）：沿用其中的讲法、符号、例题和已经记下的易错点，并在讲解里自然地点出「你笔记里写过…」。不要大段照抄笔记，也不要因为没搜到就停下。
学习者在练习或检查题里答错时，可以调用 kaoyan_log_mistake 把题目记进错题本（附错因），之后会按遗忘曲线安排重做。

## 真题题库（考研工具箱插件）
学习者的题库里有历年数学一、408 真题（含答案和解析），可用工具：
- kaoyan_bank_search：按考点 / 关键词检索真题，返回题号、年份、题型和题干摘要（不含答案）。
- kaoyan_bank_get：按 id 取一道题的完整内容（题干、选项、答案、解析）。
真题是难度和考法的标尺，不是必须照搬的题目。核心是**只考学习者学过的东西**：
- **已学范围**＝本会话已经讲过的节点 + 测底显示已掌握的内容 + 学习者明确说学过的章节（笔记里有对应章节也可参考）。拿不准某个知识点学没学过时，当作没学过处理。
- 真题检索结果里的「考点」逐个对照已学范围：
  - **全部在范围内** → 用原题，注明出处（如「2019 年数一第 3 题」）。
  - **有超出范围的部分** → 改编：保留这道题的考法和陷阱，把超纲部分换成学过的内容，或删掉超纲的小问；注明「改编自 20xx 年数一第 n 题」。改动太大、原题考法已经保不住的，就换一道真题，或自己出同等难度的题。
  - 不要为了用真题而提前讲后面的内容，也不要出需要没学过的知识才能做的题。
什么时候用真题：
1. **规划时**：对计划里的主要考点检索真题（limit 8–10），**在同一个回合里并行发出这些检索**，不要一个一个等；看历年怎么考、考到多深，据此决定讲到什么深度、节点终点放在哪里；向学习者介绍计划时顺带说明「这个点近年常考 …」。
2. **每个计划节点讲完、转到下一个节点之前**：用一道真题难度的题收尾——按上面的规则用原题或改编题（优先近 15 年，用 yearFrom 过滤）。检索结果不对题就换更具体的考点词再搜一次；仍然没有合适的，自己出一道与真题同等难度的题。
3. 学习模式的综合小测里，尽量用原题或改编题（不必强求比例）。
4. 练习会话里，每个目标的主体题优先从真题里挑或照真题改编。
用法细节：
- 检索用具体考点词（「周期 抽象函数」「反常积分 比较判别」），不要只用「函数」「积分」这种泛词。
- 用真题出题时，**答案和解析只给你自己看**，绝不能在学习者作答前泄露；quiz 的解析 / 标准答案按官方解析整理，作答后结合官方解析讲评。标了「AI 解答 / AI 补写」的答案可能有误，先自己核对。
- 真题是多步综合题、且各步都在已学范围内时，用 quiz 的自由作答形式，或拆成几个选项考关键一步；不要只因为题目超出「刚讲的这一步」就放弃——节点收尾题本来就该综合已学的多个点。
- **记录完成情况**：用题库真题出的题，学习者一作答、你判定对错后，马上调用 kaoyan_bank_record（带真题 id、是否做对；主观题部分得分时带 score）。做错时调用 kaoyan_log_mistake 也带上 bankId。**只有原题才记录**；改编题、自己出的题不要调用 kaoyan_bank_record（错题本照常记，不带 bankId）。
- **省往返**：同一回合需要的检索 / 取题 / 记录工具一次并行发出；kaoyan_bank_record 和下一道题的检索可以放在同一回合。
- **计划图（plan_init）**：节点标题写短（中文不超过 16 个字），不要用 <br/> 或换行，细节放到讲解里。
- 题库只有数学一、408；英语、政治没有真题工具时，按下面「考研难度」自己出题。

## 考研难度（考研工具箱插件；本节与通用教学 / 出题规则冲突时，以本节为准）
学习者在备考全国硕士研究生统一考试（数学一 / 408 / 英语一 / 政治），目标是在考场上做对真题。
- 「一次只讲一步」是讲解的节奏，不是题目的难度。检查题可以只考刚讲的这一步，但必须是考研的样子：换条件、设陷阱（定义域、端点、可导与连续、充分非必要、反例）、或把这一步和前面讲过的内容组合。只是把刚讲的式子代一次数、照上一段讲解机械套用就能做对的题，太简单，重出。
- 选择题的干扰项要对应考研里真实常见的错误（漏条件、记反结论、混淆相近概念），不要放一眼就能排除的选项。
- 预测题保持引导性即可，但不要连续两步以上都是「预测 + 一步代入检查」的节奏，中间要插入考研难度的检查题。
- 难度调节：连续两道检查题答对且思路完整 → 下一道直接上真题难度的综合题（原题或改编，仍限已学范围）；答错 → 先针对错因修复，再用一道**同难度**的变式确认，不要退回纯代入题；同一点连错两次，才降回更基础的一步。
- 学习者说「复习」或测底显示已经学过时，起点就是考研难度：基础定义一句带过，直接从易错点和真题考法讲起。
- 学习者说太简单 / 太难时，立刻按他说的调整。`;

/** 支持 ~ 开头的路径。 */
function expandHome(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(home, s.slice(2));
  return s;
}
const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

/** 读取 Obsidian 自己记录的仓库列表（obsidian.json），方便别人一键选择。 */
function detectObsidianVaults() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "obsidian", "obsidian.json") : "",
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "obsidian", "obsidian.json"),
    path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
  ].filter(Boolean);
  const out = new Map();
  for (const f of candidates) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const v of Object.values(data.vaults || {})) {
      if (!v || !v.path || out.has(v.path)) continue;
      out.set(v.path, { path: v.path, name: path.basename(v.path), exists: isDir(v.path), open: !!v.open, ts: v.ts || 0 });
    }
  }
  return [...out.values()].sort((a, b) => (b.open - a.open) || (b.ts - a.ts));
}

exports.activate = (ctx) => {
  const store = new Store(ctx.dataDirectory);
  const settings = () => {
    const s = store.value("settings", DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...s, models: s.models || {} };
  };
  const saveSettings = (patch) => {
    const next = { ...settings(), ...patch };
    store.saveValue("settings", next);
    return next;
  };

  // 图片存 data/images/<id>.jpg
  const imageDir = path.join(ctx.dataDirectory, "images");
  const images = {
    save(base64) {
      if (typeof base64 !== "string" || base64.length < 100) fail("图片数据无效");
      fs.mkdirSync(imageDir, { recursive: true });
      const id = uid();
      fs.writeFileSync(path.join(imageDir, `${id}.jpg`), Buffer.from(base64, "base64"));
      return id;
    },
    get(id) {
      if (!/^[0-9a-f-]{36}$/.test(String(id))) fail("图片编号无效");
      const file = path.join(imageDir, `${id}.jpg`);
      if (!fs.existsSync(file)) fail("图片不存在");
      return fs.readFileSync(file).toString("base64");
    },
  };

  const llm = createLlm(ctx, settings);
  const vault = createVault(() => expandHome(settings().vaultPath));
  /** 真题文件夹（manifest.json 所在处）；没设置时返回空串。 */
  const papersRoot = () => expandHome(settings().papersPath);
  const needPapers = (folder) => { if (!folder) fail("还没设置真题文件夹，请在 设置 → 考研工具箱 里填写，或在这里直接填文件夹路径"); return folder; };
  const notes = createNotes({ ctx, llm, vault });
  const pdf = createPdf(ctx.dataDirectory);
  const jobs = createJobs(ctx);
  const bank = createBank({ store, llm, pdf, images, getSettings: settings, getPapersRoot: () => papersRoot() });
  const english = createEnglish({ store, llm });
  const progress = createProgress({ store, bank });
  const stats = createStats({ ctx, store, vault, bank });
  const engImport = createEngImport({ store, llm, pdf, images, bank, getSettings: settings });
  const engPractice = createEngPractice({ store, llm, bank });
  const pads = createPadServer({ signal: ctx.signal,
    onSubmit: (d) => { try { ctx.events.emit("pad", d); } catch { /* ignore */ } },
    onNav: (d) => { try { ctx.events.emit("pad", { ...d, nav: true }); } catch { /* ignore */ } } });
  const changed = (what) => { try { ctx.events.emit("changed", { what }); } catch { /* ignore */ } };

  // ── 错题本 ─────────────────────────────────────────────
  function addMistake(input) {
    const m = {
      id: uid(),
      subject: ["数学", "408", "英语", "政治"].includes(input.subject) ? input.subject : stats.classify(`${input.topic} ${input.question}`),
      topic: str(input.topic, 200) || "未分类",
      source: str(input.source, 200) || "手动录入",
      question: str(input.question, 20000),
      options: Array.isArray(input.options) ? input.options : [],
      learnerAnswer: str(input.learnerAnswer, 8000),
      correctAnswer: str(input.correctAnswer, 20000),
      errorType: str(input.errorType, 50) || "其他",
      diagnosis: str(input.diagnosis, 4000),
      images: Array.isArray(input.images) ? input.images.filter((x) => typeof x === "string") : [],
      chatId: input.chatId || null,
      bankId: input.bankId || null,
      card: fsrs.newCard(),
      history: [],
      archived: false,
      createdAt: nowIso(),
    };
    if (!m.question && !m.images.length) fail("错题至少要有题目文字或图片");
    const items = store.list("mistakes");
    items.push(m);
    store.saveList("mistakes", items);
    changed("mistakes");
    return m;
  }

  // 把单独的「学习模式」插件里记过的错题并进来（只导入一次）
  function importStudyModeMistakes() {
    const file = path.join(ctx.directory, "..", "..", "study-mode", "data", "mistakes.json");
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const seen = new Set(settings().importedStudyMode || []);
      let n = 0;
      for (const m of data.items || []) {
        if (seen.has(m.id)) continue;
        addMistake({ ...m, source: "学习模式", correctAnswer: m.correctAnswer, subject: undefined });
        seen.add(m.id);
        n++;
      }
      if (n) saveSettings({ importedStudyMode: [...seen] });
    } catch { /* 旧插件数据读不了就跳过 */ }
  }
  importStudyModeMistakes();

  // ── 智能体规则与工具 ───────────────────────────────────
  ctx.registerInstructions({ agents: ["teacher", "practice"], text: VAULT_TEXT });
  if (settings().studyMode) {
    ctx.registerInstructions({ agents: ["prober"], text: PROBER_STUDY });
    ctx.registerInstructions({ agents: ["teacher"], text: TEACHER_STUDY });
  }

  const textResult = (text, details) => ({ content: [{ type: "text", text }], details });
  const guard = (signal) => { if (signal?.aborted || ctx.signal.aborted) throw new Error("已取消"); };

  ctx.registerTools({
    agents: ["teacher", "practice", "prober"],
    create: (context) => {
      const tools = [
        {
          name: "kaoyan_vault_search",
          label: "检索 Obsidian 笔记",
          description: "在学习者的 Obsidian 考研笔记仓库里按关键词检索（中文关键词用空格分开），返回最相关的笔记路径与片段。",
          parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false },
          execute: async (_id, input, signal) => {
            guard(signal);
            const hits = vault.search(input.query, { limit: 6 });
            if (!hits.length) return textResult(`没有找到和「${input.query}」相关的笔记。`, { hits: [] });
            return textResult(hits.map((h) => `- ${h.path}\n  …${h.snippet}…`).join("\n"), { hits });
          },
        },
        {
          name: "kaoyan_vault_read",
          label: "读取 Obsidian 笔记",
          description: "读取学习者 Obsidian 仓库里一篇笔记的全文（path 用检索结果里的相对路径）。",
          parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 500 } }, required: ["path"], additionalProperties: false },
          execute: async (_id, input, signal) => {
            guard(signal);
            const note = vault.read(input.path);
            return textResult(`# ${note.path}\n\n${note.text}`, { path: note.path });
          },
        },
      ];
      if (context.agent === "prober") return tools;
      tools.push(
        {
          name: "kaoyan_bank_search",
          label: "检索真题",
          description: "在学习者的真题题库里按考点 / 关键词检索历年真题（中文关键词用空格分开），返回 id、出处、题型、题干摘要和考点，不含答案。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 200, description: "考点或关键词，如「反常积分 比较判别」「二叉树 遍历」" },
              subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
              type: { type: "string", enum: ["单选", "多选", "填空", "解答", "完形", "阅读", "新题型", "翻译", "小作文", "大作文", "分析"] },
              yearFrom: { type: "integer", minimum: 1987, maximum: 2100 },
              yearTo: { type: "integer", minimum: 1987, maximum: 2100 },
              limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          execute: async (_id, input, signal) => {
            guard(signal);
            const hits = bank.search(input.query, input);
            if (!hits.length) return textResult(`题库里没有找到和「${input.query}」相关的真题。`, { hits: [] });
            const lines = hits.map((q) => `- id=${q.id} | ${q.paper || "（无出处）"} 第${q.number}题 | ${q.type} ${q.score || ""}分 | 考点：${q.topics.join("、") || "—"}${q.source === "AI生成" ? " | AI生成" : ""}\n  ${q.stem.replace(/\s+/g, " ").slice(0, 160)}`);
            return textResult(`找到 ${hits.length} 道（答案用 kaoyan_bank_get 取，不要提前告诉学习者）：\n${lines.join("\n")}`, { ids: hits.map((q) => q.id) });
          },
        },
        {
          name: "kaoyan_bank_get",
          label: "读取真题",
          description: "按 id 读取一道真题的完整内容：题干、选项、答案、解析、阅读材料。答案和解析只供你判断和讲评，学习者作答前不要透露。",
          parameters: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false },
          execute: async (_id, input, signal) => {
            guard(signal);
            const q = bank.all().find((x) => x.id === input.id);
            if (!q) return textResult(`找不到 id=${input.id} 的题，请先用 kaoyan_bank_search 检索。`, {});
            const material = q.material || (q.materialKey ? bank.materialsOf()[q.materialKey] : "") || "";
            const text = [
              `出处：${q.paper || "（无）"} 第${q.number}题（${q.type}，${q.score || "?"} 分）${q.source === "AI生成" ? "，AI 生成" : ""}`,
              material ? `阅读材料：\n${material}` : "",
              `题干：\n${q.stem}`,
              q.options.length ? `选项：\n${q.options.map((o) => `(${o.key}) ${o.text}`).join("\n")}` : "",
              q.hasFigure ? "（原题有图，题干里是图的文字描述）" : "",
              `【仅供你参考，学习者作答前不要透露】\n答案${q.answerSource === "AI" ? "（AI 解答，非官方，可能有误）" : ""}：${q.answer || "（题库里没有）"}\n解析${q.analysisSource === "AI" ? "（AI 按标准答案补写，非官方）" : ""}：${q.analysis || "（题库里没有）"}`,
            ].filter(Boolean).join("\n\n");
            return textResult(text, { id: q.id });
          },
        },
      );
      tools.push({
        name: "kaoyan_bank_record",
        label: "记录真题作答",
        description: "用题库真题（kaoyan_bank_get 取到的题）出的检查题 / 练习题，学习者作答并判定后立即调用一次：把这道真题记为已做，题库「完成情况」里会显示。只用于题库里的真题，自己出的题或改编题不要调用。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 100, description: "真题 id（kaoyan_bank_search / kaoyan_bank_get 里的 id）" },
            correct: { type: "boolean", description: "学习者这次是否做对（部分对算 false，并给 score）" },
            score: { type: "number", minimum: 0, maximum: 100, description: "可选：按这道题满分给的得分，主观题部分得分时填" },
            learnerAnswer: { type: "string", maxLength: 2000, description: "学习者的作答（简短）" },
          },
          required: ["id", "correct"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const r = progress.record({ ...input, agent: context.agent, chatId: context.chatId });
          if (!r) return textResult("题库里没有这个 id，没有记录。只有题库真题才需要记录。", {});
          return textResult(`已记录：${r.q.paper} 第${r.q.number}题 ${input.correct ? "做对" : "做错"}。${input.correct ? "" : "如果还没记错题，用 kaoyan_log_mistake（带上 bankId）记进错题本。"}`, { id: r.entry.id });
        },
      });
      tools.push({
        name: "kaoyan_log_mistake",
        label: "记录错题",
        description: "学习者答错或答得含糊时调用：把题目、学习者回答、正确答案、错因记进错题本，之后按遗忘曲线安排重做。",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
            topic: { type: "string", minLength: 1, maxLength: 200, description: "所属知识点" },
            question: { type: "string", minLength: 1, maxLength: 8000, description: "题目原文（可含 LaTeX）" },
            learnerAnswer: { type: "string", minLength: 1, maxLength: 4000 },
            correctAnswer: { type: "string", maxLength: 8000, description: "正确答案与关键步骤" },
            errorType: { type: "string", enum: ERROR_TYPES },
            diagnosis: { type: "string", minLength: 1, maxLength: 2000, description: "错在哪、为什么错" },
            bankId: { type: "string", maxLength: 100, description: "这道题来自题库真题时填真题 id" },
          },
          required: ["subject", "topic", "question", "learnerAnswer", "errorType", "diagnosis"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const m = addMistake({ ...input, bankId: input.bankId && bank.all().some((q) => q.id === input.bankId) ? input.bankId : null, source: context.agent === "practice" ? "练习会话" : "学习模式", chatId: context.chatId });
          return textResult(`已记进错题本（${m.errorType}：${m.topic}）。现在针对错因讲解，再换题检查。`, { id: m.id });
        },
      });
      if (context.agent === "teacher") {
        tools.push({
          name: "kaoyan_study_report",
          label: "生成问题清单",
          description: "学习模式专用：综合小测结束后调用一次，保存本课的问题清单与复习建议。非学习模式会话不要调用。",
          parameters: {
            type: "object",
            properties: {
              goal: { type: "string", minLength: 1, maxLength: 300 },
              mastered: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 40 },
              weakPoints: { type: "array", maxItems: 40, items: { type: "object", properties: { point: { type: "string", maxLength: 300 }, errorType: { type: "string", enum: ERROR_TYPES }, advice: { type: "string", maxLength: 1000 } }, required: ["point", "errorType", "advice"], additionalProperties: false } },
              quizScore: { type: "string", maxLength: 50 },
              reviewList: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 40 },
              summary: { type: "string", minLength: 1, maxLength: 3000 },
            },
            required: ["goal", "mastered", "weakPoints", "reviewList", "summary"],
            additionalProperties: false,
          },
          execute: async (_id, input, signal) => {
            guard(signal);
            const items = store.list("reports");
            items.push({ id: uid(), chatId: context.chatId, createdAt: nowIso(), ...input });
            store.saveList("reports", items);
            changed("reports");
            try { ctx.events.emit("study-report", { chatId: context.chatId }); } catch { /* ignore */ }
            return textResult("问题清单已保存（侧边栏「错题本」→ 问题清单）。现在用中文向学习者总结。", {});
          },
        });
      }
      return tools;
    },
  });

  // ── 前端操作 ───────────────────────────────────────────
  const op = (name, fn) => ctx.handle(name, async (input) => fn(input === undefined || input === null ? {} : obj(input)));

  op("settings.get", () => ({ settings: settings(), errorTypes: ERROR_TYPES }));
  op("models.list", () => llm.catalogModels());
  op("vault.detect", () => ({ vaults: detectObsidianVaults() }));
  // 「AI 自动配置」：固定提示词，不带本机信息，复制给 agent 在任意电脑上配置。
  op("setup.prompt", () => ({ prompt: SETUP_PROMPT }));
  op("papers.prompt", () => ({ prompt: PAPERS_PROMPT }));
  op("vault.test", (p) => {
    const root = expandHome(p.vaultPath !== undefined ? str(p.vaultPath, 1000) : settings().vaultPath);
    if (!root) fail("还没填 Obsidian 仓库路径");
    if (!isDir(root)) fail(`找不到文件夹：${root}`);
    let md = 0;
    const walk = (d, depth) => {
      if (depth > 12) return;
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.name.endsWith(".md")) md++;
      }
    };
    walk(root, 0);
    const has = (n) => isDir(path.join(root, n));
    const pr = expandHome(p.papersPath !== undefined ? str(p.papersPath, 1000) : settings().papersPath);
    let papers = null;
    if (pr) {
      try { papers = { ok: true, items: JSON.parse(fs.readFileSync(path.join(pr, "manifest.json"), "utf8")).items.length }; }
      catch { papers = { ok: false, exists: isDir(pr) }; }
    }
    return { root, isObsidian: has(".obsidian"), md, plans: has("计划"), concepts: has("concepts"), notes: has("笔记"), papers };
  });
  op("settings.save", (p) => {
    const patch = {};
    if (p.vaultPath !== undefined) {
      const v = str(p.vaultPath, 1000).trim();
      if (v && !isDir(expandHome(v))) fail(`找不到 Obsidian 仓库文件夹：${v}`);
      patch.vaultPath = v;
    }
    if (p.papersPath !== undefined) {
      const v = str(p.papersPath, 1000).trim();
      if (v && !isDir(expandHome(v))) fail(`找不到真题文件夹：${v}`);
      patch.papersPath = v;
    }
    if (p.examDate !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(p.examDate)) fail("日期格式应为 YYYY-MM-DD"); patch.examDate = p.examDate; }
    if (p.studyMode !== undefined) patch.studyMode = !!p.studyMode;
    if (p.autoExportPrompt !== undefined) patch.autoExportPrompt = !!p.autoExportPrompt;
    if (p.ocrModel !== undefined) patch.ocrModel = p.ocrModel && p.ocrModel.provider && p.ocrModel.id ? { provider: str(p.ocrModel.provider, 200), id: str(p.ocrModel.id, 300) } : null;
    if (p.importConcurrency !== undefined) patch.importConcurrency = Math.max(1, Math.min(12, Number(p.importConcurrency) || 6));
    if (p.sessionSubject) patch.sessionSubjects = { ...settings().sessionSubjects, [p.sessionSubject.id]: p.sessionSubject.subject };
    return saveSettings(patch);
  });
  op("image.get", (p) => ({ data: images.get(p.id) }));
  op("image.save", (p) => ({ id: images.save(p.data) }));
  op("jobs.list", () => jobs.list());
  op("jobs.get", (p) => jobs.get(p.id));
  op("jobs.cancel", (p) => jobs.cancel(p.id));

  // 今日 / 统计 / 考纲
  op("today", () => stats.todaySummary());
  op("plan.toggleDaily", (p) => { const r = stats.toggleDaily(str(p.key, 1000), !!p.done); changed("plan"); return r; });
  op("plan.toggle", (p) => { const r = vault.toggleTask(p.path, Number(p.line), str(p.raw, 4000), !!p.done); changed("plan"); return r; });
  op("activity.log", (p) => {
    const items = store.list("activity");
    items.push({ at: nowIso(), subject: str(p.subject, 20) || "其他", minutes: Math.max(0, Math.min(600, Number(p.minutes) || 0)), kind: str(p.kind, 40) });
    store.saveList("activity", items.slice(-5000));
    return { ok: true };
  });

  // Obsidian
  op("vault.search", (p) => vault.search(p.query, { limit: 20, includePlans: true }));
  op("vault.read", (p) => vault.read(p.path));
  op("vault.folders", () => vault.folders());
  op("export.draft", (p) => jobs.start("export", "生成笔记", async () => notes.draft({ chatId: str(p.chatId, 200), mode: p.mode })));
  op("export.save", (p) => {
    const r = notes.save({ notes: p.notes, overwrite: p.overwrite || [] });
    if (p.chatId && r.results.every((x) => x.written)) saveSettings({ exportPrompted: { ...settings().exportPrompted, [p.chatId]: "exported" } });
    return r;
  });
  op("export.dismiss", (p) => saveSettings({ exportPrompted: { ...settings().exportPrompted, [str(p.chatId, 200)]: "skipped" } }));
  op("export.shouldPrompt", (p) => {
    const s = settings();
    return { prompt: s.autoExportPrompt && !s.exportPrompted[p.chatId] };
  });

  // 错题本
  op("mistakes.list", () => ({ items: store.list("mistakes"), reports: store.list("reports") }));
  op("mistakes.add", (p) => addMistake(p));
  op("mistakes.update", (p) => {
    const allowed = ["subject", "topic", "question", "learnerAnswer", "correctAnswer", "errorType", "diagnosis", "archived", "source"];
    const patch = Object.fromEntries(Object.entries(p.patch || {}).filter(([k]) => allowed.includes(k)));
    const r = store.update("mistakes", p.id, patch);
    changed("mistakes");
    return r;
  });
  op("mistakes.delete", (p) => { store.remove("mistakes", p.id); changed("mistakes"); return { ok: true }; });
  op("mistakes.rate", (p) => {
    const r = store.update("mistakes", p.id, (m) => ({
      card: fsrs.review(m.card, p.rating),
      history: [...(m.history || []), { at: nowIso(), rating: Number(p.rating), correct: p.correct ?? null, answer: str(p.answer, 4000), feedback: str(p.feedback, 4000) }],
    }));
    changed("mistakes");
    return r;
  });
  op("mistakes.check", (p) => jobs.start("check", "错题判分", async ({ progress, signal }) => {
    const m = store.list("mistakes").find((x) => x.id === p.id);
    if (!m) fail("找不到这道错题");
    // 白板手写 / 照片作答：先用 OCR 模型转成文字再判分（判分模型不一定能看清手写）；识别失败的那张原图直接交给判分模型
    const answerImgs = (p.images || []).filter((d) => typeof d === "string" && d).slice(0, 10);
    const parts = [];
    const raw = [];
    for (let i = 0; i < answerImgs.length; i++) {
      if (signal?.aborted) fail("已取消");
      progress?.(i, answerImgs.length, `识别手写作答 ${i + 1}/${answerImgs.length}`);
      try { parts.push(await bank.transcribe({ data: answerImgs[i], mimeType: "image/jpeg" }, signal)); }
      catch (err) { if (signal?.aborted) throw err; raw.push(answerImgs[i]); }
    }
    const transcript = parts.join("\n\n").trim();
    const answerText = [str(p.answer, 8000), transcript ? `【手写作答识别】\n${transcript}` : ""].filter((x) => x && x.trim()).join("\n\n");
    progress?.(answerImgs.length, answerImgs.length + 1, "判分");
    const imgs = [...(m.images || []).map((id) => ({ data: images.get(id) })), ...raw.map((d) => ({ data: d }))];
    const res = await llm.json({
      system: "你是考研阅卷老师。判断学生这次重做是否正确，按步骤指出问题。输出 JSON：{\"correct\":true/false,\"score\":0-100,\"feedback\":\"批改意见（中文）\"}",
      text: `题目：${m.question}\n${(m.options || []).map((o) => `${o.key}. ${o.text}`).join("\n")}\n参考答案：${m.correctAnswer || "（无，请自行求解）"}\n上次的错因：${m.errorType}：${m.diagnosis}\n\n这次作答：${answerText || "（见图片中最后几张）"}${m.images?.length ? `\n（前 ${m.images.length} 张图是题目原图）` : ""}${raw.length ? `\n（最后 ${raw.length} 张图是学生手写作答）` : ""}`,
      images: imgs.map((x) => ({ ...x, mimeType: "image/jpeg" })),
      maxTokens: 3000,
      signal,
    });
    return { ...res, transcript };
  }));
  op("mistakes.ocr", (p) => jobs.start("ocr", "识别错题照片", async () => {
    const imgs = (p.images || []).map((d) => ({ data: d, mimeType: "image/jpeg" }));
    if (!imgs.length) fail("请先选择照片");
    const res = await llm.json({
      system: `你在帮考研学生录入纸质书上做错的题。识别照片里的题目（可能多道），公式用 LaTeX。输出 JSON：{"items":[{"subject":"数学|408|英语|政治","topic":"考点","question":"完整题目 Markdown（含选项）","correctAnswer":"照片里能看到的答案/解析，没有就留空","learnerAnswer":"照片里学生的手写作答，没有就留空"}]}`,
      text: `书名/来源：${str(p.source, 200) || "未说明"}。${str(p.hint, 500)}`,
      images: imgs,
      maxTokens: 8000,
    });
    return { items: res.items || [] };
  }));
  op("mistakes.diagnose", (p) => jobs.start("diagnose", "分析错因", async () => llm.json({
    system: `分析考研题的错因。输出 JSON：{"errorType":"从 ${ERROR_TYPES.join("、")} 中选","diagnosis":"错在哪、为什么错","correctAnswer":"若未提供，给出正确答案与关键步骤"}`,
    text: `题目：${str(p.question, 8000)}\n学生作答：${str(p.learnerAnswer, 4000) || "（未提供）"}\n参考答案：${str(p.correctAnswer, 8000) || "（未提供）"}`,
    images: (p.images || []).map((d) => ({ data: d, mimeType: "image/jpeg" })),
    maxTokens: 3000,
  })));

  // 题库
  op("bank.list", (p) => {
    let items = bank.all();
    if (p.subject) items = items.filter((q) => q.subject === p.subject);
    if (p.paper) items = items.filter((q) => q.paper === p.paper);
    if (p.q) items = items.filter((q) => `${q.stem} ${q.topics.join(" ")}`.includes(p.q));
    return { total: items.length, items: items.slice(0, Number(p.limit) || 200), papers: bank.papers() };
  });
  op("bank.papers", () => bank.papers());
  op("bank.update", (p) => {
    const allowed = ["stem", "answer", "analysis", "topics", "type", "score", "number", "options"];
    const patch = Object.fromEntries(Object.entries(p.patch || {}).filter(([k]) => allowed.includes(k)));
    return store.update("bank", p.id, (q) => ({ ...patch, ...(patch.analysis !== undefined && patch.analysis !== q.analysis ? { analysisSource: "手动" } : {}), ...(patch.answer !== undefined && patch.answer !== q.answer ? { answerSource: "手动" } : {}) }));
  });
  op("bank.delete", (p) => { store.remove("bank", p.id); return { ok: true }; });
  op("bank.missingAnalysis", () => bank.missingAnalysis());
  op("bank.problems", () => bank.problems());
  op("bank.fixMath", (p) => jobs.start("fixmath", "修复公式格式", (j) => bank.fixMath({
    ids: Array.isArray(p.ids) ? p.ids.map(String) : undefined,
    paper: p.paper ? str(p.paper, 200) : undefined,
    ...j,
  })));
  op("bank.missingFigures", () => bank.missingFigures());
  op("bank.cropFigures", (p) => jobs.start("figures", "裁出插图", (j) => bank.cropFigures({
    ids: Array.isArray(p.ids) ? p.ids.map(String) : undefined,
    paper: p.paper ? str(p.paper, 200) : undefined,
    force: !!p.force,
    ...j,
  })));
  op("bank.fillAnalysis", (p) => jobs.start("analysis", "AI 补全答案和解析", (j) => bank.fillAnalyses({
    ids: Array.isArray(p.ids) ? p.ids.map(String) : undefined,
    paper: p.paper ? str(p.paper, 200) : undefined,
    ...j,
  })));
  op("bank.deletePaper", (p) => { store.saveList("bank", bank.all().filter((q) => q.paper !== p.paper)); return { ok: true }; });
  op("bank.import", (p) => {
    const meta = { subject: p.subject, paper: str(p.paper, 200).trim(), year: p.year, kind: p.kind, source: p.source || "真题" };
    if (!bank.SUBJECTS.includes(meta.subject)) fail("请选择科目");
    const label = `导入 ${meta.paper || meta.subject}`;
    if (p.format === "text") return jobs.start("import", label, (j) => bank.importText({ meta, text: str(p.text, 2_000_000), ...j }));
    if (p.format === "images") return jobs.start("import", label, (j) => bank.importImages({ meta, imgs: (p.images || []).map((d) => ({ data: d, mimeType: "image/jpeg" })), ...j }));
    if (p.format === "pdf") return jobs.start("import", label, (j) => bank.importPdf({ meta, pdfBase64: p.pdf, first: Number(p.first) || 1, last: Number(p.last) || 999, ...j }));
    fail("未知的导入格式");
  });

  // 批量导入整理好的真题文件夹（manifest.json），可断点续传
  const progressFile = "import-progress";
  const readProgress = () => ({ done: [], failed: {}, ...store.value(progressFile, {}) });
  let batchJob = null;
  // 题库包：导出已识别好的题库给别人，或导入别人的题库包（不用再识别）
  const pack = createPack({ store, imageDir, version: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")).version; } catch { return ""; } })() });
  op("pack.summary", () => pack.summary());
  op("pack.find", () => ({ packs: pack.findPacks() }));
  op("pack.export", (p) => pack.exportPack({ dir: expandHome(str(p.dir, 1000)), subjects: Array.isArray(p.subjects) ? p.subjects.map((x) => str(x, 20)) : [] }));
  op("pack.preview", (p) => pack.previewPack(expandHome(str(p.file, 2000))));
  op("pack.import", (p) => { const r = pack.importPack(expandHome(str(p.file, 2000))); changed("bank"); return r; });

  op("bank.batchStatus", (p) => {
    const folder = expandHome(str(p.folder, 1000)) || papersRoot();
    let total = 0;
    try { total = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).items.length; } catch { total = 0; }
    const st = readProgress();
    return { folder, total, done: st.done.length, failed: st.failed, running: batchJob ? jobs.get(batchJob) : null };
  });
  op("bank.batchImport", (p) => {
    const running = batchJob && jobs.get(batchJob);
    if (running && running.status === "running") return running;
    const folder = needPapers(expandHome(str(p.folder, 1000)) || papersRoot());
    if (p.reset) store.saveValue(progressFile, { done: [], failed: {} });
    const job = jobs.start("batch", "批量导入真题", (j) => bank.importManifest({
      folder, ...j,
      readProgress,
      saveProgress: (st) => store.saveValue(progressFile, st),
    }));
    batchJob = job.id;
    return job;
  });

  // 快练 / 模考
  op("quiz.start", (p) => {
    const mode = ["quick", "section", "full", "english"].includes(p.mode) ? p.mode : "quick";
    const count = Math.max(1, Math.min(100, Number(p.count) || 10));
    return jobs.start("quiz", "组卷", async ({ signal }) => {
      let qs;
      if (Array.isArray(p.ids) && p.ids.length) {
        const byId = new Map(bank.all().map((q) => [q.id, q]));
        qs = p.ids.map((id) => byId.get(id)).filter(Boolean);
      } else qs = bank.select({ ...p, mode, count });
      if (mode !== "full" && qs.length < count && p.allowGenerate) {
        const extra = await bank.generate({ subject: p.subject, types: p.types, topic: p.topic, count: count - qs.length, signal });
        qs = [...qs, ...extra];
      }
      if (!qs.length) fail("题库里没有符合条件的题。可以先导入真题，或勾选「题不够时让 AI 出题」。");
      const materials = bank.materialsOf(qs);
      const attempt = {
        id: uid(), mode, subject: mode === "full" ? qs[0].subject : p.subject, paper: p.paper || "", title: str(p.title, 200),
        questionIds: qs.map((q) => q.id), minutes: Number(p.minutes) || 0, startedAt: nowIso(), status: "doing",
      };
      const items = store.list("attempts");
      items.push(attempt);
      store.saveList("attempts", items);
      return { attempt, questions: qs.map((q) => bank.forExam(q, materials)) };
    });
  });
  op("quiz.submit", (p) => jobs.start("grade", "判分", async ({ progress, signal }) => {
    const attempt = store.list("attempts").find((a) => a.id === p.attemptId);
    if (!attempt) fail("找不到这次练习");
    const byId = new Map(bank.all().map((q) => [q.id, q]));
    const qs = attempt.questionIds.map((id) => byId.get(id)).filter(Boolean);
    const answers = p.answers || {};
    // 手写 / 照片作答：先用 OCR 模型转成文字再判分（判分模型不一定能看图）
    const withImages = qs.filter((q) => answers[q.id]?.images?.length);
    for (let i = 0; i < withImages.length; i++) {
      const q = withImages[i];
      if (signal.aborted) fail("已取消");
      progress(0, qs.length, `识别手写作答 ${i + 1}/${withImages.length}`);
      const a = answers[q.id];
      const parts = [];
      for (const d of a.images) {
        try { parts.push(await bank.transcribe({ data: d, mimeType: "image/jpeg" }, signal)); } catch (err) { if (signal.aborted) throw err; parts.push(`（这张手写没识别出来：${err.message}）`); }
      }
      a.text = [a.text, `【手写作答识别】\n${parts.join("\n\n")}`].filter((x) => x && x.trim()).join("\n\n");
      a.images = [];
      a.hadImages = true;
    }
    const results = {};
    for (let i = 0; i < qs.length; i++) {
      if (signal.aborted) fail("已取消");
      progress(i, qs.length, `判第 ${i + 1}/${qs.length} 题`);
      try { results[qs[i].id] = await bank.gradeOne(qs[i], answers[qs[i].id], signal); }
      catch (err) { results[qs[i].id] = { correct: null, score: 0, max: qs[i].score, feedback: `判分失败：${err.message}` }; }
    }
    // 客观题错因诊断
    const wrongObjective = qs.filter((q) => results[q.id].correct === false && bank.CHOICE_TYPES.includes(q.type) && answers[q.id]?.choice);
    progress(qs.length, qs.length, "分析错因");
    let diag = {};
    try { diag = await bank.diagnose(wrongObjective.map((q) => ({ q, ans: answers[q.id] })), signal); } catch { diag = {}; }
    wrongObjective.forEach((q, i) => { if (diag[i]) Object.assign(results[q.id], { errorType: diag[i].errorType, diagnosis: diag[i].diagnosis }); });
    // 错题自动进错题本
    const label = attempt.paper || `${attempt.subject}${attempt.mode === "quick" ? "快练" : "专项"}`;
    let added = 0;
    for (const q of qs) {
      const r = results[q.id];
      if (r.correct !== false) continue;
      const a = answers[q.id] || {};
      const imgIds = (a.images || []).map((d) => images.save(d));
      addMistake({
        subject: q.subject, topic: q.topics[0] || q.type, source: `${attempt.mode === "full" ? "模考" : "快练"} · ${label}${q.number ? ` 第${q.number}题` : ""}`,
        question: `${q.material && q.materialKey ? `> 材料见题库（${q.materialKey}）\n\n` : ""}${q.stem}`,
        options: q.options, learnerAnswer: a.choice || a.text || (imgIds.length ? "（手写作答见图片）" : "未作答"),
        correctAnswer: [q.answer, q.analysis].filter(Boolean).join("\n\n"), errorType: r.errorType || "其他",
        diagnosis: r.diagnosis || r.feedback || "", images: [...bank.pictures(q), ...imgIds], bankId: q.id,
      });
      added++;
    }
    const total = qs.reduce((s, q) => s + (results[q.id].max || 0), 0);
    const got = qs.reduce((s, q) => s + (results[q.id].score || 0), 0);
    const elapsed = Math.max(0, Number(p.elapsedSec) || 0);
    store.update("attempts", attempt.id, { status: "done", finishedAt: nowIso(), elapsedSec: elapsed, results, total, got, unitTimes: p.unitTimes && typeof p.unitTimes === "object" ? Object.fromEntries(Object.entries(p.unitTimes).map(([k, v]) => [str(k, 300), Math.max(0, Math.round(Number(v) || 0))])) : undefined, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { choice: v.choice, text: v.text, hasImages: !!(v.images?.length || v.hadImages) }])) });
    const acts = store.list("activity");
    acts.push({ at: nowIso(), subject: attempt.subject, minutes: Math.round(elapsed / 60), kind: attempt.mode });
    store.saveList("activity", acts);
    changed("mistakes");
    const full = qs.map((q) => ({ ...bank.forExam(q, {}), answer: q.answer, analysis: q.analysis, analysisSource: q.analysisSource || "" }));
    return { attemptId: attempt.id, results, total, got, added, questions: full };
  }));
  op("quiz.history", () => store.list("attempts").filter((a) => a.status === "done").map(({ answers, results, ...a }) => a).reverse().slice(0, 100));

  // 英语
  // 英语真题专项
  const engFolder = (p) => expandHome(str(p?.folder, 1000)) || (papersRoot() ? path.join(papersRoot(), "英语一") : "");
  const engProgress = () => ({ done: [], failed: {}, ...store.value("eng-import-progress", {}) });
  let engJob = null;
  op("english.importStatus", (p) => {
    const folder = engFolder(p);
    let total = 0;
    try { total = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).items.length; } catch { total = 0; }
    const st = engProgress();
    return { folder, total, done: st.done.length, failed: st.failed, running: engJob ? jobs.get(engJob) : null };
  });
  op("english.importAll", (p) => {
    const running = engJob && jobs.get(engJob);
    if (running && running.status === "running") return running;
    if (p.reset) store.saveValue("eng-import-progress", { done: [], failed: {} });
    const job = jobs.start("engimport", "导入英语真题", (j) => engImport.importManifest({
      folder: needPapers(engFolder(p)), ...j, readProgress: engProgress, saveProgress: (st) => store.saveValue("eng-import-progress", st),
    }));
    engJob = job.id;
    return job;
  });
  op("english.overview", () => engPractice.overview());
  op("bank.overview", (p) => progress.overview(["数学", "408"].includes(p?.subject) ? p.subject : "数学"));
  op("english.units", (p) => engPractice.unitInfo(Array.isArray(p.ids) ? p.ids.map((x) => str(x, 300)) : []));
  op("english.review", (p) => jobs.start("review", "AI 复盘", (j) => engPractice.review({ attemptId: str(p.attemptId, 100), ...j })));
  op("english.aiDrill", (p) => jobs.start("drill", "生成强化题", (j) => engPractice.aiDrill({ attemptId: str(p.attemptId, 100), unitId: str(p.unitId, 300), ...j })));
  op("vocab.addMany", (p) => { const r = engPractice.addWords({ words: Array.isArray(p.words) ? p.words.slice(0, 50) : [], source: p.source }); changed("vocab"); return r; });
  op("attempt.get", (p) => {
    const a = store.list("attempts").find((x) => x.id === str(p.id, 100));
    if (!a) fail("找不到这次练习");
    const byId = new Map(bank.all().map((q) => [q.id, q]));
    const qs = a.questionIds.map((id) => byId.get(id)).filter(Boolean);
    const m = bank.materialsOf(qs);
    return { attempt: a, questions: qs.map((q) => ({ ...bank.forExam(q, m), answer: q.answer, analysis: q.analysis, analysisSource: q.analysisSource || "", part: q.part || "" })) };
  });

  // 独立手写白板（在系统浏览器里打开，可拖到 iPad 上写）
  op("pad.open", (p) => pads.open({ key: str(p.key, 300), title: str(p.title, 200), stem: str(p.stem, 6000) }));
  op("pad.take", (p) => pads.take(str(p.id, 100), p.qid ? str(p.qid, 100) : undefined));
  op("pad.board", (p) => pads.openBoard({ key: str(p.key, 300), title: str(p.title, 200) }));
  op("pad.focus", (p) => pads.focus(str(p.id, 100), { qid: str(p.qid, 100), title: str(p.title, 200), stem: str(p.stem, 6000), mode: p.mode === "answer" ? "answer" : "draft", index: Number(p.index) || 0, total: Number(p.total) || 0 }));
  op("pad.drop", (p) => pads.drop(str(p.id, 100), str(p.qid, 100)));

  op("vocab.list", () => store.list("vocab"));
  op("vocab.add", (p) => english.addWord(p));
  op("vocab.rate", (p) => english.rateWord(p));
  op("vocab.delete", (p) => { store.remove("vocab", p.id); return { ok: true }; });
  op("sentence.grade", (p) => jobs.start("sentence", "批改长难句", () => english.gradeSentence(p)));
  op("sentence.list", () => store.list("sentences").slice().reverse());
  op("essay.grade", (p) => jobs.start("essay", "批改作文", () => english.gradeEssay(p)));
  op("essay.list", () => store.list("essays").slice().reverse());

  // 模型能否识图（用于 OCR 前自检）
  op("vision.test", () => jobs.start("vision", "测试识图", async () => {
    // 8x8 白底黑字「7」很难识别，这里用一张极小的纯色图只测接口是否接受图片
    const tiny = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    const text = await llm.complete({ system: "简短回答。", text: "这张图片主要是什么颜色？只回答颜色。", images: [{ data: tiny, mimeType: "image/jpeg" }], maxTokens: 200 });
    return { reply: text, model: await llm.resolve("vision") };
  }));
};
