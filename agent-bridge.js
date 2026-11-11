// Farm bot bridge — runs in the game frame (isolated world).
// Passes settings from chrome.storage to agent-main.js and saves the bot's live status for the popup.
// Each bridge gets a random channel; the engine only talks to the newest one, so a bridge
// orphaned by an extension reload never receives messages (and never hits a dead context).
(() => {
  if (!/^apps-\d+\.apps\.fbsbx\.com$/i.test(location.hostname)) return;
  if (window.__fmBridge) return;
  window.__fmBridge = true;

  const channel = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  let memorySent = false;
  const push = async () => {
    if (!alive()) return shutdown();
    const { settings = {}, botStatus, farmMemory, lastReload } = await chrome.storage.local.get(["settings", "botStatus", "farmMemory", "lastReload"]);
    // the game went out of sync in the last 6 hours: no turbo for now
    const desynced = lastReload && Date.now() - (lastReload.at || 0) < 6 * 3600000 && !/^(daily gift|quiet)$/.test(lastReload.why || "");
    const speed = settings.botSpeed || "turbo";
    // memory from before a reload / update: coin history, decisions, totals (max 1 day old)
    let memory = null;
    if (!memorySent && botStatus && Date.now() - (botStatus.updated || 0) < 24 * 3600000) {
      memory = { coinHistory: botStatus.coinHistory, decisions: botStatus.decisions, totals: botStatus.totals };
    }
    if (!memorySent && farmMemory) memory = { ...(memory || {}), farm: farmMemory };
    memorySent = true;
    // full agent (default): always on unless paused, every job enabled, it decides everything
    const agent = (settings.mode || "agent") === "agent";
    const ALL = { doHarvest: true, doAnimals: true, doMachines: true, doPlant: true, harvestPlants: true, harvestTrees: true,
      animalCollect: true, animalFeed: true, machineCollect: true, machineRefill: true, gamePick: true };
    window.postMessage({
      channel,
      memory,
      __fmCfg: {
        agent,
        botOn: agent ? !settings.paused : !!settings.botOn,
        interval: settings.botInterval || 5,
        speed: speed === "turbo" && desynced ? "fast" : speed,
        seedMode: agent ? "agent" : settings.seedMode || "smart",
        stock: { target: Number(settings.stockTarget) || 5000, share: settings.stockShare ?? 0.3 },
        sell: {
          on: agent || settings.sellOn !== false,
          keepMin: agent ? (Number(settings.stockTarget) || 5000) : settings.sellKeepMin ?? 30,
          surplus: agent || settings.sellSurplus !== false,
          maxEach: agent ? (Number(settings.stockSurplus) || 5000) : settings.sellMaxEach || 500,
          reserve: settings.sellReserve ?? 0,
          cashFloor: Number(settings.sellCashFloor ?? 2000000) || 0,
          barnTrigger: Number(settings.sellBarnTrigger ?? 10000000) || 0
        },
        scenes: { on: agent || settings.scenesOn !== false, minMin: Number(settings.sceneMinMin) || 3, maxMin: Number(settings.sceneMaxMin) || 20 },
        rest: {
          on: settings.restOn !== false,
          from: settings.restFrom || "08:00",
          to: settings.restTo || "23:00",
          workMin: 40, workMax: 90, restMin: 8, restMax: 20
        },
        seedId: settings.seedId || "",
        goalCoins: Number(settings.goalCoins) || 100000000,
        gameFps: Number(settings.gameFps) || 0,
        orderMinRatio: Number(settings.orderMinRatio) || 1,
        plan: null,
        playbook: null, // the AI trainer is off: the bot goes by its own numbers
        features: {
          orders: settings.fOrders !== false,
          shipOrders: settings.fShipOrders !== false,
          fertilize: settings.fFertilize !== false,
          dryer: settings.fDryer !== false,
          giftCoins: settings.fGiftCoins !== false,
          social: settings.fSocial !== false,
          crafts: settings.fCrafts !== false,
          events: settings.fEvents !== false,
          machineSwitch: settings.fMachineSwitch !== false
        },
        farm: agent ? ALL : settings.farm || {}
      }
    }, location.origin);
  };

  const onStorage = (changes, area) => {
    if (area === "local" && changes.settings) push().catch(() => {});
  };

  const onMessage = async (e) => {
    if (e.source !== window || !e.data) return;
    const d = e.data;
    if (!alive()) return shutdown();
    try {
      if (d.__fmHello) return await push();
      if (d.__fmc !== channel) return;
      if (d.kind === "status") await chrome.storage.local.set({ botStatus: d.status });
      if (d.kind === "reload") await chrome.runtime.sendMessage({ type: "reload-game", reason: d.reason }).catch(() => {});
      if (d.kind === "farmMemory" && d.memory) await chrome.storage.local.set({ farmMemory: d.memory });
      if (d.kind === "pick" || d.kind === "planted") {
        const id = String(d.kind === "pick" ? d.seed.id : d.seedId);
        const { settings = {}, seedUsage = {} } = await chrome.storage.local.get(["settings", "seedUsage"]);
        seedUsage[id] = (seedUsage[id] || 0) + 1;
        const patch = { seedUsage };
        if (d.kind === "pick") patch.settings = { ...settings, seedId: id };
        await chrome.storage.local.set(patch);
      }
      if (d.kind === "toggle") {
        const { settings = {} } = await chrome.storage.local.get("settings");
        const agent = (settings.mode || "agent") === "agent";
        await chrome.storage.local.set({
          settings: agent ? { ...settings, paused: !settings.paused } : { ...settings, botOn: !settings.botOn }
        });
      }
    } catch {
      shutdown();
    }
  };

  function shutdown() {
    window.removeEventListener("message", onMessage);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
  }

  window.addEventListener("message", onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  push().catch(() => {});
})();
