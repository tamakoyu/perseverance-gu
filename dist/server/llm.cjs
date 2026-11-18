"use strict";
const { fail } = require("./util.cjs");

const RETRY_DELAYS = [5000, 20000, 60000];
/** 网络抖动、超时、限流、服务端 5xx：等一会儿重试就可能好。 */
function transient(err) {
  return /timed? ?out|timeout|terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|network|fetch failed|other side closed|\b(429|500|502|503|504)\b|overloaded|rate.?limit|Throttling|too many requests/i.test(String(err?.message || err));
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(new Error("已取消")); }, { once: true });
  });
}

/** 封装宿主模型调用：选槽位、发文本+图片、取文本 / 解析 JSON。 */
function createLlm(ctx, getSettings) {
  async function resolve(slotName) {
    const catalog = await ctx.inference.catalog();
    const settings = getSettings();
    const override = settings.models?.[slotName];
    const pin = override?.provider ? { model: override } : catalog.slots?.[slotName] || catalog.slots?.strong;
    if (!pin?.model) fail(`请先在 设置 → 模型 里配置「${slotName}」模型槽`);
    const entry = (catalog.models || []).find((m) => m.provider === pin.model.provider && m.id === pin.model.id);
    if (!entry) fail(`模型 ${pin.model.provider}/${pin.model.id} 当前不可用`);
    const level = pin.thinkingLevel;
    const ok = level && (!entry.supportedLevels || entry.supportedLevels.includes(level));
    return { ...pin.model, ...(ok ? { thinkingLevel: level } : {}) };
  }

  function textOf(message, opts = {}) {
    if (!message) return "";
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      fail(`模型调用失败：${message.errorMessage || message.stopReason}`);
    }
    const text = (message.content || []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
    if (text || !opts.allowThinking) return text;
    // 有的模型把 JSON 答案放进了思考内容里、正文为空（只用于 JSON 场景，转写不用）
    return (message.content || []).filter((p) => p.type === "thinking").map((p) => p.thinking || p.text || "").join("").trim();
  }

  /** images: [{data(base64), mimeType}] */
  /** 指定具体模型（如插件设置里的 OCR 模型），并确认它在目录里可用。 */
  async function resolveExact(spec) {
    const catalog = await ctx.inference.catalog();
    const entry = (catalog.models || []).find((m) => m.provider === spec.provider && m.id === spec.id);
    if (!entry) fail(`模型 ${spec.provider}/${spec.id} 当前不可用，请在考研工具箱设置里重新选择 OCR 模型`);
    return { provider: spec.provider, id: spec.id };
  }

  async function complete({ system, text, images = [], slot = "strong", maxTokens = 8000, purpose = "user", signal, model: forced, withMeta = false, allowThinking = false }) {
    const model = forced?.provider ? await resolveExact(forced) : await resolve(images.length ? "vision" : slot);
    const content = [{ type: "text", text }];
    for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType || "image/jpeg" });
    // 长输出（拆题时一段 15–20k token）在接口繁忙时 5 分钟不够，按输出上限放宽超时
    const timeoutMs = Math.min(1_200_000, Math.max(300_000, maxTokens * 40));
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(RETRY_DELAYS[attempt - 1], signal);
      try {
        const message = await ctx.inference.complete({
          model,
          purpose,
          context: { systemPrompt: system, messages: [{ role: "user", content, timestamp: Date.now() }] },
          options: { maxTokens, timeoutMs, maxRetries: 1 },
          signal,
        });
        const out = textOf(message, { allowThinking });
        if (withMeta) return { text: out, stopReason: message?.stopReason };
        return out;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted || !transient(err)) throw err;
      }
    }
    throw new Error(`${lastErr.message}（已自动重试 3 次）`);
  }

  function body(raw) {
    let s = String(raw || "").trim();
    // 只剥最外层的代码块标记；JSON 字符串里自带的 ```（比如 408 的 C 代码）不能当成外壳
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*(```\s*)?$/);
    if (fence) s = fence[1].trim();
    const start = s.search(/[[{]/);
    if (start < 0) throw new Error(s ? `输出里没有 JSON：${s.slice(0, 80)}` : "模型返回了空内容");
    return s.slice(start);
  }

  function strictParse(raw) {
    let s = body(raw);
    const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (end >= 0) s = s.slice(0, end + 1);
    return JSON.parse(s);
  }

  /** 修复常见问题：LaTeX 反斜杠没转义、输出被截断（只保留完整的对象）。 */
  function lenientParse(raw) {
    let s = body(raw).replace(/(^|[^\\])\\(?=[A-Za-z]{2,})/g, "$1\\\\").replace(/(^|[^\\])\\(?=[^"\\/bfnrtuA-Za-z])/g, "$1\\\\");
    try { return JSON.parse(s.slice(0, Math.max(s.lastIndexOf("}"), s.lastIndexOf("]")) + 1)); } catch { /* 继续抢救 */ }
    // 截断：逐个扫描数组里完整的 {...}
    const out = {};
    for (const key of ["questions", "answers", "items", "notes"]) {
      const at = s.indexOf(`"${key}"`);
      if (at < 0) continue;
      const open = s.indexOf("[", at);
      if (open < 0) continue;
      const objs = [];
      let depth = 0, inStr = false, esc = false, from = -1;
      for (let i = open + 1; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{") { if (depth++ === 0) from = i; }
        else if (c === "}") { if (--depth === 0 && from >= 0) { try { objs.push(JSON.parse(s.slice(from, i + 1))); } catch { /* 跳过坏对象 */ } from = -1; } }
        else if (c === "]" && depth === 0) break;
      }
      if (objs.length) out[key] = objs;
    }
    if (Object.keys(out).length) return { ...out, salvaged: true };
    throw new Error("JSON 无法解析也无法修复");
  }

  function parseJson(raw) {
    try { return strictParse(raw); } catch { return lenientParse(raw); }
  }

  /** 要求模型只输出 JSON；解析失败带错误提示重试，最多 3 次。 */
  async function json(opts) {
    const system = `${opts.system}\n\n只输出一个合法 JSON，不要任何额外文字或代码块标记。字符串里的反斜杠（如 LaTeX 的 \\frac）必须写成 \\\\。内容很多时保持简洁，确保 JSON 完整闭合。`;
    let lastErr;
    let text = opts.text;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await complete({ ...opts, system, text, allowThinking: true });
      try { return parseJson(raw); } catch (err) {
        lastErr = err;
        text = `${opts.text}\n\n（上一次输出有问题：${err.message}。请重新只输出合法、完整的 JSON；如果页面内容太多，analysis 可以写得更简短。）`;
      }
    }
    throw lastErr;
  }

  async function catalogModels() {
    const catalog = await ctx.inference.catalog();
    return (catalog.models || []).map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id, image: Array.isArray(m.input) ? m.input.includes("image") : undefined }));
  }

  return { resolve, complete, json, catalogModels };
}

module.exports = { createLlm };
