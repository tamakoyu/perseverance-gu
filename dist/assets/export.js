// 导出到 Obsidian：选原子笔记 / 普通笔记 / 不导出，预览、改文件夹和内容后写入仓库。
import { put, reset, el, btn, md, errorBox, runJob } from "./ui.js";

export function openExportDialog(ctx, chatId, { auto = false } = {}) {
  const ctl = new AbortController();
  const signal = ctl.signal;
  const body = el("div");
  let folders = [];
  ctx.call("vault.folders").then((f) => { folders = f; }, () => {});

  const choose = () => {
    reset(body, 
      el("p", "ky-muted", auto ? "这次学习模式已经讲完。要把这个知识点整理成笔记放进 Obsidian 吗？" : "把这次会话讲过、考过的内容整理成笔记放进 Obsidian。"),
      el("div", "ky-choice-grid",
        choiceCard("原子笔记", "一页一个概念，放 concepts/<科目>/<课程>/，适合双链和复习", () => generate("atomic")),
        choiceCard("普通笔记", "一篇完整梳理（导航、例题、做题步骤、易错辨析），放 笔记/<科目>/<课程>/<主题>/", () => generate("normal")),
        choiceCard("不导出", "这次先不整理", async () => {
          await ctx.call("export.dismiss", { chatId }).catch(() => {});
          handle.dispose();
        })));
  };

  function choiceCard(title, desc, onclick) {
    return el("button", { type: "button", class: "ky-choice", onclick }, el("b", null, title), el("span", "ky-muted", desc));
  }

  async function generate(mode) {
    const status = el("div");
    reset(body, status);
    try {
      const draft = await runJob(ctx, status, () => ctx.call("export.draft", { chatId, mode }), mode === "atomic" ? "生成原子笔记" : "生成普通笔记");
      review(draft);
    } catch (err) {
      reset(body, errorBox(err), el("div", "ky-row", btn("返回", choose), btn("关闭", () => handle.dispose(), "ky-btn ky-btn-ghost")));
    }
  }

  function review(draft) {
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
        reset(body, el("div", "ky-ok", `✓ 已写入 Obsidian：`), el("ul", "ky-ul", ...r.results.map((x) => el("li", null, x.path))), btn("完成", () => handle.dispose(), "ky-btn ky-btn-primary"));
      } catch (err) { reset(msg, errorBox(err)); }
    };
    reset(body, list,
      el("div", "ky-muted", `科目：${draft.subject || "?"} · 课程：${draft.course || "?"} · 主题：${draft.topic || "?"} · 共 ${draft.notes.length} 篇。文件夹、名字、内容都可以改，不想要的取消勾选。`),
      ...rows.map((r) => r.box),
      msg,
      el("div", "ky-row", btn("写入 Obsidian", () => save(), "ky-btn ky-btn-primary"), btn("重新选择", choose), btn("取消", () => handle.dispose(), "ky-btn ky-btn-ghost")));
  }

  const handle = ctx.ui.openDialog({
    title: "导出到 Obsidian",
    content: el("div", "ky-dialog ky-dialog-wide", el("h3", "ky-h3", "导出到 Obsidian"), body),
    onClose: () => ctl.abort(),
  }, { signal });
  choose();
  return handle;
}
