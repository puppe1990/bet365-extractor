function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

export const SIDE_PANEL_TAB_SCOPE_SELECTORS = [
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

export const SIDE_PANEL_TAB_LEAF_SELECTORS = [
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

export const SIDE_PANEL_TAB_LABEL_PATTERNS = {
  stats: [/^Estat\.?$/, /^Estatísticas?$/],
  playerStats: [/^Estatísticas de Jogador$/],
  timeline: [/^Cronologia$/],
  lineup: [/^Escalação$/],
};

export const SIDE_PANEL_TAB_BAND_LEFT_RATIO = 0.4;
export const SIDE_PANEL_TAB_BAND_RIGHT_RATIO = 0.98;

export function normalizeSidePanelTabLabel(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[›>]\s*$/, "")
    .trim();
}

export function sidePanelTabKeyFromText(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s || s.length > 40) return null;
  for (const [key, patterns] of Object.entries(SIDE_PANEL_TAB_LABEL_PATTERNS)) {
    if (patterns.some((re) => re.test(s))) return key;
  }
  return null;
}

export function isInSidePanelTabBand(rect, innerWidth = 1200) {
  if (!rect || rect.width < 10 || rect.height < 6) return false;
  return (
    rect.left >= innerWidth * SIDE_PANEL_TAB_BAND_LEFT_RATIO &&
    rect.left <= innerWidth * SIDE_PANEL_TAB_BAND_RIGHT_RATIO
  );
}

const SIDE_PANEL_DISCOVERY_LABELS = [
  "Estat.",
  "Estatísticas",
  "Cronologia",
  "Escalação",
  "Estatísticas de Jogador",
];

export function gluedSidePanelTabCount(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s) return 0;
  return SIDE_PANEL_DISCOVERY_LABELS.filter((label) => new RegExp(escapeRegExp(label), "i").test(s))
    .length;
}

export function scoreSidePanelTabBarContainer(text) {
  const count = gluedSidePanelTabCount(text);
  if (count < 2) return 0;
  let score = count * 2;
  if (/Estat\.?/i.test(text)) score += 2;
  if (/Cronologia/i.test(text)) score += 2;
  if (/Escalação/i.test(text)) score += 2;
  return score;
}

export function isGluedSidePanelTabContainer(text) {
  const s = normalizeSidePanelTabLabel(text);
  if (!s) return false;
  if (sidePanelTabKeyFromText(s)) return false;
  return gluedSidePanelTabCount(s) > 1;
}

export function leafSidePanelTabKey(text, childTexts = []) {
  const s = normalizeSidePanelTabLabel(text);
  const key = sidePanelTabKeyFromText(s);
  if (!key || isGluedSidePanelTabContainer(s)) return null;
  const childKeys = childTexts
    .map((childText) => sidePanelTabKeyFromText(childText))
    .filter(Boolean);
  if (childKeys.includes(key)) return null;
  return key;
}

export function pickSmallestSidePanelTabCandidates(candidates) {
  const byKey = new Map();
  for (const tab of candidates) {
    const prev = byKey.get(tab.key);
    if (!prev || tab.area < prev.area) byKey.set(tab.key, tab);
  }
  return [...byKey.values()];
}

export function collectSidePanelTabCandidates(nodes, innerWidth = 1200) {
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

export function sidePanelTabLabelRegex(key) {
  const patterns = SIDE_PANEL_TAB_LABEL_PATTERNS[key];
  if (!patterns?.length) return null;
  const source = patterns.map((re) => re.source).join("|");
  return new RegExp(`^(?:${source})$`, "i");
}
