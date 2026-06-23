export const MARKET_EXPAND_CLICK_DELAY_MS = 90;
export const MARKET_EXPAND_MAX_CLICKS = 250;
export const MARKET_EXPAND_SCROLL_STEPS = 14;
export const MARKET_EXPAND_PASSES = 6;

export function createExpandClickState() {
  return { clicked: new Set(), count: 0 };
}

export function canExpandMore(state, startedAt, budgetMs = 35_000) {
  if (!state) return true;
  if (state.count >= MARKET_EXPAND_MAX_CLICKS) return false;
  if (Date.now() - startedAt > budgetMs) return false;
  return true;
}

export const MARKET_GROUP_CONTAINER_SELECTORS = [
  "[class*='MarketGroup']",
  "[class*='CouponMarket']",
  "[class*='MarketGrid']",
  "[class*='MarketBoard']",
];

export const MARKET_GROUP_HEADER_SELECTORS = [
  "[class*='MarketGroupButton']",
  "[class*='MarketGroup'][class*='Header']",
  "[class*='MarketGroup'][class*='Button']",
];

export const MARKET_ODDS_SELECTORS = [
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

export function isMarketCaExpandText(text) {
  return /^CA$/i.test(normalize(text));
}

export function isMarketShowMoreText(text) {
  return /^Mostrar Mais$/i.test(normalize(text));
}

export function isMarketExpandControlText(text) {
  return isMarketCaExpandText(text) || isMarketShowMoreText(text);
}

export function isMarketGroupCollapsedHint({ ariaExpanded = null, className = "" } = {}) {
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

export function shouldClickMarketExpandControl(text, { collapsed = true } = {}) {
  if (isMarketShowMoreText(text)) return true;
  if (isMarketCaExpandText(text)) return collapsed;
  return false;
}

export function isLikelyMarketGroupHeaderText(text) {
  const s = normalize(text);
  if (!s || s.length < 4 || s.length > 90) return false;
  return /\b(?:Escanteios|Gols|Jogador|Cart[oõ]es|Handicap|Marcador|Total|Encontro|Partida|Chance|Resultado|Intervalo|Impedimento|Assist)\b/i.test(
    s
  );
}
