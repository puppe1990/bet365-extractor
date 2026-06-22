import {
  extractFromBet365WirePayload,
  extractNetworkHints,
  isBet365BlobUrl,
} from "./bet365-protocol-decode.js";

export const BET365_HOST_RE = /bet365/i;
export { extractNetworkHints, isBet365BlobUrl };

export const NETWORK_PAYLOAD_HINTS =
  /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\d+/i;

export function resolveNetworkUrl(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    if (typeof input.url === "string") return input.url;
    if (input instanceof URL) return input.href;
  }
  return String(input);
}

export function isBet365NetworkUrl(url) {
  return BET365_HOST_RE.test(resolveNetworkUrl(url));
}

export function looksLikeBet365NetworkPayload(data) {
  if (data == null) return false;
  if (typeof data === "object") {
    const s = JSON.stringify(data).slice(0, 6000);
    return NETWORK_PAYLOAD_HINTS.test(s);
  }
  const text = String(data).slice(0, 6000);
  return NETWORK_PAYLOAD_HINTS.test(text);
}

export function parseNetworkPayload(input) {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) return input;

  const text = String(input).trim();
  if (!text) return null;

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch (_) {}
  }

  const structured = { _bet365Protocol: true, segments: [] };
  const parts = text.split(/[|;\n]/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {}
    }

    const kv = trimmed.match(/^([A-Za-z_]+)[=:](.+)$/);
    if (kv) {
      structured.segments.push({ key: kv[1], value: kv[2] });
      continue;
    }

    structured.segments.push({ key: null, value: trimmed });
  }

  return structured.segments.length ? structured : { _rawText: text.slice(0, 4000) };
}

export function extractClockFromNetworkText(text) {
  if (!text) return null;

  const patterns = [
    /\bTU[=;](\d{1,3})[:;](\d{2})\b/i,
    /\bTM[=;](\d{1,3})[:;](\d{2})\b/i,
    /\btime[=;](\d{1,3})[:;](\d{2})\b/i,
    /\belapsed[=;](\d{1,3})[:;](\d{2})\b/i,
  ];

  for (const re of patterns) {
    const m = String(text).match(re);
    if (!m) continue;
    const mins = parseInt(m[1], 10);
    if (mins > 130) continue;
    return `${mins}:${m[2]}`;
  }

  return null;
}

export function extractScoresFromNetworkText(text) {
  if (!text) return [];

  const found = [];
  const patterns = [
    /\bSC[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
    /\bSS[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
    /\bscore[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
    /"score"\s*:\s*"(\d{1,2})-(\d{1,2})"/gi,
    /"scoreHome"\s*:\s*(\d{1,2})[\s\S]{0,80}?"scoreAway"\s*:\s*(\d{1,2})/gi,
    /\bS1[=;](\d{1,2})[\s\S]{0,40}?\bS2[=;](\d{1,2})\b/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(String(text))) !== null) {
      const home = parseInt(m[1], 10);
      const away = parseInt(m[2], 10);
      if (!Number.isFinite(home) || !Number.isFinite(away) || home > 30 || away > 30) continue;
      found.push({
        score: `${home}-${away}`,
        scoreHome: home,
        scoreAway: away,
        clock: extractClockFromNetworkText(
          text.slice(Math.max(0, m.index - 80), m.index + 120)
        ),
      });
    }
  }

  return found;
}

export function matchCandidatesFromNetworkText(text, source = "net-text") {
  const scores = extractScoresFromNetworkText(text);
  const clock = extractClockFromNetworkText(text);

  const candidates = scores.map((s) => ({
    ...s,
    source,
    clock: s.clock || clock,
  }));

  const wire = extractFromBet365WirePayload(text, source);
  if (wire) candidates.push(wire);

  return candidates;
}