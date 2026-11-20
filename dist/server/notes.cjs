"use strict";
// 会话 → Obsidian 笔记（原子笔记 / 普通笔记）。
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
        const q = a.question || a.prompt || a.stem || a.text;
        if (q) return `【${p.name}】${typeof q === "string" ? q : JSON.stringify(q)}${a.options ? `\n选项：${JSON.stringify(a.options)}` : ""}`;
        if (p.name === "probe_done" || p.name === "kaoyan_study_report") return `【${p.name}】${JSON.stringify(a).slice(0, 3000)}`;
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

const STYLE = `笔记风格（像一份整理好的复习讲义，不是会话记录）：
- 开头 YAML frontmatter：tags（科目、主题等 2–4 个中文标签）、source: 由 LearnHarness 会话整理（会话标题）、created: 日期。
- 一级标题 = 笔记名。
- 用陈述句直接写结论：知识点、公式、方法步骤、易错点。**禁止问答体**——不要写「什么是……？」「为什么……？」「怎么判断……？」这类问句标题或问句开头再跟解答，也不要复述师生对话（「老师讲到」「你答错了」之类）。会话里的提问只是素材，提炼成结论再写。
- 正文主体用普通 Markdown：## / ### 标题分节，列表、编号步骤、表格（适合对比/分类）、公式块。大部分内容不放在 callout 里。
- callout（> [!...] 色块）只给少数真正的重点，全篇 2–4 个、普通笔记最多 5 个，每个只写几行：
  - > [!important] 最核心的定义/定理/公式（只放一处最关键的，不是每个定义都放）；
  - > [!warning] 学习者在会话里真正答错过、或考研高频的易错点（最重要的 1–2 条，其余易错点写在「易错点」小节的普通列表里）；
  - 其余类型（tip/example/summary/note）一般不用。不要用 callout 做「本篇导航」，不要把整节、整组列表塞进 callout。
- 数学公式用 $...$ 和 $$...$$（LaTeX），代码用代码块。
- 用 [[双链]] 链接相关笔记：只能链接「已有笔记列表」里存在的笔记（写路径去掉 .md，如 [[笔记/数学/高数/定积分/反常积分收敛判断|反常积分收敛判断]]），或本次一起生成的原子笔记（[[笔记名]]）。
- 内容必须来自本次会话真正讲过、考过的东西，并把学习者答错暴露出的易错点写进去；不要编造会话之外的大段内容。

普通笔记的推荐结构（按会话内容取舍，没讲到的节就省掉）：
## 知识点 —— 定义、定理、公式、性质，分条陈述，必要时用表格对比。
## 做题方法 —— 按题型分 ###，每个题型写成编号步骤（1. 先… 2. 再… 3. 最后…），步骤后可跟一道会话里出现过的典型例题，用「**例**」加粗起头 + 简要解答，不用 callout。
## 易错点 —— 普通列表，每条写「错误做法 → 正确做法/原因」，最关键的一两条才用 > [!warning]。
## 相关笔记 —— 双链（可选）。

原子笔记的推荐结构：一句话陈述概念 → 定义/公式（核心那一条可用 > [!important]）→ 怎么用（编号步骤）→ 易错点（列表）→ 相关双链。`;

const RULES = `文件夹规则：
- 科目只能是：数学、408、英语、政治。
- 原子笔记放 concepts/<科目>/<课程>/，例如 concepts/数学/高数/、concepts/数学/线代/、concepts/408/数据结构/、concepts/408/C语言/。一页只讲一个概念（定义/定理/方法），短小精悍，200–600 字。
- 普通笔记放 笔记/<科目>/<课程>/<主题>/，例如 笔记/数学/高数/定积分/。一篇完整梳理本次会话：知识点、做题方法步骤、易错点。
- 课程名优先使用已有文件夹里的名字（高数、线代、概率论、数据结构、计组、操作系统、计算机网络、C语言 等），没有合适的再新建。`;

function createNotes({ ctx, llm, vault }) {
  async function draft({ chatId, mode, progress = () => {}, signal }) {
    if (!["atomic", "normal"].includes(mode)) fail("mode 必须是 atomic 或 normal");
    progress(1, 4, "读取会话记录");
    const record = ctx.learning.getSession(chatId);
    if (!record) fail("找不到这个会话");
    const transcript = transcriptText(record);
    if (transcript.length < 200) fail("这个会话内容太少，暂时没有可导出的笔记");
    progress(2, 4, "整理已有文件夹和笔记");
    let folders = [];
    let existing = [];
    try { folders = vault.folders(); existing = vault.titles().slice(0, 400); } catch (err) { fail(err.message); }
    const want = mode === "atomic"
      ? "生成若干篇原子笔记（每个核心概念一篇，通常 3–8 篇）。"
      : "生成一篇普通笔记，完整梳理本次会话。";
    progress(3, 4, `模型正在写笔记（会话约 ${Math.round(transcript.length / 1000)}k 字，通常 1–3 分钟）`);
    const result = await llm.json({
      signal,
      system: `你把一次考研辅导会话整理成学习者的 Obsidian 笔记。\n${STYLE}\n${RULES}`,
      text: `${want}
今天日期：${today()}；会话标题：${record.title || ""}

已有文件夹：
${folders.join("\n")}

已有笔记（可用于双链）：
${existing.join("\n")}

输出 JSON：{"subject":"数学|408|英语|政治","course":"课程","topic":"主题","notes":[{"folder":"相对仓库根的文件夹","name":"笔记名（不含 .md）","content":"完整 Markdown"}]}

会话记录：
${transcript}`,
      maxTokens: 16000,
    });
    progress(4, 4, "整理生成结果");
    if (!result || !Array.isArray(result.notes) || !result.notes.length) fail("模型没有生成笔记，请重试");
    const notes = result.notes.map((n) => ({
      folder: String(n.folder || "").replace(/^\/+|\/+$/g, ""),
      name: String(n.name || "未命名"),
      content: String(n.content || ""),
    }));
    return { subject: result.subject, course: result.course, topic: result.topic, mode, notes, title: record.title };
  }

  function save({ notes, overwrite = [] }) {
    if (!Array.isArray(notes) || !notes.length) fail("没有要保存的笔记");
    const results = notes.map((n) => {
      const top = String(n.folder || "").split("/")[0];
      if (!["concepts", "笔记", ...vault.SUBJECTS].includes(top)) fail(`文件夹必须在 concepts/、笔记/ 或科目文件夹下：${n.folder}`);
      return vault.writeNote(n.folder, n.name, String(n.content || ""), { overwrite: overwrite.includes(`${n.folder}/${n.name}`) });
    });
    return { results };
  }

  return { draft, save, transcriptText };
}

module.exports = { createNotes, transcriptText };
