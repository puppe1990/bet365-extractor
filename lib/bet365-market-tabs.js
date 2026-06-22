export const MARKET_CATEGORY_TABS = [
  "Popular",
  "Instantâneas",
  "Escanteios/Cartões",
  "Gols",
  "1º Tempo/2º Tempo",
  "Jogador",
  "Jogador a Marcar",
  "Especiais",
  "Odds Asiáticas",
  "Escalações",
  "Handicap",
  "Resultado",
  "Alternativas",
];

export const MARKET_CATEGORY_TABS_VISIT = [
  "Popular",
  "Jogador",
  "Gols",
  "Escanteios/Cartões",
  "Instantâneas",
];

export const PREMATCH_MARKET_TABS_VISIT = [
  "Popular",
  "Jogador a Marcar",
  "Gols",
  "Handicap",
  "Odds Asiáticas",
];

export const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
export const MARKET_TAB_CLICK_DELAY_MS = 280;
export const MARKET_TAB_BAND_TOP_PX = 480;
export const MARKET_TAB_BAND_TOP_RATIO = 0.42;
export const PREMATCH_MARKET_TAB_BAND_TOP_PX = 560;
export const PREMATCH_MARKET_TAB_BAND_TOP_RATIO = 0.58;
export const MARKET_TAB_LEFT_COLUMN_RATIO = 0.62;

export const MARKET_TAB_CONTAINER_SELECTORS = [
  "[class*='Classification']",
  "[class*='Ribbon']",
  "[class*='MarketFilter']",
  "[class*='CouponClassification']",
  "[class*='CouponPage']",
  "[class*='MarketCoupon']",
  "[class*='SlideScroller']",
  "[class*='FilterBar']",
];

export const MARKET_TAB_LEAF_SELECTORS = [
  "[class*='Scroller'] [class*='Item']",
  "[class*='Scroller'] button",
  "[class*='Scroller'] [role='tab']",
  "[class*='Classification'] *",
  "button",
  "[role='tab']",
];

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

export function resolveMarketTabPageMode(pageUrl = "") {
  const hash = String(pageUrl).includes("#")
    ? String(pageUrl).split("#")[1] || ""
    : String(pageUrl);
  if (/#\/IP\/EV\d+/i.test(`#${hash}`) || /EV\d{8,}/i.test(hash)) return "live";
  if (/\/E\d{6,}\b/i.test(hash)) return "prematch";
  return "auto";
}

export function marketTabsVisitList(pageMode = "auto") {
  return pageMode === "prematch" ? PREMATCH_MARKET_TABS_VISIT : MARKET_CATEGORY_TABS_VISIT;
}

export function marketTabTopLimit(innerHeight = 800, pageMode = "auto") {
  const prematch = pageMode === "prematch";
  const cap = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_PX : MARKET_TAB_BAND_TOP_PX;
  const ratio = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_RATIO : MARKET_TAB_BAND_TOP_RATIO;
  return Math.min(cap, innerHeight * ratio);
}

export function isInLeftMarketColumn(rect, innerWidth = 1200) {
  if (!rect) return false;
  return rect.left >= -8 && rect.left <= innerWidth * MARKET_TAB_LEFT_COLUMN_RATIO;
}

export function isInMarketTabBand(rect, innerHeight = 800, innerWidth = 1200, pageMode = "auto") {
  if (!rect || rect.width < 12 || rect.height < 6) return false;
  if (!isInLeftMarketColumn(rect, innerWidth)) return false;
  const topLimit = marketTabTopLimit(innerHeight, pageMode);
  return rect.top >= -8 && rect.top <= topLimit;
}

export function gluedMarketTabCount(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s) return 0;
  return MARKET_CATEGORY_TABS.filter((label) => new RegExp(escapeRegExp(label), "i").test(s))
    .length;
}

export function isGluedMarketTabContainer(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s) return false;
  if (TAB_PATTERNS.some((re) => re.test(s))) return false;
  return gluedMarketTabCount(s) > 1;
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

export function collectMarketTabCandidates(
  nodes,
  innerHeight = 800,
  innerWidth = 1200,
  pageMode = "auto"
) {
  const candidates = [];
  const seen = new Set();

  for (const node of nodes) {
    const text = normalizeMarketTabLabel(node.text);
    const key = leafMarketTabKey(
      text,
      (node.childTexts || []).map((childText) => normalizeMarketTabLabel(childText))
    );
    if (!key || seen.has(key)) continue;
    const rect = node.rect;
    if (!isInMarketTabBand(rect, innerHeight, innerWidth, pageMode)) continue;
    seen.add(key);
    candidates.push({
      label: key,
      area: (rect?.width || 0) * (rect?.height || 0),
      el: node.el ?? null,
    });
  }

  return pickSmallestTabCandidates(candidates);
}

export function isPlayerMarketTabKey(key) {
  return key === "Jogador" || key === "Jogador a Marcar";
}
