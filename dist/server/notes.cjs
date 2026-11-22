"use strict";
// 会话 → Obsidian 笔记：按仓库《笔记格式规范》补进章节笔记 / 题型笔记 / 公式速查。
const { fail, today } = require("./util.cjs");

/** 把原生会话记录压成可读文本：学习者消息、老师讲解、题目与作答。 */
function transcriptText(record, max = 60000) {
  const out = [];
  const textOf = (content) => {
    if (typeof content === "string") return content;
    return (content || []).map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "toolCall") {
        const a = p.arguments || {};
        // 逐题记录过的题单独计分，标清楚，结算时不要再算一遍
        if (p.name === "kaoyan_record_question") return `【已逐题记录·做对】${a.topic || ""}（难度 ${a.difficulty ?? "?"}·${a.result || ""}）${a.question ? `：${String(a.question).slice(0, 200)}` : ""}`;
        if (p.name === "kaoyan_log_mistake") return `【已逐题记录·做错】${a.topic || ""}（难度 ${a.difficulty ?? "?"}·${a.errorType || ""}）：${String(a.question || "").slice(0, 300)}`;
        if (p.name === "kaoyan_bank_record") return `【已逐题记录·题库原题】${a.correct ? "做对" : "做错"}${a.difficulty ? `（难度 ${a.difficulty}）` : ""}`;
        const q = a.question || a.prompt || a.stem || a.text;
        if (q) return `【${p.name}】${typeof q === "string" ? q : JSON.stringify(q)}${a.options ? `\n选项：${JSON.stringify(a.options)}` : ""}`;
        if (p.name === "probe_done" || p.name === "kaoyan_study_report") return `【${p.name}】${JSON.stringify(a).slice(0, 3000)}`;
        if (p.name === "kaoyan_log_paper") return `【讲题批改】${(a.items || []).map((it) => `第${it.number}题 ${it.correct ? "对" : "错"}${it.score != null ? ` ${it.score}${it.fullScore != null ? `/${it.fullScore}` : ""}分` : ""} ${it.topic || ""}${it.correct ? "" : `（${it.errorType || ""}：${it.diagnosis || ""}）`}`).join("；").slice(0, 3000)}`;
        return "";
      }
      return "";
    }).filter(Boolean).join("\n");
  };
  for (const m of record.messages || []) {
    if (m.role === "user") { const t = textOf(m.content); if (t) out.push(`学习者：${t}`); }
    else if (m.role === "assistant") { const t = textOf(m.content); if (t) out.push(`老师：${t}`); }
    else if (m.role === "toolResult" && /quiz|explain|question|answer/i.test(m.toolName || "")) {
      const t = textOf(m.content); if (t) out.push(`作答结果：${t.slice(0, 1500)}`);
    }
  }
  const all = out.join("\n\n");
  return all.length > max ? `…（前文省略）\n${all.slice(all.length - max)}` : all;
}

// 笔记写法以仓库里的《笔记格式规范》为准（用户在 Obsidian 里改，导出跟着变）；读不到才用下面的简版。
const SPEC_PATH = "笔记规范/笔记格式规范";
const SUBJECT_LIST = ["数学", "408", "英语", "政治"];

const FALLBACK_SPEC = `笔记分四类，都放在 <科目>/<课程>/ 下：
- 课程总览 00-<课程>总览.md：章节表（状态、薄弱的点）+ 题型和公式速查列表。
- 章节笔记 NN-章名.md：知识点的唯一存放处，按小节分 ##，每节用 ### 知识点 / ### 做题方法 / ### 易错点；做题方法里每个题型/方法一个 #### 标题，下面写 **识别信号**、**步骤**（编号列表）和例题框；新内容补进已有章节，不另开新篇。
- 题型笔记 题型/题型名.md：跨章节或步骤多的做题方法：识别信号、解题步骤、用到的结论、例题、易错点。
- 公式速查 公式速查/NN-章名.md：一章一篇，按小节的表格（公式/结论 | 条件 | 备注）。
写法：陈述句，不写问答体、不复述对话；条件写全；方法写识别信号 + 编号步骤；易错点写「错误做法 → 正确做法（原因）」。
例题少而精：章节笔记每个题型/方法最多 1 道，题型笔记 2–3 道；例题都放进例题框：第一行「> [!example] 例（出处）」，框内依次是题干、「**解**」、编号步骤（一步一行）、「**答案**：…」，各部分之间用单独的「>」空行隔开。
不会的地方：知识点里不会的关键句用 ==高亮==，真错过的易错点前面加 ★；会的不标。
色块只用 > [!important]（核心结论）和 > [!warning]（致命易错点），章节笔记每个 ## 节最多 2 个，题型笔记全篇最多 2 个；例题框 > [!example] 不算在内。
开头 YAML：tags（科目、课程、主题）、type（章节/题型/速查/总览）、source、created。`;

const SESSION_RULES = `整理会话时的额外要求：
- 内容必须来自本次会话真正讲过、考过的东西，把学习者答错暴露出的易错点写进去；不要编造会话之外的大段内容。
- **例题不要全搬**：会话里做过的题大多不进笔记（它们在题库和错题本里）。每个题型/方法只挑最有代表性的 1 道（题型笔记 2–3 道），放进 > [!example] 例题框，按规范的例题格式写：题目和解答分开，解答编号、一步一行。每个题型/方法用 #### 标题分开。改编题标「改编」，真题标年份。
- **标出不会的地方**：学习者这次答错、答不上来、要提示才会的知识点，在对应关键句加 ==高亮==；真犯过的错误写进易错点并在前面加 ★。学习者顺利做对的内容不加任何标记；原来标过 ==高亮== 或 ★、这次无提示做对了的，去掉标记。
- 不复述对话，不写问答体。
- 新建笔记的 frontmatter：source 写「由 LearnHarness 会话整理（会话标题）」，created 写今天日期。修改已有笔记时保留原 frontmatter，source 末尾可补「；会话标题」。
- 双链只能链接「已有笔记」里存在的笔记或本次一起新建的笔记，写完整路径去掉 .md。`;

/** 读规范和规范里「## 示例」一节链接到的笔记（每篇截 8000 字，只学格式）。 */
function loadSpec(vault) {
  let spec = null;
  try { spec = vault.readFull(SPEC_PATH); } catch { spec = null; }
  if (!spec) return { spec: FALLBACK_SPEC, examples: [] };
  const sec = (spec.split(/^## 示例\s*$/m)[1] || "").split(/^## /m)[0];
  const links = [...sec.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim()).slice(0, 3);
  const examples = [];
  for (const l of links) {
    try { const t = vault.readFull(l); if (t) examples.push({ path: l, text: t.length > 8000 ? `${t.slice(0, 8000)}\n…（示例截断）` : t }); } catch { /* 忽略 */ }
  }
  return { spec: spec.length > 20000 ? spec.slice(0, 20000) : spec, examples };
}

const cleanPath = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");

/** 解析「=== FILE: 路径 === … === END ===」格式的输出。比 JSON 稳：长 Markdown 里的 LaTeX 反斜杠不用转义。 */
function parseFiles(raw) {
  const out = [];
  const re = /^=== FILE:\s*(.+?)\s*===\s*\n([\s\S]*?)\n=== END ===/gm;
  let m;
  while ((m = re.exec(String(raw || "")))) out.push({ path: cleanPath(m[1]), content: m[2].replace(/^\s*\n/, "").trimEnd() + "\n" });
  return out;
}

const MAX_FULL = 30000; // 超过这个长度的已有笔记只让模型写「追加内容」，避免整篇重写时丢内容

function createNotes({ ctx, llm, vault, backupDir }) {
  async function draft({ chatId, progress = () => {}, signal }) {
    progress(1, 4, "读取会话记录");
    const record = ctx.learning.getSession(chatId);
    if (!record) fail("找不到这个会话");
    const transcript = transcriptText(record);
    if (transcript.length < 200) fail("这个会话内容太少，暂时没有可导出的笔记");
    let existing = [];
    try { existing = vault.titles().filter((t) => SUBJECT_LIST.includes(t.split("/")[0])).slice(0, 600); } catch (err) { fail(err.message); }
    const { spec, examples } = loadSpec(vault);

    progress(2, 4, "规划要更新哪些笔记");
    const plan = await llm.json({
      signal,
      system: `你帮学习者决定：一次考研辅导会话的内容，应该写进 Obsidian 仓库里的哪几篇笔记。严格按下面的《笔记格式规范》的分类和「新内容放哪里」规则：\n<<<规范\n${spec}\n规范>>>`,
      text: `今天日期：${today()}；会话标题：${record.title || ""}

已有笔记（路径，不含 .md）：
${existing.map((t) => t.replace(/\.md$/, "")).join("\n") || "（还没有）"}

规则：
- 知识点优先补进对应的章节笔记（已有就 update，没有就按教材章节编号 create，如 数学/高数/02-导数与微分）。
- 只有方法跨章节、或步骤和例题多到值得单独复习时，才 create/update 题型笔记（<科目>/<课程>/题型/题型名）。
- 会话里讲过、用到或学习者写错过的公式 / 定义 / 结论（等价关系、展开式、定理条件等），update 或 create 该章的公式速查（<科目>/<课程>/公式速查/NN-章名，文件名与章节笔记相同）；章节笔记写方法和例题，公式表放速查。
- 该课程有总览（00-…总览）时，新建章节笔记、或这次暴露了新的薄弱点，把总览也列为 update（更新章节表的状态和薄弱的点）。
- 会话是复习已有章节时，目标就是那篇章节笔记（update），不要另建新笔记。
- 最多 4 篇；路径以 数学/、408/、英语/、政治/ 开头，不含 .md。

输出 JSON：{"subject":"数学|408|英语|政治","course":"课程","targets":[{"path":"…","kind":"章节|题型|速查|总览","action":"update|create","reason":"一句话：写进去什么"}]}

会话记录（节选）：
${transcript.length > 24000 ? `${transcript.slice(0, 12000)}\n…\n${transcript.slice(-12000)}` : transcript}`,
      maxTokens: 4000,
    });
    const targets = (Array.isArray(plan?.targets) ? plan.targets : []).map((t) => ({
      path: cleanPath(t.path), kind: String(t.kind || ""), reason: String(t.reason || ""),
    })).filter((t) => SUBJECT_LIST.includes(t.path.split("/")[0]) && t.path.split("/").length >= 2).slice(0, 4);
    if (!targets.length) fail("模型没有规划出要写的笔记，请重试");
    // 会话里讲了公式时，确保对应章节的公式速查也在目标里（模型常把公式只写进章节笔记，速查就一直缺）
    if ((transcript.match(/\$[^$\n]{3,}\$/g) || []).length >= 6) {
      for (const t of [...targets]) {
        const m = t.path.match(/^(.+)\/(\d{2}-[^/]+)$/);
        if (!m || /\/(公式速查|题型)$/.test(m[1])) continue;
        const sheet = `${m[1]}/公式速查/${m[2]}`;
        if (targets.some((x) => x.path === sheet)) continue;
        targets.push({ path: sheet, kind: "速查", reason: "把本次会话讲到、用到和学习者写错过的公式与结论补进速查表（已有的不重复，写错过的标 ★）" });
      }
    }
    for (const t of targets) {
      t.original = vault.readFull(t.path);
      t.action = t.original == null ? "create" : "update";
      t.appendOnly = t.original != null && t.original.length > MAX_FULL;
    }

    progress(3, 4, `模型正在写笔记（${targets.length} 篇，会话约 ${Math.round(transcript.length / 1000)}k 字，通常 1–4 分钟）`);
    const targetText = targets.map((t) => {
      if (t.action === "create") return `### ${t.path}（新建，${t.kind}）\n要写：${t.reason}`;
      if (t.appendOnly) return `### ${t.path}（修改，${t.kind}，原文太长只追加）\n要写：${t.reason}\n原文最后 3000 字：\n<<<原文\n${t.original.slice(-3000)}\n原文>>>\n这一篇只输出要追加到末尾的新内容（完整的 ## 节），不要重复原文。`;
      return `### ${t.path}（修改，${t.kind}）\n要写：${t.reason}\n<<<原文\n${t.original}\n原文>>>`;
    }).join("\n\n");
    const raw = await llm.complete({
      signal,
      system: `你把一次考研辅导会话的内容写进学习者的 Obsidian 笔记。以下是学习者仓库里的《笔记格式规范》，必须严格遵守：
<<<规范
${spec}
规范>>>
${examples.length ? `\n格式示例（只学格式，不要照抄内容）：\n${examples.map((e) => `<<<示例 ${e.path}\n${e.text}\n示例>>>`).join("\n")}\n` : ""}
${SESSION_RULES}

修改已有笔记的要求（复习一章时就是这种情况）：
1. 输出修改后的**完整全文**；原有内容一律保留，只允许修正错误、调整位置、合并重复。
2. 只补**缺漏**：会话里讲到、但原笔记没写的知识点、方法、易错点，放进对应小节；原笔记已经写了的不要重复写。没有对应小节就按规范新增一节。
3. 按上面的规则更新 ==高亮== 和 ★。
4. 例题只在比原来的更有代表性时替换，不增加数量；不要删掉原来的易错点。
5. 修改课程总览时，只更新对应章的状态和「薄弱的点」。
6. 公式速查：把会话里讲过、用到、学习者写错过或问过的公式、定义和结论补进对应小节的表格（公式/结论 | 条件 | 备注），没有对应小节就按章节笔记的小节新增；学习者写错过的加 ★，会话里暴露不会的用 ==高亮==；已有的不重复。

输出格式（不要 JSON、不要代码块包裹），每篇一段：
=== FILE: 路径（与下面给定的完全一致，不含 .md） ===
完整 Markdown
=== END ===`,
      text: `今天日期：${today()}；会话标题：${record.title || ""}

要写的笔记：
${targetText}

已有笔记（可用于双链）：
${existing.map((t) => t.replace(/\.md$/, "")).join("\n")}

会话记录：
${transcript}`,
      maxTokens: 32000,
      allowThinking: true,
    });

    progress(4, 4, "整理生成结果");
    const files = parseFiles(raw);
    if (!files.length) fail("模型没有按格式输出笔记，请重试");
    const notes = [];
    for (const t of targets) {
      const f = files.find((x) => x.path === t.path) || files.find((x) => x.path.endsWith(t.path.split("/").pop()));
      if (!f) continue;
      const content = t.appendOnly ? `${t.original.trimEnd()}\n\n${f.content}` : f.content;
      const parts = t.path.split("/");
      const shrink = t.original ? 1 - content.length / t.original.length : 0;
      notes.push({
        folder: parts.slice(0, -1).join("/"), name: parts[parts.length - 1], content,
        original: t.original, action: t.action, kind: t.kind, reason: t.reason,
        warn: shrink > 0.15 ? `新内容比原来短了 ${Math.round(shrink * 100)}%，请看差异确认没有丢内容` : "",
      });
    }
    if (!notes.length) fail("模型输出的文件和规划对不上，请重试");
    return { subject: plan.subject, course: plan.course, notes, title: record.title };
  }

  /** 写入：新建的已存在要确认；修改的先比对原文（Obsidian 里改过就停下），并把原文备份到插件 data/noteBackups/。 */
  function save({ notes, overwrite = [] }) {
    if (!Array.isArray(notes) || !notes.length) fail("没有要保存的笔记");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const results = notes.map((n) => {
      const folder = cleanPath(n.folder);
      const top = folder.split("/")[0];
      if (!vault.SUBJECTS.includes(top)) fail(`文件夹必须在 ${vault.SUBJECTS.join("、")} 下：${n.folder}`);
      const key = `${folder}/${n.name}`;
      const relPath = `${folder}/${vault.safeName(n.name)}`;
      const current = vault.readFull(relPath);
      const force = overwrite.includes(key);
      if (current != null && !force) {
        if (n.original == null) return { exists: true, path: `${relPath}.md`, key };
        if (current !== n.original) return { conflict: true, path: `${relPath}.md`, key };
      }
      if (current != null && backupDir) {
        const fs = require("fs"), path = require("path");
        const file = path.join(backupDir, stamp, `${relPath}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, current);
      }
      return { ...vault.writeNote(folder, n.name, String(n.content || ""), { overwrite: true }), key, updated: current != null };
    });
    return { results };
  }

  return { draft, save, transcriptText };
}

module.exports = { createNotes, transcriptText, parseFiles };
