"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { uid, nowIso } = require("./util.cjs");

const CHOICE_FIXES = [
  {
    paper: "张宇1000题·强化篇·高数 第1章 函数极限与连续", number: "33",
    old: String.raw`$b=1,\ c=\frac{1}{2}$`,
    extra: "由 $a=f(0)=1$，三个系数依次为 $1,1,1/2$，选 B。",
  },
  {
    paper: "张宇1000题·强化篇·高数 第5章 一元函数微分学的应用（一）几何应用", number: "15",
    old: "$y=5x-8$",
    extra: String.raw`当 $x\to0^-$ 时，$(5x-3)e^{-1/x}\to-\infty$，所以 $x=0$ 也是渐近线。两条渐近线合起来对应 B。`,
  },
  {
    paper: "张宇1000题·综合篇 测试卷三", number: "9",
    old: String.raw`$E(Y_1)=\frac{4}{3}$，$E(Y_2)=0$`,
    extra: "两个结果对应 B。",
  },
];

function repairChoiceKeys(store) {
  const items = store.list("bank");
  let count = 0;
  for (const fix of CHOICE_FIXES) {
    const q = items.find((q) => q.source === "习题" && q.subject === "数学" && q.paper === fix.paper &&
      q.number === fix.number && q.type === "单选" && q.answer === fix.old && q.options.some((o) => o.key === "B"));
    if (!q) continue;
    q.answer = "B";
    q.answerSource = "手动";
    q.analysis = [q.analysis, fix.extra].filter(Boolean).join("\n\n");
    q.analysisSource = "手动";
    count++;
  }
  if (count) store.saveList("bank", items);
  return count;
}

const PAPER = "2011 408";
const needsQuestion = (items) => {
  const paper = items.filter((q) => q.subject === "408" && q.paper === PAPER && q.source === "真题");
  return paper.length === 46 && new Set(paper.map((q) => q.number)).size === 46 &&
    paper.every((q) => /^\d+$/.test(q.number) && q.number >= 1 && q.number <= 46);
};

async function restore2011Question({ store, pdf, images, folder, signal }) {
  if (!folder || !needsQuestion(store.list("bank"))) return false;
  const source = path.join(folder, "408", "题目", "2011-408-真题.pdf");
  if (!fs.existsSync(source)) return false;
  const buffer = fs.readFileSync(source);
  // 裁切坐标仅适用于核过版面的这一版本。
  if (createHash("sha256").update(buffer).digest("hex") !== "289f78e478acf1660cba8d717ca62e8a5432dec60be16789d186918d5c286b85") return false;
  const rendered = await pdf.render(buffer, { first: 8, last: 8 });
  try {
    const page = rendered.pages[0];
    if (!page) return false;
    const full = fs.readFileSync(page.file).toString("base64");
    const figures = await Promise.all([
      pdf.crop(full, [0.125, 0.222, 0.906, 0.393]),
      pdf.crop(full, [0.23, 0.595, 0.77, 0.868]),
    ]);
    const latest = store.list("bank");
    if (signal?.aborted || !needsQuestion(latest)) return false;
    const imageId = images.save(full);
    const figureIds = figures.map((image) => images.save(image));
    const stem = [
      "某主机的 MAC 地址是 00-15-C5-C1-5E-28，IP 地址是 10.2.128.100（私有地址）。图 (a) 给出网络拓扑，图 (b) 给出这台主机发起 Web 请求时，一个以太网帧前 80 字节的内容。图 (c)、(d) 分别给出以太网帧和 IPv4 首部的结构。",
      "[图：网络拓扑、数据帧前 80 字节、以太网帧格式和 IPv4 首部格式]",
      "1. 求 Web 服务器的 IP 地址和主机默认网关的 MAC 地址。",
      "2. 主机用什么协议确定该数据帧的目的 MAC 地址？承载该协议请求的以太网帧使用什么目的 MAC 地址？",
      "3. HTTP/1.1 采用持久连接且不使用流水线。页面引用了 5 个 JPEG 图像，单次请求与响应耗时为 RTT。从图 (b) 所示请求发出，到浏览器收全内容，共需多少 RTT？",
      "4. 图 (b) 中的 IP 分组经过路由器 R 转发时，首部的哪些字段会改变？",
    ].join("\n\n");
    const answer = "（1）64.170.98.32；00-21-27-21-51-EE。（2）ARP；FF-FF-FF-FF-FF-FF。（3）6 RTT。（4）源 IP 地址、TTL、首部校验和。";
    const analysis = [
      "（1）帧的前 6 字节是目的 MAC，此处对应默认网关。以太网帧头占 14 字节；IPv4 首部偏移量 16–19 处的四个字节为目的地址，读出十六进制 40 AA 62 20，换成十进制为 64.170.98.32。",
      "（2）主机以 ARP 解析本地下一跳的 MAC。尚不知道网关的 MAC 时，向链路层广播地址发送请求。",
      "（3）初始 Web 请求已经发出，因此无需另计 TCP 建连。HTML 需要 1 RTT；非流水线连接上还需依次请求 5 张图，共 6 RTT。",
      "（4）R 执行 NAT，把源地址转换为外网侧地址 101.12.123.15。转发时 TTL 减一，IPv4 首部校验和更新。分组长度为 0x01EF（495 字节），低于 1500 字节的 MTU。",
    ].join("\n\n");
    store.saveList("bank", [...latest, {
      id: uid(), subject: "408", paper: PAPER, year: 2011, number: "47", type: "解答", score: 9,
      stem, options: [], answer, analysis, answerSource: "手动", analysisSource: "手动",
      topics: ["以太网与802.3", "ARP", "HTTP及连接方式", "IPv4地址与NAT", "路由器与路由表转发"],
      hasFigure: true, images: [imageId], figures: figureIds, material: "", materialKey: "", source: "真题", createdAt: nowIso(),
    }]);
    return true;
  } finally {
    fs.rmSync(rendered.dir, { recursive: true, force: true });
  }
}

module.exports = { repairChoiceKeys, restore2011Question };
