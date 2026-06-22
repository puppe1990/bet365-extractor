import { analyzeMarketScore, applyMarketScoreInference } from "./bet365-market-inference.js";
import { isBet365PreMatchUrl } from "./bet365-url.js";
import {
  matchCandidatesFromNetworkText,
  parseNetworkPayload,
  extractNetworkHints,
} from "./bet365-network-parse.js";
import { extractFromBet365WirePayload } from "./bet365-protocol-decode.js";

export const VERSION = "3.10.13";

export const JUNK_ODDS_SELECTIONS =
  /^(Mais de|Menos de|Exatamente|Nenhum|Tabela|gol$|CA$|A Qualquer Momento|Cronologia|Escalação|Estat\.?|Estatísticas de Jogador)$/i;

export const SKIP_ODDS_LINES =
  /^(CA|SUBSTITUIÇÃO\+|Mostrar Mais|Popular|Criar Aposta|Instantâneas|Todos|Ao-Vivo|Jogador\/Contagem|Para Marcar ou Dar Assistência|1°|Jogadores Titulares|Mercado Suspenso|\d+)$/i;

export const JUNK_ODDS_MARKETS =
  /^(Escalação|FINALIZAÇÕES|Parceiros|Estat\.|Cronologia|Tabela|Exibir\b|Resultados\b|Configurações|Idioma|Esportes|Notícias de Apostas)/i;

export const TIMELINE_LEAK_MARKET_RE = /^\d+°\s*(?:Goal|Gol|Escanteio|Impedimento|Cart[aã]o)/i;

export const TIMELINE_LEAK_SELECTION_RE = /\s-\s(?:Chute|Assist)$/i;

const PLAYER_SHORT_ODDS_NAME_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{0,24}$/;

export const LEGAL_FOOTER_MARKET_RE =
  /\b(CNPJ|Portaria\s+SPA|regulada e autorizada|Sede registrada|©\s*\d{4}|Você não deve utilizar|Jogue com responsabilidade)\b/i;

export const BETTING_MARKET_HINTS =
  /\b(Gol|Gols|Resultado|Chance|Empate|Intervalo|Handicap|Total|Marcador|Chutes|Cartões|Escanteio|Tempo|Aposta|Dupla|Partida|Asiátic)/i;

export const STAT_LABEL_RE =
  /^(Goleiro|Precisão|Finalizações|Ataques|Ataques Perigosos|% de Posse|xG|Áreas de Ação|Passes Chave|Cruzamentos|Escanteios|Impedimentos|Defesas|Posse)\b/i;

export const STAT_LABELS = [
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

export function splitAtaquesPerigososGlued(digits) {
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

export const GLUED_STAT_RULES = [
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

export function normalize(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

export function isNum(v) {
  return v && /^[\d.,/%-]+$/.test(v);
}

export function isLikelyStatValue(v) {
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

export function toFlatBet365Text(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

export function parseGluedStats(text) {
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

export const GLUED_MATCH_RE =
  /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2})(\d{1,2})([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2}:\d{2})/g;

export const SPACED_SCOREBOARD_RE =
  /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,2})\s+(\d{1,2})\s+([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,3}:\d{2})/g;

export function parseClockMinutes(clock) {
  if (!clock) return -1;
  const m = String(clock).match(/^(\d{1,3}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : -1;
}

export function isWallClockTime(clock) {
  const m = String(clock || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  return hours <= 23 && mins <= 59;
}

export function isLikelyWallClock(clock, extractedAt) {
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

export function matchCandidateRank(candidate, options = {}) {
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

export function pickBestMatch(candidates, options = {}) {
  const valid = (candidates || []).filter((m) => m?.score != null);
  if (!valid.length) return null;
  return [...valid].sort(
    (a, b) => matchCandidateRank(b, options) - matchCandidateRank(a, options)
  )[0];
}

export function pickBestClock(clocks, extractedAt) {
  if (!clocks.length) return null;
  const filtered = clocks.filter((c) => !isLikelyWallClock(c.clock, extractedAt));
  const pool = filtered.length ? filtered : clocks;
  return pool.sort((a, b) => b.minutes - a.minutes)[0];
}

export function sanitizeMatchClock(match, extractedAt) {
  if (!match) return match;
  if (!isLikelyWallClock(match.clock, extractedAt)) return match;
  return { ...match, clock: null };
}

export function collectGluedMatches(text) {
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

export function collectSpacedScoreboardMatches(text) {
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
      status: flat.match(/Intervalo|INTERVALO|1T|2T|Ao Vivo/i)?.[0] || null,
    });
  }

  return matches;
}

export function parseHalftimeScore(text) {
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

export function parseMatchFromLines(text, extractedAt) {
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

export function mergeMatchCandidates(...args) {
  let options = {};
  if (isMergeOptions(args[args.length - 1])) {
    options = args.pop();
  }
  return sanitizeMatchClock(pickBestMatch(args.filter(Boolean), options), options.extractedAt);
}

export function filterMatchCandidatesForPage(candidates, pageUrl) {
  if (!isBet365PreMatchUrl(pageUrl)) return candidates || [];
  return [];
}

export function stripPreMatchScore(match, pageUrl) {
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

export function resolveMatchForPage(candidates, options = {}) {
  const { extractedAt, pageUrl } = options;
  const filtered = filterMatchCandidatesForPage(candidates, pageUrl);
  const merged = sanitizeMatchClock(pickBestMatch(filtered, { extractedAt }), extractedAt);
  if (isBet365PreMatchUrl(pageUrl)) {
    return stripPreMatchScore(merged, pageUrl) ?? { score: null, clock: null, preMatch: true };
  }
  return merged;
}

export function parseGluedMatch(text) {
  const best = pickBestMatch(collectGluedMatches(text));
  if (best) return best;
  return parseHalftimeScore(text);
}

const COMPETITION_RE =
  /(Copa do Mundo \d{4}|Champions League|Premier League|La Liga|Serie A|Bundesliga|Ligue 1)/i;

const DRAW_SELECTION_RE = /^(empate|draw|tie|x)$/i;

export function extractPageTextFromMerged(text) {
  const chunks = String(text || "").split(/---PAGE---/);
  if (chunks.length > 1) {
    return [...chunks.slice(1)].sort((a, b) => b.length - a.length)[0] || chunks[0];
  }
  return String(text || "").split(/---SIDE-TAB---/)[0] || String(text || "");
}

export function extractHeaderSlice(text, maxLines = 30) {
  return linesFromText(extractPageTextFromMerged(text)).slice(0, maxLines).join("\n");
}

export function parseVsLineStrict(text) {
  for (const line of linesFromText(text)) {
    const m = line.match(
      /^([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})\s+v\s+([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})$/i
    );
    if (!m) continue;
    return { homeTeam: normalize(m[1]), awayTeam: normalize(m[2]) };
  }
  return null;
}

export function extractCompetitionFromText(text) {
  return String(text || "").match(COMPETITION_RE)?.[0] || null;
}

export function extractTeamsFromResultadoFinalOdds(odds) {
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

export function resolveMatchTeams(match = {}, options = {}) {
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

export function enrichMatchFromHeader(text, match = {}) {
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

export function linesFromText(text) {
  return text
    .split(/\n|---IFRAME---/)
    .map(normalize)
    .filter(Boolean);
}

const MARKET_LINE_RE = /^(Mais de|Menos de|Jogador|Criar Aposta|Resultado Final|Ver$|Craques)/i;

export function extractStatsFromVisibleText(text, pageUrl) {
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

export function collectMatchCandidatesFromText(text, source, extractedAt, maxLen = 3500) {
  const candidates = [];
  if (!text || text.length > maxLen) return candidates;

  collectGluedMatches(text).forEach((m) => candidates.push({ ...m, source }));
  collectSpacedScoreboardMatches(text).forEach((m) => candidates.push({ ...m, source }));
  const fromLines = parseMatchFromLines(text, extractedAt);
  if (fromLines) candidates.push({ ...fromLines, source });

  return candidates;
}

export function looksLikeScoreboardText(text, homeTeam, awayTeam) {
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

export function extractMatchFromFrameChunks(frames, extractedAt, options = {}) {
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

export function extractMatchFromVisibleText(text) {
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

export function parseOdd(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function isLineValue(s) {
  return /^[+-]?\d+([.,]\d+)?$/.test(s);
}

export function isValidOdd(n) {
  return n >= 1.01 && n <= 501;
}

export function isValidSelection(s) {
  if (!s || s.length < 2) return false;
  if (isLineValue(s)) return false;
  if (/^\d+[.,]\d+$/.test(s)) return false;
  return /[A-Za-zÀ-ú]/.test(s);
}

export function isSkippedOddsLine(line) {
  return !line || SKIP_ODDS_LINES.test(line);
}

export function isStatLabel(text) {
  const n = normalize(text);
  if (!n) return false;
  if (STAT_LABELS.some((label) => n === label || n.includes(label))) return true;
  return STAT_LABEL_RE.test(n);
}

export function isValidTotalsLine(value) {
  if (!isLineValue(value)) return false;
  const n = parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 7.5;
}

export function isTimelineLeakMarket(market) {
  const s = normalize(market);
  if (!s) return false;
  if (/^\d+°\s*Gol$/i.test(s)) return false;
  if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
  if (/^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]*\s-\s(?:Chute|Assist)$/i.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

export function isTimelineLeakSelection(selection) {
  const s = normalize(selection);
  if (!s) return false;
  if (TIMELINE_LEAK_SELECTION_RE.test(s)) return true;
  if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

export function isLikelyTeamNameSelection(selection) {
  return /^(Argentina|Áustria|Austria|Uruguai|Brasil|França|France|Alemanha|Germany|Portugal|Inglaterra|England)$/i.test(
    normalize(selection)
  );
}

export function isLikelyScoreboardSelection(selection) {
  const s = normalize(selection);
  if (/Resultado Após|Primeira Parte|Intervalo/i.test(s)) return true;
  return /\d+\s*[-–]\s*\d+/.test(s);
}

export function isLikelyStatCountAsOdd(odd, market, selection) {
  if (!isPlayerPropMarket(market)) return false;
  if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 20) return false;
  const sel = normalize(selection);
  if (/\s-\s\d{1,2}\+$/.test(sel)) return false;
  return /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(sel);
}

export function isLikelyMinuteAsOdd(odd, market, selection) {
  if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 120) return false;
  if (isTimelineLeakMarket(market) || isTimelineLeakSelection(selection)) return true;
  if (isLikelyTeamNameSelection(selection)) return true;
  if (isLikelyScoreboardSelection(selection)) return true;
  const sel = normalize(selection);
  if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && isTimelineLeakMarket(market)) return true;
  if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && /Escanteio/i.test(market || "")) return true;
  return false;
}

export function isJunkOddsMarket(market) {
  if (!market || market === "—" || market === "Mercado") return true;
  if (market.length > 55) return true;
  if (JUNK_ODDS_MARKETS.test(market)) return true;
  if (LEGAL_FOOTER_MARKET_RE.test(market)) return true;
  if (isStatLabel(market)) return true;
  if (isTimelineLeakMarket(market)) return true;
  return false;
}

export function isTeamGoalsMarket(market) {
  return / - Gols$/i.test(market || "");
}

export function isPlayerPropMarket(market) {
  return /^Jogador\s*-/i.test(market || "");
}

export function isJunkTeamGoalsSelection(market, selection) {
  if (!isTeamGoalsMarket(market)) return false;
  return !/^(Mais de|Menos de)\s+\d/.test(normalize(selection));
}

export function isJunkPlayerPropSelection(market, selection) {
  if (!isPlayerPropMarket(market)) return false;
  return /^(Mais de|Menos de)\s+/i.test(normalize(selection));
}

export function isPlayerGridColumnHeader(line) {
  const s = normalize(line);
  if (!s) return false;
  if (/^\d{1,2}\+$/.test(s)) return true;
  if (s === "1+") return true;
  return false;
}

export function normalizePlayerGridColumn(line) {
  const s = normalize(line);
  if (/^\d{1,2}\+$/.test(s)) return s;
  if (s === "1") return "1+";
  return s;
}

export function collectPlayerGridColumns(lines, start) {
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

export function isLikelyPlayerNameLine(line) {
  return (
    isValidSelection(line) &&
    /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(line) &&
    !isPlayerGridColumnHeader(line) &&
    !/^Jogador\b/i.test(line)
  );
}

export function consumePlayerPropRow(lines, start, columns, market, pushOdd) {
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

export function isJunkOddsSelection(selection) {
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
  if (/^(Mais de|Menos de)\s+/.test(s)) {
    const linePart = s.replace(/^(Mais de|Menos de)\s+/, "");
    return !isValidTotalsLine(linePart);
  }
  return false;
}

export function isLikelyBettingMarket(market) {
  if (isJunkOddsMarket(market)) return false;
  if (isTimelineLeakMarket(market)) return false;
  if (/^(Empate|Sim|Não|Nenhum)$/i.test(market)) return false;
  if (market.includes(" - ")) return true;
  if (/\s/.test(market)) return BETTING_MARKET_HINTS.test(market);
  return /^(Resultado|Partida|Chance|Total|Marcador|Handicap|Intervalo)/i.test(market);
}

export function isLikelyShirtNumberPair(selection, oddRaw, lines, oddIndex) {
  if (!/^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(selection)) return false;
  if (!/^\d{1,2}$/.test(String(oddRaw).trim())) return false;
  const n = parseInt(oddRaw, 10);
  if (n < 1 || n > 99) return false;
  const next = lines[oddIndex + 1];
  return Boolean(
    next && /^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(next) && !isValidOdd(parseOdd(next))
  );
}

export function isLikelyMarketHeader(line, lines, index) {
  if (isSkippedOddsLine(line)) return false;
  if (isTimelineLeakMarket(line)) return false;
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

export function parseOddsFromVisibleText(text) {
  const odds = [];
  const seen = new Set();
  const lines = linesFromText(text);
  let market = "—";
  let pendingLines = [];
  let playerNames = [];
  let playerGridColumns = [];
  let inPlayerGrid = false;

  function pushOdd(entry) {
    const { market: mkt, selection, odds: odd } = entry;
    if (!isLikelyBettingMarket(mkt)) return;
    if (!isValidOdd(odd)) return;
    if (JUNK_ODDS_SELECTIONS.test(selection)) return;
    if (isJunkTeamGoalsSelection(mkt, selection)) return;
    if (isJunkPlayerPropSelection(mkt, selection)) return;
    if (isJunkOddsSelection(selection)) return;
    if (isLikelyMinuteAsOdd(odd, mkt, selection)) return;
    if (isLikelyStatCountAsOdd(odd, mkt, selection)) return;
    const validSelection = isValidSelection(selection) || /^.+\s-\s\d{1,2}\+$/.test(selection);
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
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      (/^Jogador\s*-/i.test(line) && line.includes(" - ")) ||
      isLikelyMarketHeader(line, lines, i)
    ) {
      market = line;
      resetMarketContext();
      continue;
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

    if (isSkippedOddsLine(line)) continue;

    if (isLineValue(line) && market !== "—") {
      pendingLines.push(line);
      continue;
    }

    if (/^(Mais de|Menos de)$/i.test(line) && !isPlayerPropMarket(market)) {
      const direction = line;
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

export function cleanOdds(odds) {
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

export function mergeOdds(...lists) {
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

export function mergeStats(...lists) {
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

export function walkBet365Json(node, path, out) {
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

export function ingestNetworkLogEntry(entry, out, extractedAt) {
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

export function extractFromNetworkLog(networkLog, extractedAt) {
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

export function assessMatchConfidence(match, meta = {}) {
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

export function gatherMatchCandidates(options = {}) {
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

export function annotateCandidateRanks(candidates, extractedAt) {
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

export function buildClockDebug(candidates, extractedAt) {
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

export function buildSourceBreakdown(stats, odds) {
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

export function buildNetworkDebugSamples(networkLog, limit = 15) {
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

export function buildExtractionDebug({
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

export function finalizeMatchData(match, visibleText, meta, extractedAt, pageUrl, options = {}) {
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

export function finalizeMatchWithMarkets(
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

export { analyzeMarketScore, applyMarketScoreInference };
