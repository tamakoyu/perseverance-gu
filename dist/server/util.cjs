"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fail(message) { throw new Error(message); }
function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 版本化 JSON 存储：{version:1, items:[...]}，或 {version:1, value:{...}}。 */
class Store {
  constructor(dir) { this.dir = dir; this.cache = new Map(); }
  file(name) { return path.join(this.dir, `${name}.json`); }
  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file(name), "utf8"));
      if (data.version > 1) fail(`${name}.json 是更新版本的格式，拒绝改写`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      data = { version: 1, ...fallback };
    }
    this.cache.set(name, data);
    return data;
  }
  write(name, data) {
    data.version = 1;
    atomicWrite(this.file(name), JSON.stringify(data, null, 1));
    this.cache.set(name, data);
  }
  list(name) { return this.read(name, { items: [] }).items; }
  saveList(name, items) { this.write(name, { items }); }
  value(name, defaults) { return { ...defaults, ...(this.read(name, { value: {} }).value || {}) }; }
  saveValue(name, value) { this.write(name, { value }); }
  update(name, id, patch) {
    const items = this.list(name);
    const hit = items.find((x) => x.id === id);
    if (!hit) fail("找不到这条记录");
    Object.assign(hit, typeof patch === "function" ? patch(hit) || {} : patch);
    this.saveList(name, items);
    return hit;
  }
  remove(name, id) {
    const items = this.list(name);
    const next = items.filter((x) => x.id !== id);
    if (next.length === items.length) fail("找不到这条记录");
    this.saveList(name, next);
  }
}

function str(v, max = 20000) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") fail("参数必须是文本");
  return v.length > max ? v.slice(0, max) : v;
}
function obj(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("参数必须是对象");
  return v;
}

module.exports = { fail, uid, nowIso, today, atomicWrite, Store, str, obj };
