export async function mainWorldMarketScrollFunc(steps = 10) {
  /* __MARKET_TABS__ */
  /* __MARKET_EXPAND__ */

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

    const minScore = marketTabContainerMinScore(pageMode);
    const containers = [];
    MARKET_TAB_CONTAINER_SELECTORS.forEach((sel) => {
      queryDeep(sel).forEach((el) => {
        const score = scoreMarketTabBarContainer(el.textContent || "");
        if (score >= minScore) {
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

    let tabs = collectMarketTabCandidates(
      nodes,
      window.innerHeight,
      window.innerWidth,
      pageMode,
      containerRects
    ).map((tab) => ({ ...tab, el: tab.el }));

    if (tabs.length < 3) {
      const scanNodes = [];
      const scanSeen = new Set();
      const topLimit = marketTabTopLimit(window.innerHeight, pageMode) + 100;
      for (const label of visitList) {
        queryDeep("button, [role='tab'], span, a, div, li").forEach((el) => {
          try {
            const text = normalizeMarketTabLabel(el.textContent || "");
            if (!isExactMarketTabLabel(text, label)) return;
            if (String(el.innerText || "").length > 60) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 12 || rect.height < 6) return;
            if (!isInLeftMarketColumn(rect, window.innerWidth)) return;
            if (rect.top < -20 || rect.top > topLimit) return;
            const dedupe = `${label}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
            if (scanSeen.has(dedupe)) return;
            scanSeen.add(dedupe);
            scanNodes.push({
              el,
              text,
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
        });
      }
      const scanned = pickMarketTabNodesByLabel(scanNodes, visitList).map((tab) => ({
        ...tab,
        el: tab.el,
      }));
      if (scanned.length > tabs.length) tabs = scanned;
    }

    return tabs;
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

  function resolveMarketGroupContainer(el) {
    if (!el) return null;
    for (const sel of MARKET_GROUP_CONTAINER_SELECTORS) {
      const hit = el.closest?.(sel);
      if (hit) return hit;
    }
    return el.parentElement?.parentElement || el.parentElement || null;
  }

  function resolveMarketGroupHeader(container) {
    if (!container) return null;
    for (const sel of MARKET_GROUP_HEADER_SELECTORS) {
      const hit = container.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }

  function elementIsVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 2 &&
        rect.height > 2 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      );
    } catch (_) {
      return false;
    }
  }

  function marketGroupHasVisibleOdds(container) {
    if (!container) return false;
    for (const sel of MARKET_ODDS_SELECTORS) {
      const nodes = container.querySelectorAll(sel);
      for (const node of nodes) {
        if (elementIsVisible(node)) return true;
      }
    }
    const lines = (container.innerText || "").split("\n").map(norm).filter(Boolean);
    return lines.some((line) => /^\d+[.,]\d{1,3}$/.test(line));
  }

  function isCollapsedMarketGroup(container) {
    if (!container) return false;
    const header = resolveMarketGroupHeader(container) || container;
    const ariaExpanded =
      header.getAttribute?.("aria-expanded") ?? container.getAttribute?.("aria-expanded");
    if (
      isMarketGroupCollapsedHint({
        ariaExpanded,
        className: `${container.className || ""} ${header.className || ""}`,
      })
    ) {
      return true;
    }
    return !marketGroupHasVisibleOdds(container);
  }

  function collectExpandClickTargets() {
    const targets = [];
    const seen = new Set();

    const pushTarget = (el, key, collapsed) => {
      if (!el || seen.has(key)) return;
      try {
        const rect = el.getBoundingClientRect();
        if (!isInLeftMarketColumn(rect, window.innerWidth)) return;
        if (rect.width < 6 || rect.height < 4) return;
      } catch (_) {
        return;
      }
      seen.add(key);
      targets.push({ el, key, collapsed });
    };

    queryDeep(
      [
        ...MARKET_GROUP_HEADER_SELECTORS,
        "[class*='MarketGroup'] *",
        "[class*='CouponMarket'] *",
        "button",
        "[role='button']",
        "span",
        "a",
        "div",
      ].join(", ")
    ).forEach((el) => {
      const text = norm(el.textContent || "");
      if (!text) return;

      if (isMarketShowMoreText(text)) {
        const rect = el.getBoundingClientRect?.();
        pushTarget(el, `more|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`, true);
        return;
      }

      if (!isMarketCaExpandText(text) || text.length > 4) return;
      const container = resolveMarketGroupContainer(el);
      const collapsed = isCollapsedMarketGroup(container);
      if (!shouldClickMarketExpandControl("CA", { collapsed })) return;
      const clickEl =
        el.closest(
          "[class*='MarketGroupButton'], [class*='MarketGroup'][class*='Header'], [role='button'], button"
        ) || el;
      const rect = clickEl.getBoundingClientRect?.();
      pushTarget(
        clickEl,
        `ca|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`,
        collapsed
      );
    });

    queryDeep(MARKET_GROUP_HEADER_SELECTORS.join(", ")).forEach((header) => {
      const text = norm(header.textContent || "");
      if (!isLikelyMarketGroupHeaderText(text)) return;
      const container = resolveMarketGroupContainer(header);
      if (!isCollapsedMarketGroup(container)) return;
      const rect = header.getBoundingClientRect?.();
      pushTarget(header, `hdr|${Math.round(rect?.top || 0)}|${Math.round(rect?.left || 0)}`, true);
    });

    return targets;
  }

  async function expandCollapsedMarkets(capture, startedAt, clickState = null) {
    const clicked = clickState?.clicked ?? new Set();
    let expandClicked = 0;

    for (let pass = 0; pass < MARKET_EXPAND_PASSES; pass++) {
      if (!canExpandMore(clickState ?? { count: expandClicked, clicked }, startedAt)) break;
      const targets = collectExpandClickTargets().sort((a, b) => {
        const rank = (key) => (key.startsWith("more|") ? 2 : key.startsWith("ca|") ? 0 : 1);
        return rank(a.key) - rank(b.key);
      });
      let passClicks = 0;
      for (const target of targets) {
        if (!canExpandMore(clickState ?? { count: expandClicked, clicked }, startedAt)) break;
        if (clicked.has(target.key)) continue;
        clicked.add(target.key);
        try {
          target.el.scrollIntoView({ block: "center", behavior: "instant" });
          dispatchTabClick(target.el);
          expandClicked++;
          passClicks++;
          if (clickState) clickState.count++;
          await delay(MARKET_EXPAND_CLICK_DELAY_MS);
          capture();
        } catch (_) {}
      }
      if (!passClicks) break;
    }

    return expandClicked;
  }

  async function scrollTargetWithExpand(el, capture, startedAt, clickState, steps) {
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScroll < 20) return;
    const step = Math.max(
      140,
      Math.ceil(maxScroll / Math.max(MARKET_EXPAND_SCROLL_STEPS, steps || 10))
    );
    for (let pos = 0; pos <= maxScroll + step; pos += step) {
      if (!canExpandMore(clickState, startedAt)) break;
      el.scrollTop = Math.min(pos, maxScroll);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(70);
      capture();
      await expandCollapsedMarkets(capture, startedAt, clickState);
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

  async function visitMarketCategoryTabs(capture, clickState = null) {
    const visited = [];
    const startedAt = Date.now();
    const state = clickState ?? createExpandClickState();

    await scrollMarketTabBars();
    let tabs = collectMarketCategoryTabs();

    for (const key of getMarketTabsVisitList()) {
      if (!canExpandMore(state, startedAt)) break;
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
        await scrollPlayerPropGrids(capture, startedAt);
        await expandCollapsedMarkets(capture, startedAt, state);
        if (isPlayerMarketTabKey(key) || isCornerMarketTabKey(key)) {
          await scrollPlayerPropGrids(capture, startedAt);
          await expandCollapsedMarkets(capture, startedAt, state);
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
  const startedAt = Date.now();
  const clickState = createExpandClickState();
  const tabsFound = collectMarketCategoryTabs().length;
  const tabsVisited = await visitMarketCategoryTabs(capture, clickState);

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
    await scrollTargetWithExpand(target, capture, startedAt, clickState, steps);
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

  await expandCollapsedMarkets(capture, startedAt, clickState);

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
    expandClicked: clickState.count,
    world: "MAIN",
  };
}
