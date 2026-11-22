"use strict";
const { exactPoints, byId, validPointIds } = require("./knowledge.cjs");

// 逐题核过的例子按卷种、年份、题号定位，重新导入也能复用。
const VERIFIED = new Map([
  ["数学/2018/9", { tested: ["幂指型极限"], methods: ["等价无穷小替换"] }],
  ["数学/2023/11", { tested: ["加减抵消与主项匹配"], methods: ["一元泰勒公式与余项"] }],
  ["数学/2024/11", { tested: ["幂指型极限", "等价无穷小替换"] }],
  ["数学/2025/11", { tested: ["幂指型极限", "等价无穷小替换"] }],
  ["408/2011/47", { tested: ["以太网与802.3", "ARP", "HTTP及连接方式", "IPv4地址与NAT", "路由器与路由表转发"] }],
  ["408/2013/15", { tested: ["海明码"] }],
  ["408/2017/31", { tested: ["硬链接与软链接", "文件打开与文件描述符"] }],
  ["408/2018/28", { tested: ["管程与条件变量"] }],
  ["408/2026/19", { tested: ["组原的TLB与访存", "组原页表与地址转换"] }],
  ["408/2026/28", { tested: ["多级页表"] }],
]);

function questionKnowledge(q, classifications = {}) {
  const real = !["习题", "AI生成"].includes(q.source);
  const verified = real && VERIFIED.get(`${q.subject}/${q.year}/${q.number}`);
  const ids = (names) => exactPoints(q.subject, names).map((point) => point.id);
  if (verified) return { tested: ids(verified.tested), methods: ids(verified.methods), status: "已核对" };
  const classified = classifications[q.id];
  const tested = validPointIds(classified?.tested, q.subject);
  if (tested.length) {
    return { tested, methods: validPointIds(classified.methods, q.subject).filter((id) => !tested.includes(id)), status: "AI归类" };
  }
  // AI 看过但判断没有可归的知识点（如纯计算练习、超纲题）：不再排进待归类
  if (classified?.empty) return { tested: [], methods: [], suggested: ids(q.topics), status: "无可归类" };
  // 原标签可以用于检索候选。标签本身无法判定该项是否确实被考到。
  return { tested: [], methods: [], suggested: ids(q.topics), status: "待核对" };
}

function weights(ids) {
  const counts = new Map();
  for (const id of ids) {
    const leaf = byId.get(id)?.leaf;
    if (leaf) counts.set(leaf, (counts.get(leaf) || 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, w: count / ids.length }));
}

module.exports = { questionKnowledge, weights };
