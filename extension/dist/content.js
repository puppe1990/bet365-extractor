// Bet365 Chrome Extension — content script (built from parsers + this template)
(function bet365ExtensionContent() {
  "use strict";

  if (window.__bet365ExtractorReady) return;
  window.__bet365ExtractorReady = true;

  function parseNextGoalMarkets(odds) {
  const markets = [];

  for (const o of odds || []) {
    const m = String(o.market || "").match(/(\d+)\s*°\s*Gol/i);
    if (m) markets.push(parseInt(m[1], 10));
  }

  return [...new Set(markets)].sort((a, b) => b - a);
}

function minTotalGoalsFromOdds(odds) {
  const next = parseNextGoalMarkets(odds)[0];
  if (!next || next < 2) return null;
  return next - 1;
}

function scoreTotalFromMatch(match) {
  if (match?.scoreHome != null && match?.scoreAway != null) {
    return match.scoreHome + match.scoreAway;
  }
  if (!match?.score) return null;

  const parts = match.score.split("-").map((n) => parseInt(n, 10));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] + parts[1];
}

function isDrawFavored(odds) {
  const rf = (odds || []).filter((o) => /resultado\s*final/i.test(o.market));
  const empate = rf.find((o) => /^empate$/i.test(String(o.selection || "").trim()));
  const home = rf.find((o) => o !== empate && !/empate/i.test(String(o.selection || "")));

  if (!empate) return false;

  const homeOdd = home?.odds ?? 999;
  return empate.odds <= homeOdd * 0.85;
}

function suggestScoreForMinGoals(minGoals, drawFavored, currentHome, currentAway) {
  if (!minGoals || minGoals < 1) return null;

  if (drawFavored && minGoals % 2 === 0) {
    const each = minGoals / 2;
    return { score: `${each}-${each}`, scoreHome: each, scoreAway: each };
  }

  if (
    Number.isFinite(currentHome) &&
    Number.isFinite(currentAway) &&
    currentHome + currentAway < minGoals
  ) {
    const diff = minGoals - (currentHome + currentAway);
    if (drawFavored && currentHome >= currentAway) {
      return {
        score: `${currentHome}-${currentAway + diff}`,
        scoreHome: currentHome,
        scoreAway: currentAway + diff,
      };
    }
    return {
      score: `${currentHome + diff}-${currentAway}`,
      scoreHome: currentHome + diff,
      scoreAway: currentAway,
    };
  }

  return null;
}

function analyzeMarketScore(odds, match) {
  const nextGoalMarkets = parseNextGoalMarkets(odds);
  const minTotalGoals = minTotalGoalsFromOdds(odds);
  const domTotalGoals = scoreTotalFromMatch(match);
  const drawFavored = isDrawFavored(odds);

  const analysis = {
    nextGoalMarkets,
    minTotalGoals,
    domTotalGoals,
    drawFavored,
    consistent: domTotalGoals == null || minTotalGoals == null || domTotalGoals >= minTotalGoals,
    reasons: [],
  };

  if (minTotalGoals != null && domTotalGoals != null && domTotalGoals < minTotalGoals) {
    analysis.reasons.push(
      `Mercado ${nextGoalMarkets[0]}° Gol implica ≥${minTotalGoals} gols; DOM tem ${domTotalGoals} (${match?.score ?? "?"}).`
    );
  }

  if (drawFavored) {
    analysis.reasons.push("Empate favorito no Resultado Final.");
  }

  return analysis;
}

function applyMarketScoreInference(match, odds) {
  const analysis = analyzeMarketScore(odds, match);
  const result = { match: { ...match }, analysis, applied: false };

  if (analysis.minTotalGoals == null) return result;

  const missingScore = match?.score == null;
  const inconsistent =
    !missingScore &&
    analysis.domTotalGoals != null &&
    analysis.domTotalGoals < analysis.minTotalGoals;

  if (!missingScore && (analysis.consistent || !inconsistent)) return result;

  const home = Number.isFinite(match?.scoreHome)
    ? match.scoreHome
    : match?.score
      ? parseInt(String(match.score).split("-")[0], 10)
      : null;
  const away = Number.isFinite(match?.scoreAway)
    ? match.scoreAway
    : match?.score
      ? parseInt(String(match.score).split("-")[1], 10)
      : null;

  const suggested = suggestScoreForMinGoals(
    analysis.minTotalGoals,
    analysis.drawFavored,
    home,
    away
  );

  if (!suggested) {
    analysis.reasons.push("Não foi possível sugerir placar exato pelos mercados.");
    return result;
  }

  const canOverride =
    missingScore ||
    !match.clock ||
    match.scoreConfidence === "medium" ||
    match.scoreConfidence === "low" ||
    inconsistent;

  if (!canOverride) return result;

  result.applied = true;
  result.match = {
    ...match,
    score: suggested.score,
    scoreHome: suggested.scoreHome,
    scoreAway: suggested.scoreAway,
    scoreDom: match.score ?? null,
    scoreInferredFrom: "markets",
    scoreInference: {
      ...analysis,
      suggested,
      previousScore: match.score ?? null,
    },
  };

  if (missingScore) {
    analysis.reasons.push(
      `Placar inferido pelos mercados: ${suggested.score} (mín. ${analysis.minTotalGoals} gols).`
    );
  } else {
    analysis.reasons.push(
      `Placar ajustado: ${match.score} → ${suggested.score} (inferência por mercados).`
    );
  }

  return result;
}

const FIELD_KV_RE = /\b([A-Z][A-Z0-9]{1,3})=([^|\x00-\x1f\x14]{1,200})/g;
const SCORE_PAIR_RE = /\b(?:SC|SS)=(\d{1,2})[-–](\d{1,2})\b/gi;
const S1S2_RE = /\bS1=(\d{1,2})[\s\S]{0,60}?\bS2=(\d{1,2})\b/gi;
const CLOCK_RE = /\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/gi;

function parseBet365WireFields(text) {
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

function scanBet365WireText(text, limit = 2_000_000) {
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

function matchFromBet365Fields(fields, source = "net-ws") {
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

function extractFromBet365WirePayload(text, source = "net-text") {
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

function isBet365BlobUrl(url) {
  return /\/Api\/1\/Blob\b/i.test(String(url || ""));
}

function isBet365ZapUrl(url) {
  return /sportspublisher\/zap/i.test(String(url || ""));
}

function extractNetworkHints(text, url = "") {
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

const BET365_NETWORK_HOST_RE = /bet365/i;
const NETWORK_PAYLOAD_HINTS =
  /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\d+/i;

function resolveNetworkUrl(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    if (typeof input.url === "string") return input.url;
    if (input instanceof URL) return input.href;
  }
  return String(input);
}

function isBet365NetworkUrl(url) {
  return BET365_NETWORK_HOST_RE.test(resolveNetworkUrl(url));
}

function looksLikeBet365NetworkPayload(data) {
  if (data == null) return false;
  if (typeof data === "object") {
    const s = JSON.stringify(data).slice(0, 6000);
    return NETWORK_PAYLOAD_HINTS.test(s);
  }
  const text = String(data).slice(0, 6000);
  return NETWORK_PAYLOAD_HINTS.test(text);
}

function parseNetworkPayload(input) {
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

function extractClockFromNetworkText(text) {
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

function extractScoresFromNetworkText(text) {
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
        clock: extractClockFromNetworkText(text.slice(Math.max(0, m.index - 80), m.index + 120)),
      });
    }
  }

  return found;
}

function matchCandidatesFromNetworkText(text, source = "net-text") {
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

const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;

/** Live in-play: #/IP/EV151352326532C1/ */
const BET365_IP_EVENT_RE = /#\/IP\/EV\d+/i;

/** Pre-match / competition: #/AC/.../E194699812/... */
const BET365_AC_EVENT_RE = /\/E\d{6,}\b/i;

function extractBet365EventId(urlOrHash = "") {
  const hash = String(urlOrHash).includes("#")
    ? String(urlOrHash).split("#")[1] || ""
    : String(urlOrHash);

  const ev = hash.match(/EV\d{8,}/i);
  if (ev) return ev[0];

  const e = hash.match(/\/(E\d{6,})\b/i) || hash.match(/\b(E\d{6,})\b/i);
  if (e) return e[1];

  return null;
}

function isBet365MatchUrl(url) {
  if (!BET365_HOST_RE.test(url || "")) return false;
  const hash = String(url).split("#")[1] || "";
  if (!hash) return false;
  if (BET365_IP_EVENT_RE.test(`#${hash}`)) return true;
  if (BET365_AC_EVENT_RE.test(hash)) return true;
  if (/EV\d{8,}/i.test(hash)) return true;
  return false;
}

function isBet365LiveUrl(url) {
  if (!BET365_HOST_RE.test(url || "")) return false;
  const hash = String(url).split("#")[1] || "";
  if (!hash) return false;
  return BET365_IP_EVENT_RE.test(`#${hash}`) || /EV\d{8,}/i.test(hash);
}

function isBet365PreMatchUrl(url) {
  return isBet365MatchUrl(url) && !isBet365LiveUrl(url);
}

function bet365UrlHint(url) {
  if (!BET365_HOST_RE.test(url || "")) {
    return "Abra o site bet365.bet.br";
  }
  if (isBet365MatchUrl(url)) return null;
  return "Abra a página do jogo (clique no confronto até a URL ter #/IP/EV... ou .../E123...)";
}

const VERSION = "3.10.30";

const JUNK_ODDS_SELECTIONS =
  /^(Mais de|Menos de|Exatamente|Nenhum|Tabela|gol$|CA$|A Qualquer Momento|Cronologia|Escalação|Estat\.?|Estatísticas de Jogador)$/i;

const SKIP_ODDS_LINES =
  /^(CA|SUBSTITUIÇÃO\+|Mostrar Mais|Popular|Criar Aposta|Instantâneas|Todos|Ao-Vivo|Jogador\/Contagem|Para Marcar ou Dar Assistência|1°|Jogadores Titulares|Mercado Suspenso|\d+)$/i;

const JUNK_ODDS_MARKETS =
  /^(Escalação|FINALIZAÇÕES|Parceiros|Estat\.|Cronologia|Tabela|Exibir\b|Resultados\b|Configurações|Idioma|Esportes|Notícias de Apostas)/i;

const TIMELINE_LEAK_MARKET_RE = /^\d+°\s*(?:Goal|Gol|Escanteio|Impedimento|Cart[aã]o)/i;

const TIMELINE_LEAK_SELECTION_RE = /\s-\s(?:Chute|Assist)$/i;

const PLAYER_SHORT_ODDS_NAME_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{0,24}$/;

const LEGAL_FOOTER_MARKET_RE =
  /\b(CNPJ|Portaria\s+SPA|regulada e autorizada|Sede registrada|©\s*\d{4}|Você não deve utilizar|Jogue com responsabilidade)\b/i;

const BETTING_MARKET_HINTS =
  /\b(Gol|Gols|Resultado|Chance|Empate|Intervalo|Handicap|Total|Marcador|Chutes|Cartões|Escanteio|Tempo|Aposta|Dupla|Partida|Asiátic)/i;

const STAT_LABEL_RE =
  /^(Goleiro|Precisão|Finalizações|Ataques|Ataques Perigosos|% de Posse|xG|Áreas de Ação|Passes Chave|Cruzamentos|Escanteios|Impedimentos|Defesas|Posse)\b/i;

const STAT_LABELS = [
  "Finalizações / Chutes ao Gol",
  "Ataques Perigosos",
  "Ataques",
  "% de Posse",
  "Posse de Bola",
  "Chutes ao Gol",
  "Finalizações",
  "xG",
  "Escanteios",
  "Impedimentos",
  "Cartões Amarelos",
  "Cartões Vermelhos",
  "Defesas",
  "Faltas",
  "Posse",
];

function splitAtaquesPerigososGlued(digits) {
  const d = String(digits || "");
  if (!d) return null;
  if (d.length === 4) {
    const home = d.slice(0, 2);
    const away = d.slice(2);
    const homeN = parseInt(home, 10);
    const awayN = parseInt(away, 10);
    if (homeN >= 0 && awayN >= 0 && homeN <= 99 && awayN <= 99) {
      return { home, away };
    }
  }
  if (d.length === 3) {
    const tail = parseInt(d.slice(1), 10);
    if (tail >= 10) return { home: d[0], away: String(tail) };
    return { home: d.slice(0, 2), away: d[2] };
  }
  const m = d.match(/^(\d{1,2})(\d{1,2})$/);
  return m ? { home: m[1], away: m[2] } : null;
}

const GLUED_STAT_RULES = [
  { label: "xG", regex: /(\d+\.\d+)xG(\d+\.\d+)/i },
  {
    label: "Ataques Perigosos",
    regex: /AtaquesPerigosos(\d+)(?=%dePosse|%)/i,
    map: splitAtaquesPerigososGlued,
  },
  { label: "Ataques", regex: /Ataques(\d{2})(\d{2})(?=AtaquesPerigosos|%)/i },
  { label: "% de Posse", regex: /%dePosse(\d{2})(\d{2})/i },
  {
    label: "Finalizações / Chutes ao Gol",
    regex: /Finalizacoes\/ChutesaoGol(\d+\/\d)(\d\/\d)/i,
  },
  { label: "Passes Chave", regex: /PassesChave(\d{1,2})(\d{1,2})/i },
  { label: "Goleiro - Defesas", regex: /Goleiro-Defesas(\d+)(\d+)/i },
  { label: "Precisão dos Passes", regex: /PrecisaodosPasses(\d{1,3}%)(\d{1,3}%)/i },
  { label: "Cruzamentos", regex: /Cruzamentos(\d{1,2})(\d{1,2})/i },
];

function normalize(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function isNum(v) {
  return v && /^[\d.,/%-]+$/.test(v);
}

function isLikelyStatValue(v) {
  if (!v) return false;
  const s = String(v).trim();
  if (/^\d+\/\d+$/.test(s)) return true;
  if (/^\d{1,3}%$/.test(s)) return true;
  if (/^\d{1,2}$/.test(s)) return true;
  if (/^\d\.\d{1,2}$/.test(s)) {
    const n = parseOdd(s);
    if (n != null && isValidOdd(n) && n >= 2) return false;
    return true;
  }
  return false;
}

function toFlatBet365Text(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

function parseGluedStats(text) {
  const flat = toFlatBet365Text(text);
  const stats = [];
  const seen = new Set();

  GLUED_STAT_RULES.forEach(({ label, regex, map }) => {
    const m = flat.match(regex);
    if (!m) return;
    const pair = map ? map(m[1]) : { home: m[1], away: m[2] };
    if (!pair?.home || pair.away == null) return;
    const key = `${label}|${pair.home}|${pair.away}`;
    if (seen.has(key)) return;
    seen.add(key);
    stats.push({ label, home: pair.home, away: pair.away, source: "glued-text" });
  });

  return stats;
}

const GLUED_MATCH_RE =
  /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2})(\d{1,2})([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2}:\d{2})/g;

const SPACED_SCOREBOARD_RE =
  /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,2})\s+(\d{1,2})\s+([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,3}:\d{2})/g;

function parseClockMinutes(clock) {
  if (!clock) return -1;
  const m = String(clock).match(/^(\d{1,3}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : -1;
}

function isWallClockTime(clock) {
  const m = String(clock || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  return hours <= 23 && mins <= 59;
}

function isLikelyWallClock(clock, extractedAt) {
  if (!clock || !isWallClockTime(clock)) return false;

  const hours = parseInt(clock.split(":")[0], 10);
  if (hours > 23) return false;

  if (extractedAt) {
    const d = new Date(extractedAt);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      const candidates = new Set();
      for (let offset = -2; offset <= 2; offset++) {
        const t = new Date(d.getTime() + offset * 60_000);
        candidates.add(`${pad(t.getHours())}:${pad(t.getMinutes())}`);
      }
      if (candidates.has(clock)) return true;
    }
  }

  return false;
}

function matchCandidateRank(candidate, options = {}) {
  const { extractedAt } = options;
  let rank = parseClockMinutes(candidate?.clock);

  if (!candidate?.clock) rank -= 5000;
  if (isLikelyWallClock(candidate?.clock, extractedAt)) rank -= 100_000;
  if (candidate?.source === "frame-scripting") rank += 15000;
  if (candidate?.source === "frame-walk") rank += 12000;
  if (candidate?.source === "frame-scoreboard") rank += 12000;
  if (candidate?.source === "dom-scoreboard") rank += 5000;
  if (candidate?.source === "net-ws") rank += 10000;
  if (candidate?.source === "net-blob") rank += 8000;
  if (candidate?.source === "net-fetch" || candidate?.source === "net-xhr") rank += 6000;
  if (candidate?.source === "net-text") rank += 4000;
  if (candidate?.source === "net") rank += 3000;
  if (/ao\s*vivo|live/i.test(candidate?.status || "")) rank += 1000;

  return rank;
}

function pickBestMatch(candidates, options = {}) {
  const valid = (candidates || []).filter((m) => m?.score != null);
  if (!valid.length) return null;
  return [...valid].sort(
    (a, b) => matchCandidateRank(b, options) - matchCandidateRank(a, options)
  )[0];
}

function pickBestClock(clocks, extractedAt) {
  if (!clocks.length) return null;
  const filtered = clocks.filter((c) => !isLikelyWallClock(c.clock, extractedAt));
  const pool = filtered.length ? filtered : clocks;
  return pool.sort((a, b) => b.minutes - a.minutes)[0];
}

function sanitizeMatchClock(match, extractedAt) {
  if (!match) return match;
  if (!isLikelyWallClock(match.clock, extractedAt)) return match;
  return { ...match, clock: null };
}

function collectGluedMatches(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const matches = [];
  const re = new RegExp(GLUED_MATCH_RE.source, "g");
  let m;

  while ((m = re.exec(flat)) !== null) {
    const scoreHome = parseInt(m[2], 10);
    const scoreAway = parseInt(m[3], 10);
    if (scoreHome > 30 || scoreAway > 30) continue;

    matches.push({
      homeTeam: normalize(m[1]),
      awayTeam: normalize(m[4]),
      score: `${scoreHome}-${scoreAway}`,
      scoreHome,
      scoreAway,
      clock: m[5],
      status: flat.match(/Intervalo|INTERVALO|1T|2T|Ao Vivo/i)?.[0] || null,
    });
  }

  return matches;
}

function extractScoreboardStatusNear(flat, endIndex = 0) {
  const slice = flat.slice(Math.max(0, endIndex - 20), endIndex + 160);
  const afterClock = slice.match(/\b\d{1,3}:\d{2}\s+(Intervalo|INTERVALO|Ao\s*Vivo|1T|2T)\b/i);
  if (afterClock) {
    const raw = afterClock[1];
    if (/^INTERVALO$/i.test(raw)) return "Intervalo";
    if (/^Intervalo$/i.test(raw)) return "Intervalo";
    if (/^Ao\s*Vivo$/i.test(raw)) return "Ao Vivo";
    return raw;
  }
  if (/\bINTERVALO\b/i.test(slice) || /\bIntervalo\b/.test(slice)) return "Intervalo";
  return null;
}

function collectSpacedScoreboardMatches(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const matches = [];
  const re = new RegExp(SPACED_SCOREBOARD_RE.source, "g");
  let m;

  while ((m = re.exec(flat)) !== null) {
    const scoreHome = parseInt(m[2], 10);
    const scoreAway = parseInt(m[3], 10);
    if (scoreHome > 30 || scoreAway > 30) continue;

    matches.push({
      homeTeam: normalize(m[1]),
      awayTeam: normalize(m[4]),
      score: `${scoreHome}-${scoreAway}`,
      scoreHome,
      scoreAway,
      clock: m[5],
      status:
        extractScoreboardStatusNear(flat, m.index + m[0].length) ||
        flat.match(/Intervalo|INTERVALO|1T|2T|Ao Vivo/i)?.[0] ||
        null,
    });
  }

  return matches;
}

function inferMatchStatusFromScoreboard(match, scoreboardText = "") {
  if (!match || match.status) return match;
  const flat = String(scoreboardText || "").replace(/\s+/g, " ");
  const clock = String(match.clock || "");
  const clockIndex = clock ? flat.indexOf(clock) : -1;
  const status =
    clockIndex >= 0
      ? extractScoreboardStatusNear(flat, clockIndex + clock.length)
      : extractScoreboardStatusNear(flat, flat.length);
  if (!status) return match;
  if (status === "Intervalo" && !/^45:\d{2}$/.test(clock) && clock !== "45:00") return match;
  return { ...match, status };
}

function parseHalftimeScore(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const result = flat.match(/Resultado Após Primeira Parte\s*(\d+)\s*[-–]\s*(\d+)/i);
  if (!result) return null;

  return {
    score: `${result[1]}-${result[2]}`,
    scoreHome: +result[1],
    scoreAway: +result[2],
    status: flat.match(/Intervalo|INTERVALO/i)?.[0] || null,
    clock: flat.match(/\d{1,2}:\d{2}/)?.[0] || null,
  };
}

function parseMatchFromLines(text, extractedAt) {
  const lines = linesFromText(text);
  const scores = [];
  const clocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\d{1,2}\s*[-–]\s*\d{1,2}$/.test(line)) {
      const parts = line.split(/\s*[-–]\s*/);
      scores.push({
        score: `${parts[0]}-${parts[1]}`,
        scoreHome: +parts[0],
        scoreAway: +parts[1],
        lineIndex: i,
      });
    }

    if (
      i + 2 < lines.length &&
      /^\d{1,2}$/.test(line) &&
      /^[-–]$/.test(lines[i + 1]) &&
      /^\d{1,2}$/.test(lines[i + 2])
    ) {
      scores.push({
        score: `${line}-${lines[i + 2]}`,
        scoreHome: +line,
        scoreAway: +lines[i + 2],
        lineIndex: i,
      });
    }

    if (/^\d{1,3}:\d{2}$/.test(line)) {
      clocks.push({ clock: line, minutes: parseClockMinutes(line), lineIndex: i });
    }

    if (/^\d{1,3}'$/.test(line)) {
      const mins = parseInt(line, 10);
      clocks.push({ clock: `${mins}:00`, minutes: mins * 100, lineIndex: i });
    }
  }

  if (!scores.length) return null;

  const bestScore = scores[scores.length - 1];
  const bestClock = pickBestClock(clocks, extractedAt);

  let status = null;
  for (const l of lines) {
    if (/^(INTERVALO|Intervalo|1T|2T|HT|FT|Ao Vivo)$/i.test(l)) {
      status = l;
      break;
    }
  }

  return {
    score: bestScore.score,
    scoreHome: bestScore.scoreHome,
    scoreAway: bestScore.scoreAway,
    clock: bestClock?.clock || null,
    status,
  };
}

function isMergeOptions(value) {
  return (
    value &&
    typeof value === "object" &&
    "extractedAt" in value &&
    !("score" in value) &&
    !("scoreHome" in value)
  );
}

function mergeMatchCandidates(...args) {
  let options = {};
  if (isMergeOptions(args[args.length - 1])) {
    options = args.pop();
  }
  return sanitizeMatchClock(pickBestMatch(args.filter(Boolean), options), options.extractedAt);
}

function filterMatchCandidatesForPage(candidates, pageUrl) {
  if (!isBet365PreMatchUrl(pageUrl)) return candidates || [];
  return [];
}

function stripPreMatchScore(match, pageUrl) {
  if (!isBet365PreMatchUrl(pageUrl) || !match) return match;
  return {
    ...match,
    score: null,
    scoreHome: null,
    scoreAway: null,
    clock: null,
    status: null,
    preMatch: true,
  };
}

function resolveMatchForPage(candidates, options = {}) {
  const { extractedAt, pageUrl } = options;
  const filtered = filterMatchCandidatesForPage(candidates, pageUrl);
  const merged = sanitizeMatchClock(pickBestMatch(filtered, { extractedAt }), extractedAt);
  if (isBet365PreMatchUrl(pageUrl)) {
    return stripPreMatchScore(merged, pageUrl) ?? { score: null, clock: null, preMatch: true };
  }
  return merged;
}

function parseGluedMatch(text) {
  const best = pickBestMatch(collectGluedMatches(text));
  if (best) return best;
  return parseHalftimeScore(text);
}

const COMPETITION_RE =
  /(Copa do Mundo \d{4}|Champions League|Premier League|La Liga|Serie A|Bundesliga|Ligue 1)/i;

const DRAW_SELECTION_RE = /^(empate|draw|tie|x)$/i;

function extractPageTextFromMerged(text) {
  const chunks = String(text || "").split(/---PAGE---/);
  if (chunks.length > 1) {
    return [...chunks.slice(1)].sort((a, b) => b.length - a.length)[0] || chunks[0];
  }
  return String(text || "").split(/---SIDE-TAB---/)[0] || String(text || "");
}

function extractHeaderSlice(text, maxLines = 30) {
  return linesFromText(extractPageTextFromMerged(text)).slice(0, maxLines).join("\n");
}

function parseVsLineStrict(text) {
  for (const line of linesFromText(text)) {
    const m = line.match(
      /^([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})\s+v\s+([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})$/i
    );
    if (!m) continue;
    return { homeTeam: normalize(m[1]), awayTeam: normalize(m[2]) };
  }
  return null;
}

function extractCompetitionFromText(text) {
  return String(text || "").match(COMPETITION_RE)?.[0] || null;
}

function extractTeamsFromResultadoFinalOdds(odds) {
  const selections = [];
  const seen = new Set();

  for (const row of odds || []) {
    if (!/^resultado\s*final$/i.test(String(row?.market || "").trim())) continue;
    const selection = normalize(row?.selection);
    if (!selection || DRAW_SELECTION_RE.test(selection) || seen.has(selection)) continue;
    seen.add(selection);
    selections.push(selection);
    if (selections.length >= 2) break;
  }

  if (selections.length < 2) return null;
  return { homeTeam: selections[0], awayTeam: selections[1] };
}

function resolveMatchTeams(match = {}, options = {}) {
  const { headerText = "", odds = [], domHeader = null } = options;
  const headerSlice = extractHeaderSlice(headerText || "");
  const fromDom =
    domHeader?.homeTeam && domHeader?.awayTeam
      ? { homeTeam: domHeader.homeTeam, awayTeam: domHeader.awayTeam }
      : null;
  const fromOdds = extractTeamsFromResultadoFinalOdds(odds);
  const fromHeader = parseVsLineStrict(headerSlice) || parseVsLineStrict(headerText);
  const fromMatch =
    match.homeTeam && match.awayTeam
      ? { homeTeam: match.homeTeam, awayTeam: match.awayTeam }
      : null;

  const homeTeam =
    fromDom?.homeTeam || fromOdds?.homeTeam || fromMatch?.homeTeam || fromHeader?.homeTeam || null;
  const awayTeam =
    fromDom?.awayTeam || fromOdds?.awayTeam || fromMatch?.awayTeam || fromHeader?.awayTeam || null;
  const competition =
    match.competition ||
    extractCompetitionFromText(headerSlice) ||
    extractCompetitionFromText(headerText) ||
    null;

  return { homeTeam, awayTeam, competition };
}

function enrichMatchFromHeader(text, match = {}) {
  const headerSlice = extractHeaderSlice(text);
  const vs = parseVsLineStrict(headerSlice);
  const competition = extractCompetitionFromText(headerSlice) || extractCompetitionFromText(text);

  return {
    ...match,
    homeTeam: match.homeTeam || vs?.homeTeam || null,
    awayTeam: match.awayTeam || vs?.awayTeam || null,
    competition: match.competition || competition || null,
  };
}

function linesFromText(text) {
  return text
    .split(/\n|---IFRAME---/)
    .map(normalize)
    .filter(Boolean);
}

const MARKET_LINE_RE = /^(Mais de|Menos de|Jogador|Criar Aposta|Resultado Final|Ver$|Craques)/i;

function extractStatsFromVisibleText(text, pageUrl) {
  const glued = parseGluedStats(text);
  if (glued.length) return glued;
  if (isBet365PreMatchUrl(pageUrl)) return [];

  const lines = linesFromText(text);
  const stats = [];
  const seen = new Set();

  for (const label of STAT_LABELS) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== label && !lines[i].includes(label)) continue;
      if (lines[i] !== label && MARKET_LINE_RE.test(lines[i])) continue;
      const home = lines[i + 1];
      const away = lines[i + 2];
      if (isNum(home) && isNum(away) && isLikelyStatValue(home) && isLikelyStatValue(away)) {
        const key = `${label}|${home}|${away}`;
        if (!seen.has(key)) {
          seen.add(key);
          stats.push({ label, home, away, source: "visible-lines" });
        }
        break;
      }
    }
  }

  return stats;
}

function collectMatchCandidatesFromText(text, source, extractedAt, maxLen = 3500) {
  const candidates = [];
  if (!text || text.length > maxLen) return candidates;

  collectGluedMatches(text).forEach((m) => candidates.push({ ...m, source }));
  collectSpacedScoreboardMatches(text).forEach((m) => candidates.push({ ...m, source }));
  const fromLines = parseMatchFromLines(text, extractedAt);
  if (fromLines) candidates.push({ ...fromLines, source });

  return candidates;
}

function looksLikeScoreboardText(text, homeTeam, awayTeam) {
  if (!text || text.length < 8 || text.length > 5000) return false;

  const hasGlued = collectGluedMatches(text).length > 0;
  const hasSpaced = collectSpacedScoreboardMatches(text).length > 0;
  const hasSplit = /^\d{1,2}\s*\n\s*[-–]\s*\n\s*\d{1,2}\s*$/m.test(text);
  const hasInline = /^\d{1,2}\s*[-–]\s*\d{1,2}$/m.test(text);
  const hasClock =
    /\b\d{2,3}:\d{2}\b/.test(text) ||
    /^\d{1,3}'$/m.test(text) ||
    /^(INTERVALO|Intervalo|Ao Vivo|1T|2T)$/im.test(text);

  if (!hasGlued && !hasSpaced && !hasSplit && !hasInline) return false;

  if (homeTeam && awayTeam) {
    const homeRe = new RegExp(homeTeam.slice(0, Math.min(homeTeam.length, 8)), "i");
    const awayRe = new RegExp(awayTeam.slice(0, Math.min(awayTeam.length, 8)), "i");
    return homeRe.test(text) && awayRe.test(text);
  }

  return hasClock || /\s+v\s+/i.test(text);
}

function extractMatchFromFrameChunks(frames, extractedAt, options = {}) {
  const candidates = [];
  const { homeTeam, awayTeam } = options;

  for (const frame of frames || []) {
    const text = frame?.text;
    if (!text) continue;

    const source = frame.source || "frame-scoreboard";
    const chunkCandidates = collectMatchCandidatesFromText(text, source, extractedAt, 3500);

    if (!chunkCandidates.length) {
      if (!looksLikeScoreboardText(text, homeTeam, awayTeam)) continue;
    } else {
      candidates.push(...chunkCandidates);
    }
  }

  const best = pickBestMatch(candidates, { extractedAt });
  return best ? sanitizeMatchClock(best, extractedAt) : null;
}

function extractMatchFromVisibleText(text) {
  const match =
    mergeMatchCandidates(...collectGluedMatches(text), parseMatchFromLines(text)) ||
    parseHalftimeScore(text);

  if (match) return enrichMatchFromHeader(text, match);

  return enrichMatchFromHeader(text, {
    homeTeam: null,
    awayTeam: null,
    score: null,
    clock: null,
    status: null,
    competition: null,
  });
}

function parseOdd(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isLineValue(s) {
  return /^[+-]?\d+([.,]\d+)?$/.test(s);
}

function isTotalsLineValue(s) {
  const n = String(s || "").replace(",", ".");
  return /^[+-]?\d+(\.5)$/.test(n) || /^[+-]?\d{1,2}$/.test(n);
}

function isValidOdd(n) {
  return n >= 1.01 && n <= 501;
}

function isValidSelection(s) {
  if (!s || s.length < 2) return false;
  if (isLineValue(s)) return false;
  if (/^\d+[.,]\d+$/.test(s)) return false;
  return /[A-Za-zÀ-ú]/.test(s);
}

function isSkippedOddsLine(line) {
  return !line || SKIP_ODDS_LINES.test(line);
}

function isCornerBettingMarket(market) {
  const s = normalize(market);
  if (!s) return false;
  if (/^Escanteios(?:\s*-\s*.+)?$/i.test(s)) return true;
  if (/^Mais Escanteios$/i.test(s)) return true;
  if (/^Total de Escanteios$/i.test(s)) return true;
  if (/^\d+[º°]\s*Tempo\s*-\s*Escanteios$/i.test(s)) return true;
  if (/^Número de Cartões$/i.test(s)) return true;
  if (/^Cartões\s*-/i.test(s)) return true;
  return false;
}

function isCornerTotalRangeSelection(selection, market) {
  const sel = normalize(selection);
  const mkt = normalize(market);
  if (!isCornerBettingMarket(mkt)) return false;
  if (/^\d+\s*-\s*\d+$/.test(sel)) return true;
  if (/^(Mais de|Menos de|Exatamente)\s+\d/.test(sel)) return true;
  return false;
}

function isTotalsDirectionLine(line) {
  return /^(Mais de|Menos de|Exatamente)$/i.test(normalize(line));
}

function isStatLabel(text) {
  const n = normalize(text);
  if (!n) return false;
  if (isCornerBettingMarket(n)) return false;
  if (STAT_LABELS.some((label) => n === label)) return true;
  if (STAT_LABELS.some((label) => label.includes(" ") && n.includes(label))) return true;
  return STAT_LABEL_RE.test(n);
}

function isValidTotalsLine(value, options = {}) {
  if (!isLineValue(value)) return false;
  const raw = String(value).trim();
  const n = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return false;
  if (/^\d+$/.test(raw)) {
    return n <= (options.maxIntegerLine ?? 20);
  }
  return n <= (options.maxLine ?? 7.5);
}

function isTimelineLeakMarket(market) {
  const s = normalize(market);
  if (!s) return false;
  if (/^\d+°\s*Gol$/i.test(s)) return false;
  if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
  if (/^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]*\s-\s(?:Chute|Assist)$/i.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

function isTimelineLeakSelection(selection) {
  const s = normalize(selection);
  if (!s) return false;
  if (TIMELINE_LEAK_SELECTION_RE.test(s)) return true;
  if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

function isLikelyTeamNameSelection(selection) {
  return /^(Argentina|Áustria|Austria|Uruguai|Brasil|França|France|Alemanha|Germany|Portugal|Inglaterra|England)$/i.test(
    normalize(selection)
  );
}

function isLikelyScoreboardSelection(selection) {
  const s = normalize(selection);
  if (/Resultado Após|Primeira Parte|Intervalo/i.test(s)) return true;
  return /\d+\s*[-–]\s*\d+/.test(s);
}

function isLikelyStatCountAsOdd(odd, market, selection) {
  if (!isPlayerPropMarket(market)) return false;
  if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 20) return false;
  const sel = normalize(selection);
  if (/\s-\s\d{1,2}\+$/.test(sel)) return false;
  return /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(sel);
}

function isLikelyMinuteAsOdd(odd, market, selection) {
  if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 120) return false;
  if (isCornerTotalRangeSelection(selection, market)) return false;
  if (isTimelineLeakMarket(market) || isTimelineLeakSelection(selection)) return true;
  if (isLikelyTeamNameSelection(selection)) return true;
  if (isLikelyScoreboardSelection(selection)) return true;
  const sel = normalize(selection);
  if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && isTimelineLeakMarket(market)) return true;
  if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && /Escanteio/i.test(market || "")) return true;
  return false;
}

function isJunkOddsMarket(market) {
  if (!market || market === "—" || market === "Mercado") return true;
  if (market.length > 55) return true;
  if (JUNK_ODDS_MARKETS.test(market)) return true;
  if (LEGAL_FOOTER_MARKET_RE.test(market)) return true;
  if (isCornerBettingMarket(market)) return false;
  if (isStatLabel(market)) return true;
  if (isTimelineLeakMarket(market)) return true;
  return false;
}

function isTeamGoalsMarket(market) {
  return / - Gols$/i.test(market || "");
}

function isPlayerPropMarket(market) {
  return /^Jogador\s*-/i.test(market || "");
}

function isJunkTeamGoalsSelection(market, selection) {
  if (!isTeamGoalsMarket(market)) return false;
  return !/^(Mais de|Menos de)\s+\d/.test(normalize(selection));
}

function isJunkPlayerPropSelection(market, selection) {
  if (!isPlayerPropMarket(market)) return false;
  return /^(Mais de|Menos de)\s+/i.test(normalize(selection));
}

function isPlayerGridColumnHeader(line) {
  const s = normalize(line);
  if (!s) return false;
  if (/^\d{1,2}\+$/.test(s)) return true;
  if (s === "1+") return true;
  return false;
}

function normalizePlayerGridColumn(line) {
  const s = normalize(line);
  if (/^\d{1,2}\+$/.test(s)) return s;
  if (s === "1") return "1+";
  return s;
}

function collectPlayerGridColumns(lines, start) {
  const columns = [];
  let i = start;

  if (lines[i] === "1" && isPlayerGridColumnHeader(lines[i + 1])) {
    columns.push("1+");
    i++;
  }

  while (i < lines.length && isPlayerGridColumnHeader(lines[i])) {
    columns.push(normalizePlayerGridColumn(lines[i]));
    i++;
  }

  return { columns, nextIndex: i };
}

function isLikelyPlayerNameLine(line) {
  return (
    isValidSelection(line) &&
    /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(line) &&
    !isPlayerGridColumnHeader(line) &&
    !/^Jogador\b/i.test(line)
  );
}

function consumePlayerPropRow(lines, start, columns, market, pushOdd) {
  if (!columns.length) return null;

  let i = start;
  if (/^\d{1,2}$/.test(lines[i]) && isLikelyPlayerNameLine(lines[i + 1])) i++;
  const name = lines[i];
  if (!isLikelyPlayerNameLine(name)) return null;
  i++;

  if (/^\d{1,2}$/.test(lines[i]) && !isValidOdd(parseOdd(lines[i]))) i++;

  const values = [];
  while (i < lines.length && values.length < columns.length) {
    const odd = parseOdd(lines[i]);
    if (!isValidOdd(odd)) break;
    values.push(odd);
    i++;
  }

  if (!values.length) return null;

  const count = Math.min(columns.length, values.length);
  for (let c = 0; c < count; c++) {
    pushOdd({
      market,
      selection: `${name} - ${columns[c]}`,
      odds: values[c],
    });
  }

  return i - 1;
}

function isJunkOddsSelection(selection) {
  const s = normalize(selection);
  if (!s) return true;
  if (isTimelineLeakSelection(s)) return true;
  if (isLikelyScoreboardSelection(s)) return true;
  if (isStatLabel(s)) return true;
  if (/^Perdeu o\b/i.test(s)) return true;
  if (/^Jogadores Titulares$/i.test(s)) return true;
  if (/^Exibir Totais da Partida$/i.test(s)) return true;
  if (/^\d+°\s/.test(s)) return true;
  if (/^1° Impedimento$/i.test(s)) return true;
  if (/^\d+\s+[A-Za-zÀ-ú]{3,}.*\d/.test(s)) return true;
  if (/^(Mais de|Menos de|Exatamente)\s+/.test(s)) {
    const linePart = s.replace(/^(Mais de|Menos de|Exatamente)\s+/, "");
    return !isValidTotalsLine(linePart);
  }
  return false;
}

function isLikelyBettingMarket(market) {
  if (isJunkOddsMarket(market)) return false;
  if (isTimelineLeakMarket(market)) return false;
  if (isCornerBettingMarket(market)) return true;
  if (/^(Empate|Sim|Não|Nenhum)$/i.test(market)) return false;
  if (market.includes(" - ")) return true;
  if (/\s/.test(market)) return BETTING_MARKET_HINTS.test(market);
  return /^(Resultado|Partida|Chance|Total|Marcador|Handicap|Intervalo)/i.test(market);
}

function isLikelyShirtNumberPair(selection, oddRaw, lines, oddIndex) {
  if (!/^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(selection)) return false;
  if (!/^\d{1,2}$/.test(String(oddRaw).trim())) return false;
  const n = parseInt(oddRaw, 10);
  if (n < 1 || n > 99) return false;
  const next = lines[oddIndex + 1];
  return Boolean(
    next && /^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(next) && !isValidOdd(parseOdd(next))
  );
}

function isHandicapSelectionLine(line, lines, index) {
  if (!/[+-]\d/.test(line)) return false;
  let j = index + 1;
  while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
  return j < lines.length && isValidOdd(parseOdd(lines[j]));
}

function isCornerBettingSubMarket(line) {
  const s = normalize(line);
  return /^\d+[º°]\s*Escanteio$/i.test(s) || /^Último$/i.test(s);
}

function isLikelyMarketHeader(line, lines, index) {
  if (isSkippedOddsLine(line)) return false;
  if (isTimelineLeakMarket(line)) return false;
  if (isHandicapSelectionLine(line, lines, index)) return false;
  if (isLineValue(line)) return false;
  if (isValidOdd(parseOdd(line))) return false;
  if (line.length < 4) return false;
  if (!/[A-Za-zÀ-ú]/.test(line)) return false;

  let j = index + 1;
  while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
  if (j >= lines.length) return false;

  const next = lines[j];
  if (isLineValue(next)) return isLikelyBettingMarket(line) || line.includes(" - ");
  if (isValidSelection(next) && !isValidOdd(parseOdd(next))) {
    return isLikelyBettingMarket(line);
  }
  return false;
}

function parseOddsFromVisibleText(text) {
  const odds = [];
  const seen = new Set();
  const lines = linesFromText(text);
  let market = "—";
  let pendingLines = [];
  let playerNames = [];
  let playerGridColumns = [];
  let inPlayerGrid = false;
  let inCornerGroup = false;
  let cornerSubMarket = null;
  let lastTotalsLine = null;

  function pushOdd(entry) {
    const { market: mkt, selection, odds: odd } = entry;
    if (!isLikelyBettingMarket(mkt)) return;
    if (!isValidOdd(odd)) return;
    if (JUNK_ODDS_SELECTIONS.test(selection)) return;
    if (isJunkTeamGoalsSelection(mkt, selection)) return;
    if (isJunkPlayerPropSelection(mkt, selection)) return;
    if (isJunkOddsSelection(selection) && !isCornerTotalRangeSelection(selection, mkt)) return;
    if (isLikelyMinuteAsOdd(odd, mkt, selection)) return;
    if (isLikelyStatCountAsOdd(odd, mkt, selection)) return;
    const validSelection =
      isValidSelection(selection) ||
      /^.+\s-\s\d{1,2}\+$/.test(selection) ||
      isCornerTotalRangeSelection(selection, mkt);
    if (!validSelection) return;
    const key = `${mkt}|${selection}|${odd}`;
    if (seen.has(key)) return;
    seen.add(key);
    odds.push({ market: mkt, selection, odds: odd, source: "visible-text" });
  }

  function resetMarketContext() {
    pendingLines = [];
    playerNames = [];
    playerGridColumns = [];
    inPlayerGrid = false;
    inCornerGroup = false;
    cornerSubMarket = null;
    lastTotalsLine = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^Escanteios$/i.test(line)) {
      let j = i + 1;
      while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
      if (j < lines.length && isCornerBettingSubMarket(lines[j])) {
        market = line;
        resetMarketContext();
        inCornerGroup = true;
        continue;
      }
    }

    if (inCornerGroup && isCornerBettingSubMarket(line)) {
      cornerSubMarket = line;
      continue;
    }

    if (
      (/^Jogador\s*-/i.test(line) && line.includes(" - ")) ||
      isLikelyMarketHeader(line, lines, i)
    ) {
      market = line;
      resetMarketContext();
      continue;
    }

    if (inCornerGroup && cornerSubMarket && isValidSelection(line)) {
      const odd = parseOdd(lines[i + 1]);
      if (isValidOdd(odd)) {
        pushOdd({
          market: `Escanteios - ${cornerSubMarket}`,
          selection: line,
          odds: odd,
        });
        i++;
        continue;
      }
    }

    if (/^Marcadores/i.test(market)) {
      if (/^A Qualquer Momento$/i.test(line)) {
        let j = i + 1;
        let p = 0;
        while (j < lines.length && p < playerNames.length) {
          const odd = parseOdd(lines[j]);
          if (!isValidOdd(odd)) break;
          pushOdd({ market, selection: playerNames[p], odds: odd });
          p++;
          j++;
        }
        i = j - 1;
        playerNames = [];
        continue;
      }
      if (
        isValidSelection(line) &&
        /^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(line) &&
        !/^(Mercado|SUBSTITUI)/i.test(line)
      ) {
        playerNames.push(line);
        continue;
      }
    }

    if (/^Jogador\/Contagem$/i.test(line) && isPlayerPropMarket(market)) {
      const collected = collectPlayerGridColumns(lines, i + 1);
      playerGridColumns = collected.columns;
      inPlayerGrid = playerGridColumns.length > 0;
      i = collected.nextIndex - 1;
      continue;
    }

    if (inPlayerGrid && playerGridColumns.length) {
      const consumed = consumePlayerPropRow(lines, i, playerGridColumns, market, pushOdd);
      if (consumed != null) {
        i = consumed;
        continue;
      }
    }

    if (isLineValue(line) && market !== "—") {
      pendingLines.push(line);
      continue;
    }

    if (isCornerTotalRangeSelection(line, market)) {
      const odd = parseOdd(lines[i + 1]);
      if (isValidOdd(odd)) {
        pushOdd({ market, selection: line, odds: odd });
        pendingLines = [];
        i++;
        continue;
      }
    }

    if (isSkippedOddsLine(line)) continue;

    if (isTotalsDirectionLine(line) && !isPlayerPropMarket(market)) {
      const direction = line;
      const lineAfter = lines[i + 1];
      const oddAfterLine = parseOdd(lines[i + 2]);
      if (isTotalsLineValue(lineAfter) && isValidOdd(oddAfterLine)) {
        pushOdd({
          market,
          selection: `${direction} ${lineAfter}`,
          odds: oddAfterLine,
        });
        lastTotalsLine = lineAfter;
        pendingLines = [lineAfter];
        i += 2;
        continue;
      }
      if (
        /^Menos de$/i.test(direction) &&
        pendingLines.length <= 1 &&
        isValidOdd(parseOdd(lines[i + 1])) &&
        (lastTotalsLine || pendingLines[0])
      ) {
        const lineVal = lastTotalsLine || pendingLines[0];
        pushOdd({
          market,
          selection: `Menos de ${lineVal}`,
          odds: parseOdd(lines[i + 1]),
        });
        i++;
        pendingLines = [];
        continue;
      }
      if (pendingLines.length > 1) {
        let j = i + 1;
        let col = 0;
        while (j < lines.length && col < pendingLines.length) {
          const odd = parseOdd(lines[j]);
          if (!isValidOdd(odd)) break;
          pushOdd({
            market,
            selection: `${direction} ${pendingLines[col]}`,
            odds: odd,
          });
          col++;
          j++;
        }
        i = j - 1;
      } else {
        const odd = parseOdd(lines[i + 1]);
        const lineVal = pendingLines[0];
        const selection = lineVal ? `${direction} ${lineVal}` : direction;
        pushOdd({ market, selection, odds: odd });
        if (lineVal) lastTotalsLine = lineVal;
        i++;
      }
      if (/^Menos de$/i.test(direction)) {
        pendingLines = [];
      }
      continue;
    }

    const odd = parseOdd(lines[i + 1]);
    if (isValidSelection(line) && isValidOdd(odd)) {
      if (isLikelyShirtNumberPair(line, lines[i + 1], lines, i + 1)) {
        i++;
        continue;
      }
      pushOdd({ market, selection: line, odds: odd });
      pendingLines = [];
      i++;
    }
  }

  const selectionOddSeen = new Set([...seen].map((key) => key.slice(key.indexOf("|") + 1)));
  const glued = /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,28})\s+(\d+[.,]\d{1,3})\b/g;
  let m;
  while ((m = glued.exec(text)) !== null) {
    const selection = normalize(m[1]);
    const odd = parseOdd(m[2]);
    if (!isValidSelection(selection) || !isValidOdd(odd)) continue;
    if (JUNK_ODDS_SELECTIONS.test(selection)) continue;
    if (isJunkOddsSelection(selection)) continue;
    const selectionKey = `${selection}|${odd}`;
    if (selectionOddSeen.has(selectionKey)) continue;
    const key = `—|${selectionKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectionOddSeen.add(selectionKey);
    odds.push({ market: "—", selection, odds: odd, source: "visible-text" });
  }

  return odds;
}

function cleanOdds(odds) {
  const filtered = odds.filter(
    (o) =>
      !JUNK_ODDS_SELECTIONS.test(o.selection) &&
      !isJunkOddsMarket(o.market) &&
      !isJunkTeamGoalsSelection(o.market, o.selection) &&
      !isJunkPlayerPropSelection(o.market, o.selection) &&
      !isJunkOddsSelection(o.selection) &&
      !isTimelineLeakMarket(o.market) &&
      !isTimelineLeakSelection(o.selection) &&
      !isLikelyMinuteAsOdd(o.odds, o.market, o.selection) &&
      !isLikelyStatCountAsOdd(o.odds, o.market, o.selection) &&
      o.market !== "Mercado" &&
      o.market !== "—"
  );

  const byKey = new Map();
  filtered.forEach((o) => {
    const key = `${o.selection}|${o.odds}`;
    const prev = byKey.get(key);
    if (!prev || (prev.source !== "dom" && o.source === "dom")) byKey.set(key, o);
  });

  return [...byKey.values()].sort((a, b) => a.market.localeCompare(b.market));
}

function mergeOdds(...lists) {
  const flat = lists.flat();
  const domNet = flat.filter(
    (o) => o.source === "dom" || String(o.source || "").startsWith("net:")
  );
  const visible = flat.filter((o) => o.source === "visible-text");

  if (!domNet.length) return cleanOdds(visible);

  const domKeys = new Set(domNet.map((o) => `${o.market}|${o.selection}|${o.odds}`));
  const domMarkets = new Set(domNet.map((o) => o.market));
  const domSelectionsByMarket = new Map();

  domNet.forEach((o) => {
    const selections = domSelectionsByMarket.get(o.market) || new Set();
    selections.add(o.selection);
    domSelectionsByMarket.set(o.market, selections);
  });

  const visibleSupplement = visible.filter((o) => {
    if (!isLikelyBettingMarket(o.market)) return false;
    const key = `${o.market}|${o.selection}|${o.odds}`;
    if (domKeys.has(key)) return false;
    if (domMarkets.has(o.market)) {
      return !domSelectionsByMarket.get(o.market)?.has(o.selection);
    }
    return true;
  });

  return cleanOdds([...domNet, ...visibleSupplement]);
}

function mergeStats(...lists) {
  const out = [];
  const seen = new Set();
  lists.flat().forEach((s) => {
    const key = `${s.label}|${s.home}|${s.away}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

function tryExtractMatchFromNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;

  let scoreHome =
    node.scoreHome ?? node.homeScore ?? node.HomeScore ?? node.S1 ?? node.T1G ?? node.HG;
  let scoreAway =
    node.scoreAway ?? node.awayScore ?? node.AwayScore ?? node.S2 ?? node.T2G ?? node.AG;

  const rawScore = node.score ?? node.SC ?? node.SS;
  if (typeof rawScore === "string" && /^\d+\s*[-–]\s*\d+$/.test(rawScore.trim())) {
    const parts = rawScore.trim().split(/\s*[-–]\s*/);
    scoreHome = scoreHome ?? parts[0];
    scoreAway = scoreAway ?? parts[1];
  }

  if (scoreHome == null || scoreAway == null) return null;

  const home = parseInt(String(scoreHome), 10);
  const away = parseInt(String(scoreAway), 10);
  if (!Number.isFinite(home) || !Number.isFinite(away) || home > 30 || away > 30) return null;

  const rawClock = node.clock ?? node.Clock ?? node.TU ?? node.time ?? node.TM ?? node.elapsed;
  let clock = null;
  if (rawClock != null) {
    const s = String(rawClock).trim();
    if (/^\d{1,3}:\d{2}$/.test(s)) clock = s;
    else if (/^\d{1,3}'?$/.test(s)) clock = `${parseInt(s, 10)}:00`;
  }

  return {
    score: `${home}-${away}`,
    scoreHome: home,
    scoreAway: away,
    clock,
    status: node.status ?? node.ST ?? null,
    source: "net",
  };
}

function walkBet365Json(node, path, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkBet365Json(v, `${path}[${i}]`, out));
    return;
  }

  if (node._bet365Protocol && Array.isArray(node.segments)) {
    const text = node.segments.map((s) => `${s.key || ""}=${s.value}`).join(";");
    matchCandidatesFromNetworkText(text, "net-text").forEach((m) => out.matches.push(m));
    return;
  }

  const keys = Object.keys(node);
  const kl = keys.map((k) => k.toLowerCase());

  const match = tryExtractMatchFromNode(node);
  if (match) out.matches.push(match);

  if (kl.some((k) => /name|label|stat/.test(k)) && kl.some((k) => /home|h|team1|t1/.test(k))) {
    const label = node.name || node.label || node.stat || node.NA || node.n;
    const home = node.home ?? node.h ?? node.team1 ?? node.T1 ?? node.H;
    const away = node.away ?? node.a ?? node.team2 ?? node.T2 ?? node.A;
    if (label != null && (home != null || away != null)) {
      out.stats.push({
        label: String(label),
        home: String(home ?? ""),
        away: String(away ?? ""),
        source: `net:${path}`,
      });
    }
  }

  if (
    kl.some((k) => /odds|od|price|coef/.test(k)) &&
    kl.some((k) => /name|na|selection|team/.test(k))
  ) {
    const selection = node.name || node.NA || node.selection || node.team;
    const odds = node.odds ?? node.OD ?? node.price ?? node.coef;
    const market = node.market || node.marketName || node.MG || "Mercado";
    if (selection && odds) {
      out.odds.push({
        market: String(market),
        selection: String(selection),
        odds: parseFloat(String(odds).replace(",", ".")) || odds,
        source: `net:${path}`,
      });
    }
  }

  keys.forEach((k) => walkBet365Json(node[k], `${path}.${k}`, out));
}

function tagNetworkMatches(out, startIndex, source) {
  for (let i = startIndex; i < out.matches.length; i++) {
    if (!out.matches[i].source || out.matches[i].source === "net") {
      out.matches[i].source = source;
    }
  }
}

function ingestNetworkLogEntry(entry, out, extractedAt) {
  const { data, kind = "fetch", hints, url = "" } = entry || {};
  const isBlob = /\/Api\/1\/Blob\b/i.test(url);
  const isZap = /sportspublisher\/zap/i.test(url);
  const source = isZap
    ? "net-ws"
    : isBlob
      ? "net-blob"
      : kind === "ws"
        ? "net-ws"
        : kind === "xhr"
          ? "net-xhr"
          : kind === "fetch"
            ? "net-fetch"
            : "net-text";

  if (hints?.match) {
    out.matches.push({ ...hints.match, source: hints.match.source || source });
  }

  if (typeof data === "string") {
    const parsed = parseNetworkPayload(data);
    if (parsed && typeof parsed === "object") {
      const start = out.matches.length;
      walkBet365Json(parsed, "root", out);
      tagNetworkMatches(out, start, source);
    }
    matchCandidatesFromNetworkText(data, source).forEach((m) => out.matches.push(m));
    return;
  }

  if (data && typeof data === "object") {
    const start = out.matches.length;
    walkBet365Json(data, "root", out);
    tagNetworkMatches(out, start, source);
    matchCandidatesFromNetworkText(JSON.stringify(data), source).forEach((m) =>
      out.matches.push(m)
    );
  }
}

function extractFromNetworkLog(networkLog, extractedAt) {
  const out = { stats: [], odds: [], matches: [] };
  const seenS = new Set();
  const seenO = new Set();

  (networkLog || []).forEach((entry) => {
    const enriched = { ...entry };
    if (!enriched.hints && typeof enriched.data === "string") {
      enriched.hints = extractNetworkHints(enriched.data, enriched.url);
    }
    if (enriched.hints && !enriched.hints.match && typeof enriched.data === "string") {
      const wire = extractFromBet365WirePayload(
        enriched.data,
        enriched.kind === "ws" ? "net-ws" : "net-blob"
      );
      if (wire) enriched.hints.match = wire;
    }
    ingestNetworkLogEntry(enriched, out, extractedAt);
  });

  return {
    stats: out.stats.filter((s) => {
      const k = `${s.label}|${s.home}|${s.away}`;
      if (seenS.has(k)) return false;
      seenS.add(k);
      return true;
    }),
    odds: out.odds.filter((o) => {
      const k = `${o.market}|${o.selection}|${o.odds}`;
      if (seenO.has(k)) return false;
      seenO.add(k);
      return true;
    }),
    match: sanitizeMatchClock(pickBestMatch(out.matches, { extractedAt }), extractedAt),
  };
}

function assessMatchConfidence(match, meta = {}) {
  const warnings = [];
  let confidence = "high";

  if (meta.preMatch || match?.preMatch) {
    return {
      confidence: "n/a",
      warnings: ["Página pré-jogo — placar indisponível"],
    };
  }

  if (!match?.score) {
    warnings.push("Placar não encontrado");
    confidence = "low";
  }

  if (!match?.clock) {
    warnings.push("Minuto de jogo não encontrado");
    if (confidence === "high") confidence = "medium";
  }

  if (match?.clock && isLikelyWallClock(match.clock, match.extractedAt)) {
    warnings.push("Relógio parece horário local, não minuto de jogo");
    confidence = "low";
  }

  if ((meta.visibleTextLength || 0) > 0 && meta.visibleTextLength < 3000) {
    warnings.push("Pouco texto capturado — painel do jogo pode não ter carregado");
    if (confidence === "high") confidence = "medium";
  }

  if ((meta.statsCount || 0) > 0 && !match?.score) {
    warnings.push("Stats OK mas placar ausente — scoreboard fora do alcance");
    confidence = "low";
  }

  return { confidence, warnings };
}

function gatherMatchCandidates(options = {}) {
  const { frameChunks = [], visibleText = "", extractedAt, extraCandidates = [] } = options;
  const candidates = [...extraCandidates];

  for (const frame of frameChunks) {
    candidates.push(
      ...collectMatchCandidatesFromText(
        frame.text,
        frame.source || "frame-scoreboard",
        extractedAt,
        3500
      )
    );
  }

  collectGluedMatches(visibleText).forEach((m) =>
    candidates.push({ ...m, source: "visible-glued" })
  );

  const fromLines = parseMatchFromLines(visibleText, extractedAt);
  if (fromLines) candidates.push({ ...fromLines, source: "visible-lines" });

  return candidates;
}

function annotateCandidateRanks(candidates, extractedAt) {
  return (candidates || [])
    .filter((c) => c?.score != null)
    .map((c) => ({
      ...c,
      rank: matchCandidateRank(c, { extractedAt }),
      wallClock: isLikelyWallClock(c.clock, extractedAt),
      clockMinutes: parseClockMinutes(c.clock),
    }))
    .sort((a, b) => b.rank - a.rank);
}

function buildClockDebug(candidates, extractedAt) {
  const clocks = (candidates || [])
    .filter((c) => c?.clock)
    .map((c) => ({
      clock: c.clock,
      source: c.source,
      score: c.score,
      minutes: parseClockMinutes(c.clock),
      wallClock: isLikelyWallClock(c.clock, extractedAt),
    }));

  const unique = [...new Map(clocks.map((c) => [`${c.clock}|${c.source}`, c])).values()];
  const filtered = unique.filter((c) => !c.wallClock);
  const best = pickBestClock(
    filtered.map((c) => ({ clock: c.clock, minutes: c.minutes })),
    extractedAt
  );

  return {
    found: unique.length,
    afterWallFilter: filtered.length,
    clocks: unique.slice(0, 25),
    bestClock: best?.clock ?? null,
    extractedAtLocal: extractedAt
      ? new Date(extractedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : null,
  };
}

function buildSourceBreakdown(stats, odds) {
  const countBySource = (items) => {
    const counts = {};
    for (const item of items || []) {
      const source = item.source || "unknown";
      counts[source] = (counts[source] || 0) + 1;
    }
    return counts;
  };

  return {
    stats: countBySource(stats),
    odds: countBySource(odds),
  };
}

function buildNetworkDebugSamples(networkLog, limit = 15) {
  return (networkLog || []).slice(0, limit).map((entry) => {
    const url = String(entry.url || "");
    const hints =
      entry.hints ||
      (typeof entry.data === "string" ? extractNetworkHints(entry.data, entry.url) : null);
    const isIpeBlob = /ipe\/5378|ipe-BR/i.test(url);
    const isZapWs = /sportspublisher\/zap|zap-ws/i.test(url);
    const hintPlayers = Array.isArray(hints?.lineupPlayers) ? hints.lineupPlayers : [];
    const dataText = typeof entry.data === "string" ? entry.data : entry.data?._rawText || "";
    const naSamples = [];
    if (isIpeBlob && dataText) {
      for (const m of dataText.matchAll(/\bNA=([^|;\x00-\x1f\x14]{2,60})/g)) {
        if (naSamples.length >= 12) break;
        naSamples.push(m[1].trim());
      }
    }

    return {
      url: url.slice(0, 220),
      at: entry.at || null,
      kind: entry.kind || "fetch",
      rawLen: entry.rawLen ?? null,
      isIpeBlob,
      isZapWs,
      zapBufferLen: hints?.zapBufferLen ?? null,
      fieldKeys: hints?.fieldKeys || [],
      lineupPlayersCount: hintPlayers.length,
      lineupPlayers: hintPlayers.slice(0, 16).map((p) => p?.name || p),
      naSamples,
      wireMatches: hints?.matches || [],
      wireClocks: hints?.clocks || [],
      wireMatch: hints?.match || null,
      keys:
        entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
          ? Object.keys(entry.data).slice(0, 14)
          : [],
      preview:
        typeof entry.data === "string"
          ? entry.data.slice(0, 320)
          : JSON.stringify(entry.data ?? null).slice(0, 320),
    };
  });
}

function buildExtractionDebug({
  matchCandidates = [],
  frameChunks = [],
  visibleText = "",
  marketAnalysis = null,
  marketInference = null,
  extractedAt,
  meta = {},
  pipeline = [],
  networkLog = [],
  sidePanelBlobDebug = [],
  domProbe = [],
  stats = [],
  odds = [],
  selectedMatch = null,
}) {
  const ranked = annotateCandidateRanks(matchCandidates, extractedAt);
  const clockDebug = buildClockDebug(matchCandidates, extractedAt);
  const sourceBreakdown = buildSourceBreakdown(stats, odds);
  const networkSamples = buildNetworkDebugSamples(networkLog);

  return {
    extractedAt,
    pipeline,
    frameTextsScanned: frameChunks.length,
    frameSamples: frameChunks.map((f) => ({
      source: f.source,
      href: f.href || null,
      depth: f.depth ?? null,
      len: f.text?.length || 0,
      scoreHint: f.scoreHint ?? null,
      preview: (f.text || "").slice(0, 320),
    })),
    matchCandidates: ranked.slice(0, 20).map((c) => ({
      score: c.score,
      clock: c.clock,
      source: c.source,
      status: c.status || null,
      homeTeam: c.homeTeam || null,
      awayTeam: c.awayTeam || null,
      rank: c.rank,
      wallClock: c.wallClock,
      clockMinutes: c.clockMinutes,
    })),
    selectedMatch:
      selectedMatch?.score != null
        ? {
            score: selectedMatch.score,
            clock: selectedMatch.clock,
            source: selectedMatch.source,
            status: selectedMatch.status || null,
            rank: matchCandidateRank(selectedMatch, { extractedAt }),
            wallClock: isLikelyWallClock(selectedMatch.clock, extractedAt),
          }
        : null,
    clockDebug,
    sourceBreakdown,
    networkSamples,
    sidePanelBlobDebug: (sidePanelBlobDebug || []).slice(0, 6),
    networkBreakdown: (networkLog || []).reduce((acc, entry) => {
      const kind = entry.kind || "fetch";
      acc[kind] = (acc[kind] || 0) + 1;
      return acc;
    }, {}),
    domProbe: (domProbe || []).slice(0, 20),
    marketAnalysis,
    marketInference: marketInference
      ? {
          applied: marketInference.applied,
          analysis: marketInference.analysis,
          previousScore: marketInference.match?.scoreDom || null,
        }
      : null,
    visibleTextLength: visibleText.length,
    visibleTextSample: visibleText.slice(0, 2000),
    rootsScanned: meta.rootsScanned ?? null,
    networkCaptures: meta.networkCaptures ?? networkLog.length,
    tips: meta.tips || [],
  };
}

function finalizeMatchData(match, visibleText, meta, extractedAt, pageUrl, options = {}) {
  const preMatch = isBet365PreMatchUrl(pageUrl);
  const headerText = options.headerText || visibleText;
  const teams = resolveMatchTeams(stripPreMatchScore(match, pageUrl), {
    headerText,
    odds: options.odds || [],
    domHeader: options.domHeader || null,
  });
  const enriched = {
    ...stripPreMatchScore(match, pageUrl),
    ...teams,
    extractedAt,
  };
  const confidence = assessMatchConfidence(enriched, {
    ...meta,
    statsCount: meta.statsCount ?? 0,
    preMatch,
  });

  return {
    ...enriched,
    scoreConfidence: confidence.confidence,
    scoreWarnings: confidence.warnings,
  };
}

function finalizeMatchWithMarkets(
  match,
  odds,
  visibleText,
  meta,
  extractedAt,
  pageUrl,
  options = {}
) {
  const finalized = finalizeMatchData(match, visibleText, meta, extractedAt, pageUrl, {
    ...options,
    odds,
    headerText: options.headerText || visibleText,
  });
  if (isBet365PreMatchUrl(pageUrl)) {
    const analysis = analyzeMarketScore(odds, finalized);
    return {
      match: finalized,
      inference: { match: finalized, analysis, applied: false },
      analysis,
    };
  }
  const inference = applyMarketScoreInference(finalized, odds);
  let result = inference.match;

  if (inference.applied) {
    const warnings = [...(result.scoreWarnings || [])];
    warnings.push(`Placar inferido por mercados (mín. ${inference.analysis.minTotalGoals} gols).`);

    let confidence = result.scoreConfidence;
    if (!result.clock && confidence === "high") confidence = "medium";

    result = {
      ...result,
      scoreConfidence: confidence,
      scoreWarnings: warnings,
    };
  }

  return { match: result, inference, analysis: inference.analysis };
}

const MARKET_CATEGORY_TABS = [
  "Popular",
  "Instantâneas",
  "Escanteios/Cartões",
  "Escanteios",
  "Gols",
  "1º Tempo/2º Tempo",
  "Jogador",
  "Jogador a Marcar",
  "Especiais",
  "Odds Asiáticas",
  "Todos",
  "Escalações",
  "Handicap",
  "Resultado",
  "Alternativas",
];

const MARKET_CATEGORY_TABS_VISIT = [
  "Popular",
  "Todos",
  "Jogador",
  "Gols",
  "Escanteios/Cartões",
  "Instantâneas",
];

const PREMATCH_MARKET_TABS_VISIT = [
  "Popular",
  "Escanteios",
  "Gols",
  "Jogador a Marcar",
  "Handicap",
  "Odds Asiáticas",
];

const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
const MARKET_TAB_CLICK_DELAY_MS = 280;
const MARKET_TAB_BAND_TOP_PX = 560;
const MARKET_TAB_BAND_TOP_RATIO = 0.55;
const PREMATCH_MARKET_TAB_BAND_TOP_PX = 600;
const PREMATCH_MARKET_TAB_BAND_TOP_RATIO = 0.62;
const MARKET_TAB_LEFT_COLUMN_RATIO = 0.78;
const MARKET_TAB_LEAF_MAX_TEXT_LEN = 40;

const MARKET_TAB_CONTAINER_SELECTORS = [
  "[class*='Classification']",
  "[class*='ClassificationRibbon']",
  "[class*='Ribbon']",
  "[class*='MarketFilter']",
  "[class*='CouponClassification']",
  "[class*='CouponPage']",
  "[class*='MarketCoupon']",
  "[class*='SlideScroller']",
  "[class*='FilterBar']",
  "[class*='InPlay']",
  "[class*='EventView']",
  "[class*='ipe-']",
  "[class*='ovm-']",
];

const MARKET_TAB_LEAF_SELECTORS = [
  "[class*='Classification'] [class*='Item']",
  "[class*='ClassificationRibbon'] *",
  "[class*='Scroller'] [class*='Item']",
  "[class*='Scroller'] button",
  "[class*='Scroller'] [role='tab']",
  "[class*='Classification'] *",
  "[class*='HorizontalScroll'] *",
  "button",
  "[role='tab']",
  "span",
  "a",
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

const TAB_PATTERNS = MARKET_CATEGORY_TABS.map(
  (label) => new RegExp(`^${escapeRegExp(label)}$`, "i")
);

function normalizeMarketTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarketCategoryTabLabel(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s || s.length > 40) return false;
  return TAB_PATTERNS.some((re) => re.test(s));
}

function marketCategoryTabKey(text) {
  const s = normalizeMarketTabLabel(text);
  const idx = TAB_PATTERNS.findIndex((re) => re.test(s));
  return idx >= 0 ? MARKET_CATEGORY_TABS[idx] : null;
}

function resolveMarketTabPageMode(pageUrl = "") {
  const hash = String(pageUrl).includes("#")
    ? String(pageUrl).split("#")[1] || ""
    : String(pageUrl);
  if (/#\/IP\/EV\d+/i.test(`#${hash}`) || /EV\d{8,}/i.test(hash)) return "live";
  if (/\/E\d{6,}\b/i.test(hash)) return "prematch";
  return "auto";
}

function marketTabsVisitList(pageMode = "auto") {
  return pageMode === "prematch" ? PREMATCH_MARKET_TABS_VISIT : MARKET_CATEGORY_TABS_VISIT;
}

function marketTabTopLimit(innerHeight = 800, pageMode = "auto") {
  const prematch = pageMode === "prematch";
  const cap = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_PX : MARKET_TAB_BAND_TOP_PX;
  const ratio = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_RATIO : MARKET_TAB_BAND_TOP_RATIO;
  return Math.min(cap, innerHeight * ratio);
}

function isInLeftMarketColumn(rect, innerWidth = 1200) {
  if (!rect) return false;
  return rect.left >= -8 && rect.left <= innerWidth * MARKET_TAB_LEFT_COLUMN_RATIO;
}

function isInMarketTabBand(rect, innerHeight = 800, innerWidth = 1200, pageMode = "auto") {
  if (!rect || rect.width < 12 || rect.height < 6) return false;
  if (!isInLeftMarketColumn(rect, innerWidth)) return false;
  const topLimit = marketTabTopLimit(innerHeight, pageMode);
  return rect.top >= -8 && rect.top <= topLimit;
}

function gluedMarketTabCount(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s) return 0;
  let remaining = s;
  let count = 0;
  const tabs = [...MARKET_CATEGORY_TABS].sort((a, b) => b.length - a.length);
  for (const label of tabs) {
    const re = new RegExp(escapeRegExp(label), "i");
    if (!re.test(remaining)) continue;
    count++;
    remaining = remaining.replace(re, " ");
  }
  return count;
}

function isGluedMarketTabContainer(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s) return false;
  if (TAB_PATTERNS.some((re) => re.test(s))) return false;
  return gluedMarketTabCount(s) > 1;
}

function scoreMarketTabBarContainer(text) {
  const count = gluedMarketTabCount(text);
  if (count < 3) return 0;
  let score = count;
  if (/Popular/i.test(text)) score += 2;
  if (/Jogador/i.test(text)) score += 2;
  if (/Gols/i.test(text)) score += 1;
  if (/Instant/i.test(text)) score += 1;
  if (/Escanteios\/Cartões/i.test(text)) score += 2;
  if (/\bEscanteios\b/i.test(text)) score += 2;
  if (/\bTodos\b/i.test(text)) score += 2;
  if (/Criar Aposta/i.test(text)) score += 1;
  return score;
}

function isMarketTabLeafText(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s || s.length > MARKET_TAB_LEAF_MAX_TEXT_LEN) return false;
  return Boolean(marketCategoryTabKey(s));
}

function isInsideScoredMarketTabContainer(rect, containerRects = []) {
  if (!rect || !containerRects.length) return false;
  return containerRects.some((container) => {
    if (!container || container.score < 4) return false;
    const c = container.rect;
    if (!c) return false;
    return (
      rect.top >= c.top - 12 &&
      rect.bottom <= c.bottom + 12 &&
      rect.left >= c.left - 12 &&
      rect.right <= c.right + 12
    );
  });
}

function leafMarketTabKey(text, childTexts = []) {
  const key = marketCategoryTabKey(text);
  if (!key || isGluedMarketTabContainer(text)) return null;
  const childKeys = childTexts.map((childText) => marketCategoryTabKey(childText)).filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

function pickSmallestTabCandidates(candidates) {
  const byLabel = new Map();
  for (const tab of candidates) {
    const prev = byLabel.get(tab.label);
    if (!prev || tab.area < prev.area) byLabel.set(tab.label, tab);
  }
  return [...byLabel.values()];
}

function collectMarketTabCandidates(
  nodes,
  innerHeight = 800,
  innerWidth = 1200,
  pageMode = "auto",
  containerRects = []
) {
  const candidates = [];
  const seen = new Set();

  for (const node of nodes) {
    const text = normalizeMarketTabLabel(node.text);
    const childTexts = (node.childTexts || []).map((childText) =>
      normalizeMarketTabLabel(childText)
    );
    let key = leafMarketTabKey(text, childTexts);
    if (
      !key &&
      isMarketTabLeafText(text) &&
      !childTexts.some((childText) => marketCategoryTabKey(childText))
    ) {
      key = marketCategoryTabKey(text);
    }
    if (!key || seen.has(key)) continue;
    const rect = node.rect;
    const inBand =
      isInMarketTabBand(rect, innerHeight, innerWidth, pageMode) ||
      isInsideScoredMarketTabContainer(rect, containerRects);
    if (!inBand) continue;
    seen.add(key);
    candidates.push({
      label: key,
      area: (rect?.width || 0) * (rect?.height || 0),
      el: node.el ?? null,
    });
  }

  return pickSmallestTabCandidates(candidates);
}

function isPlayerMarketTabKey(key) {
  return key === "Jogador" || key === "Jogador a Marcar";
}

function isCornerMarketTabKey(key) {
  return key === "Escanteios/Cartões" || key === "Escanteios";
}

const MARKET_EXPAND_CLICK_DELAY_MS = 120;
const MARKET_EXPAND_MAX_CLICKS = 48;

const MARKET_GROUP_CONTAINER_SELECTORS = [
  "[class*='MarketGroup']",
  "[class*='CouponMarket']",
  "[class*='MarketGrid']",
  "[class*='MarketBoard']",
];

const MARKET_GROUP_HEADER_SELECTORS = [
  "[class*='MarketGroupButton']",
  "[class*='MarketGroup'][class*='Header']",
  "[class*='MarketGroup'][class*='Button']",
];

const MARKET_ODDS_SELECTORS = [
  "[class*='ParticipantOdd']",
  "[class*='OddsOnly']",
  "[class*='Participant_Odd']",
  "[class*='Odds']",
];

function normalize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarketCaExpandText(text) {
  return /^CA$/i.test(normalize(text));
}

function isMarketShowMoreText(text) {
  return /^Mostrar Mais$/i.test(normalize(text));
}

function isMarketExpandControlText(text) {
  return isMarketCaExpandText(text) || isMarketShowMoreText(text);
}

function isMarketGroupCollapsedHint({ ariaExpanded = null, className = "" } = {}) {
  const aria = normalize(ariaExpanded);
  if (aria === "false") return true;
  if (aria === "true") return false;
  const cls = normalize(className);
  if (!cls) return false;
  if (/(?:expanded|opened|active)/i.test(cls) && !/(?:collapsed|closed)/i.test(cls)) {
    return false;
  }
  if (/(?:collapsed|closed|folded|shut)/i.test(cls)) return true;
  return false;
}

function shouldClickMarketExpandControl(text, { collapsed = true } = {}) {
  if (isMarketShowMoreText(text)) return true;
  if (isMarketCaExpandText(text)) return collapsed;
  return false;
}

function isLikelyMarketGroupHeaderText(text) {
  const s = normalize(text);
  if (!s || s.length < 4 || s.length > 90) return false;
  return /\b(?:Escanteios|Gols|Jogador|Cart[oõ]es|Handicap|Marcador|Total|Encontro|Partida|Chance|Resultado|Intervalo|Impedimento|Assist)\b/i.test(
    s
  );
}

const STATS_SUB_TAB_KEYS = [
  "marcadores",
  "chutes",
  "cartoesFaltas",
  "estatisticasJogador",
  "resultado",
  "escanteios",
  "gols",
  "tempos",
  "outros",
];

const STATS_SUB_TAB_LABELS = [
  "Marcadores",
  "Chutes",
  "Cartões/Faltas",
  "Estatísticas do Jogador",
  "Resultado",
  "Escanteios",
  "Gols",
  "1º Tempo/2º Tempo",
  "Outros",
];

const STATS_SUB_TAB_VISIT_BUDGET_MS = 12_000;
const STATS_SUB_TAB_CLICK_DELAY_MS = 220;
const STATS_SUB_TAB_LEAF_MAX_TEXT_LEN = 36;
const STATS_SUB_TAB_SCROLL_FRACTIONS = [0, 0.33, 0.66, 1];

const STATS_SUB_TAB_LEAF_SELECTORS = [
  "[class*='StatsCategory'] *",
  "[class*='MatchStats'] *",
  "[class*='StatsRibbon'] *",
  "[class*='StatsDetail'] *",
  "[class*='SubNav'] *",
  "[class*='LiteScoreboard'] *",
  "[class*='HorizontalScroll'] [class*='Item']",
  "[class*='Scroller'] [class*='Item']",
  "[class*='LocationEventsMenu_Item']",
  "[class*='EventsMenu'] *",
  "button",
  "[role='tab']",
  "span",
  "a",
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

const STATS_SUB_TAB_PATTERNS = STATS_SUB_TAB_LABELS.map(
  (label) => new RegExp(`^${escapeRegExp(label)}$`, "i")
);

const OUTROS_TAB_RE = /^Outr(?:os)?(?:\s*[›>])?$/i;

const LIVE_STATS_SIGNAL_RE =
  /xG|Ataques Perigosos|% de Posse|Passes Chave|Goleiro\s*-\s*Defesas|Precisão dos Passes|Finalizações\s*\/\s*Chutes ao Gol/i;

const MARKET_RIBBON_SIGNAL_RE =
  /Popular|Criar Aposta|Jogador a Marcar|Odds Asiáticas|Ver por|Mercado\b|Jogador \/ Últimos|SUBSTITUIÇÃO\+/i;

const LIVE_STATS_PANEL_SCOPE_SELECTORS = [
  "[class*='MatchLiveStats']",
  "[class*='SimpleMatchStats']",
  "[class*='StatsGraph']",
  "[class*='LiteScoreboard']",
  "[class*='Scoreboard']",
  "[class*='MatchLiveModule']",
  "[class*='InPlayModule']",
  "[class*='StatsModule']",
  "[class*='ParticipantStats']",
  "[class*='MediaStats']",
];

function looksLikeLiveStatsPanelText(text) {
  return LIVE_STATS_SIGNAL_RE.test(String(text || ""));
}

function shouldTreatAsMarketRibbonNotStats(text) {
  const s = String(text || "");
  if (!MARKET_RIBBON_SIGNAL_RE.test(s)) return false;
  if (!looksLikeLiveStatsPanelText(s)) return true;
  if (gluedStatsSubTabCount(s) >= 3) return false;
  if (
    /Estat\.|Cronologia|Escalação|Tabela/i.test(s) &&
    !/Jogador a Marcar ou Dar Assistência/i.test(s)
  ) {
    return false;
  }
  if (/Ataques Perigosos|% de Posse|Finalizações\s*\/\s*Chutes ao Gol/i.test(s)) return false;
  return true;
}

function looksLikeMarketRibbonText(text) {
  return shouldTreatAsMarketRibbonNotStats(text);
}

function scoreLiveStatsPanelRootText(text) {
  const s = String(text || "");
  if (!looksLikeLiveStatsPanelText(s)) return 0;
  if (shouldTreatAsMarketRibbonNotStats(s)) return 0;
  let score = 12 + scoreStatsSubTabBarContainer(s);
  if (/Estat\.|Tabela/i.test(s)) score += 4;
  if (/Marcadores|Escanteios|Cartões\/Faltas/i.test(s)) score += 2;
  return score;
}

function normalizeStatsSubTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function statsSubTabKey(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (OUTROS_TAB_RE.test(s)) return "Outros";
  if (/^Marcadores de Gols?$/i.test(s)) return "Marcadores";
  const idx = STATS_SUB_TAB_PATTERNS.findIndex((re) => re.test(s));
  return idx >= 0 ? STATS_SUB_TAB_LABELS[idx] : null;
}

function statsSubTabKeyFromKey(key) {
  const idx = STATS_SUB_TAB_KEYS.indexOf(key);
  return idx >= 0 ? STATS_SUB_TAB_LABELS[idx] : null;
}

function gluedStatsSubTabCount(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s) return 0;
  let count = STATS_SUB_TAB_LABELS.filter((label) =>
    new RegExp(escapeRegExp(label), "i").test(s)
  ).length;
  if (OUTROS_TAB_RE.test(s)) count += 1;
  return count;
}

function scoreStatsSubTabBarContainer(text) {
  const s = String(text || "");
  if (shouldTreatAsMarketRibbonNotStats(s)) return 0;
  if (!looksLikeLiveStatsPanelText(s)) return 0;

  const count = gluedStatsSubTabCount(s);
  if (count < 3) return 0;
  let score = count + 10;
  if (/Marcadores/i.test(s)) score += 2;
  if (/Chutes/i.test(s)) score += 2;
  if (/Escanteios/i.test(s)) score += 1;
  if (/Cartões\/Faltas/i.test(s)) score += 1;
  return score;
}

function isGluedStatsSubTabContainer(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s) return false;
  if (STATS_SUB_TAB_PATTERNS.some((re) => re.test(s)) || OUTROS_TAB_RE.test(s)) return false;
  return gluedStatsSubTabCount(s) > 1;
}

function isStatsSubTabLeafText(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s || s.length > STATS_SUB_TAB_LEAF_MAX_TEXT_LEN) return false;
  return Boolean(statsSubTabKey(s));
}

function leafStatsSubTabKey(text, childTexts = []) {
  const s = normalizeStatsSubTabLabel(text);
  const key = statsSubTabKey(s);
  if (!key || isGluedStatsSubTabContainer(s)) return null;
  const childKeys = childTexts.map((childText) => statsSubTabKey(childText)).filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

const SIDE_PANEL_STATS_TAB_MAP = {
  goalScorers: "marcadores",
  lateral: "escanteios",
};

function looksLikeGoalScorersPanelText(text) {
  return looksLikeGoalScorersTabContent(text);
}

function looksLikeLateralStatsPanelText(text) {
  const s = String(text || "");
  return /Escanteios/i.test(s) || (/Lateral/i.test(s) && /Laterais?/i.test(s));
}

function ingestSidePanelTabStats(textByTab = {}, textBySubTab = {}, subTabClicks = {}) {
  const out = { ...textBySubTab };
  const clicks = { ...subTabClicks };

  for (const [panelKey, subTabKey] of Object.entries(SIDE_PANEL_STATS_TAB_MAP)) {
    const text = String(textByTab[panelKey] || "");
    if (!text || out[subTabKey]) continue;
    if (panelKey === "goalScorers" && !looksLikeGoalScorersPanelText(text)) continue;
    if (panelKey === "lateral" && !looksLikeLateralStatsPanelText(text)) continue;
    out[subTabKey] = text;
    clicks[subTabKey] = true;
  }

  return { textBySubTab: out, subTabClicks: clicks };
}

function isStatsSubTabNodeInBand(rect, innerWidth, band = "strict") {
  if (band === "none") return true;
  if (band === "relaxed") return isInRelaxedSidePanelTabBand(rect, innerWidth);
  return isInSidePanelTabBand(rect, innerWidth);
}

function collectStatsSubTabCandidatesFromNodes(nodes, innerWidth = 1200, options = {}) {
  const band = options.band || (options.requireBand === false ? "none" : "strict");
  const candidates = [];
  const seen = new Set();

  for (const node of nodes) {
    const text = normalizeStatsSubTabLabel(node.text);
    const childTexts = (node.childTexts || []).map((childText) =>
      normalizeStatsSubTabLabel(childText)
    );
    const label = leafStatsSubTabKey(text, childTexts);
    if (!label) continue;
    const key = STATS_SUB_TAB_KEYS[STATS_SUB_TAB_LABELS.indexOf(label)];
    if (!key || seen.has(key)) continue;
    const rect = node.rect;
    if (!isStatsSubTabNodeInBand(rect, innerWidth, band)) continue;
    seen.add(key);
    candidates.push({
      key,
      label,
      area: (rect?.width || 0) * (rect?.height || 0),
      el: node.el ?? null,
    });
  }

  const byKey = new Map();
  for (const tab of candidates) {
    const prev = byKey.get(tab.key);
    if (!prev || tab.area < prev.area) byKey.set(tab.key, tab);
  }
  return [...byKey.values()];
}

function mergeStatsSubTabTexts(textBySubTab = {}) {
  return STATS_SUB_TAB_KEYS.map((key) => textBySubTab[key])
    .filter(Boolean)
    .join("\n---STATS-SUBTAB---\n");
}

function summarizeStatsSubTabCapture(textBySubTab = {}, subTabClicks = {}) {
  return Object.fromEntries(
    STATS_SUB_TAB_KEYS.map((key) => [
      key,
      {
        clicked: Boolean(subTabClicks[key]),
        length: String(textBySubTab[key] || "").length,
        captured: Boolean(textBySubTab[key]),
      },
    ])
  );
}

function extractStatsFromSubTabTexts(textBySubTab = {}, pageUrl = "") {
  const stats = [];
  const seen = new Set();

  const push = (row) => {
    const key = `${row.subTab || ""}|${row.label}|${row.home}|${row.away}`;
    if (seen.has(key)) return;
    seen.add(key);
    stats.push(row);
  };

  for (const key of STATS_SUB_TAB_KEYS) {
    const text = textBySubTab[key];
    if (!text) continue;

    for (const row of parseGluedStats(text)) {
      push({ ...row, subTab: key, source: `stats-subtab:${key}` });
    }

    const parsePageUrl = looksLikeLiveStatsPanelText(text) ? "" : pageUrl;
    for (const row of extractStatsFromVisibleText(text, parsePageUrl)) {
      push({ ...row, subTab: key, source: `stats-subtab:${key}` });
    }
  }

  return stats;
}

function normalize(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function linesFromText(text) {
  return String(text || "")
    .split(/\n|---IFRAME---/)
    .map(normalize)
    .filter(Boolean);
}

function parseOdd(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isValidOdd(n) {
  return n >= 1.01 && n <= 501;
}

const SIDE_PANEL_TAB_KEYS = [
  "stats",
  "goalScorers",
  "lateral",
  "playerStats",
  "timeline",
  "lineup",
];

const SIDE_PANEL_TAB_LABELS = {
  stats: /^Estat\.?$|^Estatísticas$/i,
  goalScorers: /^Marcadores de Gols?$/i,
  lateral: /^Lateral$/i,
  playerStats: /^Estatísticas de Jogador$/i,
  timeline: /^Cronologia$/i,
  lineup: /^Escalação$/i,
};

const SIDE_PANEL_STATS_HARVEST_KEYS = ["goalScorers", "lateral"];
const SIDE_PANEL_VISIT_BUDGET_MS = 18_000;
const SIDE_PANEL_STATS_SUB_TAB_BUDGET_MS = 5_000;

const TIMELINE_PANEL_SCOPE_SELECTORS = [
  "[class*='Timeline']",
  "[class*='Chronolog']",
  "[class*='MatchTimeline']",
  "[class*='LocationEvents']",
  "[class*='EventsList']",
  "[class*='EventList']",
  "[class*='MatchEvents']",
  "[class*='Incident']",
  "[class*='MatchLiveModule']",
  "[class*='InPlayModule']",
];

const TIMELINE_MINUTE_LINE_RE = /^\d{1,3}['′]?\s*$/;
const TIMELINE_ROW_SIGNAL_RE =
  /Escanteio|Substitui|Cart[aã]o Amarelo|Cart[aã]o Vermelho|Goal|Gol|Impedimento|P[eê]nalti/i;
const TIMELINE_CORNER_ORDINAL_RE = /^(\d+)[º°]\s*Escanteio/i;
const TIMELINE_EXPAND_TOTALS_RE = /^Exibir Totais da Partida$/i;

function scoreTimelinePanelText(text) {
  const s = String(text || "");
  if (!/Cronologia/i.test(s)) return 0;
  const minutes = (s.match(/\b\d{1,3}['′]\b/g) || []).length;
  const events = (s.match(TIMELINE_ROW_SIGNAL_RE) || []).length;
  let score = minutes * 40 + events * 25;
  if (/xG|Ataques Perigosos|% de Posse/i.test(s)) score -= 90;
  if (/Tabela/i.test(s) && minutes < 2) score -= 30;
  return score;
}

function isTimelineRowText(text) {
  const s = normalize(text);
  if (!s || s.length > 80) return false;
  if (TIMELINE_EXPAND_TOTALS_RE.test(s)) return true;
  if (TIMELINE_MINUTE_LINE_RE.test(s)) return true;
  if (TIMELINE_ROW_SIGNAL_RE.test(s) && !/xG|Ataques|Posse/i.test(s)) return true;
  return false;
}

function isTimelineExpandTotalsText(text) {
  return TIMELINE_EXPAND_TOTALS_RE.test(normalize(text));
}

function parseCornerOrdinal(text) {
  const m = normalize(text).match(TIMELINE_CORNER_ORDINAL_RE);
  return m ? parseInt(m[1], 10) : null;
}

function minuteLineValue(line) {
  const m = normalize(line).match(/^(\d{1,3})['′]?\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

function findMinuteNearLine(lines, index, radius = 4) {
  for (let j = index - 1; j >= Math.max(0, index - radius); j--) {
    const minute = minuteLineValue(lines[j]);
    if (minute !== null) return minute;
  }
  for (let j = index + 1; j < Math.min(lines.length, index + radius); j++) {
    const minute = minuteLineValue(lines[j]);
    if (minute !== null) return minute;
  }
  return null;
}

function makeCornerEvent(minute, description, source) {
  const desc = normalize(description);
  return { minute, type: "corner", description: desc, details: [desc], source };
}

function parseEscanteiosCountFromStatsText(text) {
  const lines = linesFromText(text).map(normalize).filter(Boolean);
  let home = null;
  let away = null;

  for (let i = 0; i < lines.length; i++) {
    if (!/^Escanteios$/i.test(lines[i])) continue;
    const nums = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      if (/^\d+$/.test(lines[j])) nums.push(parseInt(lines[j], 10));
      else if (nums.length) break;
    }
    if (nums.length >= 2) {
      home = nums[0];
      away = nums[1];
      break;
    }
  }

  if (home === null && away === null) return null;
  return { home: home ?? 0, away: away ?? 0, total: (home ?? 0) + (away ?? 0) };
}

function parseCornerTimelineHintsFromText(text) {
  const lines = linesFromText(text).map(normalize).filter(Boolean);
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const glued = line.match(/^(\d{1,3})['′]\s+(\d+[º°]\s*Escanteio.*)$/i);
    if (glued) {
      events.push(makeCornerEvent(parseInt(glued[1], 10), glued[2], "stats-hint"));
      continue;
    }
    if (!TIMELINE_CORNER_ORDINAL_RE.test(line)) continue;
    if (isTimelineMarketLeakLine(line) || isTimelineNoiseDetail(line)) continue;
    const minute = findMinuteNearLine(lines, i);
    if (minute !== null) events.push(makeCornerEvent(minute, line, "stats-hint"));
  }

  return events;
}

function inferMissingCornerMinute(ordinal, events, allLines, maxMinute = 45) {
  const used = new Set(events.filter((e) => e.minute).map((e) => e.minute));
  const minuteLines = allLines.map(minuteLineValue).filter((m) => m !== null && !used.has(m));
  const second = events.find((e) => e.type === "corner" && parseCornerOrdinal(e.description) === 2);
  const card7 = events.find((e) => e.type === "card" && e.minute === 7);
  const upper = second?.minute || maxMinute;

  if (ordinal === 1 && card7 && minuteLines.some((m) => m === 8)) return 8;

  const gap = minuteLines.filter((m) => m > 7 && m < upper).sort((a, b) => a - b);
  if (gap.length) return gap[0];
  if (ordinal === 1 && card7 && upper > 7) return 8;
  return null;
}

function reconcileTimelineCorners(events, sectionLines = [], options = {}) {
  const allLines = (sectionLines.length ? sectionLines : linesFromText(options.fullText || ""))
    .map(normalize)
    .filter(Boolean);
  const fullText = String(options.fullText || "");
  const statsCount =
    options.statsCount ||
    parseEscanteiosCountFromStatsText(fullText) ||
    parseEscanteiosCountFromStatsText(options.escanteiosText || "");

  let out = [...events];
  const hasEight = allLines.some((l) => minuteLineValue(l) === 8);

  if (hasEight) {
    out = out.map((e) => {
      if (e.type !== "corner" || parseCornerOrdinal(e.description) !== 1) return e;
      const goalAtSame = out.some((g) => g.type === "goal" && g.minute === e.minute);
      if (goalAtSame && e.minute === 15) {
        return { ...e, minute: 8, source: `${e.source || "visible-text"}-relocated` };
      }
      return e;
    });
  }

  const coveredOrdinals = new Set(
    out
      .filter((e) => e.type === "corner")
      .map((e) => parseCornerOrdinal(e.description))
      .filter(Boolean)
  );

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const ordinal = parseCornerOrdinal(line);
    if (!ordinal || coveredOrdinals.has(ordinal)) continue;
    if (isTimelineMarketLeakLine(line) || isTimelineNoiseDetail(line)) continue;

    let minute = findMinuteNearLine(allLines, i);
    if (minute === 15 && ordinal === 1 && out.some((g) => g.type === "goal" && g.minute === 15)) {
      minute = inferMissingCornerMinute(ordinal, out, allLines);
    }
    if (minute === null && ordinal === 1 && hasEight) minute = 8;
    if (minute !== null) {
      out.push(makeCornerEvent(minute, line, "visible-text-recovered"));
      coveredOrdinals.add(ordinal);
    }
  }

  if (statsCount?.total) {
    const cornerEvents = out.filter((e) => e.type === "corner");
    const missing = statsCount.total - cornerEvents.length;
    if (missing > 0 && missing <= 2) {
      for (let ordinal = 1; ordinal <= statsCount.total; ordinal++) {
        if (coveredOrdinals.has(ordinal)) continue;
        const hasHigher = cornerEvents.some((e) => {
          const o = parseCornerOrdinal(e.description);
          return o !== null && o > ordinal;
        });
        if (ordinal > 1 && !hasHigher) continue;
        const minute = inferMissingCornerMinute(ordinal, out, allLines);
        if (minute !== null) {
          out.push(makeCornerEvent(minute, `${ordinal}° Escanteio`, "stats-inferred"));
          coveredOrdinals.add(ordinal);
        }
      }
    }
  }

  return dedupeTimelineEvents(out);
}

const GOAL_ORDINAL_RE = /^(\d+)[º°]\s*(?:Goal|Gol)/i;
const SCOREBOARD_CLOCK_SCORER_RE =
  /\b\d{1,2}:\d{2}\s+([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30})\s+(?:GOL(?:GOL)+|GOL\b)/i;
const SCOREBOARD_SCORER_MINUTES_RE =
  /\b([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30})\s+((?:\d{1,3}['′]\s*,\s*)*\d{1,3}['′])/gi;
const GOAL_SCORER_JUNK_RE =
  /^(Jogadores Titulares|Mostrar Mais|SUBSTITUIÇÃO\+|A Qualquer Momento|Para Marcar|Marcadores|Resultado Correto|Jogador a Marcar)$/i;
const GOAL_ODDS_MINUTE_RE = /^(\d{1,2})(?:\.0+)?$/;

function parseGoalOrdinal(text) {
  const m = normalize(text).match(GOAL_ORDINAL_RE);
  return m ? parseInt(m[1], 10) : null;
}

function goalPlayerSurname(value = "") {
  const text = String(value || "");
  const name = text
    .split("|")
    .map((part) => part.trim())
    .find((part) => part && !/^\d+[º°]\s*Goal/i.test(part))
    ?.replace(/\s*-\s*(Chute|Cabeçada|Pênalti|Assist).*$/i, "")
    .trim();
  return (name || text).split(/\s+/).pop()?.toLowerCase() || "";
}

function goalEventMatchesHint(event, hint = {}) {
  if (event?.type !== "goal" || !Number.isFinite(hint?.minute) || !hint?.player) return false;
  if (event.minute !== hint.minute) return false;
  return goalPlayerSurname(event.description) === goalPlayerSurname(hint.player);
}

function dedupeTimelineGoals(events) {
  const goals = [];
  const others = [];

  for (const event of events) {
    if (event.type !== "goal") {
      others.push(event);
      continue;
    }
    const duplicate = goals.find(
      (g) =>
        g.minute === event.minute &&
        goalPlayerSurname(g.description) === goalPlayerSurname(event.description)
    );
    if (duplicate) {
      const prefer =
        event.source === "visible-text" ||
        (duplicate.source !== "visible-text" && event.source === "scoreboard-inferred");
      if (prefer) {
        const idx = goals.indexOf(duplicate);
        goals[idx] = event;
      }
      continue;
    }
    goals.push(event);
  }

  return [...others, ...goals];
}

function makeGoalEvent(minute, ordinal, player, source, extras = {}) {
  const ord = `${ordinal}° Goal`;
  const parts = [ord];
  if (player) parts.push(extras.method ? `${player} - ${extras.method}` : player);
  if (extras.assist) parts.push(`${extras.assist} - Assist`);
  const desc = parts.join(" | ");
  return {
    minute: Number.isFinite(minute) ? minute : null,
    type: "goal",
    description: desc,
    details: parts,
    source,
  };
}

function enrichGoalHint(hint = {}, events = [], texts = []) {
  if (!hint?.player) return hint;
  const surname = hint.player.split(/\s+/).pop();
  if (!surname || surname.length < 3) return hint;

  const corpus = [...texts, ...events.map((e) => e.description || "")].join("\n");
  const chuteRe = new RegExp(`${surname}[A-Za-zÀ-ú' .-]{0,24}\\s*-\\s*Chute`, "i");
  const assistRe = /([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,28})\s*-\s*Assist/;

  const method = chuteRe.test(corpus) ? "Chute" : hint.method || null;
  const assistMatch = corpus.match(assistRe);

  return {
    ...hint,
    method,
    assist: assistMatch?.[1]?.trim() || hint.assist || null,
  };
}

function isLikelyScorerName(name) {
  const s = normalize(name);
  if (!s || s.length > 40) return false;
  if (s.split(/\s+/).length > 4) return false;
  if (GOAL_SCORER_JUNK_RE.test(s)) return false;
  if (NETWORK_NAME_BLOCK_RE.test(s)) return false;
  if (/^(Noruega|Senegal|França|France|Iraque|Iraq|Argentina|Áustria|Austria|Empate)$/i.test(s)) {
    return false;
  }
  return isPlayerShortName(s) || isPlayerFullName(s);
}

function parseGoalScorersFromText(text) {
  const lines = linesFromText(text).map(normalize).filter(Boolean);
  const start = lines.findIndex((l) => /^Marcadores de Gols?$/i.test(l) || /^Marcadores$/i.test(l));
  if (start < 0) return [];

  const goals = [];
  let inScorerList = /^Marcadores$/i.test(lines[start]) && !/de Gol/i.test(lines[start]);

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^(Cronologia|Escalação|Tabela|FINALIZA)/i.test(line)) break;
    if (/^Marcadores$/i.test(line)) {
      inScorerList = true;
      continue;
    }
    if (/^Jogadores Titulares$/i.test(line)) {
      inScorerList = false;
      continue;
    }
    if (!isLikelyScorerName(line)) continue;

    let minute = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const m = lines[j].match(/^(\d{1,3})['′]\s*$/);
      if (m) {
        minute = parseInt(m[1], 10);
        break;
      }
      if (isLikelyScorerName(lines[j])) break;
    }

    if (!inScorerList && minute === null) continue;

    goals.push({
      minute,
      player: line,
      ordinal: goals.length + 1,
      source: "marcadores-inferred",
    });
  }

  return goals;
}

function parseGoalsFromScoreboardText(text) {
  const flat = normalize(text);
  if (!flat) return [];

  const goals = [];
  const seen = new Set();

  const pushGoal = (minute, player, source) => {
    if (!isLikelyScorerName(player)) return;
    const key = `${minute ?? "?"}|${player}`;
    if (seen.has(key)) return;
    seen.add(key);
    goals.push({
      minute: Number.isFinite(minute) ? minute : null,
      player: normalize(player),
      ordinal: goals.length + 1,
      source,
    });
  };

  const clockMatch = flat.match(SCOREBOARD_CLOCK_SCORER_RE);
  if (clockMatch) pushGoal(null, clockMatch[1], "scoreboard-inferred");

  let m;
  const playerMinutes = new RegExp(SCOREBOARD_SCORER_MINUTES_RE.source, "gi");
  while ((m = playerMinutes.exec(flat)) !== null) {
    const minutes = [...String(m[2]).matchAll(/(\d{1,3})['′]/g)].map((hit) => parseInt(hit[1], 10));
    const prefix = String(m[0])
      .slice(0, Math.max(0, String(m[0]).indexOf(String(m[2]))))
      .trim();
    const words = prefix.split(/\s+/).filter(Boolean);
    let player = null;
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      const candidate = words.slice(-len).join(" ");
      if (isLikelyScorerName(candidate)) {
        player = candidate;
        break;
      }
    }
    if (!player) continue;
    for (const minute of minutes) {
      pushGoal(minute, player, "scoreboard-inferred");
    }
  }

  return goals.sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
}

function parseGoalsFromOdds(odds = []) {
  const goals = [];

  for (const row of odds || []) {
    const market = String(row.market || "");
    const ordinalMatch = market.match(/(\d+)[º°]\s*Gol/i);
    if (!ordinalMatch) continue;

    const player = String(row.selection || "").trim();
    if (!isLikelyScorerName(player)) continue;

    const oddsText = String(row.odds ?? "");
    const minuteMatch = oddsText.match(GOAL_ODDS_MINUTE_RE);
    if (!minuteMatch) continue;

    const minute = parseInt(minuteMatch[1], 10);
    const oddNum = parseFloat(String(row.odds ?? "").replace(",", "."));
    if (minute < 1 || minute > 120) continue;
    if (Number.isFinite(oddNum) && isLikelyMinuteAsOdd(oddNum, market, player)) continue;
    if (/^\d+[º°]\s*Gol$/i.test(market) && Number.isFinite(oddNum) && oddNum >= 51) continue;

    goals.push({
      minute,
      player,
      ordinal: parseInt(ordinalMatch[1], 10),
      source: "odds-inferred",
    });
  }

  return goals;
}

function rankGoalHint(hint) {
  let rank = 0;
  if (Number.isFinite(hint?.minute)) rank += 100;
  if (hint?.source === "scoreboard-inferred") rank += 50;
  if (hint?.source === "odds-inferred") rank += 40;
  if (hint?.source === "marcadores-inferred" && Number.isFinite(hint?.minute)) rank += 30;
  if (hint?.source === "marcadores-inferred") rank += 5;
  if (hint?.source === "finalizations-inferred") rank += 10;
  return rank;
}

function parseGoalsFromPlayerFinalizations(rows = []) {
  const hinted = rows.filter(
    (row) =>
      row?.player &&
      parseInt(row.onTarget, 10) >= 1 &&
      parseInt(row.shots, 10) === 0 &&
      isLikelyScorerName(row.player)
  );
  if (hinted.length !== 1) return [];

  return [
    {
      minute: null,
      player: hinted[0].player,
      ordinal: 1,
      source: "finalizations-inferred",
    },
  ];
}

function collectScoreboardHintText(domProbe = [], extraTexts = []) {
  const chunks = [];
  for (const entry of domProbe || []) {
    if (!/scoreboard/i.test(entry?.source || "")) continue;
    for (const sample of entry.samples || []) {
      if (sample) chunks.push(sample);
    }
  }
  for (const text of extraTexts || []) {
    if (text) chunks.push(String(text));
  }
  return chunks.join("\n");
}

function gatherGoalRecoveryHints(options = {}) {
  const hints = [];

  hints.push(...parseGoalsFromScoreboardText(options.scoreboardText || ""));
  hints.push(...parseGoalsFromOdds(options.odds));

  for (const text of [options.marcadoresText, options.goalScorersText].filter(Boolean)) {
    hints.push(...parseGoalScorersFromText(text));
  }

  hints.push(...parseGoalsFromPlayerFinalizations(options.playerFinalizations));

  const seen = new Set();
  const deduped = hints.filter((hint) => {
    const key = `${hint.minute ?? "?"}|${hint.player ?? ""}|${hint.ordinal ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => rankGoalHint(b) - rankGoalHint(a));
}

function reconcileTimelineGoals(events, options = {}) {
  const expected =
    options.expectedGoals ??
    scoreTotalFromMatch(options.match) ??
    (options.scoreHome != null && options.scoreAway != null
      ? options.scoreHome + options.scoreAway
      : null);
  if (!expected || expected < 1) return events;

  let out = events.filter((e) => e.type !== "goal" || isRealTimelineGoal(e));
  const goalEvents = out.filter((e) => e.type === "goal");
  if (goalEvents.length >= expected) return out;

  const coveredOrdinals = new Set(
    goalEvents.map((e) => parseGoalOrdinal(e.description)).filter(Boolean)
  );
  const hints = gatherGoalRecoveryHints(options);
  const usedHints = new Set();
  const hintAlreadyCovered = (hint) =>
    hint && out.some((event) => goalEventMatchesHint(event, hint));

  for (let ordinal = 1; ordinal <= expected; ordinal++) {
    if (coveredOrdinals.has(ordinal)) continue;
    if (out.filter((e) => e.type === "goal").length >= expected) break;

    const hint =
      hints.find((h) => h.ordinal === ordinal && !usedHints.has(h) && !hintAlreadyCovered(h)) ||
      hints.find((h) => !usedHints.has(h) && Number.isFinite(h.minute) && !hintAlreadyCovered(h)) ||
      hints.find((h) => !usedHints.has(h) && !hintAlreadyCovered(h));
    if (hint) usedHints.add(hint);
    if (hintAlreadyCovered(hint)) {
      coveredOrdinals.add(ordinal);
      continue;
    }

    const enriched = enrichGoalHint(hint || {}, out, [
      options.timelineText,
      options.scoreboardText,
      options.marcadoresText,
      options.goalScorersText,
    ]);

    out.push(
      makeGoalEvent(
        enriched?.minute ?? null,
        ordinal,
        enriched?.player || "",
        enriched?.source || hint?.source || "score-inferred",
        { method: enriched?.method, assist: enriched?.assist }
      )
    );
    coveredOrdinals.add(ordinal);
  }

  return stripGoalAbsorbedTimelineEvents(dedupeTimelineGoals(dedupeTimelineEvents(out)));
}

const PLAYER_SHORT_NAME_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30}$/;
const PLAYER_FULL_NAME_RE = /^[A-ZÀ-Ú][a-zà-ú'`-]+(?:\s+[A-ZÀ-Ú][a-zà-ú'`.-]+){1,4}$/;
const LINEUP_STOP_RE = /^(Tabela|Cronologia|Estat\.|Estatísticas de Jogador|FINALIZA)/i;

const TIMELINE_SECTION_STOP_RE = /^(Escalação|Tabela|FINALIZA(COES|ÇÕES))$/i;

const TIMELINE_STOP_RE =
  /^(Escalação|Tabela|Jogador\s*[-/]|Resultado Final|Marcadores de Gols|Encontro\s*-|N[uú]mero de Cart|Ambos Marcam|Argentina\s*-\s*Gols|Áustria\s*-\s*Gols|Informação e Atrasos|Ajuda|Depósitos|bet365|Política de|Jogue com responsabilidade|Hora do Servidor|FINALIZA|Áreas de A[cç]ão|Mostrar Mais|SUBSTITUIÇÃO\+)$/i;

const TIMELINE_ORDINAL_RE = /[º°]/;
const TIMELINE_EVENT_HEADER_RE = /^\d+[º°]\s*(Goal|Gol|Escanteio|Impedimento|Cart[aã]o)/i;
const TIMELINE_EVENT_RE =
  /\b(?:Goal|Gol)\b|Escanteio|Impedimento|P[eê]nalti|Cart[aã]o|\bAssist\b|Chute|Substitui|Perdeu o P[eê]nalti/i;

const NETWORK_NAME_BLOCK_RE =
  /Informa[cç][aã]o|Configura|Idioma|Ajuda|Dep[oó]sito|Saques?|Contate|Termos|Respons[aá]vel|T[eé]cnica|Privacidade|Cookies|Pagamentos|Reclama|Preven[cç][aã]o|Promo[cç][aã]o|Ofertas|Resultados|Not[ií]cias|Empregos|Parceiros|bet365|Facebook|Instagram|Logo|Servidor|reCAPTCHA|Regras|Promoções|Áudio|Futebol|Estatísticas|Esportes|Sites|Jogue com|Todos os|Ao-Vivo|Minhas Apostas|Cassino|Popular|Criar Aposta|Instantâneas|Intervalo|Marcadores|Tabela|Cronologia|Escalação/i;

const LINEUP_WIRE_SOURCE_RE = /ipe\/5378|ipe-BR|sportspublisher\/zap|zap-ws/i;
const LINEUP_BLOB_URL_RE = /ipe\/5378|ipe-BR/i;
const LINEUP_ZAP_URL_RE = /sportspublisher\/zap|zap-ws/i;
const LINEUP_WIRE_RECORD_RE =
  /(?:\||^|;|\x14)(?:PG|PA|SL|PI|OV|EV|MG);([^|]{0,320})|(?:\||^)(PA;[^|]{0,320})/gi;
const LINEUP_NA_RE = /\bNA=([^|;\x00-\x1f\x14]{2,40})/;

const GOAL_LINE_RE = /^(\d{1,3})['′]?\s+(.+)$/;

function isPlayerShortName(line) {
  const s = normalize(line);
  if (!s) return false;
  if (GOAL_LINE_RE.test(s)) return true;
  return PLAYER_SHORT_NAME_RE.test(s);
}

function isPlayerFullName(line) {
  const s = normalize(line);
  if (!s || s.length > 40) return false;
  if (NETWORK_NAME_BLOCK_RE.test(s)) return false;
  if (!PLAYER_FULL_NAME_RE.test(s)) return false;
  if (/\d/.test(s)) return false;
  return true;
}

function isLineupWireSource(url = "") {
  return LINEUP_WIRE_SOURCE_RE.test(url);
}

function isZapWireSource(url = "") {
  return LINEUP_ZAP_URL_RE.test(url);
}

function collectZapWireText(networkLog = []) {
  const chunks = [];
  for (const entry of networkLog || []) {
    const url = entry?.url || "";
    if (!LINEUP_ZAP_URL_RE.test(url) && entry.kind !== "ws") continue;
    const data = networkEntryText(entry);
    if (data && data.length >= 4) chunks.push(data);
  }
  return chunks.join("\n");
}

function isPlayerNameLine(line) {
  const s = normalize(line);
  if (!s) return false;
  if (GOAL_LINE_RE.test(s)) return true;
  return isPlayerShortName(s) || isPlayerFullName(s);
}

function looksLikeOddToken(s) {
  return /^\d+(\.\d{2,3})?$/.test(s) && isValidOdd(parseOdd(s));
}

function isTimelineStopLine(line) {
  const s = normalize(line);
  if (!s) return false;
  if (TIMELINE_STOP_RE.test(s)) return true;
  if (/^Jogador\s*[-/]/i.test(s)) return true;
  if (/^Áustria\s*-\s*Gols$/i.test(s) || /^Argentina\s*-\s*Gols$/i.test(s)) return true;
  return false;
}

function isTimelineSectionStopLine(line) {
  const s = normalize(line);
  if (!s) return false;
  return TIMELINE_SECTION_STOP_RE.test(s);
}

function isTimelineNoiseDetail(line) {
  const s = normalize(line);
  if (!s || s.length < 2) return true;
  if (/^Exibir Totais da Partida$/i.test(s)) return true;
  if (/^\d{1,3}:\d{2}$/.test(s)) return true;
  if (/^CA$/i.test(s)) return true;
  if (/^\d+\+$/.test(s)) return true;
  if (/^\d+[º°]$/.test(s)) return true;
  if (isTimelineMarketLeakLine(s)) return true;
  if (looksLikeOddToken(s)) return true;
  if (
    /^(Mais de|Menos de|Exatamente|A Qualquer Momento|Para Marcar ou Dar Assistência|Jogador a Marcar ou Dar Assistência)$/i.test(
      s
    )
  ) {
    return true;
  }
  if (/^(Encontro\s*-|N[uú]mero de|Nº\s*Escanteios|Escanteios\s*-)/i.test(s)) return true;
  if (/^Escanteios\s*\/\s*Cart[oõ]es$/i.test(s)) return true;
  if (/^\d+º\s*Tempo\s*[-/]\s*Escanteios$/i.test(s)) return true;
  if (/^1º\s*Tempo\s*-\s*Escanteios$/i.test(s)) return true;
  if (
    /^(Popular|Instantâneas|Escanteios\/Cartões|Gols|1º Tempo\/2º Tempo|Jogador|Especiais|Odds Asiáticas|Criar Aposta)$/i.test(
      s
    )
  ) {
    return true;
  }
  if (
    /^(xG|Ataques Perigosos|Ataques|% de Posse|Passes Chave|Goleiro - Defesas|Precisão dos Passes|Cruzamentos|Finalizações\s*\/\s*Chutes ao Gol)$/i.test(
      s
    )
  ) {
    return true;
  }
  if (NETWORK_NAME_BLOCK_RE.test(s)) return true;
  if (isPlayerShortName(s) && !TIMELINE_EVENT_RE.test(s)) return true;
  if (/\d+\.\d{2}/.test(s) && !TIMELINE_EVENT_RE.test(s)) return true;
  if (/\|/.test(s) && !TIMELINE_EVENT_RE.test(s)) return true;
  return false;
}

function isTimelineMarketLeakLine(line) {
  const s = normalize(line);
  if (!s) return false;
  if (/^Próximo Minuto/i.test(s)) return true;
  if (/^Gol\s*\|\s*Escanteio/i.test(s)) return true;
  if (/Primeiro a Marcar/i.test(s)) return true;
  if (/2[º°]\s*Gol\s*-\s*Método/i.test(s)) return true;
  if (/Sem\s+\d+[º°]?\s*gol/i.test(s)) return true;
  if (/^\d+[º°]\s*Gol$/i.test(s)) return true;
  if (/Hora do \d/i.test(s)) return true;
  if (/Gol antes do minuto/i.test(s)) return true;
  if (/Sem Gol antes do minuto/i.test(s)) return true;
  if (/Para Qualquer um Receber/i.test(s)) return true;
  if (/Último Marcador de Gol/i.test(s)) return true;
  if (/Substituto Sim\/Não/i.test(s)) return true;
  if (/^Escanteios Asiáticos$/i.test(s)) return true;
  if (/^Partida\s*-\s*(Chutes|Impedimentos)/i.test(s)) return true;
  if (/^Impedimentos Atuais/i.test(s)) return true;
  if (/^Impedimentos do Time$/i.test(s)) return true;
  if (/^Time\s*-\s*Chutes$/i.test(s)) return true;
  const pipes = (s.match(/\|/g) || []).length;
  if (pipes >= 3 && /Gol|Escanteio|Cart[aã]o|P[eê]nalti|M[eé]todo|Gol Contra/i.test(s)) {
    return true;
  }
  return false;
}

function isRealTimelineGoal(event) {
  if (event?.type !== "goal") return false;
  const desc = String(event.description || "");
  const details = event.details || [];
  if (isTimelineMarketLeakLine(desc) || details.some((d) => isTimelineMarketLeakLine(d)))
    return false;
  if (/\d+[º°]\s*Goal/i.test(desc)) return true;
  if (/ - (Chute|Assist)/i.test(desc)) return true;
  if (/inferred/.test(event.source || "")) return true;
  return false;
}

function isTimelineFakeOrdinalGoal(details) {
  const text = details.join(" | ");
  if (/Sem\s+\d+[º°]?\s*gol/i.test(text)) return true;
  if (/^\d+[º°]\s*Gol$/i.test(normalize(details[0] || "")) && !/Chute|Assist|Goal/i.test(text)) {
    return true;
  }
  return false;
}

function isTimelineEventAnchor(line) {
  const s = normalize(line);
  if (!s) return false;
  if (/^Substitui/i.test(s)) return true;
  if (TIMELINE_EVENT_HEADER_RE.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

function isTimelineEventDetail(line) {
  const s = normalize(line);
  if (!s || isTimelineNoiseDetail(s)) return false;
  if (isTimelineEventAnchor(s)) return true;
  if (TIMELINE_EVENT_RE.test(s)) return true;
  if (/ - (Chute|Assist)/i.test(s)) return true;
  return false;
}

function extractTimelineSectionLines(text) {
  const lines = linesFromText(text);
  const start = lines.findIndex((l) => /^Cronologia$/i.test(l));
  if (start < 0) return null;

  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isTimelineSectionStopLine(lines[i])) break;
    section.push(lines[i]);
  }
  return section;
}

function mergeTimelineSectionTexts(...texts) {
  const seen = new Set();
  const merged = [];

  for (const text of texts) {
    const section = extractTimelineSectionLines(text);
    const lines = section?.length ? section : linesFromText(text);
    for (const line of lines) {
      if (/^---/.test(line)) continue;
      const key = normalize(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
  }

  if (!merged.length) return "";
  return `Cronologia\n${merged.join("\n")}`;
}

function shouldKeepTimelineEvent(details) {
  if (!details.length) return false;
  const description = details.join(" | ");
  if (isTimelineMarketLeakLine(description)) return false;
  if (details.some((d) => isTimelineMarketLeakLine(d))) return false;
  if (inferTimelineType(details) === "goal" && isTimelineFakeOrdinalGoal(details)) return false;
  const type = inferTimelineType(details);
  if (type !== "event") return true;
  return details.some((d) => TIMELINE_EVENT_RE.test(d));
}

function dedupeTimelineEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.minute}|${e.type}|${e.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function goalDetailToken(description = "") {
  const parts = String(description)
    .split("|")
    .map((p) => p.trim());
  for (const part of parts) {
    const shot = part.match(/^(.+?)\s*-\s*(Chute|Cabeçada|Pênalti)$/i);
    if (shot) {
      const surname = shot[1].trim().split(/\s+/).pop().toLowerCase();
      return { surname, method: shot[2].toLowerCase() };
    }
    const plain = part.match(/^([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]+)$/);
    if (plain && !/^\d+[º°]/.test(plain[1])) {
      const surname = plain[1].trim().split(/\s+/).pop().toLowerCase();
      return { surname, method: null };
    }
  }
  return null;
}

function stripGoalAbsorbedTimelineEvents(events) {
  const goals = events.filter((e) => e.type === "goal");
  if (!goals.length) return events;

  const absorbed = goals.map((g) => goalDetailToken(g.description)).filter(Boolean);

  return events.filter((e) => {
    if (e.type === "goal") return true;
    const shot = String(e.description || "").match(/^(.+?)\s*-\s*(Chute|Cabeçada|Pênalti)$/i);
    if (!shot) return true;
    const surname = shot[1].trim().split(/\s+/).pop().toLowerCase();
    const method = shot[2].toLowerCase();
    return !absorbed.some((g) => g.surname === surname && (!g.method || g.method === method));
  });
}

function buildTimelineEvent(minute, details) {
  const filtered = details.filter((d) => isTimelineEventDetail(d));
  if (!shouldKeepTimelineEvent(filtered)) return null;
  return {
    minute,
    type: inferTimelineType(filtered),
    description: filtered.join(" | "),
    details: filtered,
    source: "visible-text",
  };
}

function splitTimelineDetailGroups(details) {
  const groups = [];
  let group = [];

  for (const line of details) {
    if (isTimelineEventAnchor(line) && group.length) {
      groups.push(group);
      group = [line];
      continue;
    }
    group.push(line);
  }
  if (group.length) groups.push(group);
  return groups;
}

function flushTimelineGroups(events, minute, details) {
  if (!minute || !details.length) return;
  for (const group of splitTimelineDetailGroups(details)) {
    const event = buildTimelineEvent(minute, group);
    if (event) events.push(event);
  }
}

function parseTimelineLines(lines) {
  const events = [];
  let current = null;

  const flushCurrent = () => {
    if (!current || current.minute === 0) return;
    flushTimelineGroups(events, current.minute, current.details);
    current = null;
  };

  for (const line of lines) {
    if (isTimelineStopLine(line)) {
      flushCurrent();
      continue;
    }

    const min = line.match(/^(\d{1,3})['′]?\s*$/);
    if (min) {
      const minute = parseInt(min[1], 10);
      if (current?.details.length) {
        if (current.awaitingMinute) {
          flushTimelineGroups(events, minute, current.details);
          current = null;
          continue;
        }
        flushTimelineGroups(events, current.minute, current.details);
      }
      current = { minute, details: [], awaitingMinute: false };
      continue;
    }

    if (isTimelineNoiseDetail(line)) continue;
    if (!current) continue;

    if (isTimelineEventAnchor(line) && current.details.length) {
      const flushedType = inferTimelineType(current.details);
      flushTimelineGroups(events, current.minute, current.details);
      current.details = [line];
      current.awaitingMinute = /Goal|Gol/i.test(line) && flushedType === "substitution";
      continue;
    }

    current.details.push(line);
  }

  flushCurrent();
  return events;
}

function parseTimelineFromText(text, options = {}) {
  const section = extractTimelineSectionLines(text);
  const lines = section?.length ? section : linesFromText(text);
  let events = dedupeTimelineEvents(parseTimelineLines(lines));
  if (options.reconcile !== false) {
    events = reconcileTimelineCorners(events, section || lines, {
      fullText: text,
      escanteiosText: options.escanteiosText,
      statsCount: options.statsCount,
    });
  }
  return events;
}

function buildTimelineFromPanelTexts(textByTab = {}, options = {}) {
  const statsSubTabMerged = textByTab.statsSubTabMerged || "";
  const escanteiosText = textByTab.statsSubTabs?.escanteios || "";
  const statsText = [
    textByTab.stats || "",
    textByTab.goalScorers || "",
    textByTab.lateral || "",
    statsSubTabMerged,
  ]
    .filter(Boolean)
    .join("\n");
  const timelineText = textByTab.timeline || "";
  const allText = [timelineText, statsText, escanteiosText].filter(Boolean).join("\n");
  const statsCount = parseEscanteiosCountFromStatsText(escanteiosText || statsText);
  const reconcileOpts = { fullText: allText, escanteiosText, statsCount };

  const events = mergeTimelineEvents(
    parseTimelineFromText(timelineText, { ...reconcileOpts, reconcile: false }),
    parseTimelineFromText(statsText, { ...reconcileOpts, reconcile: false }),
    parseCornerTimelineHintsFromText(escanteiosText),
    parseCornerTimelineHintsFromText(statsText),
    parseCornerTimelineHintsFromText(allText)
  );
  const section =
    extractTimelineSectionLines(timelineText) ||
    extractTimelineSectionLines(allText) ||
    linesFromText(allText);
  let timeline = reconcileTimelineCorners(events, section, reconcileOpts);
  timeline = reconcileTimelineGoals(timeline, {
    ...options,
    marcadoresText: textByTab.statsSubTabs?.marcadores || textByTab.goalScorers,
    goalScorersText: textByTab.goalScorers,
  });
  return stripGoalAbsorbedTimelineEvents(timeline);
}

function mergeTimelineEvents(...lists) {
  return dedupeTimelineEvents(lists.flat());
}

function inferTimelineType(details) {
  const t = details.join(" ");
  if (details.some((d) => isTimelineMarketLeakLine(d)) || isTimelineMarketLeakLine(t)) {
    return "event";
  }
  if (/\d+[º°]\s*(?:Goal|Gol)\b/i.test(t)) return "goal";
  if (/ - Chute/i.test(t) && /\b(?:Goal|Gol)\b/i.test(t)) return "goal";
  if (/Escanteio/i.test(t)) return "corner";
  if (/Pênalti|Penalti/i.test(t)) return "penalty";
  if (/Impedimento/i.test(t)) return "offside";
  if (/Cart[aã]o/i.test(t)) return "card";
  if (/Substitui/i.test(t)) return "substitution";
  return "event";
}

function readWireContext(ctx) {
  const out = { sub: false, team: null, order: null, shots: null, onTarget: null, goalMin: null };
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
  const goal = ctx.match(/\b(\d{1,3})['′]/);
  if (goal) out.goalMin = parseInt(goal[1], 10);
  return out;
}

function mergePlayerFinalizations(...lists) {
  const seen = new Set();
  const rows = [];
  lists.flat().forEach((row) => {
    const key = `${row.player}|${row.shots}|${row.onTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  });
  return rows;
}

function dedupeWirePlayers(players) {
  const byName = new Map();
  players.forEach((p) => {
    const prev = byName.get(p.name);
    if (!prev || (p.team != null && prev.team == null) || (p.order != null && prev.order == null)) {
      byName.set(p.name, p);
    }
  });
  return [...byName.values()];
}

function extractLineupPlayersFromWireText(text, url = "") {
  const sample = String(text || "").slice(0, 2_000_000);
  if (!sample || sample.length < 40) return [];

  const players = [];
  const seenAt = new Set();

  if (isLineupWireSource(url)) {
    let rm;
    const recordRe = new RegExp(LINEUP_WIRE_RECORD_RE.source, "gi");
    while ((rm = recordRe.exec(sample)) !== null) {
      const chunk = rm[1] || rm[2] || "";
      const na = chunk.match(LINEUP_NA_RE);
      if (!na) continue;
      const name = na[1].trim();
      if (!isNetworkPlayerName(name) || !isPlayerNameLine(name)) continue;
      const ctx = readWireContext(chunk);
      const key = `${name}|${ctx.team ?? ""}|${ctx.order ?? ""}|${ctx.sub ? 1 : 0}`;
      if (seenAt.has(key)) continue;
      seenAt.add(key);
      players.push({ name, ...ctx });
    }
  }

  if (players.length < 8) {
    for (const m of sample.matchAll(/\bNA=([^|;\x00-\x1f\x14]{2,40})/g)) {
      const name = m[1].trim();
      if (!isNetworkPlayerName(name) || !isPlayerNameLine(name)) continue;
      const ctx = readWireContext(sample.slice(m.index, m.index + 140));
      const key = `${name}|${ctx.team ?? ""}|${ctx.order ?? ""}|${ctx.sub ? 1 : 0}`;
      if (seenAt.has(key)) continue;
      seenAt.add(key);
      players.push({ name, ...ctx });
    }
  }

  return dedupeWirePlayers(players);
}

function splitLineupPlayers(players) {
  const home = { starters: [], subs: [], goals: [] };
  const away = { starters: [], subs: [], goals: [] };

  const homeTagged = players.filter((p) => p.team === 1);
  const awayTagged = players.filter((p) => p.team === 2);

  if (homeTagged.length >= 8 && awayTagged.length >= 8) {
    homeTagged.forEach((p) => {
      if (p.goalMin) home.goals.push({ minute: p.goalMin, player: p.name });
      if (p.sub) home.subs.push(p.name);
      else home.starters.push(p.name);
    });
    awayTagged.forEach((p) => {
      if (p.sub) away.subs.push(p.name);
      else away.starters.push(p.name);
    });
    return { home, away };
  }

  const ordered = [...players].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const blocks = [[]];
  let block = 0;
  ordered.forEach((p) => {
    if (p.sub && blocks[block].length >= 8) {
      block++;
      blocks[block] = blocks[block] || [];
    }
    blocks[block].push(p);
  });

  if (blocks[0]?.length) {
    blocks[0].forEach((p) => {
      if (p.goalMin) home.goals.push({ minute: p.goalMin, player: p.name });
      if (p.sub) home.subs.push(p.name);
      else home.starters.push(p.name);
    });
  }

  if (blocks[1]?.length) {
    const mid = blocks[1];
    const awayStarters = Math.min(11, Math.max(0, mid.length - 2));
    if (mid.length > awayStarters) {
      mid.slice(0, mid.length - awayStarters).forEach((p) => {
        if (p.sub) home.subs.push(p.name);
        else if (!home.starters.includes(p.name)) home.subs.push(p.name);
      });
      mid.slice(-awayStarters).forEach((p) => {
        if (p.sub) away.subs.push(p.name);
        else away.starters.push(p.name);
      });
    } else {
      mid.forEach((p) => {
        if (p.sub) home.subs.push(p.name);
        else home.starters.push(p.name);
      });
    }
  }

  if (blocks[2]?.length) {
    blocks[2].forEach((p) => {
      if (p.sub) away.subs.push(p.name);
      else away.starters.push(p.name);
    });
  }

  return { home, away };
}

function lineupWireSource(url = "") {
  return isZapWireSource(url) ? "network-zap" : "network-blob";
}

function parseLineupFromZapWire(data, url = "ws:sportspublisher/zap") {
  return parseLineupFromNetworkBlob(data, url);
}

function parseLineupFromNetworkBlob(data, url = "") {
  const text = typeof data === "string" ? data : data?._rawText ? String(data._rawText) : "";
  if (!text || !isLineupWireSource(url)) return null;

  const players = extractLineupPlayersFromWireText(text, url);
  if (players.length < 8) return null;

  const { home, away } = splitLineupPlayers(players);
  if (!home.starters.length && !away.starters.length) return null;

  return { home, away, source: lineupWireSource(url) };
}

function parsePlayerFinalizationsFromNetworkBlob(data, url = "") {
  const text = typeof data === "string" ? data : data?._rawText ? String(data._rawText) : "";
  if (!text || !isLineupWireSource(url)) return [];

  const rows = [];
  const seen = new Set();

  let rm;
  const recordRe = new RegExp(LINEUP_WIRE_RECORD_RE.source, "gi");
  while ((rm = recordRe.exec(text)) !== null) {
    const chunk = rm[1] || rm[2] || "";
    const na = chunk.match(LINEUP_NA_RE);
    if (!na) continue;
    const name = na[1].trim();
    if (!isNetworkPlayerName(name) || !isPlayerNameLine(name)) continue;
    const ctx = readWireContext(chunk);
    if (ctx.shots == null || ctx.onTarget == null) continue;
    const key = `${name}|${ctx.shots}|${ctx.onTarget}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      player: name,
      shots: ctx.shots,
      onTarget: ctx.onTarget,
      source: lineupWireSource(url),
    });
  }

  return rows;
}

const TITULARES_STOP_RE =
  /^(Mostrar Mais|A Qualquer Momento|Marcadores de Gol|Multi Marcadores|2°\s*Gol|Partida\s*-|Para Qualquer um|Para Marcar ou Dar Assistência|Jogador\s*[-/])/i;
const TITULARES_SKIP_RE = /^(CA|SUBSTITUIÇÃO\+?)$/i;
const TITULARES_BETTING_CONTEXT_RE =
  /^(Marcadores de Gol|Multi Marcadores|Para Qualquer um|Jogador a Marcar)/i;

const TITULARES_SECTION_RE = /^Jogadores Titulares$/i;

function escapeLineupTeamRe(team) {
  return String(team || "").replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

function isBettingMarketTitularesContext(lines, sectionIndex) {
  for (let i = Math.max(0, sectionIndex - 8); i < sectionIndex; i++) {
    if (TITULARES_BETTING_CONTEXT_RE.test(lines[i])) return true;
  }
  return false;
}

function collectTitularesBlock(lines, startIndex) {
  const names = [];
  const seen = new Set();

  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    if (TITULARES_SECTION_RE.test(line)) break;
    if (TITULARES_SKIP_RE.test(line)) continue;
    if (TITULARES_STOP_RE.test(line)) break;
    if (/^\d{1,2}$/.test(line)) continue;
    if (/^\d+(\.\d{2})?$/.test(line)) continue;
    if (!isPlayerFullName(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    names.push(line);
  }

  return names;
}

function parseLineupByTeamHeaders(text, homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return null;
  const lines = linesFromText(text);
  const home = [];
  const away = [];
  let side = null;
  const homeRe = new RegExp(`^${escapeLineupTeamRe(homeTeam)}$`, "i");
  const awayRe = new RegExp(`^${escapeLineupTeamRe(awayTeam)}$`, "i");

  for (const line of lines) {
    if (homeRe.test(line)) {
      side = "home";
      continue;
    }
    if (awayRe.test(line)) {
      side = "away";
      continue;
    }
    if (TITULARES_STOP_RE.test(line) || TITULARES_SECTION_RE.test(line)) {
      side = null;
      continue;
    }
    if (!isPlayerNameLine(line)) continue;
    if (side === "home" && home.length < 11) home.push(line);
    else if (side === "away" && away.length < 11) away.push(line);
  }

  if (home.length < 8 || away.length < 8) return null;
  return {
    home: { starters: home, subs: [], goals: [] },
    away: { starters: away, subs: [], goals: [] },
    source: "visible-titulares-teams",
  };
}

function extractLineupSectionFromText(text) {
  const lines = linesFromText(text);
  const start = lines.findIndex((l) => /^Escalação$/i.test(l));
  if (start < 0) return "";

  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^(Cronologia|Tabela|Estat\.|FINALIZA)/i.test(lines[i])) break;
    out.push(lines[i]);
  }
  const chunk = out.join("\n");
  const playerCount = out.filter((line) => isPlayerNameLine(line)).length;
  return /Escalação/i.test(chunk) && playerCount >= 8 ? chunk : "";
}

function extractGoalScorersSectionFromText(text) {
  const lines = linesFromText(text);
  for (let i = 0; i < lines.length; i++) {
    if (!/^Marcadores de Gols?$/i.test(lines[i])) continue;
    const chunk = lines.slice(i, Math.min(lines.length, i + 120)).join("\n");
    if (/\nMarcadores\n/i.test(chunk) && /\d{1,3}['′]\s*$/m.test(chunk)) return chunk;
    if (/\n[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,28}\n\d{1,3}['′]\s*$/m.test(chunk)) {
      return chunk;
    }
  }
  return "";
}

function parseLineupFromTitularesText(text, options = {}) {
  const lines = linesFromText(text);
  const byTeams = parseLineupByTeamHeaders(text, options.homeTeam, options.awayTeam);
  if (byTeams) return byTeams;

  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TITULARES_SECTION_RE.test(lines[i])) continue;
    if (isBettingMarketTitularesContext(lines, i)) continue;
    const names = collectTitularesBlock(lines, i);
    if (names.length >= 8) blocks.push(names);
  }

  if (blocks.length >= 2) {
    return {
      home: { starters: blocks[0].slice(0, 11), subs: [], goals: [] },
      away: { starters: blocks[1].slice(0, 11), subs: [], goals: [] },
      source: "visible-titulares",
    };
  }

  if (blocks.length === 1) {
    const names = blocks[0];
    return {
      home: { starters: names.slice(0, 11), subs: [], goals: [] },
      away: { starters: names.slice(11, 22), subs: names.slice(22), goals: [] },
      source: "visible-titulares",
    };
  }

  return null;
}

function parseLineupFromText(text) {
  const lines = linesFromText(text);
  let start = lines.findIndex((l) => /^Escalação$/i.test(l));
  if (start < 0) {
    start = lines.findIndex(
      (l) =>
        /\bEscalação\b/i.test(l) && !/Escalações/i.test(l) && /Cronologia|Tabela|Estat/i.test(l)
    );
  }
  if (start < 0) return null;

  const home = { starters: [], subs: [], goals: [] };
  const away = { starters: [], subs: [], goals: [] };
  const blocks = [[]];
  let block = 0;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (LINEUP_STOP_RE.test(line)) break;
    if (/^Suplentes$/i.test(line)) {
      block++;
      blocks[block] = blocks[block] || [];
      continue;
    }

    const goal = line.match(GOAL_LINE_RE);
    if (goal) {
      home.goals.push({ minute: parseInt(goal[1], 10), player: goal[2].trim() });
      continue;
    }

    if (!isPlayerNameLine(line)) continue;
    blocks[block].push(line);
  }

  if (blocks[0]?.length) home.starters = blocks[0];

  if (blocks[1]?.length) {
    const mid = blocks[1];
    const awayStarters = Math.min(11, Math.max(0, mid.length - 2));
    if (mid.length > awayStarters) {
      home.subs = mid.slice(0, mid.length - awayStarters);
      away.starters = mid.slice(-awayStarters);
    } else {
      home.subs = mid;
    }
  }

  if (blocks[2]?.length) away.subs = blocks[2];

  if (!home.starters.length && !away.starters.length) return null;

  return { home, away, source: "visible-text" };
}

function parsePlayerFinalizationsFromText(text) {
  const lines = linesFromText(text);
  const start = lines.findIndex((l) => /^FINALIZA(COES|ÇÕES)$/i.test(l));
  if (start < 0) return [];

  const rows = [];
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (LINEUP_STOP_RE.test(line) || /^Escalação$/i.test(line)) break;
    if (!isPlayerNameLine(line)) {
      i++;
      continue;
    }

    const player = line;
    i++;
    const nums = [];
    while (i < lines.length && nums.length < 2) {
      if (isPlayerNameLine(lines[i])) break;
      if (/^\d{1,2}$/.test(lines[i])) {
        nums.push(lines[i]);
        i++;
        continue;
      }
      if (isValidOdd(parseOdd(lines[i]))) break;
      i++;
    }

    if (nums.length >= 2) {
      rows.push({
        player,
        shots: nums[0],
        onTarget: nums[1],
        source: "visible-text",
      });
    }
  }

  return rows;
}

function parseActionAreasFromText(text) {
  const flat = String(text || "").replace(/\s+/g, " ");
  const m = flat.match(
    /Áreas de A[cç]ão[^%]{0,120}?(\d{1,2}(?:\.\d)?)%[^%]{0,60}?(\d{1,2}(?:\.\d)?)%[^%]{0,60}?(\d{1,2}(?:\.\d)?)%/i
  );
  if (!m) return null;
  return {
    left: `${m[1]}%`,
    center: `${m[2]}%`,
    right: `${m[3]}%`,
    source: "visible-text",
  };
}

function mergeSidePanelTabText(scoped, full, key) {
  const scopedText = String(scoped || "");
  const fullText = String(full || "");
  if (!scopedText) return fullText;
  if (!fullText) return scopedText;
  if (
    key === "stats" ||
    key === "goalScorers" ||
    key === "lateral" ||
    key === "timeline" ||
    key === "playerStats" ||
    key === "lineup"
  ) {
    return `${scopedText}\n---PAGE---\n${fullText}`;
  }
  return scopedText;
}

function extractSidePanelFromTexts(textByTab = {}, options = {}) {
  const statsSubTabMerged = textByTab.statsSubTabMerged || "";
  const goalScorersText =
    extractGoalScorersSectionFromText(textByTab.goalScorers || "") ||
    extractGoalScorersSectionFromText(textByTab.statsSubTabs?.marcadores || "") ||
    textByTab.goalScorers ||
    "";
  const statsText = [
    textByTab.stats || "",
    goalScorersText,
    textByTab.lateral || "",
    statsSubTabMerged,
  ]
    .filter(Boolean)
    .join("\n");
  const playerText = textByTab.playerStats || "";
  const timelineText = textByTab.timeline || "";
  const lineupText = extractLineupSectionFromText(textByTab.lineup || "") || textByTab.lineup || "";
  const panelMerged = [statsText, playerText, timelineText, lineupText].join("\n");
  const playerFinalizations = mergePlayerFinalizations(
    parsePlayerFinalizationsFromText(playerText),
    parsePlayerFinalizationsFromText(statsText),
    parsePlayerFinalizationsFromText(panelMerged)
  );
  const lineupOpts = {
    homeTeam: options.homeTeam,
    awayTeam: options.awayTeam,
  };

  return {
    timeline: buildTimelineFromPanelTexts(textByTab, {
      ...options,
      playerFinalizations,
    }),
    lineup:
      parseLineupFromText(lineupText) ||
      parseLineupFromText(extractLineupSectionFromText(statsText)) ||
      parseLineupFromText(statsText) ||
      parseLineupFromText(timelineText) ||
      parseLineupFromText(playerText) ||
      parseLineupByTeamHeaders(panelMerged, options.homeTeam, options.awayTeam) ||
      parseLineupFromTitularesText(panelMerged, lineupOpts),
    playerFinalizations,
    actionAreas: parseActionAreasFromText(statsText) || parseActionAreasFromText(playerText),
    tabCapture: {
      ...Object.fromEntries(
        Object.entries(textByTab)
          .filter(([k]) => !k.startsWith("statsSub"))
          .map(([k, v]) => [k, { length: String(v || "").length, captured: Boolean(v) }])
      ),
      statsSubTabs: textByTab.statsSubTabCapture || null,
    },
  };
}

function scanNetworkSidePanel(networkLog = []) {
  const timeline = [];
  const playerNames = new Set();
  const seen = new Set();
  let lineup = null;
  let playerFinalizations = [];

  const pushEvent = (minute, type, description, source) => {
    const key = `${minute}|${type}|${description}`;
    if (seen.has(key)) return;
    seen.add(key);
    timeline.push({ minute, type, description, source });
  };

  for (const entry of networkLog) {
    const url = entry?.url || "";
    const data = networkEntryText(entry);
    if (!data || data.length < 20) continue;

    const hintPlayers = entry.hints?.lineupPlayers;
    if (Array.isArray(hintPlayers)) {
      hintPlayers.forEach((p) => {
        if (isNetworkPlayerName(p?.name || p)) playerNames.add(p?.name || p);
      });
    }

    for (const m of data.matchAll(
      /(\d{1,3})['′]?\s*(?:º|°)?\s*(Gol|Goal|Escanteio|Corner|Impedimento|Offside|Pênalti|Penalti)/gi
    )) {
      pushEvent(parseInt(m[1], 10), inferTimelineType([m[2]]), m[2], "network-text");
    }

    for (const m of data.matchAll(
      /(\d{1,3})['′](?:[^'|;\n]{0,48}?)(\d+[º°]\s*(?:Escanteio|Corner))/gi
    )) {
      pushEvent(parseInt(m[1], 10), "corner", m[2], "network-text");
    }

    for (const m of data.matchAll(
      /(\d+[º°]\s*(?:Escanteio|Corner))[^'|;\n]{0,48}?(\d{1,3})['′]/gi
    )) {
      pushEvent(parseInt(m[2], 10), "corner", m[1], "network-text");
    }

    for (const m of data.matchAll(/NA=([^|;\x00-\x1f]{2,40})/g)) {
      const name = m[1].trim();
      if (!isNetworkPlayerName(name)) continue;
      playerNames.add(name);
    }

    if (/Messi|Gregoritsch|Escanteio|Impedimento|Perdeu o P[eê]nalti/i.test(data)) {
      const src = entry.url?.includes("Blob") ? "network-blob" : "network";
      for (const m of data.matchAll(
        /(Messi[^|]{0,40}|Escanteio|Impedimento|Perdeu o P[eê]nalti)/gi
      )) {
        pushEvent(null, inferTimelineType([m[1]]), m[1].trim(), src);
      }
    }

    if (!lineup && isLineupWireSource(url)) {
      lineup =
        parseLineupFromNetworkBlob(data, url) ||
        (hintPlayers?.length >= 8
          ? parseLineupFromNetworkBlob(
              hintPlayers
                .map(
                  (p) =>
                    `|PA;NA=${p.name};TM=${p.team || ""};OR=${p.order || ""};SU=${p.sub ? 1 : 0};`
                )
                .join(""),
              url
            )
          : null);
    }

    if (!playerFinalizations.length && isLineupWireSource(url)) {
      const finals = parsePlayerFinalizationsFromNetworkBlob(data, url);
      if (finals.length) playerFinalizations = finals;
    }
  }

  const zapWire = collectZapWireText(networkLog);
  const zapUrl = "ws:sportspublisher/zap";
  if (!lineup && zapWire.length >= 40) {
    lineup = parseLineupFromZapWire(zapWire, zapUrl);
  }
  if (!playerFinalizations.length && zapWire.length >= 40) {
    const finals = parsePlayerFinalizationsFromNetworkBlob(zapWire, zapUrl);
    if (finals.length) playerFinalizations = finals;
  }

  const zapDebug = buildZapWireDebug(networkLog, zapWire);

  return {
    timeline,
    lineup,
    playerFinalizations,
    playerNames: [...playerNames].slice(0, 40),
    blobDebug: [...buildIpeBlobDebug(networkLog), ...(zapDebug ? [zapDebug] : [])],
    sources: networkLog.length ? ["network-log"] : [],
  };
}

function buildZapWireDebug(networkLog = [], mergedText = "") {
  const entries = (networkLog || []).filter(
    (entry) => LINEUP_ZAP_URL_RE.test(entry?.url || "") || entry?.kind === "ws"
  );
  if (!entries.length && !mergedText) return null;

  const merged = mergedText || collectZapWireText(networkLog);
  const wirePlayers = extractLineupPlayersFromWireText(merged, "ws:sportspublisher/zap");
  const lineupAttempt = parseLineupFromZapWire(merged, "ws:sportspublisher/zap");
  const finalsAttempt = parsePlayerFinalizationsFromNetworkBlob(merged, "ws:sportspublisher/zap");
  const hintLineupPlayers = entries.flatMap((e) => e.hints?.lineupPlayers || []).slice(0, 24);

  const recordSamples = [];
  let rm;
  const recordRe = new RegExp(LINEUP_WIRE_RECORD_RE.source, "gi");
  while ((rm = recordRe.exec(merged)) !== null && recordSamples.length < 8) {
    recordSamples.push((rm[1] || rm[2] || "").slice(0, 160));
  }

  return {
    source: "zap-ws",
    url: "ws:sportspublisher/zap",
    kind: "ws",
    messageCount: entries.length,
    mergedLen: merged.length,
    largestMessage: entries.reduce((max, entry) => {
      const len = networkEntryText(entry).length;
      return Math.max(max, len);
    }, 0),
    hintLineupCount: hintLineupPlayers.length,
    hintLineupPlayers: hintLineupPlayers.map((p) =>
      typeof p === "string"
        ? { name: p }
        : {
            name: p.name,
            team: p.team ?? null,
            order: p.order ?? null,
            sub: Boolean(p.sub),
          }
    ),
    wirePlayerCount: wirePlayers.length,
    wirePlayers: wirePlayers.slice(0, 24).map((p) => ({
      name: p.name,
      team: p.team ?? null,
      order: p.order ?? null,
      sub: Boolean(p.sub),
    })),
    wireRecordSamples: recordSamples,
    lineupParsed: Boolean(lineupAttempt),
    lineupStarters: lineupAttempt
      ? {
          home: lineupAttempt.home.starters.length,
          away: lineupAttempt.away.starters.length,
          source: lineupAttempt.source,
        }
      : null,
    finalsCount: finalsAttempt.length,
    finalsSample: finalsAttempt.slice(0, 6),
    messageSamples: entries.slice(0, 6).map((entry) => ({
      at: entry.at || null,
      rawLen: entry.rawLen ?? networkEntryText(entry).length,
      preview: networkEntryText(entry).slice(0, 180),
    })),
  };
}

function buildIpeBlobDebugEntry(entry) {
  const url = entry?.url || "";
  if (!LINEUP_BLOB_URL_RE.test(url)) return null;

  const data = networkEntryText(entry);
  const hints = entry.hints || {};
  const hintPlayers = Array.isArray(hints.lineupPlayers) ? hints.lineupPlayers : [];
  const naSamples = [];

  for (const m of data.matchAll(/\bNA=([^|;\x00-\x1f\x14]{2,60})/g)) {
    if (naSamples.length >= 48) break;
    const name = m[1].trim();
    naSamples.push({
      name,
      playerLike: isPlayerNameLine(name),
      networkOk: isNetworkPlayerName(name),
    });
  }

  const wirePlayers = extractLineupPlayersFromWireText(data, url);
  const lineupAttempt = parseLineupFromNetworkBlob(data, url);
  const finalsAttempt = parsePlayerFinalizationsFromNetworkBlob(data, url);

  const recordSamples = [];
  let rm;
  const recordRe = new RegExp(LINEUP_WIRE_RECORD_RE.source, "gi");
  while ((rm = recordRe.exec(data)) !== null && recordSamples.length < 8) {
    recordSamples.push((rm[1] || rm[2] || "").slice(0, 160));
  }

  return {
    url: url.slice(0, 220),
    at: entry.at || null,
    kind: entry.kind || "fetch",
    rawLen: entry.rawLen ?? (typeof data === "string" ? data.length : null),
    storedLen: typeof data === "string" ? data.length : null,
    fieldKeys: hints.fieldKeys || [],
    hintLineupCount: hintPlayers.length,
    hintLineupPlayers: hintPlayers.slice(0, 24).map((p) =>
      typeof p === "string"
        ? { name: p }
        : {
            name: p.name,
            team: p.team ?? null,
            order: p.order ?? null,
            sub: Boolean(p.sub),
          }
    ),
    naSampleCount: naSamples.length,
    naPlayerLikeCount: naSamples.filter((s) => s.playerLike).length,
    naSamples: naSamples.slice(0, 24),
    wirePlayerCount: wirePlayers.length,
    wirePlayers: wirePlayers.slice(0, 24).map((p) => ({
      name: p.name,
      team: p.team ?? null,
      order: p.order ?? null,
      sub: Boolean(p.sub),
    })),
    wireRecordSamples: recordSamples,
    lineupParsed: Boolean(lineupAttempt),
    lineupStarters: lineupAttempt
      ? {
          home: lineupAttempt.home.starters.length,
          away: lineupAttempt.away.starters.length,
          source: lineupAttempt.source,
        }
      : null,
    finalsCount: finalsAttempt.length,
    finalsSample: finalsAttempt.slice(0, 6),
  };
}

function buildIpeBlobDebug(networkLog = []) {
  return (networkLog || []).map(buildIpeBlobDebugEntry).filter(Boolean);
}

function isNetworkPlayerName(name) {
  if (!name || name.length > 40) return false;
  if (NETWORK_NAME_BLOCK_RE.test(name)) return false;
  if (isPlayerNameLine(name)) return true;
  if (!/^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,}$/.test(name)) return false;
  if (/\d/.test(name)) return false;
  return true;
}

function flattenProtocolWire(data) {
  if (!data?._bet365Protocol || !Array.isArray(data.segments)) return "";
  return data.segments
    .map((s) => (s.key ? `${s.key}=${s.value}` : String(s.value ?? "")))
    .join(";");
}

function networkEntryText(entry) {
  const data = entry?.data;
  if (typeof data === "string") return data;
  if (data?._rawText) return String(data._rawText);
  const wire = flattenProtocolWire(data);
  if (wire) return wire;
  try {
    return JSON.stringify(data ?? "");
  } catch (_) {
    return "";
  }
}

function mergeSidePanel(primary, fromNetwork = {}) {
  const timeline = [...(primary.timeline || [])];
  const seen = new Set(timeline.map((e) => `${e.minute}|${e.description}`));
  (fromNetwork.timeline || []).forEach((e) => {
    const key = `${e.minute}|${e.description}`;
    if (!seen.has(key)) timeline.push(e);
  });

  const lineup = primary.lineup || fromNetwork.lineup || null;
  const playerFinalizations = (primary.playerFinalizations || []).length
    ? primary.playerFinalizations
    : fromNetwork.playerFinalizations || [];

  return { ...primary, timeline, lineup, playerFinalizations, network: fromNetwork };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

const SIDE_PANEL_TAB_SCOPE_SELECTORS = [
  "[class*='LocationEventsMenu']",
  "[class*='MatchLiveModule']",
  "[class*='InPlayModule']",
  "[class*='EventView']",
  "[class*='StatsModule']",
  "[class*='ParticipantStats']",
  "[class*='MediaStats']",
  "[class*='ScoreboardModule']",
  "[class*='EventMedia']",
  "[class*='SideBar']",
  "[class*='RCLabel']",
];

const SIDE_PANEL_TAB_LEAF_SELECTORS = [
  "[class*='LocationEventsMenu_Item']",
  "[class*='EventsMenu'] *",
  "[class*='StatsCategory'] *",
  "[class*='MatchStatsMenu'] *",
  "[class*='SubNav'] *",
  "[class*='RCLabel']",
  "[class*='ParticipantStats'] *",
  "button",
  "[role='tab']",
  "a",
  "span",
  "div",
];

const SIDE_PANEL_TAB_LABEL_PATTERNS = {
  stats: [/^Estat\.?$/, /^Estatísticas?$/],
  goalScorers: [/^Marcadores de Gols?$/],
  lateral: [/^Lateral$/],
  playerStats: [/^Estatísticas de Jogador$/],
  timeline: [/^Cronologia$/],
  lineup: [/^Escalação$/],
};

const SIDE_PANEL_TAB_BAND_LEFT_RATIO = 0.4;
const SIDE_PANEL_TAB_BAND_RELAXED_LEFT_RATIO = 0.35;
const SIDE_PANEL_TAB_BAND_RIGHT_RATIO = 0.98;

function normalizeSidePanelTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[›>]\s*$/, "")
    .trim();
}

function sidePanelTabKeyFromText(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s || s.length > 40) return null;
  for (const [key, patterns] of Object.entries(SIDE_PANEL_TAB_LABEL_PATTERNS)) {
    if (patterns.some((re) => re.test(s))) return key;
  }
  return null;
}

function isInSidePanelTabBand(
  rect,
  innerWidth = 1200,
  leftRatio = SIDE_PANEL_TAB_BAND_LEFT_RATIO
) {
  if (!rect || rect.width < 10 || rect.height < 6) return false;
  return (
    rect.left >= innerWidth * leftRatio && rect.left <= innerWidth * SIDE_PANEL_TAB_BAND_RIGHT_RATIO
  );
}

function isInRelaxedSidePanelTabBand(rect, innerWidth = 1200) {
  return isInSidePanelTabBand(rect, innerWidth, SIDE_PANEL_TAB_BAND_RELAXED_LEFT_RATIO);
}

const SIDE_PANEL_DISCOVERY_LABELS = [
  "Estat.",
  "Estatísticas",
  "Cronologia",
  "Escalação",
  "Estatísticas de Jogador",
  "Marcadores de Gols",
  "Marcadores de Gol",
  "Lateral",
];

function gluedSidePanelTabCount(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s) return 0;
  return SIDE_PANEL_DISCOVERY_LABELS.filter((label) => new RegExp(escapeRegExp(label), "i").test(s))
    .length;
}

function scoreSidePanelTabBarContainer(text) {
  const count = gluedSidePanelTabCount(text);
  if (count < 2) return 0;
  let score = count * 2;
  if (/Estat\.?/i.test(text)) score += 2;
  if (/Cronologia/i.test(text)) score += 2;
  if (/Escalação/i.test(text)) score += 2;
  return score;
}

function isGluedSidePanelTabContainer(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s) return false;
  if (sidePanelTabKeyFromText(s)) return false;
  return gluedSidePanelTabCount(s) > 1;
}

function leafSidePanelTabKey(text, childTexts = []) {
  const s = normalizeSidePanelTabLabel(text);
  const key = sidePanelTabKeyFromText(s);
  if (!key || isGluedSidePanelTabContainer(s)) return null;
  const childKeys = childTexts
    .map((childText) => sidePanelTabKeyFromText(childText))
    .filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

function pickSmallestSidePanelTabCandidates(candidates) {
  const byKey = new Map();
  for (const tab of candidates) {
    const prev = byKey.get(tab.key);
    if (!prev || tab.area < prev.area) byKey.set(tab.key, tab);
  }
  return [...byKey.values()];
}

function collectSidePanelTabCandidates(nodes, innerWidth = 1200) {
  const candidates = [];
  const seen = new Set();

  for (const node of nodes) {
    const text = normalizeSidePanelTabLabel(node.text);
    const key = leafSidePanelTabKey(
      text,
      (node.childTexts || []).map((childText) => normalizeSidePanelTabLabel(childText))
    );
    if (!key || seen.has(key)) continue;
    const rect = node.rect;
    if (!isInSidePanelTabBand(rect, innerWidth)) continue;
    seen.add(key);
    candidates.push({
      key,
      label: text,
      area: (rect?.width || 0) * (rect?.height || 0),
      el: node.el ?? null,
    });
  }

  return pickSmallestSidePanelTabCandidates(candidates);
}

function sidePanelTabLabelRegex(key) {
  const patterns = SIDE_PANEL_TAB_LABEL_PATTERNS[key];
  if (!patterns?.length) return null;
  const source = patterns.map((re) => re.source).join("|");
  return new RegExp(`^(?:${source})$`, "i");
}

const SIDE_PANEL_PLAYER_LINE_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30}$/;

function looksLikeGoalScorersTabContent(text) {
  const s = String(text || "");
  if (!/Marcadores de Gols?/i.test(s)) return false;
  if (s.length > 12000) return false;
  if (/Jogadores Titulares/i.test(s) && !/\nMarcadores\n/i.test(s)) return false;
  if (/\nMarcadores\n/i.test(s) && /\d{1,3}['′]\s*$/m.test(s)) return true;
  if (/\n[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,28}\n\d{1,3}['′]\s*$/m.test(s)) return true;
  return false;
}

function looksLikeLineupTabContent(text) {
  const s = String(text || "");
  if (!/Escalação/i.test(s)) return false;
  if (s.length > 12000) return false;
  const players = (s.match(SIDE_PANEL_PLAYER_LINE_RE) || []).length;
  return players >= 8 || /Suplentes/i.test(s);
}

function looksLikeTimelineTabContent(text) {
  const s = String(text || "");
  if (!/Cronologia/i.test(s)) return false;
  if (s.length > 15000) return false;
  return (s.match(/\d{1,3}['′]/g) || []).length >= 2;
}

function findBestScopedSidePanelText(texts, key) {
  const validators = {
    goalScorers: looksLikeGoalScorersTabContent,
    lineup: looksLikeLineupTabContent,
    timeline: looksLikeTimelineTabContent,
    lateral: looksLikeLateralStatsPanelText,
  };
  const validate = validators[key];
  if (!validate) return "";

  let best = "";
  let bestScore = 0;
  for (const text of texts) {
    const chunk = String(text || "");
    if (!chunk || !validate(chunk)) continue;
    const ranked = scoreSidePanelTabContent(chunk, key) || chunk.length;
    if (ranked > bestScore) {
      bestScore = ranked;
      best = chunk;
    }
  }
  return best;
}

function looksLikeLateralStatsPanelText(text) {
  const s = String(text || "");
  return /Escanteios/i.test(s) || (/Lateral/i.test(s) && /Laterais?/i.test(s));
}

function scoreSidePanelTabContent(text, key) {
  const validators = {
    goalScorers: looksLikeGoalScorersTabContent,
    lineup: looksLikeLineupTabContent,
    timeline: looksLikeTimelineTabContent,
  };
  const validate = validators[key];
  if (!validate) return 0;
  if (!validate(text)) return 0;
  let score = Math.min(String(text || "").length, 5000);
  if (key === "goalScorers" && /\d{1,3}['′]\s*$/m.test(text)) score += 500;
  if (key === "lineup" && /Suplentes/i.test(text)) score += 300;
  if (key === "timeline" && /Escanteio|Goal|Gol/i.test(text)) score += 200;
  return score;
}

const MIN_EXTRACT_PLAYER_INTERVAL_MS = 30_000;
const MIN_PAGE_TEXT_FOR_EXTRACT = 3_000;
const EXTRACT_RETRY_DELAY_MS = 5_000;
const PAGE_READY_MARKET_RE =
  /\b(?:Resultado Final|Partida\s*-\s*Gols|Escanteios\/Cartões|\bEscanteios\b|Total de Escanteios|Chance Dupla|Marcadores de Gol)\b/i;
const PAGE_READY_TEAMS_RE = /\b[A-Za-zÀ-ú]{2,}(?:\s+[A-Za-zÀ-ú.'-]+)*\s+v\s+[A-Za-zÀ-ú]/i;
const EXTRACT_PLAYER_STORAGE_KEY = "bet365-extract-player-state";
const EXTRACT_PLAYER_BALL_SIZE_PX = 72;

function parseIntervalInput(raw, minMs = MIN_EXTRACT_PLAYER_INTERVAL_MS) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return null;

  let ms = null;
  const mmss = s.match(/^(\d{1,3}):(\d{2})$/);
  if (mmss) {
    ms = (parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10)) * 1000;
  } else if (/^\d+\s*m$/.test(s)) {
    ms = parseInt(s, 10) * 60_000;
  } else if (/^\d+\s*s$/.test(s)) {
    ms = parseInt(s, 10) * 1000;
  } else if (/^\d+$/.test(s)) {
    ms = parseInt(s, 10) * 1000;
  }

  if (!Number.isFinite(ms)) return null;
  return Math.max(ms, minMs);
}

function formatPlayerCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function clampBallPosition(pos, viewport, ballSize = EXTRACT_PLAYER_BALL_SIZE_PX) {
  const width = Math.max(ballSize, Number(viewport?.width || 0));
  const height = Math.max(ballSize, Number(viewport?.height || 0));
  return {
    x: Math.min(Math.max(0, Number(pos?.x || 0)), width - ballSize),
    y: Math.min(Math.max(0, Number(pos?.y || 0)), height - ballSize),
  };
}

function defaultBallPosition(viewport, ballSize = EXTRACT_PLAYER_BALL_SIZE_PX) {
  const width = Number(viewport?.width || 1200);
  const height = Number(viewport?.height || 900);
  return clampBallPosition(
    {
      x: (width - ballSize) / 2,
      y: Math.min(height - ballSize - 24, Math.round(height * 0.78)),
    },
    { width, height },
    ballSize
  );
}

function shouldAutoDownloadZipAfterExtract(options = {}) {
  return options.autoDownloadZip !== false;
}

function isPageTextReadyForExtract(visibleText = "") {
  const text = String(visibleText || "");
  if (text.length < MIN_PAGE_TEXT_FOR_EXTRACT) return false;
  if (!PAGE_READY_MARKET_RE.test(text)) return false;
  if (!PAGE_READY_TEAMS_RE.test(text)) return false;
  return true;
}

function isPageReadyForExtract(visibleText = "", options = {}) {
  if (!isPageTextReadyForExtract(visibleText)) return false;
  if (options.hasMarketDom === false) return false;
  return true;
}

function isPageLikelyFailedToLoad(visibleText = "", options = {}) {
  const text = String(visibleText || "");
  const hasMarketDom = options.hasMarketDom;
  const hasTeams = PAGE_READY_TEAMS_RE.test(text);
  const hasMarkets = PAGE_READY_MARKET_RE.test(text);

  if (hasMarketDom === false && text.length > 0) return true;
  if (text.length >= MIN_PAGE_TEXT_FOR_EXTRACT && !hasTeams && !hasMarkets) return true;
  return false;
}

function getExtractPlayerStatusMessage(context = {}) {
  if (context.extracting) return "Extraindo…";
  if (context.failed) return "Página não carregou — F5";
  if (context.awaitingData) return "Aguardando dados…";
  if (context.awaitingPage) return "Aguardando jogo…";
  if (context.running) return "Ativo";
  return "Pausado";
}

function isExtractDataReady(data = {}) {
  const match = data.match || {};
  const meta = data.meta || {};
  const visibleTextLength = Number(meta.visibleTextLength || 0);
  const hasTeams = Boolean(match.homeTeam && match.awayTeam);
  const hasOdds = (data.odds || []).length > 0;
  const hasStats = (data.stats || []).length > 0;
  const hasEnoughText = visibleTextLength >= MIN_PAGE_TEXT_FOR_EXTRACT;

  if (!hasEnoughText && !hasOdds && !hasStats) return false;
  if (!hasTeams && !hasOdds && !hasStats) return false;
  if (!hasTeams && visibleTextLength < MIN_PAGE_TEXT_FOR_EXTRACT) return false;
  if (match.scoreConfidence === "low" && !hasOdds && !hasStats && !hasTeams) return false;

  return true;
}

function shouldDownloadExtractZip(data = {}, options = {}) {
  if (!shouldAutoDownloadZipAfterExtract(options)) return false;
  return isExtractDataReady(data);
}

function summarizeExtractPreview(data = {}) {
  if (!isExtractDataReady(data)) {
    return "Aguardando jogo carregar…";
  }
  const m = data.match || {};
  const home = m.homeTeam || "?";
  const away = m.awayTeam || "?";
  const score = m.score || "—";
  const clock = m.clock || "—";
  const stats = (data.stats || []).length;
  const odds = (data.odds || []).length;
  const events = (data.sidePanel?.timeline || []).length;
  return `${home} vs ${away} · ${score} @ ${clock} · ${stats} stats · ${odds} odds · ${events} evt`;
}

function createExtractPlayerScheduler(options = {}) {
  const minIntervalMs = options.minIntervalMs ?? MIN_EXTRACT_PLAYER_INTERVAL_MS;
  let intervalMs = minIntervalMs;
  let running = false;
  let extracting = false;
  let nextRunAt = null;
  let lastRunAt = null;

  const countdownMs = (now) => {
    if (!running || extracting || nextRunAt == null) return null;
    return Math.max(0, nextRunAt - now);
  };

  return {
    getState() {
      return { intervalMs, running, extracting, nextRunAt, lastRunAt };
    },
    setIntervalInput(input) {
      const parsed = parseIntervalInput(input, minIntervalMs);
      if (parsed) intervalMs = parsed;
      return intervalMs;
    },
    getIntervalMs() {
      return intervalMs;
    },
    start(now, options = {}) {
      running = true;
      extracting = false;
      const delayMs = Math.max(0, Number(options.firstRunDelayMs || 0));
      nextRunAt = now + delayMs;
      return this.getState();
    },
    stop() {
      running = false;
      extracting = false;
      nextRunAt = null;
      return this.getState();
    },
    markExtractStart(now) {
      extracting = true;
      lastRunAt = now;
      return this.getState();
    },
    markExtractEnd(now, options = {}) {
      extracting = false;
      if (running) {
        const delayMs =
          options.advanceInterval === false
            ? Math.max(1_000, Number(options.retryDelayMs || EXTRACT_RETRY_DELAY_MS))
            : intervalMs;
        nextRunAt = now + delayMs;
      }
      return this.getState();
    },
    deferNextRun(now, delayMs = EXTRACT_RETRY_DELAY_MS) {
      if (running) nextRunAt = now + Math.max(1_000, Number(delayMs || EXTRACT_RETRY_DELAY_MS));
      return this.getState();
    },
    tick(now) {
      if (!running) return { action: "none", countdownMs: null };
      if (extracting) return { action: "none", countdownMs: countdownMs(now) };
      if (nextRunAt != null && now >= nextRunAt) {
        return { action: "extract", countdownMs: 0 };
      }
      return { action: "wait", countdownMs: countdownMs(now) };
    },
  };
}

function serializePlayerState(state = {}) {
  return JSON.stringify({
    x: state.x,
    y: state.y,
    intervalInput: state.intervalInput ?? "60",
    running: Boolean(state.running),
    autoDownloadZip: shouldAutoDownloadZipAfterExtract(state),
  });
}

function parsePlayerState(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      x: Number.isFinite(parsed.x) ? parsed.x : null,
      y: Number.isFinite(parsed.y) ? parsed.y : null,
      intervalInput: String(parsed.intervalInput || "60"),
      running: Boolean(parsed.running),
      autoDownloadZip: shouldAutoDownloadZipAfterExtract(parsed),
    };
  } catch (_) {
    return null;
  }
}

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

initNetworkBridge();
  const __BET365_PAGE_SNIFFER_SOURCE__ = "(function bet365PageNetworkSniffer() {\n  if (window.__bet365PageSnifferInstalled) return;\n  window.__bet365PageSnifferInstalled = true;\n\n  const HOST_RE = /bet365/i;\n  const PAYLOAD_HINTS =\n    /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\\d+/i;\n  const MAX_RAW = 12000;\n  const MAX_RAW_ZAP = 500_000;\n  const MAX_BLOB_SCAN = 2_000_000;\n  const MAX_ZAP_BUFFER = 2_000_000;\n  const zapWireBuffer = { text: \"\", len: 0 };\n  const FIELD_KV_RE = /\\b([A-Z][A-Z0-9]{1,3})=([^|\\x00-\\x1f\\x14]{1,200})/g;\n  const SCORE_PAIR_RE = /\\b(?:SC|SS)=(\\d{1,2})[-–](\\d{1,2})\\b/gi;\n  const S1S2_RE = /\\bS1=(\\d{1,2})[\\s\\S]{0,60}?\\bS2=(\\d{1,2})\\b/gi;\n  const CLOCK_RE = /\\b(?:TU|TM|TC)=(\\d{1,3})[:;](\\d{2})\\b/gi;\n\n  function resolveUrl(input) {\n    if (!input) return \"\";\n    if (typeof input === \"string\") return input;\n    if (typeof input === \"object\" && typeof input.url === \"string\") return input.url;\n    return String(input);\n  }\n\n  function isBlobUrl(url) {\n    return /\\/Api\\/1\\/Blob\\b/i.test(url);\n  }\n\n  function isZapUrl(url) {\n    return /sportspublisher\\/zap/i.test(url);\n  }\n\n  const LINEUP_WIRE_SOURCE_RE = /ipe\\/5378|ipe-BR|sportspublisher\\/zap|zap-ws/i;\n  const LINEUP_BLOB_URL_RE = /ipe\\/5378|ipe-BR/i;\n  const LINEUP_UI_BLOCK_RE =\n    /Informa|Configura|Idioma|Ajuda|Dep[oó]sito|Promo|Resultados|Not[ií]cias|Empregos|Parceiros|bet365|Facebook|Instagram|Logo|Servidor|reCAPTCHA|Regras|Promoções|Áudio|Futebol|Estatísticas|Esportes|Sites|Jogue com|Todos os|Ao-Vivo|Minhas Apostas|Cassino|Popular|Criar Aposta|Instantâneas|Intervalo|Marcadores|Tabela|Cronologia|Escalação/i;\n  const LINEUP_PLAYER_SHORT_RE = /^[A-ZÀ-Ú][\\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30}$/;\n  const LINEUP_PLAYER_FULL_RE = /^[A-ZÀ-Ú][a-zà-ú'`-]+(?:\\s+[A-ZÀ-Ú][a-zà-ú'`.-]+){1,4}$/;\n\n  function isLineupPlayerName(name) {\n    if (!name || name.length > 40) return false;\n    if (LINEUP_UI_BLOCK_RE.test(name)) return false;\n    if (!LINEUP_PLAYER_SHORT_RE.test(name) && !LINEUP_PLAYER_FULL_RE.test(name)) return false;\n    if (/\\d/.test(name)) return false;\n    return true;\n  }\n\n  function readLineupWireContext(ctx) {\n    const out = { sub: false, team: null, order: null, shots: null, onTarget: null };\n    for (const m of ctx.matchAll(/\\b(SU|OR|TM|HI|SH|ST|S1|S2)=(\\d{1,3})/g)) {\n      const key = m[1];\n      const val = parseInt(m[2], 10);\n      if (!Number.isFinite(val)) continue;\n      if (key === \"SU\" && val === 1) out.sub = true;\n      if (key === \"OR\") out.order = val;\n      if (key === \"TM\" || key === \"HI\") out.team = val;\n      if (key === \"SH\" || key === \"S1\") out.shots = String(val);\n      if (key === \"ST\" || key === \"S2\") out.onTarget = String(val);\n    }\n    return out;\n  }\n\n  function appendZapWire(text) {\n    const chunk = String(text || \"\");\n    if (!chunk) return;\n    if (zapWireBuffer.len + chunk.length > MAX_ZAP_BUFFER) return;\n    zapWireBuffer.text += (zapWireBuffer.text ? \"\\n\" : \"\") + chunk;\n    zapWireBuffer.len += chunk.length;\n  }\n\n  function extractLineupHints(sample, url) {\n    if (!LINEUP_WIRE_SOURCE_RE.test(url)) return null;\n    const players = [];\n    const seen = new Set();\n    const recordRe =\n      /(?:\\||^|;|\\x14)(?:PG|PA|SL|PI|OV|EV|MG);([^|]{0,320})|(?:\\||^)(PA;[^|]{0,320})/gi;\n\n    let rm;\n    while ((rm = recordRe.exec(sample)) !== null) {\n      const chunk = rm[1] || rm[2] || \"\";\n      const na = chunk.match(/\\bNA=([^|;\\x00-\\x1f\\x14]{2,40})/);\n      if (!na) continue;\n      const name = na[1].trim();\n      if (!isLineupPlayerName(name)) continue;\n      const ctx = readLineupWireContext(chunk);\n      const key = `${name}|${ctx.team ?? \"\"}|${ctx.order ?? \"\"}|${ctx.sub ? 1 : 0}`;\n      if (seen.has(key)) continue;\n      seen.add(key);\n      players.push({ name, ...ctx });\n    }\n\n    if (players.length < 8) {\n      for (const m of sample.matchAll(/\\bNA=([^|;\\x00-\\x1f\\x14]{2,40})/g)) {\n        const name = m[1].trim();\n        if (!isLineupPlayerName(name)) continue;\n        const ctx = readLineupWireContext(sample.slice(m.index, m.index + 140));\n        const key = `${name}|${ctx.team ?? \"\"}|${ctx.order ?? \"\"}|${ctx.sub ? 1 : 0}`;\n        if (seen.has(key)) continue;\n        seen.add(key);\n        players.push({ name, ...ctx });\n      }\n    }\n\n    return players.length >= 8 ? players.slice(0, 40) : null;\n  }\n\n  function extractHints(text, url) {\n    const limit = isBlobUrl(url) ? MAX_BLOB_SCAN : isZapUrl(url) ? MAX_ZAP_BUFFER : 120000;\n    const sample = String(text || \"\").slice(0, limit);\n    const fields = {};\n    let m;\n    const re = new RegExp(FIELD_KV_RE.source, \"g\");\n    while ((m = re.exec(sample)) !== null) {\n      if (!(m[1] in fields)) fields[m[1]] = m[2].trim();\n    }\n\n    const matches = [];\n    const clocks = new Set();\n\n    while ((m = SCORE_PAIR_RE.exec(sample)) !== null) {\n      matches.push({ score: `${m[1]}-${m[2]}`, tag: \"SC\" });\n    }\n    while ((m = S1S2_RE.exec(sample)) !== null) {\n      matches.push({ score: `${m[1]}-${m[2]}`, tag: \"S1S2\" });\n    }\n    while ((m = CLOCK_RE.exec(sample)) !== null) {\n      const mins = parseInt(m[1], 10);\n      if (mins <= 130) clocks.add(`${mins}:${m[2]}`);\n    }\n\n    const fieldKeys = Object.keys(fields).slice(0, 24);\n    const lineupSource = isZapUrl(url) ? \"ws:sportspublisher/zap\" : url;\n    const lineupSample = isZapUrl(url) ? zapWireBuffer.text || sample : sample;\n    const lineupPlayers = extractLineupHints(lineupSample, lineupSource);\n    return {\n      fieldKeys,\n      fields: fieldKeys.length ? fields : null,\n      matches: matches.slice(-5),\n      clocks: [...clocks].slice(-5),\n      lineupPlayers,\n      zapBufferLen: isZapUrl(url) ? zapWireBuffer.len : null,\n      blob: isBlobUrl(url),\n      zap: isZapUrl(url),\n    };\n  }\n\n  function shouldCapture(url, data, hints) {\n    if (isZapUrl(url)) return true;\n    if (HOST_RE.test(url)) return true;\n    if (hints?.matches?.length || hints?.clocks?.length || hints?.fieldKeys?.length) return true;\n    const sample =\n      typeof data === \"string\" ? data.slice(0, 4000) : JSON.stringify(data || \"\").slice(0, 4000);\n    return PAYLOAD_HINTS.test(sample);\n  }\n\n  function emit(url, data, kind) {\n    const u = resolveUrl(url);\n    const rawText = typeof data === \"string\" ? data : null;\n    if (rawText && isZapUrl(u)) appendZapWire(rawText);\n    const hints = rawText ? extractHints(rawText, u) : null;\n    const payload = rawText\n      ? rawText.slice(0, isBlobUrl(u) ? MAX_RAW : isZapUrl(u) ? MAX_RAW_ZAP : MAX_RAW)\n      : data && typeof data === \"object\"\n        ? data\n        : null;\n\n    if (!payload || !shouldCapture(u, payload, hints)) return;\n\n    window.postMessage(\n      {\n        channel: \"bet365-extractor-net\",\n        entry: {\n          url: u || `unknown:${kind}`,\n          at: new Date().toISOString(),\n          kind,\n          data: payload,\n          rawLen: rawText ? rawText.length : null,\n          hints,\n        },\n      },\n      \"*\"\n    );\n  }\n\n  function decodeSocketData(data) {\n    if (typeof data === \"string\") return data;\n    if (data instanceof ArrayBuffer) {\n      try {\n        return new TextDecoder(\"utf-8\").decode(data);\n      } catch (_) {\n        return null;\n      }\n    }\n    if (ArrayBuffer.isView(data)) {\n      try {\n        return new TextDecoder(\"utf-8\").decode(data.buffer);\n      } catch (_) {\n        return null;\n      }\n    }\n    return null;\n  }\n\n  const origFetch = window.fetch;\n  if (origFetch) {\n    window.fetch = async function (...args) {\n      const res = await origFetch.apply(this, args);\n      try {\n        const clone = res.clone();\n        const ct = (clone.headers.get(\"content-type\") || \"\").toLowerCase();\n        const url = resolveUrl(args[0]);\n        if (isBlobUrl(url) || ct.includes(\"javascript\") || ct.includes(\"octet\")) {\n          const text = await clone.text().catch(() => null);\n          if (text) emit(url, text, \"fetch\");\n        } else if (ct.includes(\"json\")) {\n          const data = await clone.json().catch(() => null);\n          if (data) emit(url, data, \"fetch\");\n        } else if (ct.includes(\"text\") || ct.includes(\"plain\") || !ct) {\n          const text = await clone.text().catch(() => null);\n          if (text) emit(url, text, \"fetch\");\n        }\n      } catch (_) {}\n      return res;\n    };\n  }\n\n  const XO = XMLHttpRequest.prototype.open;\n  const XS = XMLHttpRequest.prototype.send;\n  XMLHttpRequest.prototype.open = function (method, url, ...rest) {\n    this.__bet365Url = resolveUrl(url);\n    return XO.call(this, method, url, ...rest);\n  };\n  XMLHttpRequest.prototype.send = function (...args) {\n    this.addEventListener(\"load\", function () {\n      try {\n        const url = this.__bet365Url || \"\";\n        const ct = (this.getResponseHeader(\"content-type\") || \"\").toLowerCase();\n        const body = this.responseText;\n        if (!body) return;\n        if (isBlobUrl(url) || ct.includes(\"javascript\") || ct.includes(\"octet\")) {\n          emit(url, body, \"xhr\");\n        } else if (ct.includes(\"json\")) {\n          try {\n            emit(url, JSON.parse(body), \"xhr\");\n          } catch (_) {\n            emit(url, body, \"xhr\");\n          }\n        } else {\n          emit(url, body, \"xhr\");\n        }\n      } catch (_) {}\n    });\n    return XS.apply(this, args);\n  };\n\n  const OrigWS = window.WebSocket;\n  if (OrigWS) {\n    const Bet365WS = function (url, protocols) {\n      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);\n      const wsUrl = resolveUrl(url);\n      if (HOST_RE.test(wsUrl)) {\n        ws.addEventListener(\"message\", (ev) => {\n          const text = decodeSocketData(ev.data);\n          if (text) emit(`ws:${wsUrl}`, text, \"ws\");\n        });\n      }\n      return ws;\n    };\n    Bet365WS.prototype = OrigWS.prototype;\n    [\"CONNECTING\", \"OPEN\", \"CLOSING\", \"CLOSED\"].forEach((k) => {\n      Object.defineProperty(Bet365WS, k, { value: OrigWS[k] });\n    });\n    window.WebSocket = Bet365WS;\n  }\n})();\n";


  function walkWindowFrames(win, depth, out, seen) {
  if (!win || depth > 14 || seen.has(win)) return;
  seen.add(win);

  try {
    const doc = win.document;
    if (!doc) return;

    const text = doc.documentElement?.innerText || doc.body?.innerText || "";
    const href = win.location?.href || "";

    if (text && text.length > 0 && text.length < 8000) {
      out.push({
        text: text.slice(0, 3500),
        href,
        depth,
        source: depth > 0 ? "frame-walk" : "frame-root",
      });
    }

    for (let i = 0; i < win.frames.length; i++) {
      walkWindowFrames(win.frames[i], depth + 1, out, seen);
    }
  } catch (_) {}
}

function collectFrameWalkTexts() {
  const out = [];
  const seen = new Set();
  walkWindowFrames(window, 0, out, seen);
  return out.filter(
    (f) =>
      f.depth > 0 || /\d{1,2}\s*[-–]\s*\d{1,2}/.test(f.text) || /\b\d{2,3}:\d{2}\b/.test(f.text)
  );
}


  function getAllVisibleText() {
    const chunks = [];
    const seen = new Set();

    function walkDoc(doc, depth = 0) {
      if (!doc || depth > 12 || seen.has(doc)) return;
      seen.add(doc);
      try {
        const t = doc.documentElement?.innerText || doc.body?.innerText || "";
        if (t) chunks.push(t);
        doc.querySelectorAll("iframe, frame").forEach((f) => {
          try {
            if (f.contentDocument) walkDoc(f.contentDocument, depth + 1);
          } catch (_) {}
        });
      } catch (_) {}
    }

    walkDoc(document);

    collectFrameWalkTexts().forEach((f) => {
      if (f.text) chunks.push(f.text);
    });

    document.querySelectorAll("*").forEach((el) => {
      try {
        if (el.shadowRoot) {
          const t = el.shadowRoot.innerText || "";
          if (t) chunks.push(t);
          el.shadowRoot.querySelectorAll("iframe, frame").forEach((f) => {
            try {
              if (f.contentDocument) walkDoc(f.contentDocument, 0);
            } catch (_) {}
          });
        }
      } catch (_) {}
    });

    return [...new Set(chunks)].join("\n---IFRAME---\n");
  }

  function getAllRoots() {
    const roots = [];
    const seen = new Set();
    function walk(node, d = 0) {
      if (!node || d > 12 || seen.has(node)) return;
      seen.add(node);
      if (node.querySelectorAll) roots.push(node);
      node.querySelectorAll?.("iframe, frame").forEach((f) => {
        try {
          if (f.contentDocument) walk(f.contentDocument, d + 1);
        } catch (_) {}
      });
      node.querySelectorAll?.("*").forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot, d + 1);
      });
    }
    walk(document);
    return roots;
  }

  function queryDeep(sel) {
    const out = [];
    const seen = new Set();
    getAllRoots().forEach((r) => {
      r.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    });
    return out;
  }

  function findSidePanelRoot(fromTab) {
    const roots = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      roots.push(el);
    };

    if (fromTab) {
      let node = fromTab;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        push(node);
      }
    }

    queryDeep(
      "[class*='LocationEventsMenu'], [class*='MatchLiveModule'], [class*='InPlayModule'], [class*='EventView']"
    ).forEach((el) => push(el));

    let best = null;
    let bestScore = 0;
    for (const el of roots) {
      const t = el.innerText || "";
      if (!/Estat\.?|Cronologia|Escalação|Marcadores de Gol|Lateral/i.test(t)) continue;
      const score =
        (t.match(/xG|Ataques|Cronologia|Escalação|FINALIZA/i) || []).length * 120 +
        Math.min(t.length, 4000);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function getSidePanelText(fromTab) {
    const root = findSidePanelRoot(fromTab);
    if (root?.innerText) return root.innerText;
    return getAllVisibleText();
  }

  function getSidePanelScopedText(fromTab, key, extraTexts = []) {
    if (!key) return "";

    const validators = {
      stats: (text) =>
        looksLikeLiveStatsPanelText(text) && !shouldTreatAsMarketRibbonNotStats(text),
      goalScorers: looksLikeGoalScorersTabContent,
      lateral: looksLikeLateralStatsPanelText,
      timeline: looksLikeTimelineTabContent,
      lineup: looksLikeLineupTabContent,
      playerStats: (text) => /FINALIZA(COES|ÇÕES)/i.test(text) && text.length < 10000,
    };
    const score = (text) => scoreSidePanelTabContent(text, key);
    const validate = validators[key];
    if (!validate) return "";

    let best = "";
    let bestScore = 0;
    let node = fromTab;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const text = node.innerText || "";
      if (text.length > 20000 || text.length < 30) continue;
      if (!validate(text)) continue;
      const ranked = score(text) || text.length;
      if (ranked > bestScore) {
        bestScore = ranked;
        best = text;
      }
    }

    if (best) return best;

    const rootChunks = [];
    SIDE_PANEL_TAB_SCOPE_SELECTORS.forEach((sel) => {
      queryDeep(sel).forEach((el) => {
        const text = el?.innerText || "";
        if (text.length >= 30 && text.length <= 20000) rootChunks.push(text);
      });
    });
    return findBestScopedSidePanelText([...extraTexts, ...rootChunks], key);
  }

  function extractTeamsFromHeader(text) {
    const m = String(text || "").match(
      /([A-Za-zÀ-ú][A-Za-zÀ-ú .'-]{2,30})\s+v\s+([A-Za-zÀ-ú][A-Za-zÀ-ú .'-]{2,30})/
    );
    if (!m) return {};
    return { homeTeam: m[1].trim(), awayTeam: m[2].trim() };
  }

  function clickStatsMarcadoresSubTab(statsRoot, fromTab) {
    const tabs = collectStatsSubTabCandidates(statsRoot, fromTab);
    const marcadores = tabs.find((t) => t.key === "marcadores");
    if (!marcadores?.el) return null;
    try {
      marcadores.el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
      dispatchPanelClick(marcadores.el);
      return marcadores.el;
    } catch (_) {
      return null;
    }
  }

  function refineSidePanelTabText(key, tab, scopedText, fallbacks = []) {
    const panelText = scopedText || getSidePanelText(tab);
    if (key === "goalScorers") {
      if (looksLikeGoalScorersTabContent(panelText)) return panelText;
      return (
        extractGoalScorersSectionFromText(panelText) ||
        findBestScopedSidePanelText(fallbacks, "goalScorers") ||
        panelText
      );
    }
    if (key === "lineup") {
      if (looksLikeLineupTabContent(panelText)) return panelText;
      return (
        extractLineupSectionFromText(panelText) ||
        findBestScopedSidePanelText(fallbacks, "lineup") ||
        panelText
      );
    }
    return panelText;
  }

  function dispatchPanelClick(el) {
    try {
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
  }

  function normalizeStatsLeafText(el) {
    return normalizeStatsSubTabLabel(el?.innerText || el?.textContent || "");
  }

  function getLeafStatsSubTabKey(el) {
    const childTexts = [...(el?.children || [])].map((child) => normalizeStatsLeafText(child));
    return leafStatsSubTabKey(normalizeStatsLeafText(el), childTexts);
  }

  function walkElementsWithin(root, consider) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      consider(node);
      node = walker.nextNode();
    }
  }

  async function scrollStatsSubTabBars(root) {
    const bars = [];
    const scope = root || document.documentElement;
    walkElementsWithin(scope, (el) => {
      const cls = String(el.className || "");
      if (
        /Classification|HorizontalScroll|StatsRibbon|StatsCategory|SubNav|Scroller|StatsDetail|LiteScoreboard/i.test(
          cls
        ) &&
        el.scrollWidth > el.clientWidth + 8
      ) {
        bars.push(el);
      }
    });
    for (const bar of [...new Set(bars)]) {
      try {
        const maxScroll = Math.max(0, bar.scrollWidth - bar.clientWidth);
        for (const fraction of STATS_SUB_TAB_SCROLL_FRACTIONS) {
          bar.scrollLeft = Math.floor(maxScroll * fraction);
          await delay(30);
        }
      } catch (_) {}
    }
  }

  function findLiveStatsPanelRoot(fromTab) {
    const roots = [];
    if (fromTab) {
      let node = fromTab;
      for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
        roots.push(node);
      }
    }

    LIVE_STATS_PANEL_SCOPE_SELECTORS.forEach((sel) =>
      queryDeep(sel).forEach((el) => roots.push(el))
    );

    let best = null;
    let bestScore = 0;
    for (const el of [...new Set(roots)]) {
      const score = scoreLiveStatsPanelRootText(el.innerText || "");
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function collectStatsSubTabCandidates(root, fromTab = null) {
    const nodes = [];
    const seen = new Set();
    const scopes = [];
    const sideRoot = findSidePanelRoot(fromTab);
    if (sideRoot) scopes.push(sideRoot);
    if (root) scopes.push(root);
    if (!scopes.length) return [];

    const pushNode = (el) => {
      try {
        const text = normalizeStatsSubTabLabel(el?.innerText || el?.textContent || "");
        const childTexts = [...(el?.children || [])].map((child) =>
          normalizeStatsSubTabLabel(child.innerText || child.textContent || "")
        );
        if (!isStatsSubTabLeafText(text) && !leafStatsSubTabKey(text, childTexts)) return;
        if (String(el.innerText || "").length > 80) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 4) return;
        const label = leafStatsSubTabKey(text, childTexts) || statsSubTabKey(text);
        if (!label) return;
        const key = STATS_SUB_TAB_KEYS[STATS_SUB_TAB_LABELS.indexOf(label)];
        if (!key) return;
        const dedupe = `${key}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        nodes.push({
          el,
          text,
          childTexts,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
        });
      } catch (_) {}
    };

    for (const scope of [...new Set(scopes)]) {
      const containers = [];
      walkElementsWithin(scope, (el) => {
        const score = scoreStatsSubTabBarContainer(el.textContent || "");
        if (score >= 3) containers.push({ el, score });
      });
      containers.sort((a, b) => b.score - a.score);

      for (const { el } of containers.slice(0, 4)) {
        walkElementsWithin(el, pushNode);
        if (nodes.length >= STATS_SUB_TAB_KEYS.length) break;
      }

      if (nodes.length < STATS_SUB_TAB_KEYS.length) {
        for (const sel of STATS_SUB_TAB_LEAF_SELECTORS) {
          (scope.querySelectorAll ? scope.querySelectorAll(sel) : []).forEach(pushNode);
          if (nodes.length >= STATS_SUB_TAB_KEYS.length) break;
        }
      }

      if (nodes.length < STATS_SUB_TAB_KEYS.length) {
        walkElementsWithin(scope, pushNode);
      }
    }

    let picked = collectStatsSubTabCandidatesFromNodes(nodes, window.innerWidth, {
      band: "strict",
    });
    if (!picked.length) {
      picked = collectStatsSubTabCandidatesFromNodes(nodes, window.innerWidth, { band: "relaxed" });
    }
    return picked.map((tab) => ({
      ...tab,
      el: tab.el,
    }));
  }

  function collectSidePanelTabElements(labelRe, tabKey = null) {
    const nodes = [];
    const scopes = [];
    SIDE_PANEL_TAB_SCOPE_SELECTORS.forEach((sel) =>
      queryDeep(sel).forEach((el) => scopes.push(el))
    );
    if (!scopes.length) scopes.push(document.documentElement);

    const pushNode = (el) => {
      const text = normalizeSidePanelTabLabel(el?.innerText || el?.textContent || "");
      if (!text || !labelRe.test(text)) return;
      const childTexts = [...(el?.children || [])].map((child) =>
        normalizeSidePanelTabLabel(child.innerText || child.textContent || "")
      );
      if (!leafSidePanelTabKey(text, childTexts)) return;
      try {
        const rect = el.getBoundingClientRect();
        const relaxed = tabKey === "goalScorers" || tabKey === "lateral";
        if (relaxed) {
          if (!isInRelaxedSidePanelTabBand(rect, window.innerWidth)) return;
        } else if (!isInSidePanelTabBand(rect, window.innerWidth)) {
          return;
        }
        nodes.push({
          el,
          text,
          childTexts,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
        });
      } catch (_) {}
    };

    for (const scope of [...new Set(scopes)]) {
      let foundInScope = false;
      for (const sel of SIDE_PANEL_TAB_LEAF_SELECTORS) {
        const elements = scope.querySelectorAll ? [...scope.querySelectorAll(sel)] : [];
        for (const el of elements) {
          const before = nodes.length;
          pushNode(el);
          if (nodes.length > before) foundInScope = true;
        }
        if (foundInScope) break;
      }
      if (foundInScope) break;
    }

    if (!nodes.length) {
      for (const scope of [...new Set(scopes)]) {
        walkElementsWithin(scope, pushNode);
      }
    }

    return collectSidePanelTabCandidates(nodes, window.innerWidth);
  }

  function clickSidePanelTab(labelRe, scopeRoot = null, tabKey = null) {
    if (scopeRoot) {
      const text = normalizeSidePanelTabLabel(scopeRoot?.innerText || scopeRoot?.textContent || "");
      if (labelRe.test(text)) {
        try {
          scopeRoot.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        } catch (_) {}
        dispatchPanelClick(scopeRoot);
        return scopeRoot;
      }
    }

    const candidates = collectSidePanelTabElements(labelRe, tabKey);
    const tab = candidates[0]?.el;
    if (!tab) return null;
    try {
      tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
    } catch (_) {}
    dispatchPanelClick(tab);
    return tab;
  }

  function getStatsPanelScopedText(statsRoot, fromTab) {
    if (fromTab) {
      let node = fromTab;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const text = node.innerText || "";
        if (
          text.length > 40 &&
          looksLikeLiveStatsPanelText(text) &&
          !looksLikeMarketRibbonText(text)
        ) {
          return text;
        }
      }
    }

    const rootText = statsRoot?.innerText || "";
    if (rootText && looksLikeLiveStatsPanelText(rootText) && !looksLikeMarketRibbonText(rootText)) {
      return rootText;
    }
    return "";
  }

  async function collectStatsSubTabTexts(statsRoot, fromTab = null, options = {}) {
    const textBySubTab = {};
    const subTabClicks = {};
    const startedAt = Date.now();
    const budgetMs = options.budgetMs ?? STATS_SUB_TAB_VISIT_BUDGET_MS;

    if (!statsRoot || budgetMs <= 0) {
      return { textBySubTab, subTabClicks, skipped: "no-live-stats-panel" };
    }

    const panelText = statsRoot.innerText || "";
    if (!looksLikeLiveStatsPanelText(panelText) || shouldTreatAsMarketRibbonNotStats(panelText)) {
      return { textBySubTab, subTabClicks, skipped: "market-ribbon-not-stats-panel" };
    }

    const searchRoot = findSidePanelRoot(fromTab) || statsRoot;
    await scrollStatsSubTabBars(searchRoot);
    let tabs = collectStatsSubTabCandidates(statsRoot, fromTab);

    for (const key of STATS_SUB_TAB_KEYS) {
      if (Date.now() - startedAt > budgetMs) break;
      await scrollStatsSubTabBars(searchRoot);
      tabs = collectStatsSubTabCandidates(statsRoot, fromTab);
      let tab = tabs.find((t) => t.key === key);
      if (!tab) continue;
      try {
        tab.el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        dispatchPanelClick(tab.el);
        subTabClicks[key] = true;
        await delay(STATS_SUB_TAB_CLICK_DELAY_MS);
        const panelText = getStatsPanelScopedText(statsRoot, tab.el);
        textBySubTab[key] = panelText ? `${tab.label}\n${panelText}` : tab.label;
      } catch (_) {}
    }

    return { textBySubTab, subTabClicks, skipped: null };
  }

  function clickStatsTab() {
    return clickSidePanelTab(SIDE_PANEL_TAB_LABELS.stats);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const TIMELINE_SCROLL_FRACTIONS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];

  function findTimelinePanelRoot(fromTab) {
    const roots = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      roots.push(el);
    };

    if (fromTab) {
      let node = fromTab;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        push(node);
      }
    }

    TIMELINE_PANEL_SCOPE_SELECTORS.forEach((sel) => queryDeep(sel).forEach((el) => push(el)));
    const fallback = findSidePanelRoot(fromTab);
    if (fallback) push(fallback);

    let best = fallback;
    let bestScore = scoreTimelinePanelText(best?.innerText || "");
    for (const el of roots) {
      const score = scoreTimelinePanelText(el.innerText || "");
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function scoreTimelineScrollTarget(el) {
    const t = el?.innerText || "";
    let score = scoreTimelinePanelText(t);
    const cls = String(el?.className || "");
    if (/Timeline|Chronolog|EventsList|MatchEvent|Incident|LocationEvent/i.test(cls)) score += 150;
    if (/Scroller|Scroll|Virtual/i.test(cls)) score += 60;
    const overflow = Math.max(0, (el?.scrollHeight || 0) - (el?.clientHeight || 0));
    if (overflow > 8) score += Math.min(overflow, 300);
    else score -= 120;
    if (el?.clientHeight > 0 && el.clientHeight < 520) score += 40;
    return score;
  }

  function collectTimelineScrollTargets(root) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };

    try {
      TIMELINE_PANEL_SCOPE_SELECTORS.forEach((sel) => root.querySelectorAll(sel).forEach(push));
      collectScrollableTargets(root).forEach(push);
      root.querySelectorAll("*").forEach((el) => {
        if (!isScrollableElement(el)) return;
        push(el);
      });
    } catch (_) {}

    queryDeep(
      "[class*='Timeline'], [class*='Chronolog'], [class*='EventsList'], [class*='Scroller'], [class*='LocationEvents']"
    ).forEach((el) => {
      if (root === el || root.contains(el)) push(el);
    });

    return out.sort((a, b) => scoreTimelineScrollTarget(b) - scoreTimelineScrollTarget(a));
  }

  async function clickTimelineExpandTotals(root) {
    let clicked = false;
    const tryClick = (el) => {
      if (clicked || !el) return;
      const t = normalize(el.innerText || el.textContent || "");
      if (!isTimelineExpandTotalsText(t)) return;
      dispatchPanelClick(el);
      clicked = true;
    };

    walkElementsWithin(root, tryClick);
    if (!clicked) {
      queryDeep("button, [role='button'], a, span, div").forEach((el) => {
        if (clicked) return;
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width < 8 || rect.height < 8) return;
        if (rect.left < window.innerWidth * 0.35) return;
        tryClick(el);
      });
    }
    if (clicked) await delay(220);
    return clicked;
  }

  async function scrollTimelineRowsIntoView(root) {
    const rows = [];
    walkElementsWithin(root, (el) => {
      const t = normalize(el.innerText || el.textContent || "");
      if (isTimelineRowText(t)) rows.push(el);
    });

    for (const el of [...new Set(rows)].slice(-14)) {
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(85);
      } catch (_) {}
    }
  }

  async function scrollTimelinePanel(fromTab) {
    const root = findTimelinePanelRoot(fromTab) || findSidePanelRoot(fromTab);
    if (!root) return { text: "", scrollSteps: 0, container: null };

    const snapshots = [];
    const capture = (...els) => {
      const texts = els
        .filter(Boolean)
        .map((el) => el.innerText || "")
        .filter(Boolean);
      if (root?.innerText) texts.push(root.innerText);
      const merged = mergeTimelineSectionTexts(...texts);
      if (merged) snapshots.push(merged);
    };

    const expandClicked = await clickTimelineExpandTotals(root);
    capture(root);

    const targets = collectTimelineScrollTargets(root).slice(0, 4);
    const originals = new Map();

    for (const scrollEl of targets) {
      originals.set(scrollEl, scrollEl.scrollTop);
      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      if (maxScroll < 8) continue;

      for (const fraction of TIMELINE_SCROLL_FRACTIONS) {
        scrollEl.scrollTop = Math.floor(maxScroll * fraction);
        scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
        try {
          scrollEl.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 })
          );
        } catch (_) {}
        await delay(90);
        capture(scrollEl);
      }
    }

    await scrollTimelineRowsIntoView(root);
    capture(root);
    for (const scrollEl of targets.slice(0, 2)) {
      capture(scrollEl);
    }

    originals.forEach((top, el) => {
      el.scrollTop = top;
    });

    const merged = mergeTimelineSectionTexts(...snapshots);
    return {
      text: merged || snapshots[0] || "",
      scrollSteps: snapshots.length,
      expandClicked,
      container: String(targets[0]?.className || root.className || "timeline-scroll").slice(0, 80),
    };
  }

  async function collectSidePanelTexts() {
    const textByTab = {};
    const tabClicks = {};
    const fullText = getAllVisibleText();
    const textBySubTab = {};
    const subTabClicks = {};
    let statsSubTabsSkipped = null;
    let timelineScrollMeta = null;
    const sidePanelStartedAt = Date.now();
    const sidePanelRemainingMs = () =>
      Math.max(0, SIDE_PANEL_VISIT_BUDGET_MS - (Date.now() - sidePanelStartedAt));

    const statsTab = clickSidePanelTab(SIDE_PANEL_TAB_LABELS.stats);
    tabClicks.stats = Boolean(statsTab);
    if (statsTab) await delay(180);

    const statsRoot = findLiveStatsPanelRoot(statsTab) || findSidePanelRoot(statsTab);
    let lastStatsTab = statsTab;
    const subTabBudget = Math.min(
      SIDE_PANEL_STATS_SUB_TAB_BUDGET_MS,
      Math.max(0, sidePanelRemainingMs() - 4000)
    );
    if (subTabBudget > 800) {
      const initialSubTabs = await collectStatsSubTabTexts(statsRoot, statsTab, {
        budgetMs: subTabBudget,
      });
      Object.assign(textBySubTab, initialSubTabs.textBySubTab);
      Object.assign(subTabClicks, initialSubTabs.subTabClicks);
      statsSubTabsSkipped = initialSubTabs.skipped;
    }

    textByTab.stats = mergeSidePanelTabText(getSidePanelText(statsTab), fullText, "stats");

    for (const key of SIDE_PANEL_TAB_KEYS) {
      if (key === "stats") continue;
      const essential =
        key === "timeline" || key === "lineup" || key === "playerStats" || key === "goalScorers";
      if (!essential && sidePanelRemainingMs() < 600) continue;
      let tab = clickSidePanelTab(SIDE_PANEL_TAB_LABELS[key], null, key);
      if (!tab && key === "goalScorers") {
        tab = clickStatsMarcadoresSubTab(statsRoot, lastStatsTab);
      }
      tabClicks[key] = Boolean(tab);
      if (tab) await delay(essential ? 200 : 120);
      const scopedText = getSidePanelScopedText(tab, key, [
        getSidePanelText(statsRoot),
        textByTab.stats,
      ]);
      if (key === "timeline" && tab) {
        const scrolled = await scrollTimelinePanel(tab);
        timelineScrollMeta = scrolled;
        const timelineText = mergeTimelineSectionTexts(
          scopedText || getSidePanelText(tab),
          scrolled.text
        );
        textByTab[key] = mergeSidePanelTabText(
          timelineText || scopedText || getSidePanelText(tab),
          fullText,
          key
        );
      } else {
        const refined = refineSidePanelTabText(key, tab, scopedText, [
          getSidePanelText(statsRoot),
          textByTab.stats,
          getSidePanelText(tab),
        ]);
        textByTab[key] = mergeSidePanelTabText(refined, fullText, key);
      }
      if (key === "stats") lastStatsTab = tab || lastStatsTab;
    }

    const ingested = ingestSidePanelTabStats(textByTab, textBySubTab, subTabClicks);
    Object.assign(textBySubTab, ingested.textBySubTab);
    Object.assign(subTabClicks, ingested.subTabClicks);

    textByTab.statsSubTabs = textBySubTab;
    textByTab.statsSubTabClicks = subTabClicks;
    textByTab.statsSubTabMerged = mergeStatsSubTabTexts(textBySubTab);
    textByTab.statsSubTabCapture = summarizeStatsSubTabCapture(textBySubTab, subTabClicks);

    clickSidePanelTab(SIDE_PANEL_TAB_LABELS.stats);

    return {
      textByTab,
      tabClicks,
      statsSubTabClicks: subTabClicks,
      statsSubTabsSkipped,
      timelineScrollMeta,
    };
  }

  function isScrollableElement(el) {
    if (!el || el.scrollHeight <= el.clientHeight + 20) return false;
    try {
      const style = getComputedStyle(el);
      const oy = style.overflowY;
      return oy === "auto" || oy === "scroll" || oy === "overlay";
    } catch (_) {
      return false;
    }
  }

  function collectScrollableTargets(root) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };

    push(root);
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (isScrollableElement(el)) push(el);
      });
    } catch (_) {}

    let parent = root.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      if (isScrollableElement(parent)) push(parent);
    }

    return out.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight) ||
        b.scrollHeight - a.scrollHeight
    );
  }

  function findMarketScrollRoots() {
    const roots = [];
    const selectors = [
      "[class*='EventViewDetailScroller']",
      "[class*='MarketGroups']",
      "[class*='MarketBoard']",
      "[class*='ClassificationMarketGrid']",
      "[class*='CouponMarketGrid']",
      "[class*='IPMarketView']",
      "[class*='MarketGrid']",
    ];

    for (const sel of selectors) {
      queryDeep(sel).forEach((el) => roots.push(el));
    }

    if (!roots.length) {
      queryDeep("*").forEach((el) => {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width < 80 || rect.left > window.innerWidth * 0.62) return;
          if (!isScrollableElement(el)) return;
          roots.push(el);
        } catch (_) {}
      });
    }

    return [...new Set(roots)];
  }

  function marketTextFingerprint(text) {
    const playerMarkets = (text.match(/Jogador\s*-/gi) || []).length;
    const meetMarkets = (text.match(/Encontro\s*-/gi) || []).length;
    const fouls = (text.match(/Faltas Cometidas/gi) || []).length;
    const instant = (text.match(/APOSTAS INSTANTÂNEAS|Próximo Minuto/gi) || []).length;
    const corners = (text.match(/Escanteios\s*-/gi) || []).length;
    const scorers = (text.match(/Marcadores de Gol/gi) || []).length;
    return `${text.length}|${playerMarkets}|${meetMarkets}|${fouls}|${instant}|${corners}|${scorers}`;
  }

  function normalizeLeafText(el) {
    return normalizeMarketTabLabel(el?.innerText || el?.textContent || "");
  }

  function getLeafTabKey(el) {
    const childTexts = [...(el?.children || [])].map((child) => normalizeLeafText(child));
    return leafMarketTabKey(normalizeLeafText(el), childTexts);
  }

  function dispatchMarketTabClick(el) {
    try {
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
  }

  function resolveMarketGroupContainer(el) {
    if (!el) return null;
    for (const sel of MARKET_GROUP_CONTAINER_SELECTORS) {
      const hit = el.closest?.(sel);
      if (hit) return hit;
    }
    return el.parentElement?.parentElement || el.parentElement || null;
  }

  function resolveMarketGroupHeader(container) {
    if (!container) return null;
    for (const sel of MARKET_GROUP_HEADER_SELECTORS) {
      const hit = container.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }

  function elementIsVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      );
    } catch (_) {
      return false;
    }
  }

  function marketGroupHasVisibleOdds(container) {
    if (!container) return false;
    for (const sel of MARKET_ODDS_SELECTORS) {
      const nodes = container.querySelectorAll(sel);
      for (const node of nodes) {
        if (elementIsVisible(node)) return true;
      }
    }
    const lines = (container.innerText || "")
      .split("\n")
      .map(normalize)
      .filter(Boolean);
    return lines.some((line) => /^\d+[.,]\d{1,3}$/.test(line));
  }

  function isCollapsedMarketGroup(container) {
    if (!container) return false;
    const header = resolveMarketGroupHeader(container) || container;
    const ariaExpanded =
      header.getAttribute?.("aria-expanded") ?? container.getAttribute?.("aria-expanded");
    if (isMarketGroupCollapsedHint({
      ariaExpanded,
      className: `${container.className || ""} ${header.className || ""}`,
    })) {
      return true;
    }
    return !marketGroupHasVisibleOdds(container);
  }

  function collectExpandClickTargets() {
    const targets = [];
    const seen = new Set();

    const pushTarget = (el, key) => {
      if (!el || seen.has(key)) return;
      try {
        const rect = el.getBoundingClientRect();
        if (!isInLeftMarketColumn(rect, window.innerWidth)) return;
        if (rect.width < 6 || rect.height < 4) return;
      } catch (_) {
        return;
      }
      seen.add(key);
      targets.push({ el, key });
    };

    queryDeep(
      [
        ...MARKET_GROUP_HEADER_SELECTORS,
        "[class*='MarketGroup'] *",
        "[class*='CouponMarket'] *",
        "button",
        "[role='button']",
        "span",
        "a",
        "div",
      ].join(", ")
    ).forEach((el) => {
      const text = normalize(el.textContent || "");
      if (!text) return;

      if (isMarketShowMoreText(text)) {
        const rect = el.getBoundingClientRect?.();
        pushTarget(el, `more|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`);
        return;
      }

      if (!isMarketCaExpandText(text) || text.length > 4) return;
      const container = resolveMarketGroupContainer(el);
      if (!shouldClickMarketExpandControl("CA", { collapsed: isCollapsedMarketGroup(container) })) {
        return;
      }
      const clickEl =
        el.closest(
          "[class*='MarketGroupButton'], [class*='MarketGroup'][class*='Header'], [role='button'], button"
        ) || el;
      const rect = clickEl.getBoundingClientRect?.();
      pushTarget(clickEl, `ca|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`);
    });

    queryDeep(MARKET_GROUP_HEADER_SELECTORS.join(", ")).forEach((header) => {
      const text = normalize(header.textContent || "");
      if (!isLikelyMarketGroupHeaderText(text)) return;
      const container = resolveMarketGroupContainer(header);
      if (!isCollapsedMarketGroup(container)) return;
      const rect = header.getBoundingClientRect?.();
      pushTarget(header, `hdr|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`);
    });

    return targets;
  }

  async function expandCollapsedMarkets(capture, startedAt) {
    let expandClicked = 0;
    const clicked = new Set();

    for (let pass = 0; pass < 3; pass++) {
      const targets = collectExpandClickTargets();
      for (const target of targets) {
        if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) return expandClicked;
        if (expandClicked >= MARKET_EXPAND_MAX_CLICKS) return expandClicked;
        if (clicked.has(target.key)) continue;
        clicked.add(target.key);
        try {
          target.el.scrollIntoView({ block: "center", behavior: "instant" });
          dispatchMarketTabClick(target.el);
          expandClicked++;
          await delay(MARKET_EXPAND_CLICK_DELAY_MS);
          capture();
        } catch (_) {}
      }
      if (!targets.length) break;
    }

    return expandClicked;
  }

  function walkTabContainer(container, consider) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      consider(node);
      node = walker.nextNode();
    }
  }

  function getMarketTabPageMode() {
    return resolveMarketTabPageMode(location.href);
  }

  function getMarketTabsVisitList() {
    return marketTabsVisitList(getMarketTabPageMode());
  }

  function collectMarketCategoryTabs() {
    const pageMode = getMarketTabPageMode();
    const visitList = getMarketTabsVisitList();
    const nodes = [];
    const seen = new Set();
    const containerRects = [];

    const pushNode = (el) => {
      try {
        const text = normalizeLeafText(el);
        const childTexts = [...(el?.children || [])].map((child) => normalizeLeafText(child));
        if (!isMarketTabLeafText(text) && !leafMarketTabKey(text, childTexts)) return;
        if (String(el.innerText || "").length > 80) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 4) return;
        const label = marketCategoryTabKey(text) || leafMarketTabKey(text, childTexts);
        if (!label) return;
        const dedupe = `${label}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        nodes.push({
          el,
          text,
          childTexts,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            bottom: rect.bottom,
            right: rect.right,
          },
        });
      } catch (_) {}
    };

    const containers = [];
    MARKET_TAB_CONTAINER_SELECTORS.forEach((sel) => {
      queryDeep(sel).forEach((el) => {
        const score = scoreMarketTabBarContainer(el.textContent || "");
        if (score >= 3) {
          containers.push({ el, score });
          try {
            const rect = el.getBoundingClientRect();
            containerRects.push({
              score,
              rect: {
                top: rect.top,
                left: rect.left,
                bottom: rect.bottom,
                right: rect.right,
              },
            });
          } catch (_) {}
        }
      });
    });
    containers.sort((a, b) => b.score - a.score);

    for (const { el } of containers.slice(0, 6)) {
      walkTabContainer(el, pushNode);
      if (nodes.length >= visitList.length) break;
    }

    if (nodes.length < 3) {
      for (const sel of MARKET_TAB_LEAF_SELECTORS) {
        queryDeep(sel).forEach(pushNode);
        if (nodes.length >= visitList.length) break;
      }
    }

    return collectMarketTabCandidates(
      nodes,
      window.innerHeight,
      window.innerWidth,
      pageMode,
      containerRects
    ).map((tab) => ({ ...tab, el: tab.el }));
  }

  async function scrollMarketTabBars() {
    const bars = [];
    queryDeep(
      "[class*='Classification'][class*='Scroll'], [class*='ClassificationRibbon'], [class*='HorizontalScroll']"
    ).forEach((bar) => bars.push(bar));

    for (const bar of [...new Set(bars)]) {
      try {
        bar.scrollLeft = bar.scrollWidth;
        await delay(40);
      } catch (_) {}
    }
  }

  async function scrollPlayerPropGrids(capture, startedAt) {
    const headers = queryDeep(
      "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
    ).filter((el) =>
      /Jogador\s*-|Jogador\/Contagem|Escanteios|Cart[oõ]es|Número de Cartões/i.test(
        normalize(el.textContent)
      )
    );

    for (const header of headers.slice(0, 8)) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(90);
        capture();
      } catch (_) {}
    }

    const scrollRoots = findMarketScrollRoots();
    for (const root of scrollRoots.slice(0, 1)) {
      const el = collectScrollableTargets(root)[0];
      if (!el) continue;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll < 20) continue;
      const step = Math.max(220, Math.ceil(maxScroll / 5));
      for (let pos = 0; pos <= maxScroll + step; pos += step) {
        if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
        el.scrollTop = Math.min(pos, maxScroll);
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(50);
        capture();
      }
    }
  }

  async function visitMarketCategoryTabs(capture) {
    const visited = [];
    const startedAt = Date.now();

    await scrollMarketTabBars();
    let tabs = collectMarketCategoryTabs();

    for (const key of getMarketTabsVisitList()) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      let tab = tabs.find((t) => t.label === key);
      if (!tab) {
        await scrollMarketTabBars();
        tabs = collectMarketCategoryTabs();
        tab = tabs.find((t) => t.label === key);
      }
      if (!tab) continue;
      try {
        tab.el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        dispatchMarketTabClick(tab.el);
        visited.push(key);
        await delay(MARKET_TAB_CLICK_DELAY_MS);
        capture();
        if (isPlayerMarketTabKey(key) || isCornerMarketTabKey(key)) {
          await scrollPlayerPropGrids(capture, startedAt);
          await expandCollapsedMarkets(capture, startedAt);
        }
      } catch (_) {}
    }

    return visited;
  }

  async function scrollLeftColumnMarkets(maxSteps = 12) {
    const snapshots = [];
    const seen = new Set();
    const roots = findMarketScrollRoots();
    if (!roots.length) return { snapshots, scrollSteps: 0, container: null };

    const targets = [];
    const targetSeen = new Set();
    roots.forEach((root) => {
      collectScrollableTargets(root).forEach((el) => {
        if (targetSeen.has(el)) return;
        targetSeen.add(el);
        targets.push(el);
      });
    });

    if (!targets.length) return { snapshots, scrollSteps: 0, container: null };

    const originals = new Map(targets.map((el) => [el, el.scrollTop]));
    const primary = targets[0];

    const capture = () => {
      const text = getAllVisibleText();
      const key = marketTextFingerprint(text);
      if (!seen.has(key)) {
        seen.add(key);
        snapshots.push(text);
      }
    };

    const scrollTarget = async (el) => {
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll < 20) return;
      const step = Math.max(180, Math.ceil(maxScroll / maxSteps));
      for (let pos = 0; pos <= maxScroll + step; pos += step) {
        el.scrollTop = Math.min(pos, maxScroll);
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(100);
        capture();
      }
    };

    capture();
    const startedAt = Date.now();
    let expandClicked = 0;

    for (const target of targets.slice(0, 3)) {
      await scrollTarget(target);
    }

    const marketHeaders = queryDeep(
      "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
    ).filter((el) =>
      /Jogador\s*-|Jogador\/Contagem|Encontro\s*-|Faltas|Assist|Escanteios|Cart[oõ]es|Número de Cartões/i.test(
        normalize(el.textContent)
      )
    );

    for (const header of marketHeaders.slice(0, 18)) {
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(120);
        capture();
      } catch (_) {}
    }

    expandClicked = await expandCollapsedMarkets(capture, startedAt);

    originals.forEach((top, el) => {
      el.scrollTop = top;
    });

    return {
      snapshots,
      scrollSteps: snapshots.length,
      container: String(primary.className || "scrollable").slice(0, 80),
      tabsVisited: [],
      expandClicked,
      playerMarkets: snapshots.reduce(
        (sum, text) => sum + (text.match(/Jogador\s*-/gi) || []).length,
        0
      ),
    };
  }

  function extractStatsFromDOM() {
    const stats = [];
    const seen = new Set();
    const rowSels = [
      "[class*='SimpleMatchStats']",
      "[class*='StatsGraph']",
      "[class*='StatsBar']",
      "[class*='StatsIndicator']",
      "[class*='StatRow']",
    ];

    for (const sel of rowSels) {
      queryDeep(sel).forEach((row) => {
        const lines = (row.innerText || "").split("\n").map(normalize).filter(Boolean);
        if (lines.length < 3) return;
        const label = lines.find((l) => !isNum(l) && l.length < 40);
        const nums = lines.filter(isNum);
        if (!label || nums.length < 2) return;
        const key = `${label}|${nums[0]}|${nums[1]}`;
        if (seen.has(key)) return;
        seen.add(key);
        stats.push({ label, home: nums[0], away: nums[1], source: "dom" });
      });
      if (stats.length) break;
    }
    return stats;
  }

  function extractOddsFromDOM() {
    const odds = [];
    const seen = new Set();
    const marketSels =
      "[class*='MarketGroup'], [class*='HorizontalMarket'], [class*='Market_Column']";

    queryDeep(marketSels).forEach((group) => {
      const market = normalize(
        group.querySelector(
          "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
        )?.textContent || "Mercado"
      );

      group
        .querySelectorAll(
          "[class*='ParticipantOddsOnly'], [class*='ParticipantLabel'], [class*='Participant_General']"
        )
        .forEach((p) => {
          const name = normalize(p.querySelector("[class*='_Name'], [class*='Name']")?.textContent);
          const handicap = normalize(p.querySelector("[class*='Handicap']")?.textContent);
          const oddsRaw = normalize(
            p.querySelector("[class*='_Odds'], [class*='OddsOnly_Odds']")?.textContent
          );

          const selection = name || (handicap && !isLineValue(handicap) ? handicap : null);
          const odd = parseOdd(oddsRaw);

          if (!isValidSelection(selection) || !isValidOdd(odd)) return;

          const fullSelection =
            handicap && isLineValue(handicap) ? `${selection} (${handicap})` : selection;

          const key = `${market}|${fullSelection}|${odd}`;
          if (seen.has(key)) return;
          seen.add(key);
          odds.push({ market, selection: fullSelection, odds: odd, source: "dom" });
        });
    });

    return odds;
  }

  function pushMatchCandidatesFromText(candidates, text, source, extractedAt) {
    candidates.push(...collectMatchCandidatesFromText(text, source, extractedAt, 3500));
  }

  const DOM_SCOREBOARD_SELECTORS = [
    { sel: "[class*='ovm-Overview']", source: "dom-scoreboard" },
    { sel: "[class*='Scoreboard']", source: "dom-scoreboard" },
    { sel: "[class*='MatchLive']", source: "dom-scoreboard" },
    { sel: "[class*='InPlay']", source: "dom-scoreboard" },
    { sel: "[class*='LiveScore']", source: "dom-scoreboard" },
    { sel: "[class*='Video']", source: "dom-scoreboard" },
    { sel: "[class*='Media']", source: "dom-scoreboard" },
    { sel: "[class*='Stream']", source: "dom-scoreboard" },
    { sel: "[class*='EventHeader']", source: "dom" },
    { sel: "[class*='FixtureHeader']", source: "dom" },
    { sel: "[class*='MatchHeader']", source: "dom" },
    { sel: "[class*='Score']", source: "dom" },
  ];

  function extractMatchHeaderFromDOM() {
    const headerSelectors = [
      "[class*='EventHeader']",
      "[class*='FixtureHeader']",
      "[class*='MatchHeader']",
      "[class*='CouponFixture']",
      "[class*='ovm-Overview']",
    ];

    for (const sel of headerSelectors) {
      for (const el of queryDeep(sel)) {
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length < 8 || text.length > 500) continue;
        const header = enrichMatchFromHeader(text, {});
        if (header.homeTeam && header.awayTeam) return header;
      }
    }

    return null;
  }

  function probeDomScoreboardSelectors() {
    return DOM_SCOREBOARD_SELECTORS.map(({ sel, source }) => {
      const els = queryDeep(sel);
      return {
        sel,
        source,
        hits: els.length,
        samples: els
          .slice(0, 3)
          .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 140)),
      };
    }).filter((row) => row.hits > 0);
  }

  function extractMatchFromDOM(extractedAt) {
    const candidates = [];

    for (const { sel, source } of DOM_SCOREBOARD_SELECTORS) {
      queryDeep(sel).forEach((el) => {
        pushMatchCandidatesFromText(candidates, el.innerText || "", source, extractedAt);
      });
    }

    getAllVisibleText()
      .split("---IFRAME---")
      .forEach((chunk) => {
        if (/v\s+[A-Za-zÀ-ú]|\d{1,2}:\d{2}/i.test(chunk) && chunk.length < 1200) {
          pushMatchCandidatesFromText(candidates, chunk, "dom-scoreboard", extractedAt);
        }
      });

    const best = pickBestMatch(candidates, { extractedAt });
    return best ? sanitizeMatchClock(best, extractedAt) : null;
  }

  function mergeScrollSnapshots(...collects) {
    const snapshots = [];
    const seen = new Set();

    for (const collect of collects) {
      for (const text of collect?.snapshots || []) {
        const key = marketTextFingerprint(text);
        if (seen.has(key)) continue;
        seen.add(key);
        snapshots.push(text);
      }
    }

    const playerMarkets = snapshots.reduce(
      (sum, text) => sum + (text.match(/Jogador\s*-/gi) || []).length,
      0
    );

    return {
      snapshots,
      scrollSteps: snapshots.length,
      container:
        collects
          .map((c) => c?.container)
          .filter(Boolean)
          .join(" | ") || null,
      playerMarkets,
    };
  }

  async function scrapeMarketsViaScripting(tabId, maxSteps = 10) {
    if (!tabId || !chrome.runtime?.sendMessage) {
      return { snapshots: [], scrollSteps: 0, container: null, playerMarkets: 0 };
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: "SCROLL_MARKETS",
        tabId,
        maxSteps,
      });
      if (!res?.ok) {
        return {
          snapshots: [],
          scrollSteps: 0,
          container: null,
          playerMarkets: 0,
          error: res?.error || "scroll-failed",
        };
      }
      return res.result || { snapshots: [], scrollSteps: 0, container: null, playerMarkets: 0 };
    } catch (err) {
      return {
        snapshots: [],
        scrollSteps: 0,
        container: null,
        playerMarkets: 0,
        error: String(err?.message || err),
      };
    }
  }

  async function scrapeFramesViaScripting(tabId) {
    if (!tabId || !chrome.scripting?.executeScript) return [];

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const text = document.documentElement?.innerText || document.body?.innerText || "";
          const href = location.href;
          const scoreHint =
            /\d{1,2}\s*[-–]\s*\d{1,2}/.test(text) ||
            /[A-Za-zÀ-ú]{3,}\d{1,2}\d{1,2}[A-Za-zÀ-ú]{3,}\d{1,2}:\d{2}/.test(
              text.replace(/\s+/g, "")
            ) ||
            /\b\d{2,3}:\d{2}\b/.test(text) ||
            /Ao\s*Vivo/i.test(text);
          const len = text.length;
          return {
            text: text.slice(0, 3500),
            href,
            scoreHint,
            len,
          };
        },
      });

      return (results || [])
        .map((r) => ({ ...r.result, source: "frame-scripting" }))
        .filter((f) => f?.text && f.scoreHint && f.len < 5000);
    } catch (_) {
      return [];
    }
  }

  async function collectAllFrameTexts(tabId) {
    const seen = new Set();
    const out = [];

    function push(chunk) {
      if (!chunk?.text) return;
      const key = `${chunk.source}|${chunk.href || ""}|${chunk.text.slice(0, 160)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(chunk);
    }

    collectFrameWalkTexts().forEach(push);
    const scripted = await scrapeFramesViaScripting(tabId);
    scripted.forEach(push);

    return out;
  }

  async function ensurePageSniffer(tabId) {
    initNetworkBridge();

    let ok = false;

    if (chrome.runtime?.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "INJECT_SNIFFER",
          tabId,
        });
        ok = Boolean(res?.ok);
      } catch (_) {}
    }

    if (!ok && typeof __BET365_PAGE_SNIFFER_SOURCE__ === "string") {
      try {
        injectPageNetworkSniffer(__BET365_PAGE_SNIFFER_SOURCE__);
        ok = true;
      } catch (_) {}
    }

    return ok;
  }

  async function buildData(tabId) {
    const pipeline = [];
    let stepAt = Date.now();

    const snifferOk = await ensurePageSniffer(tabId);
    pipeline.push({ step: "injectSniffer", ok: snifferOk, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const extractedAt = new Date().toISOString();
    const { textByTab, tabClicks, statsSubTabClicks, statsSubTabsSkipped, timelineScrollMeta } =
      await collectSidePanelTexts();
    const pageText = getAllVisibleText();
    const sideText = Object.values(textByTab).filter(Boolean).join("\n---SIDE-TAB---\n");
    const visibleText = sideText ? `${pageText}\n---PAGE---\n${sideText}` : pageText;
    pipeline.push({
      step: "sidePanelTabs",
      ok: Object.values(tabClicks).some(Boolean),
      detail: [
        SIDE_PANEL_TAB_KEYS.map((k) => `${k}=${tabClicks[k] ? "ok" : "miss"}`).join(", "),
        `subtabs=${STATS_SUB_TAB_KEYS.filter((k) => statsSubTabClicks?.[k]).join(",") || "none"}`,
        statsSubTabsSkipped ? `subtabsSkip=${statsSubTabsSkipped}` : null,
        timelineScrollMeta?.scrollSteps ? `timelineScroll=${timelineScrollMeta.scrollSteps}` : null,
        timelineScrollMeta?.expandClicked ? "timelineExpand=ok" : null,
      ]
        .filter(Boolean)
        .join(" | "),
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    pipeline.push({
      step: "visibleText",
      count: visibleText.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const sidePanelFromText = extractSidePanelFromTexts(
      textByTab,
      extractTeamsFromHeader(pageText)
    );
    const sidePanelFromNet = scanNetworkSidePanel(networkLog);
    const sidePanel = mergeSidePanel(sidePanelFromText, sidePanelFromNet);
    pipeline.push({
      step: "sidePanelParse",
      detail: `timeline=${sidePanel.timeline.length} lineup=${sidePanel.lineup ? "yes" : "no"} finals=${sidePanel.playerFinalizations.length}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const scrollCollect = await scrollLeftColumnMarkets();
    const mainScrollCollect = await scrapeMarketsViaScripting(tabId);
    const mergedScroll = mergeScrollSnapshots(scrollCollect, mainScrollCollect);
    pipeline.push({
      step: "leftColumnScroll",
      count: scrollCollect.scrollSteps,
      detail: `${scrollCollect.container || "none"} tabs=${(scrollCollect.tabsVisited || []).join(",") || "none"} expand=${scrollCollect.expandClicked ?? 0}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();
    pipeline.push({
      step: "mainWorldScroll",
      count: mainScrollCollect.scrollSteps,
      detail: `${mainScrollCollect.container || "none"} playerMarkets=${mainScrollCollect.playerMarkets ?? 0} tabsFound=${mainScrollCollect.tabsFound ?? 0} tabs=${(mainScrollCollect.tabsVisited || []).join(",") || "none"} expand=${mainScrollCollect.expandClicked ?? 0}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const fromNet = extractFromNetworkLog(networkLog, extractedAt);
    pipeline.push({
      step: "networkParse",
      count: networkLog.length,
      detail: `stats=${fromNet.stats.length} odds=${fromNet.odds.length} match=${fromNet.match ? "yes" : "no"}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const domHeader = extractMatchHeaderFromDOM();
    const header = domHeader || enrichMatchFromHeader(pageText, {});
    const domProbe = probeDomScoreboardSelectors();
    pipeline.push({
      step: "domProbe",
      count: domProbe.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const frameChunks = await collectAllFrameTexts(tabId);
    pipeline.push({
      step: "frameCollect",
      count: frameChunks.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const stats = mergeStats(
      extractStatsFromSubTabTexts(textByTab.statsSubTabs, location.href),
      extractStatsFromVisibleText(textByTab.stats || visibleText, location.href),
      extractStatsFromDOM(),
      fromNet.stats
    );

    const odds = mergeOdds(
      extractOddsFromDOM(),
      ...mergedScroll.snapshots.map((chunk) => parseOddsFromVisibleText(chunk)),
      parseOddsFromVisibleText(visibleText),
      fromNet.odds
    );
    pipeline.push({
      step: "statsOddsMerge",
      detail: `stats=${stats.length} odds=${odds.length}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const frameMatch = extractMatchFromFrameChunks(frameChunks, extractedAt, {
      homeTeam: header.homeTeam,
      awayTeam: header.awayTeam,
    });

    const domMatch = extractMatchFromDOM(extractedAt);
    const matchCandidates = gatherMatchCandidates({
      frameChunks,
      visibleText,
      extractedAt,
      extraCandidates: [frameMatch, domMatch, fromNet.match].filter(Boolean),
    });
    pipeline.push({
      step: "matchCandidates",
      count: matchCandidates.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const matchBase =
      resolveMatchForPage(matchCandidates, {
        extractedAt,
        pageUrl: location.href,
      }) || {};
    pipeline.push({
      step: "mergeMatch",
      detail: matchBase.score ? `${matchBase.score} (${matchBase.source})` : "none",
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const meta = {
      version: VERSION,
      rootsScanned: getAllRoots().length,
      networkCaptures: networkLog.length,
      networkBridge: window.__bet365NetBridge ? "page-inject" : "isolated",
      frameTextsScanned: frameChunks.length,
      visibleTextLength: visibleText.length,
      visibleTextSample: visibleText.slice(0, 500),
      statsCount: stats.length,
      oddsCount: odds.length,
      sidePanelTimelineCount: sidePanel.timeline.length,
      sidePanelLineupCaptured: Boolean(sidePanel.lineup),
      sidePanelFinalizationsCount: sidePanel.playerFinalizations.length,
      sidePanelActionAreas: sidePanel.actionAreas || null,
      statsSubTabsCaptured: Object.values(statsSubTabClicks || {}).filter(Boolean).length,
      leftColumnScrollSteps: mergedScroll.scrollSteps,
      mainWorldScrollSteps: mainScrollCollect.scrollSteps,
      mainWorldPlayerMarkets: mainScrollCollect.playerMarkets ?? 0,
      tips: [],
    };

    if (!stats.length) {
      meta.tips.push(
        "Clique na aba 'Estat.' no painel do jogo",
        "Recarregue a página e tente novamente"
      );
    }

    if (!sidePanel.timeline.length && !sidePanel.lineup) {
      meta.tips.push(
        "Painel lateral (Cronologia/Escalação) pode não estar no texto visível — verifique rede no debug"
      );
    }

    let { match, inference, analysis } = finalizeMatchWithMarkets(
      matchBase,
      odds,
      visibleText,
      meta,
      extractedAt,
      location.href,
      { headerText: pageText, domHeader }
    );
    const scoreboardHintText = collectScoreboardHintText(domProbe);
    match = inferMatchStatusFromScoreboard(match, scoreboardHintText);
    sidePanel.timeline = reconcileTimelineGoals(sidePanel.timeline, {
      match,
      marcadoresText: textByTab.statsSubTabs?.marcadores,
      goalScorersText: textByTab.goalScorers,
      scoreboardText: scoreboardHintText,
      timelineText: textByTab.timeline,
      playerFinalizations: sidePanel.playerFinalizations,
      odds,
    });
    meta.sidePanelTimelineCount = sidePanel.timeline.length;
    pipeline.push({
      step: "marketInference",
      ok: inference.applied,
      detail: inference.applied ? `${matchBase.score} -> ${match.score}` : "not applied",
      ms: Date.now() - stepAt,
    });

    if (match.scoreWarnings?.length) {
      meta.tips.push(...match.scoreWarnings);
    }

    meta.debug = buildExtractionDebug({
      matchCandidates,
      frameChunks,
      visibleText,
      marketAnalysis: analysis,
      marketInference: inference,
      extractedAt,
      meta,
      pipeline,
      networkLog,
      sidePanelBlobDebug: sidePanel.network?.blobDebug || [],
      domProbe,
      stats,
      odds,
      selectedMatch: matchBase,
    });

    return {
      match: {
        ...match,
        eventId: (() => {
          const h = location.hash;
          const ev = h.match(/EV\d{8,}/i);
          if (ev) return ev[0];
          const e = h.match(/\/(E\d{6,})\b/i);
          return e ? e[1] : null;
        })(),
        url: location.href,
      },
      stats,
      odds,
      sidePanel,
      meta: {
        ...meta,
        scoreConfidence: match.scoreConfidence,
        scoreWarnings: match.scoreWarnings,
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "EXTRACT") return;
    if (window !== window.top) return;

    const tabId = message.tabId ?? sender.tab?.id;
    buildData(tabId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

    return true;
  });

  function mountExtractPlayer(options = {}) {
  if (window !== window.top) return null;
  if (!isBet365MatchUrl(location.href)) return null;
  if (document.getElementById("bet365-extract-player-root")) return null;

  const buildDataFn = options.buildData || buildData;
  const version = options.version || VERSION;
  const ballSize = EXTRACT_PLAYER_BALL_SIZE_PX;
  const scheduler = createExtractPlayerScheduler();
  let lastData = null;
  let autoDownloadZip = shouldAutoDownloadZipAfterExtract(options);
  let tabId = options.tabId ?? null;
  let drag = null;
  let tickTimer = null;
  const getPageVisibleText =
    options.getPageVisibleText ||
    (() => document.body?.innerText || document.documentElement?.innerText || "");
  const hasMarketDom =
    options.hasMarketDom ||
    (() =>
      Boolean(
        document.querySelector(
          '[class*="MarketGroup"], [class*="CouponPage"], [class*="IPMarketView"], [class*="EventViewDetail"], [class*="ipe-EventView"]'
        )
      ));
  const getPageReadyContext = () => ({
    text: getPageVisibleText(),
    hasMarketDom: hasMarketDom(),
  });
  const isPageReady =
    options.isPageReady ||
    (() => {
      const ctx = getPageReadyContext();
      return isPageReadyForExtract(ctx.text, { hasMarketDom: ctx.hasMarketDom });
    });
  const isPageFailed =
    options.isPageFailed ||
    (() => {
      const ctx = getPageReadyContext();
      return isPageLikelyFailedToLoad(ctx.text, { hasMarketDom: ctx.hasMarketDom });
    });
  const RESTORE_FIRST_RUN_DELAY_MS = 8_000;

  const root = document.createElement("div");
  root.id = "bet365-extract-player-root";
  root.innerHTML = `
<style>
#bet365-extract-player-root {
  position: fixed;
  z-index: 2147483646;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  user-select: none;
  touch-action: none;
}
#bet365-extract-player-root .bet365-player-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  filter: drop-shadow(0 8px 20px rgba(0,0,0,.35));
}
#bet365-extract-player-root .bet365-player-ball {
  width: ${ballSize}px;
  height: ${ballSize}px;
  border-radius: 50%;
  cursor: grab;
  background:
    radial-gradient(circle at 30% 30%, #fff 0 14%, transparent 15%),
    radial-gradient(circle at 68% 38%, #fff 0 10%, transparent 11%),
    radial-gradient(circle at 42% 72%, #fff 0 12%, transparent 13%),
    radial-gradient(circle at 70% 68%, #fff 0 9%, transparent 10%),
    conic-gradient(from 200deg, #0a5f38 0 72deg, #f5f5f5 72deg 144deg, #0a5f38 144deg 216deg, #f5f5f5 216deg 288deg, #0a5f38 288deg 360deg);
  border: 3px solid #063d24;
  box-shadow: inset 0 -4px 10px rgba(0,0,0,.25);
  display: grid;
  place-items: center;
  color: #063d24;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  line-height: 1.1;
  padding: 6px;
}
#bet365-extract-player-root .bet365-player-ball:active { cursor: grabbing; }
#bet365-extract-player-root .bet365-player-ball.is-running {
  box-shadow: 0 0 0 3px rgba(16, 185, 129, .55), inset 0 -4px 10px rgba(0,0,0,.25);
}
#bet365-extract-player-root .bet365-player-ball.is-waiting-page {
  box-shadow: 0 0 0 3px rgba(245, 158, 11, .65), inset 0 -4px 10px rgba(0,0,0,.25);
}
#bet365-extract-player-root .bet365-player-panel {
  width: 240px;
  background: rgba(8, 20, 14, .94);
  color: #ecfdf5;
  border: 1px solid rgba(16, 185, 129, .35);
  border-radius: 12px;
  padding: 10px;
  backdrop-filter: blur(6px);
}
#bet365-extract-player-root label {
  display: block;
  font-size: 11px;
  opacity: .85;
  margin-bottom: 4px;
}
#bet365-extract-player-root input {
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,.15);
  background: rgba(255,255,255,.08);
  color: #fff;
  padding: 6px 8px;
  font-size: 13px;
}
#bet365-extract-player-root .bet365-player-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
#bet365-extract-player-root button {
  border: 0;
  border-radius: 8px;
  padding: 6px 10px;
  font-weight: 600;
  cursor: pointer;
}
#bet365-extract-player-root .bet365-btn-play {
  background: #10b981;
  color: #042f1a;
}
#bet365-extract-player-root .bet365-btn-stop {
  background: #f59e0b;
  color: #3b2500;
}
#bet365-extract-player-root .bet365-btn-zip {
  background: rgba(255,255,255,.12);
  color: #ecfdf5;
}
#bet365-extract-player-root .bet365-player-countdown {
  flex: 1;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
#bet365-extract-player-root .bet365-player-preview {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.35;
  opacity: .92;
  word-break: break-word;
}
#bet365-extract-player-root .bet365-player-status {
  margin-top: 6px;
  font-size: 10px;
  opacity: .75;
}
</style>
<div class="bet365-player-wrap">
  <div class="bet365-player-ball" data-role="ball" title="Arraste a bola · Player v${version}">B365</div>
  <div class="bet365-player-panel">
    <label for="bet365-player-interval">Intervalo (ex: 60, 1:30, 2m)</label>
    <input id="bet365-player-interval" data-role="interval" value="60" />
    <div class="bet365-player-row">
      <button type="button" data-role="toggle" class="bet365-btn-play">▶ Iniciar</button>
      <div class="bet365-player-countdown" data-role="countdown">Próxima: —</div>
    </div>
    <div class="bet365-player-row">
      <button type="button" data-role="zip" class="bet365-btn-zip">ZIP</button>
      <div class="bet365-player-status" data-role="status">Pausado</div>
    </div>
    <div class="bet365-player-preview" data-role="preview">Aguardando 1ª extração…</div>
  </div>
</div>`;

  const ball = root.querySelector('[data-role="ball"]');
  const intervalInput = root.querySelector('[data-role="interval"]');
  const toggleBtn = root.querySelector('[data-role="toggle"]');
  const countdownEl = root.querySelector('[data-role="countdown"]');
  const previewEl = root.querySelector('[data-role="preview"]');
  const statusEl = root.querySelector('[data-role="status"]');
  const zipBtn = root.querySelector('[data-role="zip"]');

  function saveState() {
    const rect = root.getBoundingClientRect();
    try {
      localStorage.setItem(
        EXTRACT_PLAYER_STORAGE_KEY,
        serializePlayerState({
          x: rect.left,
          y: rect.top,
          intervalInput: intervalInput.value,
          running: scheduler.getState().running,
          autoDownloadZip,
        })
      );
    } catch (_) {}
  }

  function applyPosition(pos) {
    const clamped = clampBallPosition(
      pos,
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      ballSize
    );
    root.style.left = `${clamped.x}px`;
    root.style.top = `${clamped.y}px`;
  }

  function restoreState() {
    let pos = defaultBallPosition(
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      ballSize
    );
    try {
      const saved = parsePlayerState(localStorage.getItem(EXTRACT_PLAYER_STORAGE_KEY));
      if (saved?.intervalInput) intervalInput.value = saved.intervalInput;
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        pos = clampBallPosition(
          { x: saved.x, y: saved.y },
          {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          ballSize
        );
      }
      if (saved?.running) {
        scheduler.setIntervalInput(intervalInput.value);
        scheduler.start(Date.now(), { firstRunDelayMs: RESTORE_FIRST_RUN_DELAY_MS });
        syncToggleUi();
      }
      if (saved && "autoDownloadZip" in saved) {
        autoDownloadZip = shouldAutoDownloadZipAfterExtract(saved);
      }
    } catch (_) {}
    scheduler.setIntervalInput(intervalInput.value);
    applyPosition(pos);
  }

  function syncToggleUi(context = {}) {
    const { running, extracting } = scheduler.getState();
    ball.classList.toggle("is-running", running);
    ball.classList.toggle("is-waiting-page", running && (context.failed || context.awaitingPage));
    toggleBtn.textContent = running ? "⏸ Pausar" : "▶ Iniciar";
    toggleBtn.className = running ? "bet365-btn-stop" : "bet365-btn-play";
    statusEl.textContent = getExtractPlayerStatusMessage({
      extracting: context.extracting ?? extracting,
      running,
      failed: context.failed,
      awaitingPage: context.awaitingPage,
      awaitingData: context.awaitingData,
    });
  }

  function updateCountdown(now = Date.now()) {
    const tick = scheduler.tick(now);
    if (!scheduler.getState().running) {
      countdownEl.textContent = "Próxima: —";
      return tick;
    }
    if (!isPageReady()) {
      countdownEl.textContent = isPageFailed()
        ? "Próxima: recarregue F5"
        : "Próxima: aguardando página";
    } else if (tick.action === "extract") {
      countdownEl.textContent = "Próxima: agora";
    } else if (tick.countdownMs != null) {
      countdownEl.textContent = `Próxima: ${formatPlayerCountdown(tick.countdownMs)}`;
    } else {
      countdownEl.textContent = "Próxima: —";
    }
    return tick;
  }

  async function resolveTabId() {
    if (tabId) return tabId;
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" });
      tabId = res?.tabId ?? tabId;
    } catch (_) {}
    return tabId;
  }

  async function downloadZip(data) {
    if (typeof JSZip === "undefined" || typeof buildZipEntries !== "function") {
      statusEl.textContent = "ZIP indisponível";
      return;
    }
    const zip = new JSZip();
    buildZipEntries(data).forEach(({ path, content }) => zip.file(path, content));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const reader = new FileReader();
    const zipBase64 = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || "").split(",")[1]);
      reader.onerror = () => reject(reader.error || new Error("zip read failed"));
      reader.readAsDataURL(blob);
    });
    const filename =
      typeof buildZipFilename === "function"
        ? buildZipFilename(data)
        : `bet365-extract-${Date.now()}.zip`;
    await chrome.runtime.sendMessage({ type: "DOWNLOAD_ZIP", zipBase64, filename });
  }

  async function runExtract() {
    if (scheduler.getState().extracting) return;
    if (!isPageReady()) {
      const failed = isPageFailed();
      previewEl.textContent = failed
        ? "Bet365 não exibiu o jogo. Recarregue a página (F5)."
        : "Aguardando jogo carregar…";
      syncToggleUi({ failed, awaitingPage: !failed });
      return;
    }
    scheduler.markExtractStart(Date.now());
    syncToggleUi({ extracting: true });
    let extractSucceeded = false;
    try {
      const id = await resolveTabId();
      const data = await buildDataFn(id);
      if (!isExtractDataReady(data)) {
        previewEl.textContent = summarizeExtractPreview(data);
        syncToggleUi({ awaitingData: true });
        return;
      }
      extractSucceeded = true;
      lastData = data;
      previewEl.textContent = summarizeExtractPreview(data);
      if (shouldDownloadExtractZip(data, { autoDownloadZip })) {
        syncToggleUi({ extracting: true });
        statusEl.textContent = "ZIP…";
        await downloadZip(data);
        statusEl.textContent = "ZIP ok";
      }
    } catch (err) {
      statusEl.textContent = String(err?.message || err).slice(0, 80);
    } finally {
      scheduler.markExtractEnd(Date.now(), { advanceInterval: extractSucceeded });
      syncToggleUi();
      saveState();
    }
  }

  async function onTick() {
    const tick = updateCountdown();
    if (tick.action === "extract") await runExtract();
    else if (scheduler.getState().running && !isPageReady()) {
      const failed = isPageFailed();
      previewEl.textContent = failed
        ? "Bet365 não exibiu o jogo. Recarregue a página (F5)."
        : "Aguardando jogo carregar…";
      syncToggleUi({ failed, awaitingPage: !failed });
    }
  }

  ball.addEventListener("pointerdown", (ev) => {
    drag = {
      pointerId: ev.pointerId,
      offsetX: ev.clientX - root.offsetLeft,
      offsetY: ev.clientY - root.offsetTop,
    };
    ball.setPointerCapture(ev.pointerId);
  });

  ball.addEventListener("pointermove", (ev) => {
    if (!drag || drag.pointerId !== ev.pointerId) return;
    applyPosition({
      x: ev.clientX - drag.offsetX,
      y: ev.clientY - drag.offsetY,
    });
  });

  const endDrag = (ev) => {
    if (!drag || drag.pointerId !== ev.pointerId) return;
    drag = null;
    saveState();
  };
  ball.addEventListener("pointerup", endDrag);
  ball.addEventListener("pointercancel", endDrag);

  toggleBtn.addEventListener("click", () => {
    scheduler.setIntervalInput(intervalInput.value);
    if (scheduler.getState().running) {
      scheduler.stop();
    } else {
      scheduler.start(Date.now());
    }
    syncToggleUi();
    saveState();
    onTick();
  });

  intervalInput.addEventListener("change", () => {
    scheduler.setIntervalInput(intervalInput.value);
    saveState();
  });

  zipBtn.addEventListener("click", async () => {
    if (!lastData) {
      statusEl.textContent = "Sem dados";
      return;
    }
    try {
      statusEl.textContent = "ZIP…";
      await downloadZip(lastData);
      statusEl.textContent = "ZIP ok";
    } catch (err) {
      statusEl.textContent = String(err?.message || err).slice(0, 80);
    }
  });

  window.addEventListener("resize", () => {
    const rect = root.getBoundingClientRect();
    applyPosition({ x: rect.left, y: rect.top });
  });

  document.documentElement.appendChild(root);
  restoreState();
  syncToggleUi();
  tickTimer = window.setInterval(onTick, 1000);
  onTick();

  return {
    root,
    scheduler,
    destroy() {
      if (tickTimer) window.clearInterval(tickTimer);
      root.remove();
    },
  };
}


  function bootExtractPlayer() {
    if (window !== window.top) return;
    mountExtractPlayer({ buildData, version: VERSION });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootExtractPlayer, { once: true });
  } else {
    bootExtractPlayer();
  }
})();
