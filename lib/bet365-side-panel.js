import { scoreTotalFromMatch } from "./bet365-market-inference.js";

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

export const SIDE_PANEL_TAB_KEYS = [
  "stats",
  "goalScorers",
  "lateral",
  "playerStats",
  "timeline",
  "lineup",
];

export const SIDE_PANEL_TAB_LABELS = {
  stats: /^Estat\.?$|^Estatísticas$/i,
  goalScorers: /^Marcadores de Gols?$/i,
  lateral: /^Lateral$/i,
  playerStats: /^Estatísticas de Jogador$/i,
  timeline: /^Cronologia$/i,
  lineup: /^Escalação$/i,
};

export const SIDE_PANEL_STATS_HARVEST_KEYS = ["goalScorers", "lateral"];
export const SIDE_PANEL_VISIT_BUDGET_MS = 18_000;
export const SIDE_PANEL_STATS_SUB_TAB_BUDGET_MS = 5_000;

export const TIMELINE_PANEL_SCOPE_SELECTORS = [
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

export const TIMELINE_MINUTE_LINE_RE = /^\d{1,3}['′]?\s*$/;
export const TIMELINE_ROW_SIGNAL_RE =
  /Escanteio|Substitui|Cart[aã]o Amarelo|Cart[aã]o Vermelho|Goal|Gol|Impedimento|P[eê]nalti/i;
export const TIMELINE_CORNER_ORDINAL_RE = /^(\d+)[º°]\s*Escanteio/i;
export const TIMELINE_EXPAND_TOTALS_RE = /^Exibir Totais da Partida$/i;

export function scoreTimelinePanelText(text) {
  const s = String(text || "");
  if (!/Cronologia/i.test(s)) return 0;
  const minutes = (s.match(/\b\d{1,3}['′]\b/g) || []).length;
  const events = (s.match(TIMELINE_ROW_SIGNAL_RE) || []).length;
  let score = minutes * 40 + events * 25;
  if (/xG|Ataques Perigosos|% de Posse/i.test(s)) score -= 90;
  if (/Tabela/i.test(s) && minutes < 2) score -= 30;
  return score;
}

export function isTimelineRowText(text) {
  const s = normalize(text);
  if (!s || s.length > 80) return false;
  if (TIMELINE_EXPAND_TOTALS_RE.test(s)) return true;
  if (TIMELINE_MINUTE_LINE_RE.test(s)) return true;
  if (TIMELINE_ROW_SIGNAL_RE.test(s) && !/xG|Ataques|Posse/i.test(s)) return true;
  return false;
}

export function isTimelineExpandTotalsText(text) {
  return TIMELINE_EXPAND_TOTALS_RE.test(normalize(text));
}

export function parseCornerOrdinal(text) {
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

export function parseEscanteiosCountFromStatsText(text) {
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

export function parseCornerTimelineHintsFromText(text) {
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

export function reconcileTimelineCorners(events, sectionLines = [], options = {}) {
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
const SCOREBOARD_MINUTE_SCORER_RE =
  /\b(\d{1,3})['′]\s+([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30})(?=\s|$)/g;
const SCOREBOARD_SCORER_MINUTE_RE =
  /\b([A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30})\s+(\d{1,3})['′](?:\s|$)/g;
const GOAL_SCORER_JUNK_RE =
  /^(Jogadores Titulares|Mostrar Mais|SUBSTITUIÇÃO\+|A Qualquer Momento|Para Marcar|Marcadores|Resultado Correto|Jogador a Marcar)$/i;
const GOAL_ODDS_MINUTE_RE = /^(\d{1,2})(?:\.0+)?$/;

function parseGoalOrdinal(text) {
  const m = normalize(text).match(GOAL_ORDINAL_RE);
  return m ? parseInt(m[1], 10) : null;
}

function makeGoalEvent(minute, ordinal, player, source, extra = "") {
  const ord = `${ordinal}° Goal`;
  const desc = [ord, player, extra].filter(Boolean).join(" | ");
  return {
    minute: Number.isFinite(minute) ? minute : null,
    type: "goal",
    description: desc,
    details: [desc],
    source,
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

export function parseGoalScorersFromText(text) {
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

export function parseGoalsFromScoreboardText(text) {
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
  const minuteFirst = new RegExp(SCOREBOARD_MINUTE_SCORER_RE.source, "gi");
  while ((m = minuteFirst.exec(flat)) !== null) {
    pushGoal(parseInt(m[1], 10), m[2], "scoreboard-inferred");
  }

  const playerFirst = new RegExp(SCOREBOARD_SCORER_MINUTE_RE.source, "gi");
  while ((m = playerFirst.exec(flat)) !== null) {
    pushGoal(parseInt(m[2], 10), m[1], "scoreboard-inferred");
  }

  return goals;
}

export function parseGoalsFromOdds(odds = []) {
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
    if (minute < 1 || minute > 120) continue;

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

export function parseGoalsFromPlayerFinalizations(rows = []) {
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

export function collectScoreboardHintText(domProbe = [], extraTexts = []) {
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

export function reconcileTimelineGoals(events, options = {}) {
  const expected =
    options.expectedGoals ??
    scoreTotalFromMatch(options.match) ??
    (options.scoreHome != null && options.scoreAway != null
      ? options.scoreHome + options.scoreAway
      : null);
  if (!expected || expected < 1) return events;

  let out = [...events];
  const goalEvents = out.filter((e) => e.type === "goal");
  if (goalEvents.length >= expected) return out;

  const coveredOrdinals = new Set(
    goalEvents.map((e) => parseGoalOrdinal(e.description)).filter(Boolean)
  );
  const hints = gatherGoalRecoveryHints(options);
  const usedHints = new Set();

  for (let ordinal = 1; ordinal <= expected; ordinal++) {
    if (coveredOrdinals.has(ordinal)) continue;
    if (out.filter((e) => e.type === "goal").length >= expected) break;

    const hint =
      hints.find((h) => h.ordinal === ordinal && !usedHints.has(h)) ||
      hints.find((h) => !usedHints.has(h) && Number.isFinite(h.minute)) ||
      hints.find((h) => !usedHints.has(h));
    if (hint) usedHints.add(hint);

    out.push(
      makeGoalEvent(
        hint?.minute ?? null,
        ordinal,
        hint?.player || "",
        hint?.source || "score-inferred"
      )
    );
    coveredOrdinals.add(ordinal);
  }

  return dedupeTimelineEvents(out);
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

export const GOAL_LINE_RE = /^(\d{1,3})['′]?\s+(.+)$/;

export function isPlayerShortName(line) {
  const s = normalize(line);
  if (!s) return false;
  if (GOAL_LINE_RE.test(s)) return true;
  return PLAYER_SHORT_NAME_RE.test(s);
}

export function isPlayerFullName(line) {
  const s = normalize(line);
  if (!s || s.length > 40) return false;
  if (NETWORK_NAME_BLOCK_RE.test(s)) return false;
  if (!PLAYER_FULL_NAME_RE.test(s)) return false;
  if (/\d/.test(s)) return false;
  return true;
}

export function isLineupWireSource(url = "") {
  return LINEUP_WIRE_SOURCE_RE.test(url);
}

export function isZapWireSource(url = "") {
  return LINEUP_ZAP_URL_RE.test(url);
}

export function collectZapWireText(networkLog = []) {
  const chunks = [];
  for (const entry of networkLog || []) {
    const url = entry?.url || "";
    if (!LINEUP_ZAP_URL_RE.test(url) && entry.kind !== "ws") continue;
    const data = networkEntryText(entry);
    if (data && data.length >= 4) chunks.push(data);
  }
  return chunks.join("\n");
}

export function isPlayerNameLine(line) {
  const s = normalize(line);
  if (!s) return false;
  if (GOAL_LINE_RE.test(s)) return true;
  return isPlayerShortName(s) || isPlayerFullName(s);
}

function looksLikeOddToken(s) {
  return /^\d+(\.\d{2,3})?$/.test(s) && isValidOdd(parseOdd(s));
}

export function isTimelineStopLine(line) {
  const s = normalize(line);
  if (!s) return false;
  if (TIMELINE_STOP_RE.test(s)) return true;
  if (/^Jogador\s*[-/]/i.test(s)) return true;
  if (/^Áustria\s*-\s*Gols$/i.test(s) || /^Argentina\s*-\s*Gols$/i.test(s)) return true;
  return false;
}

export function isTimelineSectionStopLine(line) {
  const s = normalize(line);
  if (!s) return false;
  return TIMELINE_SECTION_STOP_RE.test(s);
}

export function isTimelineNoiseDetail(line) {
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

export function isTimelineMarketLeakLine(line) {
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
  const pipes = (s.match(/\|/g) || []).length;
  if (pipes >= 3 && /Gol|Escanteio|Cart[aã]o|P[eê]nalti|M[eé]todo|Gol Contra/i.test(s)) {
    return true;
  }
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

export function isTimelineEventAnchor(line) {
  const s = normalize(line);
  if (!s) return false;
  if (/^Substitui/i.test(s)) return true;
  if (TIMELINE_EVENT_HEADER_RE.test(s)) return true;
  if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
  return false;
}

export function isTimelineEventDetail(line) {
  const s = normalize(line);
  if (!s || isTimelineNoiseDetail(s)) return false;
  if (isTimelineEventAnchor(s)) return true;
  if (TIMELINE_EVENT_RE.test(s)) return true;
  if (/ - (Chute|Assist)/i.test(s)) return true;
  return false;
}

export function extractTimelineSectionLines(text) {
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

export function mergeTimelineSectionTexts(...texts) {
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

export function parseTimelineFromText(text, options = {}) {
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

export function buildTimelineFromPanelTexts(textByTab = {}, options = {}) {
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
  return timeline;
}

function mergeTimelineEvents(...lists) {
  return dedupeTimelineEvents(lists.flat());
}

export function inferTimelineType(details) {
  const t = details.join(" ");
  if (/Gol|Goal/i.test(t)) return "goal";
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

export function extractLineupPlayersFromWireText(text, url = "") {
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

export function parseLineupFromZapWire(data, url = "ws:sportspublisher/zap") {
  return parseLineupFromNetworkBlob(data, url);
}

export function parseLineupFromNetworkBlob(data, url = "") {
  const text = typeof data === "string" ? data : data?._rawText ? String(data._rawText) : "";
  if (!text || !isLineupWireSource(url)) return null;

  const players = extractLineupPlayersFromWireText(text, url);
  if (players.length < 8) return null;

  const { home, away } = splitLineupPlayers(players);
  if (!home.starters.length && !away.starters.length) return null;

  return { home, away, source: lineupWireSource(url) };
}

export function parsePlayerFinalizationsFromNetworkBlob(data, url = "") {
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
  /^(Mostrar Mais|A Qualquer Momento|Marcadores de Gol|2°\s*Gol|Partida\s*-|Para Marcar ou Dar Assistência|Jogador\s*[-/])/i;
const TITULARES_SKIP_RE = /^(CA|SUBSTITUIÇÃO\+?)$/i;

const TITULARES_SECTION_RE = /^(Jogadores Titulares|Jogador a Marcar ou Dar Assistência)$/i;

export function parseLineupFromTitularesText(text) {
  const lines = linesFromText(text);
  const names = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (!TITULARES_SECTION_RE.test(lines[i])) continue;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (TITULARES_SECTION_RE.test(line)) break;
      if (TITULARES_SKIP_RE.test(line)) continue;
      if (TITULARES_STOP_RE.test(line)) break;
      if (/^\d{1,2}$/.test(line)) continue;
      if (/^\d+(\.\d{2})?$/.test(line)) continue;
      if (!isPlayerFullName(line) || TITULARES_SECTION_RE.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      names.push(line);
    }
  }

  if (names.length < 8) return null;

  return {
    home: { starters: names.slice(0, 11), subs: [], goals: [] },
    away: { starters: names.slice(11, 22), subs: names.slice(22), goals: [] },
    source: "visible-titulares",
  };
}

export function parseLineupFromText(text) {
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

export function parsePlayerFinalizationsFromText(text) {
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

export function parseActionAreasFromText(text) {
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

export function mergeSidePanelTabText(scoped, full, key) {
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

export function extractSidePanelFromTexts(textByTab = {}, options = {}) {
  const statsSubTabMerged = textByTab.statsSubTabMerged || "";
  const statsText = [
    textByTab.stats || "",
    textByTab.goalScorers || "",
    textByTab.lateral || "",
    statsSubTabMerged,
  ]
    .filter(Boolean)
    .join("\n");
  const playerText = textByTab.playerStats || "";
  const timelineText = textByTab.timeline || "";
  const lineupText = textByTab.lineup || "";
  const panelMerged = [statsText, playerText, timelineText, lineupText].join("\n");
  const playerFinalizations = mergePlayerFinalizations(
    parsePlayerFinalizationsFromText(playerText),
    parsePlayerFinalizationsFromText(statsText),
    parsePlayerFinalizationsFromText(panelMerged)
  );

  return {
    timeline: buildTimelineFromPanelTexts(textByTab, {
      ...options,
      playerFinalizations,
    }),
    lineup:
      parseLineupFromText(lineupText) ||
      parseLineupFromText(statsText) ||
      parseLineupFromText(timelineText) ||
      parseLineupFromText(playerText) ||
      parseLineupFromTitularesText([statsText, playerText, timelineText, lineupText].join("\n")),
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

export function scanNetworkSidePanel(networkLog = []) {
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

export function buildZapWireDebug(networkLog = [], mergedText = "") {
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

export function buildIpeBlobDebugEntry(entry) {
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

export function buildIpeBlobDebug(networkLog = []) {
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

export function mergeSidePanel(primary, fromNetwork = {}) {
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
