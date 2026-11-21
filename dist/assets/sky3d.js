// 拾星 · 3D 螺旋星系（分数判断机的可视化）。
// 全景（四条旋臂＝四科）→ 一条旋臂（章节星座）→ 一个星座（考点星）→ 一颗星特写（环绕的真题小星）。
// 星的亮度＝掌握程度；背景星属于各个章节，跟着章节变亮；模块整块达到 60% / 80% / 100% 时那一片天空放一圈光波。
import { THREE, makeSkydome, makeGalaxy, galaxyPoint, ARM_TINT, Orb, makeVocabCluster, makeLines, mst, makeThread, makeSkyField, makePlanet, makeOrbit, Meteor, Sparks, Shock, SILVER, rng } from "./sky/scene.js";
import { EffectComposer } from "./vendor/EffectComposer.js";
import { RenderPass } from "./vendor/RenderPass.js";
import { UnrealBloomPass } from "./vendor/UnrealBloomPass.js";
import { OutputPass } from "./vendor/OutputPass.js";
import { put, reset, el, btn, errorBox, toast, copy, fmtDate, waitJob } from "./ui.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const KEYS = ["数学", "408", "英语", "政治"];
const SUBJ = {
  数学: { short: "数学一", arm: 0, css: "#dfe7ff" },
  408: { short: "408", arm: 1, css: "#d9f3ec" },
  英语: { short: "英语一", arm: 2, css: "#f4eadb" },
  政治: { short: "政治", arm: 3, css: "#f1e0e8" },
};
const GALAXY_R = 1150;
const LEVELS = [0.6, 0.8, 1.0];
const MOD_SHORT = { 马克思主义基本原理: "马原", 毛泽东思想和中国特色社会主义理论体系概论: "毛中特", 习近平新时代中国特色社会主义思想概论: "习思想", 中国近现代史纲要: "史纲", 思想道德与法治: "思修法基", 形势与政策及当代世界经济与政治: "时政", 概率论与数理统计: "概率统计", 计算机组成原理: "组成原理" };
const KIND_LABEL = { taught: "讲解", practice: "练习", real: "真题" };
const SEEN_KEY = "kaoyan.sky3d.seen";
const MODS_KEY = "kaoyan.sky3d.mods";
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const f1 = (x) => (Math.round((x || 0) * 10) / 10).toFixed(1);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } };
// 按本地日历日期算「今天 / 昨天 / N 天前」，不是按过了几个 24 小时
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const daysAgo = (iso) => (iso ? Math.max(0, Math.round((dayStart(Date.now()) - dayStart(Date.parse(iso))) / 86400000)) : null);
const ago = (iso) => { const d = daysAgo(iso); return d == null ? "还没学过" : d === 0 ? "今天" : d === 1 ? "昨天" : `${d} 天前`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const starRadius = (points) => 1.1 + 1.25 * Math.sqrt(points);
function lookOf(l) {
  const rad = starRadius(l.points);
  if (!l.n) return { I: 0, spikes: 0, ring: 0, radius: rad * 0.75 };
  const m = l.now ?? 0;
  return { I: 0.08 + 1.0 * m, spikes: m > 0.7 ? (m - 0.7) * 2.6 : 0, ring: l.due ? 1 : 0, radius: rad * (0.85 + 0.15 * m) };
}

// ── 布局 ───────────────────────────────────────────────
function layout(data) {
  const subjects = [], stars = [], chapters = [], modules = [];
  for (const sub of data.subjects) {
    const S = SUBJ[sub.key];
    const so = { key: sub.key, sub, ...S, chapters: [] };
    subjects.push(so);
    const list = sub.modules.flatMap((m) => m.chapters.map((c) => ({ m, c })));
    const n = list.length;
    const r = rng(`lay-${sub.key}`);
    const modIdx = new Map();
    for (const m of sub.modules) { modIdx.set(m.name, modules.length); modules.push({ key: `${sub.key}/${m.name}`, name: m.name, subject: sub.key, m, chapters: [] }); }
    list.forEach(({ m, c }, k) => {
      const t = 0.08 + 0.88 * ((k + 0.5) / n);
      const center = galaxyPoint(S.arm, t, GALAXY_R);
      center.addScaledVector(center.clone().normalize(), (k % 2 ? 1 : -1) * (25 + r() * 45)).add(V(0, (r() - 0.5) * 50, 0));
      const leaves = c.leaves;
      const isVocab = leaves.every((l) => l.vocab);
      const rc = 12 + 7.5 * Math.sqrt(leaves.length);
      const normal = V((r() - 0.5) * 0.9, 1, (r() - 0.5) * 0.9).normalize();
      const u = new THREE.Vector3().crossVectors(normal, V(1, 0, 0)).normalize();
      const w = new THREE.Vector3().crossVectors(normal, u).normalize();
      const mi = modIdx.get(m.name);
      const cs = { key: `${sub.key}/${m.name}/${c.name}`, name: c.name, module: m.name, modIndex: mi, subject: sub.key, center, rc, c, m, stars: [], isVocab, weight: c.max };
      modules[mi].chapters.push(cs);
      const placed = [];
      for (const l of leaves) {
        let p = center.clone();
        if (leaves.length > 1) {
          for (let tries = 0; tries < 50; tries++) {
            const a = r() * Math.PI * 2, d = rc * (0.25 + 0.75 * Math.sqrt(r()));
            p = center.clone().addScaledVector(u, Math.cos(a) * d).addScaledVector(w, Math.sin(a) * d).addScaledVector(normal, (r() - 0.5) * rc * 0.3);
            if (placed.every((q) => q.distanceTo(p) > 8)) break;
          }
        }
        placed.push(p);
        const st = { id: l.id, leaf: l, subject: sub.key, chapter: cs, pos: p, obj: null };
        cs.stars.push(st);
        stars.push(st);
      }
      cs.pairs = mst(cs.stars.map((s) => s.pos));
      so.chapters.push(cs);
      chapters.push(cs);
    });
    so.pos = so.chapters.reduce((a, c) => a.add(c.center), V(0, 0, 0)).divideScalar(Math.max(1, so.chapters.length));
    so.R = Math.max(150, ...so.chapters.map((c) => c.center.distanceTo(so.pos) + c.rc));
  }
  for (const m of modules) m.center = m.chapters.reduce((a, c) => a.add(c.center), V(0, 0, 0)).divideScalar(Math.max(1, m.chapters.length));
  return { subjects, stars, chapters, modules };
}

export function mountScore(ctx, container, signal) {
  const root = el("div", "sk");
  const canvas = el("canvas", "sk-canvas");
  const labels = el("div", "sk-labels");
  const scoreBox = el("div", "sk-score");
  const crumbs = el("nav", "sk-crumbs");
  const tools = el("div", "sk-tools");
  const dock = el("div", "sk-dock");
  const feed = el("div", "sk-feed");
  const hint = el("div", "sk-hint");
  const tip = el("div", "sk-tip");
  const panel = el("aside", "sk-panel");
  const pop = el("div", "sk-pop");
  const sheet = el("div", "sk-sheet");
  const banner = el("div", "sk-banner");
  const veil = el("div", "sk-veil", el("div", "sk-veil-txt", "拾 星"));
  put(root, canvas, labels, el("div", "sk-top", scoreBox, crumbs, tools), dock, feed, hint, tip, banner, panel, pop, sheet, veil);
  put(container, root);

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }); }
  catch (err) { reset(root, errorBox(new Error(`这台电脑的显卡环境不支持 WebGL：${err.message}`))); return; }
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40000);
  camera.position.set(0, 4200, 6000);
  // 后期也开 4 倍多重采样，球的边缘才不会有锯齿
  const msaa = new THREE.WebGLRenderTarget(800, 600, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, msaa);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.32, 0.78);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const sky = makeSkydome();
  const galaxy = makeGalaxy(GALAXY_R);
  const sparks = new Sparks(scene);
  scene.add(sky, galaxy);
  const meteors = [], shocks = [];
  let dpr = 1, cw = 800, ch = 600;

  let data = null, L = null, field = null, vocabPts = null, planetSys = null;
  const hitChapters = [];
  const leaving = [];

  function build(d) {
    L = layout(d);
    field = makeSkyField(L.chapters, GALAXY_R);
    scene.add(field);
    for (const so of L.subjects) {
      // 主线沿旋臂本身的螺线走（不跟着星座左右摆），所以是一条顺滑的弧
      const pts = []; for (let i = 0; i <= 40; i++) pts.push(galaxyPoint(so.arm, 0.06 + 0.9 * (i / 40), GALAXY_R));
      so.thread = makeThread(pts, new THREE.Color(...ARM_TINT[so.arm]).lerp(new THREE.Color(1, 1, 1), 0.5));
      scene.add(so.thread);
      for (const cs of so.chapters) {
        if (cs.pairs.length) { cs.lines = makeLines(cs.pairs, new THREE.Color(0.85, 0.88, 0.96)); scene.add(cs.lines); }
        const hc = new THREE.Mesh(new THREE.SphereGeometry(cs.rc * 1.35 + 16, 12, 8), new THREE.MeshBasicMaterial());
        hc.visible = false; hc.position.copy(cs.center); hc.userData = { chapter: cs };
        scene.add(hc); hitChapters.push(hc);
      }
    }
    L.modules.forEach((m, i) => { field.material.uniforms.uModC.value[i].copy(m.center); });
    // 词汇星团：作为词汇那几颗星背后的一团小星尘，点亮比例＝词汇掌握度
    const vc = L.chapters.find((c) => c.isVocab);
    if (vc) { vocabPts = makeVocabCluster(vc.rc * 1.6); vocabPts.position.copy(vc.center); scene.add(vocabPts); }
    for (const st of L.stars) {
      const obj = new Orb();
      obj.group.position.copy(st.pos);
      obj.hit.userData = { star: st };
      obj.dim = 0;
      st.obj = obj; st.hit = obj.hit;
      scene.add(obj.group);
    }
  }

  // ── 镜头 ───────────────────────────────────────────
  const ctl = { target: V(0, 0, 0), r: 7800, theta: 0.5, phi: 0.9, vt: 0, vp: 0, min: 1200, max: 5000, idle: 0 };
  let fly = null;
  const nav = { level: 0, subject: null, chapter: null, star: null };
  function camFromCtl() {
    const sp = Math.sin(ctl.phi);
    camera.position.set(ctl.target.x + ctl.r * sp * Math.sin(ctl.theta), ctl.target.y + ctl.r * Math.cos(ctl.phi), ctl.target.z + ctl.r * sp * Math.cos(ctl.theta));
    camera.lookAt(ctl.target);
  }
  function ctlFromCam(target) {
    const d = camera.position.clone().sub(target);
    ctl.target.copy(target); ctl.r = d.length();
    ctl.phi = Math.acos(clamp(d.y / ctl.r, -1, 1));
    ctl.theta = Math.atan2(d.x, d.z);
  }
  /** 从星系外侧朝中心看、接近水平：近景时身后就是远处的旋臂和星系核。 */
  function outward(p, lift) {
    const d = V(p.x, 0, p.z);
    if (d.lengthSq() < 1) d.set(0, 0, 1);
    d.normalize();
    // 稍微偏一点角度，避免星系核正好被挡在星的正后方
    d.applyAxisAngle(V(0, 1, 0), 0.35);
    return V(d.x, lift, d.z).normalize();
  }
  function viewFor(level) {
    if (level === 0) return { target: V(0, 0, 0), r: 2250, min: 1000, max: 4800, lift: 0.8 };
    if (level === 1) { const so = L.subjects.find((x) => x.key === nav.subject); return { target: so.pos.clone(), r: so.R * 1.6, min: so.R * 0.5, max: so.R * 4.5, lift: 0.6 }; }
    if (level === 2) { const cs = nav.chapter; return { target: cs.center.clone(), r: cs.rc * 3.8 + 50, min: cs.rc * 1.2 + 10, max: cs.rc * 9 + 160, dir: outward(cs.center, 0.22) }; }
    const st = nav.star;
    const rad = starRadius(st.leaf.points);
    return { target: st.pos.clone(), r: rad * 19 + 10, min: rad * 3.6 + 2, max: rad * 50 + 60, dir: outward(st.pos, 0.07) };
  }
  function flyTo(level, ms) {
    const v = viewFor(level);
    const from = camera.position.clone();
    let dir;
    if (v.dir) dir = v.dir.clone();
    else {
      dir = from.clone().sub(v.target).normalize();
      if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir = V(0.3, 0.4, 1).normalize();
      dir.y = dir.y * 0.5 + (v.lift ?? 0.32);
      dir.normalize();
    }
    let to = v.target.clone().addScaledVector(dir, v.r);
    const pw = level > 0 && cw >= 760 && root.classList.contains("sk-panel-on") ? Math.min(420, cw * 0.4) : 0;
    if (pw) {
      const right = new THREE.Vector3().crossVectors(dir.clone().negate(), V(0, 1, 0)).normalize();
      const shift = (pw / 2 / cw) * 2 * v.r * Math.tan((50 * Math.PI) / 360) * (cw / ch);
      v.target.addScaledVector(right, shift); to = to.addScaledVector(right, shift);
    }
    const len = from.distanceTo(to);
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const c1 = from.clone().addScaledVector(fwd, len * 0.28).add(V(0, len * 0.08, 0));
    const c2 = to.clone().addScaledVector(dir, len * 0.45);
    const dur = ms ?? clamp(1000 + Math.sqrt(len) * 26, 1200, 2600);
    fly = { from, c1, c2, to, lookFrom: ctl.target.clone(), lookTo: v.target.clone(), t0: performance.now(), ms: reduceMotion() ? 1 : dur, v };
    ctl.vt = ctl.vp = 0;
  }
  function stepFly(now) {
    const p = clamp((now - fly.t0) / fly.ms, 0, 1);
    const e = ease(p), k = 1 - e;
    camera.position.set(0, 0, 0).addScaledVector(fly.from, k * k * k).addScaledVector(fly.c1, 3 * k * k * e).addScaledVector(fly.c2, 3 * k * e * e).addScaledVector(fly.to, e * e * e);
    camera.lookAt(fly.lookFrom.clone().lerp(fly.lookTo, ease(clamp(p * 1.25, 0, 1))));
    camera.fov = 50 + 9 * Math.sin(Math.PI * p);
    camera.updateProjectionMatrix();
    bloom.strength = 0.7 + 0.22 * Math.sin(Math.PI * p);
    if (p >= 1) { ctlFromCam(fly.lookTo); ctl.min = fly.v.min; ctl.max = fly.v.max; camera.fov = 50; camera.updateProjectionMatrix(); fly = null; }
  }

  // ── 导航 ───────────────────────────────────────────
  function go(level, { subject, chapter, star } = {}) {
    if (level >= 1) nav.subject = subject ?? nav.subject;
    if (level >= 2) nav.chapter = chapter ?? nav.chapter;
    if (level >= 3) nav.star = star ?? nav.star;
    if (level < 3) nav.star = null;
    if (level < 2) nav.chapter = null;
    if (level < 1) nav.subject = null;
    nav.level = level;
    tip.classList.remove("sk-on"); hoverObj = null;
    if (level === 0) closePanel();
    else if (level === 1) showSubject(nav.subject);
    else if (level === 2) showChapter(nav.chapter);
    else showLeaf(nav.star);
    flyTo(level);
    if (level === 3) openPlanets(nav.star); else closePlanets();
    renderCrumbs(); renderHint();
    root.dataset.level = String(level);
  }
  const up = () => { if (nav.level > 0) go(nav.level - 1); };
  function renderCrumbs() {
    const parts = [["全景", () => go(0)]];
    if (nav.subject) parts.push([SUBJ[nav.subject].short, () => go(1)]);
    if (nav.chapter) parts.push([nav.chapter.name, () => go(2)]);
    if (nav.star) parts.push([nav.star.leaf.name, null]);
    reset(crumbs, ...parts.flatMap(([label, fn], i) => [
      i ? el("span", "sk-crumb-sep", "/") : null,
      el("button", { type: "button", class: `sk-crumb${i === parts.length - 1 ? " sk-on" : ""}`, onclick: fn || undefined }, label)]));
  }
  function renderHint() {
    reset(hint, ["拖动旋转 · 滚轮远近 · 点一颗星或一条旋臂飞进去", "点一个星座进入 · 点空白处返回", "点一颗星看特写 · 点空白处返回", nav.star?.leaf.vocab ? "这一档的单词在右边 · 点空白处返回" : "环绕的小星是相关真题，亮着的做对过 · 点它开练 · 点空白处返回"][nav.level]);
  }

  // ── 特写：环绕的真题小球 ─────────────────────────────
  async function openPlanets(st) {
    closePlanets();
    if (!st || st.leaf.vocab) return;
    const sys = { group: new THREE.Group(), items: [], st, t0: performance.now(), dead: false };
    sys.group.position.copy(st.pos);
    scene.add(sys.group);
    planetSys = sys;
    let r;
    try { r = await ctx.call("score.questions", { leaf: st.id, limit: 10 }); } catch { return; }
    if (sys.dead) return;
    const rad = starRadius(st.leaf.points);
    const rr = rng(`pl-${st.id}`);
    r.items.forEach((q, i) => {
      const kind = q.done ? (q.lastCorrect ? "good" : "bad") : "todo";
      const orb = makePlanet(q.id, kind);
      const pr = rad * (0.16 + 0.02 * Math.min(12, Number(q.score) || 4));
      const a = rad * (3.4 + i * 0.85), b = a * (0.86 + rr() * 0.12);
      const tilt = new THREE.Group();
      tilt.rotation.set((rr() - 0.5) * 0.5, rr() * 6.28, (rr() - 0.5) * 0.35);
      const orbit = makeOrbit(a, b, 0xcfd6e4);
      tilt.add(orbit, orb.group);
      sys.group.add(tilt);
      orb.hit.userData = { planet: q, kind };
      sys.items.push({ q, kind, orb, orbit, a, b, pr, phase: rr() * 6.28, w: 0.5 / Math.pow(a / rad, 1.5), delay: 350 + i * 140 });
    });
  }
  function closePlanets() {
    if (!planetSys) return;
    planetSys.dead = true; planetSys.leaving = performance.now();
    leaving.push(planetSys); planetSys = null;
  }
  function updatePlanetSys(sys, now, dt, t, fade = 1) {
    for (const it of sys.items) {
      const age = clamp((now - sys.t0 - it.delay) / 900, 0, 1);
      const s = (1 - Math.pow(1 - age, 3)) * fade;
      it.phase += it.w * dt;
      it.orb.group.position.set(Math.cos(it.phase) * it.a, 0, Math.sin(it.phase) * it.b);
      it.orb.to.radius = Math.max(0.0001, it.pr * s); it.orb.cur.radius = it.orb.to.radius;
      it.orb.hover = hoverObj?.planet === it.q ? 1 : 0;
      it.orb.viewH = ch;
      it.orb.update(dt, t, camera);
      it.orbit.material.opacity = 0.22 * s;
    }
  }

  // ── 流星 ───────────────────────────────────────────
  let nextAmbient = 2;
  function spawnAmbient() {
    const f = new THREE.Vector3(); camera.getWorldDirection(f);
    const rt = new THREE.Vector3().crossVectors(f, camera.up).normalize();
    const upv = new THREE.Vector3().crossVectors(rt, f).normalize();
    const D = (1700 + Math.random() * 1700) * clamp(ctl.r / 2300, 0.03, 1.2);
    const side = Math.random() < 0.5 ? -1 : 1;
    const from = camera.position.clone().addScaledVector(f, D).addScaledVector(rt, -side * D * (0.15 + Math.random() * 0.3)).addScaledVector(upv, D * (0.12 + Math.random() * 0.25));
    const pass = camera.position.clone().addScaledVector(f, D * 0.25).addScaledVector(rt, side * D * (0.4 + Math.random() * 0.25)).addScaledVector(upv, -D * (0.05 + Math.random() * 0.15));
    meteors.push(new Meteor(scene, { from, to: from.clone().lerp(pass, 2.6), speed: D * (0.55 + Math.random() * 0.3), color: new THREE.Color(0.84 + Math.random() * 0.1, 0.88 + Math.random() * 0.08, 1), width: D * 0.0016, pool: sparks, life: 6 }));
  }
  function gainMeteor(st, look, delay) {
    setTimeout(() => {
      if (signal.aborted) return;
      const dist = camera.position.distanceTo(st.pos);
      // 从画面的侧上方斜着划进来（屏幕上能看到一整条轨迹），先慢后快地撞进那颗星
      const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const side = Math.random() < 0.5 ? -1 : 1;
      const span = dist * Math.tan((camera.fov * Math.PI) / 360); // 这个深度上半个画面的高度
      const from = st.pos.clone()
        .addScaledVector(right, side * span * (1.1 + Math.random() * 0.5) * camera.aspect)
        .addScaledVector(up, span * (0.9 + Math.random() * 0.5))
        .addScaledVector(fwd, -dist * 0.15);
      const ctrl = from.clone().lerp(st.pos, 0.45).addScaledVector(up, span * 0.35);
      const color = SILVER.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
      meteors.push(new Meteor(scene, { from, to: st.pos, ctrl, duration: 1.7 + Math.random() * 0.5, color, width: Math.max(0.6, dist * 0.0032), pool: sparks,
        onHit: () => {
          if (st.obj) { st.obj.flash = 1.2; st.obj.setLook(look); }
          shocks.push(new Shock(scene, st.pos, color, Math.max(12, dist * 0.13)));
          sparks.burst(st.pos, color, 90, Math.max(6, dist * 0.07), Math.max(1.4, dist * 0.005));
        } }));
    }, delay);
  }

  // ── 背景星的亮度 / 模块光波 / 全亮预览 ───────────────────────
  const chapProg = new Float32Array(96), modProg = new Float32Array(24);
  const waveAt = new Array(24).fill(-1e9);
  let preview = null;
  function chapterTargets() {
    const cp = [], mp = [];
    if (!L || !data) return { cp, mp };
    L.chapters.forEach((cs, i) => { cp[i] = preview ? 1 : clamp(cs.c.max ? cs.c.score / cs.c.max : 0, 0, 1); });
    L.modules.forEach((m, i) => { mp[i] = preview ? 1 : clamp(m.m.max ? m.m.score / m.m.max : 0, 0, 1); });
    return { cp, mp };
  }
  function wave(i, delay = 0) { setTimeout(() => { if (!signal.aborted) waveAt[i] = performance.now(); }, delay); }
  function checkMilestones(first) {
    const saved = jget(MODS_KEY) || {};
    const hits = [];
    L.modules.forEach((m, i) => {
      const p = m.m.max ? m.m.score / m.m.max : 0;
      const lvl = LEVELS.filter((x) => p >= x - 1e-6).length;
      if (lvl > (saved[m.key] || 0)) hits.push({ i, m, lvl });
      saved[m.key] = Math.max(lvl, saved[m.key] || 0);
    });
    jset(MODS_KEY, saved);
    hits.forEach((h, k) => {
      const at = (first ? 3200 : 600) + k * 700;
      wave(h.i, at);
      setTimeout(() => showBanner(`${MOD_SHORT[h.m.name] || h.m.name} 达到 ${Math.round(LEVELS[h.lvl - 1] * 100)}%，这一片星空亮起来了`), at);
    });
  }
  let bannerTimer = null;
  function showBanner(text, sticky = false, action = null) {
    reset(banner, el("span", null, text), action);
    banner.classList.add("sk-on");
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = setTimeout(() => banner.classList.remove("sk-on"), 4200);
  }
  function startPreview() {
    if (!L) return;
    closePop(); closeSheet();
    if (nav.level) go(0);
    preview = { t0: performance.now() };
    root.classList.add("sk-previewing");
    for (const st of L.stars) if (st.obj) st.obj.setLook({ I: 1.08, spikes: 0.9, ring: 0, radius: starRadius(st.leaf.points) });
    // 从星系中心向外，一个模块接一个模块放光波
    L.modules.map((m, i) => ({ i, d: m.center.length() })).sort((a, b) => a.d - b.d).forEach((x, k) => wave(x.i, 600 + k * 260));
    showBanner("预览：全部学会时的星空", true, el("button", { type: "button", class: "sk-banner-btn", onclick: stopPreview }, "退出预览"));
  }
  function stopPreview() {
    if (!preview) return;
    preview = null;
    root.classList.remove("sk-previewing");
    for (const st of L.stars) if (st.obj) st.obj.setLook(lookOf(st.leaf));
    banner.classList.remove("sk-on");
  }

  // ── 标签：平时只留很淡的名字，鼠标移上去才显示分数 ─────────────────
  const labelEls = new Map();
  let rects = [];
  function label(key, cls, html) {
    let e = labelEls.get(key);
    if (!e) { e = el("div", `sk-label ${cls}`); labelEls.set(key, e); labels.append(e); }
    if (e._html !== html) { e.innerHTML = html; e._html = html; e._w = 0; e._h = 0; }
    e._used = true;
    return e;
  }
  function place(e, p, alpha, dy = 0, force = false) {
    const v = p.clone().project(camera);
    if (v.z > 1 || alpha <= 0.01) { e.style.opacity = "0"; return; }
    const x = (v.x * 0.5 + 0.5) * cw, y = (-v.y * 0.5 + 0.5) * ch + dy;
    const w = (e._w ||= Math.max(30, e.offsetWidth || 60)), h = (e._h ||= Math.max(14, e.offsetHeight || 24));
    const r = [x - w / 2 - 6, y - h / 2 - 3, x + w / 2 + 6, y + h / 2 + 3];
    if (!force && (rects.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]) || x < -40 || x > cw + 40 || y < -20 || y > ch + 20)) { e.style.opacity = "0"; return; }
    rects.push(r);
    e.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    e.style.opacity = String(alpha);
  }
  const full = (name, sub) => `<b>${esc(name)}</b><span>${sub}</span>`;
  const only = (name) => `<b>${esc(name)}</b>`;
  function updateLabels() {
    for (const e of labelEls.values()) e._used = false;
    rects = [];
    if (!L || !data || preview) { for (const e of labelEls.values()) e.style.opacity = "0"; return; }
    const lv = nav.level;
    const hv = hoverObj || {};
    if (lv === 0 || lv === 1) for (const so of L.subjects) {
      if (lv === 1 && so.key === nav.subject) continue;
      const on = hv.subject === so.key;
      const e = label(`s:${so.key}`, "sk-label-subj", on ? full(so.short, `${f1(so.sub.score)} / ${so.sub.max}`) : only(so.short));
      place(e, so.chapters[Math.floor(so.chapters.length * 0.72)].center.clone().add(V(0, 70, 0)), on ? 1 : lv === 0 ? 0.42 : 0.18, 0, on);
    }
    if (lv === 1 || lv === 2) {
      const so = L.subjects.find((x) => x.key === nav.subject);
      for (const cs of so.chapters.slice().sort((a, b) => (hv.chapter === b ? 1 : 0) - (hv.chapter === a ? 1 : 0) || b.c.max - a.c.max)) {
        if (lv === 2 && nav.chapter === cs) continue;
        const on = hv.chapter === cs;
        const e = label(`c:${cs.key}`, "sk-label-ch", on ? full(cs.name, `${f1(cs.c.score)} / ${f1(cs.c.max)}`) : only(cs.name));
        place(e, cs.center, on ? 1 : lv === 1 ? 0.3 : 0.14, 22, on);
      }
    }
    if (lv === 2 || lv === 3) {
      for (const st of nav.chapter.stars.slice().sort((a, b) => (hv.star === b ? 1 : 0) - (hv.star === a ? 1 : 0) || b.leaf.points - a.leaf.points)) {
        if (lv === 3 && st === nav.star) continue;
        const l = st.leaf;
        const on = hv.star === st;
        const nm = l.name;
        const e = label(`l:${st.id}`, "sk-label-leaf", on ? full(nm, `${f1(l.score)} / ${f1(l.points)}`) : only(nm));
        place(e, st.pos, on ? 1 : lv === 2 ? 0.34 : 0.12, 24, on);
      }
    }
    if (lv < 2 && hv.star) {
      const l = hv.star.leaf;
      const e = label(`l:${hv.star.id}`, "sk-label-leaf", full(l.name, `${hv.star.chapter.name} · ${f1(l.score)} / ${f1(l.points)}`));
      place(e, hv.star.pos, 1, 24, true);
    }
    if (lv === 3 && planetSys) for (const it of planetSys.items) {
      if (hv.planet !== it.q) continue;
      const e = label(`p:${it.q.id}`, "sk-label-planet", `${esc(it.q.paper)} 第${esc(it.q.number)}题`);
      const wp = new THREE.Vector3(); it.orb.group.getWorldPosition(wp);
      place(e, wp, 1, 18, true);
    }
    for (const [k, e] of labelEls) if (!e._used) { e.remove(); labelEls.delete(k); }
  }

  // ── 拾取与交互 ───────────────────────────────────────
  const ray = new THREE.Raycaster();
  let hoverObj = null;
  const _p = new THREE.Vector3();
  /** 按屏幕距离找最近的星：远处的星也有最小像素，所以全景时也能直接选中单颗星。 */
  function nearest(x, y, list, posOf, radiusOf) {
    let best = null, bd = Infinity;
    for (const it of list) {
      posOf(it, _p);
      _p.project(camera);
      if (_p.z > 1 || _p.z < -1) continue;
      const sx = (_p.x * 0.5 + 0.5) * cw, sy = (-_p.y * 0.5 + 0.5) * ch;
      const d = Math.hypot(sx - x, sy - y);
      if (d < radiusOf(it) && d < bd) { bd = d; best = it; }
    }
    return best;
  }
  function pick(x, y) {
    if (!L) return null;
    ray.setFromCamera(new THREE.Vector2((x / cw) * 2 - 1, -(y / ch) * 2 + 1), camera);
    const lv = nav.level;
    const first = (objs) => { const h = ray.intersectObjects(objs, false); return h.length ? h[0].object.userData : null; };
    if (lv === 3 && planetSys) {
      const it = nearest(x, y, planetSys.items, (i, v) => i.orb.group.getWorldPosition(v), (i) => i.orb.screenRadius(camera) + 8);
      if (it) return { planet: it.q, kind: it.kind };
    }
    const cand = L.stars.filter((st) => (st.obj ? st.obj.dim > 0.15 : true) && !(lv === 3 && st === nav.star));
    const vocabR = () => Math.max(18, 30 / ((2 * camera.position.distanceTo(L.stars.find((q) => q.leaf.vocab)?.pos || V(0, 0, 0)) * Math.tan((camera.fov * Math.PI) / 360)) / ch));
    const st = nearest(x, y, cand, (q, v) => v.copy(q.pos), (q) => (q.obj ? q.obj.screenRadius(camera) + 12 : vocabR()));
    if (st) return { star: st };
    if (lv >= 1) {
      if (lv === 1) { const so = L.subjects.find((x) => x.key === nav.subject); const hs = first(so.chapters.flatMap((c) => c.stars.map((s) => s.hit))); if (hs) return { chapter: hs.star.chapter }; }
      const h = first(hitChapters.filter((m) => m.userData.chapter.subject === nav.subject && m.userData.chapter !== nav.chapter));
      if (h) return { chapter: h.chapter };
    }
    const hc = first(hitChapters.filter((m) => lv === 0 || m.userData.chapter.subject !== nav.subject));
    if (hc) return { subject: hc.chapter.subject };
    return null;
  }
  function onClickPick(h) {
    if (preview) { stopPreview(); return; }
    if (!h) { up(); return; } // 点空白处：回到上一层
    if (h.planet) { showPlanet(h.planet, h.kind); return; }
    if (h.star) { nav.subject = h.star.subject; nav.chapter = h.star.chapter; go(3, { star: h.star }); return; }
    if (h.chapter) { go(2, { chapter: h.chapter }); return; }
    if (h.subject) go(1, { subject: h.subject });
  }
  function showTip(h, x, y) {
    let body = null;
    if (h?.planet) body = [el("b", null, `${h.planet.paper} 第${h.planet.number}题`), el("span", null, `${h.planet.type} · ${h.planet.score || "?"} 分 · ${h.kind === "good" ? "做对过" : h.kind === "bad" ? "做错过" : "还没做"}`)];
    else if (h?.star) { const l = h.star.leaf; body = [el("b", null, l.name), el("span", null, `${f1(l.score)} / ${f1(l.points)} 分${l.vocab ? "" : ` · 掌握 ${pct(l.m)}${l.last ? ` · 记忆 ${pct(l.R)}` : ""}`}`), l.due ? el("em", null, "该复习了") : null]; }
    else if (h?.chapter) body = [el("b", null, h.chapter.name), el("span", null, `${f1(h.chapter.c.score)} / ${f1(h.chapter.c.max)} 分 · ${h.chapter.stars.length} 个考点`)];
    else if (h?.subject) { const s = data.subjects.find((x) => x.key === h.subject); body = [el("b", null, SUBJ[h.subject].short), el("span", null, `${f1(s.score)} / ${s.max} 分`)]; }
    if (!body) { tip.classList.remove("sk-on"); return; }
    reset(tip, ...body);
    tip.style.transform = `translate(${Math.min(cw - 240, x + 18)}px, ${Math.min(ch - 70, y + 18)}px)`;
    tip.classList.add("sk-on");
  }
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); ctl.idle = 0; closePop(); });
  let mouse = null, hoverTick = 0;
  function refreshHover(x, y) {
    const h = pick(x, y);
    hoverObj = h;
    for (const st of L?.stars || []) if (st.obj) st.obj.hover = h?.star === st ? 1 : 0;
    canvas.style.cursor = h ? "pointer" : nav.level ? "zoom-out" : "grab";
    showTip(h, x, y);
  }
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
      if (!fly) { ctl.vt -= dx * 0.0007; ctl.vp -= dy * 0.0007; }
      ctl.idle = 0;
      if (drag.moved > 5) { tip.classList.remove("sk-on"); canvas.style.cursor = "grabbing"; return; }
    }
    const h = pick(e.clientX - r.left, e.clientY - r.top);
    hoverObj = h;
    for (const st of L?.stars || []) if (st.obj) st.obj.hover = h?.star === st ? 1 : 0;
    canvas.style.cursor = h ? "pointer" : nav.level ? "zoom-out" : "grab";
    showTip(h, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener("pointerup", (e) => {
    const r = canvas.getBoundingClientRect();
    const was = drag; drag = null;
    canvas.style.cursor = "grab";
    if (was && was.moved < 6 && !fly) onClickPick(pick(e.clientX - r.left, e.clientY - r.top));
  });
  canvas.addEventListener("pointerleave", () => { tip.classList.remove("sk-on"); hoverObj = null; mouse = null; for (const st of L?.stars || []) if (st.obj) st.obj.hover = 0; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); if (fly) return; ctl.r = clamp(ctl.r * Math.exp(e.deltaY * 0.0012), ctl.min, ctl.max); ctl.idle = 0; }, { passive: false });
  const onKey = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (sheet.classList.contains("sk-on")) closeSheet();
    else if (pop.classList.contains("sk-on")) closePop();
    else if (preview) stopPreview();
    else up();
  };
  window.addEventListener("keydown", onKey);

  function resize() {
    const r = root.getBoundingClientRect();
    cw = Math.max(320, Math.round(r.width)); ch = Math.max(420, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr); renderer.setSize(cw, ch, false);
    composer.setPixelRatio(dpr); composer.setSize(cw, ch);
    camera.aspect = cw / ch; camera.updateProjectionMatrix();
    root.classList.toggle("sk-narrow", cw < 760);
    galaxy.material.uniforms.uPR.value = dpr; galaxy.material.uniforms.uScale.value = ch * 0.9;
    sparks.points.material.uniforms.uPR.value = dpr;
    if (field) field.material.uniforms.uPR.value = dpr;
    if (vocabPts) vocabPts.material.uniforms.uPR.value = dpr;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  // ── 主循环 ─────────────────────────────────────────
  let last = performance.now(), raf = 0, intro = 0, vocabLit = 0;
  const clock0 = performance.now();
  function frame(now) {
    if (signal.aborted) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = (now - clock0) / 1000;
    if (fly) stepFly(now);
    else {
      ctl.idle += dt;
      // 全景：星系一直缓慢自转；指着星的时候停下来，方便点
      if (!reduceMotion() && (nav.level === 0 || ctl.idle > 6)) ctl.vt += nav.level === 0 ? 0.000032 : 0.00002;
      ctl.theta += ctl.vt; ctl.phi = clamp(ctl.phi + ctl.vp, 0.12, Math.PI - 0.12);
      ctl.vt *= 0.9; ctl.vp *= 0.9;
      camFromCtl();
    }
    const lv = nav.level;
    const k = 1 - Math.exp(-dt * (preview ? 0.9 : 0.7));
    {
      const gu = galaxy.material.uniforms;
      const prog = data ? KEYS.map((key) => { const s = data.subjects.find((x) => x.key === key); return preview ? 1 : s ? Math.pow(s.score / s.max, 0.7) : 0; }) : [0, 0, 0, 0];
      const pv = gu.uProg.value;
      pv.x += (prog[0] * intro - pv.x) * k; pv.y += (prog[1] * intro - pv.y) * k; pv.z += (prog[2] * intro - pv.z) * k; pv.w += (prog[3] * intro - pv.w) * k;
      gu.uCore.value += (((preview ? 1 : data ? Math.pow(data.total / 500, 0.7) : 0) * intro) - gu.uCore.value) * k;
      const fv = gu.uFocus.value;
      const foc = KEYS.map((key) => (lv === 0 || nav.subject === key ? 1 : 0.35));
      gu.uBreath.value = 1 + 0.07 * Math.sin(t * 0.55);
      const kf = 1 - Math.exp(-dt * 3);
      fv.x += (foc[0] - fv.x) * kf; fv.y += (foc[1] - fv.y) * kf; fv.z += (foc[2] - fv.z) * kf; fv.w += (foc[3] - fv.w) * kf;
      gu.uTime.value = t;
      // 靠近时把大片柔光雾淡掉，近景才清楚
      gu.uHaze.value += ((lv === 0 ? 1 : lv === 1 ? 0.45 : 0.08) - gu.uHaze.value) * kf;
      sky.material.uniforms.uGlow.value = gu.uCore.value;
      if (field) {
        const fu = field.material.uniforms;
        const { cp, mp } = chapterTargets();
        for (let i = 0; i < cp.length; i++) { chapProg[i] += (cp[i] * intro - chapProg[i]) * k; fu.uChap.value[i] = chapProg[i]; }
        for (let i = 0; i < mp.length; i++) { modProg[i] += (mp[i] * intro - modProg[i]) * k; fu.uMod.value[i] = modProg[i]; fu.uWave.value[i] = (now - waveAt[i]) / 1000; }
        fu.uTime.value = t;
        fu.uBreath.value = 1 + 0.1 * Math.sin(t * 0.55 + 1.2);
      }
    }
    if (L) {
      for (const so of L.subjects) {
        const target = (lv === 0 ? 0.35 : nav.subject === so.key ? (lv === 1 ? 0.5 : 0.15) : 0.06) * (0.35 + 0.65 * Math.min(1, (preview ? 1 : so.sub.score / so.sub.max) * 3 + 0.2)) * intro;
        so.thread.material.uniforms.uA.value += (target - so.thread.material.uniforms.uA.value) * (1 - Math.exp(-dt * 3));
      }
      for (const cs of L.chapters) {
        if (!cs.lines) continue;
        const target = lv >= 2 && nav.chapter === cs ? (lv === 2 ? 0.42 : 0.18) : lv >= 2 && nav.subject === cs.subject ? 0.06 : 0;
        cs.lines.material.opacity += (target - cs.lines.material.opacity) * (1 - Math.exp(-dt * 3));
      }
      for (const st of L.stars) {
        if (!st.obj) continue;
        let dim = 1;
        if (lv >= 1 && st.subject !== nav.subject) dim = 0.4;
        if (lv >= 2 && st.chapter !== nav.chapter) dim = Math.min(dim, 0.5);
        if (lv === 3 && st !== nav.star) dim = Math.min(dim, 0.3);
        const appear = clamp((t - 0.6 - st.delay) / 1.4, 0, 1) * intro;
        st.obj.dim += (dim * appear - st.obj.dim) * (1 - Math.exp(-dt * 4));
        st.obj.closeTo = lv === 3 && st === nav.star ? 1 : 0;
        st.obj.viewH = ch;
        st.obj.update(dt, t, camera);
      }
      if (vocabPts) {
        const u = vocabPts.material.uniforms;
        u.uTime.value = t;
        u.uDim.value += (((lv >= 1 && nav.subject !== "英语") ? 0.4 : 1) * intro - u.uDim.value) * (1 - Math.exp(-dt * 3));
        u.uLit.value += ((preview ? 1 : vocabLit) - u.uLit.value) * (1 - Math.exp(-dt * 1.2));
        vocabPts.rotation.y += dt * 0.05;
      }
    }
    if (planetSys) updatePlanetSys(planetSys, now, dt, t);
    for (let i = leaving.length - 1; i >= 0; i--) {
      const sys = leaving[i];
      const f = 1 - clamp((now - sys.leaving) / 600, 0, 1);
      updatePlanetSys(sys, now, dt, t, f);
      if (f <= 0) { scene.remove(sys.group); sys.items.forEach((it) => { it.orb.dispose(); it.orbit.geometry.dispose(); it.orbit.material.dispose(); }); leaving.splice(i, 1); }
    }
    nextAmbient -= dt;
    if (nextAmbient <= 0 && !reduceMotion()) { nextAmbient = (lv >= 2 ? 6 : 3) + Math.random() * 5; spawnAmbient(); }
    for (let i = meteors.length - 1; i >= 0; i--) { meteors[i].update(dt, camera); if (meteors[i].done) meteors.splice(i, 1); }
    for (let i = shocks.length - 1; i >= 0; i--) if (!shocks[i].update(dt, camera)) shocks.splice(i, 1);
    sparks.update(dt);
    // 星系在转：鼠标不动时也每隔几帧按当前位置重新判断悬停
    if (mouse && !drag && !fly && ++hoverTick % 6 === 0) refreshHover(mouse.x, mouse.y);
    updateLabels();
    composer.render();
  }

  // ── 面板 ───────────────────────────────────────────
  let redo = null;
  const bar = (v, cls = "") => el("div", `sk-bar ${cls}`, el("i", { style: `width:${clamp(v, 0, 1) * 100}%` }));
  const findLeaf = (id) => {
    for (const s of data.subjects) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) if (l.id === id) return { s, m, c, l };
    return null;
  };
  const starOf = (id) => L.stars.find((x) => x.id === id);
  function openPanel(...kids) {
    reset(panel, el("button", { type: "button", class: "sk-x", "aria-label": "收起", onclick: () => closePanel() }, "×"), el("div", "sk-panel-body", ...kids));
    panel.scrollTop = 0;
    root.classList.add("sk-panel-on");
  }
  function closePanel() { root.classList.remove("sk-panel-on"); redo = null; }
  function state(l) {
    if (l.vocab) return [`掌握 ${pct(l.m)}`, l.m >= 0.8 ? "sk-st-good" : l.m >= 0.4 ? "sk-st-mid" : "sk-st-low"];
    if (!l.n) return ["未点亮", "sk-st-off"];
    if (l.due) return ["该复习", "sk-st-due"];
    if (l.real && l.m >= 0.75) return ["真题稳定", "sk-st-good"];
    if (l.real) return ["做过真题", "sk-st-mid"];
    if (l.m >= 0.3) return ["练习中", "sk-st-mid"];
    return ["刚接触", "sk-st-low"];
  }
  const orbDot = (l) => {
    const m = l.n ? (l.now ?? l.m ?? 0) : 0;
    return el("i", { class: `sk-orb${l.due ? " sk-orb-due" : ""}`, style: `--g:${m.toFixed(2)}` });
  };
  const head = (kicker, title, score, max, extra) => el("header", "sk-head",
    el("div", "sk-kicker", kicker),
    el("h3", "sk-title", title, extra),
    el("div", "sk-headline", el("div", "sk-big", el("b", null, f1(score)), el("span", null, ` / ${f1(max).replace(/\.0$/, "")}`)), el("div", "sk-pct", pct(max ? score / max : 0))),
    bar(max ? score / max : 0, "sk-bar-lg"));
  function leafRow(l) {
    const [st, cls] = state(l);
    return el("button", { type: "button", class: "sk-row-btn", onclick: () => { const s = starOf(l.id); if (s) { nav.subject = s.subject; nav.chapter = s.chapter; go(3, { star: s }); } } },
      orbDot(l),
      el("span", "sk-row-name", l.name),
      el("span", `sk-st ${cls}`, st),
      el("span", "sk-row-num", f1(l.score), el("small", null, `/${f1(l.points)}`)),
      bar(l.points ? l.score / l.points : 0, l.due ? "sk-bar-due" : ""));
  }
  function showSubject(key) {
    redo = () => showSubject(key);
    const s = data.subjects.find((x) => x.key === key);
    const so = L.subjects.find((x) => x.key === key);
    const leaves = s.modules.flatMap((m) => m.chapters.flatMap((c) => c.leaves));
    const gain = leaves.filter((l) => !l.vocab).map((l) => ({ ...l, gap: l.points - l.score })).sort((a, b) => b.gap - a.gap).slice(0, 5);
    const due = leaves.filter((l) => l.due && !l.vocab).sort((a, b) => (b.loss || 0) - (a.loss || 0));
    openPanel(
      head("旋臂", s.name, s.score, s.max),
      el("section", "sk-sec",
        el("h4", "sk-h", "模块"),
        ...s.modules.map((m) => el("div", "sk-card",
          el("div", "sk-card-head", el("b", null, MOD_SHORT[m.name] || m.name), el("span", "sk-row-num", f1(m.score), el("small", null, `/${m.max}`))),
          bar(m.max ? m.score / m.max : 0),
          el("div", "sk-card-rows", ...m.chapters.map((c) => el("button", { type: "button", class: "sk-chrow", onclick: () => { const cs = so.chapters.find((x) => x.name === c.name && x.module === m.name); if (cs) go(2, { chapter: cs }); } },
            el("span", "sk-chrow-name", c.name),
            el("span", "sk-chrow-bar", el("i", { style: `width:${c.max ? clamp(c.score / c.max, 0, 1) * 100 : 0}%` })),
            el("span", "sk-row-num", f1(c.score), el("small", null, `/${f1(c.max)}`)))))))),
      due.length ? el("section", "sk-sec", el("h4", "sk-h sk-h-due", `该复习 · ${due.length}`), ...due.slice(0, 8).map(leafRow)) : null,
      el("section", "sk-sec", el("h4", "sk-h", "最值得补"), el("p", "sk-note", "按「分值 − 已拿到的分」排：先补这些，预测分涨得最快。"), ...gain.map(leafRow)));
  }
  function showChapter(cs) {
    redo = () => showChapter(cs);
    const c = cs.c;
    openPanel(
      head(`${SUBJ[cs.subject].short} · ${MOD_SHORT[cs.module] || cs.module}`, cs.name, c.score, c.max),
      el("section", "sk-sec", el("h4", "sk-h", `考点 · ${c.leaves.length}`), ...c.leaves.slice().sort((a, b) => b.points - a.points).map(leafRow)));
  }
  function practiceIds(ids, subject, title) {
    sessionStorage.setItem("ky-exam-preset", JSON.stringify({ mode: "ids", subject, ids, minutes: 0, title }));
    ctx.app.openView("exam");
  }
  function showLeaf(st) {
    if (!st) return;
    redo = () => showLeaf(starOf(st.id) || st);
    const hit = findLeaf(st.id);
    if (!hit) return;
    const { s, l } = hit;
    if (l.vocab) { showVocab(hit); return; }
    const [stt, cls] = state(l);
    const qinfo = el("div", "sk-list");
    const actions = el("div", "sk-actions");
    const forecast = (days) => {
      if (!l.last) return 0;
      const tt = (Date.now() - Date.parse(l.last)) / 86400000 + days;
      return l.points * l.m * (0.6 + 0.4 / (1 + tt / (9 * l.S)));
    };
    openPanel(
      head(`${SUBJ[s.key].short} · ${hit.c.name}`, l.name, l.score, l.points, el("span", `sk-st ${cls}`, stt)),
      el("div", "sk-stats",
        el("div", "sk-stat", el("span", null, "掌握度"), el("b", null, pct(l.m)), el("small", null, l.n ? `${l.n} 条证据${l.real ? ` · 真题 ${l.real}` : ""}` : "还没有证据")),
        el("div", "sk-stat", el("span", null, "记忆保持"), el("b", null, l.last ? pct(l.R) : "—"), el("small", null, l.last ? `稳定约 ${Math.round(l.S)} 天` : "还没学过")),
        el("div", "sk-stat", el("span", null, "历年真题"), el("b", null, `${Math.round(l.realCount || 0)}`), el("small", null, "道左右考到"))),
      el("p", "sk-note", l.last ? (l.due ? `上次学是 ${ago(l.last)}，记忆掉到 ${pct(l.R)}，该复习了。` : `上次学是 ${ago(l.last)}，约 ${fmtDate(l.dueAt)} 该复习。`) + ` 不复习：30 天后约 ${f1(forecast(30))} 分，90 天后约 ${f1(forecast(90))} 分。` : "在会话里学过并结算、或做对练习题和真题后，这颗星会亮起来。"),
      actions,
      el("section", "sk-sec", el("h4", "sk-h", "相关真题"), qinfo),
      el("section", "sk-sec", el("h4", "sk-h", "分数来源"),
        l.evidence?.length ? el("div", "sk-ev", ...l.evidence.slice(0, 20).map((e) => el("div", "sk-ev-row",
          el("span", "sk-ev-date", fmtDate(e.at).slice(5)),
          el("span", `sk-kind sk-k-${e.kind}`, KIND_LABEL[e.kind]),
          el("span", "sk-ev-label", e.label, e.note ? el("small", null, e.note) : null),
          el("b", e.delta >= 0 ? "sk-up" : "sk-down", `${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(2)}`)))) : el("p", "sk-note", "还没有记录。")));
    put(actions, btn("复制学习开场白", async () => {
      const text = l.n ? `${l.name}（复习，按考研难度直接练真题考法）` : `【学习】${l.name}`;
      toast(root, (await copy(text)) ? `已复制：${text}` : text);
    }, "sk-btn"));
    ctx.call("score.questions", { leaf: l.id, limit: 10 }).then((r) => {
      if (!r.total) { reset(qinfo, el("p", "sk-note", "题库里没有归到这个考点的真题。可以开练习会话让 AI 按真题难度出题。")); return; }
      actions.prepend(btn("用真题练这个考点", () => practiceIds(r.items.slice(0, 8).map((x) => x.id), s.key, `真题 · ${l.name}`), "sk-btn sk-btn-primary"));
      reset(qinfo, el("p", "sk-note", `题库里 ${r.total} 道，做过 ${r.done} 道。`),
        ...r.items.map((q) => { const kind = q.done ? (q.lastCorrect ? "good" : "bad") : "todo"; return el("button", { type: "button", class: "sk-row-btn sk-q", onclick: () => showPlanet(q, kind) },
          el("i", `sk-orb sk-orb-${kind}`), el("span", "sk-row-name", `${q.paper} 第${q.number}题`), el("span", "sk-row-num", `${q.type} · ${q.score || "?"}分`)); }));
    }, () => reset(qinfo));
  }
  function showPlanet(q, kind) {
    const st = nav.star;
    openPanel(
      st ? el("button", { type: "button", class: "sk-link", onclick: () => showLeaf(st) }, `← ${st.leaf.name}`) : null,
      el("header", "sk-head", el("div", "sk-kicker", "相关真题"), el("h3", "sk-title", `${q.paper} 第${q.number}题`)),
      el("div", "sk-stats",
        el("div", "sk-stat", el("span", null, "题型"), el("b", null, q.type), el("small", null, "")),
        el("div", "sk-stat", el("span", null, "分值"), el("b", null, `${q.score || "?"}`), el("small", null, "分")),
        el("div", "sk-stat", el("span", null, "状态"), el("b", null, kind === "good" ? "做对过" : kind === "bad" ? "做错过" : "没做"), el("small", null, kind === "good" ? "亮着" : kind === "bad" ? "泛着暖光" : "暗的"))),
      el("div", "sk-actions", btn("开练这道", () => practiceIds([q.id], (st?.id || "").split("/")[0], `${q.paper} 第${q.number}题`), "sk-btn sk-btn-primary")),
      el("p", "sk-note", "在快练里作答判分后，这颗小星和中间的星都会跟着更新。"));
  }
  function showVocab({ l, c }) {
    const v = l.vocab;
    const out = el("div");
    const words = l.words || [];
    const todo = l.todo || [];
    openPanel(
      head("英语一 · 词汇", l.name, l.score, l.points),
      el("p", "sk-note", `${l.desc || ""} 这一档固定 ${l.size} 个词，每个词归哪一档不会变；背得越多、记得越牢，这颗星越亮。`),
      el("div", "sk-stats",
        el("div", "sk-stat", el("span", null, "这一档"), el("b", null, `${l.size}`), el("small", null, "个词")),
        el("div", "sk-stat", el("span", null, "已背"), el("b", null, `${l.learnedN}`), el("small", null, l.basicN ? `另有 ${l.basicN} 个初中词按会计` : "在墨墨里背过")),
        el("div", "sk-stat", el("span", null, "掌握度"), el("b", null, pct(l.m)), el("small", null, "按每个词记住的概率"))),
      words.length ? el("section", "sk-sec", el("h4", "sk-h", "背过但记得最弱的"),
        el("div", "sk-words", ...words.map((w) => el("span", { class: "sk-word", style: `--r:${w.R}` }, w.s, el("small", null, pct(w.R)))))) : null,
      todo.length ? el("section", "sk-sec", el("h4", "sk-h", "还没背的（按真题出现次数排）"),
        el("div", "sk-words", ...todo.map((w) => el("span", { class: "sk-word sk-word-todo", style: "--r:0" }, w.s, w.f ? el("small", null, `${w.f}次`) : null)))) : null,
      el("section", "sk-sec", el("h4", "sk-h", "整体词汇"),
        el("div", "sk-stats",
          el("div", "sk-stat", el("span", null, "已背"), el("b", null, `${v.learned}`), el("small", null, `考研词表 ${v.target} 词`)),
          el("div", "sk-stat", el("span", null, "有效词汇"), el("b", null, `${v.effective}`), el("small", null, "按记住的概率加总")),
          el("div", "sk-stat", el("span", null, "词汇分"), el("b", null, f1(c.score)), el("small", null, "/ 15")))),
      el("p", "sk-note", v.local ? "还没接墨墨：现在用的是插件自己的生词本。" : `今天墨墨要背 / 复习 ${v.due} 个词${v.progress ? `（进度 ${v.progress.finished}/${v.progress.total}）` : ""}。上次同步 ${v.at ? new Date(v.at).toLocaleString() : "—"}${v.error ? `，出错：${v.error}` : ""}。`),
      el("div", "sk-actions", btn("立即同步墨墨", async () => {
        try { const job = await ctx.call("momo.sync"); reset(out, el("p", "sk-note", "同步中（约 30 秒）…")); const r = await waitJob(ctx, job); reset(out, el("p", "sk-note", `已同步 ${r.words} 个词`)); load(true); }
        catch (err) { reset(out, errorBox(err)); }
      }, "sk-btn sk-btn-primary")),
      out);
  }
  function showReview() {
    redo = showReview;
    openPanel(
      el("header", "sk-head", el("div", "sk-kicker sk-due-c", "外圈泛起琥珀色光环的星"), el("h3", "sk-title", `该复习了 · ${data.reviewCount}`)),
      el("p", "sk-note", "记忆保持率掉到 85% 以下的考点，按「再不复习会丢多少分」排序。复习成功一次，稳定度会翻倍，以后掉得更慢。"),
      data.review.length ? el("div", "sk-list", ...data.review.map((x) => { const h = findLeaf(x.id); return h ? leafRow(h.l) : null; })) : el("p", "sk-note", "现在没有需要复习的考点。"));
  }

  // ── 问号弹层：怎么读、全亮预览、高级 ──────────────────────
  function closePop() { pop.classList.remove("sk-on"); }
  function openPop() {
    const fi = data.frameInfo;
    const out = el("div");
    reset(pop,
      el("div", "sk-pop-h", "怎么读这片星系"),
      el("div", "sk-legend",
        el("div", "sk-legend-row", el("span", "sk-legend-orbs", el("i", { class: "sk-orb", style: "--g:0" }), el("i", { class: "sk-orb", style: "--g:.45" }), el("i", { class: "sk-orb", style: "--g:1" })), el("span", null, "星的亮度＝掌握程度")),
        el("div", "sk-legend-row", el("span", "sk-legend-orbs", el("i", { class: "sk-orb sk-orb-due", style: "--g:.5" })), el("span", null, "外圈琥珀色光环＝记忆在掉，该复习")),
        el("div", "sk-legend-row", el("span", "sk-legend-orbs", el("i", { class: "sk-orb sk-orb-s", style: "--g:.6" }), el("i", { class: "sk-orb sk-orb-l", style: "--g:.6" })), el("span", null, "球越大，这个考点分值越高")),
        el("div", "sk-legend-row", el("span", "sk-legend-orbs sk-legend-dust"), el("span", null, "背景星跟着所在章节变亮；模块到 60% / 80% / 100% 时那片天空放一圈光波"))),
      el("p", "sk-pop-p", "四条旋臂是四科，旋臂上的星座是章节，星座里的星是考点。每个考点的分＝分值 × 掌握度 × 记忆保持。掌握度来自会话结算（讲解最多 40%、练习最多 70%）和真题（最多 90%，隔 3 天再做对到 100%）；不复习会慢慢掉，最多掉到 60%。"),
      el("div", "sk-pop-actions", btn("预览全部点亮", startPreview, "sk-btn sk-btn-primary"), btn("刷新数据", () => { closePop(); load(true); }, "sk-btn")),
      el("details", "sk-pop-adv",
        el("summary", null, "高级 · 真题考点归类"),
        el("p", "sk-pop-p", `每道真题要先归到考点上，才能算出每个考点值多少分、刷题时给哪颗星加分。现在按题目自带的考点标签做关键词匹配（${fi.mapped}/${fi.total} 道归上了），偶尔会归错；让 AI 逐题看题干重新归一遍会更准，分值和加分都会跟着变准。约 70 次便宜模型调用，可以中途停下、下次接着来。`),
        el("div", "sk-pop-actions", btn(fi.aiCount ? `已归 ${fi.aiCount} 道 · 补归新题` : "用 AI 重新归类", async () => {
          try {
            const job = await ctx.call("score.classify", {});
            const msg = el("p", "sk-pop-p", "开始…"); reset(out, msg);
            const r = await waitJob(ctx, job, (j) => { msg.textContent = `${j.message || "归类中"}${j.total ? `（${j.done}/${j.total}）` : ""}`; });
            reset(out, el("p", "sk-pop-p", `完成：${r.mapped}/${r.total} 道已归类。`)); load(true);
          } catch (err) { reset(out, errorBox(err)); }
        }, "sk-btn")), out));
    pop.classList.add("sk-on");
  }

  // ── 学习情况：三张图 ─────────────────────────────────
  const SVGNS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); kids.forEach((c) => c && n.append(c)); return n; };
  const txt = (s) => document.createTextNode(String(s));
  let sheetTab = "trend", sheetSub = "数学";
  function closeSheet() { sheet.classList.remove("sk-on"); }
  function openSheet(tab) {
    if (tab) sheetTab = tab;
    closePop();
    const tabs = [["trend", "分数走势"], ["chapters", "章节掌握"], ["daily", "每日学习"]];
    const body = el("div", "sk-sheet-body");
    reset(sheet, el("div", "sk-sheet-card",
      el("div", "sk-sheet-top",
        el("div", "sk-seg", ...tabs.map(([k, n]) => el("button", { type: "button", class: `sk-seg-b${k === sheetTab ? " sk-on" : ""}`, onclick: () => openSheet(k) }, n))),
        el("button", { type: "button", class: "sk-x sk-x-inline", "aria-label": "关闭", onclick: closeSheet }, "×")),
      body));
    sheet.classList.add("sk-on");
    put(body, sheetTab === "trend" ? trendChart() : sheetTab === "chapters" ? chapterChart() : heatmap());
  }
  function trendChart() {
    const h = data.history;
    const W = 760, H = 300, P = { l: 40, r: 96, t: 18, b: 30 };
    const n = h.length;
    const p = data.projection;
    const maxY = Math.max(10, ...h.map((x) => x.total)) * 1.25;
    const X = (i) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r);
    const Y = (v) => H - P.b - (Math.min(v, maxY) / maxY) * (H - P.t - P.b);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "sk-chart" });
    for (let i = 0; i <= 4; i++) { const v = (maxY / 4) * i; g.append(svg("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: "sk-gridline" }), svg("text", { x: P.l - 8, y: Y(v) + 4, class: "sk-axis", "text-anchor": "end" }, txt(Math.round(v)))); }
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => { if (h[i]) g.append(svg("text", { x: X(i), y: H - 8, class: "sk-axis", "text-anchor": "middle" }, txt(h[i].day.slice(5)))); });
    const line = (vals, cls, w) => svg("path", { d: vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" "), class: cls, "stroke-width": w, pathLength: 1 });
    g.append(svg("path", { d: `M${X(0)} ${Y(0)} ${h.map((x, i) => `L${X(i).toFixed(1)} ${Y(x.total).toFixed(1)}`).join(" ")} L${X(n - 1)} ${Y(0)} Z`, class: "sk-area" }));
    KEYS.forEach((key) => g.append(line(h.map((x) => x.subjects[key] || 0), `sk-line sk-line-${SUBJ[key].arm}`, 1.2)));
    g.append(line(h.map((x) => x.total), "sk-line sk-line-total", 2));
    const lastY = Y(h[n - 1].total);
    g.append(svg("circle", { cx: X(n - 1), cy: lastY, r: 3.5, class: "sk-dot-now" }));
    g.append(svg("line", { x1: X(n - 1), y1: lastY, x2: W - P.r + 30, y2: Y(p.value), class: "sk-proj-line" }));
    g.append(svg("text", { x: W - P.r + 34, y: Y(p.value) + 4, class: "sk-axis sk-axis-strong" }, txt(`考试日 ${Math.round(p.value)}${p.value > maxY ? "↑" : ""}`)));
    const legend = el("div", "sk-chart-legend", el("span", "sk-lg sk-lg-total", "总分"), ...KEYS.map((k) => el("span", `sk-lg sk-lg-${SUBJ[k].arm}`, SUBJ[k].short)));
    const readout = el("div", "sk-readout", "移动鼠标查看每天的分数");
    const cursor = svg("line", { x1: 0, x2: 0, y1: P.t, y2: H - P.b, class: "sk-cursor" });
    g.append(cursor);
    g.addEventListener("pointermove", (e) => {
      const r = g.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const i = clamp(Math.round(((x - P.l) / (W - P.l - P.r)) * (n - 1)), 0, n - 1);
      cursor.setAttribute("x1", X(i)); cursor.setAttribute("x2", X(i)); cursor.style.opacity = 1;
      reset(readout, el("b", null, h[i].day), `  总分 ${f1(h[i].total)}`, ...KEYS.map((k) => `  ·  ${SUBJ[k].short} ${f1(h[i].subjects[k] || 0)}`));
    });
    return el("div", null,
      el("div", "sk-sheet-head", el("div", null, el("div", "sk-kicker", `最近 ${n} 天`), el("div", "sk-sheet-title", `现在 ${f1(data.total)} 分 · 考试那天约 ${Math.round(p.value)} 分`)), legend),
      g, readout,
      el("p", "sk-note", `预测按最近 14 天的净增速外推（区间 ${Math.round(p.low)}–${Math.round(p.high)}）；不学了只剩约 ${Math.round(p.idle)} 分。`));
  }
  function chapterChart() {
    const s = data.subjects.find((x) => x.key === sheetSub);
    const rows = s.modules.flatMap((m) => m.chapters.map((c) => ({ m, c })));
    const maxC = Math.max(...rows.map((r) => r.c.max));
    const so = L.subjects.find((x) => x.key === sheetSub);
    return el("div", null,
      el("div", "sk-sheet-head",
        el("div", null, el("div", "sk-kicker", "已拿到 / 分值"), el("div", "sk-sheet-title", `${s.name} · ${f1(s.score)} / ${s.max}`)),
        el("div", "sk-seg sk-seg-sm", ...KEYS.map((k) => el("button", { type: "button", class: `sk-seg-b${k === sheetSub ? " sk-on" : ""}`, onclick: () => { sheetSub = k; openSheet("chapters"); } }, SUBJ[k].short)))),
      el("div", "sk-hbars", ...rows.map(({ m, c }, i) => el("button", { type: "button", class: "sk-hbar", style: `--d:${i * 25}ms`, onclick: () => { closeSheet(); const cs = so.chapters.find((x) => x.name === c.name && x.module === m.name); if (cs) { nav.subject = sheetSub; go(2, { chapter: cs }); } } },
        el("span", "sk-hbar-name", c.name, el("small", null, MOD_SHORT[m.name] || m.name)),
        el("span", "sk-hbar-cell", el("span", { class: "sk-hbar-track", style: `width:${(c.max / maxC) * 100}%` }, el("i", { style: `width:${c.max ? clamp(c.score / c.max, 0, 1) * 100 : 0}%` }))),
        el("span", "sk-row-num", f1(c.score), el("small", null, `/${f1(c.max)}`))))),
      el("p", "sk-note", "条的长度是这一章的分值（越长越重要），亮的部分是已经拿到的分。点一行直接飞到那个星座。"));
  }
  function heatmap() {
    const daily = data.daily || {};
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 25 * 7);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 从周一开始
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const cells = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) cells.push({ day: key(d), wd: (d.getDay() + 6) % 7, ...(daily[key(d)] || { n: 0, gain: 0 }) });
    const maxN = Math.max(1, ...cells.map((c) => c.n));
    const S = 15, G = 4;
    const cols = Math.ceil(cells.length / 7);
    const W = 30 + cols * (S + G), H = 7 * (S + G) + 22;
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "sk-heat" });
    ["一", "", "三", "", "五", "", "日"].forEach((t, i) => t && g.append(svg("text", { x: 0, y: 22 + i * (S + G) + S - 4, class: "sk-axis" }, txt(t))));
    const readout = el("div", "sk-readout", "移动鼠标查看每天学了多少");
    let lastMonth = -1;
    cells.forEach((c, i) => {
      const col = Math.floor(i / 7);
      const x = 30 + col * (S + G), y = 20 + c.wd * (S + G);
      const m = Number(c.day.slice(5, 7));
      if (c.wd === 0 && m !== lastMonth) { lastMonth = m; g.append(svg("text", { x, y: 12, class: "sk-axis" }, txt(`${m}月`))); }
      const lvl = c.n ? 0.25 + 0.75 * Math.sqrt(c.n / maxN) : 0;
      const rect = svg("rect", { x, y, width: S, height: S, rx: 4, class: `sk-hcell${c.n ? " sk-hcell-on" : ""}`, style: `--l:${lvl.toFixed(2)};animation-delay:${col * 14}ms` });
      rect.addEventListener("pointerenter", () => reset(readout, el("b", null, c.day), c.n ? `  ·  ${c.n} 条学习记录  ·  预测分 +${f1(c.gain)}` : "  ·  没有学习记录"));
      g.append(rect);
    });
    const active = cells.filter((c) => c.n).length;
    let streak = 0; for (let i = cells.length - 1; i >= 0 && cells[i].n; i--) streak++;
    const gain = cells.reduce((a, c) => a + c.gain, 0);
    return el("div", null,
      el("div", "sk-sheet-head", el("div", null, el("div", "sk-kicker", "最近半年"), el("div", "sk-sheet-title", "每天的学习记录")),
        el("div", "sk-mini-stats", el("div", null, el("b", null, `${active}`), el("span", null, "学习天数")), el("div", null, el("b", null, `${streak}`), el("span", null, "连续天数")), el("div", null, el("b", null, `+${f1(gain)}`), el("span", null, "累计加分")))),
      el("div", "sk-heat-wrap", g), readout,
      el("p", "sk-note", "一格是一天，越亮学得越多（会话结算的考点、做的题、错题重做都算）。"));
  }

  // ── HUD ─────────────────────────────────────────────
  function countUp(node, from, to, ms = 1600) {
    if (reduceMotion() || from === to) { node.textContent = f1(to); return; }
    const t0 = performance.now();
    const step = (t) => { if (signal.aborted) return; const p = clamp((t - t0) / ms, 0, 1); node.textContent = f1(from + (to - from) * ease(p)); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  let shownTotal = null;
  function renderHud(prevTotal) {
    const p = data.projection;
    const num = el("b", "sk-total", f1(prevTotal ?? data.total));
    reset(scoreBox,
      el("div", "sk-score-k", "现在去考 · 预计"),
      el("div", "sk-score-line", num, el("span", "sk-max", "/ 500")),
      el("div", "sk-proj", el("span", null, "考试那天"), el("b", null, Math.round(p.value)), el("span", null, `${Math.round(p.low)}–${Math.round(p.high)}`)));
    countUp(num, prevTotal ?? data.total, data.total);
    reset(tools,
      data.reviewCount ? el("button", { type: "button", class: "sk-pill sk-pill-due", onclick: showReview }, el("i"), `该复习 ${data.reviewCount}`) : null,
      el("button", { type: "button", class: "sk-pill", onclick: () => openSheet() }, "学习情况"),
      el("button", { type: "button", class: "sk-pill sk-pill-icon", "aria-label": "怎么读", onclick: (e) => { e.stopPropagation(); pop.classList.contains("sk-on") ? closePop() : openPop(); } }, "?"));
    reset(dock, ...data.subjects.map((s) => el("button", { type: "button", class: "sk-chip", style: `--c:${SUBJ[s.key].css}`, onclick: () => go(1, { subject: s.key }) },
      el("span", "sk-chip-name", SUBJ[s.key].short), el("span", "sk-chip-num", el("b", null, f1(s.score)), `/${s.max}`), bar(s.score / s.max))));
    const ev = [];
    for (const s of data.subjects) for (const m of s.modules) for (const c of m.chapters) for (const l of c.leaves) for (const e of l.evidence || []) ev.push({ ...e, leaf: l });
    ev.sort((a, b) => (a.at < b.at ? 1 : -1));
    const grouped = [];
    for (const e of ev) { const pv = grouped[grouped.length - 1]; if (pv && pv.leaf.id === e.leaf.id && dayStart(pv.at) === dayStart(e.at) && pv.kind === e.kind) { pv.delta += e.delta; pv.count++; } else grouped.push({ ...e, count: 1 }); }
    const recent = grouped.filter((e) => Math.abs(e.delta) >= 0.05).slice(0, 5);
    reset(feed, recent.length ? el("div", "sk-feed-h", el("i"), `最近 ${recent.length} 次变化`) : null,
      el("div", "sk-feed-list", ...recent.map((e) => el("button", { type: "button", class: "sk-feed-row", onclick: () => { const st = starOf(e.leaf.id); if (st) { nav.subject = st.subject; nav.chapter = st.chapter; go(3, { star: st }); } } },
        el("b", e.delta >= 0 ? "sk-up" : "sk-down", `${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(1)}`),
        el("span", null, e.leaf.name),
        el("small", null, `${KIND_LABEL[e.kind]}${e.count > 1 ? ` ×${e.count}` : ""} · ${ago(e.at)}`)))));
  }
  document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target) && !tools.contains(e.target)) closePop(); }, { signal });
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  // ── 数据 ───────────────────────────────────────────
  let loading = false, lastSig = "", targets = {};
  async function load(force = false) {
    if (loading) return;
    loading = true;
    try {
      const d = await ctx.call("score.overview");
      if (signal.aborted) return;
      const sig = JSON.stringify([d.total, d.projection.value, d.reviewCount, d.subjects.map((s) => s.modules.map((m) => m.chapters.map((c) => c.leaves.map((l) => l.score))))]);
      if (data && sig === lastSig && !force) return;
      lastSig = sig;
      const first = !data;
      data = d;
      if (first) build(d);
      for (const st of L.stars) st.leaf = findLeaf(st.id)?.l || st.leaf;
      for (const so of L.subjects) so.sub = d.subjects.find((x) => x.key === so.key);
      for (const cs of L.chapters) { const s = d.subjects.find((x) => x.key === cs.subject); const m = s.modules.find((x) => x.name === cs.module); cs.m = m; cs.c = m.chapters.find((x) => x.name === cs.name) || cs.c; }
      for (const m of L.modules) { const s = d.subjects.find((x) => x.key === m.subject); m.m = s.modules.find((x) => x.name === m.name) || m.m; }
      vocabLit = d.vocab?.mastery || 0;
      const seen = jget(SEEN_KEY);
      let delay = 0;
      for (const st of L.stars) {
        const l = st.leaf;
        const target = l.now ?? 0;
        const look = lookOf(l);
        const was = st.id in targets ? targets[st.id] : seen?.leaves?.[st.id];
        if (first) {
          st.delay = st.pos.length() / 420 + Math.random() * 0.4;
          if (was != null && target > was + 0.004 && !reduceMotion()) { st.obj.setLook(lookOf({ ...l, now: was, m: was, due: false }), true); gainMeteor(st, look, 4000 + delay); delay += 320; }
          else st.obj.setLook(look, true);
        } else if (was != null && target > was + 0.004 && !reduceMotion() && !preview) { gainMeteor(st, look, delay); delay += 320; }
        else if (!preview) st.obj.setLook(look);
      }
      targets = Object.fromEntries(L.stars.map((s) => [s.id, s.leaf.now ?? 0]));
      jset(SEEN_KEY, { total: d.total, leaves: targets });
      renderHud(first ? (seen?.total ?? 0) : shownTotal);
      shownTotal = d.total;
      checkMilestones(first);
      if (first) {
        resize(); renderCrumbs(); renderHint();
        root.dataset.level = "0";
        flyTo(0, reduceMotion() ? 1 : 3800);
        veil.classList.add("sk-off");
        const t0 = performance.now();
        const fade = (t) => { if (signal.aborted) return; intro = clamp((t - t0) / 2600, 0, 1); if (intro < 1) requestAnimationFrame(fade); };
        requestAnimationFrame(fade);
      }
      if (redo && root.classList.contains("sk-panel-on")) { const top = panel.scrollTop; redo(); panel.scrollTop = top; }
      if (sheet.classList.contains("sk-on")) openSheet();
    } catch (err) {
      if (!data) reset(veil, errorBox(err)); else toast(root, err.message, "error");
    } finally { loading = false; }
  }

  resize();
  raf = requestAnimationFrame(frame);
  load();
  let timer = null;
  const off = ctx.onNotification((n) => {
    if (n.topic !== "changed" || !["score", "mistakes", "bank", "vocab"].includes(n.data?.what)) return;
    clearTimeout(timer); timer = setTimeout(() => load(), 600);
  });
  signal.addEventListener("abort", () => {
    off(); clearTimeout(timer); cancelAnimationFrame(raf); ro.disconnect();
    window.removeEventListener("keydown", onKey);
    for (const m of meteors) m.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
    msaa.dispose();
    renderer.dispose(); renderer.forceContextLoss?.();
  });
}
