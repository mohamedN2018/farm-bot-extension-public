// Farm Bot - background service worker
// Talks to the in-game engine (agent-main.js), keeps the game tab alive, and serves the popup.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getStore() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { settings };
}

function stopAll() {
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs.filter((t) => isGameUrl(t.url))) chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, world: "MAIN", func: () => window.__farmBot?.stop()
    }).catch(() => {});
  });
  getStore().then(({ settings }) => chrome.storage.local.set({
    settings: (settings.mode || "agent") === "agent" ? { ...settings, paused: true } : { ...settings, botOn: false }
  }));
}

// ---------- game scanner ----------

// Runs inside every frame (MAIN world). Must be self-contained.
function inspectFrame() {
  const clean = (s) =>
    String(s).replace(/((?:access_)?token|sig(?:nature)?|signed|fb_dtsg|lsd|session(?:_key)?|auth\w*|ticket|code|key)=([^&#"\s]+)/gi, "$1=***");
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  const g = window;

  const checks = {
    cocos: () => g.cc && (g.cc.ENGINE_VERSION || "yes"),
    laya: () => g.Laya && (g.Laya.version || "yes"),
    egret: () => g.egret && (g.egret.Capabilities?.engineVersion || "yes"),
    pixi: () => g.PIXI && (g.PIXI.VERSION || "yes"),
    phaser: () => g.Phaser && (g.Phaser.VERSION || "yes"),
    createjs: () => g.createjs && "yes",
    three: () => g.THREE && g.THREE.REVISION,
    babylon: () => g.BABYLON && (g.BABYLON.Engine?.Version || "yes"),
    unity: () => (g.createUnityInstance || g.UnityLoader || g.unityInstance || g.gameInstance) && "yes",
    construct: () => (g.C3 || g.cr_getC2Runtime) && "yes",
    playcanvas: () => g.pc && g.pc.version,
    fbinstant: () => g.FBInstant && (safe(() => g.FBInstant.getSDKVersion()) || "yes")
  };
  const engine = {};
  for (const [k, f] of Object.entries(checks)) {
    const v = safe(f);
    if (v) engine[k] = String(v);
  }

  const canvases = [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`);
  const iframes = [...document.querySelectorAll("iframe")].map((f) => clean(f.src).slice(0, 200));

  const hosts = {}, files = [];
  for (const r of safe(() => performance.getEntriesByType("resource")) || []) {
    const u = safe(() => new URL(r.name));
    if (!u) continue;
    hosts[u.host] = (hosts[u.host] || 0) + 1;
    if (/\.(js|wasm|json|data|unityweb|bin|proto|pb|atlas|plist|xml|txt)$/i.test(u.pathname) && files.length < 150)
      files.push(u.host + u.pathname);
  }

  const base = g.__fmBaseline;
  const globals = Object.keys(g)
    .filter((k) => (base ? !base.has(k) : !/^(on|webkit)/.test(k)) && !k.startsWith("__fm"))
    .slice(0, 300);

  const walk = (n, depth, kids, name) => ({
    name: name(n),
    children: depth ? kids(n).slice(0, 40).map((c) => walk(c, depth - 1, kids, name)) : kids(n).length
  });
  const scene =
    safe(() => g.cc?.director?.getScene && walk(g.cc.director.getScene(), 3, (n) => n.children || [], (n) => n.name)) ||
    safe(() => g.Laya?.stage && walk(g.Laya.stage, 3,
      (n) => Array.from({ length: n.numChildren || 0 }, (_, i) => n.getChildAt(i)),
      (n) => n.name || n.constructor?.name)) ||
    safe(() => g.egret?.MainContext?.instance?.stage && walk(g.egret.MainContext.instance.stage, 3,
      (n) => Array.from({ length: n.numChildren || 0 }, (_, i) => n.getChildAt(i)),
      (n) => n.name || n.constructor?.name));

  return {
    url: clean(location.href).slice(0, 300),
    title: document.title,
    engine, canvases, iframes, hosts, files, globals, scene,
    hooked: !!g.__fmProbeLog,
    net: safe(() => g.__fmProbeLog?.())
  };
}

async function scan(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: inspectFrame
  });
  const frames = results
    .filter((r) => r.result)
    .map((r) => ({ frameId: r.frameId, ...r.result }))
    // keep frames that look like part of the game
    .filter((f) => f.frameId === 0 || f.canvases.length || Object.keys(f.engine).length ||
      f.net?.sockets.length || f.net?.http.length);
  for (const f of frames) if (f.frameId === 0) { f.globals = f.globals.length; f.files = f.files.length; }
  return { scannedAt: new Date().toISOString(), ua: navigator.userAgent, frames };
}

// ---------- deep scan (Egret scene + data managers) ----------

// Runs inside every frame (MAIN world); only the Egret game frame returns data.
function deepScanFrame() {
  const g = window, eg = g.egret;
  const stage = eg?.MainContext?.instance?.stage;
  if (!stage) return null;
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  const cls = (o) => safe(() => eg.getQualifiedClassName(o)) || o?.constructor?.name || typeof o;
  const EVENTS = ["touchTap", "touchBegin", "touchEnd", "click"];

  // primitive own fields (game data) + class names of object fields (links to models)
  const describe = (o, maxP = 25, maxR = 15) => {
    const p = {}, r = {};
    let np = 0, nr = 0;
    for (const k of Object.keys(o)) {
      if (k[0] === "$" || k === "hashCode") continue;
      const v = safe(() => o[k]);
      const t = typeof v;
      if ((t === "number" || t === "string" || t === "boolean") && np < maxP) {
        p[k] = t === "string" ? v.slice(0, 80) : v; np++;
      } else if (v && t === "object" && nr < maxR) {
        r[k] = Array.isArray(v) ? `Array(${v.length})` : cls(v); nr++;
      }
    }
    return { p, r };
  };

  const counts = {}, nodes = [];
  const MAX_NODES = 3000;
  const walk = (o, depth) => {
    if (nodes.length >= MAX_NODES || !o) return;
    const c = cls(o);
    counts[c] = (counts[c] || 0) + 1;
    const pt = safe(() => o.localToGlobal(0, 0)) || { x: 0, y: 0 };
    const { p, r } = describe(o);
    const n = o.numChildren || 0;
    nodes.push({
      d: depth, c, n: o.name || "",
      x: Math.round(pt.x), y: Math.round(pt.y),
      w: Math.round(safe(() => o.width) || 0), h: Math.round(safe(() => o.height) || 0),
      vis: o.visible, te: o.touchEnabled,
      ev: EVENTS.filter((e) => safe(() => o.hasEventListener(e))),
      k: n, p, r
    });
    if (depth < 12) for (let i = 0; i < n; i++) walk(safe(() => o.getChildAt(i)), depth + 1);
  };
  walk(stage, 0);

  // game classes on window (skip UI skins) and their singletons (data managers)
  const base = g.__fmBaseline;
  const globals = Object.keys(g).filter((k) =>
    (!base || !base.has(k)) && !/Skin$/.test(k) && !k.startsWith("__fm") && typeof g[k] === "function");
  const singletons = {};
  for (const k of globals) {
    for (const f of ["instance", "_instance", "ins", "_ins", "inst"]) {
      const inst = safe(() => g[k][f]);
      if (inst && typeof inst === "object") { singletons[`${k}.${f}`] = { c: cls(inst), ...describe(inst, 40, 40) }; break; }
    }
    if (!singletons[k] && typeof safe(() => g[k].getInstance) === "function") {
      const inst = safe(() => g[k].getInstance());
      if (inst && typeof inst === "object") singletons[`${k}.getInstance()`] = { c: cls(inst), ...describe(inst, 40, 40) };
    }
  }

  return {
    url: location.href.split("?")[0],
    stage: { w: stage.stageWidth, h: stage.stageHeight, scaleMode: stage.scaleMode },
    canvas: safe(() => { const cv = document.querySelector("canvas"); const b = cv.getBoundingClientRect(); return { w: cv.width, h: cv.height, cssW: b.width, cssH: b.height }; }),
    classCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
    globals,
    singletons,
    nodes
  };
}

// Runs inside every frame (MAIN world): game functions related to farming + sample object data.
function apiScanFrame() {
  const g = window, eg = g.egret;
  const stage = eg?.MainContext?.instance?.stage;
  if (!stage) return null;
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  const cls = (o) => safe(() => eg.getQualifiedClassName(o)) || o?.constructor?.name;
  const KEY = /harvest|collect|plow|plant|seed|click|tap|touch|ripe|feed|refill|ready|action|process|state|grow|water|fertil|select|tool|cursor|batch|send|request/i;

  const methods = (proto) => {
    const out = [];
    for (let p = proto, lvl = 0; p && p !== Object.prototype && lvl < 6; p = Object.getPrototypeOf(p), lvl++) {
      const names = Object.getOwnPropertyNames(p).filter((k) => k !== "constructor" && typeof safe(() => Object.getOwnPropertyDescriptor(p, k).value) === "function");
      const src = {};
      for (const k of names) {
        if (!KEY.test(k)) continue;
        const s = safe(() => String(p[k]));
        if (s) src[k] = s.length > 900 ? s.slice(0, 900) + " …" : s;
      }
      out.push({ level: lvl, cls: safe(() => p.__class__) || safe(() => p.constructor.name), methods: names, src });
      if (/^egret\./.test(safe(() => p.__class__) || "")) break;
    }
    return out;
  };

  const json = (v, max = 2500) => {
    const seen = new WeakSet();
    const s = safe(() => JSON.stringify(v, (k, x) => {
      if (x && typeof x === "object") {
        if (seen.has(x)) return "[circular]";
        seen.add(x);
        if (x instanceof eg.DisplayObject) return `[${cls(x)}]`;
      }
      return x;
    }));
    return s && s.length > max ? s.slice(0, max) + " …" : s;
  };

  // find live farm objects
  const samples = {};
  const want = new Set(["Plant", "Soil", "Tree", "Animal", "Machine", "DryHouse", "Greenhouse"]);
  const walk = (o, d) => {
    if (!o || d > 9) return;
    const c = cls(o);
    if (want.has(c)) {
      const s = (samples[c] = samples[c] || { count: 0, data: [] });
      s.count++;
      if (s.data.length < 3) s.data.push(json(safe(() => o._data)));
    }
    for (let i = 0; i < (o.numChildren || 0); i++) walk(safe(() => o.getChildAt(i)), d + 1);
  };
  walk(stage, 0);

  const classes = {};
  for (const name of ["Plant", "Soil", "Tree", "Animal", "Machine", "MapObject1", "CollectObject", "GameView",
    "GameController", "GameModel", "UserActionManager", "AutoPlowManager", "TouchEventHook", "BaseGameController"]) {
    const C = g[name];
    if (typeof C === "function") classes[name] = methods(C.prototype);
  }

  // live controller / model behind the farm view
  let view = null;
  const findView = (o, d) => {
    if (!o || view || d > 6) return;
    if (cls(o) === "GameView") { view = o; return; }
    for (let i = 0; i < (o.numChildren || 0); i++) findView(safe(() => o.getChildAt(i)), d + 1);
  };
  findView(stage, 0);
  const live = view && {
    controller: safe(() => view._controller && { cls: cls(view._controller), methods: methods(Object.getPrototypeOf(view._controller)) }),
    model: safe(() => view.gameModel && { cls: cls(view.gameModel), keys: Object.keys(view.gameModel).slice(0, 120) })
  };

  const autoPlow = safe(() => g.AutoPlowManager?.ins && json(g.AutoPlowManager.ins, 1500));
  const userAction = safe(() => g.UserActionManager?._instance && json(g.UserActionManager._instance, 1500));

  return { samples, classes, live, autoPlow, userAction };
}

// ---------- watchdog: keeps the game open while the bot is on (inside working hours) ----------
const GAME_URL = "https://www.facebook.com/gaming/play/363893212342994/";
const isGameUrl = (u) => /facebook\.com\/gaming\/play\/363893212342994/.test(u || "");

function inWorkingHours(settings) {
  if (settings.restOn === false) return true;
  const m = (hhmm) => { const [h, mi] = String(hhmm).split(":").map(Number); return (h || 0) * 60 + (mi || 0); };
  const now = new Date(), cur = now.getHours() * 60 + now.getMinutes();
  const from = m(settings.restFrom || "08:00"), to = m(settings.restTo || "23:00");
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

const botEnabled = (settings) =>
  (settings.mode || "agent") === "agent" ? !settings.paused : !!settings.botOn;

// Reload the game page. Never more than once every 3 minutes, so a slow load can't turn into a reload loop.
async function reloadGame(tabId, why) {
  const { lastReload } = await chrome.storage.local.get("lastReload");
  if (lastReload && Date.now() - (lastReload.at || 0) < 3 * 60000) return false;
  tabId = await gameTabId(tabId);
  if (tabId == null) return false;
  await chrome.storage.local.set({ lastReload: { at: Date.now(), why } });
  await chrome.tabs.reload(tabId);
  return true;
}

// today's daily-gift reload time (default 08:00): the game only hands out the login gift on a fresh load
function dailyReloadAt(settings) {
  const [h, mi] = String(settings.dailyReload || "08:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, mi || 0, 0, 0);
  return d.getTime();
}

// Once a day at 08:00 (or the first check after it, if the PC was asleep): reload a game page that was
// loaded before that time, so the game shows the daily login gift / sign-in rewards. Runs even while
// the bot is paused; a failed reload is tried again on the next check (every 5 min) until it happens.
async function dailyReload() {
  const { settings = {}, botStatus, lastDailyReload = 0 } = await chrome.storage.local.get(["settings", "botStatus", "lastDailyReload"]);
  if (settings.dailyReloadOn === false) return false;
  const at = dailyReloadAt(settings);
  if (Date.now() < at || lastDailyReload >= at) return false;
  const tabs = (await chrome.tabs.query({})).filter((t) => isGameUrl(t.url));
  if (!tabs.length) return false; // the watchdog opens the game, that fresh load shows the gift by itself
  if (botStatus && botStatus.pageAt >= at) { // already loaded after 08:00
    await chrome.storage.local.set({ lastDailyReload: Date.now() });
    return false;
  }
  await chrome.storage.local.remove("lastReload"); // the daily reload is never held back by the rate limit
  if (!(await reloadGame(tabs[0].id, "daily gift").catch(() => false))) return false;
  await chrome.storage.local.set({ lastDailyReload: Date.now() });
  return true;
}

// an exact alarm for the daily reload (the 5-minute watchdog is the fallback)
async function scheduleDailyReload() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  let when = dailyReloadAt(settings);
  if (when <= Date.now()) when += 24 * 3600000;
  await chrome.alarms.create("daily-reload", { when });
}

async function watchdog() {
  const { settings = {}, botStatus } = await chrome.storage.local.get(["settings", "botStatus"]);
  if (await dailyReload().catch(() => false)) return;
  if (!botEnabled(settings)) return;
  const tabs = (await chrome.tabs.query({})).filter((t) => isGameUrl(t.url));
  if (settings.watchdog === false || !inWorkingHours(settings)) return;
  for (const t of tabs) if (t.autoDiscardable !== false) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
  if (!tabs.length) {
    // game closed: open it again in its own window (a normal visit, same Facebook session)
    await chrome.windows.create({ url: GAME_URL, focused: false, state: "normal", width: 1280, height: 800 });
    return;
  }
  // game open but the bot stopped reporting (crash / disconnect / frozen): reload once
  const quiet = !botStatus || Date.now() - (botStatus.updated || 0) > 15 * 60000;
  if (quiet && !tabs[0].discarded) reloadGame(tabs[0].id, "quiet").catch(() => {});
  else if (tabs[0].discarded) chrome.tabs.reload(tabs[0].id).catch(() => {});
}

// The service worker wakes up many times a day. Creating an alarm again on every wake-up would restart
// its countdown (so it might never fire), and an API call made while Chrome is still registering an
// updated worker rejects with "No SW". So: create only when missing, and never leave a promise unhandled.
function ensureAlarm(name, info) {
  Promise.resolve()
    .then(() => chrome.alarms.get(name))
    .then((a) => { if (!a) return chrome.alarms.create(name, info); })
    .catch(() => setTimeout(() => ensureAlarm(name, info), 2000));
}
ensureAlarm("watchdog", { periodInMinutes: 5 });
Promise.resolve().then(() => chrome.alarms.get("daily-reload")).then((a) => { if (!a) return scheduleDailyReload(); }).catch(() => {});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "watchdog") watchdog().catch(() => {});
  if (a.name === "daily-reload") dailyReload().catch(() => {}).then(() => scheduleDailyReload()).catch(() => {});
});
chrome.storage.onChanged.addListener((ch, area) => {
  const o = ch.settings && ch.settings.oldValue, n = ch.settings && ch.settings.newValue;
  if (area === "local" && n && (!o || o.dailyReload !== n.dailyReload)) scheduleDailyReload().catch(() => {});
});

// ---------- farm bot (engine lives in agent-main.js inside the game frame) ----------

// (Re)attach the bot to a tab: the bridge must be fresh after every extension reload,
// the in-game engine is only injected if it isn't already running there.
async function attachBot(tabId) {
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {}); // Memory Saver must not unload the game
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: ["agent-main.js"] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["agent-bridge.js"] }).catch(() => {});
}

async function attachAllGameTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://web.facebook.com/*"] });
  for (const t of tabs) attachBot(t.id);
}
// builds can add defaults.json (server: no stop time; standalone: AI trainer off); the player's own choices win
async function applyDefaults() {
  const r = await fetch(chrome.runtime.getURL("defaults.json")).catch(() => null);
  if (!r || !r.ok) return;
  const d = await r.json().catch(() => null);
  if (!d || typeof d !== "object") return;
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (Object.keys(d).some((k) => !(k in settings))) await chrome.storage.local.set({ settings: { ...d, ...settings } });
}
chrome.runtime.onInstalled.addListener(() => applyDefaults().catch(() => {}).then(() => attachAllGameTabs()).catch(() => {}));
chrome.runtime.onStartup.addListener(() => applyDefaults().catch(() => {}).then(() => attachAllGameTabs()).catch(() => {}));

async function gameTabId(preferred) {
  const tabs = (await chrome.tabs.query({})).filter((t) => isGameUrl(t.url));
  if (!tabs.length) return null;
  return (tabs.find((t) => t.id === preferred) || tabs[0]).id;
}

async function farm(preferredTab, action) {
  const tabId = await gameTabId(preferredTab);
  if (!tabId) throw new Error("اللعبة مش مفتوحة — افتح مزرعتنا السعيدة على فيسبوك");
  const call = () => chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: async (a) => {
      if (!/^apps-\d+\.apps\.fbsbx\.com$/i.test(location.hostname)) return null; // not the game frame
      if (!window.__farmBot) return { error: "__nobot" };
      try { return (await window.__farmBot.run(a)) || { error: "اللعبة لسه بتحمّل — استنى شوية" }; }
      catch (e) { return { error: "خطأ في البوت: " + (e && e.message) }; }
    },
    args: [action]
  });
  let hit = (await call()).find((r) => r.result);
  if (!hit || hit.result.error === "__nobot") {
    await attachBot(tabId);
    await sleep(1000);
    hit = (await call()).find((r) => r.result);
  }
  if (!hit) throw new Error("فريم اللعبة لسه ماتحمّلش — استنى لحد ما المزرعة تظهر على الشاشة");
  if (hit.result.error === "__nobot") throw new Error("البوت ماتحمّلش جوه اللعبة — اعمل F5 للعبة مرة واحدة");
  if (hit.result.error) throw new Error(hit.result.error);
  return hit.result;
}

// Runs inside every frame (MAIN world): how the game sells from the barn, switches farms (scenes)
// and expands — names + short sources of the relevant functions, and numeric player resources only.
function econScanFrame() {
  const g = window, eg = g.egret;
  if (!eg?.MainContext?.instance?.stage) return null;
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  const KEY = /sell|expand|scene|warehouse|barn|storage|truck|order|ship|market|trade|coin|gold|C2S/i;
  let srcBudget = 220;
  const proto = (P, depth = 3) => {
    const out = [];
    for (let p = P, lvl = 0; p && p !== Object.prototype && lvl < depth; p = Object.getPrototypeOf(p), lvl++) {
      const cls = safe(() => p.__class__) || safe(() => p.constructor.name);
      if (/^egret\.|^eui\./.test(cls || "")) break;
      const names = Object.getOwnPropertyNames(p).filter((k) => k !== "constructor" && typeof safe(() => Object.getOwnPropertyDescriptor(p, k).value) === "function");
      const src = {};
      for (const k of names) {
        if (!KEY.test(k) || srcBudget <= 0) continue;
        const s = safe(() => String(p[k]));
        if (s) { src[k] = s.length > 700 ? s.slice(0, 700) + " …" : s; srcBudget--; }
      }
      out.push({ cls, methods: names, src });
    }
    return out;
  };
  const numbers = (o) => {
    const out = {};
    for (const k of Object.keys(o || {})) {
      const v = safe(() => o[k]);
      if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    return out;
  };
  const constKeys = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => KEY.test(k)).slice(0, 200));

  const lm = safe(() => g.GF.loginModel);
  const globals = Object.keys(g).filter((k) =>
    KEY.test(k) && !/Skin\d*$|Item\d*$|Render$|Btn\d*$|Icon\d*$|Tab\d*$/.test(k) && typeof safe(() => g[k]) === "function");

  // the live controller behind the farm view
  let view = null;
  const find = (o, d) => {
    if (!o || view || d > 6) return;
    if (safe(() => eg.getQualifiedClassName(o)) === "GameView") { view = o; return; }
    for (let i = 0; i < (o.numChildren || 0); i++) find(safe(() => o.getChildAt(i)), d + 1);
  };
  find(eg.MainContext.instance.stage, 0);

  return {
    loginModel: lm && { methods: proto(Object.getPrototypeOf(lm)), numbers: numbers(lm), appData: numbers(safe(() => lm.AppData)) },
    gameView: view && proto(Object.getPrototypeOf(view), 1),
    controller: view && proto(Object.getPrototypeOf(view._controller), 1),
    sceneManager: safe(() => g.SceneManager._instance) && { methods: proto(Object.getPrototypeOf(g.SceneManager._instance)), numbers: numbers(g.SceneManager._instance) },
    consts: { LoginConst: constKeys(g.LoginConst), GameConst: constKeys(g.GameConst), ControllerConst: constKeys(g.ControllerConst) },
    classes: Object.fromEntries(globals.slice(0, 260).map((k) => [k, proto(safe(() => g[k].prototype), 2)]))
  };
}

// Runs inside every frame (MAIN world). Everything the agent still can't use on its own:
// orders (pay more than the barn), switching a machine's product, fertilizer / watering,
// buying from the shop, barn capacity, dry machine. Method names + short sources, numbers only.
function capsScanFrame() {
  const g = window, eg = g.egret;
  if (!eg?.MainContext?.instance?.stage) return null;
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  let budget = 400;
  const src = (fn, max = 900) => { const s = safe(() => String(fn)); return s && s.length > max ? s.slice(0, max) + " …" : s; };
  const proto = (P, want, depth = 3) => {
    const out = [];
    for (let p = P, lvl = 0; p && p !== Object.prototype && lvl < depth; p = Object.getPrototypeOf(p), lvl++) {
      const cls = safe(() => p.__class__) || safe(() => p.constructor.name);
      if (/^egret\.|^eui\./.test(cls || "")) break;
      const names = safe(() => Object.getOwnPropertyNames(p)) || [];
      const methods = names.filter((k) => k !== "constructor" && typeof safe(() => Object.getOwnPropertyDescriptor(p, k).value) === "function");
      const sources = {};
      for (const k of methods) if ((!want || want.test(k)) && budget > 0) { const s = src(p[k]); if (s) { sources[k] = s; budget--; } }
      out.push({ cls, methods, sources });
    }
    return out;
  };
  const numbers = (o, max = 150) => {
    const out = {};
    let n = 0;
    for (const k of safe(() => Object.keys(o || {})) || []) {
      const v = safe(() => o[k]);
      if ((typeof v === "number" || typeof v === "boolean") && n++ < max) out[k] = v;
    }
    return out;
  };
  const plain = (o, max = 3000) => { const s = safe(() => JSON.stringify(o)); return s && s.length > max ? s.slice(0, max) + " …" : s; };
  const inst = (name) => {
    const C = g[name];
    if (typeof C !== "function") return null;
    for (const f of ["instance", "_instance", "ins", "_ins", "self"]) { const i = safe(() => C[f]); if (i && typeof i === "object") return i; }
    const seen = new Set();
    const look = (o, d) => {
      if (!o || typeof o !== "object" || seen.has(o) || d > 3 || seen.size > 40000) return null;
      seen.add(o);
      if (o instanceof C) return o;
      for (const k of safe(() => Object.keys(o)) || []) { const r = look(safe(() => o[k]), d + 1); if (r) return r; }
      return null;
    };
    return look(safe(() => g.App.ControllerManager), 0) || look(g.GF, 0);
  };
  const classInfo = (name, want) => {
    const C = g[name];
    if (typeof C !== "function") return null;
    const i = inst(name);
    return { proto: proto(C.prototype, want), instanceNumbers: i ? numbers(i) : null, instanceKeys: i ? (safe(() => Object.keys(i)) || []).slice(0, 80) : null };
  };
  const lm = safe(() => g.GF.loginModel);
  const ad = safe(() => lm.AppData) || {};

  // the farm view's controller: the exact functions behind fertilizer / water / shop / tools
  let view = null;
  const find = (o, d) => { if (!o || view || d > 6) return; if (safe(() => eg.getQualifiedClassName(o)) === "GameView") { view = o; return; } for (let i = 0; i < (o.numChildren || 0); i++) find(safe(() => o.getChildAt(i)), d + 1); };
  find(eg.MainContext.instance.stage, 0);
  const ctrl = view && view._controller;

  // one live machine: how products are chosen / switched
  let machine = null;
  const findM = (o, d) => { if (!o || machine || d > 10) return; if (safe(() => eg.getQualifiedClassName(o)) === "Machine") { machine = o; return; } for (let i = 0; i < (o.numChildren || 0); i++) findM(safe(() => o.getChildAt(i)), d + 1); };
  findM(eg.MainContext.instance.stage, 0);

  const ORDER = /order|ship|trade|reward|fetch|finish|complete|deliver|refresh|accept|item|get|can|list|data|init|update|open|claim|require/i;
  const out = {
    player: { level: ad.level, coins: ad.coins, size_x: ad.size_x, top_map_size: ad.top_map_size, storageKinds: Object.keys(ad.storage || {}).length,
      storageTotal: Object.values(ad.storage || {}).reduce((a, v) => a + (Number(v) || 0), 0),
      capacityLike: Object.fromEntries(Object.entries(ad).filter(([k]) => /capacity|limit|max|size|barn|storage|warehouse|slot/i.test(k) && typeof ad[k] !== "object")) },
    loginModelStorageMethods: lm && proto(Object.getPrototypeOf(lm), /storage|capacity|barn|warehouse|shopBuy|isMeetBuyCondition|getShopCostInfo|dry|limit/i, 1),
    controller: ctrl && proto(Object.getPrototypeOf(ctrl), /fertil|water|kettle|enhance|shop|createMapObject|_createMapObject|setADD_MO_Tool|toolExecute|onToolConfirm|moBy|checkSpareGrid|buy|switch|dry|irrigat|rain|automation|pollinat/i, 1),
    machine: machine && { numbers: numbers(machine), proto: proto(Object.getPrototypeOf(machine), /switch|product|raw|select|queue|auto|refill/i, 2),
      configProduct: plain(safe(() => machine.configData.product), 600), configRaw: plain(safe(() => machine.configData.raw_material), 600), serverData: plain(safe(() => machine.serverData), 800) },
    orders: {
      OrderCenterContoller: classInfo("OrderCenterContoller", ORDER), OrderCenterModel: classInfo("OrderCenterModel", ORDER),
      TradeOrderController: classInfo("TradeOrderController", ORDER), TradeOrderModel: classInfo("TradeOrderModel", ORDER),
      ShipOrderController: classInfo("ShipOrderController", ORDER), ShipOrderModel: classInfo("ShipOrderModel", ORDER),
      sampleData: { trade: plain(safe(() => ad.trade_order || ad.tradeOrder || ad.trade), 2500), ship: plain(safe(() => ad.ship_order || ad.shipOrder), 2500),
        orderKeys: Object.keys(ad).filter((k) => /order|trade|ship|truck|npc/i.test(k)) }
    },
    shop: { ShopController: classInfo("ShopController", /buy|item|open|tab|list|price|can|add|mo/i), ShopModel: classInfo("ShopModel", /buy|item|list|price|can|get/i),
      ShopConst: plain(g.ShopConst, 1500), Config_Store_Action: plain(g.Config_Store$Action, 1500), Config_Store_Type: plain(g.Config_Store$Type, 800) },
    fertilizer: { FertilizerObject: proto(safe(() => g.FertilizerObject.prototype), /fertil|water|double|can_be|getOP|harvest/i, 1),
      items: Object.entries(ad.storage || {}).filter(([id]) => /fertil|water|kettle|rain/i.test(safe(() => g.Config.Store_GetItemData(Number(id)).name) || safe(() => g.Config.Store_GetItemData(Number(id)).type) || ""))
        .map(([id, q]) => ({ id, q, name: safe(() => g.Config.Store_GetItemData(Number(id)).name), type: safe(() => g.Config.Store_GetItemData(Number(id)).type) })).slice(0, 30),
      opTreasure: { op: ad.op, gas: ad.gas } },
    dry: classInfo("DryMachineManager", /capacity|left|add|product|collect|trade|sell|list/i),
    automation: classInfo("AutomationManager", /./) || (ctrl && proto(Object.getPrototypeOf(ctrl), /automation/i, 1)),
    expand: { ExpandController: classInfo("ExpandController", /buy|expand|open|preview/i), nextItems: plain(safe(() => inst("ExpandModel").getExpandList().map((x) => ({ id: x.id, name: x.name, price: x.price, rp: x.rp_price, size: x.size, action: x.action }))), 1500) },
    consts: { ControllerConst: plain(g.ControllerConst, 4000), LoginConst: plain(g.LoginConst, 6000), GameConst: plain(g.GameConst, 6000), TradeOrderConst: plain(g.TradeOrderConst, 1500), ShipOrderConst: plain(g.ShipOrderConst, 1500), OrderCenterConst: plain(g.OrderCenterConst, 1500) }
  };
  return out;
}

// Runs inside every frame (MAIN world). The social / events / land side of the game:
// neighbour help requests, gifts, active events, plowing new soil, moving objects, farms list.
function worldScanFrame() {
  const g = window, eg = g.egret;
  if (!eg?.MainContext?.instance?.stage) return null;
  const safe = (f) => { try { return f(); } catch { return undefined; } };
  let budget = 320;
  const src = (fn, max = 800) => { const s = safe(() => String(fn)); return s && s.length > max ? s.slice(0, max) + " …" : s; };
  const proto = (P, want, depth = 2) => {
    const out = [];
    for (let p = P, lvl = 0; p && p !== Object.prototype && lvl < depth; p = Object.getPrototypeOf(p), lvl++) {
      const cls = safe(() => p.__class__) || safe(() => p.constructor.name);
      if (/^egret\.|^eui\./.test(cls || "")) break;
      const names = safe(() => Object.getOwnPropertyNames(p)) || [];
      const methods = names.filter((k) => k !== "constructor" && typeof safe(() => Object.getOwnPropertyDescriptor(p, k).value) === "function");
      const sources = {};
      for (const k of methods) if ((!want || want.test(k)) && budget > 0) { const s = src(p[k]); if (s) { sources[k] = s; budget--; } }
      out.push({ cls, methods, sources });
    }
    return out;
  };
  const plain = (o, max = 2500) => { const s = safe(() => JSON.stringify(o)); return s && s.length > max ? s.slice(0, max) + " …" : s; };
  const numbers = (o, max = 80) => { const out = {}; let n = 0; for (const k of safe(() => Object.keys(o || {})) || []) { const v = safe(() => o[k]); if ((typeof v === "number" || typeof v === "boolean" || typeof v === "string" && v.length < 40) && n++ < max) out[k] = v; } return out; };
  const inst = (name) => {
    const C = g[name];
    if (typeof C !== "function") return null;
    for (const f of ["instance", "_instance", "ins", "self"]) { const i = safe(() => C[f]); if (i && typeof i === "object") return i; }
    const seen = new Set();
    const look = (o, d) => {
      if (!o || typeof o !== "object" || seen.has(o) || d > 3 || seen.size > 40000) return null;
      seen.add(o);
      if (o instanceof C) return o;
      for (const k of safe(() => Object.keys(o)) || []) { const r = look(safe(() => o[k]), d + 1); if (r) return r; }
      return null;
    };
    return look(safe(() => g.App.ControllerManager), 0) || look(g.GF, 0);
  };
  const classInfo = (name, want) => {
    const C = g[name];
    if (typeof C !== "function") return null;
    const i = inst(name);
    return { proto: proto(C.prototype, want), instance: i ? numbers(i) : null, instanceKeys: i ? (safe(() => Object.keys(i)) || []).slice(0, 80) : null };
  };
  const ad = safe(() => g.GF.loginModel.AppData) || {};
  const SOC = /help|request|wish|gift|friend|neighbor|neighbour|ask|send|accept|material|free|visit|list|data|get|can|need|open|collect|reward|claim/i;
  const friendsModel = safe(() => g.GF.friendsController.model);
  // the farm view controller: plow / move / sow tools
  let view = null;
  const find = (o, d) => { if (!o || view || d > 6) return; if (safe(() => eg.getQualifiedClassName(o)) === "GameView") { view = o; return; } for (let i = 0; i < (o.numChildren || 0); i++) find(safe(() => o.getChildAt(i)), d + 1); };
  find(eg.MainContext.instance.stage, 0);
  const ctrl = view && view._controller;
  const scenes = {};
  for (const k of safe(() => Object.keys(g.FarmScene || {})) || []) scenes[k] = g.FarmScene[k];
  return {
    farms: { FarmScene: scenes, scene_select: ad.scene_select, multi_scene_data: plain(ad.multi_scene_data, 1500), scene_data: plain(ad.scene_data, 800),
      allSceneMapSizes: Object.fromEntries(Object.entries(ad.allSceneMap || {}).map(([k, v]) => [k, (v || []).length])), water_level: ad.water_level },
    friends: { model: friendsModel && { numbers: numbers(friendsModel), keys: (safe(() => Object.keys(friendsModel)) || []).slice(0, 120), proto: proto(Object.getPrototypeOf(friendsModel), SOC, 2) },
      controller: safe(() => g.GF.friendsController) && proto(Object.getPrototypeOf(g.GF.friendsController), SOC, 1),
      helpKeys: Object.keys(ad).filter((k) => /help|request|wish|gift|friend|neighbor|invite|visit/i.test(k)),
      requests: plain(ad.requests || ad.help_requests || ad.helpRequests || ad.wish_list || ad.wishList, 2500), gifts: plain(ad.gifts, 1500) },
    giftBox: classInfo("GiftBoxController", SOC), wishGift: classInfo("WishGiftController", SOC), freeGifts: classInfo("FreeGiftsController", SOC), sendGifts: classInfo("SendGiftsController", SOC),
    guild: { controller: classInfo("GuildController", /help|request|material|donate|board|notice|list|get|can/i), helpList: plain(safe(() => g.GF.guildController.model.helpList), 2000) },
    events: { activityItems: classInfo("ActivityItemsController", /list|visible|open|update|get/i),
      visibleModels: (safe(() => Object.keys(g).filter((k) => /Model$/.test(k) && g[k] && typeof g[k] === "function" && g[k].prototype instanceof g.ActivityItemBaseModel)) || []).slice(0, 200) },
    land: { plow: ctrl && proto(Object.getPrototypeOf(ctrl), /plow|soil|sow|createSoils|usePlowTool|changePlowAreaSize|autoPlow|checkSpareGrid|useMoveTool|moveMapObject|_moveMapObject|setTool|toolExecute|isCanAdd|_addMapObject|addMapObject|createMapObject|_createMapObject|setADD_MO_Tool|onToolConfirm|toolCancel|dealHouse/i, 1),
      AutoPlowManager: classInfo("AutoPlowManager", /./), PlowTool: classInfo("PlowTool", /./), MoveTool: classInfo("MoveTool", /./), AddMoTool: classInfo("AddMoTool", /./) || classInfo("ADD_MO_Tool", /./),
      ToolName: plain(g.ToolName, 1500), GameCollision: safe(() => g.GameCollision) && proto(g.GameCollision, /spare|grid|add|remove|can|check/i, 1), GameCollisionStatics: safe(() => Object.getOwnPropertyNames(g.GameCollision)),
      soilConfig: plain(safe(() => { const S = g.Config.Store; const out = []; for (const k of Object.keys(S)) { const c = S[k]; if (c && /soil/i.test(c.type || "") || c && /^soil/i.test(c.kind || "")) out.push({ id: c.id, name: c.name, type: c.type, kind: c.kind, price: c.price, level: c.level, size_x: c.size_x, size_y: c.size_y }); } return out.slice(0, 20); }), 2500),
      size: { size_x: ad.size_x, size_y: ad.size_y, top_map_size: ad.top_map_size } },
    dry: { manager: classInfo("DryMachineManager", /./), controller: classInfo("DryMachineController", /./), model: classInfo("DryMachineModel", /./),
      consts: plain(g.DryMachineConst, 1500), data: plain(safe(() => g.DryMachineManager.instance.data), 1500), config: plain(safe(() => g.DryMachineManager.instance.config), 1500),
      mapData: plain(safe(() => g.DryMachineManager.instance.mapData), 800) },
    shopBuyFlow: ctrl && proto(Object.getPrototypeOf(ctrl), /^setTool$|^removeTool$|^toolExecute$|^onToolConfirm$|^_addMapObject$|^addMapObject$|^isCanAdd$|^dealHouse$/, 1),
    tools: { ToolName: plain(g.ToolName, 1500), classes: (safe(() => Object.keys(g).filter((k) => /Tool$/.test(k) && typeof g[k] === "function")) || []).slice(0, 80) }
  };
}

async function worldScan(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: worldScanFrame });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("مش لاقي محرك اللعبة — استنى لحد ما المزرعة تحمّل خالص");
  return { scannedAt: new Date().toISOString(), ...hit.result };
}

async function capsScan(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: capsScanFrame });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("مش لاقي محرك اللعبة — استنى لحد ما المزرعة تحمّل خالص");
  return { scannedAt: new Date().toISOString(), ...hit.result };
}

async function econScan(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: econScanFrame });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("مش لاقي محرك اللعبة — استنى لحد ما المزرعة تحمّل خالص");
  return { scannedAt: new Date().toISOString(), ...hit.result };
}

async function apiScan(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: apiScanFrame
  });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("مش لاقي محرك اللعبة — استنى لحد ما المزرعة تحمّل خالص");
  return { scannedAt: new Date().toISOString(), ...hit.result };
}

async function deepScan(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: deepScanFrame
  });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("مش لاقي محرك اللعبة — استنى لحد ما المزرعة تحمّل خالص");
  return { scannedAt: new Date().toISOString(), frameId: hit.frameId, ...hit.result };
}

// ---------- AI trainer: the model studies the whole game once and writes a playbook ----------
// The model is not a 24/7 player. Once the agent has seen every farm, the model reads everything
// (seeds, machines and their recipes, animals, trees, barn, dryer, investments) and writes a playbook:
// what to plant on each farm, order / reserve rules, and what the player should do by hand.
// The agent then plays alone with that playbook. The model is asked again only when the game changes
// (new level, new farm, new kind of machine / animal / tree, new seeds), or when the player asks.
// Raw HTTP on purpose: this is an MV3 service worker with no bundler, so the SDK can't be used here.
const LLM_URL = "https://api.anthropic.com/v1/messages";
const LLM_DEFAULT_MODEL = "claude-opus-5-5";
const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const OLLAMA_DEFAULT_MODEL = "qwen2.5:7b"; // free, runs locally, good Arabic + JSON
const ollamaBase = (settings) => String(settings.llmUrl || OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
const RETRAIN_MIN_HOURS = 3; // a changed game is studied again at most this often (unless asked)
const BOOK_VERSION = 3;       // bump when the prompt / schema changes: books from older versions are rewritten
const EXP_HOURS = 3;          // hours of bot work one experiment runs before it is judged
const KNOBS = ["seed", "stockTarget", "orderMinRatio", "fertilize", "sceneMinMin"];

const BOOK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "scenes", "orderMinRatio", "sellReserve", "stockTarget", "fertilize", "sceneMinMin", "endReserve", "features", "machineProducts", "rules", "playerTodo", "experiment"],
  properties: {
    summary: { type: "string", description: "3 جمل بالعربي المصري: المزرعة عاملة إزاي وإيه أهم حاجة في الخطة" },
    scenes: {
      type: "array",
      description: "مزرعة واحدة لكل مزرعة في البيانات، بنفس الاسم",
      items: {
        type: "object", additionalProperties: false, required: ["scene", "seedPlan", "why"],
        properties: {
          scene: { type: "string", description: "اسم المزرعة زي ما هو في البيانات" },
          seedPlan: {
            type: "array",
            description: "توزيع الأرض الفاضية اللي تفضل بعد احتياجات المكن والحيوانات والمخزون (الوكيل بيعملهم لوحده). أسماء من landSeeds/waterSeeds بتاعة المزرعة دي بس. فاضية = أعلى ربح في الساعة",
            items: { type: "object", additionalProperties: false, required: ["seed", "share"],
              properties: { seed: { type: "string" }, share: { type: "number", description: "من 0 لـ 1، المجموع ≤ 1" } } }
          },
          why: { type: "string", description: "سطر واحد: ليه التوزيع ده" }
        }
      }
    },
    orderMinRatio: { type: "number", description: "أقل (مكافأة ÷ قيمة الأصناف) لقبول طلب تجاري، من 0.8 لـ 3" },
    sellReserve: { type: "number", description: "كوينز يسيبها دايماً ومايصرفهاش" },
    stockTarget: { type: "number", description: "أقل كمية يحتفظ بيها من كل خامة، من 200 لـ 5000" },
    fertilize: { type: "boolean", description: "يستخدم السماد والري على أغلى الزرع؟" },
    endReserve: { type: "number", description: "كام حتة يسيبها من كل منتج نهائي بعد البيع (20 لـ 1000)" },
    features: {
      type: "object", additionalProperties: false, required: ["orders", "shipOrders", "dryer", "giftCoins", "machineSwitch"],
      description: "الوكيل يشغّل أنهي قدرات (اللاعب ممكن يقفل أي واحدة وده بيغلب)",
      properties: { orders: { type: "boolean" }, shipOrders: { type: "boolean" }, dryer: { type: "boolean" }, giftCoins: { type: "boolean" }, machineSwitch: { type: "boolean" } }
    },
    machineProducts: {
      type: "array", description: "المنتج اللي كل مكنة تشتغل عليه (من recipes بتاعتها في البيانات)",
      items: { type: "object", additionalProperties: false, required: ["machine", "product"], properties: { machine: { type: "string" }, product: { type: "string" } } }
    },
    sceneMinMin: { type: "number", description: "أقل دقايق يقعدها في مزرعة فيها شغل قبل ما ينقل، من 0.5 لـ 10" },
    experiment: {
      type: "object", additionalProperties: false, required: ["knob", "scene", "seed", "value", "why"],
      description: "تجربة واحدة جديدة الوكيل يجربها " + EXP_HOURS + " ساعات شغل ونقيس الكوينز في الساعة قبل وبعد. ماتكررش تجربة في lessons",
      properties: {
        knob: { type: "string", enum: KNOBS, description: "seed = بذرة تانية لنص الأرض الفاضية في مزرعة؛ stockTarget/orderMinRatio/sceneMinMin = رقم جديد؛ fertilize = تشغيل/إيقاف السماد" },
        scene: { type: "string", description: "اسم المزرعة (للـ seed بس، غير كده فاضي)" },
        seed: { type: "string", description: "اسم البذرة (للـ seed بس، غير كده فاضي)" },
        value: { type: ["number", "boolean"], description: "القيمة الجديدة (للـ seed اكتب 0.5)" },
        why: { type: "string", description: "ليه متوقع إنها تزوّد الكوينز، بالأرقام" }
      }
    },
    rules: { type: "array", description: "قواعد قصيرة اتعلمتها من البيانات (للعرض واللاعب)", items: { type: "string" } },
    playerTodo: { type: "array", description: "حاجات اللاعب لازم يعملها بإيده، كل واحدة بالاسم والرقم من البيانات: machineSwitches (غيّر منتج مكنة)، idleNoInput (مكنة واقفة محتاجة خامة)، investments (اشتري حاجة بترجّع فلوسها بسرعة)، المجفف", items: { type: "string" } }
  }
};

const TRAIN_PROMPT = `إنت مدرّب لوكيل آلي بيلعب "مزرعتنا السعيدة" (Family Farm). مش هتلعب إنت؛ هتذاكر بيانات اللعبة كلها مرة واحدة وتكتب "كتيّب" الوكيل هيمشي عليه لوحده أيام.
الهدف: أكتر كوينز في الساعة لحد الهدف، من غير فلوس حقيقية (RC).
الوكيل بيعمل لوحده ومن غير ما تقوله: حصاد، جمع، أكل الحيوانات، تعبئة المكن، زراعة اللي المكن والحيوانات محتاجاه، الحفاظ على المخزون، بيع المنتجات النهائية بس، الطلبات، السماد، التنقل بين المزارع.
إنت بتحدد: إيه يتزرع في الأرض اللي فاضلة في كل مزرعة، وإمتى يقبل طلب، وهل يوسّع، وقد إيه يحتفظ، وإيه اللي اللاعب لازم يعمله بإيده.
الأرض اللي فاضلة بعد احتياجات المكن والحيوانات والمخزون هي للربح: seedPlan لازم يختار من أعلى perHour، والبذرة اللي ربحها في الساعة أقل كتير من الأحسن هتترفض.
اشتغل بالأرقام اللي في البيانات: perHour للبذور، وصفات المكن (needs/sell)، eatsPerHour، المخزن (barn)، investments.paybackHours. ماتخترعش أسماء؛ استخدم الأسماء زي ما هي.
المزرعة المائية بذورها من waterSeeds بس، والباقي من landSeeds. خلي في بالك ساعات الشغل (workHours): المحصول اللي بيستوي وقت الراحة بيستنى.
كمان إنت مسؤول عن التعلّم: كل مرة بتقترح "experiment" واحدة الوكيل يجربها. في البيانات "lessons" = نتايج التجارب اللي فاتت (kept = نفعت واتثبتت). ماتكررش تجربة اتجربت، واتعلم منها: لو تغيير في اتجاه خسّر جرّب اتجاه تاني.
landSeeds/waterSeeds.perHour محسوبة على قد ما الوكيل بيرجع للمزرعة فعلاً (revisitHoursHere)، فصدّقها.
ممنوع الكلام العام زي "حافظ على المخزون". كل قاعدة أو مهمة لازم فيها اسم من البيانات ورقم.
اكتب بالعربي المصري وبإيجاز.`;

let teacherCache = null;
async function teacher() {
  if (teacherCache) return teacherCache;
  try { teacherCache = await (await fetch(chrome.runtime.getURL("teacher.json"))).json(); } catch (e) { teacherCache = { rules: [], corrections: [] }; }
  return teacherCache;
}
const teacherText = (t) => !t ? "" : "\n\nتعليمات المدرّب (لازم تلتزم بيها):\n- " + (t.rules || []).join("\n- ") +
  ((t.corrections || []).length ? "\nأخطاء عملتها قبل كده واتصلحت (ماتكررهاش):\n- " + t.corrections.join("\n- ") : "");

// Ollama: local, free, nothing leaves the machine. Streams, so a slow CPU still finishes.
// extra = [previous answer, critique] when the extension sends the book back for a fix
// A model's JSON, even when the answer was cut off by the length cap: parse the whole thing, or else keep
// everything up to the last complete item and close the open brackets (small models stop mid-array).
function parseLooseJson(text) {
  const s = String(text || "").slice(Math.max(0, String(text || "").indexOf("{")));
  if (!s.startsWith("{")) throw new Error("مفيش كتيّب في رد النموذج");
  try { return JSON.parse(s.slice(0, s.lastIndexOf("}") + 1)); } catch (e) { /* repair below */ }
  const stack = [];
  let inStr = false, esc = false, cut = -1, open = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) return JSON.parse(s.slice(0, i + 1));
      cut = i + 1; open = stack.slice();
    } else if (c === ",") { cut = i; open = stack.slice(); }
  }
  if (cut < 0) throw new Error("رد النموذج مش JSON");
  return JSON.parse(s.slice(0, cut).replace(/,\s*$/, "") + open.reverse().join(""));
}

async function callOllama(settings, knowledge, mode, extra, budget = 6000) {
  const model = settings.llmModel || OLLAMA_DEFAULT_MODEL;
  const body = {
    model, stream: true,
    // num_predict caps the answer: a small model can otherwise loop forever inside a JSON schema
    options: { temperature: 0.2, num_ctx: 32768, num_predict: budget },
    messages: [
      { role: "system", content: TRAIN_PROMPT + teacherText(knowledge.__teacher) + (mode === "plain" ? "\nرجّع JSON بس بالمفاتيح: " + BOOK_SCHEMA.required.join(", ") : "") },
      { role: "user", content: "بيانات اللعبة كلها (JSON):\n" + JSON.stringify(knowledge, (k, v) => (k === "__teacher" ? undefined : v)) + "\n\nاكتب الكتيّب." },
      ...(extra ? [{ role: "assistant", content: extra[0] }, { role: "user", content: extra[1] }] : [])
    ],
    format: mode === "plain" ? "json" : BOOK_SCHEMA
  };
  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15 * 60000); // a training run never takes longer than this
  try {
    res = await fetch(ollamaBase(settings) + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error("Ollama مش شغال على " + ollamaBase(settings) + " — ثبّته وشغّله الأول");
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    if (res.status === 403) { const e = new Error(OLLAMA_403); e.status = 403; throw e; }
    const json = await res.json().catch(() => ({}));
    const msg = String(json.error || `HTTP ${res.status}`);
    const err = new Error(/not found/i.test(msg) ? `النموذج "${model}" مش منزّل — دوس "نزّل النموذج"` : msg);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", usage = {}, cutOff = false;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch (e) { clearTimeout(timer); throw new Error("النموذج خد وقت أطول من 15 دقيقة — جرّب نموذج أصغر"); }
    const { value, done } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(String(j.error));
      if (j.message && j.message.content) text += j.message.content;
      if (j.done) { usage = { input_tokens: j.prompt_eval_count, output_tokens: j.eval_count }; cutOff = j.done_reason === "length"; }
    }
  }
  clearTimeout(timer);
  // the length cap stopped it mid-answer: once more with twice the room
  if (cutOff && budget < 12000) return callOllama(settings, knowledge, mode, extra, budget * 2);
  try {
    return { book: parseLooseJson(text), usage, model };
  } catch (e) {
    const err = new Error("رد النموذج مش JSON سليم" + (cutOff ? " (اتقطع من الطول)" : "") + ": " + String(e.message).slice(0, 80));
    err.status = 200;
    throw err;
  }
}

const OLLAMA_403 = "Ollama رافض الإضافة (403) — شغّل windows\install-ollama.ps1 تاني، بيسمح لإضافات كروم (OLLAMA_ORIGINS) ويعيد تشغيله";
async function ollamaModels(settings) {
  const res = await fetch(ollamaBase(settings) + "/api/tags");
  if (res.status === 403) { const e = new Error(OLLAMA_403); e.status = 403; throw e; }
  const json = await res.json();
  return (json.models || []).map((m) => m.name);
}

async function ollamaPull(settings) {
  const model = settings.llmModel || OLLAMA_DEFAULT_MODEL;
  const res = await fetch(ollamaBase(settings) + "/api/pull", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: model, stream: false }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.status && !/success/i.test(json.status))) throw new Error(String(json.error || json.status || `HTTP ${res.status}`));
  return model;
}

async function llmTest(settings) {
  if ((settings.llmProvider || "ollama") !== "ollama") return { ok: !!settings.llmKey, info: settings.llmKey ? "مفتاح Anthropic موجود" : "حط مفتاح API" };
  try {
    const models = await ollamaModels(settings);
    const want = settings.llmModel || OLLAMA_DEFAULT_MODEL;
    const has = models.some((m) => m === want || m.split(":")[0] === want.split(":")[0]);
    return { ok: true, models, hasModel: has, info: has ? `✅ Ollama شغال والنموذج ${want} جاهز` : `Ollama شغال بس "${want}" مش منزّل — دوس "نزّل النموذج"` };
  } catch (e) {
    if (e.status === 403) return { ok: false, info: e.message };
    return { ok: false, info: "Ollama مش شغال على " + ollamaBase(settings) + " — ثبّته من ollama.com أو شغّل windows\\install-ollama.ps1" };
  }
}

async function callClaude(key, model, knowledge, mode, extra) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  const body = {
    model,
    max_tokens: 8000,
    system: TRAIN_PROMPT + teacherText(knowledge.__teacher),
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "بيانات اللعبة كلها (JSON):\n" + JSON.stringify(knowledge, (k, v) => (k === "__teacher" ? undefined : v)) + "\n\nاكتب الكتيّب." },
      ...(extra ? [{ role: "assistant", content: extra[0] }, { role: "user", content: extra[1] }] : [])]
  };
  if (mode !== "plain") body.output_config.format = { type: "json_schema", schema: BOOK_SCHEMA };
  else { delete body.thinking; body.messages[0].content += "\nرجّع JSON بس بالمفاتيح: " + BOOK_SCHEMA.required.join(", "); }
  if (mode === "full" && /opus-5|sonnet-5-5|fable/.test(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetch(LLM_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((json.error && json.error.message) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (json.stop_reason === "refusal") throw new Error("النموذج رفض الطلب");
  const text = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("مفيش كتيّب في الرد");
  return { book: parseLooseJson(m[0]), usage: json.usage || null, model: json.model || model };
}

// keep only what the agent can really use: known farms, seeds that exist on that farm, sane numbers
function cleanBook(book, knowledge, notes = []) {
  const clamp = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Number(v))) : d);
  const farms = (knowledge.farms || []).filter((f) => !f.notSeenYet);
  const scenes = [];
  for (const sc of Array.isArray(book.scenes) ? book.scenes : []) {
    const farm = farms.find((f) => f.name === sc.scene) || farms.find((f) => String(sc.scene || "").includes(f.name.replace("المزرعة ", "")) || f.name.includes(String(sc.scene || "")));
    if (!farm) { notes.push(`مزرعة "${sc.scene}" مش موجودة في البيانات`); continue; }
    // the agent already plants what machines / animals / stock need; the rest of the soil is for profit,
    // so a seed far below the best coins-per-hour on its kind of soil is not allowed here
    const okSeeds = new Map();
    for (const list of [farm.landSeeds || [], farm.waterSeeds || []]) {
      const best = Math.max(0, ...list.map((x) => Number(x.perHour) || 0));
      for (const x of list) if ((Number(x.perHour) || 0) >= best * 0.6) okSeeds.set(x.seed, x);
    }
    let total = 0;
    const seedPlan = [];
    for (const x of Array.isArray(sc.seedPlan) ? sc.seedPlan : []) {
      const share = clamp(x && x.share, 0, 1, 0);
      if (!x || !okSeeds.has(x.seed) || share <= 0 || total + share > 1.0001) {
        if (x && x.seed && !okSeeds.has(x.seed)) notes.push(`${farm.name}: "${x.seed}" مش من أعلى البذور perHour هنا (أو مش موجودة/مقفولة)`);
        else if (x && total + share > 1.0001) notes.push(`${farm.name}: مجموع share عدّى 1`);
        continue;
      }
      total += share;
      seedPlan.push({ seed: x.seed, share: Math.round(share * 100) / 100 });
    }
    // small models repeat themselves: "X - X - X" -> "X"
    const why = String(sc.why || "").replace(/(.{6,}?)(?:\s*[-،,.]?\s*\1)+/g, "$1").slice(0, 200);
    if (seedPlan.length && !seedPlan.some((x) => why.includes(x.seed))) notes.push(`${farm.name}: السبب (why) مايذكرش البذرة اللي اخترتها`);
    scenes.push({ scene: farm.name, seedPlan: seedPlan.slice(0, 6), why });
  }
  // names the model may cite: farms, seeds, machines, animals, products, barn items
  const known = new Set();
  for (const f of farms) {
    known.add(f.name);
    for (const x of [...(f.landSeeds || []), ...(f.waterSeeds || [])]) known.add(x.seed);
    for (const m of f.machines || []) { known.add(m.name); for (const r of m.recipes || []) known.add(r.product); }
    for (const a of f.animals || []) { known.add(a.name); known.add(a.product); }
  }
  for (const b of knowledge.barn || []) known.add(b.item);
  const specific = (t) => /\d/.test(t) && [...known].some((n) => n && n.length > 1 && t.includes(n));
  const list = (v, n, label) => {
    const all = Array.isArray(v) ? v.map((x) => String(x).slice(0, 220)).filter(Boolean) : [];
    const ok = all.filter(specific);
    if (all.length > ok.length) notes.push(`${all.length - ok.length} من ${label} كلام عام من غير اسم من البيانات ورقم`);
    return ok.slice(0, n);
  };
  // the player's choices are the floor / the off switch
  const playerStock = Number(knowledge.player && knowledge.player.playerStockTarget) || 0;
  if (Number(book.stockTarget) < playerStock) notes.push(`stockTarget (${book.stockTarget}) أقل من اختيار اللاعب ${playerStock}`);
  const tools = Number(knowledge.fertilizerTools) || 0;
  if (book.fertilize === false && tools > 0) notes.push(`fertilize=false وعندك ${tools} أداة سماد`);
  if (Number(book.sceneMinMin) > 3) notes.push(`sceneMinMin = ${book.sceneMinMin} طويل (لازم 1-3)`);
  // machine products: only a product that machine can make
  const machineProducts = [];
  for (const mp of Array.isArray(book.machineProducts) ? book.machineProducts : []) {
    const m = farms.flatMap((f) => f.machines || []).find((x) => x.name === (mp && mp.machine));
    if (!m) { if (mp && mp.machine) notes.push(`مكنة "${mp.machine}" مش موجودة`); continue; }
    if (!(m.recipes || []).some((r) => r.product === mp.product)) { notes.push(`"${mp.product}" مش من منتجات ${m.name}`); continue; }
    if (!machineProducts.some((x) => x.machine === m.name)) machineProducts.push({ machine: m.name, product: mp.product });
  }
  if ((knowledge.machineSwitches || []).length && !machineProducts.length) notes.push(`فيه ${knowledge.machineSwitches.length} مكنة ممكن تعمل منتج أحسن ومفيش machineProducts`);
  const fe = book.features && typeof book.features === "object" ? book.features : {};
  const features = {};
  // turning a money feature off needs proof (a lesson where it lost coins); without it the feature stays on
  const proven = new Set((knowledge.lessons || []).filter((l) => !l.kept).map((l) => String(l.tried || "")));
  for (const k of ["orders", "shipOrders", "dryer", "giftCoins", "machineSwitch"]) {
    features[k] = true;
    if (fe[k] === false) { if ([...proven].some((t) => t.includes(k))) features[k] = false; else notes.push(`قفلت ${k} من غير دليل في lessons`); }
  }
  return {
    fertilize: tools > 0 ? true : typeof book.fertilize === "boolean" ? book.fertilize : true,
    sceneMinMin: clamp(book.sceneMinMin, 1, 3, 2),
    endReserve: clamp(book.endReserve, 20, 1000, 50),
    features,
    machineProducts: machineProducts.slice(0, 30),
    experiment: cleanExperiment(book.experiment, knowledge),
    summary: String(book.summary || "").slice(0, 600),
    scenes,
    orderMinRatio: clamp(book.orderMinRatio, 0.8, 3, 1),
    sellReserve: clamp(book.sellReserve, 0, 1e12, 0),
    stockTarget: Math.max(playerStock, clamp(book.stockTarget, 200, 20000, 1000)),
    rules: list(book.rules, 10, "rules"),
    playerTodo: list(book.playerTodo, 8, "playerTodo")
  };
}

// one experiment: a single knob, inside safe limits, on a seed that exists on that farm
function cleanExperiment(e, knowledge) {
  if (!e || !KNOBS.includes(e.knob)) return null;
  const why = String(e.why || "").slice(0, 200);
  const num = (a, b) => (Number.isFinite(Number(e.value)) ? Math.min(b, Math.max(a, Number(e.value))) : null);
  if (e.knob === "seed") {
    const farm = (knowledge.farms || []).find((f) => !f.notSeenYet && (f.name === e.scene || String(e.scene || "").includes(f.name.replace("المزرعة ", ""))));
    const seeds = farm ? [...(farm.landSeeds || []), ...(farm.waterSeeds || [])].map((x) => x.seed) : [];
    return farm && seeds.includes(e.seed) ? { knob: "seed", scene: farm.name, seed: e.seed, value: 0.5, why } : null;
  }
  if (e.knob === "fertilize") return typeof e.value === "boolean" ? { knob: "fertilize", value: e.value, why } : null;
  const lim = { stockTarget: [200, 5000], orderMinRatio: [0.8, 3], sceneMinMin: [0.5, 10] }[e.knob];
  const v = num(lim[0], lim[1]);
  return v == null ? null : { knob: e.knob, value: v, why };
}
// an experiment that changes nothing in the book in force wastes hours of measuring
function isNoop(e, book) {
  if (!e || !book) return false;
  if (e.knob === "seed") {
    const sc = (book.scenes || []).find((x) => x.scene === e.scene);
    const cur = sc && sc.seedPlan.find((x) => x.seed === e.seed);
    return !!cur && cur.share >= 0.5;
  }
  const cur = book[e.knob];
  return typeof e.value === "number" ? Math.abs(Number(cur) - e.value) < 1e-9 : cur === e.value;
}
const expKey = (e) => e && [e.knob, e.scene || "", e.seed || "", typeof e.value === "number" ? Math.round(e.value * 100) / 100 : e.value].join("|");
const expText = (e) => !e ? "" : e.knob === "seed" ? `${e.seed} على نص الأرض الفاضية في ${e.scene}`
  : e.knob === "fertilize" ? (e.value ? "تشغيل السماد" : "إيقاف السماد")
  : `${{ stockTarget: "حد المخزون", orderMinRatio: "حد قبول الطلبات", sceneMinMin: "أقل قعدة في المزرعة (د)" }[e.knob]} = ${e.value}`;

// the book the agent really plays with = the proven book + the experiment running now (if any)
function applyExperiment(base, e) {
  if (!base) return base;
  const book = JSON.parse(JSON.stringify(base));
  delete book.experiment;
  if (!e) return book;
  if (e.knob === "seed") {
    const sc = book.scenes.find((x) => x.scene === e.scene) || (book.scenes[book.scenes.length] = { scene: e.scene, seedPlan: [], why: "" });
    const rest = sc.seedPlan.filter((x) => x.seed !== e.seed).map((x) => ({ seed: x.seed, share: Math.round(x.share * 0.5 * 100) / 100 }));
    sc.seedPlan = [{ seed: e.seed, share: 0.5 }, ...rest];
  } else book[e.knob] = e.value;
  return book;
}

// ---------- coins per hour, measured from what the bot reports ----------
// coinLog: one point per tick while the bot runs. Rate = coin change per hour of bot work
// (gaps over 40 min = the bot or PC was off: not counted).
function workRate(log, from, to) {
  const pts = log.filter((p) => p.t >= from && p.t <= to);
  let hours = 0, delta = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 3600000;
    if (dt <= 40 / 60) { hours += dt; delta += pts[i].c - pts[i - 1].c; }
  }
  return { hours, rate: hours > 0 ? delta / hours : null };
}

async function readKnowledge() {
  const tabId = await gameTabId();
  if (tabId == null) throw new Error("اللعبة مش مفتوحة — افتحها واستنى تحمّل");
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: "MAIN",
    func: () => (window.__farmBot && window.__farmBot.knowledge ? window.__farmBot.knowledge() : null)
  });
  const hit = results.find((r) => r.result);
  if (!hit) throw new Error("الوكيل مش شغال في اللعبة دلوقتي — افتح اللعبة واستنى تحمّل");
  return hit.result;
}

let training = false;
async function train(force = false, nextOnly = false) {
  if (training) return { error: "التدريب شغال فعلاً" };
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!force && settings.llmOn === false) return null;
  const provider = settings.llmProvider || "ollama";
  const fail = async (msg) => { await chrome.storage.local.set({ llmError: msg, trainState: { running: false, at: Date.now(), error: msg } }); return { error: msg }; };
  if (provider === "anthropic" && !settings.llmKey) return fail("حط مفتاح API الأول");
  let knowledge;
  try { knowledge = await readKnowledge(); } catch (e) { return fail(String(e.message || e)); }
  knowledge.player = { ...(knowledge.player || {}), playerStockTarget: Number(settings.stockTarget) || 1000 };
  if (!knowledge.know || !knowledge.know.complete)
    // not an error, just too early: tell the popup, but don't leave a red error behind
    return { error: `لسه الوكيل ماشافش كل المزارع (${(knowledge.know && knowledge.know.missing || []).join("، ") || "؟"}) — سيبه يلف عليهم وهيدرّب لوحده` };
  const learn = settings.learn || {};
  knowledge.__teacher = await teacher();
  knowledge.pastMistakes = (learn.mistakes || []).slice(-20);
  knowledge.lessons = (learn.history || []).slice(-15).map((h) => ({ tried: expText(h.exp), coinsPerHourBefore: Math.round(h.base), after: Math.round(h.rate), kept: h.kept }));
  if (settings.playbook && settings.playbook.base) {
    const b = settings.playbook.base;
    knowledge.currentBook = { scenes: b.scenes, stockTarget: b.stockTarget, orderMinRatio: b.orderMinRatio, fertilize: b.fertilize, sceneMinMin: b.sceneMinMin };
  }
  training = true;
  await chrome.storage.local.set({ trainState: { running: true, startedAt: Date.now() } });
  // a long local run must not let the service worker fall asleep
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const model = settings.llmModel || (provider === "ollama" ? OLLAMA_DEFAULT_MODEL : LLM_DEFAULT_MODEL);
  let last;
  try {
    for (const mode of (provider === "ollama" ? ["schema", "plain"] : ["full", "nofallback", "plain"])) {
      try {
        const r = provider === "ollama" ? await callOllama(settings, knowledge, mode) : await callClaude(settings.llmKey, model, knowledge, mode);
        const fresh = (await chrome.storage.local.get("settings")).settings || {};
        const tried = new Set(((fresh.learn || {}).history || []).map((h) => expKey(h.exp)));
        if (nextOnly && fresh.playbook && fresh.playbook.base) {
          // the proven book stays; only the next experiment comes from the model
          let exp = cleanExperiment(r.book && r.book.experiment, knowledge);
          if (exp && (tried.has(expKey(exp)) || isNoop(exp, fresh.playbook.base))) exp = null;
          const learnNext = { ...(fresh.learn || {}), next: exp, askedAt: Date.now() };
          await chrome.storage.local.set({ settings: { ...fresh, learn: learnNext }, llmError: "", trainState: { running: false, at: Date.now() } });
          return { experiment: exp };
        }
        let notes = [];
        let book = cleanBook(r.book || {}, knowledge, notes);
        // an empty answer is not a playbook: try the next (simpler) request shape
        if (!book.summary || !book.scenes.length) { const err = new Error("النموذج رجّع كتيّب فاضي — جرّب نموذج أكبر"); err.status = 200; throw err; }
        // teaching: send the mistakes back once and keep the fixed book if it is cleaner
        let fixedRound = false;
        if (notes.length) {
          const critique = "كتيّبك فيه الأخطاء دي:\n- " + notes.join("\n- ") + "\nصلّحها كلها ورجّع الكتيّب كامل بنفس الشكل.";
          try {
            const r2 = provider === "ollama" ? await callOllama(settings, knowledge, mode, [JSON.stringify(r.book), critique])
              : await callClaude(settings.llmKey, model, knowledge, mode, [JSON.stringify(r.book), critique]);
            const notes2 = [];
            const book2 = cleanBook(r2.book || {}, knowledge, notes2);
            if (book2.summary && book2.scenes.length && notes2.length < notes.length) { book = book2; fixedRound = true; }
          } catch (e) { /* keep the cleaned first book */ }
        }
        const mistakes = [...(learn.mistakes || []), ...notes.map((t) => ({ t, at: Date.now() }))].slice(-40).map((m) => (typeof m === "string" ? { t: m, at: Date.now() } : m));
        let exp = book.experiment;
        if (exp && (tried.has(expKey(exp)) || isNoop(exp, book))) exp = null;
        // a new book replaces the knobs proven before only where the model chose differently; experiments restart
        const learnNew = { history: (fresh.learn || {}).history || [], active: null, next: exp, baseline: null, changedAt: Date.now(),
          mistakes: mistakes.map((m) => m.t || m).slice(-40), lastFix: { at: Date.now(), found: notes.length, fixedByModel: fixedRound } };
        await chrome.storage.local.set({
          settings: { ...fresh, learn: learnNew, playbook: { v: BOOK_VERSION, at: Date.now(), base: book, book: applyExperiment(book, null), fp: knowledge.know.fp, level: knowledge.player.level, usage: r.usage, model: r.model } },
          llmError: "",
          trainState: { running: false, at: Date.now() }
        });
        return { book };
      } catch (e) {
        last = e;
        // 400 = this request shape isn't accepted here, 200 = answer wasn't valid JSON: try a simpler shape
        if (!(e.status === 400) && !(e.status === 200) && !(e instanceof SyntaxError)) break;
      }
    }
  } finally {
    clearInterval(keepAlive);
    training = false;
  }
  return fail("التدريب: " + String((last && last.message) || last).slice(0, 160));
}

// every 30 min:
// 1) log the coins (to measure coins per hour of bot work)
// 2) train when the agent has seen every farm and there's no book yet, the book is from an older
//    version, or the game changed (and the book is at least a few hours old)
// 3) otherwise learn: start the next experiment, judge the running one after EXP_HOURS of work
//    (kept if it earned ≥ 5 % more per hour, rolled back if not), then ask the model for the next one
async function maybeTrain() {
  const { settings = {}, botStatus, coinLog = [] } = await chrome.storage.local.get(["settings", "botStatus", "coinLog"]);
  const now = Date.now();
  if (botStatus && now - (botStatus.updated || 0) < 10 * 60000 && Number(botStatus.coins) > 0) {
    coinLog.push({ t: now, c: Number(botStatus.coins) });
    while (coinLog.length && now - coinLog[0].t > 72 * 3600000) coinLog.shift();
    await chrome.storage.local.set({ coinLog });
  }
  if (settings.llmOn === false || !botEnabled(settings)) return;
  if ((settings.llmProvider || "ollama") === "anthropic" && !settings.llmKey) return;
  const k = botStatus && botStatus.know;
  if (!k || !k.complete) return;
  const pb = settings.playbook;
  if (!pb || !pb.base || pb.v !== BOOK_VERSION) return void (await train(false));
  if (pb.fp !== k.fp && now - pb.at >= RETRAIN_MIN_HOURS * 3600000) return void (await train(false));

  const learn = settings.learn || { history: [] };
  const save = async (l, book) => {
    const fresh = (await chrome.storage.local.get("settings")).settings || {};
    const pbx = { ...fresh.playbook, ...(book ? { base: book } : {}) };
    pbx.book = applyExperiment(pbx.base, l.active);
    await chrome.storage.local.set({ settings: { ...fresh, learn: l, playbook: pbx } });
  };
  if (learn.active) {
    const a = learn.active;
    const m = workRate(coinLog, a.startedAt, now);
    if (m.hours < EXP_HOURS) return;
    const kept = m.rate != null && a.base != null && m.rate > a.base + Math.max(50, Math.abs(a.base) * 0.05);
    const history = [...(learn.history || []), { exp: a.exp, base: a.base, rate: m.rate, kept, at: now }].slice(-40);
    const book = kept ? applyExperiment(pb.base, a.exp) : null; // a winner becomes part of the proven book
    if (book) book.experiment = null;
    // the rate of the book now in force: the experiment's own rate if kept, the old one if rolled back
    await save({ history, active: null, next: null, baseline: { rate: kept ? m.rate : a.base, at: now }, changedAt: now }, book);
    return void (await train(false, true)); // ask the model what to try next, knowing this result
  }
  if (learn.next) {
    // compare against the book in force: a fresh measured baseline, or one measured since the last change
    let base = learn.baseline && now - learn.baseline.at < 24 * 3600000 ? learn.baseline.rate : null;
    if (base == null) {
      const since = Math.max(learn.changedAt || pb.at || 0, now - 12 * 3600000);
      const before = workRate(coinLog, since, now);
      if (before.hours < EXP_HOURS) return; // not enough measured work under this book yet
      base = before.rate;
    }
    await save({ ...learn, active: { exp: learn.next, startedAt: now, base }, next: null, baseline: null });
    return;
  }
  // nothing planned: ask for the next experiment at most every 2 hours
  if (!learn.askedAt || now - learn.askedAt > 2 * 3600000) await train(false, true);
}
Promise.resolve().then(() => chrome.alarms.clear("strategist")).catch(() => {}); // the old review-every-N-minutes alarm
Promise.resolve().then(() => chrome.alarms.clear("trainer")).catch(() => {}); // the AI trainer is off
// older versions saved "too early" as an error: clear it
chrome.storage.local.get("llmError").then(({ llmError }) => { if (/^لسه الوكيل/.test(llmError || "")) return chrome.storage.local.set({ llmError: "" }); }).catch(() => {});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "trainer") maybeTrain().catch(() => {}); });


// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let tabId = msg.tabId ?? sender.tab?.id;
  const run = async () => {
    if (/scan$/.test(msg.type)) tabId = (await gameTabId(tabId)) ?? tabId;
    switch (msg.type) {
      case "stop": return stopAll();
      case "scan": return scan(tabId);
      case "deep-scan": return deepScan(tabId);
      case "api-scan": return apiScan(tabId);
      case "econ-scan": return econScan(tabId);
      case "caps-scan": return capsScan(tabId);
      case "world-scan": return worldScan(tabId);
      case "strategize": case "train": return train(true);
      case "llm-test": return llmTest((await getStore()).settings);
      case "llm-pull": return ollamaPull((await getStore()).settings);
      case "farm": return farm(tabId, msg.action);
      case "reload-game": return reloadGame(sender.tab?.id, msg.reason || "out of sync");
    }
  };
  run().then(
    (res) => sendResponse({ ok: true, res }),
    (e) => sendResponse({ ok: false, error: e.message })
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "stop-all") return stopAll();
  if (command === "farm-all") farm(null, "all").catch((e) => console.warn(e));
});
