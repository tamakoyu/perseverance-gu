// 分数判断机的小部件：会话顶栏「结算本次学习」浮窗、成绩单里的「对预测分的影响」。
// 星空页本身在 sky3d.js（3D）。
import { reset, el, btn, errorBox, waitJob } from "./ui.js";

const f1 = (x) => (Math.round((x || 0) * 10) / 10).toFixed(1);
const KIND_LABEL = { taught: "讲解", practice: "练习", real: "真题" };

// ── 会话顶栏「结算本次学习」 ───────────────────────────────
let settleBox = null;
export async function openSettleDialog(ctx, chatId) {
  settleBox?.remove();
  const body = el("div", "ky-settle-body", el("p", "ky-muted", "AI 正在读这次的对话，评估各考点的掌握程度…"));
  const box = el("div", "ky-settle",
    el("div", "ky-settle-head", el("b", null, "结算本次学习"), el("button", { type: "button", class: "ky-sky-x", "aria-label": "关闭", onclick: () => box.remove() }, "×")),
    body);
  settleBox = box;
  document.body.append(box);
  try {
    const job = await ctx.call("score.settle", { chatId });
    const r = await waitJob(ctx, job, (j) => { if (j.message) reset(body, el("p", "ky-muted", `${j.message}…`)); });
    const imp = r.impact;
    reset(body,
      el("div", "ky-settle-total", el("span", null, "预测分"), el("b", null, `${f1(imp.before)} → ${f1(imp.after)}`), el("em", imp.delta >= 0 ? "ky-up" : "ky-down", `${imp.delta >= 0 ? "+" : ""}${f1(imp.delta)}`)),
      r.summary ? el("p", "ky-settle-sum", r.summary) : null,
      r.items.length ? el("div", "ky-settle-list", ...r.items.map((x) => {
        const d = imp.items.find((i) => i.id === x.leaf);
        return el("div", "ky-settle-row",
          el("span", "ky-settle-name", x.name, el("small", null, `${x.subject} · ${x.chapter}`)),
          el("span", `ky-sky-kind ky-k-${x.kind}`, `${KIND_LABEL[x.kind]}·${x.result}`),
          el("b", (d?.delta || 0) >= 0 ? "ky-up" : "ky-down", d ? `${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(2)}` : "±0"));
      })) : el("p", "ky-muted", "这次会话里没找到讲过或练过的考点。"),
      el("div", "ky-row", btn("打开拾星", () => { box.remove(); ctx.app.openView("score"); }, "ky-btn ky-btn-primary"), btn("关闭", () => box.remove())));
  } catch (err) {
    reset(body, errorBox(err));
  }
}

/** 成绩单里的「对预测分的影响」。 */
export function impactCard(ctx, impact) {
  if (!impact) return null;
  const rows = impact.items.slice(0, 8);
  return el("div", "ky-impact",
    el("div", "ky-impact-head", el("span", null, "预测分"), el("b", null, `${f1(impact.before)} → ${f1(impact.after)}`), el("b", impact.delta >= 0 ? "ky-up" : "ky-down", `${impact.delta >= 0 ? "+" : ""}${f1(impact.delta)}`)),
    rows.length ? el("div", null, ...rows.map((x) => el("div", "ky-impact-row",
      el("span", null, x.name, " ", el("small", null, `${x.subject} · ${x.chapter}`)),
      el("b", x.delta >= 0 ? "ky-up" : "ky-down", `${x.delta >= 0 ? "+" : ""}${x.delta.toFixed(2)}`)))) : el("div", "ky-muted", "这次的题没有归到考点上，预测分没变。"),
    impact.items.length > rows.length ? el("div", "ky-muted", `还有 ${impact.items.length - rows.length} 个考点有变化`) : null,
    el("div", "ky-row", btn("打开拾星", () => ctx.app.openView("score"))));
}
