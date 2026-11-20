// 分数星空 · 3D 场景的渲染部件：天穹星云、背景星、彗星、科目星云、考点恒星、行星、流星。
import * as THREE from "../vendor/three.module.min.js";

// ── 通用 GLSL：3D simplex 噪声 + fbm ───────────────────────────
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<5;i++){f+=a*snoise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=0.5;}return f*0.5+0.5;}
float fbm3(vec3 p){float f=0.0,a=0.5;for(int i=0;i<3;i++){f+=a*snoise(p);p=p*2.07+vec3(4.1,1.3,7.7);a*=0.5;}return f*0.5+0.5;}
`;

// ── 黑体辐射色（开尔文 → 线性 RGB，Tanner Helland 近似） ──────────
export function kelvin(T) {
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  const c = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2);
  const col = new THREE.Color(c(r), c(g), c(b));
  // 真实色温偏淡，画面里稍微提一点饱和度，冷暖更好分辨
  const hsl = {}; col.getHSL(hsl);
  col.setHSL(hsl.h, Math.min(1, hsl.s * 1.35 + 0.05), hsl.l);
  return col;
}

export function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── 天穹：新海诚式的深蓝紫夜空 + 银河 + 暖色星系核 + 暗尘带 ─────────
// 柔和的月面：大片暗色月海 + 稀疏的圆形环形山，对比度很低，不像贴图
export const MOON = /* glsl */ `
vec3 hash33(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453); }
float craters(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); float c = 0.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g = vec3(float(x),float(y),float(z)); vec3 o = hash33(i+g);
    if (o.z < 0.45) continue;
    float r = 0.16 + 0.22*o.x; float d = length(g + o - f);
    c += -0.45*smoothstep(r, r*0.55, d) + 0.3*exp(-pow((d - r)/(r*0.2), 2.0));
  }
  return c;
}
float moonAlbedo(vec3 n, float seed){
  float maria = smoothstep(0.45, 0.66, fbm3(n*1.4 + seed));
  float a = 0.8 - 0.2*maria + 0.05*fbm3(n*5.0 + seed);
  a += 0.07*craters(n*2.8 + seed) + 0.035*craters(n*6.5 + seed*1.7);
  return clamp(a, 0.0, 1.1);
}`;

// ── 天穹：近乎全黑的深空，只在学得越多时泛出一点点深蓝 ───────────────
export function makeSkydome() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uGlow: { value: 0 } },
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `${NOISE}
      varying vec3 vDir; uniform float uGlow;
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = mix(vec3(0.0035,0.004,0.009), vec3(0.007,0.008,0.016), smoothstep(-0.7,0.9,d.y));
        col += vec3(0.010,0.012,0.022) * pow(fbm3(d*1.8 + vec3(3.0,1.0,7.0)), 2.0) * (0.3 + uGlow);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(14000, 64, 32), mat);
  mesh.renderOrder = -10;
  return mesh;
}

// ── 螺旋星系的星尘：四条旋臂各对应一科，亮度跟着这一科的分数；中心核球跟着总分 ─────
export const ARM_TINT = [[0.86, 0.9, 1.0], [0.84, 0.97, 0.95], [1.0, 0.95, 0.88], [0.98, 0.9, 0.95]];
export function galaxyPoint(arm, t, R = 1150) {
  const r = 150 + t * (R - 150);
  const th = arm * Math.PI / 2 + 0.35 + t * 3.1;
  return new THREE.Vector3(Math.cos(th) * r, 0, Math.sin(th) * r);
}
export function makeGalaxy(R = 1150) {
  const r = rng("galaxy");
  const gauss = () => (r() + r() + r() + r() - 2) / 2;
  const pts = [];
  for (let arm = 0; arm < 4; arm++) {
    for (let i = 0; i < 2600; i++) {
      const t = Math.pow(r(), 0.85);
      const p = galaxyPoint(arm, t, R);
      const w = 55 + 120 * t;
      const radial = p.clone().normalize();
      p.addScaledVector(radial, gauss() * w).add(new THREE.Vector3(gauss() * w * 0.5, gauss() * (14 + 10 * (1 - t)), gauss() * w * 0.5));
      pts.push([p, arm, 0.6 + r() * 1.6, 0, r()]);
    }
    for (let i = 0; i < 160; i++) { // 旋臂上的柔光
      const t = r();
      const p = galaxyPoint(arm, t, R).add(new THREE.Vector3(gauss() * 40, gauss() * 10, gauss() * 40));
      pts.push([p, arm, 90 + r() * 120, 1, r()]);
    }
  }
  for (let i = 0; i < 5000; i++) { // 旋臂之间的稀薄星盘，按方位归到最近的那条旋臂
    const rr = 150 + Math.sqrt(r()) * (R - 150);
    const th = r() * Math.PI * 2;
    const t = (rr - 150) / (R - 150);
    let best = 0, bd = 9;
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.35 + t * 3.1; const d = Math.abs(Math.atan2(Math.sin(th - a), Math.cos(th - a))); if (d < bd) { bd = d; best = k; } }
    pts.push([new THREE.Vector3(Math.cos(th) * rr, gauss() * 18, Math.sin(th) * rr), best, 0.5 + r() * 1.1, 0, r()]);
  }
  for (let i = 0; i < 2600; i++) { // 核球
    const v = new THREE.Vector3(gauss(), gauss() * 0.35, gauss()).multiplyScalar(170);
    pts.push([v, 4, 0.6 + r() * 1.4, 0, r()]);
  }
  for (let i = 0; i < 40; i++) pts.push([new THREE.Vector3(gauss() * 60, gauss() * 20, gauss() * 60), 4, 160 + r() * 160, 1, r()]);
  const N = pts.length;
  const pos = new Float32Array(N * 3), arm = new Float32Array(N), size = new Float32Array(N), haze = new Float32Array(N), rnd = new Float32Array(N);
  pts.forEach(([p, a, s, h, q], i) => { pos.set([p.x, p.y, p.z], i * 3); arm[i] = a; size[i] = s; haze[i] = h; rnd[i] = q; });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("arm", new THREE.BufferAttribute(arm, 1));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  g.setAttribute("haze", new THREE.BufferAttribute(haze, 1));
  g.setAttribute("rnd", new THREE.BufferAttribute(rnd, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uBreath: { value: 1 }, uHaze: { value: 1 }, uProg: { value: new THREE.Vector4() }, uCore: { value: 0 }, uFocus: { value: new THREE.Vector4(1, 1, 1, 1) }, uTime: { value: 0 }, uPR: { value: 1 }, uScale: { value: 800 },
      uTint: { value: ARM_TINT.map((c) => new THREE.Vector3(...c)) } },
    vertexShader: /* glsl */ `
      attribute float arm; attribute float size; attribute float haze; attribute float rnd;
      uniform float uBreath; uniform float uHaze; uniform vec4 uProg; uniform float uCore; uniform vec4 uFocus; uniform float uTime; uniform float uPR; uniform float uScale; uniform vec3 uTint[4];
      varying vec3 vC; varying float vA; varying float vH;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        float d = max(-mv.z, 1.0);
        int a = int(arm + 0.5);
        float prog = a == 0 ? uProg.x : a == 1 ? uProg.y : a == 2 ? uProg.z : a == 3 ? uProg.w : uCore;
        float foc = a == 0 ? uFocus.x : a == 1 ? uFocus.y : a == 2 ? uFocus.z : a == 3 ? uFocus.w : 1.0;
        vec3 tint = a < 4 ? uTint[a] : vec3(0.95,0.95,1.0);
        vC = mix(vec3(0.9,0.92,1.0), tint, 0.45);
        // 还没学：几乎看不见；学得越多越亮
        float b = 0.018 + 0.6 * prog;
        float tw = 0.75 + 0.25*sin(uTime*(0.5 + rnd*2.0) + rnd*40.0);
        vA = b * foc * uBreath * (haze > 0.5 ? 0.045 * uHaze : tw * 0.9);
        vH = haze;
        float s = haze > 0.5 ? size * uScale / d : size * clamp(2000.0 / d, 0.8, 3.5);
        gl_PointSize = min(s * uPR, 700.0 * uPR);
        vA *= haze > 0.5 ? smoothstep(size * 0.3, size * 1.5, d) : 1.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA; varying float vH;
      void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = vH > 0.5 ? exp(-d*d*3.0) * smoothstep(1.0, 0.6, d) : exp(-d*d*11.0) * smoothstep(1.0, 0.5, d);
        a *= vA;
        gl_FragColor = vec4(vC * a, 1.0); // 加法混合，alpha 设 1，避免亮度被平方压暗
      }`,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

// ── 考点星：发光水晶球。外层是带菲涅尔边缘光、高光和折射亮带的玻璃壳，里面悬着一颗光核；
//    没点亮时是一颗暗暗的空玻璃球，掌握越好光核越大越亮，把整颗球点亮。 ─────────
const SPHERE = new THREE.SphereGeometry(1, 72, 48);
const QUAD = new THREE.PlaneGeometry(1, 1);
const glassVS = /* glsl */ `varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main(){ vN = normalize(normalMatrix*normal); vP = position; vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`;
const glassFS = /* glsl */ `
  uniform vec3 uColor; uniform float uI; uniform float uTime; uniform float uFlash; uniform vec3 uTint; uniform float uHover;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main(){
    vec3 n = normalize(vN); vec3 v = normalize(vV);
    float mu = clamp(dot(n, v), 0.0, 1.0);
    float fres = pow(1.0 - mu, 3.2);
    vec3 L1 = normalize(vec3(-0.55, 0.65, 0.55)); vec3 L2 = normalize(vec3(0.7, -0.35, 0.45));
    float sp1 = pow(max(dot(n, normalize(L1 + v)), 0.0), 160.0) * 1.6;
    float sp2 = pow(max(dot(n, normalize(L2 + v)), 0.0), 36.0) * 0.18;
    // 内部的光：透过玻璃，越靠球心越亮
    float inner = pow(mu, 2.4) * uI;
    // 折射焦散：背光一侧靠近边缘的一圈亮带
    float band = smoothstep(0.18, 0.36, mu) * smoothstep(0.62, 0.38, mu);
    float caustic = band * (0.5 + 0.5 * dot(n, -L1)) * (0.12 + 0.75 * uI);
    // 玻璃里极细的一圈内反射
    float inRing = exp(-pow((mu - 0.12) * 18.0, 2.0)) * 0.35;
    vec3 tint = mix(uColor, uTint, 0.5);
    vec3 col = tint * (0.025 + fres * 0.7 + inRing * (0.3 + uI)) + vec3(1.0) * (sp1 + sp2) + uColor * inner * 1.5 + tint * caustic * 0.8;
    col += vec3(uFlash) * 0.8 + tint * fres * uHover * 0.6;
    float a = clamp(0.05 + fres * 0.55 + sp1 + inner * 0.95 + caustic * 0.6 + uFlash, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
  }`;
const coreFS = /* glsl */ `
  uniform vec3 uColor; uniform float uI; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main(){
    float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float pulse = 0.92 + 0.08 * sin(uTime * 1.6 + vP.x * 3.0);
    vec3 c = uColor * (0.6 + 1.6 * pow(mu, 0.8)) * (0.4 + 1.4 * uI) * pulse;
    gl_FragColor = vec4(c, 1.0);
  }`;
const glowFS = /* glsl */ `
  uniform vec3 uColor; uniform float uI; uniform float uTime; uniform float uSpikes; uniform float uFlash; uniform float uRing; uniform vec3 uRingColor; uniform float uHole;
  varying vec2 vUv;
  void main(){
    vec2 p = vUv - 0.5; float d = length(p)*2.0;
    float halo = exp(-d*d*10.0) * 0.5 + exp(-d*4.2) * 0.25;
    float spike = (exp(-abs(p.y)*120.0) * exp(-abs(p.x)*4.0) + exp(-abs(p.x)*120.0) * exp(-abs(p.y)*4.0)) * uSpikes * 0.8;
    float a = (halo + spike) * uI + exp(-d*d*18.0) * uFlash * 1.6;
    a *= smoothstep(1.0, 0.65, d);
    if (uHole > 0.001) a *= smoothstep(uHole*0.9, uHole*1.25, d);
    vec3 col = uColor * a;
    float ring = exp(-pow((d - 0.62 - 0.03*sin(uTime*1.8))*24.0, 2.0)) * uRing;
    col += uRingColor * ring * 0.7;
    gl_FragColor = vec4(col, 1.0);
  }`;
const billboardVS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
export const SILVER = new THREE.Color(0.86, 0.9, 1.0);

// 参考 Gaia Sky / SpaceEngine 一类天文软件的做法：
//  · 远处：面向镜头的发光面片，按视角换算大小，并保证最小像素，远看也是清楚的一颗星、能点中；
//  · 近处：自发光球体（边缘变暗 + 极淡的缓慢等离子纹理）+ 约 3 倍直径的日冕光晕（按距离平方衰减）+ 菲涅尔细边；
//  · 外层光晕交给辉光后期。没点亮时是一颗只剩细银边的暗球（像日食），点亮后整颗发光。
const starFS = /* glsl */ `${NOISE}
  uniform vec3 uColor; uniform float uI; uniform float uTime; uniform float uSeed; uniform float uHover; uniform float uFlash;
  varying vec3 vN; varying vec3 vV; varying vec3 vP;
  void main(){
    float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    // 很淡、很慢的等离子流动，只是让发光面不死板
    float plasma = fbm3(normalize(vP) * 2.2 + vec3(uSeed, uTime * 0.05, -uTime * 0.04));
    float limb = 0.35 + 0.65 * pow(mu, 0.55);
    float emit = uI * limb * (0.86 + 0.28 * plasma);
    // 菲涅尔细边：没点亮时它就是唯一的轮廓
    float rimThin = pow(1.0 - mu, 7.0);
    float rimSoft = pow(1.0 - mu, 3.0);
    vec3 c = uColor * (0.012 + emit * 1.9);
    c += uColor * rimThin * (0.35 + 0.6 * uI) + uColor * rimSoft * uHover * 0.55 + uColor * rimThin * uHover * 1.2;
    c += vec3(uFlash) * 0.8;
    gl_FragColor = vec4(c, 1.0);
  }`;
const coronaFS = /* glsl */ `${NOISE}
  uniform vec3 uColor; uniform float uI; uniform float uTime; uniform float uSeed; uniform float uSpikes; uniform float uFlash; uniform float uRing; uniform vec3 uRingColor; uniform float uHover; uniform float uCore; uniform float uMinI;
  varying vec2 vUv;
  void main(){
    vec2 p = vUv - 0.5; float d = length(p) * 2.0;
    float ang = atan(p.y, p.x);
    // 日冕：按距离平方衰减，外缘有缓慢变化的放射纹
    float fall = 1.0 / (1.0 + pow(d / max(uCore, 0.02), 2.0) * 6.0);
    float rays = 0.75 + 0.25 * fbm3(vec3(cos(ang) * 2.5, sin(ang) * 2.5, uTime * 0.12 + uSeed));
    float corona = fall * rays * smoothstep(1.0, 0.5, d);
    // 远看时的星点：一个锐利的亮核，保证任何距离都清楚
    float point = exp(-d * d * 60.0);
    float spike = (exp(-abs(p.y) * 140.0) * exp(-abs(p.x) * 5.0) + exp(-abs(p.x) * 140.0) * exp(-abs(p.y) * 5.0)) * uSpikes * 0.7;
    float I = max(uI, uMinI);
    float a = corona * uI * 1.3 + point * I * 1.6 + spike * uI + exp(-d * d * 18.0) * uFlash * 1.5;
    // 悬停：外面一圈柔和的光环
    a += exp(-pow((d - uCore * 1.25) * 9.0, 2.0)) * uHover * 0.55;
    vec3 col = uColor * a;
    float ring = exp(-pow((d - max(uCore * 1.35, 0.45)) * 34.0, 2.0)) * uRing;
    col += uRingColor * ring * 0.7;
    gl_FragColor = vec4(col, 1.0);
  }`;

/** 考点星（环绕的真题小星共用）。 */
export class Orb {
  constructor({ tint = SILVER, halo = true } = {}) {
    this.group = new THREE.Group();
    const seed = Math.random() * 40;
    this.color = tint.clone().lerp(new THREE.Color(1, 1, 1), 0.25);
    this.body = new THREE.Mesh(SPHERE, new THREE.ShaderMaterial({ vertexShader: glassVS, fragmentShader: starFS,
      uniforms: { uColor: { value: this.color.clone() }, uI: { value: 0 }, uTime: { value: 0 }, uSeed: { value: seed }, uHover: { value: 0 }, uFlash: { value: 0 } } }));
    this.body.renderOrder = 1;
    this.corona = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
      vertexShader: billboardVS, fragmentShader: coronaFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: this.color.clone() }, uI: { value: 0 }, uTime: { value: 0 }, uSeed: { value: seed }, uSpikes: { value: 0 }, uFlash: { value: 0 }, uRing: { value: 0 }, uRingColor: { value: new THREE.Color(1.0, 0.68, 0.32) }, uHover: { value: 0 }, uCore: { value: 0.33 }, uMinI: { value: 0.06 } },
    }));
    this.corona.renderOrder = 4;
    this.halo = halo;
    this.group.add(this.body, this.corona);
    this.hit = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial());
    this.hit.visible = false;
    this.group.add(this.hit);
    this.cur = { I: 0, spikes: 0, ring: 0, radius: 1 };
    this.to = { I: 0, spikes: 0, ring: 0, radius: 1 };
    this.flash = 0; this.hover = 0; this.dim = 1; this.close = 0; this.closeTo = 0;
    this.hs = 0; this.hv = 0; // 悬停放大的弹簧（带一点回弹）
    this.minPx = 7;          // 远处至少占这么多像素
    this.viewH = 900;
  }
  setLook({ I, spikes = 0, ring = 0, radius }, instant = false) {
    Object.assign(this.to, { I, spikes, ring, radius });
    if (instant) Object.assign(this.cur, { I, spikes, ring, radius });
  }
  update(dt, t, camera) {
    const k = 1 - Math.exp(-dt * 1.4);
    for (const key of ["I", "spikes", "ring", "radius"]) this.cur[key] += (this.to[key] - this.cur[key]) * k;
    this.flash = Math.max(0, this.flash - dt * 1.0);
    this.close += (this.closeTo - this.close) * (1 - Math.exp(-dt * 2.2));
    this.hv += ((this.hover - this.hs) * 170 - this.hv * 14) * dt;
    this.hs += this.hv * dt;
    const cl = this.close;
    const I = Math.max(0, this.cur.I);
    const hs = Math.max(-0.2, this.hs);
    const R = this.cur.radius * (0.55 + 0.1 * Math.min(1, I)) * (1 + hs * 0.35 + this.flash * 0.25) * (1 + 2.6 * cl);
    this.body.scale.setScalar(R);
    // 日冕面片：世界尺寸约 3–7 倍直径；远处按像素保底，保证看得见、点得中
    const dist = camera.position.distanceTo(this.group.getWorldPosition(_tmp));
    const pxWorld = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / this.viewH;
    const world = R * 2 * (this.halo ? 3 + 3.5 * Math.sqrt(I) : 2.6) * (1 + hs * 0.25);
    const minW = this.minPx * (1 + hs * 0.6) * pxWorld * 2.2;
    const size = Math.max(world, minW);
    this.corona.scale.setScalar(size);
    this.corona.quaternion.copy(camera.quaternion);
    const bu = this.body.material.uniforms, cu = this.corona.material.uniforms;
    bu.uI.value = I * this.dim * (1 - 0.3 * cl); bu.uTime.value = t; bu.uHover.value = Math.max(0, hs) * this.dim; bu.uFlash.value = this.flash;
    cu.uI.value = I * this.dim * (1 - 0.35 * cl) * (this.halo ? 1 : 0.6);
    cu.uMinI.value = 0.06 * this.dim * (1 - cl);
    cu.uCore.value = Math.min(0.9, (2 * R) / size);
    cu.uTime.value = t; cu.uSpikes.value = this.cur.spikes * this.dim * (1 - cl); cu.uFlash.value = this.flash; cu.uRing.value = this.cur.ring * this.dim * (1 - 0.75 * cl); cu.uHover.value = Math.max(0, hs) * this.dim;
    this.hit.scale.setScalar(Math.max(R * 1.6, minW * 0.5, 3));
  }
  /** 屏幕上的半径（像素），用于按屏幕距离拾取。 */
  screenRadius(camera) {
    const dist = camera.position.distanceTo(this.group.getWorldPosition(_tmp));
    const pxWorld = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / this.viewH;
    return Math.max(this.body.scale.x / pxWorld, this.minPx);
  }
  dispose() { this.body.material.dispose(); this.corona.material.dispose(); this.hit.material.dispose(); }
}
const _tmp = new THREE.Vector3();
export { Orb as Star };

export function makeVocabCluster(R) {
  const N = 420;
  const r = rng("vocab");
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), order = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(Math.pow(r(), 1.8) * R);
    pos.set([v.x, v.y, v.z], i * 3);
    const c = new THREE.Color(0.86 + r() * 0.1, 0.9 + r() * 0.08, 1.0);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = 1.4 + r() * 2.8;
    order[i] = r();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  g.setAttribute("order", new THREE.BufferAttribute(order, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uLit: { value: 0 }, uTime: { value: 0 }, uPR: { value: 1 }, uDim: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size; attribute float order; attribute vec3 color;
      varying vec3 vC; varying float vOn; uniform float uLit; uniform float uTime; uniform float uPR;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vOn = step(order, uLit);
        float tw = 0.75 + 0.25*sin(uTime*1.7 + order*40.0);
        gl_PointSize = size * uPR * (vOn > 0.5 ? 1.0 : 0.55) * clamp(260.0 / -mv.z, 0.5, 8.0) * tw;
        vC = vOn > 0.5 ? color : vec3(0.28,0.3,0.36);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vOn; uniform float uDim;
      void main(){ vec2 p = gl_PointCoord - 0.5; float d = length(p)*2.0; float a = exp(-d*d*6.0) * (vOn > 0.5 ? 1.0 : 0.35) * uDim; gl_FragColor = vec4(vC*a*1.6, a); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}


// ── 连线 ─────────────────────────────────────────────────
export function makeLines(pairs, color) {
  const arr = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], i) => arr.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.LineSegments(g, m);
}
/** 最小生成树：星座里的星按最近距离连成一棵树，不会两三颗一堆。 */
export function mst(points) {
  const n = points.length;
  if (n < 2) return [];
  const used = new Array(n).fill(false); used[0] = true;
  const out = [];
  for (let k = 1; k < n; k++) {
    let best = null, bd = Infinity;
    for (let i = 0; i < n; i++) if (used[i]) for (let j = 0; j < n; j++) if (!used[j]) {
      const d = points[i].distanceToSquared(points[j]);
      if (d < bd) { bd = d; best = [i, j]; }
    }
    used[best[1]] = true;
    out.push([points[best[0]], points[best[1]]]);
  }
  return out;
}
/** 旋臂主线：一条穿过这一科所有章节的柔和曲线，亮度跟着这一科的分数。 */
export function makeThread(points, color) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const pts = curve.getPoints(Math.max(60, points.length * 24));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const a = new Float32Array(pts.length);
  pts.forEach((_, i) => { const t = i / (pts.length - 1); a[i] = Math.sin(Math.PI * t) ** 0.5; });
  g.setAttribute("aT", new THREE.BufferAttribute(a, 1));
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(color) }, uA: { value: 0 } },
    vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uA; varying float vT; void main(){ gl_FragColor = vec4(uColor * vT * uA, 1.0); }` });
  return new THREE.Line(g, m);
}

// ── 背景星：铺满整个星系和四周天空，每颗属于离它最近的章节；
//    跟着那一章的掌握度连续变亮，模块整块完成时以模块为中心放一圈光波。 ─────────
export function makeSkyField(chapters, R = 1150) {
  const r = rng("skyfield");
  const gauss = () => (r() + r() + r() + r() - 2) / 2;
  const centers = chapters.map((c) => c.center);
  const nearest = (p) => {
    const q = p.clone(); q.y = 0;
    const len = q.length();
    if (len > R * 0.95) q.multiplyScalar((R * 0.95) / len);
    let bi = 0, bd = Infinity;
    centers.forEach((c, i) => { const d = (c.x - q.x) ** 2 + (c.z - q.z) ** 2; if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const items = [];
  // 每个章节周围一团
  chapters.forEach((c, i) => {
    const n = 110 + Math.round(c.weight * 10);
    for (let k = 0; k < n; k++) {
      const p = c.center.clone().add(new THREE.Vector3(gauss() * 150, gauss() * 60, gauss() * 150));
      items.push([p, i, 0.7 + r() * 1.8, r()]);
    }
  });
  // 整个星系盘和上下的星海
  for (let k = 0; k < 9000; k++) {
    const rr = Math.pow(r(), 0.6) * R * 1.35;
    const th = r() * Math.PI * 2;
    const p = new THREE.Vector3(Math.cos(th) * rr, gauss() * (90 + 140 * r()), Math.sin(th) * rr);
    items.push([p, nearest(p), 0.6 + r() * 1.6, r()]);
  }
  for (let k = 0; k < 6000; k++) { // 远处一整圈天空
    const v = new THREE.Vector3(r() * 2 - 1, (r() * 2 - 1) * 0.8, r() * 2 - 1).normalize().multiplyScalar(2600 + r() * 2600);
    items.push([v, nearest(v), 1.0 + r() * 2.2, r()]);
  }
  const N = items.length;
  const pos = new Float32Array(N * 3), chap = new Float32Array(N), mod = new Float32Array(N), size = new Float32Array(N), rnd = new Float32Array(N);
  items.forEach(([p, i, s, q], k) => { pos.set([p.x, p.y, p.z], k * 3); chap[k] = i; mod[k] = chapters[i].modIndex; size[k] = s; rnd[k] = q; });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("chap", new THREE.BufferAttribute(chap, 1));
  g.setAttribute("mod", new THREE.BufferAttribute(mod, 1));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  g.setAttribute("rnd", new THREE.BufferAttribute(rnd, 1));
  const MAXC = 96, MAXM = 24;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uBreath: { value: 1 }, uChap: { value: new Array(MAXC).fill(0) }, uMod: { value: new Array(MAXM).fill(0) }, uWave: { value: new Array(MAXM).fill(99) }, uModC: { value: new Array(MAXM).fill(0).map(() => new THREE.Vector3()) }, uTime: { value: 0 }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float chap; attribute float mod; attribute float size; attribute float rnd;
      uniform float uBreath; uniform float uChap[${MAXC}]; uniform float uMod[${MAXM}]; uniform float uWave[${MAXM}]; uniform vec3 uModC[${MAXM}]; uniform float uTime; uniform float uPR;
      varying float vB; varying vec3 vC;
      void main(){
        int ci = int(chap + 0.5); int mi = int(mod + 0.5);
        float c = uChap[ci]; float m = uMod[mi];
        // 还没学：极暗；章节学得越好越亮，整个模块学好时这一片整体亮起来
        float b = 0.012 + 0.7 * pow(c, 1.3) + 0.5 * pow(m, 2.0);
        float age = uWave[mi];
        float d = distance(position, uModC[mi]);
        float wave = exp(-pow((d - age * 1100.0) / 220.0, 2.0)) * exp(-age * 0.5) * step(0.0, age);
        b += wave * 2.2;
        float tw = 0.7 + 0.3 * sin(uTime * (0.5 + rnd * 2.4) + rnd * 60.0);
        vB = b * tw * uBreath;
        vC = mix(vec3(0.82,0.86,1.0), vec3(1.0,0.96,0.9), step(0.8, rnd));
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        float dd = max(-mv.z, 1.0);
        gl_PointSize = size * uPR * clamp(1800.0 / dd, 0.8, 3.2) * (0.75 + 0.5 * min(1.0, b));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vB; varying vec3 vC;
      void main(){ vec2 p = gl_PointCoord - 0.5; float d = length(p) * 2.0; float a = exp(-d*d*12.0) * smoothstep(1.0, 0.45, d) + (exp(-abs(p.x)*40.0) + exp(-abs(p.y)*40.0)) * exp(-d*3.0) * 0.25 * min(1.0, vB); gl_FragColor = vec4(vC * a * vB, 1.0); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

// ── 真题小球（恒星特写时环绕）：同样是水晶球，做对的里面亮着，做错的泛暖光，没做的是空的 ─────
export function makePlanet(seed, kind) {
  const tint = { good: new THREE.Color(0.88, 0.92, 1.0), bad: new THREE.Color(1.0, 0.78, 0.58), todo: new THREE.Color(0.7, 0.74, 0.84) }[kind];
  const orb = new Orb({ tint, halo: false });
  orb.minPx = 4;
  orb.setLook({ I: kind === "good" ? 0.9 : kind === "bad" ? 0.25 : 0, radius: 1 }, true);
  return orb;
}

export function makeOrbit(a, b, color) {
  const pts = [];
  for (let i = 0; i <= 160; i++) { const t = (i / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * a, 0, Math.sin(t) * b)); }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
}

// ── 流星：带锥形尾迹的发光头 + 一路掉落的火星；从远处出现，飞出画面才消失 ─────
const ribbonVS = /* glsl */ `attribute float aA; attribute vec3 aC; varying float vA; varying vec3 vC; void main(){ vA = aA; vC = aC; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const ribbonFS = /* glsl */ `varying float vA; varying vec3 vC; void main(){ gl_FragColor = vec4(vC*vA, vA); }`;
const SEG = 40;
export class Meteor {
  constructor(scene, { from, to, ctrl = null, speed = 900, color = new THREE.Color(0.75, 0.85, 1), width = 3.2, duration = null, onHit = null, life = 7, pool = null }) {
    this.scene = scene;
    this.pool = pool;
    this.from = from.clone(); this.to = to.clone(); this.ctrl = ctrl ? ctrl.clone() : null;
    this.dir = to.clone().sub(from).normalize();
    this.speed = speed; this.color = color; this.width = width;
    this.duration = duration; this.onHit = onHit; this.life = life;
    this.t = 0; this.done = false;
    this.trail = [];
    this.pos = from.clone();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
    g.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(SEG * 2), 1));
    g.setAttribute("aC", new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < SEG - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.ribbon = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: ribbonVS, fragmentShader: ribbonFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.ribbon.frustumCulled = false;
    this.head = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
      vertexShader: billboardVS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uC: { value: color }, uA: { value: 0 } },
      fragmentShader: /* glsl */ `uniform vec3 uC; uniform float uA; varying vec2 vUv; void main(){ vec2 p = vUv-0.5; float d = length(p)*2.0; float a = (exp(-d*d*28.0)*2.4 + exp(-d*4.5)*0.6 + (exp(-abs(p.y)*70.0)+exp(-abs(p.x)*70.0))*exp(-d*3.0)*0.5) * uA; a *= smoothstep(1.0,0.75,d); gl_FragColor = vec4(mix(uC, vec3(1.0), exp(-d*8.0))*a, a); }`,
    }));
    scene.add(this.ribbon, this.head);
  }
  position(t) {
    if (this.duration) {
      // 弧线：二次贝塞尔，先慢后快地加速冲进目标
      const u = Math.min(1, t / this.duration);
      const e = u * u * (1.6 - 0.6 * u);
      const a = this.from, b = this.ctrl || this.from.clone().lerp(this.to, 0.5), c = this.to;
      const k = 1 - e;
      return new THREE.Vector3().addScaledVector(a, k * k).addScaledVector(b, 2 * k * e).addScaledVector(c, e * e);
    }
    return this.from.clone().addScaledVector(this.dir, this.speed * t);
  }
  update(dt, camera) {
    if (this.done) return;
    this.t += dt;
    this.pos = this.position(this.t);
    this.trail.unshift(this.pos.clone());
    if (this.trail.length > SEG) this.trail.length = SEG;
    // 出现：亮度从 0 渐亮（从远处显出来）；到达 / 飞出画面后结束
    const fadeIn = Math.min(1, this.t / 0.35);
    const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir);
    const rel = this.pos.clone().sub(camera.position);
    const behind = rel.dot(camDir) < 5;
    const ndc = this.pos.clone().project(camera);
    const off = Math.abs(ndc.x) > 1.6 || Math.abs(ndc.y) > 1.6;
    let fadeOut = 1;
    if (this.duration) {
      if (this.t >= this.duration) { if (!this.hit) { this.hit = true; this.onHit?.(); } this.tailT = (this.tailT || 0) + dt; fadeOut = Math.max(0, 1 - this.tailT / 0.45); }
    } else if ((behind || off) && this.t > 0.6) { this.exitT = (this.exitT || 0) + dt; fadeOut = Math.max(0, 1 - this.exitT / 0.4); }
    if (this.t > this.life) fadeOut = 0;
    const A = fadeIn * fadeOut;
    // 掉落的火星
    if (this.pool && A > 0.3 && this.trail.length > 1) {
      const vel = this.trail[0].clone().sub(this.trail[1]).divideScalar(Math.max(dt, 1e-3));
      for (let k = 0; k < 2; k++) {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(this.width * 14).addScaledVector(vel, 0.08);
        this.pool.add(this.pos, v, this.color, 0.35 + Math.random() * 0.5, this.width * (1.2 + Math.random() * 1.5));
      }
    }
    // 尾迹带：每个点沿「尾迹切线 × 视线」方向展开，宽度从头到尾收窄
    const g = this.ribbon.geometry;
    const P = g.attributes.position.array, AA = g.attributes.aA.array, C = g.attributes.aC.array;
    const n = this.trail.length;
    for (let i = 0; i < SEG; i++) {
      const p = this.trail[Math.min(i, n - 1)];
      const q = this.trail[Math.min(i + 1, n - 1)];
      const tan = i + 1 < n ? p.clone().sub(q).normalize() : this.dir;
      const view = camera.position.clone().sub(p).normalize();
      const side = new THREE.Vector3().crossVectors(tan, view).normalize();
      const f = i / (SEG - 1);
      const w = this.width * (1 - f) * (1 - f) * (0.4 + 0.6 * Math.min(1, camera.position.distanceTo(p) / 300));
      P.set([p.x + side.x * w, p.y + side.y * w, p.z + side.z * w, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w], i * 6);
      const a = (i < n ? Math.pow(1 - f, 1.7) : 0) * A;
      AA[i * 2] = a; AA[i * 2 + 1] = a;
      const c = this.color.clone().lerp(new THREE.Color(1, 1, 1), Math.max(0, 1 - f * 4));
      C.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    }
    g.attributes.position.needsUpdate = true; g.attributes.aA.needsUpdate = true; g.attributes.aC.needsUpdate = true;
    const dist = camera.position.distanceTo(this.pos);
    this.head.position.copy(this.pos);
    this.head.quaternion.copy(camera.quaternion);
    this.head.scale.setScalar(Math.min(this.width * 9 + dist * 0.012, dist * 0.06));
    this.head.material.uniforms.uA.value = A;
    if (A <= 0 && this.t > 0.4) this.dispose();
  }
  dispose() {
    if (this.done) return;
    this.done = true;
    this.scene.remove(this.ribbon, this.head);
    this.ribbon.geometry.dispose(); this.ribbon.material.dispose(); this.head.material.dispose();
  }
}

/** 火星 / 爆散粒子：一个共享的粒子池。 */
export class Sparks {
  constructor(scene, max = 1500) {
    this.max = max;
    this.list = [];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    g.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(max), 1));
    g.setAttribute("aC", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    g.setAttribute("aS", new THREE.BufferAttribute(new Float32Array(max), 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPR: { value: 1 } },
      vertexShader: /* glsl */ `attribute float aA; attribute vec3 aC; attribute float aS; varying float vA; varying vec3 vC; uniform float uPR;
        void main(){ vA = aA; vC = aC; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aS * uPR * clamp(300.0 / -mv.z, 0.4, 10.0); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `varying float vA; varying vec3 vC; void main(){ float d = length(gl_PointCoord-0.5)*2.0; float a = exp(-d*d*5.0)*vA; gl_FragColor = vec4(vC*a*1.5, a); }`,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  add(p, v, color, life = 0.8, size = 3) { if (this.list.length < this.max) this.list.push({ p: p.clone(), v, c: color, age: 0, life, size }); }
  burst(p, color, n = 60, speed = 30, size = 3) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      this.add(p, v, color, 0.6 + Math.random() * 0.8, size * (0.5 + Math.random()));
    }
  }
  update(dt) {
    const g = this.points.geometry;
    const P = g.attributes.position.array, A = g.attributes.aA.array, C = g.attributes.aC.array, S = g.attributes.aS.array;
    this.list = this.list.filter((s) => (s.age += dt) < s.life);
    for (let i = 0; i < this.max; i++) {
      const s = this.list[i];
      if (!s) { A[i] = 0; continue; }
      s.p.addScaledVector(s.v, dt);
      s.v.multiplyScalar(1 - dt * 1.5);
      P.set([s.p.x, s.p.y, s.p.z], i * 3);
      A[i] = Math.pow(1 - s.age / s.life, 1.5);
      C.set([s.c.r, s.c.g, s.c.b], i * 3);
      S[i] = s.size;
    }
    g.attributes.position.needsUpdate = true; g.attributes.aA.needsUpdate = true; g.attributes.aC.needsUpdate = true; g.attributes.aS.needsUpdate = true;
  }
}

/** 冲击波：面朝镜头、迅速扩大变淡的光环。 */
export class Shock {
  constructor(scene, pos, color, size) {
    this.scene = scene; this.t = 0; this.size = size;
    this.mesh = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
      vertexShader: billboardVS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uC: { value: color }, uT: { value: 0 } },
      fragmentShader: /* glsl */ `uniform vec3 uC; uniform float uT; varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; float r = uT; float a = exp(-pow((d - r)*14.0, 2.0)) * (1.0-uT) + exp(-d*d*30.0)*(1.0-uT)*(1.0-uT)*2.0; gl_FragColor = vec4(mix(uC, vec3(1.0), 0.3)*a, a); }`,
    }));
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
  }
  update(dt, camera) {
    this.t += dt / 1.1;
    const e = 1 - Math.pow(1 - Math.min(1, this.t), 3);
    this.mesh.material.uniforms.uT.value = e;
    this.mesh.scale.setScalar(this.size);
    this.mesh.quaternion.copy(camera.quaternion);
    if (this.t >= 1) { this.scene.remove(this.mesh); this.mesh.material.dispose(); return false; }
    return true;
  }
}

export { THREE };