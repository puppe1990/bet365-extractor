export async function mainWorldMarketScrollFunc(steps = 10) {
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

  const MARKET_CATEGORY_TABS = [
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
  const MARKET_CATEGORY_TABS_VISIT = [
    "Popular",
    "Jogador",
    "Gols",
    "Escanteios/Cartões",
    "Instantâneas",
  ];
  const MARKET_TAB_VISIT_BUDGET_MS = 10_000;
  const MARKET_TAB_CLICK_DELAY_MS = 280;

  function tabKey(label) {
    const s = norm(label);
    return MARKET_CATEGORY_TABS.find((t) => new RegExp(`^${t}$`, "i").test(s)) || null;
  }

  function gluedTabCount(text) {
    const s = norm(text);
    if (!s) return 0;
    return MARKET_CATEGORY_TABS.filter((label) =>
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`), "i").test(s)
    ).length;
  }

  function isGluedTabContainer(text) {
    return gluedTabCount(text) > 1;
  }

  function scoreTabBarContainer(text) {
    const count = gluedTabCount(text);
    if (count < 3) return 0;
    let score = count;
    if (/Popular/i.test(text)) score += 2;
    if (/Jogador/i.test(text)) score += 2;
    if (/Gols/i.test(text)) score += 1;
    if (/Instant/i.test(text)) score += 1;
    return score;
  }

  function leafTabKey(el) {
    const text = norm(el?.innerText || el?.textContent || "");
    const key = tabKey(text);
    if (!key || isGluedTabContainer(text)) return null;
    const childKeys = [...(el?.children || [])]
      .map((child) => tabKey(norm(child.innerText || child.textContent || "")))
      .filter(Boolean);
    if (childKeys.includes(key)) return null;
    return key;
  }

  function tabTopLimit() {
    return Math.min(480, window.innerHeight * 0.42);
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

  function isInMarketTabBand(rect) {
    if (!rect || rect.width < 12 || rect.height < 6) return false;
    const topLimit = tabTopLimit();
    return (
      rect.top >= -8 &&
      rect.top <= topLimit &&
      rect.left >= 0 &&
      rect.left <= window.innerWidth * 0.85
    );
  }

  function dispatchTabClick(el) {
    try {
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
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
    const candidates = [];
    const seen = new Set();

    const consider = (el) => {
      try {
        const key = leafTabKey(el);
        if (!key || seen.has(key)) return;
        const rect = el.getBoundingClientRect();
        if (!isInMarketTabBand(rect)) return;
        seen.add(key);
        candidates.push({ el, label: key, area: rect.width * rect.height });
      } catch (_) {}
    };

    const containers = [];
    queryDeep(
      "[class*='Classification'], [class*='Ribbon'], [class*='MarketFilter'], [class*='CouponClassification']"
    ).forEach((el) => {
      const score = scoreTabBarContainer(el.textContent || "");
      if (score >= 5) containers.push({ el, score });
    });
    containers.sort((a, b) => b.score - a.score);

    for (const { el } of containers.slice(0, 3)) {
      walkTabContainer(el, consider);
      if (candidates.length >= MARKET_CATEGORY_TABS_VISIT.length) break;
    }

    if (candidates.length < 3) {
      const selectors = [
        "[class*='Scroller'] [class*='Item']",
        "[class*='Scroller'] button",
        "[class*='Scroller'] [role='tab']",
        "[class*='Classification'] *",
        "button",
        "[role='tab']",
      ];
      for (const sel of selectors) {
        queryDeep(sel).forEach(consider);
        if (candidates.length >= MARKET_CATEGORY_TABS_VISIT.length) break;
      }
    }

    const byLabel = new Map();
    candidates.forEach((tab) => {
      const prev = byLabel.get(tab.label);
      if (!prev || tab.area < prev.area) byLabel.set(tab.label, tab);
    });
    return [...byLabel.values()];
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
    ).filter((el) => /Jogador\s*-|Jogador\/Contagem/i.test(norm(el.textContent)));

    for (const header of headers.slice(0, 8)) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(90);
        capture();
      } catch (_) {}
    }

    const scrollRoots = [];
    [
      "[class*='EventViewDetailScroller']",
      "[class*='MarketGroups']",
    ].forEach((sel) => queryDeep(sel).forEach((el) => scrollRoots.push(el)));

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

    for (const key of MARKET_CATEGORY_TABS_VISIT) {
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
        if (key === "Jogador") {
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
    /Jogador\s*-|Jogador\/Contagem|Encontro\s*-|Faltas|Assist/i.test(norm(el.textContent))
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