const $ = (id) => document.getElementById(id);

let tab = null;
const GAME_RE = /facebook\.com\/gaming\/play\/363893212342994/;
const tabReady = chrome.tabs.query({}).then(async (all) => {
  tab = all.find((t) => GAME_RE.test(t.url || "")) ||
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return tab;
});
const isGameTab = () => GAME_RE.test(tab?.url || "");
const isAgent = (settings) => (settings.mode || "agent") === "agent";
const botEnabled = (settings) => (isAgent(settings) ? !settings.paused : !!settings.botOn);

const FARM_OPTS = ["doHarvest", "doAnimals", "doMachines", "doPlant", "harvestPlants", "harvestTrees",
  "animalCollect", "animalFeed", "machineCollect", "machineRefill", "gamePick"];

let seeds = [], playerLevel = 0, seedUsage = {}, currentSeedId = "";

// ---------- storage / messaging ----------

async function getAll() {
  const { settings = {}, botStatus = null, seedUsage = {}, seedsCache = null } =
    await chrome.storage.local.get(["settings", "botStatus", "seedUsage", "seedsCache"]);
  return { settings, botStatus, seedUsage, seedsCache };
}

async function saveSettings(patch) {
  const { settings } = await getAll();
  await chrome.storage.local.set({ settings: { ...settings, ...patch } });
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage({ ...msg, tabId: tab?.id });
  if (res && !res.ok) { toast("⚠ " + res.error, true); return null; }
  return res?.res;
}

let toastTimer;
function toast(text, err = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

// ---------- tabs ----------

for (const b of document.querySelectorAll(".tab")) {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "p-" + b.dataset.tab));
    saveSettings({ lastTab: b.dataset.tab });
  };
}

// ---------- farm view ----------

const badge = (id, n) => ($(id).textContent = n > 0 ? n : "");

function renderList(el, list) {
  el.innerHTML = "";
  if (!list || !list.length) {
    el.innerHTML = '<li class="empty">مفيش</li>';
    return;
  }
  for (const x of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.innerHTML = `<span class="name"></span> <span class="count">×${x.total}</span>`;
    name.querySelector(".name").textContent = x.name;
    const tags = document.createElement("span");
    if (x.ready) tags.innerHTML += `<span class="badge ready">جاهز ${x.ready}</span> `;
    if (x.hungry) tags.innerHTML += `<span class="badge hungry">مش مليان ${x.hungry}</span>`;
    li.append(name, tags);
    el.appendChild(li);
  }
}

function renderFarm(r) {
  const c = r.counts;
  if (!c) return;
  $("sReadyPlants").textContent = c.readyPlants;
  $("sPlants").textContent = `من ${c.plants}`;
  $("sReadyTrees").textContent = c.readyTrees;
  $("sTrees").textContent = `من ${c.trees}`;
  $("sSoils").textContent = c.soils;
  $("farmPlant").textContent = `🌱 ازرع الأرض الفاضية (${c.soils})`;
  renderList($("animalList"), r.animals);
  renderList($("machineList"), r.machines);
  badge("bHarvest", c.readyPlants + c.readyTrees);
  badge("bPlant", c.soils);
  badge("bAnimals", (r.animals || []).reduce((a, x) => a + x.ready, 0));
  badge("bMachines", (r.machines || []).reduce((a, x) => a + x.ready, 0));
}

// ---------- bot status ----------

function renderBot(st, on) {
  const fresh = st && Date.now() - (st.updated || 0) < 30000;
  const busy = fresh && st.phase && !["idle", "waiting", "rest"].includes(st.phase);
  $("dot").className = "dot" + (on ? (busy ? " busy" : " on") : busy ? " busy" : "");
  $("botStatus").textContent = on
    ? (fresh ? st.text || "🤖 شغال" : "🤖 مستني اللعبة تفتح...")
    : (busy ? st.text : document.body.classList.contains("agent-mode")
      ? "⏸ الوكيل متوقف مؤقتاً — شغّله من الزرار فوق" : "البوت واقف — شغّله من الزرار فوق");
  const t = (st && st.totals) || {};
  const chips = [
    ["🌾", t.harvested], ["🍌", t.trees], ["🧺", (t.collected || 0) + (t.mCollected || 0)],
    ["🍽", t.fed], ["📥", t.mRefilled], ["🌱", t.planted],
    ["📦", t.orders], ["🧪", t.fertilized], ["📬", t.social], ["💐", t.crafted], ["🎃", t.events],
    ["💰", t.earned ? (t.earned >= 1000 ? Math.round(t.earned / 1000) + "k" : t.earned) : 0]
  ].filter(([, n]) => n > 0);
  $("botTotals").innerHTML = (on || busy) ? chips.map(([e, n]) => `<span class="chip">${e} ${n}</span>`).join("") : "";
  $("botWarn").textContent = fresh ? (st.warnings || []).slice(-2).join(" • ") : "";
  if (st && st.counts) renderFarm(st);
  if (st) renderBrain(st);
  if (st && fresh) {
    $("coinsInfo").textContent = st.coins != null ? `🪙 ${Number(st.coins).toLocaleString()}` : "";
    $("sceneInfo").textContent = st.scene ? `📍 ${st.scene}` : "";
  }
}

function renderBrain(st) {
  const b = st && st.brain;
  if (st && st.coins != null) $("bCoins").textContent = Number(st.coins) >= 1e6
    ? (st.coins / 1e6).toFixed(2) + "M" : Number(st.coins).toLocaleString("en-US");
  if (!b) return;
  $("bRate").textContent = b.coinsPerHour == null ? "…" : (b.coinsPerHour >= 0 ? "+" : "") + Math.round(b.coinsPerHour).toLocaleString("en-US");
  const gr = b.goal;
  if (gr) {
    $("goalPct").textContent = gr.pct.toFixed(gr.pct < 10 ? 2 : 1) + "%";
    $("goalBar").style.width = Math.max(1, gr.pct) + "%";
    $("goalCoinsTxt").textContent = `${Number(gr.coins).toLocaleString("en-US")} / ${Number(gr.goal).toLocaleString("en-US")}`;
    $("goalEta").textContent = gr.etaDays == null ? "بيحسب السرعة…"
      : gr.etaDays > 3650 ? "بالسرعة دي: مش هيوصل — لازم استثمار"
      : gr.etaDays < 2 ? `باقي ~${Math.round(gr.etaDays * 24)} ساعة` : `باقي ~${Math.round(gr.etaDays)} يوم`;
    const inc = gr.income;
    $("incomeInfo").textContent = inc
      ? `≈ ${inc.total.toLocaleString("en-US")} 🪙/س — زرع ${inc.plants.toLocaleString("en-US")} • شجر ${inc.trees.toLocaleString("en-US")} • حيوانات ${inc.animals.toLocaleString("en-US")} • مكن ${inc.machines.toLocaleString("en-US")}` +
        (inc.soilsPotential ? ` • +${inc.soilsPotential.toLocaleString("en-US")} لو الأرض الفاضية اتزرعت` : "")
      : "—";
    const it = $("investTable");
    it.innerHTML = "";
    if (!gr.invest.length) it.innerHTML = '<tr><td colspan="4" class="empty">مفيش بيانات محل لسه</td></tr>';
    for (const x of gr.invest) {
      const tr = document.createElement("tr");
      const pb = x.paybackH < 48 ? Math.round(x.paybackH) + " س" : Math.round(x.paybackH / 24) + " يوم";
      for (const v of [x.name, x.price.toLocaleString("en-US"), Math.round(x.perHour).toLocaleString("en-US"), pb]) {
        const td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
      }
      it.appendChild(tr);
    }
    const inv = gr.inventory || {};
    $("inventoryInfo").textContent = Object.keys(inv).length
      ? Object.entries(inv).map(([n, v]) => `${n}: زرع ${v.plants} • شجر ${v.trees} • حيوان ${v.animals} • مكن ${v.machines}`).join("\n")
      : "—";
    $("inventoryInfo").style.whiteSpace = "pre-line";
  }
  const scenes = st.scenes || [];
  const ago = (t) => !t ? "لسه ماشفتهاش" : `منذ ${Math.max(0, Math.round((Date.now() - t) / 60000))} د`;
  const inMin = (t) => t == null ? "—" : Math.max(0, Math.round((t * 1000 - Date.now()) / 60000)) + " د";
  $("scenesBoard").textContent = scenes.length
    ? scenes.map((x) => `${x.current ? "📍 " : ""}${x.name}: ${x.visitedAt ? `جاهز ${x.readyNow} • فاضي ${x.soils} • محتاج ${x.hungry} • الجاي بعد ${inMin(x.nextReadyAt)} • ≈${(x.income || 0).toLocaleString("en-US")} 🪙/س` : "لسه ماشفتهاش"} (${ago(x.visitedAt)})`).join("\n") +
      (st.sceneNote ? "\n⚠ " + st.sceneNote : "")
    : "—";
  $("scenesBoard").style.whiteSpace = "pre-line";
  const d = b.dry;
  $("dryInfo").textContent = d
    ? `السعة ${d.used}/${d.max} (فاضل ${d.left}) • الطاقة ${d.power}/${d.maxPower}` + (d.crops.length ? "\n" + d.crops.map((c) => `${c.name} ×${c.qty}`).join(" • ") : "")
    : "مفيش مجفف في المزرعة دي";
  $("dryInfo").style.whiteSpace = "pre-line";
  if (b.topWater && b.topWater.length) $("dryInfo").textContent += "\n🌊 أربح بذور مائية: " + b.topWater.map((x) => `${x.name} ${x.rate}/س`).join(" • ");
  const needs = b.needs || {};
  const cons = needs.construction || [];
  $("needsInfo").textContent = cons.length
    ? cons.map((c) => `${c.name}: ${c.missing.map((m) => `${m.name} ×${m.need}`).join("، ")}`).join("\n")
    : "✅ مفيش مبانٍ مستنية مواد";
  $("needsInfo").style.whiteSpace = "pre-line";
  const tips = b.machineTips || [];
  $("machineTips").textContent = tips.length
    ? tips.map((t) => `${t.machine}: دلوقتي ${t.now} ← الأفضل ${t.best} (+${t.gain} 🪙 لكل وحدة)`).join("\n")
    : "✅ كل المكن على أفضل منتج ممكن";
  $("machineTips").style.whiteSpace = "pre-line";
  const low = b.stock || [];
  $("stockInfo").textContent = low.length
    ? low.map((x) => `${x.name}: ${Number(x.qty).toLocaleString("en-US")} / ${Number(x.target).toLocaleString("en-US")}`).join(" • ")
    : `✅ كل حاجة فوق ${Number(b.stockTarget || 5000).toLocaleString("en-US")}`;
  const tb = $("econTable");
  tb.innerHTML = "";
  if (!b.top.length) tb.innerHTML = '<tr><td colspan="4" class="empty">مفيش بيانات بذور لسه</td></tr>';
  for (const x of b.top) {
    const tr = document.createElement("tr");
    const ready = x.hours < 1 ? Math.round(x.hours * 60) + " د" : x.hours + " س";
    const wait = x.realHours > x.hours + 0.2 ? ` ⏳${x.realHours}س` : "";
    for (const v of [x.name, x.profit.toLocaleString("en-US"), ready + wait, x.rate.toLocaleString("en-US")]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  const ul = $("decisions");
  const list = st.decisions || [];
  if (!list.length) return;
  ul.innerHTML = "";
  for (const d of list) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="time"></span><span class="txt"></span>';
    li.querySelector(".time").textContent = d.time;
    li.querySelector(".txt").textContent = d.text;
    ul.appendChild(li);
  }
}

// ---------- AI strategist ----------
async function renderPlan(settings, llmError) {
  const { botStatus, trainState } = await chrome.storage.local.get(["botStatus", "trainState"]);
  const p = settings.playbook, k = botStatus && botStatus.know;
  $("llmError").textContent = llmError || "";
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 90 ? `${m} د` : m < 2880 ? `${Math.round(m / 60)} س` : `${Math.round(m / 1440)} يوم`; };
  let info = "";
  if (trainState && trainState.running) info = `⏳ بيدرّب دلوقتي (من ${ago(trainState.startedAt)})… على جهاز من غير كارت شاشة ممكن ياخد كذا دقيقة`;
  else if (!k) info = "الوكيل لسه مابعتش بيانات — افتح اللعبة";
  else if (!k.complete) info = `👀 الوكيل شاف ${k.seen}/${k.of} مزارع — فاضل: ${(k.missing || []).join("، ")}. بعدها هيدرّب لوحده`;
  else if (!p) info = "✅ الوكيل شاف كل المزارع — جاهز للتدريب";
  else info = p.fp === k.fp ? `✅ متدرّب من ${ago(p.at)} — اللعبة ماتغيّرتش من ساعتها` : "🔄 اللعبة اتغيّرت من آخر تدريب — هيعيد التدريب قريب";
  $("trainInfo").textContent = info;
  $("aiPlan").hidden = true; // the AI trainer is off
  if (!p || !p.book || true) return;
  const b = p.book;
  $("aiPlan").hidden = false;
  $("aiWhen").textContent = `منذ ${ago(p.at)}` + (p.model ? ` • ${String(p.model).replace("claude-", "")}` : "");
  $("aiSummary").textContent = b.summary || "";
  const ul = $("aiNotes");
  ul.innerHTML = "";
  const li = (text, muted) => { const x = document.createElement("li"); x.textContent = text; if (muted) x.style.color = "var(--muted)"; ul.appendChild(x); };
  for (const sc of b.scenes || []) {
    const seeds = (sc.seedPlan || []).map((x) => `${x.seed} ${Math.round(x.share * 100)}%`).join("، ");
    li(`🌱 ${sc.scene}: ${seeds || "أعلى ربح في الساعة"}${sc.why ? " — " + sc.why : ""}`);
  }
  for (const r of b.rules || []) li("📏 " + r);
  // learning: the experiment running now and what earlier ones taught
  const L = settings.learn || {};
  const expTxt = (e) => !e ? "" : e.knob === "seed" ? `${e.seed} على نص الأرض الفاضية في ${e.scene}`
    : e.knob === "fertilize" ? (e.value ? "تشغيل السماد" : "إيقاف السماد")
    : `${{ stockTarget: "حد المخزون", orderMinRatio: "حد قبول الطلبات", sceneMinMin: "أقل قعدة في المزرعة (د)" }[e.knob] || e.knob} = ${e.value}`;
  const n0 = (x) => (x == null ? "؟" : Math.round(x).toLocaleString("en-US"));
  if (L.active) li(`🧪 بيجرب دلوقتي: ${expTxt(L.active.exp)} — من ${ago(L.active.startedAt)} (بيتحكم عليها بعد 3 ساعات شغل؛ قبلها ${n0(L.active.base)} 🪙/س)${L.active.exp.why ? " — " + L.active.exp.why : ""}`);
  else if (L.next) li(`🧪 التجربة الجاية: ${expTxt(L.next)} (بتبدأ لما يتجمع 3 ساعات قياس)`);
  for (const h of (L.history || []).slice(-5).reverse())
    li(`${h.kept ? "✅ اتثبتت" : "↩️ اترجعت"}: ${expTxt(h.exp)} — ${n0(h.base)} ← ${n0(h.rate)} 🪙/س`, !h.kept);
  for (const t of b.playerTodo || []) li("👤 عليك: " + t);
  li([`الطلبات ≥ ×${b.orderMinRatio}`, `مخزون ${Number(b.stockTarget).toLocaleString("en-US")}`,
    b.fertilize === false ? "السماد: مقفول" : "السماد: شغال", b.sceneMinMin ? `قعدة ${b.sceneMinMin} د` : "",
    b.sellReserve ? "احتياطي " + Number(b.sellReserve).toLocaleString("en-US") : ""].filter(Boolean).join(" • "), true);
}
function renderProvider(v) {
  document.body.classList.toggle("prov-anthropic", v === "anthropic");
  for (const b of $("llmProvider").children) b.classList.toggle("on", b.dataset.v === v);
}
for (const b of $("llmProvider").children) {
  b.onclick = () => {
    renderProvider(b.dataset.v);
    saveSettings({ llmProvider: b.dataset.v, llmModel: b.dataset.v === "anthropic" ? $("llmModelA").value : $("llmModel").value });
  };
}
$("llmKey").onchange = (e) => saveSettings({ llmKey: e.target.value.trim() });
$("llmModel").onchange = (e) => saveSettings({ llmModel: e.target.value.trim() });
$("llmModelA").onchange = (e) => saveSettings({ llmModel: e.target.value });
$("llmUrl").onchange = (e) => saveSettings({ llmUrl: e.target.value.trim() });
$("llmTest").onclick = async () => {
  $("llmInfo").textContent = "⏳ بيختبر...";
  const r = await send({ type: "llm-test" });
  if (!r) return;
  $("llmInfo").textContent = r.info;
  if (r.models) { const dl = $("llmModels"); dl.innerHTML = ""; for (const m of r.models) dl.appendChild(new Option(m)); }
};
$("llmPull").onclick = async () => {
  $("llmInfo").textContent = "⬇️ بينزّل النموذج (ممكن ياخد دقايق حسب النت)... سيب الإضافة مفتوحة";
  const r = await send({ type: "llm-pull" });
  $("llmInfo").textContent = r ? `✅ اتنزّل: ${r}` : $("llmInfo").textContent;
};
// Claude access switch: on for 3 hours
function renderDev(settings) {
  if (!$("devBridge")) return; // not in the standalone build
  const until = Number(settings.devBridgeUntil) || 0, on = until > Date.now();
  $("devBridge").checked = on;
  $("devBridgeInfo").textContent = on
    ? `✅ شغال — هيتقفل لوحده الساعة ${new Date(until).toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" })}`
    : "بيتقفل لوحده بعد 3 ساعات. بيشتغل بس مع برنامج Claude على نفس الجهاز (127.0.0.1)، ومفيش حاجة بتخرج بره.";
}
if ($("devBridge")) $("devBridge").onchange = (e) => saveSettings({ devBridgeUntil: e.target.checked ? Date.now() + 3 * 3600000 : 0 });

$("llmNow").onclick = async () => {
  toast("🎓 الـ AI بيذاكر اللعبة... ممكن ياخد دقايق، تقدر تقفل النافذة");
  const r = await send({ type: "train" });
  const { settings, llmError } = await chrome.storage.local.get(["settings", "llmError"]);
  await renderPlan(settings || {}, llmError);
  toast(r && r.error ? "⚠ " + r.error : r && r.book ? "✅ الوكيل اتدرّب — الكتيّب في تابة المخ" : "⚠ " + (llmError || "التدريب ماخلصش"), !(r && r.book));
};


// ---------- selling / farms / watchdog settings ----------
const NUM_SETTINGS = { sellKeepMin: 30, sellMaxEach: 500, sellReserve: 0, sceneMinMin: 3, sceneMaxMin: 20, goalCoins: 100000000, stockTarget: 5000, stockSurplus: 5000, sellCashFloor: 2000000, sellBarnTrigger: 10000000 };
const BOOL_SETTINGS = { sellOn: true, sellSurplus: true, scenesOn: true, watchdog: true, dailyReloadOn: true, fOrders: true, fShipOrders: true, fFertilize: true, fDryer: true, fGiftCoins: true, fSocial: true, fCrafts: true, fEvents: true, fMachineSwitch: true, llmOn: true };
for (const k in NUM_SETTINGS) $(k).onchange = (e) => saveSettings({ [k]: Math.max(0, Number(e.target.value) || 0) });
for (const k in BOOL_SETTINGS) $(k).onchange = (e) => saveSettings({ [k]: e.target.checked });

async function loadSellPlan() {
  const r = await send({ type: "farm", action: "sell-plan" });
  const ul = $("sellPlan");
  ul.innerHTML = "";
  if (!r) return;
  if (!r.plan.length) { ul.innerHTML = '<li class="empty">مفيش حاجة محتاجة تتباع دلوقتي</li>'; return; }
  for (const x of r.plan) {
    const li = document.createElement("li");
    li.innerHTML = '<span><span class="name"></span> <span class="count"></span></span><span class="badge ready"></span>';
    li.querySelector(".name").textContent = x.name;
    li.querySelector(".count").textContent = "×" + x.n;
    li.querySelector(".badge").textContent = "+" + Number(x.coins).toLocaleString() + " 🪙";
    ul.appendChild(li);
  }
}
$("sellNow").onclick = async () => { await runFarm("sell", "💰 بيبيع..."); loadSellPlan(); };

// ---------- mode: full agent / manual ----------
function renderMode(mode) {
  document.body.classList.toggle("agent-mode", mode === "agent");
  for (const b of $("modeSel").children) b.classList.toggle("on", b.dataset.v === mode);
}
for (const b of $("modeSel").children) {
  b.onclick = () => {
    renderMode(b.dataset.v);
    saveSettings(b.dataset.v === "agent" ? { mode: "agent", paused: false } : { mode: "manual" });
    toast(b.dataset.v === "agent" ? "🤖 الوكيل الكامل اشتغل — هيعمل كل حاجة لوحده" : "🛠 التحكم اليدوي");
  };
}

$("botOn").onchange = async (e) => {
  const { settings } = await getAll();
  saveSettings(isAgent(settings) ? { paused: !e.target.checked } : { botOn: e.target.checked });
  toast(e.target.checked ? "🤖 البوت اشتغل — هيفضل شغال طول ما اللعبة مفتوحة" : "⏸ البوت وقف");
};
// ---------- smart planting ----------
const MODE_HELP = {
  agent: "🤖 بيحسب كل حاجة لوحده: الأول اللي المكن والحيوانات محتاجاه، والأرض الباقية بأعلى بذرة ربح في الساعة " +
    "(وبيحسب إن المحصول اللي هيجهز وهو مستريح هيستنى لحد ما يرجع). البذرة اللي تحت مش بتتستخدم.",
  smart: "🧠 بيزرع اللي المكن والحيوانات محتاجاه (مكنة ← خاماتها ← … ← البذرة)، والأرض الباقية بالبذرة اللي تحت.",
  manual: ""
};
function renderSeedMode(v) {
  for (const b of $("seedMode").children) b.classList.toggle("on", b.dataset.v === v);
  $("smartBox").hidden = v === "manual";
  $("modeHelp").textContent = MODE_HELP[v] || "";
  $("seedMeta").dataset.mode = v;
}
for (const b of $("seedMode").children) {
  b.onclick = () => { renderSeedMode(b.dataset.v); saveSettings({ seedMode: b.dataset.v }); if (b.dataset.v !== "manual") loadPlan(); };
}
async function loadPlan() {
  if (!isGameTab()) return;
  const r = await send({ type: "farm", action: "plan" });
  const ul = $("planList");
  ul.innerHTML = "";
  if (!r) return;
  if (!r.plan.length) {
    ul.innerHTML = `<li class="empty">${r.soils ? "المكن والحيوانات مش محتاجين حاجة دلوقتي — هيزرع البذرة اللي تحت" : "مفيش أرض فاضية"}</li>`;
    return;
  }
  for (const x of r.plan) {
    const li = document.createElement("li");
    li.innerHTML = '<span><span class="name"></span> <span class="count"></span></span><span class="badge ready"></span>';
    li.querySelector(".name").textContent = x.name;
    li.querySelector(".count").textContent = "×" + x.n;
    li.querySelector(".badge").textContent = "لـ " + x.for.slice(0, 2).join("، ");
    ul.appendChild(li);
  }
  if (r.left) ul.insertAdjacentHTML("beforeend", `<li class="empty">والباقي (${r.left}) بالبذرة اللي تحت</li>`);
}

// ---------- rest ----------
$("restOn").onchange = (e) => saveSettings({ restOn: e.target.checked });
$("restFrom").onchange = (e) => saveSettings({ restFrom: e.target.value });
$("restTo").onchange = (e) => saveSettings({ restTo: e.target.value });
$("dailyReload").onchange = (e) => saveSettings({ dailyReload: e.target.value || "08:00" });

function renderSpeed(v) {
  for (const b of $("botSpeed").children) b.classList.toggle("on", b.dataset.v === v);
}
for (const b of $("botSpeed").children) {
  b.onclick = (e) => { e.preventDefault(); renderSpeed(b.dataset.v); saveSettings({ botSpeed: b.dataset.v }); };
}
$("botInterval").onchange = (e) => saveSettings({ botInterval: Math.max(2, Number(e.target.value) || 5) });

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local" || !(ch.botStatus || ch.settings || ch.seedUsage || ch.trainState || ch.llmError)) return;
  const { settings, botStatus, seedUsage: usage } = await getAll();
  if (ch.settings) {
    $("botOn").checked = botEnabled(settings);
    renderMode(settings.mode || "agent");
    if ((settings.seedId || "") !== currentSeedId) { currentSeedId = settings.seedId || ""; renderSeedCard(); }
  }
  if (ch.seedUsage) { seedUsage = usage; if (!$("seedSheet").hidden) renderSeeds(); }
  if (ch.settings || ch.llmError || ch.trainState || ch.botStatus) renderPlan(settings, (await chrome.storage.local.get("llmError")).llmError);
  if (ch.settings) renderDev(settings);
  renderBot(botStatus, botEnabled(settings));
});

// ---------- actions ----------

const ACTION_BUTTONS = ["farmAll", "farmHarvest", "farmPlant", "farmAnimals", "farmMachines"];

async function runFarm(action, label) {
  if (!isGameTab()) return toast("⚠ افتح صفحة اللعبة على فيسبوك الأول", true);
  ACTION_BUTTONS.forEach((id) => ($(id).disabled = true));
  if (label) toast(label);
  try {
    const r = await send({ type: "farm", action });
    if (!r) return;
    renderFarm(r);
    if (action === "status") return;
    const d = r.done, parts = [];
    if (d.harvested || d.trees) parts.push(`🌾 ${d.harvested} • 🍌 ${d.trees}`);
    if (d.collected || d.fed) parts.push(`🐄 جمع ${d.collected} • أكل ${d.fed}`);
    if (d.mCollected || d.mRefilled) parts.push(`⚙️ جمع ${d.mCollected} • تعبئة ${d.mRefilled}`);
    if (d.planted) parts.push(`🌱 ${d.planted}`);
    const w = r.warnings && r.warnings.length ? ` — ⚠ ${r.warnings[r.warnings.length - 1]}` : "";
    toast((parts.length ? "✅ " + parts.join(" | ") : "✅ مفيش حاجة جاهزة دلوقتي") + w);
  } finally {
    ACTION_BUTTONS.forEach((id) => ($(id).disabled = false));
  }
}

$("farmAll").onclick = () => runFarm("all", "⚡ شغال على المزرعة كلها...");
$("farmHarvest").onclick = () => runFarm("harvest", "🌾 بيحصد...");
$("farmPlant").onclick = () => runFarm("plant", "🌱 بيزرع...");
$("farmAnimals").onclick = () => runFarm("animals", "🐄 بيجمّع ويأكّل واحد واحد...");
$("farmMachines").onclick = () => runFarm("machines", "⚙️ بيجمّع ويعبّي واحدة واحدة...");
$("farmStatus").onclick = () => runFarm("status");
$("farmStop").onclick = () => { send({ type: "stop" }); toast("⏹ اتوقف"); };

async function saveFarmOpts() {
  const farm = {};
  for (const k of FARM_OPTS) farm[k] = $(k).checked;
  await saveSettings({ farm });
}
for (const k of FARM_OPTS) $(k).onchange = saveFarmOpts;
$("autoPlantOnPick").onchange = (e) => saveSettings({ autoPlantOnPick: e.target.checked });

// ---------- seeds ----------

const seedById = (id) => seeds.find((s) => String(s.id) === String(id));
const seedMeta = (s) => `⏱ ${s.hours} ساعة • 🪙 ${s.price} • مستوى ${s.level}`;

function renderSeedCard() {
  const s = seedById(currentSeedId);
  $("seedName").textContent = s ? s.name : currentSeedId ? `بذرة #${currentSeedId}` : "⭐ تلقائي";
  $("seedMeta").textContent = s ? seedMeta(s) : "أكتر بذرة موجودة في المزرعة";
}

function seedButton(s, tag) {
  const b = document.createElement("button");
  b.className = "seed-item" + (String(s.id) === String(currentSeedId) ? " current" : "");
  b.innerHTML = '<span class="seed-emoji">🌱</span><span class="seed-text"><b></b><small></small></span>';
  b.querySelector("b").textContent = s.name;
  b.querySelector("small").textContent = seedMeta(s);
  if (tag) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = tag;
    b.appendChild(t);
  }
  b.onclick = () => pickSeed(s.id);
  return b;
}

function renderSeeds() {
  const list = $("seedList");
  list.innerHTML = "";
  const q = $("seedSearch").value.trim();
  const onlyMine = $("seedLevelOnly").checked && playerLevel > 0;
  const visible = seeds.filter((s) => (!onlyMine || s.level <= playerLevel) && (!q || s.name.includes(q)));

  const auto = document.createElement("button");
  auto.className = "seed-item" + (!currentSeedId ? " current" : "");
  auto.innerHTML = '<span class="seed-emoji">⭐</span><span class="seed-text"><b>تلقائي</b><small>أكتر بذرة موجودة في المزرعة</small></span>';
  auto.onclick = () => pickSeed("");
  if (!q) list.appendChild(auto);

  const fav = visible.filter((s) => seedUsage[s.id] > 0).sort((a, b) => seedUsage[b.id] - seedUsage[a.id]).slice(0, 8);
  if (fav.length) {
    list.insertAdjacentHTML("beforeend", "<h4>⭐ بتزرعهم كتير</h4>");
    for (const s of fav) list.appendChild(seedButton(s, `${seedUsage[s.id]} مرة`));
  }
  list.insertAdjacentHTML("beforeend", `<h4>كل البذور (${visible.length})</h4>`);
  const favIds = new Set(fav.map((s) => s.id));
  for (const s of visible) if (!favIds.has(s.id)) list.appendChild(seedButton(s));
  if (!seeds.length) list.insertAdjacentHTML("beforeend", '<p class="muted">افتح اللعبة واستنى تحمّل عشان أقرأ البذور</p>');
}

async function pickSeed(id) {
  currentSeedId = String(id || "");
  $("seedSheet").hidden = true;
  const { settings, seedUsage: usage } = await getAll();
  if (id) {
    usage[id] = (usage[id] || 0) + 1;
    seedUsage = usage;
    await chrome.storage.local.set({ seedUsage: usage, settings: { ...settings, seedId: currentSeedId } });
  } else {
    await saveSettings({ seedId: "" });
  }
  renderSeedCard();
  const s = seedById(id);
  if ($("autoPlantOnPick").checked) runFarm("plant", `🌱 بيزرع ${s ? s.name : "تلقائي"} في كل الأرض الفاضية...`);
  else toast(`✔ البذرة: ${s ? s.name : "تلقائي"}`);
}

$("seedCard").onclick = () => {
  $("seedSheet").hidden = false;
  $("seedSearch").value = "";
  renderSeeds();
  $("seedSearch").focus();
};
$("seedBack").onclick = () => ($("seedSheet").hidden = true);
$("seedSearch").oninput = renderSeeds;
$("seedLevelOnly").onchange = renderSeeds;

async function loadSeeds() {
  const r = await send({ type: "farm", action: "seeds" });
  if (!r || !r.seeds.length) return;
  seeds = r.seeds;
  playerLevel = r.level;
  chrome.storage.local.set({ seedsCache: { seeds, level: playerLevel } });
  $("seedLevelOnly").closest("label").style.display = playerLevel ? "" : "none";
  renderSeedCard();
  if (!$("seedSheet").hidden) renderSeeds();
}

// ---------- advanced reports ----------

async function saveReport(type, file) {
  if (!isGameTab()) return toast("⚠ افتح صفحة اللعبة الأول", true);
  toast("⏳ بيجهّز التقرير...");
  const r = await send({ type });
  if (!r) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r)], { type: "application/json" }));
  a.download = file;
  a.click();
  toast("💾 اتحفظ في Downloads");
}
$("apiScan").onclick = () => saveReport("api-scan", "family-farm-api.json");
$("deepScan").onclick = () => saveReport("deep-scan", "family-farm-deep.json");
$("netScan").onclick = () => saveReport("scan", "family-farm-network.json");
$("econScan").onclick = () => saveReport("econ-scan", "family-farm-econ.json");
$("capsScan").onclick = () => saveReport("caps-scan", "family-farm-caps.json");
$("worldScan").onclick = () => saveReport("world-scan", "family-farm-world.json");

// ---------- init ----------

(async () => {
  await tabReady;
  const { settings, botStatus, seedUsage: usage, seedsCache } = await getAll();
  seedUsage = usage;
  currentSeedId = settings.seedId || "";
  for (const k of FARM_OPTS) if (settings.farm && k in settings.farm) $(k).checked = settings.farm[k];
  $("autoPlantOnPick").checked = settings.autoPlantOnPick !== false;
  renderMode(settings.mode || "agent");
  $("botOn").checked = botEnabled(settings);
  if (settings.botInterval) $("botInterval").value = settings.botInterval;
  renderSpeed(settings.botSpeed || "turbo");
  renderSeedMode(settings.seedMode || "agent");
  for (const k in NUM_SETTINGS) $(k).value = settings[k] ?? NUM_SETTINGS[k];
  $("llmKey").value = settings.llmKey || "";
  const prov = settings.llmProvider || "ollama";
  renderProvider(prov);
  $("llmUrl").value = settings.llmUrl || "http://localhost:11434";
  if (prov === "anthropic") $("llmModelA").value = settings.llmModel || "claude-opus-5-5";
  else $("llmModel").value = settings.llmModel || "qwen2.5:7b";
  renderPlan(settings, (await chrome.storage.local.get("llmError")).llmError);
  renderDev(settings);
  for (const k in BOOL_SETTINGS) $(k).checked = settings[k] ?? BOOL_SETTINGS[k];
  $("restOn").checked = settings.restOn !== false;
  if (settings.restFrom) $("restFrom").value = settings.restFrom;
  if (settings.restTo) $("restTo").value = settings.restTo;
  if (settings.dailyReload) $("dailyReload").value = settings.dailyReload;
  if (settings.lastTab) document.querySelector(`.tab[data-tab="${settings.lastTab}"]`)?.click();
  if (seedsCache) { seeds = seedsCache.seeds; playerLevel = seedsCache.level; }
  if (!playerLevel) $("seedLevelOnly").closest("label").style.display = "none";
  renderSeedCard();
  renderBot(botStatus, botEnabled(settings));
  if (!isGameTab()) return toast("افتح اللعبة على فيسبوك عشان البوت يشتغل");
  await runFarm("status");
  if ((settings.seedMode || "agent") !== "manual") loadPlan();
  loadSellPlan();
  await loadSeeds();
})();
