export const MARKET_CATEGORY_TABS = [
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

export const MARKET_CATEGORY_TABS_VISIT = [
  "Popular",
  "Todos",
  "Jogador",
  "Gols",
  "Escanteios/Cartões",
  "Instantâneas",
];

export const PREMATCH_MARKET_TABS_VISIT = [
  "Popular",
  "Escanteios",
  "Gols",
  "Jogador a Marcar",
  "Handicap",
  "Odds Asiáticas",
];

export const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
export const MARKET_TAB_CLICK_DELAY_MS = 280;
export const MARKET_TAB_BAND_TOP_PX = 560;
export const MARKET_TAB_BAND_TOP_RATIO = 0.55;
export const PREMATCH_MARKET_TAB_BAND_TOP_PX = 600;
export const PREMATCH_MARKET_TAB_BAND_TOP_RATIO = 0.62;
export const MARKET_TAB_LEFT_COLUMN_RATIO = 0.78;
export const MARKET_TAB_LEAF_MAX_TEXT_LEN = 40;

export const MARKET_TAB_CONTAINER_SELECTORS = [
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

export const MARKET_TAB_LEAF_SELECTORS = [
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
  if (/Escanteios\/Cartões/i.test(text)) score += 2;
  if (/\bEscanteios\b/i.test(text)) score += 2;
  if (/\bTodos\b/i.test(text)) score += 2;
  if (/Criar Aposta/i.test(text)) score += 1;
  return score;
}

export function isMarketTabLeafText(text) {
  const s = normalizeMarketTabLabel(text);
  if (!s || s.length > MARKET_TAB_LEAF_MAX_TEXT_LEN) return false;
  return Boolean(marketCategoryTabKey(s));
}

export function isInsideScoredMarketTabContainer(rect, containerRects = []) {
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

export function isPlayerMarketTabKey(key) {
  return key === "Jogador" || key === "Jogador a Marcar";
}

export function isCornerMarketTabKey(key) {
  return key === "Escanteios/Cartões" || key === "Escanteios";
}
