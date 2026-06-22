(function bet365PageNetworkSniffer() {
  if (window.__bet365PageSnifferInstalled) return;
  window.__bet365PageSnifferInstalled = true;

  const HOST_RE = /bet365/i;
  const PAYLOAD_HINTS =
    /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\d+/i;
  const MAX_RAW = 12000;
  const MAX_RAW_ZAP = 500_000;
  const MAX_BLOB_SCAN = 2_000_000;
  const MAX_ZAP_BUFFER = 2_000_000;
  const zapWireBuffer = { text: "", len: 0 };
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

  const LINEUP_WIRE_SOURCE_RE = /ipe\/5378|ipe-BR|sportspublisher\/zap|zap-ws/i;
  const LINEUP_BLOB_URL_RE = /ipe\/5378|ipe-BR/i;
  const LINEUP_UI_BLOCK_RE =
    /Informa|Configura|Idioma|Ajuda|Dep[oó]sito|Promo|Resultados|Not[ií]cias|Empregos|Parceiros|bet365|Facebook|Instagram|Logo|Servidor|reCAPTCHA|Regras|Promoções|Áudio|Futebol|Estatísticas|Esportes|Sites|Jogue com|Todos os|Ao-Vivo|Minhas Apostas|Cassino|Popular|Criar Aposta|Instantâneas|Intervalo|Marcadores|Tabela|Cronologia|Escalação/i;
  const LINEUP_PLAYER_SHORT_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30}$/;
  const LINEUP_PLAYER_FULL_RE =
    /^[A-ZÀ-Ú][a-zà-ú'`-]+(?:\s+[A-ZÀ-Ú][a-zà-ú'`.-]+){1,4}$/;

  function isLineupPlayerName(name) {
    if (!name || name.length > 40) return false;
    if (LINEUP_UI_BLOCK_RE.test(name)) return false;
    if (!LINEUP_PLAYER_SHORT_RE.test(name) && !LINEUP_PLAYER_FULL_RE.test(name)) return false;
    if (/\d/.test(name)) return false;
    return true;
  }

  function readLineupWireContext(ctx) {
    const out = { sub: false, team: null, order: null, shots: null, onTarget: null };
    for (const m of ctx.matchAll(/\b(SU|OR|TM|HI|SH|ST|S1|S2)=(\d{1,3})/g)) {
      const key = m[1];
      const val = parseInt(m[2], 10);
      if (!Number.isFinite(val)) continue;
      if (key === "SU" && val === 1) out.sub = true;
      if (key === "OR") out.order = val;
      if (key === "TM" || key === "HI") out.team = val;
      if (key === "SH" || key === "S1") out.shots = String(val);
      if (key === "ST" || key === "S2") out.onTarget = String(val);
    }
    return out;
  }

  function appendZapWire(text) {
    const chunk = String(text || "");
    if (!chunk) return;
    if (zapWireBuffer.len + chunk.length > MAX_ZAP_BUFFER) return;
    zapWireBuffer.text += (zapWireBuffer.text ? "\n" : "") + chunk;
    zapWireBuffer.len += chunk.length;
  }

  function extractLineupHints(sample, url) {
    if (!LINEUP_WIRE_SOURCE_RE.test(url)) return null;
    const players = [];
    const seen = new Set();
    const recordRe =
      /(?:\||^|;|\x14)(?:PG|PA|SL|PI|OV|EV|MG);([^|]{0,320})|(?:\||^)(PA;[^|]{0,320})/gi;

    let rm;
    while ((rm = recordRe.exec(sample)) !== null) {
      const chunk = rm[1] || rm[2] || "";
      const na = chunk.match(/\bNA=([^|;\x00-\x1f\x14]{2,40})/);
      if (!na) continue;
      const name = na[1].trim();
      if (!isLineupPlayerName(name)) continue;
      const ctx = readLineupWireContext(chunk);
      const key = `${name}|${ctx.team ?? ""}|${ctx.order ?? ""}|${ctx.sub ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      players.push({ name, ...ctx });
    }

    if (players.length < 8) {
      for (const m of sample.matchAll(/\bNA=([^|;\x00-\x1f\x14]{2,40})/g)) {
        const name = m[1].trim();
        if (!isLineupPlayerName(name)) continue;
        const ctx = readLineupWireContext(sample.slice(m.index, m.index + 140));
        const key = `${name}|${ctx.team ?? ""}|${ctx.order ?? ""}|${ctx.sub ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        players.push({ name, ...ctx });
      }
    }

    return players.length >= 8 ? players.slice(0, 40) : null;
  }

  function extractHints(text, url) {
    const limit = isBlobUrl(url) ? MAX_BLOB_SCAN : isZapUrl(url) ? MAX_ZAP_BUFFER : 120000;
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
    const lineupSource = isZapUrl(url) ? "ws:sportspublisher/zap" : url;
    const lineupSample = isZapUrl(url) ? zapWireBuffer.text || sample : sample;
    const lineupPlayers = extractLineupHints(lineupSample, lineupSource);
    return {
      fieldKeys,
      fields: fieldKeys.length ? fields : null,
      matches: matches.slice(-5),
      clocks: [...clocks].slice(-5),
      lineupPlayers,
      zapBufferLen: isZapUrl(url) ? zapWireBuffer.len : null,
      blob: isBlobUrl(url),
      zap: isZapUrl(url),
    };
  }

  function shouldCapture(url, data, hints) {
    if (isZapUrl(url)) return true;
    if (HOST_RE.test(url)) return true;
    if (hints?.matches?.length || hints?.clocks?.length || hints?.fieldKeys?.length) return true;
    const sample =
      typeof data === "string" ? data.slice(0, 4000) : JSON.stringify(data || "").slice(0, 4000);
    return PAYLOAD_HINTS.test(sample);
  }

  function emit(url, data, kind) {
    const u = resolveUrl(url);
    const rawText = typeof data === "string" ? data : null;
    if (rawText && isZapUrl(u)) appendZapWire(rawText);
    const hints = rawText ? extractHints(rawText, u) : null;
    const payload = rawText
      ? rawText.slice(0, isBlobUrl(u) ? MAX_RAW : isZapUrl(u) ? MAX_RAW_ZAP : MAX_RAW)
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