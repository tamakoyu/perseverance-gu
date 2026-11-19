"use strict";
// 独立手写白板：插件在 127.0.0.1 上开一个只给本机用的小网页（带随机口令），
// 用默认浏览器打开后可以拖到 iPad（随航）上写；点「提交为答案」把图片传回练习页面。
// LearnHarness 自己禁止弹出新窗口（window.open 一律交给系统浏览器），所以只能这样做。
const http = require("node:http");
const crypto = require("node:crypto");

function createPadServer({ onSubmit = () => {}, onNav = () => {}, signal } = {}) {
  let server = null;
  let port = 0;
  const sessions = new Map(); // id → {token, key, v, current:{qid,title,stem,mode,multi}, modes:{qid→mode}, answers:{qid→{images,submittedAt}}}

  async function ensure() {
    if (server) return;
    server = http.createServer(handle);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    port = server.address().port;
    server.unref();
    signal?.addEventListener("abort", () => { try { server.close(); } catch { /* 忽略 */ } });
  }

  function send(res, code, type, body) {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(body);
  }

  function readJson(req, limit, cb) {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) req.destroy(); else chunks.push(c); });
    req.on("end", () => { try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (err) { cb(err); } });
  }
  const json = (res, code, obj) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
  const stateOf = stateOf0;

  function handle(req, res) {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return send(res, 400, "text/plain", "bad url"); }
    const m = url.pathname.match(/^\/pad\/([a-f0-9]{24})(?:\/(submit|state|nav))?$/);
    const s = m && sessions.get(m[1]);
    const token = url.searchParams.get("t") || "";
    if (!s || token.length !== s.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.token))) return send(res, 404, "text/plain; charset=utf-8", "白板不存在或已过期，请回到练习页面重新打开");
    const id = m[1];
    const action = m[2];
    if (!action && req.method === "GET") return send(res, 200, "text/html; charset=utf-8", page(s, id));
    if (action === "state" && req.method === "GET") { s.seenAt = Date.now(); return json(res, 200, stateOf(s)); }
    if (action === "nav" && req.method === "POST") {
      return readJson(req, 4096, (err, body) => {
        if (err) return json(res, 400, { error: "bad json" });
        const dir = body.dir === -1 || body.dir === 1 ? body.dir : 0;
        const qid = typeof body.qid === "string" ? body.qid.slice(0, 100) : "";
        if (!dir && !qid) return json(res, 400, { error: "缺少方向" });
        try { onNav({ id, key: s.key, dir, qid }); } catch { /* 忽略 */ }
        json(res, 200, { ok: true });
      });
    }
    if (action === "submit" && req.method === "POST") {
      return readJson(req, 25 * 1024 * 1024, (err, body) => {
        if (err) return json(res, 400, { error: String(err.message || err) });
        const qid = typeof body.qid === "string" && body.qid ? body.qid.slice(0, 100) : s.current.qid;
        if (!s.current.multi && qid !== s.current.qid) return json(res, 400, { error: "题目对不上，请刷新白板" });
        if (s.modes[qid] === "draft") return json(res, 400, { error: "这题是选择 / 填空，白板只当草稿，不提交" });
        const imgs = (Array.isArray(body.images) ? body.images : [body.image]).filter((x) => typeof x === "string" && /^[A-Za-z0-9+/=]+$/.test(x)).slice(0, 10);
        if (!imgs.length) return json(res, 400, { error: "没有图片" });
        s.answers[qid] = { images: imgs, submittedAt: Date.now() };
        s.v++;
        try { onSubmit({ id, key: s.key, qid }); } catch { /* 忽略 */ }
        json(res, 200, { ok: true, qid });
      });
    }
    send(res, 405, "text/plain", "method not allowed");
  }

  function sessionFor(key) {
    let id = [...sessions.entries()].find(([, s]) => s.key === key)?.[0];
    if (!id) {
      id = crypto.randomBytes(12).toString("hex");
      sessions.set(id, { token: crypto.randomBytes(18).toString("base64url"), key, v: 1, current: { qid: "_", title: "", stem: "", mode: "answer", multi: false }, modes: {}, answers: {}, createdAt: Date.now(), seenAt: 0 });
    }
    // 只留最近 200 个
    if (sessions.size > 200) for (const k of [...sessions.keys()].slice(0, sessions.size - 200)) sessions.delete(k);
    return id;
  }
  const urlOf = (id) => `http://127.0.0.1:${port}/pad/${id}?t=${encodeURIComponent(sessions.get(id).token)}`;

  /** 单题白板（英语专项用）：打开（或复用）某道题的白板，返回网址。 */
  async function open({ key, title, stem }) {
    await ensure();
    const id = sessionFor(key);
    const s = sessions.get(id);
    s.current = { qid: "_", title: String(title || "").slice(0, 200), stem: String(stem || "").slice(0, 6000), mode: "answer", multi: false };
    s.v++;
    return { id, url: urlOf(id) };
  }

  /** 整套练习共用一块白板：开一次，换题时用 focus 告诉白板现在是哪题。 */
  async function openBoard({ key, title }) {
    await ensure();
    const id = sessionFor(key);
    const s = sessions.get(id);
    s.boardTitle = String(title || "").slice(0, 200);
    if (!s.current.multi) s.current = { qid: "", title: s.boardTitle, stem: "", mode: "draft", multi: true };
    return { id, url: urlOf(id), opened: !!s.seenAt && Date.now() - s.seenAt < 5000 };
  }

  function focus(id, { qid, title, stem, mode, index, total }) {
    const s = sessions.get(id);
    if (!s) throw new Error("白板已过期，请重新打开");
    const m = mode === "answer" ? "answer" : "draft";
    s.modes[qid] = m;
    s.current = { qid, title: String(title || "").slice(0, 200), stem: String(stem || "").slice(0, 6000), mode: m, multi: true, board: s.boardTitle || "", index: Number(index) || 0, total: Number(total) || 0 };
    s.v++;
    return { ok: true, live: !!s.seenAt && Date.now() - s.seenAt < 5000 };
  }

  function take(id, qid) {
    const s = sessions.get(id);
    if (!s) return { images: null, submittedAt: 0 };
    const a = s.answers[qid || s.current.qid];
    return { images: a?.images || null, submittedAt: a?.submittedAt || 0 };
  }

  /** 练习页面移除了某题的手写，白板那边也要清掉「已发送」标记。 */
  function drop(id, qid) {
    const s = sessions.get(id);
    if (s && s.answers[qid]) { delete s.answers[qid]; s.v++; }
    return { ok: true };
  }

  return { open, openBoard, focus, take, drop };
}

const cleanStem = (t) => String(t || "").replace(/\$\$?/g, "").replace(/\[图[：:][^\]]*\]/g, "[图见练习页面]");
const stateOf0 = (s) => ({ v: s.v, ...s.current, stem: cleanStem(s.current.stem), sent: Object.fromEntries(Object.entries(s.answers).map(([q, a]) => [q, a.images?.length || 0])) });
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(s, id) {
  const cur = s.current;
  const boot = JSON.stringify(stateOf0(s)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>手写 · ${esc(cur.multi ? s.boardTitle || "白板" : cur.title || "答题白板")}</title>
<style>
:root{--fg:#1d1d1f;--bg:#fbfaf7;--line:rgba(0,0,0,.07);--bd:#d9d6cf;--ink:#111;--chip:#efece6}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#1c1c1e;--line:rgba(255,255,255,.07);--bd:#3a3a3c;--ink:#f2f2f2;--chip:#2c2c2e}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:15px -apple-system,"PingFang SC",sans-serif}
.bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;background:var(--bg);border-bottom:1px solid var(--bd)}
.bar b{margin-right:auto;font-size:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--chip)}
.chip.draft{background:#f3e6c4;color:#7a5a00}.chip.answer{background:#d7e6ff;color:#1d4fa8}.chip.sent{background:#d5f0df;color:#146c3c}
@media (prefers-color-scheme:dark){.chip.draft{background:#4a3c14;color:#f3d98a}.chip.answer{background:#1d3357;color:#a9c8ff}.chip.sent{background:#143d27;color:#8fe0b0}}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--bd);border-radius:10px;min-height:44px;min-width:56px;padding:0 14px;cursor:pointer}
button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
button.primary{background:#2f6fde;border-color:#2f6fde;color:#fff;font-weight:600}
button:disabled{opacity:.5}.hide{display:none!important}
.dot{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:-2px}
details{padding:8px 14px;border-bottom:1px solid var(--bd)}summary{cursor:pointer;opacity:.75;min-height:32px}
.stem{white-space:pre-wrap;line-height:1.7;max-height:30vh;overflow:auto;padding:6px 0}
#wrap{position:relative;background-image:repeating-linear-gradient(to bottom,transparent 0 47px,var(--line) 47px 48px)}
canvas{display:block;width:100%;touch-action:pan-y;cursor:crosshair}
#msg{padding:8px 14px;font-size:14px;opacity:.8}
#wait{padding:60px 20px;text-align:center;opacity:.7}
.ok{color:#18a058}.err{color:#d0505b}
</style></head><body>
<div class="bar">
  <b><span id="ttl"></span><span id="mode" class="chip"></span></b>
  <button id="prev" class="hide">← 上一题</button><button id="next" class="hide">下一题 →</button>
  <button data-c="ink" class="on"><span class="dot" style="background:var(--ink)"></span></button>
  <button data-c="#2f6fde"><span class="dot" style="background:#2f6fde"></span></button>
  <button data-c="#e0453a"><span class="dot" style="background:#e0453a"></span></button>
  <button id="er">橡皮</button><button id="un">撤销</button><button id="cl">清空</button><button id="ex">加长</button>
  <button id="sub" class="primary">发送到本题</button>
</div>
<details id="stemBox" class="hide"><summary>题目</summary><div class="stem" id="stem"></div></details>
<div id="msg"></div>
<div id="wait" class="hide">等练习页面选好题目…</div>
<div id="wrap"><canvas id="cv"></canvas></div>
<script>
(()=>{
const ID="${id}";
let st=${boot};
const $=x=>document.getElementById(x);
const cv=$("cv"),wrap=$("wrap"),g=cv.getContext("2d"),msg=$("msg");
let qid=null,strokes=[],color="ink",erase=false,cur=null,H=0,pending=null,flash="";
const KEY=q=>"ky-pad-"+ID+"-"+q;
const inkColor=()=>getComputedStyle(document.documentElement).getPropertyValue("--ink").trim()||"#111";
const save=()=>{if(qid==null)return;try{localStorage.setItem(KEY(qid),JSON.stringify({strokes,H}))}catch(e){}};
function load(q){strokes=[];H=Math.max(window.innerHeight*1.5,900);try{const d=JSON.parse(localStorage.getItem(KEY(q))||"null");if(d){strokes=d.strokes||[];H=d.H||H;}}catch(e){}}
function size(){const r=devicePixelRatio||1,w=wrap.clientWidth;cv.width=Math.round(w*r);cv.height=Math.round(H*r);cv.style.height=H+"px";g.setTransform(r,0,0,r,0,0);draw();}
function paint(ctx,list,map,sc){ctx.lineCap="round";ctx.lineJoin="round";for(const s of list){ctx.strokeStyle=map(s.c);ctx.fillStyle=map(s.c);const p=s.p;if(p.length===1){ctx.beginPath();ctx.arc(p[0][0]*sc,p[0][1]*sc,1.6*sc,0,7);ctx.fill();continue;}for(let i=1;i<p.length;i++){ctx.lineWidth=(1.1+2.3*((p[i-1][2]+p[i][2])/2))*sc;ctx.beginPath();ctx.moveTo(p[i-1][0]*sc,p[i-1][1]*sc);ctx.lineTo(p[i][0]*sc,p[i][1]*sc);ctx.stroke();}}}
function draw(){g.clearRect(0,0,cv.width,cv.height);paint(g,strokes,c=>c==="ink"?inkColor():c,1);}
function hint(){
  if(flash){msg.innerHTML=flash;return;}
  const n=(st.sent||{})[st.qid]||0;
  msg.innerHTML=st.mode==="draft"?"草稿纸：这题是选择 / 填空，白板不提交，答案请在练习页面选 / 填。换题后草稿会各自保留。"
    :n?'<span class="ok">✓ 这题已发送（'+n+' 页）。还可以继续改，再发送会覆盖。</span>'
    :"用 Apple Pencil 书写，手指上下滑动翻页。写完点「发送到本题」，可以反复发送（以最后一次为准）。";
}
function apply(next){
  st=next;
  const ready=!!st.qid;
  $("wait").classList.toggle("hide",ready);wrap.classList.toggle("hide",!ready);
  $("ttl").textContent=(st.multi&&st.total>1?(st.index+1)+" / "+st.total+" · ":"")+(st.title||"答题白板");
  document.title="手写 · "+(st.title||"白板");
  const m=$("mode"),n=(st.sent||{})[st.qid]||0;
  m.textContent=!ready?"":st.mode==="draft"?"草稿":n?"已发送":"作答";m.className="chip "+(st.mode==="draft"?"draft":n?"sent":"answer");
  $("sub").classList.toggle("hide",st.mode==="draft"||!ready);
  const one=!st.multi||!ready||st.total<=1;$("prev").classList.toggle("hide",one);$("next").classList.toggle("hide",one);
  $("prev").disabled=!(st.index>0);$("next").disabled=!(st.index<st.total-1);
  const stem=String(st.stem||"").trim();
  $("stemBox").classList.toggle("hide",!stem);$("stem").textContent=stem;
  if(ready&&st.qid!==qid){if(qid!=null)save();qid=st.qid;flash="";load(qid);size();window.scrollTo(0,0);}
  hint();
}
async function poll(){
  try{const r=await fetch(location.pathname+"/state"+location.search,{cache:"no-store"});if(r.ok){const j=await r.json();
    if(j.v!==st.v||j.qid!==st.qid){if(cur)pending=j;else apply(j);}}}
  catch(e){}
  setTimeout(poll,document.hidden?3000:700);
}
const pos=e=>{const rc=cv.getBoundingClientRect();const pr=e.pointerType==="pen"&&e.pressure>0?e.pressure:.5;return[e.clientX-rc.left,e.clientY-rc.top,pr];};
function eraseAt([x,y]){const n=strokes.length;strokes=strokes.filter(s=>!s.p.some(([a,b])=>(a-x)**2+(b-y)**2<144));if(strokes.length!==n){draw();save();}}
cv.addEventListener("pointerdown",e=>{if(e.pointerType==="touch")return;if(e.pointerType==="mouse"&&e.button!==0)return;e.preventDefault();cv.setPointerCapture(e.pointerId);
  if(erase||(e.buttons&32)){cur={erase:true};eraseAt(pos(e));return;}cur={c:color,p:[pos(e)]};strokes.push(cur);draw();});
cv.addEventListener("pointermove",e=>{if(!cur)return;e.preventDefault();const evs=e.getCoalescedEvents?e.getCoalescedEvents():[e];
  if(cur.erase){for(const v of evs)eraseAt(pos(v));return;}for(const v of evs)cur.p.push(pos(v));draw();
  const y=cur.p[cur.p.length-1][1];if(y>H-120){H+=500;size();}});
const end=()=>{if(cur&&!cur.erase)save();cur=null;if(pending){const p=pending;pending=null;apply(p);}};cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
document.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>{color=b.dataset.c;erase=false;document.querySelectorAll("[data-c],#er").forEach(x=>x.classList.toggle("on",x===b));});
$("er").onclick=e=>{erase=true;document.querySelectorAll("[data-c],#er").forEach(x=>x.classList.toggle("on",x===e.currentTarget));};
$("un").onclick=()=>{strokes.pop();draw();save();};
$("cl").onclick=()=>{if(strokes.length&&confirm("清空这题的白板？")){strokes=[];draw();save();}};
$("ex").onclick=()=>{H+=600;size();save();window.scrollBy({top:400,behavior:"smooth"});};
async function nav(dir){try{await fetch(location.pathname+"/nav"+location.search,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({dir})});}catch(e){}}
$("prev").onclick=()=>nav(-1);$("next").onclick=()=>nav(1);
function exportPages(){let maxY=0;for(const s of strokes)for(const p of s.p)maxY=Math.max(maxY,p[1]);if(!strokes.length)return[];
  const w=wrap.clientWidth,pageH=Math.max(900,Math.round(w*1.3)),total=Math.min(H,Math.ceil(maxY+40)),out=[];
  for(let top=0;top<total;top+=pageH){const h=Math.min(pageH,total-top),sc=Math.min(2,1600/Math.max(w,h));
    const c=document.createElement("canvas");c.width=Math.round(w*sc);c.height=Math.round(h*sc);const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);
    const part=strokes.map(s=>({c:s.c,p:s.p.map(([a,b,pr])=>[a,b-top,pr])})).filter(s=>s.p.some(p=>p[1]>-20&&p[1]<h+20));
    if(!part.length)continue;paint(x,part,cc=>cc==="ink"?"#111":cc,sc);out.push(c.toDataURL("image/jpeg",.85).split(",")[1]);}
  return out;}
$("sub").onclick=async e=>{const b=e.currentTarget;const images=exportPages();const target=qid;if(!images.length){flash='<span class="err">白板是空的</span>';hint();flash="";return;}
  b.disabled=true;msg.textContent="发送中…";
  try{const r=await fetch(location.pathname+"/submit"+location.search,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({qid:target,images})});
    const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
    if(target===qid){st.sent=Object.assign({},st.sent,{[target]:images.length});apply(Object.assign({},st));}}
  catch(err){flash='<span class="err">发送失败：'+String(err.message||err)+'（练习页面还开着吗？）</span>';hint();flash="";}
  b.disabled=false;};
addEventListener("resize",size);
apply(st);if(!st.qid)size();
poll();
})();
</script></body></html>`;
}

module.exports = { createPadServer };
