import { extractStatsFromVisibleText, parseGluedStats } from "./bet365-parsers.js";
import {
  isInRelaxedSidePanelTabBand,
  isInSidePanelTabBand,
  looksLikeGoalScorersTabContent,
} from "./bet365-side-panel-tabs.js";

export const STATS_SUB_TAB_KEYS = [
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

export const STATS_SUB_TAB_LABELS = [
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

export const STATS_SUB_TAB_VISIT_BUDGET_MS = 12_000;
export const STATS_SUB_TAB_CLICK_DELAY_MS = 220;
export const STATS_SUB_TAB_LEAF_MAX_TEXT_LEN = 36;
export const STATS_SUB_TAB_SCROLL_FRACTIONS = [0, 0.33, 0.66, 1];

export const STATS_SUB_TAB_LEAF_SELECTORS = [
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

export const LIVE_STATS_SIGNAL_RE =
  /xG|Ataques Perigosos|% de Posse|Passes Chave|Goleiro\s*-\s*Defesas|Precisão dos Passes|Finalizações\s*\/\s*Chutes ao Gol/i;

export const MARKET_RIBBON_SIGNAL_RE =
  /Popular|Criar Aposta|Jogador a Marcar|Odds Asiáticas|Ver por|Mercado\b|Jogador \/ Últimos|SUBSTITUIÇÃO\+/i;

export const LIVE_STATS_PANEL_SCOPE_SELECTORS = [
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

export function looksLikeLiveStatsPanelText(text) {
  return LIVE_STATS_SIGNAL_RE.test(String(text || ""));
}

export function shouldTreatAsMarketRibbonNotStats(text) {
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

export function looksLikeMarketRibbonText(text) {
  return shouldTreatAsMarketRibbonNotStats(text);
}

export function scoreLiveStatsPanelRootText(text) {
  const s = String(text || "");
  if (!looksLikeLiveStatsPanelText(s)) return 0;
  if (shouldTreatAsMarketRibbonNotStats(s)) return 0;
  let score = 12 + scoreStatsSubTabBarContainer(s);
  if (/Estat\.|Tabela/i.test(s)) score += 4;
  if (/Marcadores|Escanteios|Cartões\/Faltas/i.test(s)) score += 2;
  return score;
}

export function normalizeStatsSubTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function statsSubTabKey(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (OUTROS_TAB_RE.test(s)) return "Outros";
  const idx = STATS_SUB_TAB_PATTERNS.findIndex((re) => re.test(s));
  return idx >= 0 ? STATS_SUB_TAB_LABELS[idx] : null;
}

export function statsSubTabKeyFromKey(key) {
  const idx = STATS_SUB_TAB_KEYS.indexOf(key);
  return idx >= 0 ? STATS_SUB_TAB_LABELS[idx] : null;
}

export function gluedStatsSubTabCount(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s) return 0;
  let count = STATS_SUB_TAB_LABELS.filter((label) =>
    new RegExp(escapeRegExp(label), "i").test(s)
  ).length;
  if (OUTROS_TAB_RE.test(s)) count += 1;
  return count;
}

export function scoreStatsSubTabBarContainer(text) {
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

export function isGluedStatsSubTabContainer(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s) return false;
  if (STATS_SUB_TAB_PATTERNS.some((re) => re.test(s)) || OUTROS_TAB_RE.test(s)) return false;
  return gluedStatsSubTabCount(s) > 1;
}

export function isStatsSubTabLeafText(text) {
  const s = normalizeStatsSubTabLabel(text);
  if (!s || s.length > STATS_SUB_TAB_LEAF_MAX_TEXT_LEN) return false;
  return Boolean(statsSubTabKey(s));
}

export function leafStatsSubTabKey(text, childTexts = []) {
  const s = normalizeStatsSubTabLabel(text);
  const key = statsSubTabKey(s);
  if (!key || isGluedStatsSubTabContainer(s)) return null;
  const childKeys = childTexts.map((childText) => statsSubTabKey(childText)).filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

export const SIDE_PANEL_STATS_TAB_MAP = {
  goalScorers: "marcadores",
  lateral: "escanteios",
};

export function looksLikeGoalScorersPanelText(text) {
  return looksLikeGoalScorersTabContent(text);
}

export function looksLikeLateralStatsPanelText(text) {
  const s = String(text || "");
  return /Escanteios/i.test(s) || (/Lateral/i.test(s) && /Laterais?/i.test(s));
}

export function ingestSidePanelTabStats(textByTab = {}, textBySubTab = {}, subTabClicks = {}) {
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

export function collectStatsSubTabCandidatesFromNodes(nodes, innerWidth = 1200, options = {}) {
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

export function mergeStatsSubTabTexts(textBySubTab = {}) {
  return STATS_SUB_TAB_KEYS.map((key) => textBySubTab[key])
    .filter(Boolean)
    .join("\n---STATS-SUBTAB---\n");
}

export function summarizeStatsSubTabCapture(textBySubTab = {}, subTabClicks = {}) {
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

export function extractStatsFromSubTabTexts(textBySubTab = {}, pageUrl = "") {
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
