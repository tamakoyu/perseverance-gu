"use strict";
// 「考研版宿主提示词」：用宿主自带的提示词覆盖机制（data/prompts/<片段> + settings.json 的 agent.prompts 开关）
// 替换宿主里和考研冲突的几段教学规则。不改 app 本身，宿主更新也不会被冲掉。
// 应用前备份学习者原来的覆盖文件和开关，「恢复原版」时原样还原。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fail } = require("./util.cjs");

const SRC = path.join(__dirname, "hostprompts");
const SEGMENTS = [
  { key: "system-prompt.md", title: "总纲：理解 + 考场得分，只在考试会考的内容里找薄弱点" },
  { key: "shared/20-question-tools.md", title: "出题工具：选择题模式下计算 / 填空 / 解答题怎么出，一次一题不停顿" },
  { key: "prober/10-probe-doctrine.md", title: "测底：只测高频考点、优先用真题、答错当场讲" },
  { key: "teacher/05-method.md", title: "教学方法：考纲定义 → 讲清为什么 → 落到题型" },
  { key: "teacher/10-planning.md", title: "规划：按考点频率和掌握度排节点" },
  { key: "teacher/20-teaching.md", title: "讲课：答错时讲正确答案、错因和一步一行的解法" },
  { key: "teacher/28-predictions.md", title: "预测题：只在学新方法前用，复习会话不用" },
  { key: "teacher/30-question-principles.md", title: "检查题：要有真题 / 习题原型，不出偏题" },
  { key: "practice/10-doctrine.md", title: "练习：按分值选题，两轮提示后完整讲解" },
];
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

function createHostPrompts({ ctx, store }) {
  /** 宿主数据目录：插件数据在 <数据目录>/plugins/<id>/data。 */
  function hostDir() {
    const guess = process.env.LH_DATA_DIR || path.resolve(ctx.dataDirectory, "..", "..", "..");
    if (!fs.existsSync(path.join(guess, "settings.json")) && !fs.existsSync(path.join(guess, "chats"))) fail(`找不到 LearnHarness 数据目录（猜的是 ${guess}）`);
    return guess;
  }
  const settingsFile = () => path.join(hostDir(), "settings.json");
  const promptFile = (key) => path.join(hostDir(), "prompts", ...key.split("/"));
  const ours = (key) => fs.readFileSync(path.join(SRC, ...key.split("/")), "utf8");
  const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

  function readSettings() {
    const raw = readText(settingsFile());
    if (raw == null) return { version: 1 };
    try { return JSON.parse(raw); } catch { fail("宿主的 settings.json 读不了（格式不对），没有改动"); }
  }
  function writeSettings(obj) {
    const f = settingsFile();
    const tmp = `${f}.kaoyan-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, "\t") + "\n");
    fs.renameSync(tmp, f);
  }
  function writeAtomic(f, text) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.kaoyan-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
  }

  /** 宿主自带的原版片段（用来提示「宿主更新了原版」）；找不到就不比较。 */
  function hostSource(key) {
    for (const base of [process.cwd(), path.resolve(__dirname, "..", "..", "..", "..")]) {
      // system-prompt.md 在 src/agent/ 下，其余片段在 src/agent/prompts/ 下
      const t = readText(key === "system-prompt.md" ? path.join(base, "src", "agent", key) : path.join(base, "src", "agent", "prompts", ...key.split("/")));
      if (t != null) return t;
    }
    return null;
  }

  function status() {
    const sw = readSettings().agent?.prompts || {};
    const meta = store.value("hostPrompts", { applied: false, backups: {}, sourceHash: {} });
    const items = SEGMENTS.map((s) => {
      const cur = readText(promptFile(s.key));
      const installed = cur != null && cur === ours(s.key);
      const src = hostSource(s.key);
      return {
        key: s.key, title: s.title,
        installed, edited: meta.applied && cur != null && !installed,
        on: sw[s.key] === true,
        hostChanged: !!(meta.sourceHash?.[s.key] && src != null && sha(src) !== meta.sourceHash[s.key]),
      };
    });
    const active = items.every((x) => x.installed && x.on);
    return { applied: !!meta.applied, active, items, dir: (() => { try { return hostDir(); } catch { return null; } })() };
  }

  function apply() {
    const settings = readSettings();
    settings.agent = settings.agent || {};
    settings.agent.prompts = settings.agent.prompts || {};
    const meta = store.value("hostPrompts", { applied: false, backups: {}, sourceHash: {} });
    meta.backups = meta.backups || {};
    meta.sourceHash = meta.sourceHash || {};
    for (const s of SEGMENTS) {
      const f = promptFile(s.key);
      const text = ours(s.key);
      // 只在第一次应用时备份学习者原来的文件和开关；重复应用（插件更新后）沿用这份备份
      if (!meta.applied || !meta.backups[s.key]) {
        const cur = readText(f);
        meta.backups[s.key] = { hadFile: cur != null, text: cur, wasOn: settings.agent.prompts[s.key] };
      }
      writeAtomic(f, text);
      const src = hostSource(s.key);
      if (src != null) meta.sourceHash[s.key] = sha(src);
      settings.agent.prompts[s.key] = true;
    }
    writeSettings(settings);
    meta.applied = true;
    meta.at = new Date().toISOString();
    store.saveValue("hostPrompts", meta);
    return status();
  }

  function revert() {
    const meta = store.value("hostPrompts", { applied: false, backups: {} });
    if (!meta.applied) return status();
    const settings = readSettings();
    settings.agent = settings.agent || {};
    settings.agent.prompts = settings.agent.prompts || {};
    for (const s of SEGMENTS) {
      const b = meta.backups?.[s.key];
      const f = promptFile(s.key);
      if (b?.hadFile && b.text != null) writeAtomic(f, b.text);
      else { try { fs.unlinkSync(f); } catch { /* 本来就没有 */ } }
      if (b && b.wasOn !== undefined) settings.agent.prompts[s.key] = b.wasOn;
      else delete settings.agent.prompts[s.key];
    }
    writeSettings(settings);
    store.saveValue("hostPrompts", { applied: false, backups: {}, sourceHash: {} });
    return status();
  }

  return { status, apply, revert, SEGMENTS };
}

module.exports = { createHostPrompts };
