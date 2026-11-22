// 考研工具箱前端入口。
import { put, reset, el, btn, field, errorBox, toast, runJob } from "./assets/ui.js";
import { mountToday } from "./assets/today.js";
import { mountMistakes } from "./assets/mistakes.js";
import { mountBank } from "./assets/bank.js";
import { mountExam } from "./assets/exam.js";
import { mountEnglish } from "./assets/english.js";
import { openExportDialog } from "./assets/export.js";
import { openSettleDialog } from "./assets/score.js";
import { mountScore } from "./assets/sky3d.js";

const VIEWS = [
  ["today", "今日", mountToday, "M3 4h18v18H3z M3 10h18 M8 2v4 M16 2v4"],
  ["score", "拾星", mountScore, "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"],
  ["mistakes", "错题本", mountMistakes, "M4 4h12l4 4v12H4z M8 12h8 M8 16h5"],
  ["bank", "题库", mountBank, "M4 6h16 M4 12h16 M4 18h10"],
  ["exam", "快练 / 模考", mountExam, "M12 7v5l3 3 M12 3a9 9 0 1 0 0.01 0"],
  ["english", "英语专项", mountEnglish, "M4 20l6-16 6 16 M6 14h8 M17 8h4 M19 6v4"],
];
const icon = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

export function activate(ctx) {
  for (const [id, name, mount, path] of VIEWS) {
    ctx.registerView({
      id,
      name,
      mount(container, signal) {
        try { mount(ctx, container, signal); } catch (err) { reset(container, errorBox(err)); }
        return () => reset(container);
      },
    });
    ctx.registerAction({ id: `open-${id}`, name, icon: icon(path), run: () => ctx.app.openView(id) });
    ctx.placeAction({ id: `sidebar-${id}`, actionId: `open-${id}`, location: "sidebar" });
  }

  // 会话顶栏：导出到 Obsidian
  ctx.registerAction({
    id: "export-obsidian",
    name: "导出到 Obsidian",
    icon: icon("M12 3v12 M7 10l5 5 5-5 M5 21h14"),
    run: (context) => {
      if (context.surface !== "session") return;
      openExportDialog(ctx, context.sessionId);
    },
  });
  ctx.placeAction({ id: "topbar-export", actionId: "export-obsidian", location: "top-bar", sessions: ["teaching", "practice"] });

  // 会话顶栏：结算本次学习（AI 读整段对话，按考点更新预测分）
  ctx.registerAction({
    id: "settle-study",
    name: "结算本次学习",
    icon: icon("M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"),
    run: (context) => {
      if (context.surface !== "session") return;
      openSettleDialog(ctx, context.sessionId);
    },
  });
  ctx.placeAction({ id: "topbar-settle", actionId: "settle-study", location: "top-bar", sessions: ["teaching", "practice"] });

  // 学习模式讲完（生成问题清单）后，等这一轮结束再弹出导出询问
  const pending = new Set();
  ctx.onNotification((n) => { if (n.topic === "study-report" && n.data?.chatId) pending.add(n.data.chatId); });
  ctx.onAppEvent(async (e) => {
    if (e.type !== "turn-settled" || !pending.has(e.chatId)) return;
    pending.delete(e.chatId);
    try {
      const r = await ctx.call("export.shouldPrompt", { chatId: e.chatId });
      if (r.prompt) openExportDialog(ctx, e.chatId, { auto: true });
    } catch { /* 忽略 */ }
  });

  // 设置页
  ctx.registerSettings((container, signal) => {
    const root = el("div", "ky-root ky-settings");
    put(container, root);
    ctx.call("settings.get").then(({ settings: s }) => {
      if (signal.aborted) return;
      const vault = el("input", { class: "ky-input", value: s.vaultPath || "", placeholder: "例如 ~/Documents/考研（Obsidian 仓库根目录）" });
      const papers = el("input", { class: "ky-input", value: s.papersPath || "", placeholder: "可选：放 manifest.json 的真题文件夹" });
      const exam = el("input", { class: "ky-input", type: "date", value: s.examDate });
      const study = el("input", { type: "checkbox", checked: s.studyMode });
      const ask = el("input", { type: "checkbox", checked: s.autoExportPrompt });
      const momo = el("input", { class: "ky-input", type: "password", value: "", placeholder: s.momoTokenSet ? `${s.momoTokenHint}，留空不修改` : "墨墨开放 API token（墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API）", autocomplete: "off" });
      const momoOut = el("div");
      const out = el("div");
      const picks = el("div", "ky-row");
      const conn = el("div");
      const testConn = async () => {
        try {
          const r = await ctx.call("vault.test", { vaultPath: vault.value, papersPath: papers.value });
          const lack = [["计划/", r.plans], ["笔记规范/笔记格式规范.md", r.spec]].filter(([, ok]) => !ok).map(([n]) => n);
          reset(conn,
            el("div", "ky-ok", `✓ 已连接 ${r.root}：${r.md} 篇笔记${r.isObsidian ? "" : "（没找到 .obsidian，确认这是仓库根目录）"}`),
            el("div", "ky-muted", `科目文件夹：${(r.subjects || []).join("、") || "还没有"}（导出笔记写到 <科目>/<课程>/ 下，没有会自动创建）。`),
            lack.length ? el("div", "ky-muted", `仓库里还没有 ${lack.join("、")}：今日面板读 计划/ 里的周计划；没有笔记规范时导出用插件内置的简版格式。`) : null,
            r.papers ? el("div", r.papers.ok ? "ky-ok" : "ky-error", r.papers.ok ? `✓ 真题文件夹：manifest.json 列了 ${r.papers.items} 份文件` : r.papers.exists ? "真题文件夹里没有可读的 manifest.json" : "真题文件夹不存在") : null);
        } catch (err) { reset(conn, errorBox(err)); }
      };
      const detect = async () => {
        try {
          const { vaults } = await ctx.call("vault.detect");
          if (!vaults.length) { reset(picks, el("span", "ky-muted", "没检测到 Obsidian 仓库记录，请手动填写路径。")); return; }
          reset(picks, el("span", "ky-muted", "检测到："),
            ...vaults.filter((v) => v.exists).map((v) => btn(v.name + (v.open ? "（打开中）" : ""), () => { vault.value = v.path; testConn(); }, "ky-btn ky-btn-ghost")));
        } catch (err) { reset(picks, errorBox(err)); }
      };
      const promptBox = el("div");
      const showPrompt = async () => {
        try {
          const { prompt } = await ctx.call("setup.prompt");
          const ta = el("textarea", { class: "ky-input ky-ta-lg", readonly: true, rows: 14 });
          ta.value = prompt;
          const copy = async () => {
            try { await navigator.clipboard.writeText(prompt); }
            catch { ta.focus(); ta.select(); document.execCommand("copy"); }
            toast(root, "已复制，粘贴给 Claude Code 等能操作本机文件的 agent 即可");
          };
          reset(promptBox,
            el("p", "ky-hint", "把下面的提示词复制给能读写本机文件的 AI agent（如 Claude Code）。它会在这台电脑上找到或新建 Obsidian 考研仓库和真题文件夹，会先问你考哪些科目，再按统一格式建好 计划 / 科目 / 真题 等文件夹，最后写好插件设置。提示词不含任何本机信息，换电脑也能用；动手前它会先跟你确认位置，并让你退出 LearnHarness。"),
            ta,
            el("div", "ky-row", btn("复制提示词", copy, "ky-btn ky-btn-primary"), btn("收起", () => reset(promptBox), "ky-btn ky-btn-ghost")));
          ta.focus(); ta.select();
        } catch (err) { reset(promptBox, errorBox(err)); }
      };
      const hostBox = el("div", "ky-card");
      const renderHost = (st) => {
        const stale = st.items.filter((x) => x.hostChanged);
        const edited = st.items.filter((x) => x.edited);
        reset(hostBox,
          el("div", "ky-row", el("strong", null, "考研版宿主提示词"), el("span", st.active ? "ky-ok" : "ky-muted", st.active ? "✓ 已应用" : st.applied ? "部分生效（可能有开关被关掉了）" : "未应用（用的是宿主原版）")),
          el("p", "ky-hint", "LearnHarness 自带的教学方法是「从最底层的道理一步步推」，出题偏向找理解漏洞，不太贴考研。应用后会用宿主自带的「提示词覆盖」功能替换下面几段（不改 app 本身，宿主更新也不会被冲掉）；你原来的覆盖文件和开关会先备份，点「恢复原版」原样还原。新开的会话生效。"),
          el("ul", "ky-list", ...st.items.map((x) => el("li", null, `${x.title}`, el("span", "ky-muted", `　${x.key}${x.installed && x.on ? " ✓" : x.installed ? "（开关关着）" : ""}`)))),
          stale.length ? el("div", "ky-error", `宿主更新了 ${stale.map((x) => x.key).join("、")} 的原版内容，考研版可能需要跟着更新。`) : null,
          edited.length ? el("div", "ky-muted", `${edited.map((x) => x.key).join("、")} 在设置 → 提示词里被改过；再点「应用」会换回考研版。`) : null,
          el("div", "ky-row",
            btn(st.active ? "重新应用" : "应用考研版宿主提示词", async () => {
              try { renderHost(await ctx.call("hostPrompts.apply")); toast(root, "已应用，新开的会话生效"); } catch (err) { toast(root, err.message, "error"); }
            }, "ky-btn ky-btn-primary"),
            st.applied ? btn("恢复原版", async () => {
              try { renderHost(await ctx.call("hostPrompts.revert")); toast(root, "已恢复宿主原版提示词"); } catch (err) { toast(root, err.message, "error"); }
            }, "ky-btn ky-btn-ghost") : null));
      };
      ctx.call("hostPrompts.status").then(renderHost, (err) => reset(hostBox, errorBox(err)));
      put(root, 
        field("Obsidian 考研仓库路径", vault, "导出笔记、读取周计划、讲课检索都用这个仓库；填仓库根目录（含 .obsidian 的那层），支持 ~ 开头"),
        el("div", "ky-row", btn("自动检测 Obsidian 仓库", detect, "ky-btn ky-btn-ghost"), btn("测试连接", testConn, "ky-btn ky-btn-ghost"), btn("AI 自动配置连接", showPrompt, "ky-btn ky-btn-ghost")),
        picks, conn, promptBox,
        field("真题文件夹（可选）", papers, "题库「批量导入」和英语专项导入用；里面放 manifest.json，英语一在子文件夹 英语一/"),
        field("初试日期", exam, "用于倒计时，2027 年考试时间公布后改成准确日期"),
        field("墨墨背单词 token（分数判断机的词汇分）", momo, "只保存在本机插件数据里，只发给墨墨自己的服务器；学习数据接口要在墨墨 App 里开启自动同步"),
        el("div", "ky-row", btn("测试墨墨连接", async () => {
          try { const r = await ctx.call("momo.test", { token: momo.value }); reset(momoOut, el("div", "ky-ok", `✓ 连上了：${r.count} 个词有学习记录`)); }
          catch (err) { reset(momoOut, errorBox(err)); }
        }, "ky-btn ky-btn-ghost")), momoOut,
        el("label", "ky-check", study, " 启用学习模式（会话首句以【学习】开头时生效；改动后需重启 LearnHarness）"),
        el("label", "ky-check", ask, " 学习模式讲完后询问是否导出到 Obsidian"),
        el("div", "ky-row",
          btn("保存", async () => {
            try {
              await ctx.call("settings.save", { vaultPath: vault.value, papersPath: papers.value, examDate: exam.value, studyMode: study.checked, autoExportPrompt: ask.checked, ...(momo.value.trim() ? { momoToken: momo.value.trim() } : {}) });
              toast(root, "已保存");
              testConn();
            } catch (err) { toast(root, err.message, "error"); }
          }, "ky-btn ky-btn-primary"),
          btn("测试视觉模型", async () => {
            try {
              const r = await runJob(ctx, out, () => ctx.call("vision.test"), "测试");
              reset(out, el("div", "ky-ok", `${r.model.provider}/${r.model.id} 能接收图片，回复：${r.reply}`));
            } catch (err) { reset(out, errorBox(err)); }
          })),
        out,
        hostBox,
        el("p", "ky-hint", "模型：普通任务用「强」槽，生词释义用「便宜」槽，照片 / OCR 用「视觉」槽（设置 → 模型）。"));
    }, (err) => put(root, errorBox(err)));
    return () => reset(container);
  });
}
