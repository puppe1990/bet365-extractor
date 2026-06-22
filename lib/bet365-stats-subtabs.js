import { extractStatsFromVisibleText, parseGluedStats } from "./bet365-parsers.js";

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

export const STATS_SUB_TAB_VISIT_BUDGET_MS = 8000;
export const STATS_SUB_TAB_CLICK_DELAY_MS = 200;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

const STATS_SUB_TAB_PATTERNS = STATS_SUB_TAB_LABELS.map(
  (label) => new RegExp(`^${escapeRegExp(label)}$`, "i")
);

const OUTROS_TAB_RE = /^Outr(?:os)?(?:\s*[›>])?$/i;

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
  const count = gluedStatsSubTabCount(text);
  if (count < 3) return 0;
  let score = count;
  if (/Marcadores/i.test(text)) score += 2;
  if (/Chutes/i.test(text)) score += 2;
  if (/Escanteios/i.test(text)) score += 1;
  if (/Cartões\/Faltas/i.test(text)) score += 1;
  return score;
}

export function leafStatsSubTabKey(text, childTexts = []) {
  const key = statsSubTabKey(text);
  if (!key) return null;
  if (gluedStatsSubTabCount(text) > 1) return null;
  const childKeys = childTexts.map((childText) => statsSubTabKey(childText)).filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
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

    for (const row of extractStatsFromVisibleText(text, pageUrl)) {
      push({ ...row, subTab: key, source: `stats-subtab:${key}` });
    }
  }

  return stats;
}
