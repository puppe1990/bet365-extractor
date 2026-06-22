const FIELD_KV_RE = /\b([A-Z][A-Z0-9]{1,3})=([^|\x00-\x1f\x14]{1,200})/g;
const SCORE_PAIR_RE = /\b(?:SC|SS)=(\d{1,2})[-–](\d{1,2})\b/gi;
const S1S2_RE = /\bS1=(\d{1,2})[\s\S]{0,60}?\bS2=(\d{1,2})\b/gi;
const CLOCK_RE = /\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/gi;

export function parseBet365WireFields(text) {
  const fields = {};
  if (!text) return fields;

  const flat = String(text);
  let m;
  const re = new RegExp(FIELD_KV_RE.source, "g");

  while ((m = re.exec(flat)) !== null) {
    const key = m[1];
    const value = m[2].trim();
    if (!value) continue;
    if (!(key in fields)) fields[key] = value;
  }

  return fields;
}

export function scanBet365WireText(text, limit = 2_000_000) {
  const sample = String(text || "").slice(0, limit);
  const matches = [];
  const clocks = new Set();

  const pushScore = (home, away, index, tag) => {
    const h = parseInt(home, 10);
    const a = parseInt(away, 10);
    if (!Number.isFinite(h) || !Number.isFinite(a) || h > 30 || a > 30) return;
    const window = sample.slice(Math.max(0, index - 120), index + 160);
    let clock = null;
    const cm = window.match(/\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/i);
    if (cm) {
      const mins = parseInt(cm[1], 10);
      if (mins <= 130) clock = `${mins}:${cm[2]}`;
    }
    matches.push({
      score: `${h}-${a}`,
      scoreHome: h,
      scoreAway: a,
      clock,
      tag,
    });
  };

  let sm;
  while ((sm = SCORE_PAIR_RE.exec(sample)) !== null) {
    pushScore(sm[1], sm[2], sm.index, "SC");
  }

  while ((sm = S1S2_RE.exec(sample)) !== null) {
    pushScore(sm[1], sm[2], sm.index, "S1S2");
  }

  let cm;
  while ((cm = CLOCK_RE.exec(sample)) !== null) {
    const mins = parseInt(cm[1], 10);
    if (mins <= 130) clocks.add(`${mins}:${cm[2]}`);
  }

  return {
    fields: parseBet365WireFields(sample),
    matches,
    clocks: [...clocks],
  };
}

export function matchFromBet365Fields(fields, source = "net-ws") {
  if (!fields || typeof fields !== "object") return null;

  let scoreHome = null;
  let scoreAway = null;

  const sc = fields.SC || fields.SS;
  if (sc) {
    const parts = String(sc).split(/[-–]/);
    if (parts.length === 2) {
      scoreHome = parseInt(parts[0], 10);
      scoreAway = parseInt(parts[1], 10);
    }
  }

  if (scoreHome == null && fields.S1 != null && fields.S2 != null) {
    scoreHome = parseInt(fields.S1, 10);
    scoreAway = parseInt(fields.S2, 10);
  }

  if (!Number.isFinite(scoreHome) || !Number.isFinite(scoreAway)) return null;
  if (scoreHome > 30 || scoreAway > 30) return null;

  let clock = null;
  const rawClock = fields.TU || fields.TM || fields.TC;
  if (rawClock) {
    const cm = String(rawClock).match(/^(\d{1,3})[:;](\d{2})$/);
    if (cm && parseInt(cm[1], 10) <= 130) clock = `${cm[1]}:${cm[2]}`;
  }

  return {
    score: `${scoreHome}-${scoreAway}`,
    scoreHome,
    scoreAway,
    clock,
    status: fields.ST || fields.STATUS || null,
    homeTeam: fields.NA || fields.HN || null,
    awayTeam: fields.N2 || fields.AN || null,
    source,
  };
}

export function extractFromBet365WirePayload(text, source = "net-text") {
  const scanned = scanBet365WireText(text);
  const fromFields = matchFromBet365Fields(scanned.fields, source);
  if (fromFields) return fromFields;

  if (!scanned.matches.length) return null;

  const best = scanned.matches[scanned.matches.length - 1];
  const clock = best.clock || scanned.clocks[scanned.clocks.length - 1] || null;

  return {
    score: best.score,
    scoreHome: best.scoreHome,
    scoreAway: best.scoreAway,
    clock,
    source,
  };
}

export function isBet365BlobUrl(url) {
  return /\/Api\/1\/Blob\b/i.test(String(url || ""));
}

export function isBet365ZapUrl(url) {
  return /sportspublisher\/zap/i.test(String(url || ""));
}

export function extractNetworkHints(text, url = "") {
  const scanned = scanBet365WireText(text, isBet365BlobUrl(url) ? 2_000_000 : 120_000);
  const match = extractFromBet365WirePayload(text, isBet365ZapUrl(url) ? "net-ws" : "net-blob");
  const fieldKeys = Object.keys(scanned.fields).slice(0, 24);

  return {
    fieldKeys,
    fields: scanned.fields,
    matches: scanned.matches.slice(-5),
    clocks: scanned.clocks.slice(-5),
    match,
    blobUrl: isBet365BlobUrl(url),
    zapUrl: isBet365ZapUrl(url),
  };
}