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
const { repairChoiceKeys, restore2011Question } = require("./server/bank-repairs.cjs");
const { createEnglish } = require("./server/english.cjs");
const { createStats } = require("./server/stats.cjs");
const { createEngImport } = require("./server/engimport.cjs");
const { createEngPractice } = require("./server/engpractice.cjs");
const { createPadServer } = require("./server/padserver.cjs");
const { SETUP_PROMPT, PAPERS_PROMPT } = require("./server/setupprompt.cjs");
const { createPack } = require("./server/pack.cjs");
const { createProgress } = require("./server/progress.cjs");
const { createMomo } = require("./server/momo.cjs");
const { createScore } = require("./server/score.cjs");
const { byId: knowledgeById, createCoverage, validPointIds } = require("./server/knowledge.cjs");
const { createPaper } = require("./server/paper.cjs");
const { createHostPrompts } = require("./server/hostprompts.cjs");
const { transcriptText } = require("./server/notes.cjs");

// 路径默认留空：每个人在 设置 → 考研工具箱 里填（或点「自动检测」从 Obsidian 读取）。
const DEFAULT_SETTINGS = {
  vaultPath: "",
  papersPath: "",
  examDate: "2027-12-18",
  ocrModel: null,
  classifyModel: null,
  importConcurrency: 6,
  studyMode: true,
  autoExportPrompt: true,
  sessionSubjects: {},
  exportPrompted: {},
  models: {},
  momoToken: "",
  vocabTarget: 5500,
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
1. 计划顺序：考纲要求的定义和定理 → 这一章的高频题型（按 kaoyan_exam_focus 从高到低排）。定义只讲到考纲要求的深度；考研不考的严格化内容（如 ε-N / ε-δ 证明）用一两句直观说明带过。
2. 不出预测题：不要用 quiz 的 type: "predict"。每一步用讲授式讲清楚：确切的定义 / 定理和成立条件、直观理解、为什么这样想、至少一道写全过程的例题；不要指望学习者自己推出来。题型节点按「识别信号 → 方法步骤 → 常见陷阱 → 例题」讲。
3. 每讲完一步，用 quiz 出一道检查题（type: "check"），按「出题规则」：考应用不考背诵，优先拿习题或真题当原型。
4. 每道检查题判定后按「逐题记录」记录。答错按「答错之后」讲完（kaoyan_log_mistake 的错因类型：${ERROR_TYPES.join(" / ")}），确认他看懂后（见「答错后确认看懂」）再换一道同考法的题确认。同一个点连错两次，就退回更基础的一步。检查题从 1–2 档起步，节点收尾和综合小测用 3 档以上。
5. 所有节点讲完后做综合小测：3–5 道，每回合一道，混合考本课各知识点，题面不提示用哪个知识点，尽量用真题原题或改编。每题都照第 4 条处理错题。
6. 小测结束后调用 kaoyan_study_report 生成问题清单，同一回合调用 kaoyan_settle_study 结算，再用中文总结（顺带说一句预测分的变化），建议之后开一个练习会话做变式题。
全程用中文。`;

const VAULT_TEXT = `## 学习者的 Obsidian 考研笔记（考研工具箱插件）
学习者在 Obsidian 里有自己的考研笔记仓库（科目：数学 / 408 / 英语 / 政治）。可用工具：
- kaoyan_vault_search：按关键词检索笔记，返回路径和片段。
- kaoyan_vault_read：读取一篇笔记全文。
笔记结构：每门课在「<科目>/<课程>/」下，有 00-<课程>总览、章节笔记「NN-章名」（知识点都在这里）、题型/（跨章节方法）、公式速查/（每章一篇）。笔记里 ==高亮== 的句子和 ★ 开头的易错点，是学习者**不会、错过**的地方；没有标记的不代表一定掌握。
- **规划前先读笔记**：用 kaoyan_vault_search 找到这次主题所在的章节笔记（必要时加上相关题型笔记、课程总览），用 kaoyan_vault_read 读**全文**；和规划用的真题检索放在同一个回合并行发出。同一会话读过的不要重复读。
- **用笔记定重点**：高亮和 ★ 的地方优先讲、专门出题复查；笔记里写了且没标记的内容可以讲得快一些，直接用考研难度的题检测；笔记里没有、但这一章该会的内容，是这次要补的缺口。向学习者介绍计划时说明「你笔记里标了 … 不熟，这次重点练」。
- 讲解时沿用笔记里的讲法、符号和例题，自然地点出「你笔记里写过…」；发现笔记写错了要指出来（导出笔记时会改正）。不要大段照抄笔记。
- 计划节点的内容不在已读的笔记里时，开讲前再用 kaoyan_vault_search 搜一次；没搜到就照常讲，不要停下。
学习者在练习或检查题里答错时，可以调用 kaoyan_log_mistake 把题目记进错题本（附错因），之后会按遗忘曲线安排重做。

## 分数判断机（考研工具箱插件）
插件按考点估算学习者现在能考多少分。会话学习告一段落时调用 kaoyan_settle_study 结算一次（它会读整段对话、评估各考点掌握程度并更新预测分）：
- 学习者说「今天就到这」「结束」「下次再学」之类告别的话时；
- 学习模式综合小测和问题清单完成后；
- 练习会话的目标都练完时。
同一会话可以多次调用（后一次覆盖前一次，不会重复加分）。调用后用一句话告诉学习者预测分的变化。不要在会话刚开始或讲到一半时调用。

## 题库与考点频率（考研工具箱插件）
题库里有历年数学一、408、英语一真题（含答案和解析）；以后导入的习题书题目标「习题」。可用工具：
- kaoyan_exam_focus：按章节或考点查考点频率表，包括近 15 年题数和分值、常见题型、学习者掌握度、最近几道真题。**规划前必查**；讲什么、讲多深、先讲什么都以它为准。统计是按关键词自动归类的，可能有偏差；某个细分点用 kaoyan_coverage 查是否在纲，再用 kaoyan_bank_search 核实历史考法。
- kaoyan_bank_search：按具体关键词或知识点编号检索题库。核对历年考法、测底和综合检验时优先传 source="真题"，课中单点检查和错后变式优先检索 source="习题"，找不到适合的再用真题或改编。答案待核的题先复核或换题。
- kaoyan_coverage：数一或 408 测底、规划时与频率表一起查。重点复习按优先级排，未排进本轮的考纲点留在清单待测。用户说「按考纲查漏」时，按知识点清单优先未测和答错待复测，包括低频项。每轮按已学范围控制题量。
- 知识点已按考试大纲细分到条目（数一约 380 项、408 约 430 项，每条大纲要求都有对应项）。清单每项带「近15年真题直接考查题数」和标记：「延伸」= 大纲没单列但常考的方法，「待核」= 只有第三方整理稿列出、低优先级。填 pointIds 时选最细的那一项（例如只考 CRC 就填「检错编码」，不要连「纠错编码」一起填）。快练、模考和题库作答会按题目的细归类自动更新清单状态。
- 课中讲完某个知识点可调用 kaoyan_mark_taught。每道检查题、练习题或测底题作答后，在对应记录工具上填知识点编号 pointIds，只填题目实际检验的知识点；提示后答对用 hinted 或对应 result，不得把用来讲解的方法也记作已测。结算后用清单说明这一轮已测和待测项。
- kaoyan_bank_get：按 id 取一道题的完整内容（题干、选项、答案、解析）。**答案和解析只给你自己看**，学习者作答前绝不能透露；标了「AI 解答 / AI 补写」的答案可能有误，先自己核对。
- **省往返**：规划时在同一个回合里并行发出 kaoyan_exam_focus、各主要考点的 kaoyan_bank_search（limit 8–10）和读笔记，不要一个一个等。介绍计划时说明「这个点近 15 年考了 n 次」。

## 计划怎么排（考研工具箱插件；与通用规划规则冲突时以本节为准）
- **学习会话**（零基础新学）：考纲要求的定义和定理 → 这一章的高频题型。只讲到考纲要求的深度。
- **复习会话**（复习、回顾，或测底显示已学过）：节点就是考点或题型，按「分值 ×（1 − 掌握度）」从高到低排。定义不单独成节点，做题暴露缺口时再补。
- 一次 4–8 个节点，最后一个是「真题综合」。近 15 年几乎没考过的细节不单独成节点；测底发现的冷门漏洞不进计划，在介绍里提一句。
- 依赖边只画真正的前置，不要为了从最底层推起而拉长链条。
- 计划图（plan_init）的节点标题不超过 16 个中文字，不用 <br/> 或换行。

## 出题规则（考研工具箱插件；与通用出题规则冲突时以本节为准）
学习者在备考全国硕士研究生统一考试（数学一 / 408 / 英语一 / 政治），目标是在考场上做对真题。
- **每道题都要有原型**：
  - 题库原题（真题或习题）对得上考点和难度，就直接用。
  - 对不上就改编：保留考法，换数据，或去掉超出已学范围的部分。改动太大、原题考法保不住，就换一道题。
  - 题干第一行标出处：「真题·2019 数一 T3」「改编自 2019 数一 T3」「习题·《书名》第 n 题」「改编自《书名》第 n 题」。
  - 实在找不到原型才自编，标「自编」，并照着频率表里近年真题的形式出。
- **只考已学**：已学范围＝本会话讲过的节点 + 测底显示已掌握的 + 学习者说学过的章节。拿不准就当没学过。不要为了用真题提前讲后面的内容。
- **真题没有的题型不出**：「仅凭条件能否断言…」式的逻辑辨析、ε-N / ε-δ 证明、函数方程推导、构造反例、数学分析或竞赛风格的题都不出，除非频率表或检索显示近年真题确实这样考过。判断说法对错的辨析题，一个节点最多一道。
- **难度**：
  - 刚讲完的一步可以只考这一步，但要像真题里的那一步，有真实的计算和陷阱，不是把式子换个数字代一次。
  - 每个节点讲完、转到下一个之前，用一道真题难度的题收尾（原题或改编，优先近 15 年，用 yearFrom 过滤）。
  - 连续两道答对且思路完整，下一道直接上真题难度。学习者说太简单或太难，立刻调整。
- **选项和解析**：错误选项对应考生真实常犯的错（漏条件、记反结论、算错一步），不放一眼能排除的选项；解析写完整解题过程，一步一行。
- **综合题**：真题是多步综合题、各步都在已学范围内时，自由作答模式下让学习者写关键步骤；选择题模式下拆成关键一步，连着出几道，每道接着上一道的结果。计算题和填空题在选择题模式下做成 4 个结果选项，干扰项用常见算错的结果。完整做一道大题，建议学习者开练习会话。
- **练习会话**：每个目标的主体题从题库挑，或照题库题改编。
- **逐题记录（拾星按题给考点的星加分）**：每道检查题、练习题、测底题，判定后马上记录一次（预测题不记）：
  - 题库原题 → kaoyan_bank_record（带 id 和是否做对；主观题部分得分时带 score；只截取了原题一步或给了提示的，带上实际难度 difficulty）。做错再调用 kaoyan_log_mistake 并带 bankId。
  - 其他题（改编、自编）答对、提示后做对、部分对 → kaoyan_record_question。
  - 其他题答错 → kaoyan_log_mistake（同时进错题本，也算一次做错，不要再调用 kaoyan_record_question）。
  - 都要带难度档 difficulty，按考研视角判断：1 基础＝直接套定义或公式；2 简单＝常规变形两三步；3 中档＝考研选择 / 填空常见难度；4 较难＝真题解答题、综合两三个点；5 压轴。
  - 记录可以和下一步讲解、下一道题的检索放在同一回合并行发出。
- **按难度递进**：考点的掌握度越高，简单题加的分越少，超过某一档的上限后再做这一档的题几乎不加分。kaoyan_exam_focus 里每个考点有「要继续涨需要的难度」：复习和练习时出这一档及以上的题；刚开始学的考点可以从 1–2 档起步，逐步加难。

## 答错之后（考研工具箱插件；与通用规则冲突时以本节为准）
学习者答错、说不会或答得含糊时，不要只给提示让他自己再想，也不要一句话带过就出下一题。按下面的顺序讲完：
1. **正确答案**：先直接说。
2. **你为什么会错**：从他选的选项、作答和思路栏推断他是怎么想的，找出**第一处**出错的地方，说清楚错在哪、为什么看起来对。
3. **正确的解题流程，一步一行**：识别（题目里什么特征提示用什么方法）→ 步骤（每步做什么、为什么这么做，关键算式写全）→ 检查（最后要验证什么）。
4. **一句话规律**：以后看到什么特征就怎么做，或者这个坑怎么避开。
讲完调用 kaoyan_log_mistake 记录（附错因），然后确认他看懂；他选看懂了，再出一道同考法、换数据或条件的题确认。
**答错后确认看懂（必做）**：讲完 1–4、调用 kaoyan_log_mistake 之后，不要接着出下一题、不要推进计划。同一回合调用 ask_user_question，问「这道题的讲解看懂了吗？」，选项 4 个（宿主还会自动加 Other 自定义，共 5 个）：「看懂了，继续」放第一个；另外三个是「第 n 步不懂：…」，从刚才的讲解里挑三处最可能卡住的步骤，写清是哪一步、卡在哪（如「第 2 步不懂：为什么可以用等价无穷小替换」），不要写「步骤不清楚」这种空话。选了某一步就只讲那一步（换角度讲、补全跳过的推导、代具体数字走一遍），打字提问就答他的问题；每次讲完再问一次，选项按刚讲的内容重新挑三步，一直循环到他选「看懂了，继续」。循环期间不出新题、不调用记录工具。没有 ask_user_question 时，用编号列表写出这几个选项（回 1 = 看懂了，回 2–4 = 某一步不懂，也可以直接打问题），然后结束回合等他回复。
- 同一个点最多再换 2 道。还错就退回更基础的一步，或者先往下走、收尾时再回来。
- 冷门点（近 15 年很少考）不要反复纠缠，记进错题本后继续。
- 练习会话里先按练习规则给提示；两轮提示后仍然错，或者学习者说不会，就按上面 1–4 讲完，确认他看懂后再结束这道题。练习会话没有 ask_user_question：讲完用编号列表问「这道题的讲解看懂了吗？回 1 = 看懂了；回 2–4 = 第 n 步不懂：…（挑三处具体步骤）；也可以直接打你的问题」，然后结束回合、先不调用 conclude；他回了某一步就只讲那一步、打字就答问题，讲完再问一次，他回 1 或说懂了才 conclude。`;

const PROBER_EXAM = `## 测底（考研工具箱插件；与通用测底规则冲突时以本节为准）
学习模式、讲题模式不测底时，忽略本节。
- 测底前先查 kaoyan_exam_focus 与 kaoyan_coverage，重点复习先测这一章的高频考点；按考纲查漏时按知识点的未测和待复测状态挑题。题目优先用真题（kaoyan_bank_search / kaoyan_bank_get，答案只给你自己看），题太长就截取关键一步改成选择题。不出逻辑辨析、ε 证明、竞赛风格的题。3–6 道就够。
- 每道测底题判定后按「逐题记录」记录：题库原题用 kaoyan_bank_record；其他题答对用 kaoyan_record_question、答错用 kaoyan_log_mistake；都带难度档 difficulty（1 基础 … 5 压轴）。
- **答错要讲**：答错或答「不知道」时，出下一题之前先用 3–6 行讲清楚：正确答案；他可能是怎么想的、错在哪一步；正确思路的关键步骤（一步一行）。不展开成完整教学，但不能让学习者带着「不知道为什么错」往下做。讲完不要直接出下一道测底题：用 ask_user_question 问「看懂了吗？」，选项为「看懂了，继续」+ 三个「第 n 步不懂：…」（从刚才的讲解里挑三处具体步骤），宿主自动加 Other 自定义；选了某一步就只讲那一步，打字提问就答问题，讲完再问一次（三步按刚讲的重新挑），直到他选看懂了才出下一题。
- probe_done 的 assessment 按考点写：会做哪些题型、在哪类题上出错、错因（概念 / 方法 / 计算）、还有哪些没测到。`;

const PAPER_MARKER = "本会话里学习者发来了**做过的**题目照片（照片上能看到学习者自己的作答痕迹：手写答案、演算过程、勾选的选项），或者消息以「【讲题】」开头";

const PROBER_PAPER = `## 讲题模式（考研工具箱插件）
判断：只有当${PAPER_MARKER}时，本节才生效；否则忽略本节。照片上只有题目、没有作答痕迹的，不算讲题模式。
讲题模式下，学习者已经把题做完了，要的是批改和讲错题，不需要测底：
- 不出摸底题，不调用 probe / recall，不问问题。
- 在你的第一个回合里直接调用 probe_done。assessment.strands 列出照片里这些题涉及的知识线（扫一眼题目就行，不要判卷）；每条的 assessment 写「讲题模式：以学习者交来的作答为准，由老师判卷后确定」。summary 写「讲题模式：学习者交来 N 张做过的题目照片（科目 / 大致内容），先判卷、记错题，再逐题讲错题，最后按错因知识点巩固」。
- 调用成功后用一句中文告诉学习者马上开始批改，然后结束回合。`;

const TEACHER_PAPER = `## 讲题模式（考研工具箱插件；本节优先于学习模式和通用的规划规则）
判断：只有当${PAPER_MARKER}，或测底总结里写有「讲题模式」时，本节才生效；否则忽略本节。照片上只有题目、没有作答痕迹的，按平常讲题处理，不用本节。
学习者交来的是自己做完的试卷或练习题（一般不是真题，**不要去题库里找原题对答案**，你自己判）。流程固定为「判卷 → 记错题 → 逐题讲错题 → 按错因知识点巩固 → 结算」：

1. **判卷**（第一个回合）：逐张看照片，按题号找出全部题目。对每道题：读懂题干，看清学习者的最终答案和演算过程，然后**自己独立完整地解一遍**（不要被学习者的答案带偏），再判对错。
   - 选择 / 填空看最终答案；解答题按考研阅卷习惯按步骤给分，思路对但算错、缺步骤给部分分。题目上标了分值就用标的分值，没标就按考研常见分值估（选择 / 填空 5 分，解答题 10–12 分），并在表里注明「估」。
   - 照片上有红笔批改时可以参考，但仍要自己核对。字迹看不清、题目被遮挡的地方直接问学习者，不要猜。
   - 做对但过程有隐患（蒙对、思路绕远、关键步骤缺论证）的，算做对，在表里备注「对·有隐患」。
2. **错因**：每道错题找到**第一处**出错的步骤，归到错因类型（${ERROR_TYPES.join(" / ")}），知识点写具体（「定积分换元：换元后上下限没跟着换」，不要只写「积分」）。diagnosis 写清楚错在哪一步、学习者写的是什么、为什么错。
3. **记录**：判完后在同一回合调用一次 kaoyan_log_paper，items 里放**全部**题目（做对的也放，correct: true，带得分、知识点和难度档 difficulty 1–5；做对的题会给对应考点的星加分）；做错的写全题目原文、学习者作答、正确答案与关键步骤、错因、诊断。pages 填这道题在第几张照片上（按本会话里学习者发图的先后从 1 数起，跨页就写多张）。错题会自动进错题本（不要再对这些题调用 kaoyan_log_mistake），原题图片会在后台自动裁好。
4. **批改表**：用一张 Markdown 表告诉学习者结果：题号｜对错｜得分｜知识点｜错因（一句话）；表下写总分和错因分布。然后说「哪道判得不对直接告诉我」。学习者纠正后，**只带被改的题**再调用一次 kaoyan_log_paper（按题号覆盖；改成做对会从错题本里删掉）。全对时直接表扬，问要不要讲「对·有隐患」的题，然后结算收尾。
5. **规划**（和批改表同一回合，教学会话用 plan_init）：每道错题一个节点，按卷面顺序，标题如「第3题·换元换限」；同一知识点错了多道题的，这几道连成一串。再为每个错因知识点加一个「巩固：<知识点>」节点，依赖对应的错题节点，放在后面。几道题错因相同就合并成一个巩固节点。节点标题不超过 16 个字。
6. **逐题讲错题**（每个错题节点）：
   - 先简短复述题目，再指出学习者是在哪一步错的（引用他写的那一步），讲清楚为什么错、正确该怎么想，再把正确解法一步一行写完整。讲完按「答错后确认看懂」问他看懂没有，没看懂就答他的追问，选了看懂才出检查题。
   - 讲完出一道检查题：和原题同考法，换数据或换条件，考研难度。答对进入下一题；答错就判断错因、调用 kaoyan_log_mistake 记录，针对错因再讲一次，同样确认看懂后，再换一道同难度变式确认。
   - 只讲做错的题；做对的不讲，除非学习者要求。
7. **按错因知识点巩固**（每个巩固节点）：
   - 先用 kaoyan_vault_search 找这个知识点所在的章节笔记、用 kaoyan_vault_read 读全文（多个知识点的检索在同一回合并行发出），沿用笔记里的讲法；笔记里有 ==高亮== / ★ 的地方重点讲。
   - 系统地讲这个知识点：定义 / 条件 / 结论、常见陷阱，结合这次几道错题的错法说明「你这里容易错在 …」。
   - 再出 1–2 道考研难度的综合变式题（可以用 kaoyan_bank_search 找真题当素材，原题或改编都行；用了题库原题就按真题规则调用 kaoyan_bank_record），都答对才算这个点过关。
8. **收尾**：全部节点完成后调用 kaoyan_settle_study 结算，再用中文总结：这张卷子的得分、错因分布、已经补上的知识点、仍然不稳的点；提醒学习者可以点顶栏「导出到 Obsidian」把这次的易错点记进笔记（真错过的会标 ★）。
全程用中文。`;

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
  const notes = createNotes({ ctx, llm, vault, backupDir: path.join(ctx.dataDirectory, "noteBackups") });
  const pdf = createPdf(ctx.dataDirectory);
  const jobs = createJobs(ctx);
  const bank = createBank({ store, llm, pdf, images, getSettings: settings, getPapersRoot: () => papersRoot() });
  repairChoiceKeys(store);
  const english = createEnglish({ store, llm });
  const progress = createProgress({ store, bank });
  const coverage = createCoverage(store);
  const stats = createStats({ ctx, store, vault, bank });
  const engImport = createEngImport({ store, llm, pdf, images, bank, getSettings: settings });
  const engPractice = createEngPractice({ store, llm, bank });
  const pads = createPadServer({ signal: ctx.signal,
    onSubmit: (d) => { try { ctx.events.emit("pad", d); } catch { /* ignore */ } },
    onNav: (d) => { try { ctx.events.emit("pad", { ...d, nav: true }); } catch { /* ignore */ } } });
  const changed = (what) => { try { ctx.events.emit("changed", { what }); } catch { /* ignore */ } };
  const momo = createMomo({ store, getToken: () => String(settings().momoToken || "").trim() });
  const score = createScore({ ctx, store, bank, llm, progress, coverage, momo, getSettings: settings, transcriptText, classify: (t) => stats.classify(t), onChange: () => changed("score") });
  restore2011Question({ store, pdf, images, folder: papersRoot(), signal: ctx.signal }).then((repaired) => {
    if (!repaired) return;
    score.invalidateFrame();
    changed("bank");
    changed("score");
  }).catch((err) => console.warn(`[kaoyan] 2011 408 第47题恢复失败：${err.message}`));
  const paper = createPaper({ ctx, store, llm, pdf, images, bank, addMistake: (input) => addMistake(input), changed });
  const hostPrompts = createHostPrompts({ ctx, store });
  try { const n = hostPrompts.sync(); if (n) console.log(`[kaoyan] 考研版宿主提示词已更新 ${n} 段`); } catch (err) { console.warn(`[kaoyan] 宿主提示词同步失败：${err?.message || err}`); }
  // 启动 20 秒后：还没细归类的数学 / 408 题、还没评难度的题，在后台补上（之前的调用可能失败过；queueClassify / queueRate 只收没做过的）
  setTimeout(() => {
    if (ctx.signal.aborted) return;
    try {
      const all = bank.all();
      score.queueClassify(all.filter((q) => ["数学", "408"].includes(q.subject) && q.source !== "AI生成").map((q) => q.id));
      score.queueRate(all.map((q) => q.id));
    } catch { /* 下次启动再补 */ }
  }, 20000);
  let momoSyncing = null;
  /** 墨墨数据超过 3 小时就在后台刷新，刷新完通知页面。 */
  const refreshMomo = (force = false) => {
    if (!String(settings().momoToken || "").trim()) return null;
    if (momoSyncing) return momoSyncing;
    const before = momo.cache().at;
    // 只有真的从墨墨拉到了新数据才通知页面刷新（否则页面加载 → 检查 → 通知 → 再加载，会无限循环）
    momoSyncing = momo.sync({ force }).then((r) => { if (r?.at && r.at !== before) changed("score"); return r; }).finally(() => { momoSyncing = null; });
    momoSyncing.catch(() => {});
    return momoSyncing;
  };
  const impactText = (impact) => {
    if (!impact || !impact.items.length) return "预测分没有变化。";
    const top = impact.items.slice(0, 4).map((x) => `${x.name} ${x.delta > 0 ? "+" : ""}${x.delta.toFixed(1)}`).join("，");
    return `预测分 ${impact.before.toFixed(1)} → ${impact.after.toFixed(1)}（${impact.delta >= 0 ? "+" : ""}${impact.delta.toFixed(1)}：${top}）。`;
  };

  // ── 错题本 ─────────────────────────────────────────────
  // 选项统一成 [{key:"A",text}]：接受 {key,text} / {value,label} / 纯字符串
  function normOptions(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 10).map((o, i) => {
      const raw = typeof o === "string" ? { text: o } : (o || {});
      const k = String(raw.key ?? raw.value ?? "").trim();
      const key = /^[A-Za-z]$/.test(k) ? k.toUpperCase() : String.fromCharCode(65 + i);
      return { key, text: str(raw.text ?? raw.label ?? "", 2000) };
    }).filter((o) => o.text);
  }

  // 会话里用宿主选择题工具（quiz / probe）出的题，记错题时模型常常只抄（甚至改写）题干、不抄选项：
  // 在会话里找回原选项（字母沿用出题时的 value，和模型讲解里的「选 C」一致）。
  // 打分 = 题干相似度 + 学习者当时选的选项文字出现在「作答」里 + 是记错题之前最近一道答错的选择题
  function sessionQuiz(chatId, question, learnerAnswer) {
    if (!chatId || !question) return null;
    let record = null;
    try { record = ctx.learning.getSession(chatId); } catch { /* 会话读不到就算了 */ }
    if (!record) return null;
    const norm = (t) => String(t || "").replace(/\\[a-zA-Z]+|[\s$\\{}()（）"“”'‘’，。、：:；;？?！!,.\-]/g, "");
    const grams = (t) => { const s = new Set(); for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2)); return s; };
    const target = grams(norm(question));
    if (target.size < 4) return null;
    const said = norm(learnerAnswer);
    const msgs = record.messages || [];
    // 选择题调用 + 学习者的作答结果
    const results = new Map();
    for (const msg of msgs) if (msg.role === "toolResult" && msg.toolCallId) results.set(msg.toolCallId, msg.details || {});
    let stop = msgs.length; // 旧错题：只看记这道错题那次工具调用之前的题
    msgs.forEach((msg, i) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
      if (msg.content.some((c) => c?.type === "toolCall" && c.name === "kaoyan_log_mistake" && c.arguments?.question === question)) stop = Math.min(stop, i + 1);
    });
    const calls = [];
    msgs.slice(0, stop).forEach((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
      for (const c of msg.content) {
        if (c?.type !== "toolCall" || !["quiz", "probe"].includes(c.name)) continue;
        const a = c.arguments || {};
        if (Array.isArray(a.options) && a.options.length >= 2) calls.push({ a, res: results.get(c.id) });
      }
    });
    const lastWrong = [...calls].reverse().find((x) => x.res && x.res.correct === false);
    let best = null;
    for (const x of calls) {
      const g = grams(norm(x.a.question));
      if (!g.size) continue;
      let hit = 0;
      for (const t of target) if (g.has(t)) hit++;
      let s = Math.max((2 * hit) / (target.size + g.size), (hit / target.size) * 0.95); // 题干常被删掉半句，也看覆盖率
      const picked = (x.res?.answers || []).map((y) => norm(y.label)).filter((y) => y.length >= 2);
      if (said && picked.length && picked.every((y) => said.includes(y))) s += 0.4;
      if (x === lastWrong) s += 0.25;
      if (s >= 0.6 && (!best || s >= best.s)) best = { s, a: x.a };
    }
    if (!best) return null;
    const original = typeof best.a.question === "string" ? best.a.question.trim() : "";
    return { options: normOptions(best.a.options), question: original };
  }

  // 题干里抄进来的选项（「…是：A. xx B. yy」或分行的 A./B.）去掉：选项已经单独存了
  function stripInlineOptions(question, options) {
    const q = String(question || "");
    if (!options?.length) return q;
    const mark = (k) => new RegExp(`(^|[\\s：:。？?；;，,])[(（]?${k}[)）.．、:：]`, "m");
    const a = q.match(mark("A"));
    if (!a) return q;
    const cut = a.index + a[1].length;
    // 至少前三个选项字母（不足三个就全部）都按顺序出现，才认定是抄进来的选项
    let rest = q.slice(cut + 2);
    for (const k of ["B", "C", "D"].slice(0, Math.min(options.length, 3) - 1)) {
      const hit = rest.match(mark(k));
      if (!hit) return q;
      rest = rest.slice(hit.index + hit[0].length);
    }
    return q.slice(0, cut).replace(/[\s；;，,]+$/, "").trim() || q;
  }

  // 旧错题：补选项（optionsChecked），并把题干换回出题时的原文、去掉题干里的选项（stemChecked）；每道只做一次
  function backfillOptions() {
    const items = store.list("mistakes");
    let touched = 0;
    for (const m of items) {
      if (m.optionsChecked && m.stemChecked) continue;
      const hit = m.chatId ? sessionQuiz(m.chatId, m.question, m.learnerAnswer) : null;
      if (hit && !m.options?.length) m.options = hit.options;
      if (!m.stemChecked) {
        if (hit?.question) m.question = hit.question;
        else if (!m.bankId) m.question = stripInlineOptions(m.question, m.options);
      }
      m.optionsChecked = m.stemChecked = true;
      touched++;
    }
    if (touched) { store.saveList("mistakes", items); changed("mistakes"); }
  }

  function addMistake(input) {
    const m = {
      id: uid(),
      subject: ["数学", "408", "英语", "政治"].includes(input.subject) ? input.subject : stats.classify(`${input.topic} ${input.question}`),
      topic: str(input.topic, 200) || "未分类",
      source: str(input.source, 200) || "手动录入",
      question: str(input.question, 20000),
      options: normOptions(input.options),
      optionsChecked: !!input.optionsChecked,
      stemChecked: !!input.optionsChecked,
      learnerAnswer: str(input.learnerAnswer, 8000),
      correctAnswer: str(input.correctAnswer, 20000),
      errorType: str(input.errorType, 50) || "其他",
      diagnosis: str(input.diagnosis, 4000),
      images: Array.isArray(input.images) ? input.images.filter((x) => typeof x === "string") : [],
      chatId: input.chatId || null,
      bankId: input.bankId || null,
      pointIds: validPointIds(input.pointIds, input.subject),
      difficulty: Number.isInteger(input.difficulty) && input.difficulty >= 1 && input.difficulty <= 5 ? input.difficulty : null,
      card: fsrs.newCard(),
      history: [],
      archived: false,
      createdAt: nowIso(),
    };
    if (!m.question && !m.images.length) fail("错题至少要有题目文字或图片");
    // 英语题不进错题本（用户要求）。题库题的对错已在作答记录里；其他英语题记一次做错给拾星
    if (m.subject === "英语") {
      if (!m.bankId) {
        const dup = store.list("qlog").some((x) => x.result === "做错" && x.question === m.question.slice(0, 600) && (x.chatId || null) === m.chatId);
        if (!dup) { score.recordQuestion({ subject: "英语", topic: m.topic, question: m.question, difficulty: m.difficulty, result: "做错", note: `${m.errorType}：${m.diagnosis}`.slice(0, 300), chatId: m.chatId, src: m.source }); changed("score"); }
      }
      return null;
    }
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

  // 英语题不进错题本：启动时把已有的英语错题移出（先备份到 data/removed-english-mistakes.json）
  function purgeEnglishMistakes() {
    const items = store.list("mistakes");
    const eng = items.filter((m) => m.subject === "英语");
    if (!eng.length) return;
    const file = path.join(ctx.dataDirectory, "removed-english-mistakes.json");
    let old = [];
    try { old = JSON.parse(fs.readFileSync(file, "utf8")).items || []; } catch { /* 第一次 */ }
    fs.writeFileSync(file, JSON.stringify({ removedAt: nowIso(), items: [...old, ...eng] }, null, 1));
    store.saveList("mistakes", items.filter((m) => m.subject !== "英语"));
    changed("mistakes");
  }
  try { purgeEnglishMistakes(); } catch { /* 备份失败就先不删 */ }

  // ── 智能体规则与工具 ───────────────────────────────────
  ctx.registerInstructions({ agents: ["teacher", "practice"], text: VAULT_TEXT });
  ctx.registerInstructions({ agents: ["teacher", "practice"], text: TEACHER_PAPER });
  ctx.registerInstructions({ agents: ["prober"], text: PROBER_EXAM });
  ctx.registerInstructions({ agents: ["prober"], text: PROBER_PAPER });
  if (settings().studyMode) {
    ctx.registerInstructions({ agents: ["prober"], text: PROBER_STUDY });
    ctx.registerInstructions({ agents: ["teacher"], text: TEACHER_STUDY });
  }

  const textResult = (text, details) => ({ content: [{ type: "text", text }], details });
  const guard = (signal) => { if (signal?.aborted || ctx.signal.aborted) throw new Error("已取消"); };

  /** 每个会话里用 kaoyan_bank_get 取过的题（会话被压缩成摘要后，模型自己记不住用过哪些）。重启后靠 bankLog / 错题里的 chatId 兜底。 */
  const usedInChat = new Map();
  const pointIdsSchema = { type: "array", maxItems: 8, items: { type: "string", maxLength: 500 }, description: "实际检验的知识点编号，从 kaoyan_coverage 查出。只填真正考到的点。" };
  const knowledgeSummary = (q, entry) => {
    const names = (ids) => (ids || []).map((id) => knowledgeById.get(id)?.name).filter(Boolean).join("、");
    const tested = names(entry?.tested);
    const methods = names(entry?.methods);
    return [tested ? `直接考查：${tested}` : `原标签：${q.topics.join("、") || "—"}`, methods && `解题方法：${methods}`, entry?.status].filter(Boolean).join(" · ");
  };
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
      tools.push(
        {
          name: "kaoyan_bank_search",
          label: "检索题库",
          description: "检索真题和习题。测底及考频核实传 source 真题，课中检查或错后变式可传习题。可按知识点编号检索，即使该词不在题干。返回题干摘要、出处、考查知识点、方法和答案来源，不含答案。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 200, description: "考点或关键词，如「反常积分 比较判别」「二叉树 遍历」" },
              source: { type: "string", enum: ["全部", "真题", "习题"] },
              pointId: { type: "string", maxLength: 500, description: "来自 kaoyan_coverage 的知识点编号" },
              subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
              type: { type: "string", enum: ["单选", "多选", "填空", "解答", "完形", "阅读", "新题型", "翻译", "小作文", "大作文", "分析"] },
              yearFrom: { type: "integer", minimum: 1987, maximum: 2100 },
              yearTo: { type: "integer", minimum: 1987, maximum: 2100 },
              limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            additionalProperties: false,
          },
          execute: async (_id, input, signal) => {
            guard(signal);
            if (!input.query && !input.pointId) fail("请填写关键词或知识点编号");
            const want = Math.max(1, Math.min(20, input.limit || 8));
            const frame = score.frame();
            const point = input.pointId && knowledgeById.get(input.pointId);
            if (input.pointId && !point) fail("知识点编号不存在，请先查考纲覆盖清单");
            const findByPoint = point && ((q) => {
              const entry = frame.knowledge.get(q.id);
              return !!entry && [...entry.tested, ...entry.methods, ...(entry.suggested || [])].includes(point.id);
            });
            const extraTopics = (q) => {
              const entry = frame.knowledge.get(q.id);
              return entry && [...entry.tested, ...entry.methods].map((id) => knowledgeById.get(id)?.name).join(" ");
            };
            let found = bank.search(point ? "" : input.query, { ...input, matchPoint: findByPoint, extraTopics, limit: Math.min(20, want * 2) });
            // 题目还没细归类时按知识点几乎搜不到：用知识点名和别名（再加上调用方给的关键词）做关键词检索补足
            if (point && found.length < want) {
              const seen = new Set(found.map((q) => q.id));
              const words = [point.name.replace(/（.*?）/g, ""), ...point.aliases, input.query || ""].filter(Boolean).join(" ");
              found = [...found, ...bank.search(words, { ...input, subject: point.subject, extraTopics, limit: Math.min(20, want * 2) }).filter((q) => !seen.has(q.id))];
            }
            if (!found.length) return textResult(`题库里没有找到和「${point?.name || input.query}」相关的${input.source === "真题" || input.source === "习题" ? input.source : "题目"}。`, { hits: [] });
            // 标上做没做过：本会话用过的排最后，以前做对过的其次，没做过 / 做错过的优先（各组内保持相关度顺序）
            const { map } = progress.events();
            const mine = usedInChat.get(context.chatId) || new Set();
            const info = (q) => {
              const ev = map.get(q.id) || [];
              const last = ev[ev.length - 1];
              const inChat = mine.has(q.id) || (!!context.chatId && ev.some((e) => e.chatId === context.chatId));
              const tag = inChat ? "本会话用过" : ev.length ? `做过${ev.length}次·上次${last.correct === true ? "对" : last.correct === false ? "错" : "未判"}` : "没做过";
              const keyOk = !!q.answer && (!bank.CHOICE_TYPES.includes(q.type) || bank.choiceAnswer(q));
              return { q, tag: `难度${score.qDiff(q)} | ${tag}`, keyOk, rank: (inChat ? 4 : 0) + (keyOk ? 0 : 2) + (last?.correct === true ? 1 : 0) };
            };
            const hits = found.map(info).map((x, i) => ({ ...x, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, want);
            const lines = hits.map(({ q, tag, keyOk }) => `- id=${q.id} | ${q.paper || "（无出处）"} 第${q.number}题 | ${q.type} ${q.score || ""}分 | ${tag} | ${knowledgeSummary(q, frame.knowledge.get(q.id))} | ${keyOk ? `答案来源：${q.answerSource || "题库"}` : "答案待核"}${q.source === "AI生成" ? " | AI生成" : q.source === "习题" ? " | 习题" : " | 真题"}\n  ${q.stem.replace(/\s+/g, " ").slice(0, 160)}`);
            return textResult(`找到 ${hits.length} 道（没做过、做错过的排在前面；「本会话用过」的不要再出；答案用 kaoyan_bank_get 取，不要提前告诉学习者）：\n${lines.join("\n")}`, { ids: hits.map((h) => h.q.id) });
          },
        },
        {
          name: "kaoyan_bank_get",
          label: "读取题库题目",
          description: "按 id 读取题库原题的题干、选项、答案、解析和材料。作答前不透露答案；答案待核的题请先独立核对、换题或改编。",
          parameters: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false },
          execute: async (_id, input, signal) => {
            guard(signal);
            const q = bank.all().find((x) => x.id === input.id);
            if (!q) return textResult(`找不到 id=${input.id} 的题，请先用 kaoyan_bank_search 检索。`, {});
            if (context.chatId) { if (!usedInChat.has(context.chatId)) usedInChat.set(context.chatId, new Set()); usedInChat.get(context.chatId).add(q.id); }
            score.queueRate([q.id]);
            const material = q.material || (q.materialKey ? bank.materialsOf()[q.materialKey] : "") || "";
            const text = [
              `出处：${q.source === "习题" ? "习题·" : ""}${q.paper || "（无）"} 第${q.number}题（${q.type}${q.source === "习题" ? "" : `，${q.score || "?"} 分`}）${q.source === "AI生成" ? "，AI 生成" : ""}`,
              knowledgeSummary(q, score.frame().knowledge.get(q.id)),
              q.answer && bank.CHOICE_TYPES.includes(q.type) && !bank.choiceAnswer(q) ? "答案待核：题库答案无法对应选项，不能据此判分。" : "",
              material ? `阅读材料：\n${material}` : "",
              `题干：\n${q.stem}`,
              q.options.length ? `选项：\n${q.options.map((o) => `(${o.key}) ${o.text}`).join("\n")}` : "",
              q.hasFigure ? "（原题有图。题图随结果附上时，出题不得省略作答所需数据。）" : "",
              `【仅供你参考，学习者作答前不要透露】\n答案${q.answerSource === "AI" ? "（AI 解答，非官方，可能有误）" : ""}：${q.answer || "（题库里没有）"}\n解析${q.analysisSource === "AI" ? "（AI 按标准答案补写，非官方）" : ""}：${q.analysis || "（题库里没有）"}`,
            ].filter(Boolean).join("\n\n");
            const result = textResult(text, { id: q.id });
            for (const id of (q.figures?.length ? q.figures : q.hasFigure ? q.images || [] : []).slice(0, 4)) {
              try { result.content.push({ type: "image", data: images.get(id), mimeType: "image/jpeg" }); } catch { /* 老题图片可能已丢失 */ }
            }
            return result;
          },
        },
      );
      tools.push({
        name: "kaoyan_exam_focus",
        label: "考点频率表",
        description: "查一章（或一个考点）的考点频率表：每个考纲考点近 15 年真题题数和分值、常见题型、学习者当前掌握度、复习优先级，以及最近几道真题（id、出处、题干摘要，不含答案）。规划和测底前先查，用来决定讲什么、先讲什么、讲多深。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, maxLength: 200, description: "章节或考点名，如「函数 极限 连续」「一元函数积分学」「二叉树」" },
            subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const r = score.focus(input);
          return textResult(r.text, { leaves: r.leaves.map((l) => l.id), pending: r.pending });
        },
      });
      tools.push({
        name: "kaoyan_bank_record",
        label: "记录题库题作答",
        description: "学习者完成题库原题（真题或习题）后记录。填实际检验的 pointIds，且用 hinted 区分独立和提示后答对。自编或改编题用记录做题或错题工具。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 100, description: "题库题目 id（kaoyan_bank_search / kaoyan_bank_get 里的 id）" },
            correct: { type: "boolean", description: "学习者这次是否做对（部分对算 false，并给 score）" },
            pointIds: pointIdsSchema,
            hinted: { type: "boolean", description: "是否在关键步骤获得过提示" },
            score: { type: "number", minimum: 0, maximum: 100, description: "可选：按这道题满分给的得分，主观题部分得分时填" },
            learnerAnswer: { type: "string", maxLength: 2000, description: "学习者的作答（简短）" },
            difficulty: { type: "integer", minimum: 1, maximum: 5, description: "可选：这次实际考的难度档（只截取原题一步、或给了提示时会比原题低）。难度档 1–5（考研视角）：1 基础=直接套定义或公式；2 简单=常规变形两三步；3 中档=考研选择 / 填空常见难度；4 较难=真题解答题、综合两三个点；5 压轴。不填按题库里的难度" },
          },
          required: ["id", "correct"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const question = score.frame().qMap.get(input.id);
          if (!question) return textResult("题库里没有这个 id，没有记录。", {});
          input = { ...input, pointIds: validPointIds(input.pointIds, question.subject) };
          let impact = null;
          let r;
          try { ({ result: r, impact } = score.measure(() => progress.record({ ...input, agent: context.agent, chatId: context.chatId }))); }
          catch { r = progress.record({ ...input, agent: context.agent, chatId: context.chatId }); }
          const bankStatus = input.correct ? (input.hinted ? "提示后做对" : "独立做对") : input.score > 0 ? "部分做对" : "答错待复测";
          coverage.record({ subject: question.subject, pointIds: input.pointIds, status: bankStatus, question: `${question.paper} 第${question.number}题`, chatId: context.chatId, bankId: question.id });
          score.queueRate([input.id]);
          changed("score");
          return textResult(`已记录：${r.q.paper} 第${r.q.number}题 ${input.correct ? "做对" : "做错"}。${impact ? impactText(impact) : ""}${input.correct ? "" : "如果还没记错题，用 kaoyan_log_mistake（带上 bankId）记进错题本。"}`, { id: r.entry.id });
        },
      });
      tools.push({
        name: "kaoyan_record_question",
        label: "记录做题",
        description: "学习者答对（或提示后做对、部分对）一道不是题库原题的题（改编题、自编题、检查题、练习题、测底题）后调用：按难度给对应考点的星加分。题库原题用 kaoyan_bank_record；答错用 kaoyan_log_mistake（它会同时记一次做错）。预测题不记。",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
            pointIds: pointIdsSchema,
            topic: { type: "string", minLength: 1, maxLength: 200, description: "这道题考的具体考点，如「等价无穷小替换」「二叉树的遍历」" },
            question: { type: "string", maxLength: 600, description: "题目摘要（一两句，可含 LaTeX）" },
            difficulty: { type: "integer", minimum: 1, maximum: 5, description: "难度档 1–5（考研视角）：1 基础=直接套定义或公式；2 简单=常规变形两三步；3 中档=考研选择 / 填空常见难度；4 较难=真题解答题、综合两三个点；5 压轴" },
            result: { type: "string", enum: ["独立做对", "提示后做对", "部分对"] },
            note: { type: "string", maxLength: 300, description: "可选：一句话依据" },
          },
          required: ["subject", "topic", "difficulty", "result"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          let r, impact = null;
          try { ({ result: r, impact } = score.measure(() => score.recordQuestion({ ...input, chatId: context.chatId, src: { practice: "练习会话", prober: "测底" }[context.agent] || "教学会话" }))); }
          catch { r = score.recordQuestion({ ...input, chatId: context.chatId }); }
          changed("score");
          return textResult(`已记录（难度 ${r.entry.difficulty}·${r.entry.result}${r.leaves.length ? `，计入：${r.leaves.join("、")}` : "，没对上考纲考点，没有加分"}）。${impact ? impactText(impact) : ""}`, { id: r.entry.id });
        },
      });
      tools.push({
        name: "kaoyan_log_mistake",
        label: "记录错题",
        description: "学习者答错或答得含糊时调用：把题目、学习者回答、正确答案、错因记进错题本，之后按遗忘曲线安排重做。选择题必须把全部选项放进 options（字母和出题时一致），题干里不要写选项。英语题照样调用，但不会进错题本，只记一次做错。",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
            pointIds: pointIdsSchema,
            topic: { type: "string", minLength: 1, maxLength: 200, description: "所属知识点" },
            question: { type: "string", minLength: 1, maxLength: 8000, description: "题干原文（可含 LaTeX），照抄出题时的完整题干，不要删改" },
            options: {
              type: "array",
              maxItems: 10,
              description: "选择题的全部选项（非选择题不填）。key 用出题时的字母，text 照抄选项原文（可含 LaTeX）",
              items: {
                type: "object",
                properties: { key: { type: "string", maxLength: 2 }, text: { type: "string", minLength: 1, maxLength: 2000 } },
                required: ["key", "text"],
                additionalProperties: false,
              },
            },
            learnerAnswer: { type: "string", minLength: 1, maxLength: 4000 },
            correctAnswer: { type: "string", maxLength: 8000, description: "正确答案与关键步骤" },
            errorType: { type: "string", enum: ERROR_TYPES },
            diagnosis: { type: "string", minLength: 1, maxLength: 2000, description: "错在哪、为什么错" },
            bankId: { type: "string", maxLength: 100, description: "题库原题（真题或习题）填题目 id" },
            difficulty: { type: "integer", minimum: 1, maximum: 5, description: "难度档 1–5（考研视角）：1 基础=直接套定义或公式；2 简单=常规变形两三步；3 中档=考研选择 / 填空常见难度；4 较难=真题解答题、综合两三个点；5 压轴" },
          },
          required: ["subject", "topic", "question", "learnerAnswer", "errorType", "diagnosis", "difficulty"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          // 会话里能找到这道选择题时，题干和选项都用出题时的原文（模型记错题时常改写题干、把选项抄进题干）
          const hit = sessionQuiz(context.chatId, input.question, input.learnerAnswer);
          const options = input.options?.length ? input.options : hit?.options || [];
          input = { ...input, question: hit?.question || stripInlineOptions(input.question, normOptions(options)) };
          if (input.subject === "英语") {
            addMistake({ ...input, source: { practice: "练习会话", prober: "测底" }[context.agent] || "教学会话", chatId: context.chatId });
            return textResult(`英语题不进错题本，只给对应考点的星记了一次做错（难度 ${input.difficulty || "?"}）。现在按「答错之后」讲清楚，再换题检查。`, {});
          }
          const m = addMistake({ ...input, options, optionsChecked: true, bankId: input.bankId && bank.all().some((q) => q.id === input.bankId) ? input.bankId : null, source: { practice: "练习会话", prober: "测底" }[context.agent] || "教学会话", chatId: context.chatId });
          if (!m.bankId) coverage.record({ subject: m.subject, pointIds: m.pointIds, status: "答错待复测", question: m.question, chatId: context.chatId });
          changed("score");
          return textResult(`已记进错题本（${m.errorType}：${m.topic}），对应考点的星记了一次做错（难度 ${m.difficulty || "?"}）。现在按「答错之后」讲清楚，再换题检查。`, { id: m.id });
        },
      });
      tools.push({
        name: "kaoyan_coverage",
        label: "查考纲知识点覆盖",
        description: "查数一或408某章的知识点、编号和实测状态。规划时与考频表同查；本轮未测的继续留在清单。题库检索或作答记录可以引用编号。",
        parameters: {
          type: "object",
          properties: { query: { type: "string", minLength: 1, maxLength: 200 }, subject: { type: "string", enum: ["数学", "408"] } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const result = score.focus(input);
          if (!result.coverage?.length) return textResult("没查到对应的数一或408知识点，请用具体章节名。", { points: [] });
          const rows = result.coverage;
          const count = (st) => rows.filter((p) => p.status === st).length;
          const lines = [`考纲知识点清单（共 ${rows.length} 项：独立做对 ${count("独立做对")}，提示后/部分做对 ${count("提示后做对") + count("部分做对")}，答错待复测 ${count("答错待复测")}，已讲待测 ${count("已讲待测")}，未测 ${count("未测")}）`,
            "格式：知识点 · 状态 · 近15年真题直接考查题数（只算已细归类的题） · 标记 · 编号。「延伸」= 大纲没单列、常考的方法；「待核」= 只有第三方整理稿列出，低优先级。"];
          let leaf = "";
          for (const p of rows) {
            if (p.leaf !== leaf) { leaf = p.leaf; lines.push(`## ${leaf.split("/").slice(-2).join(" · ")}`); }
            const tags = [p.extension && !p.pending ? "延伸" : "", p.pending ? "待核" : ""].filter(Boolean).join("·");
            lines.push(`- ${p.name} · ${p.status}${p.tests > 1 ? `（测过${p.tests}次）` : ""} · ${p.recent}题${tags ? ` · ${tags}` : ""} · ${p.id}`);
          }
          if (result.pending) lines.push("", `注意：这些科目还有 ${result.pending} 道近 15 年真题没做细归类，题数偏少，不能据「0题」判定不考。`);
          return textResult(lines.join("\n"), { points: rows });
        },
      }, {
        name: "kaoyan_mark_taught",
        label: "记录已讲待测",
        description: "只标记已完成讲解、还没作答的知识点。答题结果用对应的逐题作答工具。",
        parameters: {
          type: "object",
          properties: { subject: { type: "string", enum: ["数学", "408"] }, pointIds: pointIdsSchema },
          required: ["subject", "pointIds"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          const n = coverage.record({ ...input, status: "已讲待测", chatId: context.chatId });
          if (n) changed("score");
          return textResult(n ? `已记录 ${n} 个已讲知识点。` : "没有找到有效的知识点编号。", { n });
        },
      });
      if (context.agent === "prober") return tools;
      tools.push({
        name: "kaoyan_log_paper",
        label: "记录讲题批改",
        description: "讲题模式专用：学习者发来做过的试卷 / 题目照片、你判完卷后调用一次。items 放全部题目的批改结果（做对的也放）；做错的自动进错题本（附从照片里裁出的原题图），不要再对它们调用 kaoyan_log_mistake。学习者纠正判卷结果时，只带被改的题再调用（按题号覆盖）。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 200, description: "这份卷子 / 练习的名字，如「高数第三章测验」「线代练习 5」；看不出就写主要内容" },
            subject: { type: "string", enum: ["数学", "408", "英语", "政治"] },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                properties: {
                  number: { type: "string", minLength: 1, maxLength: 30, description: "题号，按卷面写，如「3」「17(2)」" },
                  correct: { type: "boolean", description: "是否做对（部分得分算 false）" },
                  score: { type: "number", minimum: 0, maximum: 200, description: "这道题得分" },
                  fullScore: { type: "number", minimum: 0, maximum: 200, description: "这道题满分" },
                  topic: { type: "string", minLength: 1, maxLength: 200, description: "知识点（做错时写错因所在的具体知识点）" },
                  pages: { type: "array", items: { type: "integer", minimum: 1, maximum: 200 }, maxItems: 4, description: "这道题在本会话学习者发的第几张照片上（从 1 数起）" },
                  question: { type: "string", maxLength: 8000, description: "做错时必填：题目原文（可含 LaTeX）" },
                  learnerAnswer: { type: "string", maxLength: 4000, description: "做错时必填：学习者的作答与关键过程" },
                  correctAnswer: { type: "string", maxLength: 8000, description: "做错时必填：正确答案与关键步骤" },
                  errorType: { type: "string", enum: ERROR_TYPES, description: "做错时必填" },
                  diagnosis: { type: "string", maxLength: 2000, description: "做错时必填：第一处错在哪一步、为什么错" },
                  difficulty: { type: "integer", minimum: 1, maximum: 5, description: "难度档 1–5（考研视角）：1 基础=直接套定义或公式；2 简单=常规变形两三步；3 中档=考研选择 / 填空常见难度；4 较难=真题解答题、综合两三个点；5 压轴" },
                },
                required: ["number", "correct", "topic", "difficulty"],
                additionalProperties: false,
              },
            },
          },
          required: ["items"],
          additionalProperties: false,
        },
        execute: async (_id, input, signal) => {
          guard(signal);
          if (!context.chatId) return textResult("拿不到会话编号，没有记录。", {});
          const r = await paper.log({ chatId: context.chatId, agent: context.agent, input });
          const wrong = r.rows.filter((x) => !x.correct);
          const rev = r.review;
          const lines = [
            `已记录 ${r.rows.length} 道题（这次调用里做错 ${wrong.length} 道${wrong.length ? `：第 ${wrong.map((x) => x.number).join("、")} 题，已进错题本` : ""}）。`,
            rev.total != null ? `整份目前得分 ${rev.got}/${rev.total}。` : "",
            wrong.some((x) => x.pages.length) ? "原题图片正在后台从照片里裁剪。" : "",
            !r.imageCount && wrong.length ? "注意：本会话里没找到学习者发的照片，错题只存了文字。" : "",
            wrong.some((x) => !x.pages.length) && r.imageCount ? "有错题没填 pages，没附原题图；可以补上 pages 再调用一次。" : "",
            "现在给学习者看批改表，并按讲题模式规划。",
          ];
          return textResult(lines.filter(Boolean).join(""), { reviewId: rev.id, wrong: wrong.map((x) => x.mistakeId) });
        },
      });
      tools.push({
        name: "kaoyan_settle_study",
        label: "结算本次学习",
        description: "会话学习告一段落时调用一次：读取本会话全文，评估各考点的掌握程度，更新考研预测分。同一会话再次调用会覆盖上一次结算。",
        parameters: { type: "object", properties: { note: { type: "string", maxLength: 500, description: "可选：你对这次学习的简短判断" } }, additionalProperties: false },
        execute: async (_id, _input, signal) => {
          guard(signal);
          if (!context.chatId) return textResult("拿不到会话编号，没有结算。", {});
          const r = await score.settle({ chatId: context.chatId, by: "agent", signal });
          changed("score");
          try { ctx.events.emit("score-settled", { chatId: context.chatId }); } catch { /* ignore */ }
          const lines = r.items.map((x) => `- ${x.name}：${x.kind === "practice" ? "练习" : "讲解"}·${x.result}${x.note ? `（${x.note}）` : ""}`);
          return textResult(`已结算 ${r.items.length} 个考点。${impactText(r.impact)}\n${lines.join("\n")}`, { delta: r.impact.delta });
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

  op("settings.get", () => {
    const { momoToken, ...rest } = settings();
    const t = String(momoToken || "");
    return { settings: { ...rest, momoTokenSet: !!t, momoTokenHint: t ? `已填写（…${t.slice(-4)}）` : "" }, errorTypes: ERROR_TYPES };
  });
  op("models.list", () => llm.catalogModels());
  op("vault.detect", () => ({ vaults: detectObsidianVaults() }));
  // 「AI 自动配置」：固定提示词，不带本机信息，复制给 agent 在任意电脑上配置。
  op("setup.prompt", () => ({ prompt: SETUP_PROMPT }));
  op("hostPrompts.status", () => hostPrompts.status());
  op("hostPrompts.apply", () => hostPrompts.apply());
  op("hostPrompts.revert", () => hostPrompts.revert());
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
    return { root, isObsidian: has(".obsidian"), md, plans: has("计划"), spec: fs.existsSync(path.join(root, "笔记规范", "笔记格式规范.md")), subjects: ["数学", "408", "英语", "政治"].filter(has), papers };
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
    if (p.classifyModel !== undefined) patch.classifyModel = p.classifyModel && p.classifyModel.provider && p.classifyModel.id ? { provider: str(p.classifyModel.provider, 200), id: str(p.classifyModel.id, 300) } : null;
    if (p.importConcurrency !== undefined) patch.importConcurrency = Math.max(1, Math.min(12, Number(p.importConcurrency) || 6));
    if (p.momoToken !== undefined) patch.momoToken = str(p.momoToken, 500).trim();
    if (p.vocabTarget !== undefined) patch.vocabTarget = Math.max(1000, Math.min(20000, Math.round(Number(p.vocabTarget) || 5500)));
    if (p.sessionSubject) patch.sessionSubjects = { ...settings().sessionSubjects, [p.sessionSubject.id]: p.sessionSubject.subject };
    return saveSettings(patch);
  });
  op("image.get", (p) => ({ data: images.get(p.id) }));
  op("image.save", (p) => ({ id: images.save(p.data) }));
  op("jobs.list", () => jobs.list());
  op("jobs.get", (p) => jobs.get(p.id));
  op("jobs.cancel", (p) => jobs.cancel(p.id));

  // 分数判断机
  op("score.overview", () => { refreshMomo(false); return score.overview(); });
  op("score.today", () => {
    refreshMomo(false);
    const o = score.overview();
    return { total: o.total, sigma: o.sigma, projection: o.projection, review: o.review.slice(0, 8), reviewCount: o.reviewCount, vocab: o.vocab, unsettled: score.unsettled() };
  });
  op("score.unsettled", () => ({ sessions: score.unsettled() }));
  op("score.focus", (p) => score.focus(p));
  op("score.coverage", (p) => score.coverageList(Array.isArray(p.leaves) ? p.leaves.slice(0, 50) : [str(p.leaf, 500)]));
  op("score.questions", (p) => score.questionsOf(str(p.leaf, 500), Math.max(1, Math.min(40, Number(p.limit) || 10))));
  op("score.settle", (p) => jobs.start("settle", "结算本次学习", async (j) => {
    const r = await score.settle({ chatId: str(p.chatId, 200), by: "button", ...j });
    changed("score");
    return r;
  }));
  // 题目细归类：一次只跑一个任务；暂停 = 取消任务（已归的每批都存了，下次从没归的接着来）
  let classifyJob = null;
  const classifyRunning = () => { const j = classifyJob && jobs.get(classifyJob); return j && j.status === "running" ? j : null; };
  op("score.classifyStatus", () => ({ ...score.classifyStatus(), running: classifyRunning(), model: settings().classifyModel || null }));
  op("score.classify", async () => {
    let running = classifyRunning();
    for (let i = 0; i < 120 && running?.cancelling; i++) { await new Promise((r) => setTimeout(r, 500)); running = classifyRunning(); }
    if (running) return running;
    const job = jobs.start("classify", "题目知识点归类", async (j) => { try { return await score.classifyBank(j); } finally { changed("score"); } });
    classifyJob = job.id;
    return job;
  });
  op("score.classifyPause", () => { const j = classifyRunning(); return j ? jobs.cancel(j.id) : { ok: false }; });
  op("score.rate", (p) => jobs.start("rate", "AI 评定题目难度", async (j) => { const r = await score.rateBank({ ...j, force: !!p.force }); changed("score"); return r; }));
  op("momo.sync", () => jobs.start("momo", "同步墨墨背单词", async () => {
    const r = await refreshMomo(true);
    if (!r) fail("还没填墨墨 token");
    if (r.error) fail(r.error);
    return { words: r.words.length, at: r.at };
  }));
  op("momo.test", async (p) => {
    const token = str(p.token, 500).trim() || String(settings().momoToken || "").trim();
    if (!token) fail("请先填墨墨 token");
    const res = await fetch("https://open.maimemo.com/open/api/v1/memo/study/query_study_records", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ as_count: true, next_study_date: { start: "2000-01-01T00:00:00.000Z", end: "2100-01-01T00:00:00.000Z" } }), signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) fail(`连不上墨墨：${data?.errors?.[0]?.msg || res.status}`);
    return { count: data.data.count };
  });

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
  // 导出草稿：生成任务在后台跑，结果落盘（data/exportDrafts.json），关掉窗口也能回来接着改
  const exportJobs = new Map(); // chatId → jobId（本次运行内）
  const drafts = () => store.value("exportDrafts", {});
  const setDraft = (chatId, v) => { const all = drafts(); if (v) all[chatId] = v; else delete all[chatId]; store.saveValue("exportDrafts", all); };
  op("export.draft", (p) => {
    const chatId = str(p.chatId, 200);
    const running = exportJobs.get(chatId) && jobs.get(exportJobs.get(chatId));
    if (running?.status === "running") return running;
    const job = jobs.start("export", "整理到 Obsidian 笔记", async ({ progress, signal }) => {
      const d = await notes.draft({ chatId, progress, signal });
      setDraft(chatId, { draft: d, at: nowIso() });
      return d;
    });
    exportJobs.set(chatId, job.id);
    return job;
  });
  op("export.status", (p) => {
    const chatId = str(p.chatId, 200);
    const id = exportJobs.get(chatId);
    const job = id ? jobs.get(id) : null;
    const saved = drafts()[chatId] || null;
    return { job: job?.status === "running" ? job : null, draft: saved?.draft || null, at: saved?.at || null, error: job?.status === "failed" ? job.error : null };
  });
  op("export.discard", (p) => { setDraft(str(p.chatId, 200), null); return { ok: true }; });
  op("export.save", (p) => {
    const r = notes.save({ notes: p.notes, overwrite: p.overwrite || [] });
    if (p.chatId && r.results.every((x) => x.written)) {
      saveSettings({ exportPrompted: { ...settings().exportPrompted, [p.chatId]: "exported" } });
      setDraft(str(p.chatId, 200), null);
    }
    return r;
  });
  op("export.dismiss", (p) => saveSettings({ exportPrompted: { ...settings().exportPrompted, [str(p.chatId, 200)]: "skipped" } }));
  op("export.shouldPrompt", (p) => {
    const s = settings();
    return { prompt: s.autoExportPrompt && !s.exportPrompted[p.chatId] };
  });

  // 错题本
  op("mistakes.list", () => {
    try { backfillOptions(); } catch { /* 补不上不影响列表 */ }
    return { items: store.list("mistakes"), reports: store.list("reports"), reviews: store.list("reviews") };
  });
  op("reviews.delete", (p) => { store.remove("reviews", str(p.id, 100)); changed("reviews"); return { ok: true }; });
  op("mistakes.add", (p) => {
    // 手动录入的英语题直接拒绝（不要像会话里那样记一次做错）
    const subject = ["数学", "408", "英语", "政治"].includes(p.subject) ? p.subject : stats.classify(`${p.topic} ${p.question}`);
    if (subject === "英语") fail("英语题不进错题本");
    return addMistake({ ...p, subject, question: stripInlineOptions(p.question, normOptions(p.options)) });
  });
  op("mistakes.update", (p) => {
    const allowed = ["subject", "topic", "question", "learnerAnswer", "correctAnswer", "errorType", "diagnosis", "archived", "source", "options"];
    const patch = Object.fromEntries(Object.entries(p.patch || {}).filter(([k]) => allowed.includes(k)));
    if ("options" in patch) patch.options = normOptions(patch.options);
    const r = store.update("mistakes", p.id, patch);
    changed("mistakes");
    return r;
  });
  op("mistakes.delete", (p) => { store.remove("mistakes", p.id); changed("mistakes"); return { ok: true }; });
  op("mistakes.rate", (p) => {
    try { ctx.events.emit("changed", { what: "score" }); } catch { /* ignore */ }
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
      system: `你是考研阅卷老师。判断学生这次重做是否正确，按步骤指出问题；顺便按考研视角给这道题评难度档 difficulty（1 基础＝直接套定义或公式；2 简单＝常规变形两三步；3 中档＝考研选择 / 填空常见难度；4 较难＝真题解答题、综合两三个点；5 压轴）。
- 有选项的是选择题：只看选的字母（或写出的结论）是否等于正确选项，选对就是 correct:true、score 100，不要求写论证；选错再说明错在哪、正确选项为什么对。
- feedback 是 Markdown：所有数学符号和式子（哪怕只是 f(x)、x、1）都用 $...$ 包成 LaTeX，例如 $f(x+1)=f(x)$；分点用列表（"- "）或分段，不要用 ①②。
输出 JSON：{"correct":true/false,"score":0-100,"feedback":"批改意见（中文 Markdown）","difficulty":3}`,
      text: `题目：${m.question}\n${(m.options || []).length ? `选项：\n${m.options.map((o) => `${o.key}. ${o.text}`).join("\n")}\n` : ""}参考答案：${m.correctAnswer || "（无，请自行求解）"}\n上次的错因：${m.errorType}：${m.diagnosis}\n\n这次作答：${answerText || "（见图片中最后几张）"}${m.images?.length ? `\n（前 ${m.images.length} 张图是题目原图）` : ""}${raw.length ? `\n（最后 ${raw.length} 张图是学生手写作答）` : ""}`,
      images: imgs.map((x) => ({ ...x, mimeType: "image/jpeg" })),
      maxTokens: 3000,
      signal,
    });
    // 题库题交给后台统一评；别的错题没有难度时，用这次批改顺手给的
    if (m.bankId) score.queueRate([m.bankId]);
    else if (!m.difficulty && Number.isInteger(res.difficulty) && res.difficulty >= 1 && res.difficulty <= 5) { store.update("mistakes", m.id, { difficulty: res.difficulty }); changed("score"); }
    return { ...res, transcript };
  }));
  op("mistakes.ocr", (p) => jobs.start("ocr", "识别错题照片", async () => {
    const imgs = (p.images || []).map((d) => ({ data: d, mimeType: "image/jpeg" }));
    if (!imgs.length) fail("请先选择照片");
    const res = await llm.json({
      system: `你在帮考研学生录入纸质书上做错的题。识别照片里的题目（可能多道），公式用 LaTeX。输出 JSON：{"items":[{"subject":"数学|408|英语|政治","topic":"考点","question":"题干 Markdown（不含选项）","options":[{"key":"A","text":"选项内容（不带字母）"}],"correctAnswer":"照片里能看到的答案/解析，没有就留空","learnerAnswer":"照片里学生的手写作答，没有就留空"}]}。选择题的选项只放在 options 里，不要写进 question；不是选择题 options 给 []。`,
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
    if (p.source === "真题") items = items.filter((q) => !["习题", "AI生成"].includes(q.source));
    if (p.source === "习题") items = items.filter((q) => q.source === "习题");
    const frame = p.q || p.knowledge ? score.frame() : null;
    if (p.q) items = items.filter((q) => `${q.stem} ${q.topics.join(" ")} ${knowledgeSummary(q, frame.knowledge.get(q.id))}`.toLowerCase().includes(String(p.q).toLowerCase()));
    if (p.knowledge) items = items.map((q) => ({ ...q, knowledge: knowledgeSummary(q, frame.knowledge.get(q.id)) }));
    return { total: items.length, items: items.slice(0, Number(p.limit) || 200), papers: bank.papers() };
  });
  op("bank.papers", () => bank.papers());
  op("bank.update", (p) => {
    const allowed = ["stem", "answer", "analysis", "topics", "type", "score", "number", "options"];
    const patch = Object.fromEntries(Object.entries(p.patch || {}).filter(([k]) => allowed.includes(k)));
    const updated = store.update("bank", p.id, (q) => {
      const next = { ...q, ...patch };
      if (next.answer && bank.CHOICE_TYPES.includes(next.type) && !bank.choiceAnswer(next)) fail("答案无法对应现有选项，请填写正确的选项字母");
      return { ...patch, ...(patch.analysis !== undefined && patch.analysis !== q.analysis ? { analysisSource: "手动" } : {}), ...(patch.answer !== undefined && patch.answer !== q.answer ? { answerSource: "手动" } : {}) };
    });
    score.invalidateFrame();
    changed("score");
    return updated;
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
    const run = (options, importer) => jobs.start("import", label, async (j) => {
      const result = await importer({ meta, ...options, ...j });
      score.invalidateFrame();
      if (meta.kind !== "answers") {
        const ids = bank.all().filter((q) => q.subject === meta.subject && q.paper === meta.paper).map((q) => q.id);
        score.queueClassify(ids);
        score.queueRate(ids);
      }
      changed("bank");
      return result;
    });
    if (p.format === "text") return run({ text: str(p.text, 2_000_000) }, bank.importText);
    if (p.format === "images") return run({ imgs: (p.images || []).map((d) => ({ data: d, mimeType: "image/jpeg" })) }, bank.importImages);
    if (p.format === "pdf") return run({ pdfBase64: p.pdf, first: Number(p.first) || 1, last: Number(p.last) || 999 }, bank.importPdf);
    fail("未知的导入格式");
  });

  // 批量导入整理好的真题文件夹（manifest.json），可断点续传
  const progressFile = "import-progress";
  const readProgress = () => ({ done: [], failed: {}, ...store.value(progressFile, {}) });
  /** 合并写入：暂停后旧任务手上的文件可能晚一点才做完，不能用它的旧快照覆盖新任务的进度。 */
  const saveProgressMerged = (st) => {
    const cur = readProgress();
    const done = [...new Set([...cur.done, ...st.done])];
    const failed = { ...cur.failed, ...st.failed };
    for (const f of st.done) delete failed[f];
    store.saveValue(progressFile, { ...cur, ...st, done, failed });
  };
  /** 清单里的文件各自的状态（进度记录几个文件夹共用，只数这一份的）。 */
  const folderProgress = (folder) => {
    let items = [];
    try { items = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).items || []; } catch { items = []; }
    const st = readProgress();
    const files = new Set(items.map((it) => it.file));
    return { total: items.length, done: items.filter((it) => st.done.includes(it.file)).length, failed: Object.fromEntries(Object.entries(st.failed || {}).filter(([f]) => files.has(f))) };
  };
  const folderProgressFiles = (folder) => { try { return new Set((JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).items || []).map((it) => it.file)); } catch { return new Set(); } };
  let batchJob = null;
  // 题库包：导出已识别好的题库给别人，或导入别人的题库包（不用再识别）
  const pack = createPack({ store, imageDir, version: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")).version; } catch { return ""; } })() });
  op("pack.summary", () => pack.summary());
  op("pack.find", () => ({ packs: pack.findPacks() }));
  op("pack.export", (p) => pack.exportPack({ dir: expandHome(str(p.dir, 1000)), subjects: Array.isArray(p.subjects) ? p.subjects.map((x) => str(x, 20)) : [] }));
  op("pack.preview", (p) => pack.previewPack(expandHome(str(p.file, 2000))));
  op("pack.import", (p) => { const r = pack.importPack(expandHome(str(p.file, 2000))); changed("bank"); return r; });

  // 文件夹框默认填上次批量导入用的文件夹（重启后不会跳回真题文件夹）
  const batchFolder = (p) => expandHome(str(p.folder, 1000)) || expandHome(settings().lastBatchFolder || "") || papersRoot();
  op("bank.batchStatus", (p) => {
    const folder = batchFolder(p);
    return { folder, ...folderProgress(folder), running: batchJob ? jobs.get(batchJob) : null };
  });
  op("bank.batchPause", () => {
    const running = batchJob && jobs.get(batchJob);
    if (!running || running.status !== "running") return { ok: false };
    return jobs.cancel(batchJob);
  });
  op("bank.batchImport", async (p) => {
    let running = batchJob && jobs.get(batchJob);
    // 刚点了暂停、旧任务还在收尾：等它停下（最多 60 秒）再开新任务
    for (let i = 0; i < 120 && running?.cancelling; i++) { await new Promise((r) => setTimeout(r, 500)); running = jobs.get(batchJob); }
    if (running && running.status === "running") return running;
    const folder = needPapers(batchFolder(p));
    if (settings().lastBatchFolder !== folder) saveSettings({ lastBatchFolder: folder });
    if (p.reset) store.saveValue(progressFile, { ...readProgress(), done: readProgress().done.filter((f) => !folderProgressFiles(folder).has(f)), failed: {} });
    const job = jobs.start("batch", "批量导入题目", (j) => bank.importManifest({
      folder, ...j,
      // 每导完一份题目文件：后台把新题归到考点，没评上难度的也补评
      onFileDone: ({ ids }) => { score.invalidateFrame(); score.queueClassify(ids); score.queueRate(ids); changed("bank"); },
      readProgress,
      saveProgress: saveProgressMerged,
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
    // 错题自动进错题本；前后各算一次分数，看这次练习对预测分的影响
    let before = null;
    try { before = score.evaluate(Date.now(), { detail: false }); } catch { before = null; }
    const label = attempt.paper || `${attempt.subject}${attempt.mode === "quick" ? "快练" : "专项"}`;
    let added = 0;
    for (const q of qs) {
      const r = results[q.id];
      if (r.correct !== false || q.subject === "英语") continue; // 英语题不进错题本
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
    changed("score");
    let impact = null;
    try { if (before) impact = score.diff(before, score.evaluate(Date.now(), { detail: false })); } catch { impact = null; }
    if (impact) store.update("attempts", attempt.id, { impact: { before: impact.before, after: impact.after, delta: impact.delta, items: impact.items.slice(0, 30) } });
    score.queueRate(qs.map((q) => q.id));
    const full = qs.map((q) => ({ ...bank.forExam(q, {}), answer: q.answer, analysis: q.analysis, analysisSource: q.analysisSource || "" }));
    return { attemptId: attempt.id, results, total, got, added, questions: full, impact };
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
  // 生词只在墨墨里背：加进生词本时自动推送到墨墨的学习计划
  let pushing = Promise.resolve();
  function pushToMomo(words, signal) {
    const run = async () => {
      const items = store.list("vocab");
      const list = words ? items.filter((w) => words.some((x) => x.toLowerCase() === w.word.toLowerCase())) : items.filter((w) => !w.momo || w.momo.status === "error");
      if (!list.length) return { total: 0, added: 0, exists: 0, notfound: 0 };
      let r;
      try { r = await momo.pushWords(list.map((w) => w.word), signal); }
      catch (err) {
        const all = store.list("vocab");
        for (const w of all) if (list.some((x) => x.id === w.id)) w.momo = { status: "error", error: err.message, at: nowIso() };
        store.saveList("vocab", all); changed("vocab");
        throw err;
      }
      const all = store.list("vocab");
      const count = { total: list.length, added: 0, exists: 0, notfound: 0 };
      for (const w of all) {
        const st = r.result[w.word.trim()] || r.result[Object.keys(r.result).find((k) => k.toLowerCase() === w.word.trim().toLowerCase())];
        if (!st || !list.some((x) => x.id === w.id)) continue;
        w.momo = { status: st, at: nowIso() };
        count[st]++;
      }
      store.saveList("vocab", all);
      changed("vocab");
      return { ...count, confirmed: r.added };
    };
    const p = pushing.then(run, run);
    pushing = p.catch(() => {});
    return p;
  }
  const autoPush = (words) => { if (String(settings().momoToken || "").trim() && words.length) pushToMomo(words).catch(() => {}); };
  op("vocab.addMany", (p) => {
    const words = Array.isArray(p.words) ? p.words.slice(0, 50) : [];
    const r = engPractice.addWords({ words, source: p.source });
    changed("vocab");
    autoPush(words.map((w) => str(w.word, 100).trim()).filter(Boolean));
    return r;
  });
  op("vocab.pushMomo", () => jobs.start("momopush", "推送生词到墨墨", ({ signal }) => pushToMomo(null, signal)));
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
  op("vocab.add", async (p) => { const r = await english.addWord(p); changed("vocab"); autoPush([r.item.word]); return r; });
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
