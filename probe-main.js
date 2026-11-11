// Farm Macro - network probe (runs in the page's MAIN world, every frame, at document_start)
// Logs what the game sends/receives (WebSocket, fetch, XHR, postMessage) so we can
// learn its data format. Read back by background.js via window.__fmProbeLog().
(() => {
  if (window.__fmProbeLog) return;
  // Only the game's own frame — never facebook.com itself (it carries personal data).
  if (!/^apps-\d+\.apps\.fbsbx\.com$|centurygames?\./i.test(location.hostname)) return;

  window.__fmBaseline = new Set(Object.keys(window));

  // ---- keep running in the background ----
  // Egret (egret.web.WebLifeCycleHandler) pauses the whole game on window "blur" and when the page is hidden
  // (minimized, other tab, other app in front), and Chrome stops requestAnimationFrame in hidden pages and
  // slows timers to once a minute. The game's tap queue runs on those frames, so the bot stalls.
  // 1) the game never hears blur / hidden: those listeners are not registered and document.hidden reads false
  // 2) a Web Worker ticks ~30x/s (worker timers aren't throttled): any animation frame Chrome didn't deliver
  //    within 40 ms is run from the worker tick; window.__fmTimer gives the bot unthrottled timers too
  try {
    const PAUSE_EVENTS = new Set(["blur", "visibilitychange", "webkitvisibilitychange", "mozvisibilitychange", "msvisibilitychange", "pagehide", "freeze"]);
    for (const T of [window.EventTarget && EventTarget.prototype]) {
      if (!T) continue;
      const add = T.addEventListener;
      T.addEventListener = function (type, fn, opts) {
        if ((this === window || this === document) && PAUSE_EVENTS.has(String(type))) return; // the game must not pause
        return add.call(this, type, fn, opts);
      };
    }
    const hid = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    const vis = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    const realHidden = () => !!(hid && hid.get && hid.get.call(document));
    window.__fmRealHidden = realHidden;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "webkitHidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    if (vis) Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
    if (document.hasFocus) document.hasFocus = () => true;

    // worker clock
    const timers = new Map();
    let tid = 0, worker = null;
    try {
      const src = "setInterval(function(){postMessage(0)},33)";
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    } catch (e) { worker = null; }
    window.__fmBgRunner = { worker: !!worker, since: Date.now(), ticks: 0, rescued: 0 };
    const nativeRAF = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
    const nativeCAF = window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window);
    const frames = new Map();
    let fid = 0;
    if (nativeRAF && worker) {
      window.requestAnimationFrame = function (cb) {
        const id = ++fid;
        const nid = nativeRAF((t) => { if (frames.delete(id)) cb(t); });
        frames.set(id, { cb, nid, at: performance.now() });
        return id;
      };
      window.webkitRequestAnimationFrame = window.requestAnimationFrame;
      window.cancelAnimationFrame = function (id) {
        const f = frames.get(id);
        if (f) { frames.delete(id); nativeCAF && nativeCAF(f.nid); }
      };
    }
    if (worker) {
      worker.onmessage = () => {
        const now = performance.now();
        window.__fmBgRunner.ticks++;
        // animation frames Chrome is holding back (hidden / minimized / occluded window)
        if (frames.size) {
          const late = [];
          for (const [id, f] of frames) if (now - f.at > 40) late.push([id, f]);
          for (const [id, f] of late) {
            frames.delete(id); nativeCAF && nativeCAF(f.nid);
            window.__fmBgRunner.rescued++;
            try { f.cb(now); } catch (e) { setTimeout(() => { throw e; }); }
          }
        }
        // unthrottled timers for the bot
        if (timers.size) for (const [id, t] of [...timers]) if (now >= t.due) { timers.delete(id); try { t.fn(); } catch (e) {} }
      };
      window.__fmTimer = {
        setTimeout(fn, ms) { const id = ++tid; timers.set(id, { fn, due: performance.now() + Math.max(0, ms || 0) }); return id; },
        clearTimeout(id) { timers.delete(id); },
        sleep(ms) { return new Promise((r) => window.__fmTimer.setTimeout(r, ms)); }
      };
    }
  } catch (e) {
    window.__fmBgRunner = { error: String((e && e.message) || e) };
  }

  // The game can report a lost / out-of-sync session with alert(), which freezes this whole frame (bot
  // included) until someone clicks OK. Keep the text for the bot (it asks for a reload) instead.
  try {
    const STUCK = /جهاز\s*(?:آخر|اخر|تاني|ثاني|جديد)|(?:مكان|متصفح)\s*(?:آخر|اخر)|(?:logged|signed)\s*in\s*(?:from|on|at|elsewhere)|another\s*(?:device|location|browser|session)|غير\s*مت[زن]ا[مز]ن|يرج[ىي]\s*(?:إ|ا)عادة|(?:إ|ا)عادة\s*(?:ال)?(?:تحديث|تحميل|الدخول|تسجيل)|تحديث\s*الصفحة|(?:انقطع|فقد|فقدان|ضعف|مشكلة\s*في)\s*(?:ال)?(?:اتصال|شبكة)|خطأ\s*في\s*(?:ال)?(?:اتصال|شبكة|الخادم|السيرفر)|انتهت\s*(?:ال)?جلسة|out of sync|refresh the page|reload the page|connection (?:lost|error|failed)|network error|session (?:expired|timeout)|disconnected/i;
    const nativeAlert = window.alert && window.alert.bind(window);
    window.alert = function (msg) {
      const text = String(msg ?? "");
      if (STUCK.test(text)) { window.__fmAlert = { text, at: Date.now() }; return; }
      return nativeAlert && nativeAlert(msg);
    };
    const nativeConfirm = window.confirm && window.confirm.bind(window);
    window.confirm = function (msg) {
      const text = String(msg ?? "");
      if (STUCK.test(text)) { window.__fmAlert = { text, at: Date.now() }; return true; }
      return nativeConfirm ? nativeConfirm(msg) : false;
    };
  } catch (e) {}

  const MAXLEN = 600, MAX_HTTP = 200, MAX_SAMPLES = 60, MAX_MSG = 40;
  const SKIP = /\.(png|jpe?g|webp|gif|svg|mp3|ogg|wav|m4a|woff2?|ttf|css)(\?|$)/i;
  const clean = (s) =>
    String(s).replace(/((?:access_)?token|sig(?:nature)?|signed|fb_dtsg|lsd|session(?:_key)?|auth\w*|ticket|code|key)=([^&#"\s]+)/gi, "$1=***");
  const hexAscii = (u8, total = u8.length) => {
    const head = u8.slice(0, 64);
    const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const txt = [...head].map((b) => (b > 31 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    return `[bin ${total}B] ${hex} | ${txt}`;
  };
  const preview = (d) => {
    try {
      if (d == null) return "";
      if (typeof d === "string") return clean(d.slice(0, MAXLEN)) + (d.length > MAXLEN ? ` …(+${d.length - MAXLEN})` : "");
      if (d instanceof ArrayBuffer) return hexAscii(new Uint8Array(d));
      if (ArrayBuffer.isView(d)) return hexAscii(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      if (d instanceof Blob) return `[Blob ${d.size}B ${d.type}]`;
      if (d instanceof FormData || d instanceof URLSearchParams) return preview(String(new URLSearchParams(d)));
      return preview(JSON.stringify(d));
    } catch {
      return "[?]";
    }
  };

  const sockets = [], http = [], messages = [];
  let skippedAssets = 0;

  // ---- WebSocket ----
  const NativeWS = window.WebSocket;
  if (NativeWS) {
    function WS(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      const rec = { url: clean(url), sent: 0, recv: 0, samples: [] };
      sockets.push(rec);
      const add = (dir, data) => {
        rec[dir === ">" ? "sent" : "recv"]++;
        if (rec.samples.length >= MAX_SAMPLES) return;
        const i = rec.samples.push(`${dir} ${preview(data)}`) - 1;
        if (data instanceof Blob)
          data.slice(0, 64).arrayBuffer().then((b) => (rec.samples[i] = `${dir} ${hexAscii(new Uint8Array(b), data.size)}`));
      };
      const send = ws.send;
      ws.send = function (d) { add(">", d); return send.call(this, d); };
      ws.addEventListener("message", (e) => add("<", e.data));
      return ws;
    }
    WS.prototype = NativeWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) WS[k] = NativeWS[k];
    window.WebSocket = WS;
  }

  // ---- HTTP ----
  const addHttp = (method, url, status, type, req, res) => {
    url = String(url);
    if (SKIP.test(url)) return void skippedAssets++;
    if (http.length < MAX_HTTP) http.push({ method, url: clean(url).slice(0, 300), status, type, req: preview(req), res });
  };
  const bodyOf = (ct, len, read) => {
    if (/javascript|wasm|image|audio|font/.test(ct)) return Promise.resolve(`[${ct}]`);
    if (len > 1e6) return Promise.resolve(`[${ct} ${len}B]`);
    return read();
  };

  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      const p = nativeFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url || String(input);
      const method = init?.method || input?.method || "GET";
      p.then((r) => {
        const ct = r.headers.get("content-type") || "";
        if (SKIP.test(url)) return addHttp(method, url, r.status, ct);
        // Clone only when the body will really be read: an unread clone keeps the whole download in memory.
        const len = Number(r.headers.get("content-length")) || 0;
        if (http.length >= MAX_HTTP) return;
        if (/javascript|wasm|image|audio|video|font/.test(ct) || len > 1e6 || (!len && !/json|text|xml/.test(ct)))
          return addHttp(method, url, r.status, ct, init?.body, `[${ct || "?"}${len ? " " + len + "B" : ""}]`);
        const c = r.clone();
        bodyOf(ct, len, () =>
          /json|text|xml/.test(ct) ? c.text().then(preview) : c.arrayBuffer().then(preview)
        ).then((res) => addHttp(method, url, r.status, ct, init?.body, res), () => {});
      }, () => {});
      return p;
    };
  }

  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__fm = { m, u }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__fm;
    if (info) {
      this.addEventListener("loadend", () => {
        if (http.length >= MAX_HTTP) return;
        try {
          const ct = this.getResponseHeader("content-type") || "";
          const t = this.responseType;
          bodyOf(ct, 0, () => Promise.resolve(t === "" || t === "text" ? preview(this.responseText) : preview(this.response)))
            .then((res) => addHttp(info.m, info.u, this.status, ct, body, res));
        } catch {}
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- postMessage between frames (SDK <-> game) ----
  addEventListener("message", (e) => {
    if (messages.length < MAX_MSG) messages.push(`${clean(e.origin)}: ${preview(e.data)}`);
  }, true);

  Object.defineProperty(window, "__fmProbeLog", {
    value: () => ({ sockets, http, messages, skippedAssets }),
    configurable: true
  });
})();
