// Farm bot engine — runs inside the game frame (MAIN world).
// Uses the game's own GameController, one object at a time, exactly like a player's taps.
// Settings arrive from agent-bridge.js via window.postMessage; status goes back the same way.
(() => {
  if (!/^apps-\d+\.apps\.fbsbx\.com$/i.test(location.hostname)) return;
  const VERSION = 43;
  if (window.__farmBot && window.__farmBot.version >= VERSION) return;
  // an older engine is running (extension was updated without F5): shut it down and take over
  if (window.__farmBot) {
    try { window.__farmBot.dispose ? window.__farmBot.dispose() : window.__farmBot.stop(); } catch {}
    window.postMessage({ __fm: "config", cfg: { botOn: false } }, location.origin); // stops engines older than v5
  }
  const g = window;

  // Messages go only to the newest bridge (its random channel), so bridges left over
  // from an old extension version never receive anything and can't throw.
  let channel = null;
  const send = (kind, data) => {
    if (channel) window.postMessage({ __fmc: channel, kind, ...data }, location.origin);
  };

  const safe = (f) => { try { return f(); } catch { return undefined; } };
  // the probe's worker clock keeps running when the window is in the background (main-thread timers don't)
  const bgTimer = () => window.__fmTimer;
  const sleep = (ms) => (bgTimer() ? bgTimer().sleep(ms) : new Promise((r) => setTimeout(r, ms)));
  const later = (fn, ms) => (bgTimer() ? bgTimer().setTimeout(fn, ms) : setTimeout(fn, ms));
  // if the game paused anyway (older page without the probe fix), wake it up
  const unpause = () => { if (safe(() => g.egret.ticker.isPaused)) safe(() => g.egret.lifecycle.onResume()); };
  const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);
  const randRange = (a, b) => a + Math.random() * (b - a);

  // ---------- save watch ----------
  // The game keeps every tap locally and sends them later to its server in one "execute_batch"
  // request (gateway.php, AMF). Leaving the farm (or reloading) before that batch went out loses
  // those taps: plants show up, then vanish after the next load. So we watch those requests and
  // wait for a successful batch sent after our last tap before we change farms.
  // Installed once per page; a newer engine reuses the same watcher.
  const saves = g.__fmSaveWatch || (g.__fmSaveWatch = (() => {
    const w = { seen: 0, inflight: 0, okSentAt: 0, failAt: 0, fails: 0, streak: 0, lastStatus: null };
    const isBatch = (body) => {
      try {
        let u8 = null;
        if (body instanceof ArrayBuffer) u8 = new Uint8Array(body, 0, Math.min(body.byteLength, 256));
        else if (ArrayBuffer.isView(body)) u8 = new Uint8Array(body.buffer, body.byteOffset, Math.min(body.byteLength, 256));
        else if (typeof body === "string") return body.slice(0, 256).includes("execute_batch");
        if (!u8) return false;
        let t = "";
        for (let i = 0; i < u8.length; i++) t += String.fromCharCode(u8[i]);
        return t.includes("execute_batch");
      } catch { return false; }
    };
    const done = (sentAt, okRes, st) => {
      w.inflight = Math.max(0, w.inflight - 1);
      w.lastStatus = st;
      if (okRes) { w.okSentAt = Math.max(w.okSentAt, sentAt); w.streak = 0; }
      else { w.failAt = Date.now(); w.fails++; w.streak = (w.streak || 0) + 1; }
    };
    const XP = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
    const XS = XP && XP.send;
    if (XS) XP.send = function (body) {
      if (isBatch(body)) {
        const sentAt = Date.now();
        w.seen++; w.inflight++;
        this.addEventListener("loadend", () => done(sentAt, this.status >= 200 && this.status < 300, this.status), { once: true });
      }
      return XS.apply(this, arguments);
    };
    const F = g.fetch;
    if (F) g.fetch = function (input, init) {
      const p = F.apply(this, arguments);
      if (init && isBatch(init.body)) {
        const sentAt = Date.now();
        w.seen++; w.inflight++;
        p.then((r) => done(sentAt, r.ok, r.status), () => done(sentAt, false, 0));
      }
      return p;
    };
    return w;
  })());
  let lastTapAt = 0;
  const unsaved = () => lastTapAt > 0 && saves.okSentAt < lastTapAt;
  // true when everything we tapped reached the server (or nothing is pending)
  async function waitSaved(maxMs = 90000) {
    if (!unsaved()) return true;
    const t0 = Date.now();
    if (!saves.seen) {
      // no save request recognized on this page yet (game changed?): fall back to a plain pause
      step("💾 بديّ اللعبة وقت تحفظ قبل ما أتحرك...", "save");
      await sleep(20000);
      return true;
    }
    step("💾 مستني اللعبة تحفظ الشغل على السيرفر قبل ما أتحرك...", "save");
    while (Date.now() - t0 < maxMs && !stopFlag) {
      if (!unsaved() && saves.inflight === 0) return true;
      await sleep(500);
    }
    return !unsaved();
  }

  let cfg = { botOn: false, interval: 5, seedId: "", farm: {} };
  let stopFlag = false, busy = false, loopRunning = false, manual = false;
  const emptyTotals = () => ({ harvested: 0, trees: 0, collected: 0, fed: 0, mCollected: 0, mRefilled: 0, planted: 0, sold: 0, earned: 0, orders: 0, fertilized: 0, social: 0, crafted: 0, events: 0 });
  const status = { on: false, phase: "idle", text: "", totals: emptyTotals(), warnings: [], counts: null, animals: [], machines: [],
    pageAt: Math.round(performance.timeOrigin || 0) }; // when this page was loaded (the watchdog's daily reload reads it)
  const opt = (k, def = true) => (cfg.farm && k in cfg.farm ? !!cfg.farm[k] : def);

  // ---------- game access ----------
  const stage = () => g.egret?.MainContext?.instance?.stage;
  const cls = (o) => safe(() => g.egret.getQualifiedClassName(o));
  const atHome = () => {
    const lm = safe(() => g.GF.loginModel);
    return !lm || (lm.atMyHom !== false && !lm.isChangeSceneing);
  };
  const shown = (o) => {
    const st = stage();
    for (let p = o; p && p !== st; p = p.parent) if (!p.visible) return false;
    return true;
  };
  const ok = (o) => o && o.usable !== false && !o.isDestroyed && !safe(() => o.is_under_construction()) && shown(o);
  const ready = (o) => !!safe(() => o.isReady());
  const getP = (o) => Number(safe(() => o.getProducts())) || 0;
  const getR = (o, port) => Number(safe(() => (port == null ? o.getRawMaterials() : o.getRawMaterials(port)))) || 0;
  const maxR = (o) => Number(o.max_raw_materials) || 3;
  // production time in SECONDS. Game configs: seeds count seconds (carrot 28800 = 8 h),
  // animals and machines count minutes (camel 70 = 70 min). Trees: minutes if under a day's worth.
  const secsOf = (c) => {
    const v = Number(c && c.collect_in) || 0;
    if (!v) return 0;
    if (c.type === "seeds") return v;
    if (c.type === "animals" || c.type === "buildings") return v * 60;
    return v <= 1440 ? v * 60 : v;
  };
  const objSecs = (o) => secsOf(safe(() => o.configData)) || (Number(o.collect_in) || 0) * 60;
  const nameOf = (o) => o.name || safe(() => o.configData.name) || "؟";
  const byPos = (a, b) => (a.y - b.y) || (a.x - b.x);
  // water soil takes water seeds only, land soil takes land seeds only (the game rejects the rest)
  const isWaterSoil = (o) => !!(o.water_ranch || safe(() => o.isInWater()));
  const isWaterSeed = (c) => !!(c && c.water_ranch);

  const scan = () => {
    const m = { view: null, Plant: [], Soil: [], Soil2: [], Soil3: [], Tree: [], Animal: [], Machine: [], Fertilizer: [], Kettle: [] };
    const st = stage();
    if (!st) return null;
    const seen = new Set();
    const walk = (o, d) => {
      if (!o || d > 12 || seen.has(o)) return;
      seen.add(o);
      const c = cls(o);
      if (c === "GameView" && !m.view) m.view = o;
      if (m[c] && c !== "view") m[c].push(o);
      for (let i = 0; i < (o.numChildren || 0); i++) walk(safe(() => o.getChildAt(i)), d + 1);
    };
    walk(st, 0);
    hookCtrl(m.view && m.view._controller);
    const plants = m.Plant.filter(ok), trees = m.Tree.filter(ok);
    return {
      ctrl: m.view && m.view._controller,
      plants, readyPlants: plants.filter(ready).sort(byPos),
      trees, readyTrees: trees.filter(ready).sort(byPos),
      soils: [...m.Soil, ...m.Soil2, ...m.Soil3].filter(ok).sort(byPos),
      animals: m.Animal.filter(ok).sort(byPos),
      machines: m.Machine.filter(ok).sort(byPos),
      tools: [...m.Fertilizer, ...m.Kettle].filter((t) => t && !t.isDestroyed)
    };
  };

  const groups = (list) => {
    const map = new Map();
    for (const o of list) {
      const n = nameOf(o);
      const e = map.get(n) || { name: n, total: 0, ready: 0, hungry: 0 };
      e.total++;
      if (getP(o) > 0) e.ready++;
      if (getR(o, cls(o) === "Machine" ? 0 : null) < maxR(o)) e.hungry++;
      map.set(n, e);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };

  const countsOf = (s) => ({
    plants: s.plants.length, readyPlants: s.readyPlants.length,
    trees: s.trees.length, readyTrees: s.readyTrees.length,
    soils: s.soils.length
  });

  // ---------- status / overlay ----------
  let box, lastPost = 0, postTimer = null;
  const post = () => {
    const flush = () => {
      lastPost = Date.now();
      postTimer = null;
      send("status", { status: JSON.parse(JSON.stringify({ ...status, coinHistory, updated: Date.now() })) });
    };
    if (Date.now() - lastPost > 1000) flush();
    else if (!postTimer) postTimer = later(flush, 1000);
  };
  const overlay = () => {
    if (!document.body) return;
    if (!box) {
      document.getElementById("fm-overlay")?.remove();
      box = document.createElement("div");
      box.id = "fm-overlay";
      Object.assign(box.style, {
        position: "fixed", top: "8px", left: "8px", zIndex: 2147483647, maxWidth: "380px", touchAction: "none",
        background: "rgba(15,15,15,.82)", color: "#fff", font: "13px/1.5 sans-serif", direction: "rtl",
        padding: "6px 10px", borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,.4)", display: "none"
      });
      const btn = "cursor:pointer;border:0;border-radius:5px;padding:1px 8px;margin-inline-start:4px";
      box.innerHTML =
        '<div class="drag" title="اسحبني" style="display:flex;align-items:center;gap:6px;cursor:move;user-select:none">' +
        '<span style="opacity:.6">⠿</span><b class="h"></b><span style="flex:1"></span>' +
        `<button class="m" title="تصغير" style="${btn}">–</button><button class="b" style="${btn}"></button></div>` +
        '<div class="body"><div class="t"></div><div class="w" style="color:#ffd27a"></div></div>';
      for (const b of box.querySelectorAll("button")) b.addEventListener("pointerdown", (e) => e.stopPropagation());
      box.querySelector(".b").onclick = () => send("toggle", {});
      const body = box.querySelector(".body"), mini = box.querySelector(".m");
      const setMini = (on) => { body.style.display = on ? "none" : ""; mini.textContent = on ? "+" : "–"; };
      setMini(safe(() => localStorage.getItem("fmOverlayMini")) === "1");
      mini.onclick = () => {
        const on = body.style.display !== "none";
        setMini(on);
        try { localStorage.setItem("fmOverlayMini", on ? "1" : "0"); } catch {}
      };
      // drag anywhere; position is remembered
      const pos = safe(() => JSON.parse(localStorage.getItem("fmOverlayPos")));
      if (pos) { box.style.left = pos.x + "px"; box.style.top = pos.y + "px"; }
      box.querySelector(".drag").addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dx = e.clientX - box.offsetLeft, dy = e.clientY - box.offsetTop;
        const move = (ev) => {
          box.style.left = Math.max(0, Math.min(innerWidth - box.offsetWidth, ev.clientX - dx)) + "px";
          box.style.top = Math.max(0, Math.min(innerHeight - box.offsetHeight, ev.clientY - dy)) + "px";
        };
        const up = () => {
          removeEventListener("pointermove", move, true);
          removeEventListener("pointerup", up, true);
          try { localStorage.setItem("fmOverlayPos", JSON.stringify({ x: box.offsetLeft, y: box.offsetTop })); } catch {}
        };
        addEventListener("pointermove", move, true);
        addEventListener("pointerup", up, true);
      });
      document.body.appendChild(box);
    }
    const active = status.on || status.phase !== "idle";
    box.style.display = active ? "block" : "none";
    const who = cfg.agent ? "الوكيل" : "البوت";
    box.querySelector(".h").textContent = status.phase === "rest" ? `😴 ${who} مستريح` : status.on ? `🤖 ${who} شغال` : "🤖 بيشتغل مرة واحدة";
    const b = box.querySelector(".b");
    b.textContent = status.on ? "⏸ وقّف" : cfg.agent ? "▶ كمّل" : "▶ شغّل دايماً";
    const gr = status.brain && status.brain.goal;
    const goalLine = gr ? `🎯 ${fmt(gr.coins)} / ${fmt(gr.goal)} (${gr.pct.toFixed(2)}%)` +
      (gr.ratePerHour ? ` • ${gr.ratePerHour >= 0 ? "+" : ""}${fmt(gr.ratePerHour)}/س` : "") +
      (gr.etaDays != null && gr.etaDays < 3650 ? ` • باقي ~${gr.etaDays < 2 ? Math.round(gr.etaDays * 24) + " ساعة" : Math.round(gr.etaDays) + " يوم"}` : "") : "";
    box.querySelector(".t").textContent = status.text + (goalLine ? "\n" + goalLine : "");
    box.querySelector(".t").style.whiteSpace = "pre-line";
    box.querySelector(".w").textContent = status.warnings.slice(-2).join(" • ");
  };
  const step = (text, phase) => {
    status.text = text;
    if (phase) status.phase = phase;
    overlay();
    post();
  };
  const warn = (w) => {
    if (!status.warnings.includes(w)) status.warnings = [...status.warnings.slice(-4), w];
    step(status.text);
  };

  // ---------- actions ----------
  const stopped = () => stopFlag || (!manual && !cfg.botOn) || !atHome();
  const tryDo = (f) => {
    try { f(); return true; } catch (e) { warn("خطأ: " + String((e && e.message) || e).slice(0, 80)); return false; }
  };
  const storageQty = (ctrl, id) => {
    const q = safe(() => ctrl.loginModel.getStorageQtyById(Number(id)));
    return q == null ? Infinity : Number(q);
  };
  const add = (done, key, n = 1) => { done[key] = (done[key] || 0) + n; status.totals[key] = (status.totals[key] || 0) + n; };

  // The game runs every tap through its own ProcessQueue (one animation after another).
  // We tap like a fast player: queue taps without waiting for each animation, but never
  // let the queue grow long, and wait for it to drain before reading the farm again.
  let pqKey;
  const queueLen = () => {
    const PQ = g.ProcessQueue;
    if (!PQ) return 0;
    if (pqKey === undefined) {
      pqKey = null;
      for (const k of Object.getOwnPropertyNames(PQ)) {
        if (Array.isArray(safe(() => PQ[k]))) { pqKey = k; break; }
      }
    }
    const v = pqKey && safe(() => PQ[pqKey]);
    return Array.isArray(v) ? v.length : 0;
  };
  const maxQueue = () => (cfg.speed === "turbo" ? 14 : 8);
  // the server refusing saves means too fast: slow down until a save goes through
  const stepMs = () => (cfg.speed === "normal" || saves.streak > 0 ? 400 : cfg.speed === "turbo" ? 100 : 170);

  async function tap(f) {
    unpause();
    for (let t = 0; queueLen() >= maxQueue() && t < 150 && !stopped(); t++) await sleep(100);
    if (stopped()) return false;
    const r = tryDo(f);
    if (r) lastTapAt = Date.now();
    await sleep(jitter(stepMs()));
    return r;
  }

  // wait until the game executed everything we queued (and the farm shows it)
  async function drain(isDone = () => true, maxMs = 15000) {
    const t0 = Date.now();
    await sleep(250);
    while (Date.now() - t0 < maxMs && !stopFlag) {
      if (queueLen() === 0 && isDone()) return true;
      await sleep(150);
    }
    return false;
  }

  const dryMachine = () => {
    const d = safe(() => g.DryMachineManager.instance);
    if (!d || !safe(() => d.mapData)) return null;
    return { used: Number(safe(() => d.getCapacity())) || 0, max: Number(d.maxCapacity) || 0, left: Number(safe(() => d.leftCapacity())) || 0,
      power: Number(safe(() => d.getPower())) || 0, maxPower: Number(d.maxPower) || 0,
      crops: (safe(() => d.data.crops) || []).map((c) => ({ name: itemCfg(c.id)?.name || c.id, qty: Number(c.qty) || 0 })).slice(0, 10) };
  };
  const goesToDryer = (prod) => !!safe(() => lm().isInDryMachine(Number(prod)));

  // The dryer fills with water crops and then blocks every water harvest. The game's batch popup
  // (DryMachineTradeAllPopup.onClickFun) does exactly: NetUtils.enqueue(DRIER_MACHINE_BATCH, s) then
  // DryMachineManager.instance.trade_plant_all / dry_plant_all({data:{ids}, totalNum}, s).
  // "ferment" sells for sell_for coins; "dry" moves the crop to the barn (for machines that eat it).
  // Each unit costs water_exp power (free regen); quantities are clamped to what is there and to the power.
  let lastDryAt = 0;
  async function emptyDryer(s, done, force = false) {
    if (!feat("dryer")) return false;
    const dm = safe(() => g.DryMachineManager.instance);
    if (!dm || !safe(() => dm.mapData) || safe(() => lm().isChangeSceneing)) return false;
    if (Number(safe(() => dm.mapData.sceneId)) !== currentScene()) return false; // only from the farm it stands on
    const crops = (safe(() => dm.data.crops) || []).filter((c) => c && Number(c.qty) > 0);
    if (!crops.length) return false;
    const used = Number(safe(() => dm.getCapacity())) || 0, max = Number(dm.maxCapacity) || 1;
    let power = Number(safe(() => dm.getPower())) || 0;
    const maxPower = Number(dm.maxPower) || power;
    // act when it's filling up or the power would otherwise be wasted at its cap
    if (!force && used < max * 0.5 && power < maxPower - 10 && Date.now() - lastDryAt < 3 * 3600000) return false;
    const consumed = consumedAll(s), orders = orderNeed();
    const dry = {}, ferment = {};
    let nDry = 0, nFerment = 0;
    for (const c of crops) {
      const id = Number(c.id), cfgc = itemCfg(id) || {};
      const per = Number(cfgc.water_exp) || 1;
      let qty = Math.min(Number(c.qty), Math.floor(power / per));
      if (qty <= 0) break;
      // the barn gets what machines eat (a day), what open orders ask for and the stock target of possible inputs;
      // a crop the player locked in the barn is never sold; only the surplus is fermented (sold)
      const inBarn = Number(safe(() => lm().getStorageQtyById(id))) || 0;
      const target = (consumed.has(id) ? Math.ceil(consumed.get(id) * STOCK_HOURS) : 0) + (orders.get(id) || 0) + (maybeInput(id) ? stockTarget() : 0);
      const want = safe(() => lm().wareItemIsLocked(id)) ? qty : Math.max(0, target - inBarn);
      const toBarn = Math.min(qty, want);
      if (toBarn > 0) { dry[id] = toBarn; nDry += toBarn; }
      if (qty - toBarn > 0) { ferment[id] = qty - toBarn; nFerment += qty - toBarn; }
      power -= qty * per;
    }
    const run = (action, ids, total) => tap(() => {
      const p = { action, ids, x: dm.mapData.x, y: dm.mapData.y };
      g.NetUtils.enqueue(g.HttpConst.DRIER_MACHINE_BATCH, p);
      if (action === "dry") dm.dry_plant_all({ data: { ids }, totalNum: total }, p);
      else dm.trade_plant_all({ data: { ids }, totalNum: total }, p);
    });
    let did = false;
    if (nDry > 0) {
      step(`🫙 المجفف: بينشّف ${nDry} للمخزن (المكن محتاجاه)`, "dryer");
      if (await run("dry", dry, nDry)) { did = true; decide(`🫙 نشّفت ${nDry} محصول مائي للمخزن عشان المكن`); }
    }
    if (nFerment > 0) {
      const coinsIn = Object.entries(ferment).reduce((a, [id, n]) => a + sellValue(id) * n, 0);
      step(`🫙 المجفف: بيبيع ${nFerment} (+${fmt(coinsIn)} 🪙)`, "dryer");
      if (await run("ferment", ferment, nFerment)) {
        did = true;
        add(done, "earned", coinsIn); add(done, "sold", nFerment);
        decide(`🫙 فضّيت المجفف: بعت ${nFerment} محصول مائي بـ ${fmt(coinsIn)} 🪙`);
      }
    }
    if (did) { lastDryAt = Date.now(); await drain(() => true, 4000); }
    return did;
  }

  async function harvestPlants(s, done, between, allowDryer = false) {
    const list = s.readyPlants;
    let dry = dryMachine(), dryFull = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (stopped()) return;
      if (!ok(p) || !ready(p)) continue;
      // water crops land in the dry machine: don't tap when it's full (the game refuses and the tap is wasted)
      const prod = safe(() => p.configData.product);
      if (dry && goesToDryer(prod)) {
        const n = Number(safe(() => p.getHarvestNum())) || 1;
        if (dry.left < n && !dryFull && allowDryer) {
          const emptied = await emptyDryer(scan() || s, done, true).catch((e) => { warn("المجفف: " + String(e && e.message).slice(0, 60)); return false; });
          if (emptied) dry = dryMachine() || dry;
        }
        if (dry.left < n) { if (!dryFull) { dryFull = true; warn(`المجفف مليان (${dry.used}/${dry.max}) — المحصول المائي مستني تجفيف أو بيع من المجفف`); decide("🫙 المجفف مليان — وقّفت حصاد المائي لحد ما يفضى"); } continue; }
        dry.left -= n; dry.used += n;
      }
      step(`🌾 بيحصد ${nameOf(p)} (${i + 1}/${list.length})`, "harvest");
      if (await tap(() => s.ctrl.harvestPlant(p))) add(done, "harvested");
      // a long harvest must not keep machines/animals waiting
      if (between && i % 25 === 24) await between(i);
    }
    if (list.length) {
      await drain(() => list.every((p) => !ok(p) || !ready(p)));
      const after = scan();
      if (after && after.readyPlants.length >= list.length) warn("الحصاد مش ماشي — ممكن المخزن مليان");
    }
  }

  async function harvestTrees(s, done) {
    const list = s.readyTrees;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (stopped()) return;
      if (!ok(t) || !ready(t)) continue;
      step(`🍌 بيحصد ${nameOf(t)} (${i + 1}/${list.length})`, "trees");
      if (await tap(() => s.ctrl.collectMapObject(t, t.collectAreaName))) add(done, "trees");
    }
    if (list.length) await drain(() => list.every((t) => !ready(t)));
  }

  const portCount = (m) => {
    const rm = safe(() => m.configData.raw_material);
    return Array.isArray(rm) && Array.isArray(rm[0]) ? rm.length : 1;
  };
  const slotsOf = (o, isMachine) => {
    const out = [];
    const n = isMachine ? portCount(o) : 1;
    for (let port = 1; port <= n; port++) {
      out.push({
        port,
        read: () => (isMachine ? getR(o, port - 1) : getR(o)),
        food: isMachine ? safe(() => o.getRawMaterialId(port)) : safe(() => o.configData.raw_material)
      });
    }
    return out;
  };
  // The game counts taps that are still in its queue under these keys (CollectObject.processCount):
  // "collect", "feed" for animals, "feed1".."feedN" for machine ports. Using the same keys keeps the
  // game's own can_collect/canFeed/can_refill_with right, and lets us skip taps already in flight.
  const pending = (o, key) => Number(safe(() => o.processCount[key])) || 0;
  const feedKey = (isMachine, port) => (isMachine ? "feed" + port : "feed");
  const toCollect = (o) => Math.max(0, Math.min(getP(o), Number(o.max_products) || 3) - pending(o, "collect"));
  const toFill = (o, isMachine, sl) => Math.max(0, maxR(o) - sl.read() - pending(o, feedKey(isMachine, sl.port)));
  // workLog: when this animal / machine last started a product (our own taps), to know when it's due again
  const workLog = new Map();
  const workKey = (o) => currentScene() + ":" + (o.map_unique_id ?? (o.x + "," + o.y));
  const markWork = (o) => workLog.set(workKey(o), serverNow());
  const needsWork = (o, isMachine) =>
    toCollect(o) > 0 || slotsOf(o, isMachine).some((sl) => sl.food && toFill(o, isMachine, sl) > 0);

  // An animal whose product sells for less than its food, and that nothing on any farm (machine, animal,
  // craft shop) or any open order needs, only burns food: fed clover (20) -> honey (5). Checked live 17 Oct:
  // 10 beehives were eating the clover the cows needed for milk. Its food is neither fed nor planted.
  // Bee hives "eat" a crop growing on the farm (raw_material = the clover SEED id 4, not barn clover 15):
  // the bees pollinate the field and it is still harvested. Nothing to feed from the barn; the crop has to
  // be growing (see smartPlan). Kitchen (CookBook) materials such as honey always count as needed.
  const seedFood = (a) => itemCfg([].concat(safe(() => a.configData.raw_material))[0])?.type === "seeds";
  let kitchenSet = null;
  const kitchenMaterials = () => kitchenSet || (kitchenSet = new Set(Object.values(safe(() => g.Config.CookBook) || {})
    .flatMap((r) => (r && r.materials) || []).map((m) => Number(m.id))));
  const wasteCache = new Map();
  function wasteful(a) {
    const c = safe(() => a.configData);
    if (!c || seedFood(a)) return false;
    const key = String(c.id || c.name);
    const hit = wasteCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.v;
    const food = Number([].concat(c.raw_material)[0]), prod = Number([].concat(c.product)[0]);
    const v = !!(food && prod && sellValue(prod) < sellValue(food) && !maybeInput(prod) && !kitchenMaterials().has(prod) &&
      !(safe(() => orderNeed()) || new Map()).has(prod));
    wasteCache.set(key, { v, at: Date.now() });
    return v;
  }
  const usefulAnimals = (s) => s.animals.filter((a) => !wasteful(a) && !seedFood(a));
  let wasteNoted = 0;

  // Pass 1: collect every product of every object (exactly as many taps as products).
  // Pass 2: fill every object/slot up to its max (exactly as many taps as empty places).
  // Exact counts matter: the game sends every tap to the server, even a useless one.
  // cropsFirst (optional): the farmer walks to every object, so a big group takes minutes; crops that ripen
  // meanwhile are harvested and replanted first, then the group goes on where it stopped.
  async function tendGroup(s, list, isMachine, done, cropsFirst) {
    const icon = isMachine ? "⚙️" : "🐄";
    const phase = isMachine ? "machines" : "animals";
    let lastCheck = Date.now();
    const yieldToCrops = async () => {
      if (!cropsFirst || Date.now() - lastCheck < 5000) return;
      lastCheck = Date.now();
      if (await cropsFirst()) lastCheck = Date.now();
    };
    if (opt(isMachine ? "machineCollect" : "animalCollect")) {
      const withProducts = list.filter((o) => toCollect(o) > 0);
      for (let i = 0; i < withProducts.length; i++) {
        const o = withProducts[i];
        if (stopped()) return;
        await yieldToCrops();
        const n = toCollect(o);
        if (n <= 0) continue;
        step(`${icon} بيجمّع من ${nameOf(o)} ×${n} (${i + 1}/${withProducts.length})`, phase);
        for (let k = 0; k < n; k++) {
          if (!(await tap(() => s.ctrl.collectMapObject(o, o.collectAreaName)))) break;
          add(done, isMachine ? "mCollected" : "collected");
          markWork(o);
        }
      }
      if (withProducts.length) await drain(() => withProducts.every((o) => getP(o) === 0));
    }
    if (opt(isMachine ? "machineRefill" : "animalFeed")) {
      const filled = [];
      const skipped = new Set();
      for (const o of list) {
        if (stopped()) return;
        await yieldToCrops();
        if (!isMachine && seedFood(o)) continue; // bees: they work off the crop growing on the farm
        if (!isMachine && wasteful(o)) { skipped.add(nameOf(o)); continue; }
        for (const sl of slotsOf(o, isMachine)) {
          if (!sl.food) continue;
          const need = toFill(o, isMachine, sl);
          if (need <= 0) continue;
          const have = storageQty(s.ctrl, sl.food);
          if (have <= 0) { warn(`مفيش خامات لـ ${nameOf(o)}`); continue; }
          const n = Math.min(need, have);
          const target = sl.read() + n;
          step(`${isMachine ? "📥 بيعبّي" : "🍽 بيأكّل"} ${nameOf(o)} ×${n} (${sl.read()}/${maxR(o)})`, phase);
          for (let k = 0; k < n; k++) {
            const tapped = await tap(isMachine
              ? () => s.ctrl.refillMapObject(o, o.refillAreaName, sl.port)
              : () => s.ctrl.feedMapObject(o, o.refillAreaName));
            if (!tapped) break;
            add(done, isMachine ? "mRefilled" : "fed");
            if (!workLog.has(workKey(o)) || !o.is_working) markWork(o);
          }
          filled.push(() => sl.read() >= target);
        }
      }
      if (filled.length) await drain(() => filled.every((f) => f()));
      if (skipped.size && Date.now() - wasteNoted > 60 * 60000) {
        wasteNoted = Date.now();
        decide(`🚫 مابأكّلش ${[...skipped].join("، ")}: المنتج أرخص من الأكل ومحدش محتاجه — الأكل بيروح للي بيكسب`);
      }
    }
  }

  async function tendAnimals(s, done, cropsFirst) { await tendGroup(s, s.animals, false, done, cropsFirst); }
  async function tendMachines(s, done, cropsFirst) { await tendGroup(s, s.machines, true, done, cropsFirst); }


  // ---------- smart planting: grow what this farm's machines & animals actually consume ----------
  // Walks the recipe chain: machine slot / animal food -> (machine that makes it -> its raw materials)… -> crop seed.
  // Example: coffee machine needs milk -> milk comes from an animal / machine -> … -> clover seed.
  const BUFFER_FILLS = 5; // keep enough in the barn for 5 full refills of every consumer
  let seedCache = null, seedCacheAt = 0, seedCacheScene = null;
  // Seeds the shop shows with a lock: buying them anyway gets refused by the server (the plant shows,
  // then vanishes on the next load). Rules read from the live game's configs / ShopItem:
  //  - special_type "limitseeds" / pack_rp_price: unlocked for a while with RC (dinars) -> AppData.limitseeds[id].end
  //  - event_unlock_seed: same timed unlock (goose / drop events)
  //  - water_level / vip_level above the player's, unlock_task_ids (story tasks), max_buy_level below the player's level
  function seedLocked(c, lvl) {
    const ad = safe(() => lm().AppData) || {};
    const packOpen = () => Number(safe(() => ad.limitseeds[c.id].end)) > serverNow();
    if ((c.special_type === "limitseeds" || Number(c.pack_rp_price) > 0 || c.event_unlock_seed) && !packOpen()) return true;
    if (c.water_level != null && Number(c.water_level) > (Number(ad.water_level) || 0)) return true;
    if (c.vip_level != null && Number(c.vip_level) > (Number(ad.vip_level) || 0)) return true;
    const tasks = Array.isArray(c.unlock_task_ids) ? c.unlock_task_ids : String(c.unlock_task_ids || "").split(",").filter(Boolean);
    if (tasks.length && !packOpen()) return true;
    if (c.max_buy_level != null && lvl && lvl > Number(c.max_buy_level)) return true;
    return false;
  }
  // the last gate before any seed is planted (also the player's pick / chosen seed / fallbacks):
  // coins-only, shop-buyable, level reached, not locked; returns the full config or null
  function plantable(c) {
    c = c && (safe(() => g.Config.Store_GetItemData(Number(c.id))) || c);
    if (!c || c.type !== "seeds" || c.buyable === false || c.map_object === false || !Number(c.product)) return null;
    if (c.rp_price || c.rc_price || c.cash_price) return null;
    const lvl = playerLevel();
    if (lvl && (Number(c.level) || 0) > lvl) return null;
    return seedLocked(c, lvl) ? null : c;
  }
  function buyableSeeds(s) {
    const scene = Number(safe(() => g.GF.loginModel.AppData.scene_select)) || 0;
    if (!seedCache || seedCacheScene !== scene || Date.now() - seedCacheAt > 10 * 60000) {
      const lvl = playerLevel();
      seedCache = allSeeds(s.plants).filter((c) =>
        c.map_object !== false && c.buyable !== false && Number(c.product) &&
        !c.rp_price && !c.rc_price && !c.cash_price && (!lvl || (Number(c.level) || 0) <= lvl) &&
        (c.only_scene == null || Number(c.only_scene) === scene));
      seedCacheAt = Date.now();
      seedCacheScene = scene;
    }
    // timed (dinar) unlocks can expire any minute: the lock is checked on every read, not cached
    const lvl = playerLevel();
    return seedCache.filter((c) => !seedLocked(c, lvl));
  }

  const seedsFor = (s, water) => buyableSeeds(s).filter((c) => isWaterSeed(c) === !!water);

  function machineRecipes(machines) {
    const recipe = new Map();
    for (const m of machines) {
      const rm = safe(() => m.configData.raw_material), pr = safe(() => m.configData.product);
      if (!Array.isArray(pr)) continue;
      const ports = Array.isArray(rm) && Array.isArray(rm[0]) ? rm : [rm];
      pr.forEach((p, i) => {
        const raws = ports.map((list) => Array.isArray(list) ? Number(list[i]) : Number(list)).filter(Boolean);
        if (raws.length && !recipe.has(Number(p))) recipe.set(Number(p), { raws, by: nameOf(m) });
      });
    }
    return recipe;
  }

  // ---------- craft shops (read from the live game, 17 Oct) ----------
  // Dessert (beauty_*), Beauty (newbeauty_*) and Aqua (watershop_*) shops craft by themselves every second
  // for each recipe set to auto, as long as the barn has its materials: the bot's job is to grow them and
  // never sell them. The floral art shop crafts instantly (~+5,000 coins over the materials for the best
  // recipes): the bot grows the materials of the best recipe it can grow and crafts when they are in.
  const AUTO_SHOPS = [["beauty_auto_data", "BeautyShop"], ["newbeauty_auto_data", "NewBeautyShop"], ["watershop_auto_data", "WaterShop"]];
  const FLORAL = 10058; // ControllerConst.FloralArtShop
  const recipeHours = (r) => Math.max(1 / 60, (Number(r && r.time) || 3600) / 3600);
  const recipeCost = (r) => (r.materials || []).reduce((a, m) => a + sellValue(m.id) * (Number(m.qty) || 0), 0);
  function autoRecipes() {
    const ad = safe(() => lm().AppData) || {}, out = [];
    for (const [key, table] of AUTO_SHOPS) {
      for (const e of Object.values(ad[key] || {})) {
        if (!e || !Number(e.auto)) continue;
        const r = safe(() => g.Config[table][Number(e.itemid)]);
        if (r && Array.isArray(r.materials)) out.push(r);
      }
    }
    return out;
  }
  const floralRecipes = () => Object.values(safe(() => g.Config.FloralArtShop) || {})
    .filter((r) => r && Array.isArray(r.materials) && r.product && (Number(r.level) || 0) <= (playerLevel() || 0));
  // the floral recipe worth growing for: best margin among those whose every material is a crop we can plant
  // (or already plenty in the barn); hours = the slowest of its crops
  let floralPick = null, floralPickAt = 0;
  function floralTarget(s) {
    if (Date.now() - floralPickAt < 10 * 60000) return floralPick;
    floralPickAt = Date.now();
    const seedOf = new Map();
    for (const c of safe(() => buyableSeeds(s)) || []) if (plantable(c)) seedOf.set(Number(c.product), c);
    let best = null;
    for (const r of floralRecipes()) {
      const margin = sellValue(r.product) - recipeCost(r);
      if (margin <= 500 || (best && margin <= best.margin)) continue;
      let hours = 1, okAll = true;
      for (const m of r.materials) {
        const seed = seedOf.get(Number(m.id)), have = storageQty(s.ctrl, m.id);
        if (seed) hours = Math.max(hours, (Number(seed.collect_in) || 3600) / 3600);
        else if (!(have !== Infinity && have >= Number(m.qty) * 3)) { okAll = false; break; }
      }
      if (okAll) best = { r, margin, hours, name: itemCfg(r.product)?.name || r.name, value: margin / hours };
    }
    floralPick = best;
    return best;
  }
  function shopConsumers(s, withFloral = true) {
    const out = [];
    for (const r of autoRecipes()) {
      // what the shop really adds: product price minus its materials (checked live: most auto recipes add
      // only +100-300 coins/h), so their crops get their needs but not the free soil
      const v = Math.max(1, sellValue(r.product) - recipeCost(r)) / recipeHours(r), name = itemCfg(r.product)?.name || r.name;
      for (const m of r.materials) out.push({ food: Number(m.id), qty: (Number(m.qty) || 0) * BUFFER_FILLS, name, value: v, perHour: (Number(m.qty) || 0) / recipeHours(r) });
    }
    const f = withFloral ? safe(() => floralTarget(s)) : null;
    if (f) for (const m of f.r.materials) out.push({ food: Number(m.id), qty: (Number(m.qty) || 0) * BUFFER_FILLS, name: f.name, value: f.value, perHour: (Number(m.qty) || 0) / f.hours });
    return out;
  }
  // instant crafts in the floral art shop: the game's own make() without its window (the window code runs
  // after the request and breaks when it was never opened): check, take the materials, add XP + product, send
  let lastFloralAt = 0;
  async function craftFloral(s, done) {
    if (!feat("crafts") || Date.now() - lastFloralAt < 60000) return;
    lastFloralAt = Date.now();
    const fc = safe(() => g.App.ControllerManager._modules[FLORAL]), model = fc && fc.commonShopModel;
    if (!fc || !model || typeof fc.sendToServer !== "function" || typeof model.checkProductCanMake !== "function") return;
    const other = consumedAll(s, false); // what everything else eats keeps a day of stock
    const list = floralRecipes().map((r) => ({ r, margin: sellValue(r.product) - recipeCost(r) })).filter((x) => x.margin > 0).sort((a, b) => b.margin - a.margin);
    let made = 0, earned = 0, xp = 0;
    for (const x of list.slice(0, 15)) {
      for (let k = 0; k < 20 && !stopped(); k++) {
        const enough = x.r.materials.every((m) => {
          const q = storageQty(s.ctrl, m.id), id = Number(m.id);
          return q !== Infinity && q - (Number(m.qty) || 0) >= (other.has(id) ? Math.ceil(other.get(id) * STOCK_HOURS) : 0);
        });
        if (!enough || !safe(() => model.checkProductCanMake(x.r, 1))) break;
        if (!tryDo(() => { lm().reduceMaterials(x.r, 1); lm().addTreasure(g.TreasureType.Exp, Number(x.r.exp) || 0); lm().addStorage(x.r.product, 1); fc.sendToServer(x.r, 1); })) break;
        made++; earned += x.margin; xp += Number(x.r.exp) || 0;
        step(`💐 بيصنع ${itemCfg(x.r.product)?.name || x.r.name} في محل تنسيق الزهور`, "craft");
        await sleep(jitter(900));
      }
    }
    if (made) { add(done, "crafted", made); decide(`💐 صنعت ${made} في محل تنسيق الزهور: +${fmt(earned)} 🪙 زيادة عن تمن الخامات، +${xp} XP`); }
  }

  // coins per hour that depend on an item: an animal / machine slot eating it makes a product worth
  // sell_for × products per hour; that value runs down the recipe chain to the crops at the bottom.
  function valuePerHour(s) {
    const recipe = machineRecipes(s.machines);
    for (const [id, kn] of Object.entries(sceneKnow)) {
      if (Number(id) === currentScene()) continue;
      for (const [pr, raws] of kn.recipeIds || []) if (!recipe.has(Number(pr))) recipe.set(Number(pr), { raws });
    }
    const out = new Map();
    const addUp = (id, v, depth) => {
      id = Number(id);
      if (!id || depth > 4 || !(v > 0)) return;
      out.set(id, (out.get(id) || 0) + v);
      for (const raw of (recipe.get(id) || {}).raws || []) addUp(raw, v, depth + 1);
    };
    const perHour = (o) => 1 / Math.max(1 / 60, (objSecs(o) || 3600) / 3600);
    for (const a of usefulAnimals(s)) addUp(safe(() => a.configData.raw_material), sellValue([].concat(safe(() => a.configData.product))[0]) * perHour(a), 0);
    for (const m of s.machines) {
      const made = [].concat(safe(() => m.configData.product) || [])[Number(m.selected_raw_material) || 0];
      for (const sl of slotsOf(m, true)) addUp(sl.food, sellValue(made) * perHour(m), 0);
    }
    return out;
  }
  function valueAll(s) {
    const all = new Map(safe(() => valuePerHour(s)) || []);
    for (const c of safe(() => shopConsumers(s)) || []) all.set(c.food, (all.get(c.food) || 0) + c.value);
    for (const [id, kn] of Object.entries(sceneKnow)) {
      if (Number(id) === currentScene()) continue;
      for (const [item, v] of kn.valueIds || []) all.set(Number(item), (all.get(Number(item)) || 0) + Number(v));
    }
    return all;
  }
  // the soil left after the urgent needs and the stock: crops that feed the animals / machines that earn the most.
  // Up to 3 days of their use first (best value first), then the rest still goes to the best inputs.
  function inputPlan(s, soilCount, water = false) {
    if (soilCount <= 0) return { jobs: [], left: soilCount };
    const value = valueAll(s), use = consumedAll(s);
    const harvestNum = new Map(), growing = new Map();
    for (const p of s.plants) {
      const id = Number(safe(() => p.configData.id)), prod = Number(safe(() => p.configData.product));
      if (id && !harvestNum.has(id)) harvestNum.set(id, Number(safe(() => p.getHarvestNum())) || 1);
      if (prod) growing.set(prod, (growing.get(prod) || 0) + 1);
    }
    const byProduct = new Map();
    for (const c of seedsFor(s, water).filter(plantable)) {
      const prod = Number(c.product);
      if (!(value.get(prod) > 0)) continue;
      const cur = byProduct.get(prod);
      if (!cur || (Number(c.collect_in) || 0) < (Number(cur.collect_in) || 0)) byProduct.set(prod, c);
    }
    const list = [...byProduct.entries()].map(([prod, seed]) => {
      const n = harvestNum.get(Number(seed.id)) || 1;
      const have = storageQty(s.ctrl, prod), qty = have === Infinity ? 0 : have;
      const target = Math.ceil((use.get(prod) || 0) * STOCK_HOURS);
      return { seed, prod, n, qty, value: value.get(prod), room: Math.max(0, Math.ceil((target - qty - (growing.get(prod) || 0) * n) / n)) };
    }).sort((a, b) => b.value - a.value);
    const jobs = [];
    let left = soilCount;
    for (const x of list) {
      if (left <= 0) break;
      const take = Math.min(x.room, left);
      if (take > 0) { jobs.push({ ...x, n: take }); left -= take; }
    }
    // everything is stocked: the rest still goes to the two inputs that earn the most
    const top = list.slice(0, 2);
    if (left > 0 && top.length) {
      const each = Math.ceil(left / top.length);
      for (const x of top) {
        const take = Math.min(each, left);
        if (take <= 0) break;
        const j = jobs.find((y) => y.prod === x.prod);
        if (j) j.n += take; else jobs.push({ ...x, n: take });
        left -= take;
      }
    }
    return { jobs, left, any: list.length > 0 };
  }

  function smartPlan(s, soilCount, water = false) {
    const seedByProduct = new Map();
    for (const c of seedsFor(s, water)) {
      const prod = Number(c.product);
      const cur = seedByProduct.get(prod);
      if (!cur || (Number(c.collect_in) || 0) < (Number(cur.collect_in) || 0)) seedByProduct.set(prod, c);
    }
    // product id -> raw materials needed (one per machine slot), from the machines on this farm,
    // then the ones remembered from the other farms (a machine there can make an input from crops grown here)
    const recipe = machineRecipes(s.machines);
    for (const [id, kn] of Object.entries(sceneKnow)) {
      if (Number(id) === currentScene()) continue;
      for (const [pr, raws] of kn.recipeIds || []) if (!recipe.has(Number(pr))) recipe.set(Number(pr), { raws, by: kn.name });
    }
    // what is already growing
    const growing = new Map();
    for (const p of s.plants) {
      const prod = Number(safe(() => p.configData.product));
      if (prod) growing.set(prod, (growing.get(prod) || 0) + 1);
    }

    const need = new Map(); // crop product id -> { n, for: Set(names) }
    const seen = new Set();
    const resolve = (id, n, consumer, depth) => {
      id = Number(id);
      if (!id || n <= 0 || depth > 4) return;
      const short = n - Math.min(n, storageQty(s.ctrl, id) === Infinity ? 0 : storageQty(s.ctrl, id));
      if (short <= 0) return;
      if (seedByProduct.has(id)) {
        const e = need.get(id) || { n: 0, for: new Set() };
        e.n += short;
        e.for.add(consumer);
        need.set(id, e);
        return;
      }
      const r = recipe.get(id);
      if (!r || seen.has(id + ":" + depth)) return;
      seen.add(id + ":" + depth);
      for (const raw of r.raws) resolve(raw, short, consumer, depth + 1);
    };
    for (const a of usefulAnimals(s)) resolve(safe(() => a.configData.raw_material), maxR(a) * BUFFER_FILLS, nameOf(a), 0);
    for (const m of s.machines) for (const sl of slotsOf(m, true)) resolve(sl.food, maxR(m) * BUFFER_FILLS, nameOf(m), 0);
    // the barn is shared: grow here what the machines / animals of the other farms are short of too
    for (const [id, kn] of Object.entries(sceneKnow)) {
      if (Number(id) === currentScene()) continue;
      for (const [food, qty, name] of kn.needIds || []) resolve(food, qty, `${name} (${kn.name})`, 0);
    }
    // and what the craft shops need (auto recipes + the floral recipe worth growing for)
    for (const c of safe(() => shopConsumers(s)) || []) resolve(c.food, c.qty, `${c.name} (محل)`, 0);

    const plan = [];
    let left = soilCount;
    // bee hives need their crop in the field: about 3 growing plots per hive
    const bees = new Map();
    for (const a of s.animals) if (seedFood(a)) { const id = Number([].concat(a.configData.raw_material)[0]); bees.set(id, (bees.get(id) || 0) + 1); }
    for (const [seedId, hives] of bees) {
      const seed = plantable(itemCfg(seedId));
      if (!seed || isWaterSeed(seed) !== !!water) continue;
      const growingNow = s.plants.filter((p) => Number(safe(() => p.configData.id)) === seedId).length;
      const take = Math.min(left, Math.max(0, hives * 3 - growingNow));
      if (take > 0) { plan.push({ seed, n: take, for: [`النحل (${hives} خلية بتلقّح)`] }); left -= take; }
    }
    const list = [...need.entries()]
      .map(([prod, e]) => ({ prod, n: e.n - (growing.get(prod) || 0), for: [...e.for] }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    for (const x of list) {
      if (left <= 0) break;
      const take = Math.min(x.n, left);
      plan.push({ seed: seedByProduct.get(x.prod), n: take, for: x.for });
      left -= take;
    }
    return { plan, left };
  }

  // ---------- game controllers (found by class, same objects the game's own buttons use) ----------
  const instCache = {};
  function findInstance(className) {
    const C = g[className];
    if (typeof C !== "function") return null;
    if (instCache[className] instanceof C) return instCache[className];
    const seen = new Set();
    const look = (o, d) => {
      if (!o || typeof o !== "object" || seen.has(o) || d > 3 || seen.size > 30000) return null;
      seen.add(o);
      if (o instanceof C) return o;
      for (const k of safe(() => Object.keys(o)) || []) {
        const r = look(safe(() => o[k]), d + 1);
        if (r) return r;
      }
      return null;
    };
    const hit = look(safe(() => g.App.ControllerManager), 0) || look(g.GF, 0);
    if (hit) instCache[className] = hit;
    return hit;
  }
  const lm = () => safe(() => g.GF.loginModel);
  const coins = () => Number(safe(() => lm().AppData.coins)) || 0;
  const itemCfg = (id) => safe(() => g.Config.Store_GetItemData(Number(id)));

  // how much of each item this farm's machines/animals consume (whole chain, not only crops)
  function demandMap(s) {
    const recipe = new Map();
    for (const m of s.machines) {
      const rm = safe(() => m.configData.raw_material), pr = safe(() => m.configData.product);
      if (!Array.isArray(pr)) continue;
      const ports = Array.isArray(rm) && Array.isArray(rm[0]) ? rm : [rm];
      pr.forEach((p, i) => {
        const raws = ports.map((list) => (Array.isArray(list) ? Number(list[i]) : Number(list))).filter(Boolean);
        if (raws.length && !recipe.has(Number(p))) recipe.set(Number(p), raws);
      });
    }
    const out = new Map();
    const addUp = (id, n, depth) => {
      id = Number(id);
      if (!id || depth > 4) return;
      out.set(id, (out.get(id) || 0) + n);
      for (const raw of recipe.get(id) || []) addUp(raw, n, depth + 1);
    };
    for (const a of usefulAnimals(s)) addUp(safe(() => a.configData.raw_material), maxR(a) * BUFFER_FILLS, 0);
    for (const m of s.machines) for (const sl of slotsOf(m, true)) addUp(sl.food, maxR(m) * BUFFER_FILLS, 0);
    return out;
  }

  // how many of each input the farm eats per hour (one raw material per product, chain included)
  function consumptionPerHour(s) {
    const recipe = new Map();
    for (const m of s.machines) {
      const rm = safe(() => m.configData.raw_material), pr = safe(() => m.configData.product);
      if (!Array.isArray(pr)) continue;
      const ports = Array.isArray(rm) && Array.isArray(rm[0]) ? rm : [rm];
      pr.forEach((p, i) => {
        const raws = ports.map((list) => (Array.isArray(list) ? Number(list[i]) : Number(list))).filter(Boolean);
        if (raws.length && !recipe.has(Number(p))) recipe.set(Number(p), raws);
      });
    }
    const out = new Map();
    const addUp = (id, perHour, depth) => {
      id = Number(id);
      if (!id || depth > 4 || !(perHour > 0)) return;
      out.set(id, (out.get(id) || 0) + perHour);
      for (const raw of recipe.get(id) || []) addUp(raw, perHour, depth + 1);
    };
    const rate = (o) => 1 / Math.max(1 / 60, (objSecs(o) || 3600) / 3600);
    for (const a of usefulAnimals(s)) addUp(safe(() => a.configData.raw_material), rate(a), 0);
    for (const m of s.machines) for (const sl of slotsOf(m, true)) addUp(sl.food, rate(m), 0);
    return out;
  }
  const cropIds = (s) => new Set(buyableSeeds(s).map((c) => Number(c.product)).filter(Boolean));
  // inputs eaten on ANY farm (remembered from the last visit of each farm) + the farm we're on now.
  // Selling / giving away must never take an input of a machine standing on another farm.
  const sceneUse = {}; // sceneId -> Map(itemId -> per hour)
  const sceneInputs = {}; // sceneId -> Set of every item any machine / animal there CAN eat (any product choice)
  function consumedAll(s, withFloral = true) {
    const cur = consumptionPerHour(s);
    sceneUse[currentScene()] = cur;
    const ins = new Set();
    for (const o of [...s.machines, ...s.animals]) {
      const rm = safe(() => o.configData.raw_material);
      for (const x of [].concat(rm == null ? [] : rm).flat(2)) if (Number(x)) ins.add(Number(x));
    }
    sceneInputs[currentScene()] = ins;
    const all = new Map();
    for (const m of Object.values(sceneUse)) for (const [id, n] of m) all.set(id, (all.get(id) || 0) + n);
    for (const [sid, kn] of Object.entries(sceneKnow)) {
      if (sceneUse[sid]) continue;
      for (const [id, n] of kn.useIds || []) all.set(Number(id), (all.get(Number(id)) || 0) + Number(n));
    }
    for (const c of safe(() => shopConsumers(s, withFloral)) || []) all.set(c.food, (all.get(c.food) || 0) + c.perHour);
    return all;
  }
  // how many of an item the open market (ship) and trade orders still ask for
  // every input of every machine / animal on ALL farms, from the game's own map of every farm
  // (AppData.allSceneMap), so even farms the bot hasn't visited yet in this session are protected
  let mapInputs = null, mapInputsAt = 0;
  function allMapInputs() {
    if (mapInputs && Date.now() - mapInputsAt < 10 * 60000) return mapInputs;
    const set = new Set();
    for (const list of Object.values(safe(() => lm().AppData.allSceneMap) || {})) {
      for (const mo of list || []) {
        const c = itemCfg(mo && (mo.itemid ?? mo.id));
        const rm = c && c.raw_material;
        // any map object that eats something (animals, "buildings" and "gear" machines, ...); seeds carry raw_material:false
        if (c && c.type !== "seeds" && rm != null && rm !== false) for (const x of [].concat(rm).flat(3)) if (Number(x)) set.add(Number(x));
      }
    }
    // recipes the game crafts by itself (dessert / beauty / water shops on auto) eat their materials from the barn
    const ad = safe(() => lm().AppData) || {};
    const recipes = [["beauty_auto_data", "BeautyShop"], ["beauty_data", "BeautyShop"], ["newbeauty_auto_data", "NewBeautyShop"], ["newbeauty_data", "NewBeautyShop"],
      ["watershop_auto_data", "WaterShop"], ["watershop_data", "WaterShop"], ["allWaterShopData", "WaterShop"]];
    for (const [key, table] of recipes) {
      for (const e of Object.values(ad[key] || {})) {
        const r = safe(() => g.Config[table][Number(e && e.itemid)]);
        for (const m of (r && r.materials) || []) if (Number(m.id)) set.add(Number(m.id));
      }
    }
    mapInputs = set; mapInputsAt = Date.now();
    return set;
  }
  // could a machine / animal on any farm eat this (even if it's set to another product right now)?
  const maybeInput = (id) => allMapInputs().has(Number(id)) || Object.values(sceneInputs).some((set) => set.has(Number(id)));
  function orderNeed() {
    const need = new Map();
    const put = (id, n) => { id = Number(id); if (id && n > 0) need.set(id, (need.get(id) || 0) + n); };
    for (const it of safe(() => g.GF.shipOrderModel.shiporders.data) || []) if (it && !it.finish) put(it.id, Number(it.num) || 0);
    const tm = safe(() => findInstance("TradeOrderController").tradeOrderModel);
    for (const o of safe(() => tm.data) || []) if (o && o.hasData) for (const x of o.exchange || []) put(x.itemId, Number(x.num) || 0);
    return need;
  }
  // end products kept in the barn after selling (the model may tune it; plus whatever open orders ask for)
  const END_RESERVE_DEFAULT = 50;
  const endReserve = () => { const v = Number(cfg.playbook && cfg.playbook.endReserve); return v > 0 ? Math.min(1000, Math.max(20, v)) : END_RESERVE_DEFAULT; };

  // items this farm produces (the only things the bot is allowed to sell)
  function producedIds(s) {
    const set = new Set();
    const addAll = (v) => [].concat(v || []).forEach((x) => set.add(Number(x)));
    for (const p of s.plants) addAll(safe(() => p.configData.product));
    for (const c of buyableSeeds(s)) addAll(c.product);
    for (const t of s.trees) addAll(safe(() => t.configData.product));
    for (const a of s.animals) addAll(safe(() => a.configData.product));
    for (const m of s.machines) addAll(safe(() => m.configData.product));
    // fish (caught by the rods) and products of the dessert / beauty / water shops
    for (const k of Object.keys(safe(() => lm().AppData.storage) || {})) {
      const c = itemCfg(k);
      if (c && c.type === "products" && (c.fishpos != null || c.beautyshop_product || c.beautyshop2_product || c.watershop_product)) set.add(Number(k));
    }
    set.delete(0);
    set.delete(NaN);
    return set;
  }

  // ---------- selling from the barn ----------
  // Sells only what the farm produces, never below the minimum / what machines & animals need,
  // never items the player locked in the barn, and only for coins.
  function sellPlan(s, wantCoins) {
    const sc = cfg.sell || {};
    const storage = safe(() => lm().AppData.storage) || {};
    const produced = producedIds(s), consumed = consumedAll(s), crops = cropIds(s), orders = orderNeed();
    const keepMin = Number(sc.keepMin ?? 30), maxEach = Number(sc.maxEach || 500);
    const agent = !!cfg.agent;
    const endProducts = [], cropsSpare = [];
    for (const [k, v] of Object.entries(storage)) {
      const id = Number(k), qty = Number(v) || 0;
      if (!produced.has(id) || safe(() => lm().wareItemIsLocked(id))) continue;
      if (consumed.has(id)) continue; // an input of a machine / animal: never sold
      const c = itemCfg(id);
      const price = Number(c && c.sell_for) || 0;
      if (!price || (c && c.sell_for_ancient_coins)) continue;
      // what stays in the barn: crops keep the stock target; end products only a small reserve + open orders
      // (a possible input of some machine keeps the stock target too: product choices may switch to it)
      const reserve = crops.has(id) || maybeInput(id) ? Math.max(keepMin, stockTarget()) + (orders.get(id) || 0)
        : agent ? endReserve() + (orders.get(id) || 0) : keepMin;
      const x = { id, name: c.name, qty, price, reserve };
      if (crops.has(id)) cropsSpare.push(x); else endProducts.push(x);
    }
    const plan = new Map();
    const take = (x, n, reason) => {
      if (n <= 0) return;
      const cur = plan.get(x.id) || { ...x, n: 0, reason };
      cur.n = Math.min(x.qty - x.reserve, cur.n + n);
      if (cur.n > 0) plan.set(x.id, cur);
    };
    // 1) end products (made by machines / animals, nobody here eats them): that's the income.
    //    agent: everything above the stock target; manual: only above the surplus limit
    for (const x of endProducts) {
      const limit = agent ? x.reserve : maxEach;
      if (sc.surplus !== false && x.qty > limit) take(x, x.qty - limit, agent ? "منتج نهائي (محدش بيستهلكه)" : `زاد عن ${maxEach}`);
    }
    // 2) still short of coins (planting / reserve): more end products first, crops only as a last resort
    const sold = () => [...plan.values()].reduce((a, x) => a + x.n * x.price, 0);
    let left = wantCoins - coins() - sold();
    const pools = agent ? [endProducts, cropsSpare] : [[...endProducts, ...cropsSpare]];
    for (const pool of pools) {
      for (const x of pool.slice().sort((a, b) => b.price - a.price)) {
        if (left <= 0) break;
        const already = plan.get(x.id)?.n || 0;
        const n = Math.min(x.qty - x.reserve - already, Math.ceil(left / x.price));
        if (n <= 0) continue;
        take(x, n, crops.has(x.id) ? "اضطراري: فلوس الزراعة" : "عشان فلوس الزراعة");
        left -= n * x.price;
      }
    }
    return [...plan.values()].filter((x) => x.n > 0).sort((a, b) => b.n * b.price - a.n * a.price).slice(0, 60);
  }

  // selling policy (agent): below the cash floor sell the surplus as usual; above it, keep everything
  // in the barn until the sellable surplus is worth the barn trigger, then sell it all at once.
  // Coins needed right now (seeds, reserve) are always raised.
  let lastHoldMsg = 0;
  async function sellIfNeeded(s, done, wantCoins = 0) {
    if (!cfg.sell || !cfg.sell.on) return;
    const reserve = Math.max(Number(cfg.sell.reserve) || 0, Number(plan()?.sellReserve) || 0);
    let plan_ = sellPlan(s, Math.max(wantCoins, reserve));
    if (!plan_.length) return;
    const floor = Number(cfg.sell.cashFloor) || 0, trigger = Number(cfg.sell.barnTrigger) || 0;
    if (cfg.agent && floor > 0 && coins() >= floor && coins() >= Math.max(wantCoins, reserve)) {
      const surplus = sellPlan(s, 0);
      const worth = surplus.reduce((a, x) => a + x.n * x.price, 0);
      if (!trigger || worth < trigger) {
        if (Date.now() - lastHoldMsg > 30 * 60000) {
          lastHoldMsg = Date.now();
          decide(`🏦 مش ببيع: معاك ${fmt(coins())} (فوق ${fmt(floor)}) والحظيرة فيها ~${fmt(worth)} 🪙 للبيع — هبيع لما توصل ${fmt(trigger)}`);
        }
        return;
      }
      plan_ = surplus;
      decide(`💰 الحظيرة وصلت ~${fmt(worth)} 🪙 (فوق ${fmt(trigger)}) — ببيع الزيادة كلها مرة واحدة`);
    }
    // nothing to pay for right now: sell an item only once its surplus is worth something, not 1 meat for
    // 20 coins every minute (each sale is a tap the farm work waits for)
    if (coins() >= Math.max(wantCoins, reserve)) plan_ = plan_.filter((x) => x.n * x.price >= 1500);
    if (!plan_.length) return;
    const barn = findInstance("BarnController");
    if (!barn || typeof barn.onSell !== "function") return warn("مش لاقي الحظيرة عشان أبيع");
    for (const x of plan_) {
      if (stopped()) return;
      step(`💰 بيبيع ${x.name} ×${x.n} (+${(x.n * x.price).toLocaleString()} 🪙)`, "sell");
      const own = Number(safe(() => lm().getStorageQtyById(x.id))) || 0;
      if (own < x.n) continue;
      if (await tap(() => barn.onSell(x.id, x.n, own))) {
        add(done, "sold", x.n);
        add(done, "earned", x.n * x.price);
        decide(`💰 بعت ${x.name} ×${x.n} بـ ${fmt(x.n * x.price)} 🪙 (${x.reason || "زيادة عن الحاجة"})`);
      }
    }
    await drain(() => true, 5000);
  }

  // rough cost of planting all empty soils with the planned seeds
  function plantingCost(s) {
    if (!s.soils.length) return 0;
    let cost = 0;
    for (const water of [false, true]) {
      const soils = s.soils.filter((o) => isWaterSoil(o) === water);
      if (!soils.length) continue;
      const p = smartPlan(s, soils.length, water);
      const best = (cfg.seedMode || "agent") === "agent" ? safe(() => rankSeeds(s, water)[0]?.seed) : null;
      const chosen = plantable(seedConfig(cfg.seedId, s.plants));
      const fallback = best || (chosen && isWaterSeed(chosen) === water ? chosen : null) ||
        safe(() => seedsFor(s, water).slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0]);
      cost += p.plan.reduce((a, x) => a + x.n * (Number(x.seed.price) || 0), 0);
      if (fallback) cost += p.left * (Number(fallback.price) || 0);
    }
    return cost;
  }

  // ---------- farms (scenes): main / garden / water ----------
  const FS = () => g.FarmScene || {};
  function ownedScenes() {
    const f = FS(), l = lm();
    if (!l) return [];
    const main = Number(f.SCENE_MAIN ?? 0);
    const allowed = [main, f.SCENE_GARDEN, f.SCENE_WATER].filter((v) => v != null).map(Number);
    const owned = new Set([main]);
    for (const x of safe(() => l.AppData.multi_scene_data) || []) owned.add(Number(x.sceneid));
    return allowed.filter((id) => owned.has(id));
  }
  const currentScene = () => Number(safe(() => lm().AppData.scene_select)) || 0;
  const sceneName = (id) => {
    const f = FS();
    if (id === Number(f.SCENE_WATER)) return "المزرعة المائية";
    if (id === Number(f.SCENE_GARDEN)) return "الحديقة";
    return "المزرعة الرئيسية";
  };
  // ---------- the brain: economics, decisions, memory ----------
  // profit of one planting = product sell price × harvest amount − seed price
  // real cycle time       = until the bot can actually harvest it (crops that ripen while the bot
  //                         sleeps wait until the working hours start again)
  // best seed             = highest profit per real hour
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  function seedEconomics(s, water = false) {
    const harvestNum = new Map();
    for (const p of s.plants) {
      const id = Number(safe(() => p.configData.id));
      if (id && !harvestNum.has(id)) harvestNum.set(id, Number(safe(() => p.getHarvestNum())) || 1);
    }
    return seedsFor(s, water).map((c) => {
      const prod = itemCfg(c.product);
      const sell = Number(prod && prod.sell_for) || 0;
      const n = harvestNum.get(Number(c.id)) || 1;
      const hours = Math.max(1 / 60, (Number(c.collect_in) || 0) / 3600);
      return { seed: c, sell, n, hours, profit: sell * n - (Number(c.price) || 0) };
    }).filter((x) => x.profit > 0);
  }

  // first moment at/after t when the bot is working (rest hours from the settings)
  function nextWorkTime(t) {
    const r = cfg.rest;
    if (!r || !r.on) return t;
    const d = new Date(t), m = d.getHours() * 60 + d.getMinutes();
    const from = minutesOf(r.from), to = minutesOf(r.to);
    const inHours = from <= to ? m >= from && m < to : m >= from || m < to;
    if (inHours) return t;
    const next = new Date(t);
    next.setHours(Math.floor(from / 60), from % 60, 0, 0);
    if (next.getTime() <= t) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  // how often the bot really comes back to this farm (median of the last gaps between visits).
  // With one farm it never leaves, so there's no floor.
  const visitLog = {}; // sceneId -> [enter times]
  function revisitHours() {
    if (ownedScenes().length < 2) return 0;
    const v = visitLog[currentScene()] || [];
    const gaps = [];
    for (let i = 1; i < v.length; i++) gaps.push((v[i] - v[i - 1]) / 3600000);
    if (!gaps.length) return 0.5; // not measured yet: assume half an hour
    gaps.sort((a, b) => a - b);
    return Math.min(6, gaps[Math.floor(gaps.length / 2)]);
  }
  // minutes until the working hours end (Infinity when the bot works 24 h)
  function minutesToStop() {
    const r = cfg.rest;
    if (!r || !r.on) return Infinity;
    const d = new Date(), cur = d.getHours() * 60 + d.getMinutes(), to = minutesOf(r.to);
    return (to - cur + 1440) % 1440;
  }
  function rankSeeds(s, water = false) {
    const now = Date.now();
    const floor = revisitHours();
    return seedEconomics(s, water).map((x) => {
      const harvestAt = nextWorkTime(now + x.hours * 3600000) + (Number(cfg.interval) || 5) * 1000;
      // a crop can't be harvested before the bot is back on this farm
      const realHours = Math.max((harvestAt - now) / 3600000, floor);
      return { ...x, realHours, rate: x.profit / realHours };
    }).sort((a, b) => b.rate - a.rate);
  }

  // memory: decisions + coin history (survives scene changes, not page reloads)
  const coinHistory = [];
  function recordCoins() {
    const c = coins(), t = Date.now();
    if (!c) return;
    coinHistory.push({ t, c });
    while (coinHistory.length && t - coinHistory[0].t > 3 * 3600000) coinHistory.shift();
  }
  function coinsPerHour() {
    if (coinHistory.length < 2) return null;
    const a = coinHistory[0], b = coinHistory[coinHistory.length - 1];
    const h = (b.t - a.t) / 3600000;
    return h < 0.1 ? null : (b.c - a.c) / h;
  }
  function decide(text) {
    const time = new Date().toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" });
    status.decisions = [{ time, text }, ...(status.decisions || [])].slice(0, 12);
  }

  // which product of each multi-product machine pays best per hour (needs its raw in the barn)
  function machineTips(s) {
    const out = [];
    for (const m of s.machines) {
      const raws = safe(() => m.configData.raw_material?.[0]), prods = safe(() => m.configData.product);
      if (!Array.isArray(raws) || !Array.isArray(prods) || raws.length < 2) continue;
      const cur = Number(m.selected_raw_material) || 0;
      let best = null;
      prods.forEach((p, i) => {
        const have = storageQty(s.ctrl, raws[i]);
        if (have === Infinity || have < maxR(m)) return;
        const gain = sellValue(p) - sellValue(raws[i]);
        if (!best || gain > best.gain) best = { i, gain, name: itemCfg(p)?.name || p };
      });
      if (best && best.i !== cur && best.gain > (sellValue(prods[cur]) - sellValue(raws[cur])) * 1.15)
        out.push({ machine: nameOf(m), now: itemCfg(prods[cur])?.name || prods[cur], best: best.name, gain: Math.round(best.gain) });
    }
    return out.slice(0, 6);
  }

  function brainReport(s) {
    const ranked = safe(() => rankSeeds(s)) || [];
    return {
      mode: cfg.seedMode || "agent",
      coinsPerHour: coinsPerHour(),
      goal: safe(() => goalReport(s)) || null,
      stock: safe(() => stockPlan(s, s.soils.length || 1).low) || [],
      machineTips: safe(() => machineTips(s)) || [],
      dry: safe(() => dryMachine()) || null,
      topWater: safe(() => rankSeeds(s, true).slice(0, 3).map((x) => ({ name: x.seed.name, rate: Math.round(x.rate) }))) || [],
      needs: safe(() => needsReport(s)) || null,
      stockTarget: stockTarget(),
      top: ranked.slice(0, 6).map((x) => ({
        name: x.seed.name, profit: Math.round(x.profit), hours: Math.round(x.hours * 10) / 10,
        realHours: Math.round(x.realHours * 10) / 10, rate: Math.round(x.rate)
      }))
    };
  }


  // ---------- goal: reach N coins — progress, ETA, what the farm earns, where to invest ----------
  const goalCoins = () => Number(cfg.goalCoins) || 100000000;

  // what one object earns per hour at full use (sell price of its product, minus what it eats)
  function hourlyOf(c, harvestNum = 1) {
    if (!c) return 0;
    const hours = Math.max(1 / 60, secsOf(c) / 3600);
    const product = [].concat(c.product || [])[0];
    const sell = Number(itemCfg(product)?.sell_for) || 0;
    const raws = [].concat(c.raw_material || []).flat().slice(0, 1);
    const feed = raws.reduce((a, id) => a + (Number(itemCfg(id)?.sell_for) || 0), 0); // its cost ≈ its sale value
    if (c.type === "seeds") return (sell * harvestNum - (Number(c.price) || 0)) / hours;
    return (sell - feed) / hours;
  }

  // everything you own, on every farm (from the game's own map data), not only what's on screen
  function inventory() {
    const all = safe(() => lm().AppData.allSceneMap) || {};
    const out = {};
    for (const [sceneId, list] of Object.entries(all)) {
      const scene = (out[sceneName(Number(sceneId))] = { plants: 0, trees: 0, animals: 0, machines: 0, other: 0, items: {} });
      for (const mo of list || []) {
        const c = itemCfg(mo.itemid ?? mo.id);
        const t = c?.type;
        if (t === "seeds") scene.plants++;
        else if (t === "trees") scene.trees++;
        else if (t === "animals") scene.animals++;
        else if (t === "buildings" && c.sub_type === "working") scene.machines++;
        else { scene.other++; continue; }
        if (c?.name) scene.items[c.name] = (scene.items[c.name] || 0) + 1;
      }
    }
    return out;
  }

  // estimated income/hour of the farm you're standing on, at full use
  function farmIncome(s) {
    let plants = 0, trees = 0, animals = 0, machines = 0;
    for (const p of s.plants) plants += hourlyOf(safe(() => p.configData), Number(safe(() => p.getHarvestNum())) || 1);
    for (const t of s.trees) trees += hourlyOf(safe(() => t.configData), Number(safe(() => t.getHarvestNum())) || 1);
    for (const a of s.animals) animals += hourlyOf(safe(() => a.configData));
    for (const m of s.machines) machines += hourlyOf(safe(() => m.configData));
    const best = safe(() => rankSeeds(s)[0]);
    const soilsPotential = best ? s.soils.length * best.rate : 0;
    return { plants, trees, animals, machines, total: plants + trees + animals + machines, soilsPotential };
  }

  // shop items (animals / machines / trees) you could buy with coins at your level, by payback time
  function investments(s) {
    const lvl = playerLevel();
    const cands = [];
    const consider = (c) => {
      if (!c || typeof c !== "object" || !c.name) return;
      if (!["animals", "buildings", "trees"].includes(c.type)) return;
      if (c.type === "buildings" && c.sub_type !== "working") return;
      if (c.buyable === false || c.map_object === false || c.rp_price || c.rc_price || c.cash_price) return;
      if (lvl && (Number(c.level) || 0) > lvl) return;
      const price = Number(c.price) || 0;
      if (!price) return;
      const perHour = hourlyOf(c);
      if (perHour <= 0) return;
      cands.push({ id: c.id, name: c.name, type: c.type, price, perHour, paybackH: price / perHour, level: Number(c.level) || 0 });
    };
    const store = safe(() => g.Config.Store);
    if (store && typeof store === "object") for (const k of safe(() => Object.keys(store)) || []) consider(safe(() => store[k]));
    const seen = new Set();
    return cands.filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => a.paybackH - b.paybackH).slice(0, 8);
  }

  function goalReport(s) {
    const c = coins(), goal = goalCoins(), rate = coinsPerHour();
    const left = Math.max(0, goal - c);
    const inc = safe(() => farmIncome(s)) || null;
    const etaH = rate && rate > 0 ? left / rate : null;
    return {
      goal, coins: c, left, pct: Math.min(100, (c / goal) * 100),
      ratePerHour: rate, etaHours: etaH, etaDays: etaH == null ? null : etaH / 24,
      income: inc && { total: Math.round(inc.total), plants: Math.round(inc.plants), trees: Math.round(inc.trees),
        animals: Math.round(inc.animals), machines: Math.round(inc.machines), soilsPotential: Math.round(inc.soilsPotential) },
      invest: safe(() => investments(s)) || [],
      inventory: safe(() => inventory()) || {}
    };
  }

  // ---------- stock: keep ≥ target of every product this farm can grow ----------
  // the player's stock target is the floor; the model may only raise it
  const stockTarget = () => {
    const user = Number(cfg.stock?.target) || 5000;
    const pb = Number(cfg.playbook && cfg.playbook.stockTarget);
    return pb > 0 ? Math.max(user, Math.min(20000, pb)) : user;
  };
  const stockShare = () => Math.min(0.8, Math.max(0, Number(cfg.stock?.share) ?? 0.3));
  const STOCK_HOURS = 72; // keep 3 days of every input: the farm must never stop for lack of one
  function stockPlan(s, soilCount, water = false) {
    const base = stockTarget();
    const consumed = consumedAll(s), orders = orderNeed();
    const targetOf = (prod) => Math.max(base, Math.ceil((consumed.get(prod) || 0) * STOCK_HOURS)) + (orders.get(prod) || 0);
    // inputs the farm eats a lot get more of the free soil
    const budget = Math.floor(soilCount * (consumed.size ? Math.max(stockShare(), 0.5) : stockShare()));
    const harvestNum = new Map();
    for (const p of s.plants) {
      const id = Number(safe(() => p.configData.id));
      if (id && !harvestNum.has(id)) harvestNum.set(id, Number(safe(() => p.getHarvestNum())) || 1);
    }
    const growing = new Map();
    for (const p of s.plants) {
      const prod = Number(safe(() => p.configData.product));
      if (prod) growing.set(prod, (growing.get(prod) || 0) + 1);
    }
    const byProduct = new Map();
    for (const c of seedsFor(s, water)) {
      const prod = Number(c.product);
      const cur = byProduct.get(prod);
      if (!cur || (Number(c.collect_in) || 0) < (Number(cur.collect_in) || 0)) byProduct.set(prod, c);
    }
    const low = [];
    for (const [prod, c] of byProduct) {
      const have = storageQty(s.ctrl, prod);
      const qty = have === Infinity ? 0 : have;
      const n = harvestNum.get(Number(c.id)) || 1;
      const coming = (growing.get(prod) || 0) * n;
      const target = targetOf(prod);
      const missing = target - qty - coming;
      // a crop nothing eats and no order wants is not stock: it's coins spent on seeds for nothing
      if (!consumed.has(prod) && !orders.has(prod)) continue;
      const used = consumed.get(prod) || 0;
      // about to run out: less than a day of use (or a small pile) in the barn and on the way
      const crit = used > 0 && qty + coming < Math.max(200, used * 24);
      if (missing > 0) low.push({ seed: c, prod, qty, target, missing, soils: Math.ceil(missing / n), used, crit, cover: used > 0 ? (qty + coming) / used : Infinity });
    }
    // what is about to run out first, then what the farm eats (fewest hours left), then the furthest below target
    low.sort((a, b) => (b.crit - a.crit) || (b.used > 0) - (a.used > 0) || (a.cover - b.cover) || b.missing / b.target - a.missing / a.target);
    const jobs = [];
    // inputs about to run out may take all the free soil; the normal share only limits the rest
    let left = soilCount, normal = budget;
    for (const x of low) {
      if (left <= 0) break;
      const take = Math.min(x.soils, left, x.crit ? left : normal);
      if (take <= 0) continue;
      jobs.push({ seed: x.seed, n: take, qty: x.qty, target: x.target, used: x.used, crit: x.crit });
      left -= take;
      if (!x.crit) normal -= take;
    }
    return { jobs, low: low.slice(0, 8).map((x) => ({ name: itemCfg(x.prod)?.name || x.seed.name, qty: x.qty, target: x.target, used: Math.round(x.used * 10) / 10 })) };
  }


  // ---------- orders, fertilizer: the levers the caps report confirmed ----------
  const feat = (k, def = true) => {
    if (cfg.features && cfg.features[k] === false) return false; // the player turned it off
    const pb = cfg.playbook;
    if (k === "fertilize" && pb && typeof pb.fertilize === "boolean") return pb.fertilize;
    if (pb && pb.features && typeof pb.features[k] === "boolean") return pb.features[k];
    return cfg.features && k in cfg.features ? !!cfg.features[k] : def;
  };
  // the AI's playbook (written once after it studied every farm), applied to the farm we're on
  const sameScene = (a, b) => {
    a = String(a || ""); b = String(b || "");
    return !!a && !!b && (a === b || a.includes(b.replace("المزرعة ", "")) || b.includes(a.replace("المزرعة ", "")));
  };
  const plan = () => {
    if (cfg.plan && typeof cfg.plan === "object") return cfg.plan;
    const pb = cfg.playbook;
    if (!pb || typeof pb !== "object") return null;
    const here = (pb.scenes || []).find((x) => sameScene(x.scene, sceneName(currentScene())));
    return { seedPlan: (here && here.seedPlan) || [], orderMinRatio: pb.orderMinRatio, sellReserve: pb.sellReserve, preferScene: null };
  };
  const orderRatio = () => Number(plan()?.orderMinRatio) || Number(cfg.orderMinRatio) || 1;
  const findSeedByName = (s, name) => {
    const n = String(name || "").trim();
    if (!n) return null;
    const list = buyableSeeds(s);
    return list.find((c) => c.name === n) || list.find((c) => c.name.includes(n) || n.includes(c.name)) || null;
  };
  const serverNow = () => Number(safe(() => g.ServerTime.timestamp)) || Math.floor(Date.now() / 1000);
  const sellValue = (id) => Number(itemCfg(id)?.sell_for) || 0;

  // may this many of an item leave the barn (orders) without hurting the farm?
  function canGive(s, id, n, consumed, crops) {
    id = Number(id);
    const qty = storageQty(s.ctrl, id);
    if (qty === Infinity || qty < n) return false;
    if (safe(() => lm().wareItemIsLocked(id))) return false;
    // inputs (eaten on any farm) keep a full day of use; possible inputs of a farm not measured yet keep
    // the stock target; anything else keeps a small reserve
    if (consumed.has(id)) return qty - n >= Math.max(30, Math.ceil(consumed.get(id) * STOCK_HOURS));
    if (maybeInput(id)) return qty - n >= stockTarget();
    return qty - n >= 30;
  }

  // ---- trade orders (NPC exchanges) ----
  async function tradeOrders(s, done) {
    if (!feat("orders")) return;
    const tc = findInstance("TradeOrderController");
    const model = tc && tc.tradeOrderModel;
    if (!tc || !model || !safe(() => model.opened())) return;
    const consumed = consumedAll(s), crops = cropIds(s);
    const now = serverNow();
    const orders = (safe(() => model.data) || []).filter((o) => o && o.hasData && Number(o.display_time || 0) <= now && safe(() => model.isEnough(o)));
    for (const o of orders) {
      if (stopped()) return;
      const cost = (o.exchange || []).reduce((a, x) => a + sellValue(x.itemId) * Number(x.num), 0);
      let coinsR = 0, itemsR = 0;
      for (const r of o.reward || []) {
        if (r.itemId === "coins") coinsR += Number(r.num) || 0;
        else if (r.itemId !== "exp") itemsR += sellValue(r.itemId) * (Number(r.num) || 0);
      }
      const value = coinsR + itemsR;
      const ok = (o.exchange || []).every((x) => canGive(s, x.itemId, Number(x.num), consumed, crops));
      if (!ok || value < cost * orderRatio()) continue;
      const what = (o.exchange || []).map((x) => `${itemCfg(x.itemId)?.name || x.itemId} ×${x.num}`).join("، ");
      step(`📦 طلب ${o.npc?.name || ""}: ${what} ← ${fmt(coinsR)} 🪙`, "orders");
      if (await tap(() => tc.onTradeOrder(o, false))) {
        add(done, "orders"); add(done, "earned", coinsR);
        decide(`📦 نفّذت طلب ${o.npc?.name || ""}: ${what} ← ${fmt(coinsR)} 🪙${itemsR ? ` + أصناف بـ ${fmt(itemsR)}` : ""} (قيمة اللي اتبعت ${fmt(cost)})`);
      }
      await sleep(jitter(800));
    }
  }

  // ---- market (ship) orders: coins per item + order points, vouchers when the whole board is done ----
  async function shipOrders(s, done) {
    if (!feat("shipOrders")) return;
    const model = safe(() => g.GF.shipOrderModel);
    const sc = findInstance("ShipOrderController");
    if (!model || !sc || !safe(() => model.isCanUse()) || safe(() => model.isFreezing())) return;
    const data = safe(() => model.shiporders.data) || [];
    const consumed = consumedAll(s), crops = cropIds(s);
    const todo = data.map((it, i) => ({ it, i })).filter(({ it }) => it && !it.finish && canGive(s, it.id, Number(it.num), consumed, crops));
    if (!todo.length) return;
    let opened = false;
    if (!safe(() => sc.shipOrderView.isInit())) { tryDo(() => sc.onOpen()); opened = true; await sleep(1500); }
    for (const { it, i } of todo) {
      if (stopped()) break;
      const name = itemCfg(it.id)?.name || it.id;
      step(`🚚 طلب السوق: ${name} ×${it.num} ← ${fmt(it.coins)} 🪙`, "orders");
      if (await tap(() => sc.onFinish(i, it, null, null, false))) {
        add(done, "orders"); add(done, "earned", Number(it.coins) || 0);
        decide(`🚚 سلّمت للسوق ${name} ×${it.num} ← ${fmt(it.coins)} 🪙`);
      }
      await sleep(jitter(700));
    }
    if (data.length && data.every((it) => it.finish) && !safe(() => model.shiporders.allfinish)) {
      if (tryDo(() => sc.onFinishAll())) decide("🚚 خلّصت لوحة السوق كلها — قبضت المكافأة");
    }
    if (opened) tryDo(() => sc.onClose());
  }

  // ---- social chores, each exactly what the game's own button does (read from the live game, 17 Oct) ----
  //  inbox every 5 min: InBoxView.onAccept = GF.inBoxModel.callServerAllAccept() ("accept and send all":
  //    takes the gifts, sends neighbors what they asked for, accepts help / neighbor invites)
  //  daily login gift: DailyRewardView's button = hideRewardPopup() (adds the gift, asks for tomorrow's)
  //  ask neighbors once a day for one item, alternating: SendWishVO.doSend = wishInfo.addUsers(uids) +
  //    GF.inBoxModel.callServerSendwish([{giftId, ids}]), 50 neighbors a batch (FriendsModel.MAX_REQUEST_NUM)
  const ASK_ITEMS = [200655, 9004]; // سياج أبيض، فطيرة فراولة
  let lastInboxAt = 0, lastAskDay = -1, lastDailyAt = 0;
  // daily login gift: the popup the game opens after a refresh
  function dailyGift(done) {
    const dc = findInstance("DailyRewardController"), dv = dc && dc.dailyRewardView;
    if (!(safe(() => lm().AppData.daily_gift) && dv && safe(() => dv.stage) && Date.now() - lastDailyAt > 60000)) return false;
    lastDailyAt = Date.now();
    if (!tryDo(() => dv.hideRewardPopup())) return false;
    safe(() => dc.onClose());
    add(done, "social");
    decide("🎁 خدت هدية تسجيل الدخول اليومي");
    post();
    return true;
  }
  // right after a (daily 08:00) reload: take the gift even if the bot is paused or resting now (first 5 min)
  const giftTimer = setInterval(() => {
    if (disposed || performance.now() > 5 * 60000) return clearInterval(giftTimer);
    if (feat("social") && safe(() => g.IGDataManager.isIG) && stage() && !busy && dailyGift(emptyTotals())) clearInterval(giftTimer);
  }, 10000);
  async function socialChores(done) {
    if (!feat("social") || !safe(() => g.IGDataManager.isIG)) return;
    const ib = safe(() => g.GF.inBoxModel);
    // 1) daily login gift
    dailyGift(done);
    if (!ib || typeof ib.callServerAllAccept !== "function") return;
    // 2) inbox
    if (Date.now() - lastInboxAt >= 5 * 60000) {
      lastInboxAt = Date.now();
      safe(() => ib.callServerBoxlists(0));
      await sleep(4000); // the list comes back from the server
      const n = (k) => (Array.isArray(ib[k]) ? ib[k].length : 0);
      const gifts = n("gifts"), wishes = n("wishes"), assists = n("assists"), invites = n("communityInvites");
      if (gifts + wishes + assists + invites > 0 && !stopped()) {
        step(`📬 البريد: بيقبل ويبعت الكل`, "social");
        try {
          await ib.callServerAllAccept();
          add(done, "social", gifts + wishes + assists + invites);
          decide(`📬 البريد: قبلت ${gifts} هدية وبعت ${wishes} طلب للجيران` + (assists ? ` وقبلت ${assists} مساعدة` : "") + (invites ? ` و${invites} دعوة جار` : ""));
        } catch (e) { warn("البريد: " + String(e && e.message).slice(0, 60)); }
      }
    }
    // 3) ask the neighbors for today's item (once a day; the game's history says who was asked today)
    const day = Math.floor(serverNow() / 86400);
    const wi = safe(() => g.GF.friendsController.wishInfo), fm = safe(() => g.GF.friendsController.model);
    if (day !== lastAskDay && wi && fm && typeof ib.callServerSendwish === "function" && lastInboxAt) {
      const askedToday = new Set((safe(() => wi.getUserIdList()) || []).map(String));
      const items = (Array.isArray(cfg.askItems) && cfg.askItems.length ? cfg.askItems : ASK_ITEMS).map(Number).filter(Boolean);
      const item = itemCfg(items[day % items.length]);
      if (item) {
        const me = String(safe(() => lm().AppData.uid) || "");
        // every neighbor, active or not; whoever a stopped round missed gets it on the next one
        const pool = [...(safe(() => fm.allNeighbors) || []), ...(safe(() => fm.activeNeighbors) || [])];
        const uids = [...new Set(pool.map((u) => String(safe(() => u.uid) || "")))].filter((u) => u && u !== me && !askedToday.has(u));
        if (!uids.length) lastAskDay = day;
        let sent = 0;
        for (let i = 0; i < uids.length && !stopped(); i += 50) {
          const batch = uids.slice(i, i + 50);
          if (!tryDo(() => { wi.addUsers(batch); ib.callServerSendwish([{ giftId: Number(item.id), ids: batch }]); })) break;
          sent += batch.length;
          if (sent === uids.length) lastAskDay = day;
          await sleep(jitter(1500));
        }
        if (sent) { add(done, "social"); decide(`🙏 طلبت ${item.name} من ${sent} جار (بكرة ${itemCfg(items[(day + 1) % items.length])?.name || ""})`); }
      }
    }
  }

  // ---- time-limited events, free parts only (read from the live game, 17 Oct) ----
  //  golden egg goose: GF.gooseController.feed(food, qty) every feed_goose_cooldown (30 min) with the golden
  //    food already in the gift box (auto mode costs OP: never), then smashEgg(egg, qty) for score rewards
  //  autumn event: today's sign-in is free (HalloweenEvent {action:"signIn", date: todayDate, rc:0});
  //    any other day costs RC, so only today's
  async function eventChores(done) {
    if (!feat("events")) return;
    const gifts = () => safe(() => lm().AppData.gifts) || {};
    const gc = safe(() => g.GF.gooseController), gm = gc && (gc.gooseModel || gc.model);
    if (gc && gm && typeof gc.feed === "function" && !gm.auto && safe(() => gm.getFeedState()) === 1) {
      const food = Number(gm.food_id), have = Number(gifts()[food]) || 0;
      const qty = Math.min(Number(gm.each_feed_max) || 8, have);
      if (qty >= (Number(gm.each_feed_min) || 3) && safe(() => gc.feed(food, qty)) === true) {
        add(done, "events");
        decide(`🪿 أكّلت الوزة الذهبية ${qty} (فاضل ${fmt(have - qty)})`);
        await sleep(4000); // the eggs come back from the server
      }
    }
    if (gc && gm && typeof gc.smashEgg === "function") {
      for (const egg of [].concat(gm.golden_egg || [])) {
        const n = Number(gifts()[Number(egg)]) || 0;
        if (n > 0 && !stopped() && tryDo(() => gc.smashEgg(Number(egg), n, () => {}))) {
          add(done, "events");
          decide(`🥚 كسرت ${n} بيضة ذهبية (${itemCfg(egg)?.name || egg})`);
          await sleep(2500);
        }
      }
    }
    const hc = safe(() => g.GF.halloweenEvent2020Controller), hm = hc && hc.selfModel;
    if (hm && hm.data && hm.data.signIn && !safe(() => hm.isEnd)) {
      const today = Number(hm.todayDate);
      const e = (safe(() => hm.getSignInData()) || []).find((x) => Number(x.date) === today);
      if (e && !e.rewardTime && tryDo(() => {
        g.NetUtils.enqueue(g.HttpConst.HalloweenEvent, { action: "signIn", date: today, rc: 0 });
        hm.data.signIn[today] = g.ServerTime.serverDateTime;
        lm().addGift(e.rewardId, e.rewardQty);
      })) {
        add(done, "events");
        decide(`🎃 سجّلت دخول حدث الخريف النهارده (${itemCfg(e.rewardId)?.name || e.rewardId} ×${e.rewardQty})`);
      }
    }
  }

  // ---- gift box: coin gifts (type giftcoin) -> coins, like GiftBoxModel.onUseAllCoins (the game's button) ----
  let lastGiftAt = 0;
  async function claimGiftCoins(done) {
    if (!feat("giftCoins") || Date.now() - lastGiftAt < 3600000) return;
    const gm = safe(() => g.GF.giftBoxModel);
    const gifts = safe(() => lm().AppData.gifts) || {};
    if (!gm || typeof gm.onUseAllCoins !== "function") return;
    if (safe(() => findInstance("GiftBoxController").giftBoxView.stage)) return; // the player has the box open: try again next cycle
    lastGiftAt = Date.now();
    const locked = new Set([].concat(safe(() => lm().AppData.lockedGifts) || []).map(Number));
    const list = Object.keys(gifts).map(Number).filter((id) => Number(gifts[id]) > 0 && !locked.has(id))
      .map((id) => itemCfg(id)).filter((c) => c && c.type === "giftcoin" && Number(c.coinNum) > 0);
    if (!list.length) return;
    const total = list.reduce((a, c) => a + Number(gifts[c.id]) * Number(c.coinNum), 0);
    step(`🎁 بيصرف هدايا العملات (+${fmt(total)} 🪙)`, "gifts");
    if (await tap(() => gm.onUseAllCoins(list))) {
      add(done, "earned", total);
      decide(`🎁 صرفت هدايا العملات من صندوق الهدايا: +${fmt(total)} 🪙`);
    }
  }

  // ---- multi-product machines: pick the product the farm needs (same call as the game's material picker) ----
  // SelectMaterialController.changeMaterial: m.setRawMaterial(i) + SAVE_SELECTED_RAW_MATERIAL_C2S(m, i).
  // Only when the new raw is in the barn (the picker's own rule), and at most once per 3 h per machine.
  const switchedAt = new Map();
  function machineChoice(s, m, consumed, claimed) {
    if (typeof m.setRawMaterial !== "function") return null; // not a switchable machine in this game version
    const c = safe(() => m.configData) || {};
    const rm = c.raw_material, prods = [].concat(c.product || []);
    if (!Array.isArray(rm) || !Array.isArray(rm[0]) || rm[0].length < 2 || prods.length < 2) return null;
    const fixed = rm.slice(1).map((l) => [].concat(l)[0]).filter(Boolean); // other ports: same input for every product
    const have = (id) => { const q = storageQty(s.ctrl, id); return q === Infinity ? 0 : q; };
    if (fixed.some((id) => have(id) <= 0)) return null; // the other ports are empty anyway
    const cur = Number(m.selected_raw_material) || 0;
    const need = Math.max(1, maxR(m)) * 3;
    const score = (i) => {
      const raw = Number(rm[0][i]), prod = Number(prods[i]);
      if (!raw || !prod) return -Infinity;
      // the variable input must be spare: a few refills on top of what other machines eat in a day
      const spare = have(raw) - Math.ceil((consumed.get(raw) || 0) * STOCK_HOURS * (i === cur ? 0 : 1));
      if (spare < need) return -Infinity;
      let v = sellValue(prod) - sellValue(raw) - fixed.reduce((a, id) => a + sellValue(id), 0);
      // a product other machines are waiting for (eaten and short) beats any sale margin
      if (consumed.has(prod) && have(prod) < Math.ceil(consumed.get(prod) * STOCK_HOURS)) v += 100000;
      // the model's choice for this machine comes next
      const want = (safe(() => cfg.playbook.machineProducts) || []).find((x) => x && x.machine === nameOf(m));
      if (want && (itemCfg(prod)?.name || "") === want.product) v += 50000;
      return v;
    };
    const curScore = score(cur);
    let best = cur, bestScore = curScore;
    for (let i = 0; i < Math.min(rm[0].length, prods.length); i++) {
      if (claimed && (claimed.has("p" + prods[i]) || claimed.has("r" + rm[0][i])) && i !== cur) continue; // taken this pass
      const v = score(i);
      if (v > bestScore) { best = i; bestScore = v; }
    }
    if (best === cur || bestScore === -Infinity) return null;
    // switch when the current product can't run, feeds a short input, or pays clearly more (absolute margin, sign-safe)
    if (curScore !== -Infinity && bestScore < 50000 && bestScore - curScore < Math.max(5, Math.abs(curScore) * 0.15)) return null;
    return { i: best, from: cur, raw: Number(rm[0][best]), prod: Number(prods[best]), name: itemCfg(prods[best])?.name || prods[best], fromName: itemCfg(prods[cur])?.name || prods[cur], short: bestScore >= 100000, byModel: bestScore >= 50000 && bestScore < 100000 };
  }
  async function switchMachines(s, done) {
    if (!feat("machineSwitch")) return;
    // never switch while taps are still queued: a queued refill would load the old input under the new product
    if (queueLen() > 0) await drain(() => true, 8000);
    if (queueLen() > 0) return;
    const consumed = consumedAll(s);
    const claimed = new Set(); // one switch per input / product per pass (they share one barn snapshot)
    for (const m of s.machines) {
      if (stopped()) return;
      const key = workKey(m);
      if (Date.now() - (switchedAt.get(key) || 0) < 3 * 3600000) continue;
      if (Object.values(safe(() => m.processCount) || {}).some((v) => Number(v) > 0)) continue; // taps in flight on it
      const ch = safe(() => machineChoice(s, m, consumed, claimed));
      if (!ch) continue;
      claimed.add("p" + ch.prod); claimed.add("r" + ch.raw);
      step(`🔁 بيغيّر ${nameOf(m)}: ${ch.fromName} ← ${ch.name}`, "machines");
      const okSw = await tap(() => {
        m.setRawMaterial(ch.i);
        g.App.ControllerManager.applyFunc(g.ControllerConst.Login, g.LoginConst.SAVE_SELECTED_RAW_MATERIAL_C2S, m, ch.i);
      });
      if (okSw) {
        switchedAt.set(key, Date.now());
        decide(`🔁 غيّرت ${nameOf(m)} من ${ch.fromName} لـ ${ch.name}${ch.short ? " (مكن تانية مستنياه)" : ch.byModel ? " (حسب كتيّب الـ AI)" : " (أربح)"}`);
      }
    }
  }

  // ---- fertilizer / watering with the tools lying on the farm ----
  async function fertilize(s, done) {
    if (!feat("fertilize")) return;
    const ferts = (s.tools || []).filter((t) => cls(t) === "Fertilizer" && Number(t.uses_left) > 0);
    const kettles = (s.tools || []).filter((t) => cls(t) === "Kettle" && Number(t.uses_left) > 0);
    if (!ferts.length && !kettles.length) return;
    const value = (p) => sellValue(safe(() => p.configData.product)) * (Number(safe(() => p.getHarvestNum())) || 1);
    let used = 0;
    if (ferts.length) {
      const plants = s.plants.filter((p) => safe(() => p.can_be_fertilized())).sort((a, b) => value(b) - value(a));
      for (const p of plants) {
        if (stopped()) break;
        const need = Number(safe(() => p.getFertilizerUseNum())) || 1;
        const f = ferts.filter((t) => Number(t.uses_left) >= need && safe(() => t.can_use(need)) !== false)
          .sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0))[0];
        if (!f) break;
        step(`🧪 بيسمّد ${nameOf(p)} (${f.isDouble ? "مضاعف" : "تسريع"} — باقي ${f.uses_left})`, "fertilize");
        if (await tap(() => s.ctrl.fertilizer(f, p))) { add(done, "fertilized"); used++; }
      }
    }
    if (kettles.length) {
      const trees = s.trees.filter((t) => safe(() => t.can_be_fertilized())).sort((a, b) => value(b) - value(a));
      for (const t of trees) {
        if (stopped()) break;
        const k = kettles.filter((x) => Number(x.uses_left) > 0).sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0))[0];
        if (!k) break;
        step(`💧 بيروي ${nameOf(t)} (باقي ${k.uses_left})`, "fertilize");
        if (await tap(() => s.ctrl.water(k, t))) { add(done, "fertilized"); used++; }
      }
    }
    if (used) {
      await drain(() => true, 4000);
      decide(`🧪 استخدمت السماد/الري ${used} مرة على أغلى الزرع والشجر`);
      // a used-up tool opens the game's "get more fertilizer" dialog — close it
      const shop = findInstance("ShopController");
      safe(() => shop.onCloseUseFertilizer());
    }
  }

  // ---------- farms board: remember what every farm has and when it's due, go where the work is ----------
  const sceneBoard = {}; // sceneId -> summary of the last visit
  let sceneEnteredAt = Date.now();
  function summarizeScene(s) {
    const now = serverNow();
    let next = Infinity;
    // events: { t: server seconds when it's ready, v: coins it brings, live: animal / machine
    // (those stop producing while they wait, crops just sit) }
    const events = [];
    const firstProduct = (o) => [].concat(safe(() => o.configData.product) || [])[0];
    const event = (t, v, live) => {
      if (!(t > 0)) return;
      events.push({ t, v: Math.max(1, Math.round(v)), live });
      if (t > now && t < next) next = t;
    };
    for (const p of s.plants) if (!ready(p)) {
      const c = safe(() => p.configData) || {};
      event(Number(p.start_time) + (Number(p.collect_in) || secsOf(c)), sellValue(c.product) * (Number(safe(() => p.getHarvestNum())) || 1), false);
    }
    for (const t of s.trees) if (!ready(t)) {
      const c = safe(() => t.configData) || {};
      event(Number(t.start_time) + (secsOf(c) || Number(t.collect_in) || 0), sellValue(firstProduct(t)) * (Number(safe(() => t.getHarvestNum())) || 1), false);
    }
    for (const o of [...s.animals, ...s.machines]) {
      const isM = cls(o) === "Machine";
      const fed = isM ? slotsOf(o, true).some((sl) => sl.read() > 0) : getR(o) > 0;
      if (!o.is_working && !fed) continue; // idle and empty: nothing will come out of it
      const secs = objSecs(o) || 3600;
      let since = workLog.get(workKey(o));
      // never saw it start, or our guess passed with nothing to collect: assume it just started
      // (worst case: we come back at most one production late, never "ready" forever)
      if (since == null || (since + secs <= now && getP(o) === 0)) { since = now; workLog.set(workKey(o), now); }
      const t = since + secs;
      const prod = isM ? [].concat(safe(() => o.configData.product) || [])[Number(o.selected_raw_material) || 0] : firstProduct(o);
      event(t <= now ? now + 1 : t, sellValue(prod) * Math.max(1, Number(o.max_products) || 3), true);
    }
    const products = [...s.animals, ...s.machines].reduce((n, o) => n + getP(o), 0);
    // "hungry" = something the bot can really do: products to collect, or an empty slot whose food is in the barn
    const canServe = (o) => {
      const m = cls(o) === "Machine";
      return toCollect(o) > 0 || slotsOf(o, m).some((sl) => sl.food && toFill(o, m, sl) > 0 && storageQty(s.ctrl, sl.food) > 0);
    };
    const hungry = [...s.animals, ...s.machines].filter(canServe).length;
    return {
      id: currentScene(), name: sceneName(currentScene()), visitedAt: Date.now(),
      readyNow: s.readyPlants.length + s.readyTrees.length + products, hungry, soils: s.soils.length,
      plants: s.plants.length, trees: s.trees.length, animals: s.animals.length, machines: s.machines.length,
      nextReadyAt: next === Infinity ? null : next,
      events: events.filter((e) => e.t > now).sort((a, b) => a.t - b.t).slice(0, 80),
      income: Math.round(safe(() => farmIncome(s).total) || 0)
    };
  }
  // what a farm has waiting by time t: animals / machines count double (every minute they wait
  // they don't produce), crops count their sale value
  const valueBy = (b, t) => (b && b.events ? b.events.reduce((n, e) => n + (e.t <= t ? e.v * (e.live ? 2 : 1) : 0), 0) : 0);
  let lastMemSent = 0;
  function sendFarmMemory() {
    if (Date.now() - lastMemSent < 120000) return;
    lastMemSent = Date.now();
    const maps = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Map ? [...v] : v instanceof Set ? [...v] : v]));
    send("farmMemory", { memory: JSON.parse(JSON.stringify({ at: Date.now(), sceneKnow, sceneBoard, visitLog, sceneUse: maps(sceneUse), sceneInputs: maps(sceneInputs) })) });
  }
  function recordScene(s) {
    const sum = summarizeScene(s);
    sceneBoard[sum.id] = sum;
    later(sendFarmMemory, 50);
    safe(() => { sceneKnow[sum.id] = snapshotScene(s); });
    status.know = safe(() => knowStatus()) || status.know;
    const owned = ownedScenes();
    status.scenes = owned.map((id) => ({ ...(sceneBoard[id] || { id, name: sceneName(id), visitedAt: 0 }), current: id === sum.id }));
    status.sceneNote = owned.length < 2 ? "اللعبة مبلّغة عن مزرعة واحدة بس — لو عندك مزارع تانية ابعتلي تقرير الإمكانيات" : "";
    return sum;
  }

  async function maybeSwitchScene(cur) {
    if (!cfg.scenes || !cfg.scenes.on) return false;
    const list = ownedScenes();
    if (list.length < 2) return false;
    const now = Date.now(), curId = currentScene();
    const dwellMin = (now - sceneEnteredAt) / 60000;
    const tNow = serverNow();
    // The board is written right after a full cycle, so whatever is still "ready / empty / hungry" there
    // is what the bot could NOT do (no seeds, coins, food, full dryer). Only real upcoming work counts:
    // something that matures here soon, or work the bot can do (feedable / collectable).
    const curNext = cur && cur.nextReadyAt ? cur.nextReadyAt : Infinity;
    const curSoonValue = cur ? valueBy(cur, tNow + 120) : 0;
    const curSoon = !!cur && (cur.hungry > 0 || curSoonValue > 0);
    const minMin = Number(cfg.playbook && cfg.playbook.sceneMinMin) || Number(cfg.scenes.minMin) || 3;
    const minDwell = curSoon ? minMin : Math.min(0.5, minMin);
    if (dwellMin < minDwell) return false;
    const others = list.filter((id) => id !== curId);
    let target = null, why = "";
    const pref = plan()?.preferScene;
    if (pref) {
      const want = others.find((id) => sceneName(id) === pref || sceneName(id).includes(String(pref)) || String(pref).includes(sceneName(id).replace("المزرعة ", "")));
      if (want != null && (!sceneBoard[want] || now - sceneBoard[want].visitedAt > 30 * 60000)) { target = want; why = "خطة الـ AI بتفضّلها"; }
    }
    const unvisited = others.filter((id) => !sceneBoard[id]);
    const boards = others.map((id) => sceneBoard[id]).filter(Boolean);
    if (target != null) { /* plan decided */ }
    else if (unvisited.length) { target = unvisited[0]; why = "لسه ماشفتهاش"; }
    else {
      // money waiting right now on every other farm (live = animals / machines that stopped)
      const waiting = boards.map((b) => ({ b, v: valueBy(b, tNow) + (b.hungry > 0 ? 1 : 0) }))
        .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
      const best = waiting[0];
      // leave a busy farm only for clearly more money (or after staying too long)
      if (best && (!curSoon || best.v > curSoonValue * 1.5 || dwellMin > (Number(cfg.scenes.maxMin) || 20))) {
        target = best.b.id;
        const liveReady = (best.b.events || []).filter((e) => e.live && e.t <= tNow).length;
        why = liveReady ? `فيها ${liveReady} مكنة/حيوان خلّصوا (~${fmt(best.v)} 🪙 مستنية)` : best.b.hungry ? `فيها ${best.b.hungry} محتاجين أكل أو جمع` : `فيها حاجات جهزت (~${fmt(best.v)} 🪙)`;
      } else if (!curSoon) {
        // nothing ready anywhere: wait where the next money comes first (machines / animals included)
        const soonest = boards.filter((b) => b.nextReadyAt).sort((a, b) => a.nextReadyAt - b.nextReadyAt)[0];
        if (soonest && soonest.nextReadyAt < curNext - 60) {
          target = soonest.id;
          why = `هنا مفيش شغل، وهناك هيجهز بعد ${Math.max(1, Math.round((soonest.nextReadyAt - tNow) / 60))} د`;
        }
        const stale = target == null ? boards.sort((a, b) => a.visitedAt - b.visitedAt)[0] : null;
        if (stale && now - stale.visitedAt > 30 * 60000) { target = stale.id; why = "أتأكد منها (آخر زيارة من أكتر من نص ساعة)"; }
      }
    }
    if (target == null) return false;
    // never leave a farm with taps the server hasn't got yet (they would be lost)
    if (!(await waitSaved())) {
      warn(`اللعبة ماحفظتش آخر شغل على السيرفر (آخر رد ${saves.lastStatus ?? "مفيش"}) — مش هنقل لـ ${sceneName(target)} دلوقتي`);
      decide(`💾 أجّلت النقل لـ ${sceneName(target)} لحد ما اللعبة تحفظ`);
      return false;
    }
    step(`🚜 بينقل لـ ${sceneName(target)} — ${why}`, "scene");
    const soc = findInstance("SceneOperationController");
    let sent = false;
    if (soc && typeof soc.onSceneEnter === "function") sent = tryDo(() => soc.onSceneEnter(target));
    if (!sent) sent = tryDo(() => g.App.ControllerManager.applyFunc(g.ControllerConst.Login, g.LoginConst.LOAD_FARM_C2S, g.App.Platform.snsID(), target));
    if (!sent) { decide(`🚜 ماقدرتش أنقل لـ ${sceneName(target)} — اللعبة مش مستجيبة للنقل`); return false; }
    for (let t = 0; t < 90; t++) {
      await sleep(1000);
      if (currentScene() === target && !safe(() => lm().isChangeSceneing) && scan()?.ctrl) {
        await sleep(3000); // let the new farm finish drawing
        hookedCtrl = null;
        sceneEnteredAt = Date.now();
        (visitLog[target] = visitLog[target] || []).push(sceneEnteredAt);
        if (visitLog[target].length > 8) visitLog[target].shift();
        decide(`🚜 نقلت لـ ${sceneName(target)} — ${why}`);
        return true;
      }
    }
    warn(`النقل لـ ${sceneName(target)} خد وقت طويل`);
    decide(`🚜 حاولت أنقل لـ ${sceneName(target)} بس اللعبة ما غيّرتش المزرعة`);
    return true;
  }

  // ---------- knowledge for training the AI ----------
  // On every visit the agent writes down what that farm has and what everything costs and pays.
  // When every farm was seen, the AI studies it once and writes a playbook the agent then follows alone.
  const sceneKnow = {}; // sceneId -> snapshot of the last visit
  const nm = (id) => itemCfg(id)?.name || String(id);
  const fin = (q) => (q === Infinity || q == null ? null : Number(q));
  const mins = (c) => Math.round(secsOf(c) / 60);
  function snapshotScene(s) {
    const group = (list, make) => {
      const m = new Map();
      for (const o of list) {
        const c = safe(() => o.configData);
        if (!c) continue;
        const k = c.name || c.id;
        const e = m.get(k) || make(o, c);
        e.count = (e.count || 0) + 1;
        m.set(k, e);
      }
      return [...m.values()];
    };
    const seeds = (water) => (safe(() => rankSeeds(s, water)) || []).slice(0, 12).map((x) => ({
      seed: x.seed.name, price: Number(x.seed.price) || 0, sell: x.sell, perHarvest: x.n, hours: Math.round(x.hours * 100) / 100,
      profit: Math.round(x.profit), perHour: Math.round(x.rate), level: Number(x.seed.level) || 0 }));
    const recipes = (c) => {
      const rm = c.raw_material, prods = [].concat(c.product || []);
      const ports = Array.isArray(rm) && Array.isArray(rm[0]) ? rm : [[].concat(rm == null ? [] : rm)];
      return prods.map((pr, i) => ({
        product: nm(pr), sell: sellValue(pr), have: fin(storageQty(s.ctrl, pr)),
        needs: ports.map((l) => { const a = [].concat(l); return Number(a[i] ?? a[0]); }).filter(Boolean)
          .map((r) => ({ item: nm(r), sell: sellValue(r), have: fin(storageQty(s.ctrl, r)) }))
      }));
    };
    const use = safe(() => consumptionPerHour(s)) || new Map();
    const waterPlant = (p) => isWaterSeed(safe(() => p.configData) || {});
    const first = (v) => [].concat(v)[0];
    return {
      name: sceneName(currentScene()), seenAt: new Date().toISOString(),
      soil: { land: s.soils.filter((o) => !isWaterSoil(o)).length + s.plants.filter((p) => !waterPlant(p)).length,
        water: s.soils.filter(isWaterSoil).length + s.plants.filter(waterPlant).length, free: s.soils.length },
      growing: group(s.plants, (o, c) => ({ seed: c.name })),
      landSeeds: seeds(false), waterSeeds: seeds(true),
      animals: group(s.animals, (o, c) => ({ name: c.name, minutes: mins(c), food: nm(c.raw_material), foodHave: fin(storageQty(s.ctrl, c.raw_material)),
        product: nm(first(c.product)), sell: sellValue(first(c.product)) })),
      machines: group(s.machines, (o, c) => ({ name: c.name, minutes: mins(c), ports: portCount(o),
        making: nm([].concat(c.product || [])[Number(o.selected_raw_material) || 0]), recipes: recipes(c).slice(0, 8) })),
      trees: group(s.trees, (o, c) => ({ name: c.name, product: nm(first(c.product)), sell: sellValue(first(c.product)), hours: Math.round(secsOf(c) / 360) / 10 })),
      // by game ids, for planting on the OTHER farms (they share the barn): what each consumer here eats,
      // the recipes of the machines here, and the use per hour
      needIds: [...usefulAnimals(s).map((a) => [Number(safe(() => a.configData.raw_material)) || 0, maxR(a) * BUFFER_FILLS, nameOf(a)]),
        ...s.machines.flatMap((m) => slotsOf(m, true).map((sl) => [Number(sl.food) || 0, maxR(m) * BUFFER_FILLS, nameOf(m)]))].filter((x) => x[0]),
      recipeIds: [...machineRecipes(s.machines).entries()].map(([pr, r]) => [pr, r.raws]),
      useIds: [...use.entries()].map(([id, n]) => [id, Math.round(n * 100) / 100]),
      valueIds: [...(safe(() => valuePerHour(s)) || new Map()).entries()].map(([id, v]) => [id, Math.round(v)]),
      eatsPerHour: [...use.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([id, n]) => ({ item: nm(id), perHour: Math.round(n * 10) / 10, have: fin(storageQty(s.ctrl, id)) })),
      income: safe(() => goalReport(s).income) || null
    };
  }
  function knowStatus() {
    const owned = ownedScenes();
    const missing = owned.filter((id) => !sceneKnow[id]).map(sceneName);
    const kinds = new Set();
    for (const k of Object.values(sceneKnow)) for (const list of [k.machines, k.animals, k.trees]) for (const x of list || []) kinds.add(x.name);
    const seedNames = new Set();
    for (const k of Object.values(sceneKnow)) for (const x of [...(k.landSeeds || []), ...(k.waterSeeds || [])]) seedNames.add(x.seed);
    // changes only when the game really changes: level, farms, new kinds of machines / animals / trees, new seeds
    const fp = [playerLevel(), owned.join(","), [...kinds].sort().join(","), [...seedNames].sort().join(",")].join("|");
    let h = 0;
    for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) | 0;
    return { complete: owned.length > 0 && !missing.length, missing, seen: owned.length - missing.length, of: owned.length, fp: String(h >>> 0) };
  }
  function knowledge() {
    const s = scan();
    if (s && s.ctrl) safe(() => recordScene(s));
    const storage = safe(() => lm().AppData.storage) || {};
    const barn = Object.entries(storage).map(([id, q]) => ({ item: nm(id), qty: Number(q) || 0, sell: sellValue(id) }))
      .filter((x) => x.qty > 0).sort((a, b) => b.qty * b.sell - a.qty * a.sell).slice(0, 60);
    const goal = s ? safe(() => goalReport(s)) : null;
    return {
      know: knowStatus(),
      player: { level: playerLevel(), coins: coins(), op: Number(safe(() => lm().AppData.op)) || null, coinsPerHour: Math.round(coinsPerHour() || 0) || null,
        goal: goalCoins(), workHours: cfg.rest && cfg.rest.on ? `${cfg.rest.from}-${cfg.rest.to}` : "24h" },
      farms: ownedScenes().map((id) => sceneKnow[id] || { name: sceneName(id), notSeenYet: true }),
      barn,
      dryer: safe(() => dryMachine()) || null,
      investments: ((goal && goal.invest) || []).map((x) => ({ name: x.name, type: x.type, price: x.price, perHour: Math.round(x.perHour), paybackHours: Math.round(x.paybackH) })),
      settings: { stockTarget: stockTarget(), sellReserve: Number(cfg.sell?.reserve) || 0, orderMinRatio: Number(cfg.orderMinRatio) || 1 },
      recentDecisions: (status.decisions || []).slice(0, 10).map((d) => d.text),
      warnings: status.warnings || [],
      // things only the player can do: better product on a machine, machines idle for lack of an input
      machineSwitches: s ? (safe(() => machineTips(s)) || []).reduce((acc, t) => {
        const k = t.machine + "→" + t.best;
        const e = acc.find((x) => x.key === k);
        if (e) e.count++; else acc.push({ key: k, machine: t.machine, now: t.now, better: t.best, extraPerProduct: t.gain, count: 1 });
        return acc;
      }, []).map(({ key, ...x }) => x) : [],
      idleNoInput: (status.warnings || []).filter((w) => /^مفيش خامات لـ /.test(w)).map((w) => w.replace(/^مفيش خامات لـ /, "")),
      revisitHoursHere: Math.round(revisitHours() * 100) / 100,
      fertilizerTools: s ? (s.tools || []).filter((t) => cls(t) === "Fertilizer" && Number(t.uses_left) > 0).length : 0,
      totals: status.totals
    };
  }

  // ---------- needs: construction materials + inputs the barn is short of ----------
  function needsReport(s) {
    const construction = [];
    for (const o of safe(() => g.GameGridData.moList) || []) {
      if (!safe(() => o.is_under_construction())) continue;
      const mats = safe(() => o.configData.materials) || [];
      const have = safe(() => o.obtained_materials) || {};
      const missing = mats.map((m) => ({ name: itemCfg(m.id)?.name || m.id, need: Number(m.qty) - (Number(have[m.id]) || 0) })).filter((m) => m.need > 0);
      if (missing.length) construction.push({ name: nameOf(o), missing });
    }
    return { construction: construction.slice(0, 8) };
  }

  const describePlan = (p) =>
    p.plan.map((x) => `${x.seed.name} ×${x.n} (لـ ${x.for.slice(0, 2).join("، ")})`).join(" • ");

  const seedConfig = (id, plants) => {
    if (!id) {
      const counts = new Map();
      for (const p of plants) {
        const c = safe(() => p.configData);
        if (c) counts.set(c, (counts.get(c) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    return safe(() => g.Config.Store_GetItemData(Number(id))) ||
      plants.map((p) => safe(() => p.configData)).find((c) => c && String(c.id) === String(id)) ||
      allSeeds([]).find((c) => String(c.id) === String(id));
  };

  async function plantAll(s, done, picked) {
    if (!s.soils.length) return;
    // rows top-to-bottom, left-to-right: each job takes the next run of neighbouring plots, so one seed = one block
    const tidy = (list) => list.slice().sort((a, b) => (Math.round(a.y / 8) - Math.round(b.y / 8)) || (a.x - b.x));
    const pools = [
      { water: false, soils: tidy(s.soils.filter((o) => !isWaterSoil(o))) },
      { water: true, soils: tidy(s.soils.filter((o) => isWaterSoil(o))) }
    ].filter((p) => p.soils.length);
    for (const pool of pools) {
      if (stopped()) return;
      await plantPool({ ...s, soils: pool.soils }, done, picked, pool.water);
    }
  }

  async function plantPool(s, done, picked, water) {
    const mode = cfg.seedMode || "agent";
    const label = water ? "مائية" : "عادية";
    const fits = (c) => c && isWaterSeed(c) === !!water;
    let fallback = picked
      ? safe(() => g.Config.Store_GetItemData(Number(picked.id))) || picked
      : seedConfig(cfg.seedId, s.plants);
    if (fallback && !plantable(fallback)) {
      if (picked || mode === "manual") warn(`"${fallback.name}" مقفولة أو مش للبيع بالكوينز (محتاجة فتح بالدنانير/شرط) — مش هتتزرع`);
      fallback = null;
    }
    if (fallback && !fits(fallback)) {
      if (picked || mode === "manual") warn(`"${fallback.name}" ${isWaterSeed(fallback) ? "بذرة مائية" : "بذرة عادية"} — مش هتتزرع في الأرض ال${label}`);
      fallback = null;
    }
    const cheapest = () => safe(() => seedsFor(s, water).filter(plantable).sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0]);
    const jobs = [];
    if (!picked && mode !== "manual") {
      const p = smartPlan(s, s.soils.length, water);
      if (p.plan.length) {
        step(`🧠 هزرع (${label}): ${describePlan(p)}`, "plant");
        decide(`🌱 للمكن والحيوانات (${label}): ${describePlan(p)}`);
      }
      for (const x of p.plan) jobs.push({ seed: x.seed, n: x.n, crit: true });
      if (p.left > 0 && mode === "agent") {
        const st = safe(() => stockPlan(s, p.left, water));
        if (st && st.jobs.length) {
          for (const j of st.jobs) { jobs.push({ seed: j.seed, n: j.n, crit: j.crit }); p.left -= j.n; }
          decide(`📦 للمخزون (${label}): ${st.jobs.map((j) => `${j.seed.name} ×${j.n} (عندك ${fmt(j.qty)}/${fmt(j.target)}${j.used ? `، بيتستهلك ${fmt(j.used)}/س` : ""})`).join(" • ")}`);
        }
      }
      if (p.left > 0 && mode === "agent") {
        const ip = safe(() => inputPlan(s, p.left, water));
        if (ip && ip.jobs.length) {
          for (const j of ip.jobs) jobs.push({ seed: j.seed, n: j.n });
          p.left = ip.left;
          decide(`🐄⚙️ للحيوانات والمكن اللي بتكسب (${label}): ${ip.jobs.map((j) => `${j.seed.name} ×${j.n} (بيطلّع ${fmt(j.value)} 🪙/س، عندك ${fmt(j.qty)})`).join(" • ")}`);
        }
      }
      const sp = mode === "agent" ? plan()?.seedPlan : null;
      if (p.left > 0 && Array.isArray(sp) && sp.length) {
        const total = p.left, named = [], dropped = [];
        // the AI's pick must still pay close to the best seed by the game's own prices (>= 75% per hour)
        const ranked = safe(() => rankSeeds(s, water)) || [];
        const bestRate = ranked.length ? ranked[0].rate : 0;
        const rateOf = (seed) => (ranked.find((r) => String(r.seed.id) === String(seed.id)) || {}).rate || 0;
        for (const x of sp) {
          const seed = findSeedByName(s, x.seed);
          if (!seed || !fits(seed)) continue;
          if (bestRate > 0 && rateOf(seed) < bestRate * 0.75) { dropped.push(seed.name); continue; }
          const n = Math.min(p.left, Math.floor(total * Math.min(1, Math.max(0, Number(x.share) || 0))));
          if (n > 0) { jobs.push({ seed, n }); p.left -= n; named.push(`${seed.name} ×${n}`); }
        }
        if (named.length) decide(`🧠 حسب خطة الـ AI (${label}): ${named.join(" • ")}`);
        if (dropped.length) decide(`🧮 سيبت من خطة الـ AI (${label}): ${dropped.join("، ")} — ربحها في الساعة أقل من أحسن بذرة بكتير`);
      }
      // the evening before the player's stop time: the crops ranked by "until the bot is back" already favor
      // long ones that ripen by morning; say so once
      const toStop = minutesToStop();
      if (mode === "agent" && toStop <= 180 && p.left > 0 && Date.now() - (g.__fmNightMsg || 0) > 30 * 60000 && (g.__fmNightMsg = Date.now())) decide(`🌙 فاضل ${Math.round(toStop / 60 * 10) / 10} س على وقف الشغل — بزرع حاجات تطلع على الصبح`);
      if (p.left > 0) {
        // only when no animal / machine on any farm eats a crop: plant the most profitable crop to sell
        const best = mode === "agent" ? safe(() => rankSeeds(s, water)[0]) : null;
        if (best) {
          jobs.push({ seed: best.seed, n: p.left });
          decide(`🌱 ${best.seed.name} ×${p.left} (${label}) — أعلى ربح: ${fmt(best.rate)} 🪙/ساعة ` +
            `(ربح ${fmt(best.profit)} كل ${best.hours < 1 ? Math.round(best.hours * 60) + " د" : best.hours.toFixed(1) + " س"}` +
            (best.realHours > best.hours + 0.2 ? `، هيتحصد بعد ${best.realHours.toFixed(1)} س` : "") + ")");
        } else {
          const alt = fallback || cheapest();
          if (alt) {
            jobs.push({ seed: alt, n: p.left });
            if (mode === "agent") decide(`🌱 ${alt.name} ×${p.left} (${label}) — مفيش أسعار بيع لسه، زرعت ${fallback ? "الأكتر في المزرعة" : "الأرخص"}`);
          }
        }
      }
    } else if (fallback) {
      jobs.push({ seed: fallback, n: s.soils.length });
    }
    if (!jobs.length) return warn(`مفيش بذرة ${label} تنفع هنا — اختار بذرة من القايمة`);
    // big batches, one after the other: a round plants 1-3 crops (the most important first: needs, stock,
    // inputs) on all the free soil instead of many small lots; the next harvest round takes the next crops.
    // A big lot keeps the machines / animals fed for days and every plot of it ripens and is harvested together.
    if (mode === "agent" && !picked) {
      const merged = [];
      for (const j of jobs) {
        const m = merged.find((x) => String(x.seed.id) === String(j.seed.id));
        if (m) { m.n += j.n; m.crit = m.crit || j.crit; } else if (j.n > 0) merged.push({ ...j });
      }
      // inputs that are running out are never pushed to a later round (up to 6 crops a round)
      merged.sort((a, b) => (b.crit ? 1 : 0) - (a.crit ? 1 : 0));
      const total = merged.reduce((a, j) => a + j.n, 0);
      const keep = Math.max(total >= 300 ? 3 : total >= 100 ? 2 : 1, Math.min(6, merged.filter((j) => j.crit).length));
      if (merged.length > keep) {
        const kept = merged.slice(0, keep), dropped = merged.slice(keep);
        const base = kept.reduce((a, j) => a + j.n, 0);
        let rest = total - base;
        // the freed soil goes to the kept crops in proportion, the most important one takes the remainder
        for (const j of kept) { const add_ = Math.floor((total - base) * (j.n / base)); j.n += add_; rest -= add_; }
        kept[0].n += rest;
        jobs.length = 0;
        jobs.push(...kept);
        decide(`🚜 زرعة كبيرة (${label}): ${kept.map((j) => `${j.seed.name} ×${j.n}`).join(" • ")} — ` +
          `${dropped.map((j) => j.seed.name).join("، ")} في الدورة الجاية`);
      } else { jobs.length = 0; jobs.push(...merged); }
    }
    // money: what the whole plan costs; if the coins are short, sell barn surplus first
    const reserveCoins = Number(cfg.sell?.reserve) || 0;
    const priceOf = (seed) => Number(seed && seed.price) || 0;
    const planned = jobs.reduce((a, j) => a + j.n, 0);
    const want = jobs.reduce((a, j) => a + priceOf(j.seed) * j.n, 0);
    if (coins() - reserveCoins < want && !stopped()) {
      const before = coins();
      await sellIfNeeded(scan() || s, done, want + reserveCoins).catch(() => {});
      if (coins() > before) decide(`💰 بعت من الحظيرة بـ ${fmt(coins() - before)} 🪙 علشان الزراعة (الخطة محتاجة ${fmt(want)})`);
    }
    let wallet = coins() - reserveCoins;
    if (!(coins() > 0) || wallet <= 0) return warn(`مفيش كوينز فوق الاحتياطي للزراعة (${label}) — مستني البيع`);
    if (want > wallet) {
      // every plot gets at least the cheapest seed; the coins left upgrade plots in plan order
      // (machines/animals needs, stock, then profit), so no soil is left empty while coins remain
      const ch = cheapest(), base = priceOf(ch);
      const fillable = ch ? Math.min(planned, base > 0 ? Math.floor(wallet / base) : planned) : 0;
      let extra = wallet - base * fillable, upgraded = 0;
      for (const j of jobs) {
        const step_ = Math.max(0, priceOf(j.seed) - base);
        const can = step_ > 0 ? Math.min(j.n, Math.floor(extra / step_)) : j.n;
        extra -= can * step_;
        upgraded += can;
        j.n = can;
      }
      const filled = Math.min(fillable, planned);
      const rest = Math.max(0, filled - upgraded);
      if (rest > 0 && ch) jobs.push({ seed: ch, n: rest });
      decide(`💸 معاك ${fmt(wallet)} والخطة محتاجة ${fmt(want)} — زرعت ${filled} أرض: ${upgraded} حسب الخطة و${rest} ${ch ? ch.name : ""} الأرخص` +
        (filled < planned ? ` (${planned - filled} أرض فاضية لحد ما الفلوس تيجي)` : ""));
    }
    let from = 0;
    for (const job of jobs) {
      if (job.n <= 0) continue;
      const part = { ...s, soils: s.soils.slice(from, from + job.n) };
      from += job.n;
      await plantSeed(part, done, job.seed);
      if (stopped()) return;
    }
  }

  async function plantSeed(s, done, seed) {
    const list = s.soils;
    if (!list.length) return;
    seed = plantable(seed);
    if (!seed) return warn("بذرة مقفولة أو مش بالكوينز — اتمنعت قبل الزراعة");
    for (let i = 0; i < list.length; i++) {
      if (stopped()) return;
      const soil = list[i];
      if (!ok(soil)) continue;
      step(`🌱 بيزرع ${seed.name} (${i + 1}/${list.length})`, "plant");
      // createPlant = the player's own tap (PlantTool -> GameConst.CREATE_PLANT, ADD_PLANT_C2S): costs coins only.
      // createPlants is the multi-sow tool: it spends 1 OP per plot (costTreasure(OP)), so it's never used.
      if (typeof s.ctrl.createPlant !== "function") return warn("مش لاقي الزراعة العادية في اللعبة — وقّفت الزراعة عشان ماتصرفش OP");
      await tap(() => s.ctrl.createPlant(soil, seed));
      // after the first few, make sure planting really works (coins / level)
      if (i === 2) {
        await drain(() => true, 5000);
        const now = scan();
        const left = now ? new Set(now.soils) : null;
        if (left && list.slice(0, 3).every((x) => left.has(x)))
          return warn(`الزراعة مش ماشية — اتأكد من الفلوس ومستوى "${seed.name}"`);
      }
    }
    await drain(() => true, 8000);
    const after = scan();
    if (after) {
      const left = new Set(after.soils);
      const n = list.filter((x) => !left.has(x)).length;
      done.planted += n;
      status.totals.planted += n;
      if (n) send("planted", { seedId: seed.id, n });
    }
  }

  // ---------- player picks a seed inside the game -> plant every empty soil with it ----------
  let pendingSeed = null, hookedCtrl = null;
  function hookCtrl(ctrl) {
    if (!ctrl || ctrl === hookedCtrl || typeof ctrl.setPlantTool !== "function") return;
    hookedCtrl = ctrl;
    const orig = ctrl.setPlantTool;
    ctrl.setPlantTool = function (t) {
      const r = orig.apply(this, arguments);
      if (!disposed && t && t.id != null && t.type === "seeds" && opt("gamePick")) {
        pendingSeed = t;
        send("pick", { seed: { id: t.id, name: t.name } });
        setTimeout(plantPicked, 900);
      }
      return r;
    };
  }
  async function plantPicked() {
    if (!pendingSeed || busy) return; // the running loop picks it up
    const seed = pendingSeed;
    pendingSeed = null;
    busy = true; manual = true; stopFlag = false;
    try {
      const s = scan();
      if (s && s.ctrl) await plantAll(s, emptyTotals(), seed);
    } finally {
      busy = false; manual = false;
      step(`✅ زرعت ${seed.name} في كل الأرض الفاضية`, cfg.botOn ? "waiting" : "idle");
      if (!cfg.botOn) setTimeout(() => { if (!busy && !cfg.botOn) { status.phase = "idle"; overlay(); } }, 4000);
    }
  }
  // keep the hook installed even while the bot is off (cheap: stops at GameView)
  let disposed = false;
  const hookTimer = setInterval(() => {
    if (!opt("gamePick") || hookedCtrl) return;
    const st = stage();
    if (!st) return;
    const find = (o, d) => {
      if (!o || d > 6) return null;
      if (cls(o) === "GameView") return o;
      for (let i = 0; i < (o.numChildren || 0); i++) {
        const v = find(safe(() => o.getChildAt(i)), d + 1);
        if (v) return v;
      }
      return null;
    };
    hookCtrl(safe(() => find(st, 0)._controller));
  }, 3000);

  let lastLevel = 0;
  async function cycle(only) {
    safe(applyFps); // a farm change can reset it
    const done = emptyTotals();
    let s = scan();
    if (!s || !s.ctrl) { step("⏳ مستني المزرعة تحمّل...", "waiting"); return done; }
    const want = (k) => (only ? only === k : opt("do" + k));
    const tendReady = async (i) => {
      // a big harvest: plant what it freed so far, an empty plot earns nothing
      if (i % 100 === 99 && want("Plant")) {
        await drain(() => true, 5000);
        const freed = scan();
        if (freed && freed.soils.length) await plantAll(freed, done);
      }
      const now = scan();
      if (!now) return;
      if (want("Machines") && now.machines.some((m) => needsWork(m, true))) await tendMachines(now, done);
      if (want("Animals") && now.animals.some((a) => needsWork(a, false))) await tendAnimals(now, done);
    };
    // 1) what is ripe comes first (a ripe plot earns nothing until it is harvested and planted again)
    if (!only && cfg.agent) { try { await emptyDryer(scan() || s, done); } catch (e) { warn("المجفف: " + String(e && e.message).slice(0, 60)); } }
    if (want("Harvest")) {
      if (opt("harvestPlants")) await harvestPlants(scan() || s, done, only ? null : tendReady, !only && !!cfg.agent);
      if (opt("harvestTrees")) await harvestTrees(scan() || s, done);
    }
    // 2) replant the freed soil right away (coins for seeds come first if they are short)
    if (!only && want("Plant")) {
      s = scan() || s;
      if (s.soils.length) {
        const need = plantingCost(s);
        if (need > coins()) await sellIfNeeded(s, done, need);
        await plantAll(scan() || s, done);
      }
    }
    // 3) machines and animals — crops that ripen meanwhile still come first
    let cropsStuckUntil = 0; // ripe crops that can't be taken now (dryer / barn full): don't retry every 5 s
    const cropsFirst = only || !want("Harvest") || !opt("harvestPlants") ? null : async () => {
      if (Date.now() < cropsStuckUntil) return false;
      const now = scan();
      if (!now || !now.readyPlants.length) return false;
      const before = done.harvested || 0;
      step(`🌾 ${now.readyPlants.length} زرعة جهزت — بحصدها الأول وبعدين أكمّل`, "harvest");
      await harvestPlants(now, done, null, !!cfg.agent);
      const got = (done.harvested || 0) - before;
      if (!got) { cropsStuckUntil = Date.now() + 2 * 60000; return false; }
      decide(`🌾 حصدت ${got} زرعة جهزت وأنا بخدم المكن والحيوانات، وزرعت مكانها، وبعدين كمّلت`);
      const after = scan();
      if (after && after.soils.length && want("Plant")) {
        const need = plantingCost(after);
        if (need > coins()) await sellIfNeeded(after, done, need);
        await plantAll(scan() || after, done);
      }
      return true;
    };
    if (!only && cfg.agent) { try { await switchMachines(scan() || s, done); } catch (e) { warn("تغيير المنتج: " + String(e && e.message).slice(0, 60)); } }
    if (want("Machines")) await tendMachines(scan() || s, done, cropsFirst);
    if (want("Animals")) await tendAnimals(scan() || s, done, cropsFirst);
    if (!only && cfg.agent) {
      s = scan() || s;
      try { await fertilize(s, done); } catch (e) { warn("السماد: " + String(e && e.message).slice(0, 60)); }
      try { await tradeOrders(s, done); } catch (e) { warn("الطلبات: " + String(e && e.message).slice(0, 60)); }
      try { await shipOrders(s, done); } catch (e) { warn("السوق: " + String(e && e.message).slice(0, 60)); }
      try { await claimGiftCoins(done); } catch (e) { warn("الهدايا: " + String(e && e.message).slice(0, 60)); }
      try { await socialChores(done); } catch (e) { warn("البريد والطلبات: " + String(e && e.message).slice(0, 60)); }
      try { await craftFloral(scan() || s, done); } catch (e) { warn("تنسيق الزهور: " + String(e && e.message).slice(0, 60)); }
      try { await eventChores(done); } catch (e) { warn("الأحداث: " + String(e && e.message).slice(0, 60)); }
    }
    if (!only || only === "Sell") {
      const now = scan() || s;
      await sellIfNeeded(now, done, want("Plant") ? plantingCost(now) : 0);
    }
    if (want("Plant")) {
      s = scan() || s;
      await plantAll(s, done);
    }
    if (pendingSeed) {
      const seed = pendingSeed;
      pendingSeed = null;
      await plantAll(scan() || s, done, seed);
    }
    s = scan() || s;
    status.counts = countsOf(s);
    status.animals = groups(s.animals);
    status.machines = groups(s.machines);
    status.coins = coins();
    status.scene = sceneName(currentScene());
    status.level = playerLevel();
    if (lastLevel && status.level > lastLevel) decide(`⭐ وصلت للمستوى ${status.level}`);
    lastLevel = status.level || lastLevel;
    recordCoins();
    status.brain = safe(() => brainReport(s)) || status.brain;
    status.lastScene = safe(() => recordScene(s)) || null;
    status.save = { seen: saves.seen, fails: saves.fails, lastStatus: saves.lastStatus, unsaved: unsaved(), lastOkAt: saves.okSentAt || null };
    return done;
  }

  // ---------- seeds list ----------
  function allSeeds(plants) {
    const out = new Map();
    const consider = (v) => {
      if (v && typeof v === "object" && v.type === "seeds" && v.id != null && v.name) out.set(String(v.id), v);
    };
    const visit = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 2) return;
      let n = 0;
      const vals = safe(() => (Array.isArray(o) ? o : Object.values(o))) || [];
      for (const v of vals) {
        if (++n > 60000) break;
        consider(v);
        if (v && typeof v === "object" && v.type === undefined) visit(v, depth + 1);
      }
    };
    const roots = Object.keys(g).filter((k) => /^Config|ConfigData|StoreData/i.test(k)).map((k) => safe(() => g[k]));
    roots.push(safe(() => g.GF));
    for (const root of roots) {
      if (!root || (typeof root !== "object" && typeof root !== "function")) continue;
      for (const k of safe(() => Object.getOwnPropertyNames(root)) || []) {
        const v = safe(() => root[k]);
        if (v && typeof v === "object") safe(() => visit(v, 0));
      }
    }
    for (const p of plants) consider(safe(() => p.configData));
    return [...out.values()];
  }
  const playerLevel = () =>
    Number(safe(() => g.GF.loginModel.AppData.level)) || Number(safe(() => g.GF.loginModel.level)) || 0;

  // ---------- public API (popup buttons) ----------
  async function run(action) {
    try {
      return await runInner(action);
    } catch (e) {
      busy = false; manual = false;
      return { error: "خطأ في البوت: " + String((e && e.message) || e).slice(0, 120) };
    }
  }

  async function runInner(action) {
    const s = scan();
    if (!s) return { error: "اللعبة لسه بتحمّل — استنى لحد ما المزرعة تظهر" };
    if (!s.ctrl) return { error: "مش لاقي المزرعة على الشاشة — اقفل أي نافذة مفتوحة في اللعبة وارجع للمزرعة" };

    if (action === "sell-plan") {
      const plan = sellPlan(s, Math.max(plantingCost(s), Number(cfg.sell?.reserve) || 0));
      return { coins: coins(), plan: plan.map((x) => ({ name: x.name, n: x.n, coins: x.n * x.price })) };
    }

    if (action === "plan") {
      const p = smartPlan(s, s.soils.length);
      return {
        soils: s.soils.length, left: p.left,
        plan: p.plan.map((x) => ({ name: x.seed.name, id: x.seed.id, n: x.n, for: x.for }))
      };
    }

    if (action === "seeds") {
      return {
        level: playerLevel(),
        seeds: allSeeds(s.plants).map((c) => ({
          id: c.id, name: c.name, level: Number(c.level) || 0, price: Number(c.price) || 0,
          hours: Math.round(((Number(c.collect_in) || 0) / 3600) * 10) / 10
        })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      };
    }

    let done = emptyTotals();
    if (action !== "status") {
      if (busy) return { error: "البوت شغال على حاجة دلوقتي — استنى ثانية" };
      if (!atHome()) return { error: "ارجع لمزرعتك الأول (إنت عند جار)" };
      busy = true; manual = true; stopFlag = false;
      try {
        const only = { harvest: "Harvest", animals: "Animals", machines: "Machines", plant: "Plant", sell: "Sell" }[action];
        done = await cycle(only);
      } finally {
        busy = false; manual = false;
        step(stopFlag ? "⏹ اتوقف" : "✅ خلص", cfg.botOn ? "waiting" : "idle");
        if (!cfg.botOn) setTimeout(() => { if (!busy && !cfg.botOn) { status.phase = "idle"; overlay(); } }, 4000);
      }
    }
    const now = scan() || s;
    status.counts = countsOf(now);
    status.animals = groups(now.animals);
    status.machines = groups(now.machines);
    status.coins = coins();
    status.scene = sceneName(currentScene());
    recordCoins();
    status.brain = safe(() => brainReport(now)) || status.brain;
    safe(() => recordScene(now));
    status.save = { seen: saves.seen, fails: saves.fails, lastStatus: saves.lastStatus, unsaved: unsaved(), lastOkAt: saves.okSentAt || null };
    post();
    return { counts: status.counts, animals: status.animals, machines: status.machines, done, warnings: status.warnings };
  }

  // ---------- rest / working hours (look like a person, not a 24/7 machine) ----------
  let workUntil = 0, restUntil = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clock = (t) => new Date(t).toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" });
  const minutesOf = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  function restReason() {
    const r = cfg.rest;
    if (!r || !r.on) return null;
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes(), from = minutesOf(r.from), to = minutesOf(r.to);
    const inHours = from <= to ? m >= from && m < to : m >= from || m < to;
    if (!inHours) { workUntil = 0; return `🌙 برا ساعات الشغل — هيرجع الساعة ${r.from}`; }
    const t = Date.now();
    if (t < restUntil) return `😴 استراحة — هيرجع ${clock(restUntil)}`;
    if (!workUntil) workUntil = t + rand(r.workMin || 40, r.workMax || 90) * 60000;
    if (t >= workUntil) {
      restUntil = t + rand(r.restMin || 8, r.restMax || 20) * 60000;
      workUntil = 0;
      return `😴 استراحة — هيرجع ${clock(restUntil)}`;
    }
    return null;
  }

  // ---------- out of sync / lost connection ----------
  // The game says "اللعبة غير متزامنة يرجى إعادة تحديث الصفحة" (or that the connection is lost) and saves
  // nothing more until the page is reloaded. The bot kept reporting meanwhile, so the watchdog never
  // noticed. Look for that notice (game dialog or a blocked alert()) and ask for a reload.
  const STUCK_RE = /جهاز\s*(?:آخر|اخر|تاني|ثاني|جديد)|(?:مكان|متصفح)\s*(?:آخر|اخر)|(?:logged|signed)\s*in\s*(?:from|on|at|elsewhere)|another\s*(?:device|location|browser|session)|غير\s*مت[زن]ا[مز]ن|يرج[ىي]\s*(?:إ|ا)عادة|(?:إ|ا)عادة\s*(?:ال)?(?:تحديث|تحميل|الدخول|تسجيل)|تحديث\s*الصفحة|(?:انقطع|فقد|فقدان|ضعف|مشكلة\s*في)\s*(?:ال)?(?:اتصال|شبكة)|خطأ\s*في\s*(?:ال)?(?:اتصال|شبكة|الخادم|السيرفر)|انتهت\s*(?:ال)?جلسة|out of sync|refresh the page|reload the page|connection (?:lost|error|failed)|network error|session (?:expired|timeout)|disconnected/i;
  function stuckText() {
    const a = g.__fmAlert; // set by probe-main.js instead of an alert() that freezes the frame
    if (a && Date.now() - a.at < 10 * 60000) return a.text;
    // page text too (without the bot's overlay: it holds its own "reloading" line)
    const html = safe(() => document.body.innerText.replace(box ? box.innerText : "", "").slice(0, 5000));
    const m = html && html.match(STUCK_RE);
    if (m) return m[0];
    const st = stage();
    if (!st) return null;
    let n = 0, hit = null;
    const walk = (o, d) => {
      if (!o || hit || d > 14 || ++n > 6000 || o.visible === false) return;
      const t = safe(() => o.text);
      if (typeof t === "string" && t.length < 300 && STUCK_RE.test(t)) { hit = t; return; }
      for (let i = 0; i < (o.numChildren || 0); i++) walk(safe(() => o.getChildAt(i)), d + 1);
    };
    walk(st, 0);
    return hit;
  }
  let stuckSince = 0, reloadAsked = 0;
  const stuckTimer = setInterval(() => {
    if (disposed || !cfg.botOn) { stuckSince = 0; return; }
    const why = stuckText() ||
      ((saves.streak || 0) >= 5 && Date.now() - saves.failAt < 3 * 60000 ? `السيرفر رفض الحفظ ${saves.streak} مرات ورا بعض` : null);
    if (!why) { stuckSince = 0; return; }
    if (!stuckSince) { stuckSince = Date.now(); warn("⚠️ اللعبة فصلت: " + String(why).slice(0, 60)); }
    // a few seconds for the game to recover on its own, then reload (asked again every 5 min if it didn't happen)
    if (Date.now() - stuckSince >= 15000 && Date.now() - reloadAsked > 5 * 60000) {
      reloadAsked = Date.now();
      stopFlag = true;
      step("🔄 اللعبة غير متزامنة — بعمل إعادة تحميل للصفحة...", "reload");
      send("reload", { reason: String(why).slice(0, 120) });
    }
  }, 5000);

  // ---------- always-on loop ----------
  async function loop() {
    if (loopRunning) return;
    loopRunning = true;
    status.warnings = [];
    try {
      while (cfg.botOn) {
        const rest = restReason();
        if (rest) {
          step(rest, "rest");
          await sleep(20000);
          continue;
        }
        unpause();
        status.bg = safe(() => ({ ...window.__fmBgRunner, hiddenNow: window.__fmRealHidden ? window.__fmRealHidden() : null })) || null;
        if (stage() && atHome() && !busy) {
          busy = true; stopFlag = false;
          try {
            await cycle(null);
            if (cfg.botOn && !restReason()) await maybeSwitchScene(status.lastScene);
          } catch (e) { warn("خطأ: " + String(e && e.message).slice(0, 80)); }
          finally { busy = false; }
        }
        if (!cfg.botOn) break;
        const c = status.counts;
        const here = status.lastScene;
        const idleHere = here && !here.hungry && !valueBy(here, serverNow() + 120);
        let nextTxt = "";
        if (idleHere) {
          const soon = Object.values(sceneBoard).filter((b) => b.nextReadyAt).sort((a, b) => a.nextReadyAt - b.nextReadyAt)[0];
          if (soon) nextTxt = ` — أقرب حاجة: ${soon.name} بعد ${Math.max(0, Math.round((soon.nextReadyAt - serverNow()) / 60))} د`;
        }
        step(!atHome() ? "🏠 مستنيك ترجع لمزرعتك"
          : idleHere ? `✅ مفيش شغل هنا دلوقتي${nextTxt}`
          : `👀 مستني اللي يجهز${c ? ` — زرع ${c.readyPlants} • شجر ${c.readyTrees} • أرض فاضية ${c.soils}` : ""}`, "waiting");
        await sleep(Math.max(2, Number(cfg.interval) || 5) * 1000);
      }
    } finally {
      loopRunning = false;
      status.on = false;
      step("⏸ البوت واقف", "idle");
    }
  }

  // restore what an earlier engine remembered (sent once by the bridge with the first config)
  function restore(m) {
    if (!m || restored) return;
    restored = true;
    // what the bot learned about every farm before the page was reloaded (max 1 day old)
    const f = m.farm;
    if (f && Date.now() - (f.at || 0) < 24 * 3600000) {
      for (const [k, v] of Object.entries(f.sceneKnow || {})) if (!sceneKnow[k]) sceneKnow[k] = v;
      for (const [k, v] of Object.entries(f.sceneBoard || {})) if (!sceneBoard[k]) sceneBoard[k] = v;
      for (const [k, v] of Object.entries(f.visitLog || {})) if (!visitLog[k]) visitLog[k] = v;
      for (const [k, v] of Object.entries(f.sceneUse || {})) if (!sceneUse[k]) sceneUse[k] = new Map(v.map(([a, b]) => [Number(a), b]));
      for (const [k, v] of Object.entries(f.sceneInputs || {})) if (!sceneInputs[k]) sceneInputs[k] = new Set(v.map(Number));
      status.know = safe(() => knowStatus()) || status.know;
    }
    if (Array.isArray(m.coinHistory)) coinHistory.push(...m.coinHistory.filter((x) => x && x.t && x.c));
    if (Array.isArray(m.decisions) && !status.decisions?.length) status.decisions = m.decisions.slice(0, 12);
    if (m.totals && typeof m.totals === "object") {
      for (const k of Object.keys(status.totals)) status.totals[k] += Number(m.totals[k]) || 0;
    }
  }
  let restored = false;

  // the server draws the game by CPU (no GPU): fewer frames per second = much less work. The game's own
  // timers / walking are time based, so the bot keeps the same pace. 0 = leave the game's frame rate alone.
  let gameFpsOrig = null;
  function applyFps() {
    const st = stage();
    if (!st || typeof st.frameRate !== "number") return;
    const want = Number(cfg.gameFps) || 0;
    if (gameFpsOrig == null) gameFpsOrig = st.frameRate;
    const target = want > 0 ? Math.max(10, Math.min(60, want)) : gameFpsOrig;
    if (target && st.frameRate !== target) safe(() => { st.frameRate = target; });
  }

  function applyConfig(c) {
    const wasOn = cfg.botOn;
    cfg = { ...cfg, ...c };
    safe(applyFps);
    status.on = !!cfg.botOn;
    if (cfg.botOn && !wasOn) loop();
    if (!cfg.botOn && wasOn) stopFlag = true;
    overlay();
    post();
  }

  const onMessage = (e) => {
    if (e.source !== window || !e.data || !e.data.__fmCfg) return;
    channel = e.data.channel; // the newest bridge wins
    restore(e.data.memory);
    applyConfig(e.data.__fmCfg);
  };
  window.addEventListener("message", onMessage);

  function dispose() {
    disposed = true;
    stopFlag = true;
    cfg.botOn = false;
    clearInterval(hookTimer);
    clearInterval(stuckTimer);
    clearInterval(giftTimer);
    window.removeEventListener("message", onMessage);
    box?.remove();
  }

  // read-only snapshot of what the bot sees right now (for checking from the bridge)
  function diag() {
    const s = scan();
    if (!s) return { noFarm: true };
    const names = (list) => { const m = {}; for (const o of list) { const n = nameOf(o); m[n] = (m[n] || 0) + 1; } return m; };
    const econ = (water) => (safe(() => rankSeeds(s, water)) || []).slice(0, 6).map((x) => ({
      name: x.seed.name, price: Number(x.seed.price) || 0, sell: x.sell, n: x.n, hours: Math.round(x.hours * 10) / 10,
      profit: Math.round(x.profit), rate: Math.round(x.rate) }));
    const cheap = (water) => safe(() => seedsFor(s, water).filter(plantable).sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0]);
    return {
      at: Date.now(), scene: sceneName(currentScene()), coins: coins(), busy, phase: status.phase, text: status.text,
      plants: s.plants.length, ready: s.readyPlants.length, readyNames: names(s.readyPlants),
      readyWater: s.readyPlants.filter((p) => goesToDryer(safe(() => p.configData.product))).length,
      soils: { land: s.soils.filter((o) => !isWaterSoil(o)).length, water: s.soils.filter((o) => isWaterSoil(o)).length },
      trees: s.trees.length, readyTrees: s.readyTrees.length, dryer: dryMachine(),
      queue: queueLen(), plantingCost: safe(() => plantingCost(s)),
      cheapest: { land: cheap(false) && { name: cheap(false).name, price: cheap(false).price }, water: cheap(true) && { name: cheap(true).name, price: cheap(true).price } },
      bestLand: econ(false), bestWater: econ(true), decisions: (status.decisions || []).map((d) => d.time + " " + d.text)
    };
  }
  window.__farmBot = { version: VERSION, run, dispose, stop: () => { stopFlag = true; }, status: () => status, knowledge: () => JSON.parse(JSON.stringify(knowledge())), diag: () => JSON.parse(JSON.stringify(diag())) };
  window.postMessage({ __fmHello: true }, location.origin);
})();
