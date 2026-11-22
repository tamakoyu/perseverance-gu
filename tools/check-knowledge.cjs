"use strict";
// 校验知识点目录与大纲对应：node tools/check-knowledge.cjs
const { points } = require("../dist/server/knowledge.cjs");
const { outlineItems, extensions } = require("../dist/server/outline.cjs");
const { leaves } = require("../dist/server/syllabus.cjs");

let bad = 0;
const fail = (msg) => { bad++; console.log(`✗ ${msg}`); };
const names = new Map();
for (const p of points) {
  const key = `${p.subject}|${p.name}`;
  if (names.has(key)) fail(`重名知识点：${key}（${names.get(key)} 与 ${p.leaf}）`);
  names.set(key, p.leaf);
  if (!p.name || /[,|]/.test(p.name)) fail(`知识点名不合法：${p.id}`);
}
for (const item of outlineItems) {
  if (!item.points.length) fail(`大纲条目没有对应知识点：${item.subject} ${item.item}`);
  for (const m of item.missing) fail(`大纲条目引用了不存在的知识点：${item.subject} ${item.item} → ${m}`);
}
for (const l of leaves().filter((x) => ["数学", "408"].includes(x.subject))) {
  if (!points.some((p) => p.leaf === [l.subject, ...l.path, l.name].join("/"))) fail(`计分考点没有知识点：${l.id}`);
}
for (const s of ["数学", "408"]) {
  const its = outlineItems.filter((i) => i.subject === s);
  const ext = extensions.filter((p) => p.subject === s);
  console.log(`${s}：知识点 ${points.filter((p) => p.subject === s).length}，大纲条目 ${its.length}（待核 ${its.filter((i) => i.pending).length}），延伸方法项 ${ext.length}`);
  console.log(`  延伸：${ext.map((p) => p.name).join("、")}`);
}
console.log(bad ? `共 ${bad} 处问题` : "✓ 全部大纲条目都有对应知识点，知识点无重名");
process.exit(bad ? 1 : 0);
