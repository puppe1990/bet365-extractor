(function bet365PageNetworkSniffer() {
  if (window.__bet365PageSnifferInstalled) return;
  window.__bet365PageSnifferInstalled = true;

  const HOST_RE = /bet365/i;
  const PAYLOAD_HINTS =
    /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\d+/i;
  const MAX_RAW = 12000;
  const MAX_BLOB_SCAN = 2_000_000;
  const FIELD_KV_RE = /\b([A-Z][A-Z0-9]{1,3})=([^|\x00-\x1f\x14]{1,200})/g;
  const SCORE_PAIR_RE = /\b(?:SC|SS)=(\d{1,2})[-–](\d{1,2})\b/gi;
  const S1S2_RE = /\bS1=(\d{1,2})[\s\S]{0,60}?\bS2=(\d{1,2})\b/gi;
  const CLOCK_RE = /\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/gi;

  function resolveUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof input === "object" && typeof input.url === "string") return input.url;
    return String(input);
  }

  function isBlobUrl(url) {
    return /\/Api\/1\/Blob\b/i.test(url);
  }

  function isZapUrl(url) {
    return /sportspublisher\/zap/i.test(url);
  }

  function extractHints(text, url) {
    const limit = isBlobUrl(url) ? MAX_BLOB_SCAN : 120000;
    const sample = String(text || "").slice(0, limit);
    const fields = {};
    let m;
    const re = new RegExp(FIELD_KV_RE.source, "g");
    while ((m = re.exec(sample)) !== null) {
      if (!(m[1] in fields)) fields[m[1]] = m[2].trim();
    }

    const matches = [];
    const clocks = new Set();

    while ((m = SCORE_PAIR_RE.exec(sample)) !== null) {
      matches.push({ score: `${m[1]}-${m[2]}`, tag: "SC" });
    }
    while ((m = S1S2_RE.exec(sample)) !== null) {
      matches.push({ score: `${m[1]}-${m[2]}`, tag: "S1S2" });
    }
    while ((m = CLOCK_RE.exec(sample)) !== null) {
      const mins = parseInt(m[1], 10);
      if (mins <= 130) clocks.add(`${mins}:${m[2]}`);
    }

    const fieldKeys = Object.keys(fields).slice(0, 24);
    return {
      fieldKeys,
      fields: fieldKeys.length ? fields : null,
      matches: matches.slice(-5),
      clocks: [...clocks].slice(-5),
      blob: isBlobUrl(url),
      zap: isZapUrl(url),
    };
  }

  function shouldCapture(url, data, hints) {
    if (HOST_RE.test(url)) return true;
    if (hints?.matches?.length || hints?.clocks?.length || hints?.fieldKeys?.length) return true;
    const sample =
      typeof data === "string" ? data.slice(0, 4000) : JSON.stringify(data || "").slice(0, 4000);
    return PAYLOAD_HINTS.test(sample);
  }

  function emit(url, data, kind) {
    const u = resolveUrl(url);
    const rawText = typeof data === "string" ? data : null;
    const hints = rawText ? extractHints(rawText, u) : null;
    const payload = rawText
      ? rawText.slice(0, isBlobUrl(u) ? MAX_RAW : MAX_RAW)
      : data && typeof data === "object"
        ? data
        : null;

    if (!payload || !shouldCapture(u, payload, hints)) return;

    window.postMessage(
      {
        channel: "bet365-extractor-net",
        entry: {
          url: u || `unknown:${kind}`,
          at: new Date().toISOString(),
          kind,
          data: payload,
          rawLen: rawText ? rawText.length : null,
          hints,
        },
      },
      "*"
    );
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

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const clone = res.clone();
        const ct = (clone.headers.get("content-type") || "").toLowerCase();
        const url = resolveUrl(args[0]);
        if (isBlobUrl(url) || ct.includes("javascript") || ct.includes("octet")) {
          const text = await clone.text().catch(() => null);
          if (text) emit(url, text, "fetch");
        } else if (ct.includes("json")) {
          const data = await clone.json().catch(() => null);
          if (data) emit(url, data, "fetch");
        } else if (ct.includes("text") || ct.includes("plain") || !ct) {
          const text = await clone.text().catch(() => null);
          if (text) emit(url, text, "fetch");
        }
      } catch (_) {}
      return res;
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bet365Url = resolveUrl(url);
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__bet365Url || "";
        const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
        const body = this.responseText;
        if (!body) return;
        if (isBlobUrl(url) || ct.includes("javascript") || ct.includes("octet")) {
          emit(url, body, "xhr");
        } else if (ct.includes("json")) {
          try {
            emit(url, JSON.parse(body), "xhr");
          } catch (_) {
            emit(url, body, "xhr");
          }
        } else {
          emit(url, body, "xhr");
        }
      } catch (_) {}
    });
    return XS.apply(this, args);
  };

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const Bet365WS = function (url, protocols) {
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      const wsUrl = resolveUrl(url);
      if (HOST_RE.test(wsUrl)) {
        ws.addEventListener("message", (ev) => {
          const text = decodeSocketData(ev.data);
          if (text) emit(`ws:${wsUrl}`, text, "ws");
        });
      }
      return ws;
    };
    Bet365WS.prototype = OrigWS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => {
      Object.defineProperty(Bet365WS, k, { value: OrigWS[k] });
    });
    window.WebSocket = Bet365WS;
  }
})();