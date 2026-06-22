export const MARKET_CATEGORY_TABS = [
  "Popular",
  "Instantâneas",
  "Escanteios/Cartões",
  "Gols",
  "1º Tempo/2º Tempo",
  "Jogador",
  "Especiais",
  "Odds Asiáticas",
  "Escalações",
];

export const MARKET_CATEGORY_TABS_VISIT = [
  "Popular",
  "Jogador",
  "Gols",
  "Escanteios/Cartões",
  "Instantâneas",
];

export const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
export const MARKET_TAB_CLICK_DELAY_MS = 280;
export const MARKET_TAB_BAND_TOP_PX = 480;
export const MARKET_TAB_BAND_TOP_RATIO = 0.42;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

const TAB_PATTERNS = MARKET_CATEGORY_TABS.map(
  (label) => new RegExp(`^${escapeRegExp(label)}$`, "i")
);

export function normalizeMarketTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMarketCategoryTabLabel(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s || s.length > 40) return false;
  return TAB_PATTERNS.some((re) => re.test(s));
}

export function marketCategoryTabKey(text) {
  const s = normalizeMarketTabLabel(text);
  const idx = TAB_PATTERNS.findIndex((re) => re.test(s));
  return idx >= 0 ? MARKET_CATEGORY_TABS[idx] : null;
}

export function marketTabTopLimit(innerHeight = 800) {
  return Math.min(MARKET_TAB_BAND_TOP_PX, innerHeight * MARKET_TAB_BAND_TOP_RATIO);
}

export function isInMarketTabBand(rect, innerHeight = 800, innerWidth = 1200) {
  if (!rect || rect.width < 12 || rect.height < 6) return false;
  const topLimit = marketTabTopLimit(innerHeight);
  return rect.top >= -8 && rect.top <= topLimit && rect.left >= 0 && rect.left <= innerWidth * 0.85;
}

export function gluedMarketTabCount(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s) return 0;
  return MARKET_CATEGORY_TABS.filter((label) => new RegExp(escapeRegExp(label), "i").test(s))
    .length;
}

export function isGluedMarketTabContainer(text) {
  return gluedMarketTabCount(text) > 1;
}

export function scoreMarketTabBarContainer(text) {
  const count = gluedMarketTabCount(text);
  if (count < 3) return 0;
  let score = count;
  if (/Popular/i.test(text)) score += 2;
  if (/Jogador/i.test(text)) score += 2;
  if (/Gols/i.test(text)) score += 1;
  if (/Instant/i.test(text)) score += 1;
  return score;
}

export function leafMarketTabKey(text, childTexts = []) {
  const key = marketCategoryTabKey(text);
  if (!key || isGluedMarketTabContainer(text)) return null;
  const childKeys = childTexts.map((childText) => marketCategoryTabKey(childText)).filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

export function pickSmallestTabCandidates(candidates) {
  const byLabel = new Map();
  for (const tab of candidates) {
    const prev = byLabel.get(tab.label);
    if (!prev || tab.area < prev.area) byLabel.set(tab.label, tab);
  }
  return [...byLabel.values()];
}
