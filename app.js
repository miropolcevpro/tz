// Paver WebAR MVP (GitHub Pages ready)
// - WebXR immersive-ar on Android Chrome (ARCore)
// - Draw contour polygon
// - Measurement (distance + area)
// - Tile catalog with cards + variants (color tints)
// - Offline-ish via service worker (caches once visited assets)

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const dbgEl = $("dbg");
function setStatus(msg){ statusEl.textContent = msg; }
function showDebug(err){
  console.error(err);
  const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  dbgEl.hidden = false;
  dbgEl.textContent = `Ошибка\n\n${msg}`;
}

function setBadgeState(state, text){
  if(!floorQualityBadge) return;
  floorQualityBadge.classList.remove("bad","mid","good");
  floorQualityBadge.classList.add(state);
  floorQualityBadge.textContent = text;
}

function updateFloorQualityUI(){
  const pct = Math.round(floorQuality*100);
  if(floorQualityState === "good") setBadgeState("good", `Floor: ${pct}% (stable)`);
  else if(floorQualityState === "mid") setBadgeState("mid", `Floor: ${pct}%`);
  else setBadgeState("bad", `Floor: ${pct}% (scan…)`);
}

function updateOcclusionUI(){
  if(!occlusionToggle) return;
  if(!depthSupported){
    occlusionToggle.textContent = "Occlusion: N/A";
    occlusionToggle.disabled = true;
    return;
  }
  occlusionToggle.disabled = false;
  occlusionToggle.textContent = occlusionEnabled ? "Occlusion: On" : "Occlusion: Off";
}

// Floor quality (агрессивная блокировка ранней фиксации — как у marevo)
const QUALITY_MIN_SAMPLES = 25;          // минимум семплов, прежде чем разрешать калибровку
const QUALITY_WINDOW_SECONDS = 1.4;      // окно для оценки дрожания (сек)
const QUALITY_STABLE_SECONDS = 0.8;      // сколько держать "зелёный" подряд
const QUALITY_MIN_DISTANCE_M = 0.35;     // не фиксируем слишком близко к камере
const QUALITY_JITTER_GOOD_M = 0.010;     // зелёный: ~1см rms
const QUALITY_JITTER_OK_M   = 0.018;     // жёлтый: ~1.8см rms

function computeFloorQuality(nowSec){
  const n = qualitySamples.length;
  if(n < QUALITY_MIN_SAMPLES){
    floorQuality = 0;
    floorQualityState = "bad";
    qualityStableSince = 0;
    updateFloorQualityUI();
    return false;
  }
  let mx=0, mz=0;
  for(const s of qualitySamples){ mx+=s.pos.x; mz+=s.pos.z; }
  mx/=n; mz/=n;
  let sum=0;
  for(const s of qualitySamples){
    const dx=s.pos.x-mx, dz=s.pos.z-mz;
    sum += dx*dx + dz*dz;
  }
  const rms = Math.sqrt(sum/n); // meters
  let q;
  if(rms <= QUALITY_JITTER_GOOD_M) q=1.0;
  else if(rms <= QUALITY_JITTER_OK_M) q=0.55;
  else q=Math.max(0, 1.0 - (rms-QUALITY_JITTER_OK_M)/(0.06-QUALITY_JITTER_OK_M));
  floorQuality = Math.max(0, Math.min(1, q));
  floorQualityState = (floorQuality>=0.8) ? "good" : (floorQuality>=0.35 ? "mid" : "bad");

  const stable = (rms <= QUALITY_JITTER_GOOD_M);
  if(stable){
    if(!qualityStableSince) qualityStableSince = nowSec;
  }else{
    qualityStableSince = 0;
  }
  updateFloorQualityUI();
  return stable && qualityStableSince && (nowSec-qualityStableSince) >= QUALITY_STABLE_SECONDS;
}

function applyOcclusionToMaterial(material, THREE){
  if(!material || material.userData.__occlusionPatched) return;
  material.userData.__occlusionPatched = true;

  material.onBeforeCompile = (shader)=>{
    shader.uniforms.uDepthTex = occlusionUniforms.uDepthTex;
    shader.uniforms.uDepthTransform = occlusionUniforms.uDepthTransform;
    shader.uniforms.uViewport = occlusionUniforms.uViewport;
    shader.uniforms.uFramebuffer = occlusionUniforms.uFramebuffer;
    shader.uniforms.uOcclusionEnabled = occlusionUniforms.uOcclusionEnabled;
    shader.uniforms.uEpsilon = occlusionUniforms.uEpsilon;

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
`#include <common>
uniform sampler2D uDepthTex;
uniform mat4 uDepthTransform;
uniform vec4 uViewport;
uniform vec2 uFramebuffer;
uniform float uOcclusionEnabled;
uniform float uEpsilon;

float sampleRealDepthMeters(vec2 uvView){
  vec4 uv = uDepthTransform * vec4(uvView, 0.0, 1.0);
  vec2 duv = clamp(uv.xy, vec2(0.0), vec2(1.0));
  return texture2D(uDepthTex, duv).r;
}
`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
`#include <dithering_fragment>
if(uOcclusionEnabled > 0.5){
  vec2 uvView = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  if(all(greaterThanEqual(uvView, vec2(0.0))) && all(lessThanEqual(uvView, vec2(1.0)))){
    float realD = sampleRealDepthMeters(uvView);
    float virtualD = -vViewPosition.z;
    if(realD > 0.0 && realD < (virtualD - uEpsilon)) discard;
  }
}
`
    );
  };
  material.needsUpdate = true;
}

function patchOcclusionOnObject(obj, THREE){
  if(!obj) return;
  obj.traverse((o)=>{
    if(o.isMesh && o.material){
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for(const m of mats){
        if(m && (m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshPhysicalMaterial)){
          applyOcclusionToMaterial(m, THREE);
        }
      }
    }
  });
}

window.addEventListener("error", (e)=>showDebug(e.error || e.message));
window.addEventListener("unhandledrejection", (e)=>showDebug(e.reason || e.message));


const FALLBACK_URL = "./unsupported.html";

async function ensureXRSupportOrFallback(){
  // Redirect to fallback page if immersive-ar is not supported
  try{
    if(!navigator.xr || !navigator.xr.isSessionSupported){
      location.replace(FALLBACK_URL);
      return false;
    }
    const ok = await navigator.xr.isSessionSupported("immersive-ar");
    if(!ok){
      location.replace(FALLBACK_URL);
      return false;
    }
    return true;
  }catch(_){
    location.replace(FALLBACK_URL);
    return false;
  }
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function fmtM(m){ return (Math.round(m*100)/100).toFixed(2); }
function fmtMM(mm){ return `${Math.round(mm)} мм`; }
function hexToInt(hex){
  if(!hex) return 0xffffff;
  const h = String(hex).replace("#","").trim();
  return parseInt(h, 16);
}
function safeName(s){ return String(s||"").replace(/\s+/g," ").trim(); }

async function registerSW(){
  try{
    if("serviceWorker" in navigator){
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  }catch(e){
    console.warn("SW registration failed", e);
  }
}

async function importThree(){
  const urls = [
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "https://unpkg.com/three@0.160.0/build/three.module.js"
  ];
  let last;
  for(const url of urls){
    try{
      const mod = await import(url);
      return mod;
    }catch(e){
      last = e;
      console.warn("THREE import failed:", url, e);
    }
  }
  throw last || new Error("Не удалось загрузить three.module.js");
}

function makeTouchControls({ dom, camera, target }) {
  let enabled = true;
  let isDown = false;
  let lastX = 0, lastY = 0;
  let lastDist = 0;
  let yaw = 0, pitch = 0.45;
  let radius = 3.8;

  function updateCamera(){
    pitch = clamp(pitch, 0.05, 1.35);
    radius = clamp(radius, 1.2, 12);
    const x = target.x + radius * Math.cos(pitch) * Math.sin(yaw);
    const y = target.y + radius * Math.sin(pitch);
    const z = target.z + radius * Math.cos(pitch) * Math.cos(yaw);
    camera.position.set(x,y,z);
    camera.lookAt(target);
  }

  function getTouchDist(t0, t1){
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  function onDown(e){
    if(!enabled) return;
    isDown = true;
    if(e.touches && e.touches.length===2){
      lastDist = getTouchDist(e.touches[0], e.touches[1]);
    }else{
      lastX = (e.touches? e.touches[0].clientX : e.clientX);
      lastY = (e.touches? e.touches[0].clientY : e.clientY);
    }
  }
  function onMove(e){
    if(!enabled || !isDown) return;
    if(e.touches && e.touches.length===2){
      const d = getTouchDist(e.touches[0], e.touches[1]);
      const delta = d - lastDist;
      lastDist = d;
      radius *= (1 - delta * 0.002);
      updateCamera();
      return;
    }
    const x = (e.touches? e.touches[0].clientX : e.clientX);
    const y = (e.touches? e.touches[0].clientY : e.clientY);
    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x; lastY = y;
    yaw -= dx * 0.006;
    pitch -= dy * 0.006;
    updateCamera();
  }
  function onUp(){ isDown = false; }

  dom.addEventListener("mousedown", onDown);
  dom.addEventListener("mousemove", onMove);
  dom.addEventListener("mouseup", onUp);
  dom.addEventListener("mouseleave", onUp);
  dom.addEventListener("touchstart", onDown, {passive:true});
  dom.addEventListener("touchmove", onMove, {passive:true});
  dom.addEventListener("touchend", onUp);

  updateCamera();

  return {
    setEnabled(v){ enabled = !!v; },
    reset(){
      yaw = 0; pitch = 0.45; radius = 3.8;
      updateCamera();
    }
  };
}

function distXZ(a,b){
  if(!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}


function polygonAreaXZ(points){
  // Shoelace on XZ plane
  if(!points || points.length < 3) return 0;
  let a = 0;
  for(let i=0;i<points.length;i++){
    const p1 = points[i];
    const p2 = points[(i+1)%points.length];
    a += (p1.x * p2.z - p2.x * p1.z);
  }
  return Math.abs(a) * 0.5;
}
function polygonPerimeter(points){
  if(!points || points.length < 2) return 0;
  let p = 0;
  for(let i=0;i<points.length;i++){
    const a = points[i];
    const b = points[(i+1)%points.length];
    p += a.distanceTo(b);
  }
  return p;
}

function pointInUI(target){
  if(!target) return false;
  return !!(target.closest && (target.closest("#panel") || target.closest("#catalogOverlay") || target.closest(".topbar") || target.closest("#help")));
}

(async ()=>{
  await registerSW();

  // Splash
  const splashEl = $("splash");
  function hideSplash(){ if(splashEl) splashEl.classList.add("hidden"); }

  // Fallback for unsupported devices
  const ok = await ensureXRSupportOrFallback();
  if(!ok) return;

  setStatus("загрузка 3D…");
  const THREE = await importThree();

  // UI refs
  const helpEl = $("help");
  const closeHelpBtn = $("closeHelp");
  const helpFab = $("helpFab");
  const menuFab = $("menuFab");
  const catalogFab = $("catalogFab");
  const panelEl = $("panel");
  const hidePanelBtn = $("hidePanelBtn");
  const enterArBtn = $("enterArBtn");
  const exitArBtn = $("exitArBtn");
  const clearBtn = $("clearBtn");
  const calibBtn = $("calibBtn");
  const gridBtn = $("gridBtn");
  const actionBar = $("actionBar");
  const actionBtn = $("actionBtn");
  const floorQualityBadge = $("floorQualityBadge");
  const occlusionToggle = $("occlusionToggle");
  const actionClose = $("actionClose");

  const modeDrawBtn = $("modeDraw");
  const modeMeasureBtn = $("modeMeasure");
  const modeHint = $("modeHint");

  const drawCard = $("drawCard");
  const measureCard = $("measureCard");

  const undoBtn = $("undoBtn");
  const closePolyBtn = $("closePolyBtn");
  const resetPolyBtn = $("resetPolyBtn");
  const areaOut = $("areaOut");
  const drawStatus = $("drawStatus");

  const clearMeasureBtn = $("clearMeasureBtn");
  const measureOut = $("measureOut");

  const tileNameEl = $("tileName");
  const variantRow = $("variantRow");
  const texScaleSlider = $("texScale");
  const texVal = $("texVal");
  const heightMmSlider = $("heightMm");
  const hVal = $("hVal");
  const layoutSel = $("layout");

  // init labels
  texVal.textContent = (parseFloat(texScaleSlider.value)||1).toFixed(2);
  hVal.textContent = heightMmSlider.value;

  const openCatalogBtn = $("openCatalogBtn");
  const shotBtn = $("shotBtn");

  const catalogOverlay = $("catalogOverlay");
  const closeCatalogBtn = $("closeCatalogBtn");
  const catalogGrid = $("catalogGrid");
  const catalogSearch = $("catalogSearch");
  const filterCollection = $("filterCollection");
  const filterTech = $("filterTech");
  const filterThickness = $("filterThickness");

  function setHelp(visible){
    helpEl.hidden = !visible;
  }
  closeHelpBtn.addEventListener("click", ()=>setHelp(false));
  helpFab.addEventListener("click", ()=>setHelp(!helpEl.hidden));
  setHelp(true);

  function setPanelCollapsed(v){
    panelEl.classList.toggle("collapsed", !!v);
  }
  menuFab.addEventListener("click", ()=>setPanelCollapsed(!panelEl.classList.contains("collapsed")));
  hidePanelBtn.addEventListener("click", ()=>setPanelCollapsed(true));
  catalogFab.addEventListener("click", ()=>openCatalog());


  // Action bar (context CTA)
  let actionHandler = null;
  function hideAction(){
    if(actionBar) actionBar.classList.add("hidden");
    actionHandler = null;
  }
  function showAction(label, {secondary=false}={}, handler=null){
    if(!actionBar || !actionBtn) return;
    actionBar.classList.remove("hidden");
    actionBtn.textContent = label;
    actionBtn.classList.toggle("secondary", !!secondary);
    actionHandler = handler;
  }
  actionClose?.addEventListener("click", hideAction);
  actionBtn?.addEventListener("click", ()=>{
    if(typeof actionHandler === "function") actionHandler();
  });

  // Catalog data
  let catalog = null;
  let currentItem = null;
  let currentVariant = null;

  async function loadCatalog(){
    const res = await fetch("./catalog/catalog.json", { cache:"no-cache" });
    if(!res.ok) throw new Error("Не удалось загрузить catalog/catalog.json");
    return await res.json();
  }

  function buildFilters(){
    const collections = new Set();
    const techs = new Set();
    const thicknesses = new Set();
    for(const it of (catalog?.items||[])){
      if(it.collection) collections.add(it.collection);
      if(it.technology) techs.add(it.technology);
      if(it.thickness_mm) thicknesses.add(String(it.thickness_mm));
    }
    function fillSelect(sel, values){
      const cur = sel.value;
      const first = sel.querySelector("option")?.outerHTML || "<option value=\"\">—</option>";
      sel.innerHTML = first;
      [...values].sort().forEach(v=>{
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      });
      sel.value = cur;
    }
    fillSelect(filterCollection, collections);
    fillSelect(filterTech, techs);
    fillSelect(filterThickness, thicknesses);
  }

  function catalogMatches(it){
    const q = (catalogSearch.value||"").toLowerCase().trim();
    if(q && !safeName(it.name).toLowerCase().includes(q)) return false;
    const fc = filterCollection.value;
    if(fc && it.collection !== fc) return false;
    const ft = filterTech.value;
    if(ft && it.technology !== ft) return false;
    const th = filterThickness.value;
    if(th && String(it.thickness_mm||"") !== th) return false;
    return true;
  }

  function renderCatalog(){
    catalogGrid.innerHTML = "";
    const items = (catalog?.items||[]).filter(catalogMatches);
    if(!items.length){
      const empty = document.createElement("div");
      empty.className = "note";
      empty.style.padding = "12px";
      empty.textContent = "Ничего не найдено.";
      catalogGrid.appendChild(empty);
      return;
    }
    for(const it of items){
      const thumb = (it.variants && it.variants[0] && it.variants[0].thumb) || "";
      const card = document.createElement("div");
      card.className = "tileCard";
      card.innerHTML = `
        <img class="tileThumb" src="${thumb}" alt="" loading="lazy" />
        <div class="tileMeta">
          <div class="tileName">${it.name}</div>
          <div class="tileSub">${[it.collection, it.thickness_mm? (it.thickness_mm+" мм"):"", it.technology].filter(Boolean).join(" • ")}</div>
          <div class="tileTags">
            ${(it.tags||[]).slice(0,3).map(t=>`<span class="tag">${t}</span>`).join("")}
          </div>
        </div>
      `;
      card.addEventListener("click", ()=>{
        selectItem(it);
        closeCatalog();
        setPanelCollapsed(false);
      });
      catalogGrid.appendChild(card);
    }
  }

  function openCatalog(){
    catalogOverlay.classList.remove("hidden");
    catalogOverlay.setAttribute("aria-hidden","false");
    setHelp(false);
  }
  function closeCatalog(){
    catalogOverlay.classList.add("hidden");
    catalogOverlay.setAttribute("aria-hidden","true");
  }

  openCatalogBtn.addEventListener("click", openCatalog);
  closeCatalogBtn.addEventListener("click", closeCatalog);
  catalogOverlay.addEventListener("click", (e)=>{ if(e.target === catalogOverlay) closeCatalog(); });
  catalogSearch.addEventListener("input", renderCatalog);
  filterCollection.addEventListener("change", renderCatalog);
  filterTech.addEventListener("change", renderCatalog);
  filterThickness.addEventListener("change", renderCatalog);

  function renderVariants(){
    variantRow.innerHTML = "";
    if(!currentItem || !currentItem.variants || currentItem.variants.length === 0){
      return;
    }
    for(const v of currentItem.variants){
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.type = "button";
      const tint = v.tint || "#ffffff";
      sw.style.background = tint;
      sw.innerHTML = `<span title="${v.name}">${v.name}</span>`;
      sw.addEventListener("click", ()=>{
        selectVariant(v);
      });
      if(currentVariant && currentVariant.id === v.id) sw.classList.add("on");
      variantRow.appendChild(sw);
    }
  }

  

// Depth-sensing / occlusion
let depthSupported = false;
let occlusionEnabled = true; // default ON if supported           // default ON when supported
let occlusionAutoInit = false;         // enable only once when depth becomes available
let depthTexture = null;               // THREE.DataTexture (meters)
let depthW = 0, depthH = 0;
let lastDepthUpdateTs = 0;

const occlusionUniforms = {
  uDepthTex: { value: null },
  uDepthTransform: { value: null },     // THREE.Matrix4
  uViewport: { value: null },           // THREE.Vector4
  uFramebuffer: { value: null },        // THREE.Vector2
  uOcclusionEnabled: { value: 0.0 },
  uEpsilon: { value: OCCLUSION_EPSILON_M },
};

// Three.js init
  const canvas = $("c");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  
  // Init occlusion uniforms with safe defaults
  occlusionUniforms.uViewport.value = new THREE.Vector4(0,0,1,1);
  occlusionUniforms.uFramebuffer.value = new THREE.Vector2(1,1);
  occlusionUniforms.uDepthTransform.value = new THREE.Matrix4().identity();
  // dummy 1x1 depth texture (0 meters)
  depthTexture = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
  depthTexture.needsUpdate = true;
  occlusionUniforms.uDepthTex.value = depthTexture;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  // --- ВАЖНО ДЛЯ WebXR AR ---
  // В режиме immersive-ar видеопоток камеры находится "под" WebGL‑слоем.
  // Если WebGL очищается непрозрачно (alpha = 1), вместо камеры будет "чёрный экран".
  // Поэтому:
  //  - в обычном (не‑AR) режиме делаем фон непрозрачным для удобного предпросмотра;
  //  - при входе в AR переключаемся на прозрачный фон (alpha = 0).
  const PREVIEW_CLEAR = { color: 0x0b0f1a, alpha: 1 };
  renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.01, 100);
  const controls = makeTouchControls({ dom: canvas, camera, target: new THREE.Vector3(0,0.2,0) });

  // Lighting (simple but nice)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(3,6,2);
  scene.add(sun);

  // Preview ground (non-AR)
  const previewGround = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.75 })
  );
  previewGround.rotation.x = -Math.PI/2;
  previewGround.position.y = 0;
  scene.add(previewGround);

  // Reticle (AR hit-test)
  const reticleMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent:true, opacity:0.95 });
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.10, 32).rotateX(-Math.PI/2),
    reticleMat
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Locked root (calibration / anchors). All placed content lives here.
  const lockedRoot = new THREE.Group();
  lockedRoot.name = "LockedRoot";
  scene.add(lockedRoot);

  function worldToLockedLocal(worldV, out){
    if(!out) out = worldV.clone();
    else out.copy(worldV);
    return lockedRoot.worldToLocal(out);
  }
  function lockedLocalToWorld(localV, out){
    if(!out) out = localV.clone();
    else out.copy(localV);
    return lockedRoot.localToWorld(out);
  }

  // Grid helper (visual floor aid) — shown after calibration
  const gridHelper = new THREE.GridHelper(8, 16);
  gridHelper.visible = false;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.35;
  gridHelper.renderOrder = 5;
  try{ gridHelper.material.depthTest = true;
        gridHelper.material.depthWrite = false; }catch(_){}
  lockedRoot.add(gridHelper);

  function updateGridUI(){
    if(!gridBtn) return;
    gridBtn.classList.toggle("primary", gridEnabled && floorLocked);
    gridBtn.textContent = gridEnabled ? "Сетка: вкл" : "Сетка: выкл";
    gridHelper.visible = !!(gridEnabled && floorLocked);
  }

  // Groups for surfaces & debug
  const surfaceGroup = new THREE.Group();
  const drawGroup = new THREE.Group();
  lockedRoot.add(surfaceGroup);
  lockedRoot.add(drawGroup);

  // Current surface mesh (single for MVP)
  let surfaceMesh = null;
  let surfaceReady = false;
  let surfaceType = "poly";      // "rect" | "poly"
  let patternYaw = 0;            // поворот раскладки/текстуры (для заливки внутри контура)
  let surfaceBaseY = 0;          // базовая высота пола в момент установки

  // Drawing state
  let drawPoints = []; // world Vector3
  let drawClosed = false;
  let drawLine = null;
  let drawMarkers = [];
  let drawOrigin = null; // world Vector3 (first point)

  // Measurement state
  let measureA = null;
  let measureB = null;
  let measureLine = null;

  // XR state
  let arSession = null;
  let hitTestSource = null;
  let viewerSpace = null;

  // Last valid hit (for stable placement on floor)
  let lastHitValid = false;
  const lastHitPos = new THREE.Vector3();
  const lastHitQuat = new THREE.Quaternion();
  const _hitScale = new THREE.Vector3(1,1,1);

  const _worldUp = new THREE.Vector3(0,1,0);
  const _tmpMat = new THREE.Matrix4();
  const _tmpPos = new THREE.Vector3();
  const _tmpQuat = new THREE.Quaternion();
  const _tmpScale = new THREE.Vector3();
  const _bestPos = new THREE.Vector3();
  const _bestQuat = new THREE.Quaternion();
  const _tmpNormal = new THREE.Vector3();
  const _camPos = new THREE.Vector3();
  const FLOOR_Y_EPS = 0.01; // 1cm default tolerance // meters tolerance to lock to calibrated floor
const HIT_NORMAL_DOT = 0.93; // more strict: block walls/verticals   
// After floor calibration we additionally lock to this Y tolerance (meters)
const FLOOR_Y_TOLERANCE = 0.01; // 2 cm
const FLOOR_Y_TOLERANCE_PRECALIB = 0.08; // 8 cm (used only for UX hints, not strict)
// чем выше, тем «горизонтальнее» должна быть плоскость (пол)
  // Floor lock & helpers
  let floorLocked = false;
let lastHitResultForCalib = null;        // XRHitTestResult used for anchor creation

// Rolling samples for floor quality
const qualitySamples = [];              // {pos:THREE.Vector3, t:number}
let qualityStableSince = 0;             // seconds when became stable
let floorQuality = 0;                   // 0..1
let floorQualityState = "bad";          // bad|mid|good
  let lockedFloorY = 0;
  let gridEnabled = true; // default ON
  let floorAnchor = null;
  let lastBestHit = null;
  let depthSensingAvailable = false;

  const HIT_SMOOTHING = 0.25;    // сглаживание позиции/ориентации ретикла (меньше дрожание)
  const DRAW_SNAP_M = 0.12;      // «магнит» к первой точке при замыкании контура

  // Material/texture cache
  const texCache = new Map();
  let currentMaterial = null;
  let currentPatternSize = [0.3, 0.3];

  // Плавное появление (анимация) — визуально «дороже» и скрывает микродрожание в первый момент
  let surfaceFadeStart = 0;
  let surfaceFadeDur = 0;
  function startSurfaceFade(durMs = 280){
    if(!surfaceMesh || !surfaceMesh.material) return;
    try{
      surfaceMesh.material.transparent = true;
      surfaceMesh.material.opacity = 0;
      surfaceFadeStart = performance.now();
      surfaceFadeDur = durMs;
    }catch(_){}
  }
  function updateSurfaceFade(now){
    if(!surfaceMesh || !surfaceMesh.material) return;
    if(surfaceFadeDur <= 0) return;
    const t = clamp((now - surfaceFadeStart) / surfaceFadeDur, 0, 1);
    surfaceMesh.material.opacity = t;
    if(t >= 1){
      surfaceMesh.material.opacity = 1;
      surfaceFadeDur = 0;
    }
  }


  async function loadTexture(url, { srgb=false } = {}){
    if(!url) return null;
    const key = url + (srgb? "|srgb":"|lin");
    if(texCache.has(key)) return texCache.get(key);
    const loader = new THREE.TextureLoader();
    const tex = await new Promise((res, rej)=>loader.load(url, res, undefined, rej));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1,1);
    tex.offset.set(0,0);
    tex.center.set(0,0);
    tex.rotation = 0;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 16);
    texCache.set(key, tex);
    return tex;
  }

  async function buildMaterialForVariant(variant){
    const maps = variant?.maps || {};
    const base = await loadTexture(maps.base, { srgb:true });
    const normal = await loadTexture(maps.normal, { srgb:false });
    const rough = await loadTexture(maps.roughness, { srgb:false });

    const mat = new THREE.MeshStandardMaterial({
      map: base || null,
      normalMap: normal || null,
      roughnessMap: rough || null,
      roughness: 1.0,
      metalness: 0.0
    });

    // Tint (multiply)
    const tint = variant?.tint ? hexToInt(variant.tint) : 0xffffff;
    mat.color.setHex(tint);

    // Small anti-z-fighting
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;

    return mat;
  }

  function disposeMesh(m){
    if(!m) return;
    if(m.geometry) m.geometry.dispose();
    // keep material cached? We keep currentMaterial reference, so don't dispose it here.
    surfaceGroup.remove(m);
  }

  
  function setModeUI(m){
    if(modeDrawBtn) modeDrawBtn.classList.toggle("segOn", m==="draw");
    if(modeMeasureBtn) modeMeasureBtn.classList.toggle("segOn", m==="measure");
    if(drawCard) drawCard.hidden = m!=="draw";
    if(measureCard) measureCard.hidden = m!=="measure";

    if(!modeHint) return;

    if(m==="draw"){
      modeHint.textContent = floorLocked
        ? "Контур: тапайте точки по полу → замкните контур → «Визуализировать»."
        : "Контур: сначала наведите маркер на пол и нажмите «Калибр. пол».";
    } else {
      modeHint.textContent = floorLocked
        ? "Замер: 2 тапа по полу — расстояние."
        : "Замер: сначала нажмите «Калибр. пол», чтобы зафиксировать пол.";
    }

    updateDrawUI();
    updateGridUI();
  }

  let mode = "draw";
  setModeUI(mode);

  modeDrawBtn.addEventListener("click", ()=>{ mode="draw"; setModeUI(mode); });
  modeMeasureBtn.addEventListener("click", ()=>{ mode="measure"; setModeUI(mode); });

  function applyHeightOffset(){
    if(!surfaceMesh) return;
    const offsetM = parseFloat(heightMmSlider.value)/1000;
    surfaceMesh.position.y = surfaceBaseY + offsetM;
  }


  function applyUVs(geometry){
    if(!geometry || !geometry.attributes || !geometry.attributes.position) return;
    const pos = geometry.attributes.position;
    const uv = geometry.attributes.uv || new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    const sx = (currentPatternSize && currentPatternSize[0]) ? currentPatternSize[0] : 0.3;
    const sy = (currentPatternSize && currentPatternSize[1]) ? currentPatternSize[1] : sx;
    const scale = parseFloat(texScaleSlider.value) || 1.0;
    const layout = layoutSel.value || "straight";

    const c45 = Math.cos(Math.PI/4), s45 = Math.sin(Math.PI/4);

    for(let i=0;i<pos.count;i++){
      const x = pos.getX(i);
      const y = pos.getY(i);
      let u = x / sx;
      let v = y / sy;

      // Extra rotation of the pattern (only for polygon fill), without moving the contour itself
      if(surfaceType === "poly" && patternYaw !== 0){
        const c = Math.cos(patternYaw);
        const s = Math.sin(patternYaw);
        const ru = u * c - v * s;
        const rv = u * s + v * c;
        u = ru; v = rv;
      }

      // Layout transforms
      if(layout === "diagonal"){
        const ru = u * c45 - v * s45;
        const rv = u * s45 + v * c45;
        u = ru; v = rv;
      } else if(layout === "cross"){
        // 90° rotation in UV space
        const ru = -v;
        const rv = u;
        u = ru; v = rv;
      } else if(layout === "running"){
        const row = Math.floor(v);
        if(row % 2 !== 0) u += 0.5;
      }

      // Texture scale (bigger scale => larger texture => fewer repeats)
      u /= scale;
      v /= scale;

      uv.setXY(i, u, v);
    }
    geometry.setAttribute("uv", uv);
    uv.needsUpdate = true;
  }

  function ensureSurfaceMesh(){
    if(surfaceMesh) return;
    const geom = new THREE.PlaneGeometry(2,2, 1,1); // in XY
    applyUVs(geom);
    surfaceMesh = new THREE.Mesh(geom, currentMaterial || new THREE.MeshStandardMaterial({ color:0xffffff }));
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);
    surfaceMesh.position.set(0,0,0);
    surfaceMesh.receiveShadow = false;
    surfaceGroup.add(surfaceMesh);
  }

  function clearSurface(){
    surfaceReady = false;
    surfaceType = "poly";
    patternYaw = 0;
    drawClosed = false;
    lastHitValid = false;

    if(surfaceMesh){
      disposeMesh(surfaceMesh);
      surfaceMesh = null;
    }
    clearDraw();
    clearMeasure();
  }

  clearBtn.addEventListener("click", clearSurface);


  function resetForRecalibration(){
    // reset geometry/points on recalibration, keep выбранную плитку
    clearSurface();
    hideAction();
  }

  calibBtn?.addEventListener("click", async ()=>{
    // Агрессивная блокировка ранней фиксации: калибруем пол только когда quality зелёный и стабилен.
    const nowSec = performance.now()/1000;
    const stableReady = computeFloorQuality(nowSec);
    if(!stableReady){
      setStatus("Сканируйте пол: дождитесь зелёного индикатора ‘Floor’ и только потом нажмите ‘Калибр. пол’.");
      return;
    }

    if(!arSession){
      alert("Сначала нажмите «Включить AR».");
      return;
    }
    if(!reticle.visible || !lastBestHit){
      alert("Наведите маркер на пол, дождитесь зелёного индикатора и попробуйте снова.");
      return;
    }

    // Recalibration resets contour
    resetForRecalibration();

    // Remove old anchor if any
    try{ if(floorAnchor && floorAnchor.delete) floorAnchor.delete(); }catch(_){}
    floorAnchor = null;

    const refSpace = renderer.xr.getReferenceSpace();
    try{
      if(lastBestHit.createAnchor){
        floorAnchor = await lastHitResultForCalib.createAnchor();
      }
    }catch(e){
      console.warn("Anchor not available:", e);
      floorAnchor = null;
    }

    // Lock root to current hit pose (stable horizontal frame)
    lockedRoot.matrixAutoUpdate = true;
    lockedRoot.position.copy(lastHitPos);
    // Keep the world up axis stable: we lock only position (no surface tilt).
    lockedRoot.quaternion.identity();
    lockedRoot.scale.set(1,1,1);
    lockedRoot.updateMatrixWorld(true);
    lockedFloorY = lastHitPos.y;
    floorLocked = true;
updateGridUI();
    setModeUI(mode);
    setStatus("Пол откалиброван ✓");
    try{ if(navigator.vibrate) navigator.vibrate(15); }catch(_){}
  });

  gridBtn?.addEventListener("click", ()=>{
    gridEnabled = !gridEnabled;
    updateGridUI();
  });

  
occlusionToggle?.addEventListener("click", ()=>{
  if(!depthSupported) return;
  occlusionEnabled = !occlusionEnabled;
  occlusionUniforms.uOcclusionEnabled.value = occlusionEnabled ? 1.0 : 0.0;
  updateOcclusionUI();
});
function normalizeAngle(a){
    const twoPi = Math.PI * 2;
    a = a % twoPi;
    if(a > Math.PI) a -= twoPi;
    if(a < -Math.PI) a += twoPi;
    return a;
  }

  function applySurfaceRotation(){
    if(!surfaceMesh) return;
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);
    if(surfaceMesh.geometry) applyUVs(surfaceMesh.geometry);
  }


  texScaleSlider.addEventListener("input", ()=>{
    texVal.textContent = (parseFloat(texScaleSlider.value)||1).toFixed(2);
    if(surfaceMesh) applyUVs(surfaceMesh.geometry);
  });
  heightMmSlider.addEventListener("input", ()=>{
    hVal.textContent = heightMmSlider.value;
    if(!surfaceMesh) return;
    // если поверхность еще не "поставлена" и мы в AR — она и так будет привязана к reticle
    // но высоту применяем всегда относительно surfaceBaseY
    applyHeightOffset();
  });
  layoutSel.addEventListener("change", ()=>{
    if(surfaceMesh) applyUVs(surfaceMesh.geometry);
  });

  // Draw mode helpers
  function clearDraw(){
    drawPoints = [];
    drawOrigin = null;
    drawClosed = false;

    if(drawLine){
      drawGroup.remove(drawLine);
      drawLine.geometry.dispose();
      drawLine.material.dispose();
      drawLine=null;
    }
    for(const m of drawMarkers){
      drawGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    drawMarkers = [];
    areaOut.textContent = "—";
    if(drawStatus) drawStatus.textContent = "";
    updateDrawUI();
  }

  
  function updateDrawUI(){
  if(mode !== "draw"){
    hideAction();
    drawStatus.textContent = "";
    closePolyBtn.style.display = "none";
    closePolyBtn.disabled = true;
    return;
  }

  if(!drawClosed){
    closePolyBtn.style.display = "inline-flex";
    closePolyBtn.disabled = drawPoints.length < 3;

    if(drawPoints.length < 3){
      drawStatus.textContent = "Поставьте минимум 3 точки по полу";
    } else {
      drawStatus.textContent = "Наведитесь на первую точку и замкните контур";
    }

    hideAction();
    return;
  }

  closePolyBtn.style.display = "none";
  closePolyBtn.disabled = true;

  if(!fillMesh){
    drawStatus.textContent = "Контур замкнут. Нажмите «Визуализировать».";
    showAction("Визуализировать");
  } else {
    drawStatus.textContent = "Готово. Можно сделать скриншот.";
    showAction("Сделать скриншот");
  }
}

function rebuildDrawLine(livePoint){
    if(drawLine){
      drawGroup.remove(drawLine);
      drawLine.geometry.dispose();
      drawLine.material.dispose();
      drawLine = null;
    }

    const pts = drawPoints.slice();

    // preview: last segment to current reticle (only while contour is open)
    if(livePoint && !drawClosed){
      const lp = livePoint.clone();
      if(drawOrigin) lp.y = drawOrigin.y;
      pts.push(lp);
    }

    // closed contour: connect last to first
    if(drawClosed && pts.length >= 2){
      const first = drawOrigin || pts[0];
      if(first) pts.push(first);
    }

    if(pts.length < 2) return;

    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
    drawLine = new THREE.Line(geom, mat);
    drawLine.renderOrder = 10;
    drawLine.material.depthTest = false;
    drawLine.material.depthWrite = false;
    drawGroup.add(drawLine);
  }
  function addDrawPoint(p){
    if(!p) return;

    // Если контур уже замкнут — не добавляем новые точки (сначала Undo/Reset)
    if(drawClosed){
      updateDrawUI();
      return;
    }

    // Делаем контур ПЛОСКИМ: фиксируем Y по первой точке (так линия и заливка будут строго по полу)
    const pp = p.clone();
    if(drawOrigin) pp.y = drawOrigin.y;

    // Авто-замыкание: если тапнули рядом с первой точкой (считаем дистанцию по полу, в XZ)
    const CLOSE_THRESH_M = 0.12; // 12 см (точнее, чем 22 см)
    if(drawOrigin && drawPoints.length >= 3){
      const d = distXZ(pp, drawOrigin);
      if(d < CLOSE_THRESH_M){
        drawClosed = true;

        // лёгкая тактильная обратная связь, если доступно
        try { if(navigator.vibrate) navigator.vibrate(20); } catch(e){}

        // Обновим линию (замкнётся на первую точку)
        rebuildDrawLine(null);

        // Площадь/периметр по уже набранным точкам
        const area = polygonAreaXZ(drawPoints);
        const per = polygonPerimeter(drawPoints);
        areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;

        updateDrawUI();
        return;
      }
    }

    drawPoints.push(pp.clone());
    if(!drawOrigin){
      if(floorLocked) pp.y = 0;
      drawOrigin = pp.clone();
    }

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x60a5fa })
    );
    marker.position.copy(pp);
    drawGroup.add(marker);
    drawMarkers.push(marker);

    if(drawPoints.length >= 3){
      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
    } else {
      areaOut.textContent = `Точек: ${drawPoints.length}`;
    }

    rebuildDrawLine(null);
    updateDrawUI();
  }
  function closePolygon(){
    if(drawPoints.length < 3){
      areaOut.textContent = "Нужно минимум 3 точки.";
      return;
    }
    // Build polygon mesh
    ensureSurfaceMesh();
    // compute local points relative to origin
    const origin = drawOrigin || drawPoints[0];
    // ВНИМАНИЕ: ShapeGeometry строится в плоскости XY, а мы хотим XZ.
    // При повороте -90° вокруг X оси координата Y превращается в -Z.
    // Поэтому используем -(dz), чтобы заливка НЕ зеркалилась относительно контура.
    let pts2 = drawPoints.map(p => new THREE.Vector2(p.x - origin.x, -(p.z - origin.z)));

    // Приводим направление обхода к корректному (наружный контур — против часовой)
    if(THREE.ShapeUtils && THREE.ShapeUtils.isClockWise(pts2)) pts2 = pts2.reverse();

    const shape = new THREE.Shape(pts2);
    const geom = new THREE.ShapeGeometry(shape); // in XY
    applyUVs(geom);

    const old = surfaceMesh.geometry;
    surfaceMesh.geometry = geom;
    if(old) old.dispose();

    surfaceMesh.position.set(origin.x, origin.y, origin.z);
    // Для заливки внутри контура НЕ вращаем саму геометрию по Y (иначе она уедет относительно точек).
    surfaceType = "poly";
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);

    surfaceBaseY = origin.y;
    applyHeightOffset();

    surfaceReady = true;
    startSurfaceFade(360);

    const area = polygonAreaXZ(drawPoints);
    const per = polygonPerimeter(drawPoints);
    areaOut.textContent = `Готово • Площадь: ${fmtM(area)} м² • Периметр: ${fmtM(per)} м`;

    // Keep markers/line? For clarity, hide after close
    rebuildDrawLine(null);
  }

  undoBtn.addEventListener("click", ()=>{
    // Если контур замкнут — первый Undo просто "размыкает" его
    if(drawClosed){
      drawClosed = false;
      rebuildDrawLine(null);

      if(drawPoints.length >= 3){
        const area = polygonAreaXZ(drawPoints);
        const per = polygonPerimeter(drawPoints);
        areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
      } else if(drawPoints.length > 0){
        areaOut.textContent = `Точек: ${drawPoints.length}`;
      } else {
        areaOut.textContent = "—";
        drawOrigin = null;
      }

      updateDrawUI();
      return;
    }

    if(drawPoints.length === 0) return;

    drawPoints.pop();
    const marker = drawMarkers.pop();
    if(marker){
      drawGroup.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }

    rebuildDrawLine(null);

    if(drawPoints.length >= 3){
      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
    }else if(drawPoints.length>0){
      areaOut.textContent = `Точек: ${drawPoints.length}`;
    }else{
      areaOut.textContent = "—";
      drawOrigin = null;
    }

    updateDrawUI();
  });
  resetPolyBtn.addEventListener("click", clearDraw);
  closePolyBtn.addEventListener("click", ()=>{
    if(mode !== "draw") return;

    // 1) Если контур ещё открыт — "Замкнуть контур"
    if(!drawClosed){
      if(drawPoints.length < 3){
        updateDrawUI();
        return;
      }
      drawClosed = true;
      rebuildDrawLine(null);

      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;

      updateDrawUI();
      return;
    }

    // 2) Если контур уже замкнут — дальнейшие действия через кнопку «Визуализировать» внизу
    updateDrawUI();
  });

  // Measurement
  function clearMeasure(){
    measureA = null; measureB = null;
    measureOut.textContent = "—";
    if(measureLine){
      lockedRoot.remove(measureLine);
      measureLine.geometry.dispose();
      measureLine.material.dispose();
      measureLine = null;
    }
  }
  clearMeasureBtn.addEventListener("click", clearMeasure);

  function setMeasurePoint(p){
    if(!measureA){
      measureA = p.clone();
      measureOut.textContent = "Точка A установлена. Тапните точку B.";
      return;
    }
    measureB = p.clone();
    const dist = measureA.distanceTo(measureB);
    measureOut.textContent = `Расстояние: ${fmtM(dist)} м`;

    // line
    if(measureLine){
      lockedRoot.remove(measureLine);
      measureLine.geometry.dispose();
      measureLine.material.dispose();
      measureLine=null;
    }
    const geom = new THREE.BufferGeometry().setFromPoints([measureA, measureB]);
    const mat = new THREE.LineBasicMaterial({ color: 0xf59e0b });
    measureLine = new THREE.Line(geom, mat);
    lockedRoot.add(measureLine);
  }

  // Tile selection
  async function selectVariant(variant){
    if(!variant) return;
    currentVariant = variant;
    renderVariants();
    tileNameEl.textContent = `${currentItem?.name || ""} — ${variant.name || ""}`.trim();

    setStatus("загрузка текстур…");
    currentMaterial = await buildMaterialForVariant(variant);
    setStatus(arSession ? "AR активен" : "3D‑превью");

    if(surfaceMesh){
      surfaceMesh.material = currentMaterial;
      // держим прозрачность включенной — так можно делать плавные появления/исчезновения
      surfaceMesh.material.transparent = true;
      surfaceMesh.material.opacity = 1;
    }
  }

  async function selectItem(item){
    currentItem = item;
    const pattern = item?.patternSize_m;
    currentPatternSize = Array.isArray(pattern) ? pattern : [0.3, 0.3];
    renderVariants();
    if(item?.variants && item.variants.length){
      await selectVariant(item.variants[0]);
    }
  }

  // Load catalog & select first item
  setStatus("загрузка каталога…");
  catalog = await loadCatalog();
  // Hide splash once core assets are ready
  hideSplash();
  buildFilters();
  renderCatalog();
  if(catalog.items && catalog.items.length){
    await selectItem(catalog.items[0]);
  } else {
    tileNameEl.textContent = "Каталог пуст";
  }

  // Init surface container
  ensureSurfaceMesh();
  // start hidden until visualized
  if(surfaceMesh){ surfaceMesh.material.transparent = true; surfaceMesh.material.opacity = 0; }

  // Screenshot
  function takeScreenshot(){
  try{
    // Hide UI briefly to keep the shot clean
    document.body.classList.add("hide-ui");
    setTimeout(()=>{
      try{
        const canvas = renderer?.domElement;
        if(!canvas) throw new Error("Canvas not ready");
        const onBlob = (blob)=>{
          if(!blob) throw new Error("Empty screenshot blob");
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `paver-ar-${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        };
        // Prefer toBlob (more memory-friendly)
        if(canvas.toBlob){
          canvas.toBlob(onBlob, "image/png");
        }else{
          const dataURL = canvas.toDataURL("image/png");
          fetch(dataURL).then(r=>r.blob()).then(onBlob);
        }
      }catch(err){
        showDebug("Screenshot failed: " + (err?.message || err));
        setStatus("Скриншот недоступен. Используйте системный скриншот устройства.");
      }finally{
        setTimeout(()=>document.body.classList.remove("hide-ui"), 200);
      }
    }, 120);
  }catch(e){
    showDebug("Screenshot error: " + (e?.message || e));
    document.body.classList.remove("hide-ui");
  }
}

  shotBtn.addEventListener("click", takeScreenshot);

  // WebXR start/stop
  async function isARSupported(){
    try{
      if(!navigator.xr) return false;
      return await navigator.xr.isSessionSupported("immersive-ar");
    }catch(e){
      return false;
    }
  }

  
  async function requestSessionWithFallback(){
    // Try with dom-overlay + depth-sensing + anchors, then fallback progressively
    const base = {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors", "light-estimation", "depth-sensing"],
      domOverlay: { root: document.body },
      depthSensing: {
        usagePreference: ["gpu-optimized", "cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"]
      }
    };

    try{
      return await navigator.xr.requestSession("immersive-ar", base);
    }catch(e1){
      console.warn("requestSession(full) failed, retrying without depth-sensing", e1);
      try{
        return await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hit-test"],
          optionalFeatures: ["dom-overlay", "anchors", "light-estimation"],
          domOverlay: { root: document.body }
        });
      }catch(e2){
        console.warn("requestSession(dom-overlay) failed, retrying without domOverlay", e2);
        return await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hit-test"],
          optionalFeatures: ["anchors", "light-estimation"]
        });
      }
    }
  }

  async function chooseRefSpaceType(session){
    const types = ["local-floor", "bounded-floor", "local"];
    for(const t of types){
      try{
        await session.requestReferenceSpace(t);
        return t;
      }catch(e){ /* try next */ }
    }
    return "local";
  }

  async function startAR(){
    try{
      if(arSession) return;
      setHelp(false);

      const supported = await isARSupported();
      if(!supported){
        setStatus("AR недоступен (показано 3D‑превью)");
        alert("WebXR AR недоступен в этом браузере.\n\nОткройте в Chrome на Android (ARCore). На iPhone Safari WebXR AR обычно не работает.");
        return;
      }

      enterArBtn.disabled = true;

      const session = await requestSessionWithFallback();

      const refType = await chooseRefSpaceType(session);
      renderer.xr.setReferenceSpaceType(refType);

      // Three.js will create the WebGLLayer and manage camera
      await renderer.xr.setSession(session);

      // Чуть стабильнее картинка на некоторых устройствах
      try{ renderer.xr.setFoveation(0); }catch(_){ }

      // Делаем WebGL‑слой прозрачным: тогда видеопоток камеры будет виден.
      // Если оставить непрозрачный clear, WebXR сессия запускается,
      // разрешение на камеру даётся, но пользователь видит "чёрный экран".
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.backgroundColor = "transparent";

      viewerSpace = await session.requestReferenceSpace("viewer");
      // Просим hit-test только по плоскостям (если поддерживается) — меньше "хитов в воздухе"
      try{
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace, entityTypes: ["plane"] });
      }catch(_){
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      }

      lastHitValid = false;
      reticle.visible = false;

      arSession = session;
      arSession.addEventListener("end", onSessionEnd);

      // UI
      exitArBtn.disabled = false;
      enterArBtn.disabled = true;
      setStatus("AR активен — наведите на пол");
      depthSensingAvailable = false;
      controls.setEnabled(false);
      previewGround.visible = false;
      setPanelCollapsed(true);

      // Need manual calibration for stable floor-locked content
      floorLocked = false;
      lockedRoot.matrixAutoUpdate = true;
      lockedRoot.position.set(0,0,0);
      lockedRoot.quaternion.identity();
      lockedRoot.scale.set(1,1,1);
      lockedRoot.updateMatrixWorld(true);
      updateGridUI();
      setModeUI(mode);
      showAction("Калибр. пол", {secondary:true}, ()=>calibBtn?.click());

    }catch(e){
      enterArBtn.disabled = false;
      showDebug(e);
      setStatus("ошибка запуска AR");
    }
  }

  async function stopAR(){
    try{
      if(!arSession) return;
      await arSession.end();
    }catch(e){
      showDebug(e);
    }
  }

  function onSessionEnd(){
    // cleanup
    try{
      if(arSession){
        arSession.removeEventListener("end", onSessionEnd);
      }
    }catch(_){}
    arSession = null;

    hitTestSource = null;
    viewerSpace = null;
    reticle.visible = false;
    lastHitValid = false;

    exitArBtn.disabled = true;
    enterArBtn.disabled = false;
    setStatus("3D‑превью");
    controls.setEnabled(true);
    previewGround.visible = true;

    // Возвращаем непрозрачный фон для 3D‑превью.
    renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);
    renderer.domElement.style.backgroundColor = "";

    // reset calibration/anchors
    floorLocked = false;
    lockedFloorY = 0;
    try{ if(floorAnchor && floorAnchor.delete) floorAnchor.delete(); }catch(_){ }
    floorAnchor = null;
    lastBestHit = null;
    lockedRoot.matrixAutoUpdate = true;
    lockedRoot.position.set(0,0,0);
    lockedRoot.quaternion.identity();
    lockedRoot.scale.set(1,1,1);
    lockedRoot.updateMatrixWorld(true);
    updateGridUI();
    hideAction();
    setModeUI(mode);
  }

  enterArBtn.addEventListener("click", startAR);
  exitArBtn.addEventListener("click", stopAR);

  // Tap handling
  
  // Tap handling
  window.addEventListener("pointerdown", (e)=>{
    if(pointInUI(e.target)) return;
    if(!arSession) return;
    if(!reticle.visible) return;

    // Require calibration for placing points/measurements (prevents фиксацию на стенах и уменьшает дрейф)
    if(!floorLocked && (mode==="draw" || mode==="measure")){
      // small hint
      showAction("Калибр. пол", {secondary:true}, ()=>calibBtn?.click());
      return;
    }

    const pWorld = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    if(floorLocked && lockedFloorY != null){ pWorld.y = lockedFloorY; }
    const p = worldToLockedLocal(pWorld, new THREE.Vector3());

    if(mode === "draw"){
      addDrawPoint(p);
      rebuildDrawLine(null);
    } else if(mode === "measure"){
      setMeasurePoint(p);
    }
  }, { passive:true });

  // Resize
  window.addEventListener("resize", ()=>{
    // В WebXR размер framebuffer контролируется сессией.
    // setSize во время presenting может кидать ошибку на некоторых браузерах.
    if(renderer.xr && renderer.xr.isPresenting) return;

    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  // Main render loop (works for both preview and XR)
  renderer.setAnimationLoop((t, frame)=>{
    
    // Depth-sensing (best effort): update depth texture for occlusion
    if(frame.getDepthInformation){
      const xrCam = renderer.xr.getCamera(camera);
      const subCam = xrCam.isArrayCamera ? xrCam.cameras[0] : xrCam;
      const view = subCam.userData?.view;
      if(view){
        try{
          const di = frame.getDepthInformation(view);
          if(di){
            depthSupported = !!(di.data && di.width && di.height);
            if(depthSupported && !occlusionAutoInit){
              occlusionEnabled = true; // default ON
              occlusionUniforms.uOcclusionEnabled.value = 1.0;
              occlusionAutoInit = true;
            }
            const baseLayer = arSession.renderState.baseLayer;
            const vp = baseLayer.getViewport(view);

            if(!occlusionUniforms.uViewport.value) occlusionUniforms.uViewport.value = new THREE.Vector4();
            if(!occlusionUniforms.uFramebuffer.value) occlusionUniforms.uFramebuffer.value = new THREE.Vector2();
            occlusionUniforms.uViewport.value.set(vp.x, vp.y, vp.width, vp.height);
            const gl = renderer.getContext();
            occlusionUniforms.uFramebuffer.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);

            if(!occlusionUniforms.uDepthTransform.value){
              occlusionUniforms.uDepthTransform.value = new THREE.Matrix4();
            }
            if(di.normDepthBufferFromNormView){
              occlusionUniforms.uDepthTransform.value.fromArray(di.normDepthBufferFromNormView.matrix);
            }else{
              occlusionUniforms.uDepthTransform.value.identity();
            }

            // CPU depth upload to DataTexture (meters)
            if(di.data && di.width && di.height){
              if(!depthTexture || depthW!==di.width || depthH!==di.height){
                depthW = di.width; depthH = di.height;
                depthTexture = new THREE.DataTexture(new Float32Array(depthW*depthH), depthW, depthH, THREE.RedFormat, THREE.FloatType);
                depthTexture.flipY = false;
                depthTexture.needsUpdate = true;
                occlusionUniforms.uDepthTex.value = depthTexture;
              }
              const now = performance.now();
              if(now - lastDepthUpdateTs > 50){
                lastDepthUpdateTs = now;
                const src = di.data;
                const dst = depthTexture.image.data;
                const scale = di.rawValueToMeters || 0;
                for(let i=0;i<src.length;i++) dst[i] = src[i]*scale;
                depthTexture.needsUpdate = true;
              }
            }

            updateOcclusionUI();
            patchOcclusionOnObject(lockedRoot, THREE);
          }else{
            updateOcclusionUI();
          }
        }catch(_){}
      }
    }
// Update locked root from anchor (reduces drift) if available
    if(frame && floorAnchor && floorAnchor.anchorSpace){
      try{
        const refSpace = renderer.xr.getReferenceSpace();
        const ap = frame.getPose(floorAnchor.anchorSpace, refSpace);
        if(ap){
          _tmpMat.fromArray(ap.transform.matrix);
          _tmpMat.decompose(_tmpPos, _tmpQuat, _tmpScale);

          // Update only position from the anchor; keep a stable horizontal frame (no tilt drift)
          lockedRoot.matrixAutoUpdate = true;
          lockedRoot.position.copy(_tmpPos);
          lockedRoot.quaternion.identity();
          lockedRoot.scale.set(1,1,1);
          lockedRoot.updateMatrixWorld(true);
          lockedFloorY = lockedRoot.position.y;
        }
      }catch(e){ /* ignore */ }
    }

    // Depth sensing (occlusion support) detection
    if(frame && !depthSensingAvailable && frame.getDepthInformation){
      try{
        const refSpace = renderer.xr.getReferenceSpace();
        const pose = frame.getViewerPose(refSpace);
        const view = pose?.views?.[0];
        const di = view ? frame.getDepthInformation(view) : null;
        if(di){
          depthSensingAvailable = true;
          console.log("Depth sensing available:", di);
        }
      }catch(_){ }
    }

    // XR hit-test: фильтруем "пол" + считаем качество пола (блокировка ранней фиксации)

    if(frame && hitTestSource){

      const refSpace = renderer.xr.getReferenceSpace();

      const hitTestResults = frame.getHitTestResults(hitTestSource);


      let found = false;

      let bestHit = null;

      let bestUpDot = -1;


      for(const hit of hitTestResults){

        const pose = hit.getPose(refSpace);

        if(!pose) continue;


        _tmpMat.fromArray(pose.transform.matrix);

        _tmpMat.decompose(_tmpPos, _tmpQuat, _tmpScale);


        _tmpNormal.set(0,1,0).applyQuaternion(_tmpQuat).normalize();

        const upDot = _tmpNormal.dot(_worldUp);

        if(upDot < HIT_NORMAL_DOT) continue;


        if(floorLocked && Math.abs(_tmpPos.y - lockedFloorY) > FLOOR_Y_EPS) continue;


        if(upDot > bestUpDot){

          bestUpDot = upDot;

          bestHit = hit;

          _bestPos.copy(_tmpPos);

          _bestQuat.copy(_tmpQuat);

          found = true;

        }

      }


      if(found){

        camera.getWorldPosition(_camPos);

        const dist = _camPos.distanceTo(_bestPos);


        // Считаем качество только ДО калибровки пола

        if(!floorLocked && dist >= QUALITY_MIN_DISTANCE_M){

          const nowSec = performance.now() / 1000;


          qualitySamples.push({ t: nowSec, pos: _bestPos.clone() });

          while(qualitySamples.length && (nowSec - qualitySamples[0].t) > QUALITY_WINDOW_SECONDS){

            qualitySamples.shift();

          }


          const stableReady = computeFloorQuality(nowSec);

          if(calibBtn) calibBtn.disabled = !stableReady;

        } else {

          if(calibBtn && !floorLocked) calibBtn.disabled = true;

          if(!floorLocked){

            floorQuality = 0;

            floorQualityState = "bad";

            qualityStableSince = 0;

            updateFloorQualityUI();

          }

        }


        lastBestHit = bestHit;


        // сглаживаем ретикл

        if(!lastHitValid){

          lastHitPos.copy(_bestPos);

          lastHitQuat.copy(_bestQuat);

          lastHitValid=true;

        }else{

          lastHitPos.lerp(_bestPos, HIT_SMOOTHING);

          lastHitQuat.slerp(_bestQuat, HIT_SMOOTHING);

        }


        reticle.visible=true;

        reticle.position.copy(lastHitPos);

        if(floorLocked){

          reticle.position.y = lockedFloorY;

        }

        reticle.quaternion.set(0,0,0,1);

        reticle.matrix.compose(reticle.position, reticle.quaternion, reticle.scale);


        if(mode==="draw" && floorLocked && drawPoints.length>0 && !drawClosed){

          rebuildDrawLine(reticle.position);

        }

      } else {

        reticle.visible=false;

        lastHitValid=false;

        if(calibBtn && !floorLocked) calibBtn.disabled = true;


        if(!floorLocked){

          floorQuality = 0;

          floorQualityState = "bad";

          qualityStableSince = 0;

          updateFloorQualityUI();

        }


        if(mode==="draw" && drawPoints.length>0 && !drawClosed){

          rebuildDrawLine(null);

        }

      }

    } else {

      if(calibBtn && !floorLocked) calibBtn.disabled = true;

    }

    // Non-AR preview: keep surface on origin
    if(!arSession){
      // 3D preview: показываем только если уже была визуализация
      if(surfaceMesh){
        surfaceMesh.visible = !!surfaceReady;
      }
    }

    updateSurfaceFade(t || performance.now());

    renderer.render(scene, camera);
  });

  // Initial status
  const arOk = await isARSupported();
  setStatus(arOk ? "готово (AR доступен)" : "готово (AR недоступен — 3D‑превью)");
  enterArBtn.disabled = !arOk;
  exitArBtn.disabled = true;

})().catch(showDebug);