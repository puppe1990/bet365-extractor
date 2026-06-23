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
  goalScorers: [/^Marcadores de Gols?$/],
  lateral: [/^Lateral$/],
  playerStats: [/^Estatísticas de Jogador$/],
  timeline: [/^Cronologia$/],
  lineup: [/^Escalação$/],
};

export const SIDE_PANEL_TAB_BAND_LEFT_RATIO = 0.4;
export const SIDE_PANEL_TAB_BAND_RELAXED_LEFT_RATIO = 0.35;
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

export function isInSidePanelTabBand(
  rect,
  innerWidth = 1200,
  leftRatio = SIDE_PANEL_TAB_BAND_LEFT_RATIO
) {
  if (!rect || rect.width < 10 || rect.height < 6) return false;
  return (
    rect.left >= innerWidth * leftRatio && rect.left <= innerWidth * SIDE_PANEL_TAB_BAND_RIGHT_RATIO
  );
}

export function isInRelaxedSidePanelTabBand(rect, innerWidth = 1200) {
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

const SIDE_PANEL_PLAYER_LINE_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,30}$/;

export function looksLikeGoalScorersTabContent(text) {
  const s = String(text || "");
  if (!/Marcadores de Gols?/i.test(s)) return false;
  if (s.length > 12000) return false;
  if (/Jogadores Titulares/i.test(s) && !/\nMarcadores\n/i.test(s)) return false;
  if (/\nMarcadores\n/i.test(s) && /\d{1,3}['′]\s*$/m.test(s)) return true;
  if (/\n[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{1,28}\n\d{1,3}['′]\s*$/m.test(s)) return true;
  return false;
}

export function looksLikeLineupTabContent(text) {
  const s = String(text || "");
  if (!/Escalação/i.test(s)) return false;
  if (s.length > 12000) return false;
  const players = (s.match(SIDE_PANEL_PLAYER_LINE_RE) || []).length;
  return players >= 8 || /Suplentes/i.test(s);
}

export function looksLikeTimelineTabContent(text) {
  const s = String(text || "");
  if (!/Cronologia/i.test(s)) return false;
  if (s.length > 15000) return false;
  return (s.match(/\d{1,3}['′]/g) || []).length >= 2;
}

export function findBestScopedSidePanelText(texts, key) {
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

export function looksLikeLateralStatsPanelText(text) {
  const s = String(text || "");
  return /Escanteios/i.test(s) || (/Lateral/i.test(s) && /Laterais?/i.test(s));
}

export function scoreSidePanelTabContent(text, key) {
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
