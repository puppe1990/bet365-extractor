const networkLog = [];
const MAX_NET = 120;

function receiveNetworkEntry(entry) {
  if (!entry) return;
  const keepRaw =
    typeof entry.data === "string" &&
    (/\/Api\/1\/Blob\b/i.test(entry.url || "") ||
      /sportspublisher\/zap/i.test(entry.url || "") ||
      (entry.data.length || 0) > 4000);
  const normalized = keepRaw
    ? entry.data
    : typeof entry.data === "string"
      ? (parseNetworkPayload(entry.data) ?? { _rawText: entry.data.slice(0, 4000) })
      : entry.data;

  networkLog.unshift({
    url: entry.url,
    at: entry.at || new Date().toISOString(),
    kind: entry.kind || "fetch",
    data: normalized ?? entry.data,
    rawLen: entry.rawLen ?? (typeof entry.data === "string" ? entry.data.length : null),
    hints: entry.hints || null,
  });
  if (networkLog.length > MAX_NET) networkLog.length = MAX_NET;
}

function pushNetwork(url, data, kind = "fetch") {
  const u = resolveNetworkUrl(url);
  const normalized =
    typeof data === "string"
      ? (parseNetworkPayload(data) ?? { _rawText: data.slice(0, 4000) })
      : data;

  if (!isBet365NetworkUrl(u) && !looksLikeBet365NetworkPayload(normalized ?? data)) return;

  receiveNetworkEntry({
    url: u || `unknown:${kind}`,
    kind,
    data: normalized ?? data,
    rawLen: typeof data === "string" ? data.length : null,
  });
}

function decodeSocketData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    try {
      return new TextDecoder("utf-8").decode(data);
    } catch (_) {
      return null;
    }
  }
  if (ArrayBuffer.isView(data)) {
    try {
      return new TextDecoder("utf-8").decode(data.buffer);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function installNetworkSniffer() {
  if (window.__bet365SnifferInstalled) return;
  window.__bet365SnifferInstalled = true;

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const clone = res.clone();
        const ct = (clone.headers.get("content-type") || "").toLowerCase();
        const url = resolveNetworkUrl(args[0]);
        if (ct.includes("json")) {
          const data = await clone.json().catch(() => null);
          if (data) pushNetwork(url, data, "fetch");
        } else if (ct.includes("text") || ct.includes("plain") || !ct) {
          const text = await clone.text().catch(() => null);
          if (text) pushNetwork(url, text, "fetch");
        }
      } catch (_) {}
      return res;
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bet365Url = resolveNetworkUrl(url);
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__bet365Url || "";
        const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
        const body = this.responseText;
        if (!body) return;
        if (ct.includes("json")) {
          pushNetwork(url, JSON.parse(body), "xhr");
        } else {
          pushNetwork(url, body, "xhr");
        }
      } catch (_) {}
    });
    return XS.apply(this, args);
  };

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const Bet365WS = function (url, protocols) {
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      const wsUrl = resolveNetworkUrl(url);

      if (isBet365NetworkUrl(wsUrl)) {
        ws.addEventListener("message", (ev) => {
          const text = decodeSocketData(ev.data);
          if (text) pushNetwork(`ws:${wsUrl}`, text, "ws");
        });
      }

      return ws;
    };
    Bet365WS.prototype = OrigWS.prototype;
    Object.defineProperty(Bet365WS, "CONNECTING", { value: OrigWS.CONNECTING });
    Object.defineProperty(Bet365WS, "OPEN", { value: OrigWS.OPEN });
    Object.defineProperty(Bet365WS, "CLOSING", { value: OrigWS.CLOSING });
    Object.defineProperty(Bet365WS, "CLOSED", { value: OrigWS.CLOSED });
    window.WebSocket = Bet365WS;
  }
}

function initNetworkBridge() {
  if (window.__bet365NetBridge) return;
  window.__bet365NetBridge = true;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.channel !== "bet365-extractor-net") return;
    receiveNetworkEntry(ev.data.entry);
  });
}

function injectPageNetworkSniffer(pageSnifferSource) {
  initNetworkBridge();
  const script = document.createElement("script");
  script.textContent = pageSnifferSource;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

/* __INSTALL_SNIFFER__ */
