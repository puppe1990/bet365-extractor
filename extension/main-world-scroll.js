export async function mainWorldMarketScrollFunc(steps = 10) {
  const MARKET_CATEGORY_TABS = [
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

  const MARKET_CATEGORY_TABS_VISIT = [
    "Popular",
    "Todos",
    "Jogador",
    "Gols",
    "Escanteios/Cartões",
    "Instantâneas",
  ];

  const PREMATCH_MARKET_TABS_VISIT = [
    "Popular",
    "Escanteios",
    "Gols",
    "Jogador a Marcar",
    "Handicap",
    "Odds Asiáticas",
  ];

  const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
  const MARKET_TAB_CLICK_DELAY_MS = 280;
  const MARKET_TAB_BAND_TOP_PX = 560;
  const MARKET_TAB_BAND_TOP_RATIO = 0.55;
  const PREMATCH_MARKET_TAB_BAND_TOP_PX = 600;
  const PREMATCH_MARKET_TAB_BAND_TOP_RATIO = 0.62;
  const MARKET_TAB_LEFT_COLUMN_RATIO = 0.78;
  const MARKET_TAB_LEAF_MAX_TEXT_LEN = 40;

  const MARKET_TAB_CONTAINER_SELECTORS = [
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

  const MARKET_TAB_LEAF_SELECTORS = [
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

  function normalizeMarketTabLabel(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMarketCategoryTabLabel(text) {
    const s = normalizeMarketTabLabel(text);
    if (!s || s.length > 40) return false;
    return TAB_PATTERNS.some((re) => re.test(s));
  }

  function marketCategoryTabKey(text) {
    const s = normalizeMarketTabLabel(text);
    const idx = TAB_PATTERNS.findIndex((re) => re.test(s));
    return idx >= 0 ? MARKET_CATEGORY_TABS[idx] : null;
  }

  function resolveMarketTabPageMode(pageUrl = "") {
    const hash = String(pageUrl).includes("#")
      ? String(pageUrl).split("#")[1] || ""
      : String(pageUrl);
    if (/#\/IP\/EV\d+/i.test(`#${hash}`) || /EV\d{8,}/i.test(hash)) return "live";
    if (/\/E\d{6,}\b/i.test(hash)) return "prematch";
    return "auto";
  }

  function marketTabsVisitList(pageMode = "auto") {
    return pageMode === "prematch" ? PREMATCH_MARKET_TABS_VISIT : MARKET_CATEGORY_TABS_VISIT;
  }

  function marketTabTopLimit(innerHeight = 800, pageMode = "auto") {
    const prematch = pageMode === "prematch";
    const cap = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_PX : MARKET_TAB_BAND_TOP_PX;
    const ratio = prematch ? PREMATCH_MARKET_TAB_BAND_TOP_RATIO : MARKET_TAB_BAND_TOP_RATIO;
    return Math.min(cap, innerHeight * ratio);
  }

  function isInLeftMarketColumn(rect, innerWidth = 1200) {
    if (!rect) return false;
    return rect.left >= -8 && rect.left <= innerWidth * MARKET_TAB_LEFT_COLUMN_RATIO;
  }

  function isInMarketTabBand(rect, innerHeight = 800, innerWidth = 1200, pageMode = "auto") {
    if (!rect || rect.width < 12 || rect.height < 6) return false;
    if (!isInLeftMarketColumn(rect, innerWidth)) return false;
    const topLimit = marketTabTopLimit(innerHeight, pageMode);
    return rect.top >= -8 && rect.top <= topLimit;
  }

  function gluedMarketTabCount(text) {
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

  function isGluedMarketTabContainer(text) {
    const s = normalizeMarketTabLabel(text);
    if (!s) return false;
    if (TAB_PATTERNS.some((re) => re.test(s))) return false;
    return gluedMarketTabCount(s) > 1;
  }

  function scoreMarketTabBarContainer(text) {
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

  function isMarketTabLeafText(text) {
    const s = normalizeMarketTabLabel(text);
    if (!s || s.length > MARKET_TAB_LEAF_MAX_TEXT_LEN) return false;
    return Boolean(marketCategoryTabKey(s));
  }

  function isInsideScoredMarketTabContainer(rect, containerRects = []) {
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

  function leafMarketTabKey(text, childTexts = []) {
    const key = marketCategoryTabKey(text);
    if (!key || isGluedMarketTabContainer(text)) return null;
    const childKeys = childTexts
      .map((childText) => marketCategoryTabKey(childText))
      .filter(Boolean);
    if (childKeys.includes(key)) return null;
    return key;
  }

  function pickSmallestTabCandidates(candidates) {
    const byLabel = new Map();
    for (const tab of candidates) {
      const prev = byLabel.get(tab.label);
      if (!prev || tab.area < prev.area) byLabel.set(tab.label, tab);
    }
    return [...byLabel.values()];
  }

  function collectMarketTabCandidates(
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

  function isPlayerMarketTabKey(key) {
    return key === "Jogador" || key === "Jogador a Marcar";
  }

  function isCornerMarketTabKey(key) {
    return key === "Escanteios/Cartões" || key === "Escanteios";
  }

  const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function getRoots() {
    const roots = [];
    const seen = new Set();
    function walk(node, d = 0) {
      if (!node || d > 12 || seen.has(node)) return;
      seen.add(node);
      if (node.querySelectorAll) roots.push(node);
      node.querySelectorAll?.("iframe, frame").forEach((f) => {
        try {
          if (f.contentDocument) walk(f.contentDocument, d + 1);
        } catch (_) {}
      });
      node.querySelectorAll?.("*").forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot, d + 1);
      });
    }
    walk(document);
    return roots;
  }

  function queryDeep(sel) {
    const out = [];
    const seen = new Set();
    getRoots().forEach((r) => {
      r.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    });
    return out;
  }

  function getVisibleText() {
    const chunks = [];
    const seen = new Set();
    function walkDoc(doc, depth = 0) {
      if (!doc || depth > 12 || seen.has(doc)) return;
      seen.add(doc);
      try {
        const t = doc.documentElement?.innerText || doc.body?.innerText || "";
        if (t) chunks.push(t);
        doc.querySelectorAll("iframe, frame").forEach((f) => {
          try {
            if (f.contentDocument) walkDoc(f.contentDocument, depth + 1);
          } catch (_) {}
        });
      } catch (_) {}
    }
    walkDoc(document);
    document.querySelectorAll("*").forEach((el) => {
      try {
        if (el.shadowRoot) {
          const t = el.shadowRoot.innerText || "";
          if (t) chunks.push(t);
        }
      } catch (_) {}
    });
    return [...new Set(chunks)].join("\n---IFRAME---\n");
  }

  function isScrollable(el) {
    if (!el || el.scrollHeight <= el.clientHeight + 20) return false;
    try {
      const oy = getComputedStyle(el).overflowY;
      return oy === "auto" || oy === "scroll" || oy === "overlay";
    } catch (_) {
      return false;
    }
  }

  function collectTargets(root) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    push(root);
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (isScrollable(el)) push(el);
      });
    } catch (_) {}
    let parent = root.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      if (isScrollable(parent)) push(parent);
    }
    return out.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight) ||
        b.scrollHeight - a.scrollHeight
    );
  }

  function getMarketTabPageMode() {
    return resolveMarketTabPageMode(location.href);
  }

  function getMarketTabsVisitList() {
    return marketTabsVisitList(getMarketTabPageMode());
  }

  function normalizeLeafText(el) {
    return normalizeMarketTabLabel(el?.innerText || el?.textContent || "");
  }

  function fingerprint(text) {
    const playerMarkets = (text.match(/Jogador\s*-/gi) || []).length;
    const meetMarkets = (text.match(/Encontro\s*-/gi) || []).length;
    const fouls = (text.match(/Faltas Cometidas/gi) || []).length;
    const instant = (text.match(/APOSTAS INSTANTÂNEAS|Próximo Minuto/gi) || []).length;
    const corners = (text.match(/Escanteios\s*-/gi) || []).length;
    const scorers = (text.match(/Marcadores de Gol/gi) || []).length;
    return `${text.length}|${playerMarkets}|${meetMarkets}|${fouls}|${instant}|${corners}|${scorers}`;
  }

  function dispatchTabClick(el) {
    try {
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
  }

  function walkTabContainer(container, consider) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      consider(node);
      node = walker.nextNode();
    }
  }

  function collectMarketCategoryTabs() {
    const pageMode = getMarketTabPageMode();
    const visitList = getMarketTabsVisitList();
    const nodes = [];
    const seen = new Set();
    const containerRects = [];

    const pushNode = (el) => {
      try {
        const text = normalizeLeafText(el);
        const childTexts = [...(el?.children || [])].map((child) => normalizeLeafText(child));
        if (!isMarketTabLeafText(text) && !leafMarketTabKey(text, childTexts)) return;
        if (String(el.innerText || "").length > 80) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 4) return;
        const label = marketCategoryTabKey(text) || leafMarketTabKey(text, childTexts);
        if (!label) return;
        const dedupe = `${label}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        nodes.push({
          el,
          text,
          childTexts,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            bottom: rect.bottom,
            right: rect.right,
          },
        });
      } catch (_) {}
    };

    const containers = [];
    MARKET_TAB_CONTAINER_SELECTORS.forEach((sel) => {
      queryDeep(sel).forEach((el) => {
        const score = scoreMarketTabBarContainer(el.textContent || "");
        if (score >= 3) {
          containers.push({ el, score });
          try {
            const rect = el.getBoundingClientRect();
            containerRects.push({
              score,
              rect: {
                top: rect.top,
                left: rect.left,
                bottom: rect.bottom,
                right: rect.right,
              },
            });
          } catch (_) {}
        }
      });
    });
    containers.sort((a, b) => b.score - a.score);

    for (const { el } of containers.slice(0, 6)) {
      walkTabContainer(el, pushNode);
      if (nodes.length >= visitList.length) break;
    }

    if (nodes.length < 3) {
      for (const sel of MARKET_TAB_LEAF_SELECTORS) {
        queryDeep(sel).forEach(pushNode);
        if (nodes.length >= visitList.length) break;
      }
    }

    return collectMarketTabCandidates(
      nodes,
      window.innerHeight,
      window.innerWidth,
      pageMode,
      containerRects
    ).map((tab) => ({ ...tab, el: tab.el }));
  }

  async function scrollMarketTabBars() {
    const bars = [];
    queryDeep(
      "[class*='Classification'][class*='Scroll'], [class*='ClassificationRibbon'], [class*='HorizontalScroll']"
    ).forEach((bar) => bars.push(bar));

    for (const bar of [...new Set(bars)]) {
      try {
        bar.scrollLeft = bar.scrollWidth;
        await delay(40);
      } catch (_) {}
    }
  }

  async function scrollPlayerPropGrids(capture, startedAt) {
    const headers = queryDeep(
      "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
    ).filter((el) =>
      /Jogador\s*-|Jogador\/Contagem|Escanteios|Cart[oõ]es|Número de Cartões/i.test(
        norm(el.textContent)
      )
    );

    for (const header of headers.slice(0, 8)) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(90);
        capture();
      } catch (_) {}
    }

    const scrollRoots = [];
    ["[class*='EventViewDetailScroller']", "[class*='MarketGroups']"].forEach((sel) =>
      queryDeep(sel).forEach((el) => scrollRoots.push(el))
    );

    for (const root of [...new Set(scrollRoots)].slice(0, 1)) {
      const el = collectTargets(root)[0];
      if (!el) continue;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll < 20) continue;
      const step = Math.max(220, Math.ceil(maxScroll / 5));
      for (let pos = 0; pos <= maxScroll + step; pos += step) {
        if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
        el.scrollTop = Math.min(pos, maxScroll);
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(50);
        capture();
      }
    }
  }

  async function visitMarketCategoryTabs(capture) {
    const visited = [];
    const startedAt = Date.now();

    await scrollMarketTabBars();
    let tabs = collectMarketCategoryTabs();

    for (const key of getMarketTabsVisitList()) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      let tab = tabs.find((t) => t.label === key);
      if (!tab) {
        await scrollMarketTabBars();
        tabs = collectMarketCategoryTabs();
        tab = tabs.find((t) => t.label === key);
      }
      if (!tab) continue;
      try {
        tab.el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        dispatchTabClick(tab.el);
        visited.push(key);
        await delay(MARKET_TAB_CLICK_DELAY_MS);
        capture();
        if (isPlayerMarketTabKey(key) || isCornerMarketTabKey(key)) {
          await scrollPlayerPropGrids(capture, startedAt);
        }
      } catch (_) {}
    }

    return visited;
  }

  const snapshots = [];
  const seen = new Set();
  const capture = () => {
    const text = getVisibleText();
    const key = fingerprint(text);
    if (!seen.has(key)) {
      seen.add(key);
      snapshots.push(text);
    }
  };

  capture();
  const tabsFound = collectMarketCategoryTabs().length;
  const tabsVisited = await visitMarketCategoryTabs(capture);

  const roots = [];
  [
    "[class*='EventViewDetailScroller']",
    "[class*='MarketGroups']",
    "[class*='MarketBoard']",
    "[class*='ClassificationMarketGrid']",
    "[class*='CouponMarketGrid']",
    "[class*='IPMarketView']",
    "[class*='MarketGrid']",
  ].forEach((sel) => queryDeep(sel).forEach((el) => roots.push(el)));

  if (!roots.length) {
    queryDeep("*").forEach((el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width < 80 || rect.left > window.innerWidth * 0.62) return;
        if (!isScrollable(el)) return;
        roots.push(el);
      } catch (_) {}
    });
  }

  const uniqueRoots = [...new Set(roots)];
  let primary = null;
  const targets = [];
  const targetSeen = new Set();
  const originals = new Map();

  if (uniqueRoots.length) {
    uniqueRoots.forEach((root) => {
      collectTargets(root).forEach((el) => {
        if (targetSeen.has(el)) return;
        targetSeen.add(el);
        targets.push(el);
      });
    });
    if (targets.length) {
      primary = targets[0];
      targets.forEach((el) => originals.set(el, el.scrollTop));
    }
  }

  const scrollTarget = async (el) => {
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScroll < 20) return;
    const step = Math.max(180, Math.ceil(maxScroll / steps));
    for (let pos = 0; pos <= maxScroll + step; pos += step) {
      el.scrollTop = Math.min(pos, maxScroll);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(90);
      capture();
    }
  };

  for (const target of targets.slice(0, 3)) {
    await scrollTarget(target);
  }

  const marketHeaders = queryDeep(
    "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
  ).filter((el) =>
    /Jogador\s*-|Jogador\/Contagem|Encontro\s*-|Faltas|Assist|Escanteios|Cart[oõ]es|Número de Cartões/i.test(
      norm(el.textContent)
    )
  );

  for (const header of marketHeaders.slice(0, 18)) {
    try {
      header.scrollIntoView({ block: "center", behavior: "instant" });
      await delay(100);
      capture();
    } catch (_) {}
  }

  originals.forEach((top, el) => {
    el.scrollTop = top;
  });

  const playerMarkets = snapshots.reduce(
    (sum, text) => sum + (text.match(/Jogador\s*-/gi) || []).length,
    0
  );

  return {
    snapshots,
    scrollSteps: snapshots.length,
    container: primary ? String(primary.className || "scrollable").slice(0, 80) : null,
    playerMarkets,
    tabsVisited,
    tabsFound,
    world: "MAIN",
  };
}
