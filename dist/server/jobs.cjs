"use strict";
// 长任务（OCR 导入、批改）：立即返回任务号，进度通过插件通知推给前端。
const { uid, nowIso } = require("./util.cjs");

function createJobs(ctx) {
  const jobs = new Map();
  const emit = (job) => { try { ctx.events.emit("job", publicJob(job)); } catch { /* 前端不在也没关系 */ } };
  const publicJob = (j) => ({ id: j.id, kind: j.kind, label: j.label, status: j.status, done: j.done, total: j.total, message: j.message, result: j.result, error: j.error, startedAt: j.startedAt });

  function start(kind, label, fn) {
    const job = { id: uid(), kind, label, status: "running", done: 0, total: 0, message: "开始…", startedAt: nowIso(), abort: new AbortController() };
    jobs.set(job.id, job);
    const progress = (done, total, message) => {
      Object.assign(job, { done, total, ...(message ? { message } : {}) });
      emit(job);
    };
    Promise.resolve().then(() => fn({ progress, signal: job.abort.signal })).then((result) => {
      Object.assign(job, { status: "succeeded", result, message: "完成" });
      emit(job);
    }, (err) => {
      Object.assign(job, { status: job.abort.signal.aborted ? "cancelled" : "failed", error: err?.message || String(err) });
      emit(job);
    });
    emit(job);
    return publicJob(job);
  }

  ctx.cleanup(() => { for (const j of jobs.values()) j.abort.abort(); });

  return {
    start,
    get: (id) => { const j = jobs.get(id); return j ? publicJob(j) : null; },
    list: () => [...jobs.values()].map(publicJob).reverse().slice(0, 20),
    cancel: (id) => { const j = jobs.get(id); if (j) j.abort.abort(); return { ok: !!j }; },
  };
}

module.exports = { createJobs };
