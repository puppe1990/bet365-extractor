// Bet365 Chrome Extension — content script (built from parsers + this template)
(function bet365ExtensionContent() {
  "use strict";

  if (window.__bet365ExtractorReady) return;
  window.__bet365ExtractorReady = true;

  /* __PARSERS__ */

  /* __NETWORK__ */

  /* __FRAMES__ */

  function getAllVisibleText() {
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

    collectFrameWalkTexts().forEach((f) => {
      if (f.text) chunks.push(f.text);
    });

    document.querySelectorAll("*").forEach((el) => {
      try {
        if (el.shadowRoot) {
          const t = el.shadowRoot.innerText || "";
          if (t) chunks.push(t);
          el.shadowRoot.querySelectorAll("iframe, frame").forEach((f) => {
            try {
              if (f.contentDocument) walkDoc(f.contentDocument, 0);
            } catch (_) {}
          });
        }
      } catch (_) {}
    });

    return [...new Set(chunks)].join("\n---IFRAME---\n");
  }

  function getAllRoots() {
    const roots = [];
    const seen = new Set();
    function walk(node, d = 0) {
      if (!node || d > 12 || seen.has(node)) return;
      seen.add(node);
      if (node.querySelectorAll) roots.push(node);
      node.querySelectorAll?.("iframe, frame").forEach((f) => {
        try { if (f.contentDocument) walk(f.contentDocument, d + 1); } catch (_) {}
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
    getAllRoots().forEach((r) => {
      r.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      });
    });
    return out;
  }

  function findSidePanelRoot(fromTab) {
    const roots = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      roots.push(el);
    };

    if (fromTab) {
      let node = fromTab;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        push(node);
      }
    }

    queryDeep(
      "[class*='LocationEventsMenu'], [class*='MatchLiveModule'], [class*='InPlayModule'], [class*='EventView']"
    ).forEach((el) => push(el));

    let best = null;
    let bestScore = 0;
    for (const el of roots) {
      const t = el.innerText || "";
      if (!/Estat\.?|Cronologia|Escalação/i.test(t)) continue;
      const score =
        (t.match(/xG|Ataques|Cronologia|Escalação|FINALIZA/i) || []).length * 120 +
        Math.min(t.length, 4000);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function getSidePanelText(fromTab) {
    const root = findSidePanelRoot(fromTab);
    if (root?.innerText) return root.innerText;
    return getAllVisibleText();
  }

  function clickSidePanelTab(labelRe) {
    for (const tab of queryDeep("[class*='LocationEventsMenu_Item'], [class*='EventsMenu'] *")) {
      const t = normalize(tab.textContent);
      if (labelRe.test(t)) {
        try {
          tab.scrollIntoView({ block: "nearest", behavior: "instant" });
        } catch (_) {}
        tab.click();
        return tab;
      }
    }
    return null;
  }

  function clickStatsTab() {
    return clickSidePanelTab(SIDE_PANEL_TAB_LABELS.stats);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function collectSidePanelTexts() {
    const textByTab = {};
    const tabClicks = {};
    const fullText = getAllVisibleText();

    for (const key of SIDE_PANEL_TAB_KEYS) {
      const tab = clickSidePanelTab(SIDE_PANEL_TAB_LABELS[key]);
      tabClicks[key] = Boolean(tab);
      if (tab) await delay(250);
      textByTab[key] = mergeSidePanelTabText(getSidePanelText(tab), fullText, key);
    }

    return { textByTab, tabClicks };
  }

  function isScrollableElement(el) {
    if (!el || el.scrollHeight <= el.clientHeight + 20) return false;
    try {
      const style = getComputedStyle(el);
      const oy = style.overflowY;
      return oy === "auto" || oy === "scroll" || oy === "overlay";
    } catch (_) {
      return false;
    }
  }

  function collectScrollableTargets(root) {
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
        if (isScrollableElement(el)) push(el);
      });
    } catch (_) {}

    let parent = root.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      if (isScrollableElement(parent)) push(parent);
    }

    return out.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight) ||
        b.scrollHeight - a.scrollHeight
    );
  }

  function findMarketScrollRoots() {
    const roots = [];
    const selectors = [
      "[class*='EventViewDetailScroller']",
      "[class*='MarketGroups']",
      "[class*='MarketBoard']",
      "[class*='ClassificationMarketGrid']",
      "[class*='CouponMarketGrid']",
      "[class*='IPMarketView']",
      "[class*='MarketGrid']",
    ];

    for (const sel of selectors) {
      queryDeep(sel).forEach((el) => roots.push(el));
    }

    if (!roots.length) {
      queryDeep("*").forEach((el) => {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width < 80 || rect.left > window.innerWidth * 0.62) return;
          if (!isScrollableElement(el)) return;
          roots.push(el);
        } catch (_) {}
      });
    }

    return [...new Set(roots)];
  }

  function marketTextFingerprint(text) {
    const playerMarkets = (text.match(/Jogador\s*-/gi) || []).length;
    const meetMarkets = (text.match(/Encontro\s*-/gi) || []).length;
    const fouls = (text.match(/Faltas Cometidas/gi) || []).length;
    const instant = (text.match(/APOSTAS INSTANTÂNEAS|Próximo Minuto/gi) || []).length;
    const corners = (text.match(/Escanteios\s*-/gi) || []).length;
    const scorers = (text.match(/Marcadores de Gol/gi) || []).length;
    return `${text.length}|${playerMarkets}|${meetMarkets}|${fouls}|${instant}|${corners}|${scorers}`;
  }

  function normalizeLeafText(el) {
    return normalizeMarketTabLabel(el?.innerText || el?.textContent || "");
  }

  function getLeafTabKey(el) {
    const childTexts = [...(el?.children || [])].map((child) => normalizeLeafText(child));
    return leafMarketTabKey(normalizeLeafText(el), childTexts);
  }

  function dispatchMarketTabClick(el) {
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
        const key = getLeafTabKey(el);
        if (!key || seen.has(key)) return;
        const rect = el.getBoundingClientRect();
        if (!isInMarketTabBand(rect, window.innerHeight, window.innerWidth)) return;
        seen.add(key);
        candidates.push({ el, label: key, area: rect.width * rect.height });
      } catch (_) {}
    };

    const containers = [];
    queryDeep(
      "[class*='Classification'], [class*='Ribbon'], [class*='MarketFilter'], [class*='CouponClassification']"
    ).forEach((el) => {
      const score = scoreMarketTabBarContainer(el.textContent || "");
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

    return pickSmallestTabCandidates(candidates);
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
    ).filter((el) => /Jogador\s*-|Jogador\/Contagem/i.test(normalize(el.textContent)));

    for (const header of headers.slice(0, 8)) {
      if (Date.now() - startedAt > MARKET_TAB_VISIT_BUDGET_MS) break;
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(90);
        capture();
      } catch (_) {}
    }

    const scrollRoots = findMarketScrollRoots();
    for (const root of scrollRoots.slice(0, 1)) {
      const el = collectScrollableTargets(root)[0];
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
        dispatchMarketTabClick(tab.el);
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

  async function scrollLeftColumnMarkets(maxSteps = 12) {
    const snapshots = [];
    const seen = new Set();
    const roots = findMarketScrollRoots();
    if (!roots.length) return { snapshots, scrollSteps: 0, container: null };

    const targets = [];
    const targetSeen = new Set();
    roots.forEach((root) => {
      collectScrollableTargets(root).forEach((el) => {
        if (targetSeen.has(el)) return;
        targetSeen.add(el);
        targets.push(el);
      });
    });

    if (!targets.length) return { snapshots, scrollSteps: 0, container: null };

    const originals = new Map(targets.map((el) => [el, el.scrollTop]));
    const primary = targets[0];

    const capture = () => {
      const text = getAllVisibleText();
      const key = marketTextFingerprint(text);
      if (!seen.has(key)) {
        seen.add(key);
        snapshots.push(text);
      }
    };

    const scrollTarget = async (el) => {
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll < 20) return;
      const step = Math.max(180, Math.ceil(maxScroll / maxSteps));
      for (let pos = 0; pos <= maxScroll + step; pos += step) {
        el.scrollTop = Math.min(pos, maxScroll);
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(100);
        capture();
      }
    };

    capture();

    for (const target of targets.slice(0, 3)) {
      await scrollTarget(target);
    }

    const marketHeaders = queryDeep(
      "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
    ).filter((el) =>
      /Jogador\s*-|Jogador\/Contagem|Encontro\s*-|Faltas|Assist/i.test(normalize(el.textContent))
    );

    for (const header of marketHeaders.slice(0, 18)) {
      try {
        header.scrollIntoView({ block: "center", behavior: "instant" });
        await delay(120);
        capture();
      } catch (_) {}
    }

    originals.forEach((top, el) => {
      el.scrollTop = top;
    });

    return {
      snapshots,
      scrollSteps: snapshots.length,
      container: String(primary.className || "scrollable").slice(0, 80),
      tabsVisited: [],
      playerMarkets: snapshots.reduce(
        (sum, text) => sum + (text.match(/Jogador\s*-/gi) || []).length,
        0
      ),
    };
  }

  function extractStatsFromDOM() {
    const stats = [];
    const seen = new Set();
    const rowSels = [
      "[class*='SimpleMatchStats']",
      "[class*='StatsGraph']",
      "[class*='StatsBar']",
      "[class*='StatsIndicator']",
      "[class*='StatRow']",
    ];

    for (const sel of rowSels) {
      queryDeep(sel).forEach((row) => {
        const lines = (row.innerText || "").split("\n").map(normalize).filter(Boolean);
        if (lines.length < 3) return;
        const label = lines.find((l) => !isNum(l) && l.length < 40);
        const nums = lines.filter(isNum);
        if (!label || nums.length < 2) return;
        const key = `${label}|${nums[0]}|${nums[1]}`;
        if (seen.has(key)) return;
        seen.add(key);
        stats.push({ label, home: nums[0], away: nums[1], source: "dom" });
      });
      if (stats.length) break;
    }
    return stats;
  }

  function extractOddsFromDOM() {
    const odds = [];
    const seen = new Set();
    const marketSels = "[class*='MarketGroup'], [class*='HorizontalMarket'], [class*='Market_Column']";

    queryDeep(marketSels).forEach((group) => {
      const market = normalize(
        group.querySelector(
          "[class*='MarketGroupButton_Text'], [class*='Market__label'], [class*='MarketGroup'][class*='Text']"
        )?.textContent || "Mercado"
      );

      group
        .querySelectorAll(
          "[class*='ParticipantOddsOnly'], [class*='ParticipantLabel'], [class*='Participant_General']"
        )
        .forEach((p) => {
          const name = normalize(p.querySelector("[class*='_Name'], [class*='Name']")?.textContent);
          const handicap = normalize(p.querySelector("[class*='Handicap']")?.textContent);
          const oddsRaw = normalize(
            p.querySelector("[class*='_Odds'], [class*='OddsOnly_Odds']")?.textContent
          );

          const selection = name || (handicap && !isLineValue(handicap) ? handicap : null);
          const odd = parseOdd(oddsRaw);

          if (!isValidSelection(selection) || !isValidOdd(odd)) return;

          const fullSelection = handicap && isLineValue(handicap)
            ? `${selection} (${handicap})`
            : selection;

          const key = `${market}|${fullSelection}|${odd}`;
          if (seen.has(key)) return;
          seen.add(key);
          odds.push({ market, selection: fullSelection, odds: odd, source: "dom" });
        });
    });

    return odds;
  }

  function pushMatchCandidatesFromText(candidates, text, source, extractedAt) {
    candidates.push(...collectMatchCandidatesFromText(text, source, extractedAt, 3500));
  }

  const DOM_SCOREBOARD_SELECTORS = [
    { sel: "[class*='ovm-Overview']", source: "dom-scoreboard" },
    { sel: "[class*='Scoreboard']", source: "dom-scoreboard" },
    { sel: "[class*='MatchLive']", source: "dom-scoreboard" },
    { sel: "[class*='InPlay']", source: "dom-scoreboard" },
    { sel: "[class*='LiveScore']", source: "dom-scoreboard" },
    { sel: "[class*='Video']", source: "dom-scoreboard" },
    { sel: "[class*='Media']", source: "dom-scoreboard" },
    { sel: "[class*='Stream']", source: "dom-scoreboard" },
    { sel: "[class*='EventHeader']", source: "dom" },
    { sel: "[class*='FixtureHeader']", source: "dom" },
    { sel: "[class*='MatchHeader']", source: "dom" },
    { sel: "[class*='Score']", source: "dom" },
  ];

  function probeDomScoreboardSelectors() {
    return DOM_SCOREBOARD_SELECTORS.map(({ sel, source }) => {
      const els = queryDeep(sel);
      return {
        sel,
        source,
        hits: els.length,
        samples: els
          .slice(0, 3)
          .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 140)),
      };
    }).filter((row) => row.hits > 0);
  }

  function extractMatchFromDOM(extractedAt) {
    const candidates = [];

    for (const { sel, source } of DOM_SCOREBOARD_SELECTORS) {
      queryDeep(sel).forEach((el) => {
        pushMatchCandidatesFromText(candidates, el.innerText || "", source, extractedAt);
      });
    }

    getAllVisibleText()
      .split("---IFRAME---")
      .forEach((chunk) => {
        if (/v\s+[A-Za-zÀ-ú]|\d{1,2}:\d{2}/i.test(chunk) && chunk.length < 1200) {
          pushMatchCandidatesFromText(candidates, chunk, "dom-scoreboard", extractedAt);
        }
      });

    const best = pickBestMatch(candidates, { extractedAt });
    return best ? sanitizeMatchClock(best, extractedAt) : null;
  }

  function mergeScrollSnapshots(...collects) {
    const snapshots = [];
    const seen = new Set();

    for (const collect of collects) {
      for (const text of collect?.snapshots || []) {
        const key = marketTextFingerprint(text);
        if (seen.has(key)) continue;
        seen.add(key);
        snapshots.push(text);
      }
    }

    const playerMarkets = snapshots.reduce(
      (sum, text) => sum + (text.match(/Jogador\s*-/gi) || []).length,
      0
    );

    return {
      snapshots,
      scrollSteps: snapshots.length,
      container: collects.map((c) => c?.container).filter(Boolean).join(" | ") || null,
      playerMarkets,
    };
  }

  async function scrapeMarketsViaScripting(tabId, maxSteps = 10) {
    if (!tabId || !chrome.runtime?.sendMessage) {
      return { snapshots: [], scrollSteps: 0, container: null, playerMarkets: 0 };
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: "SCROLL_MARKETS",
        tabId,
        maxSteps,
      });
      if (!res?.ok) {
        return {
          snapshots: [],
          scrollSteps: 0,
          container: null,
          playerMarkets: 0,
          error: res?.error || "scroll-failed",
        };
      }
      return (
        res.result || { snapshots: [], scrollSteps: 0, container: null, playerMarkets: 0 }
      );
    } catch (err) {
      return {
        snapshots: [],
        scrollSteps: 0,
        container: null,
        playerMarkets: 0,
        error: String(err?.message || err),
      };
    }
  }

  async function scrapeFramesViaScripting(tabId) {
    if (!tabId || !chrome.scripting?.executeScript) return [];

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const text = document.documentElement?.innerText || document.body?.innerText || "";
          const href = location.href;
          const scoreHint =
            /\d{1,2}\s*[-–]\s*\d{1,2}/.test(text) ||
            /[A-Za-zÀ-ú]{3,}\d{1,2}\d{1,2}[A-Za-zÀ-ú]{3,}\d{1,2}:\d{2}/.test(
              text.replace(/\s+/g, "")
            ) ||
            /\b\d{2,3}:\d{2}\b/.test(text) ||
            /Ao\s*Vivo/i.test(text);
          const len = text.length;
          return {
            text: text.slice(0, 3500),
            href,
            scoreHint,
            len,
          };
        },
      });

      return (results || [])
        .map((r) => ({ ...r.result, source: "frame-scripting" }))
        .filter((f) => f?.text && f.scoreHint && f.len < 5000);
    } catch (_) {
      return [];
    }
  }

  async function collectAllFrameTexts(tabId) {
    const seen = new Set();
    const out = [];

    function push(chunk) {
      if (!chunk?.text) return;
      const key = `${chunk.source}|${chunk.href || ""}|${chunk.text.slice(0, 160)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(chunk);
    }

    collectFrameWalkTexts().forEach(push);
    const scripted = await scrapeFramesViaScripting(tabId);
    scripted.forEach(push);

    return out;
  }

  async function ensurePageSniffer(tabId) {
    initNetworkBridge();

    let ok = false;

    if (chrome.runtime?.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "INJECT_SNIFFER",
          tabId,
        });
        ok = Boolean(res?.ok);
      } catch (_) {}
    }

    if (!ok && typeof __BET365_PAGE_SNIFFER_SOURCE__ === "string") {
      try {
        injectPageNetworkSniffer(__BET365_PAGE_SNIFFER_SOURCE__);
        ok = true;
      } catch (_) {}
    }

    return ok;
  }

  async function buildData(tabId) {
    const pipeline = [];
    let stepAt = Date.now();

    const snifferOk = await ensurePageSniffer(tabId);
    pipeline.push({ step: "injectSniffer", ok: snifferOk, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const extractedAt = new Date().toISOString();
    const { textByTab, tabClicks } = await collectSidePanelTexts();
    const visibleText =
      Object.values(textByTab)
        .filter(Boolean)
        .join("\n---SIDE-TAB---\n") || getAllVisibleText();
    pipeline.push({
      step: "sidePanelTabs",
      ok: Object.values(tabClicks).some(Boolean),
      detail: SIDE_PANEL_TAB_KEYS.map((k) => `${k}=${tabClicks[k] ? "ok" : "miss"}`).join(", "),
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    pipeline.push({
      step: "visibleText",
      count: visibleText.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const sidePanelFromText = extractSidePanelFromTexts(textByTab);
    const sidePanelFromNet = scanNetworkSidePanel(networkLog);
    const sidePanel = mergeSidePanel(sidePanelFromText, sidePanelFromNet);
    pipeline.push({
      step: "sidePanelParse",
      detail: `timeline=${sidePanel.timeline.length} lineup=${sidePanel.lineup ? "yes" : "no"} finals=${sidePanel.playerFinalizations.length}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const scrollCollect = await scrollLeftColumnMarkets();
    const mainScrollCollect = await scrapeMarketsViaScripting(tabId);
    const mergedScroll = mergeScrollSnapshots(scrollCollect, mainScrollCollect);
    pipeline.push({
      step: "leftColumnScroll",
      count: scrollCollect.scrollSteps,
      detail: `${scrollCollect.container || "none"} tabs=${(scrollCollect.tabsVisited || []).join(",") || "none"}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();
    pipeline.push({
      step: "mainWorldScroll",
      count: mainScrollCollect.scrollSteps,
      detail: `${mainScrollCollect.container || "none"} playerMarkets=${mainScrollCollect.playerMarkets ?? 0} tabsFound=${mainScrollCollect.tabsFound ?? 0} tabs=${(mainScrollCollect.tabsVisited || []).join(",") || "none"}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const fromNet = extractFromNetworkLog(networkLog, extractedAt);
    pipeline.push({
      step: "networkParse",
      count: networkLog.length,
      detail: `stats=${fromNet.stats.length} odds=${fromNet.odds.length} match=${fromNet.match ? "yes" : "no"}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const header = enrichMatchFromHeader(visibleText, {});
    const domProbe = probeDomScoreboardSelectors();
    pipeline.push({
      step: "domProbe",
      count: domProbe.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const frameChunks = await collectAllFrameTexts(tabId);
    pipeline.push({
      step: "frameCollect",
      count: frameChunks.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const stats = mergeStats(
      extractStatsFromVisibleText(textByTab.stats || visibleText, location.href),
      extractStatsFromDOM(),
      fromNet.stats
    );

    const odds = mergeOdds(
      extractOddsFromDOM(),
      ...mergedScroll.snapshots.map((chunk) => parseOddsFromVisibleText(chunk)),
      parseOddsFromVisibleText(visibleText),
      fromNet.odds
    );
    pipeline.push({
      step: "statsOddsMerge",
      detail: `stats=${stats.length} odds=${odds.length}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const frameMatch = extractMatchFromFrameChunks(frameChunks, extractedAt, {
      homeTeam: header.homeTeam,
      awayTeam: header.awayTeam,
    });

    const domMatch = extractMatchFromDOM(extractedAt);
    const matchCandidates = gatherMatchCandidates({
      frameChunks,
      visibleText,
      extractedAt,
      extraCandidates: [frameMatch, domMatch, fromNet.match].filter(Boolean),
    });
    pipeline.push({
      step: "matchCandidates",
      count: matchCandidates.length,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const matchBase =
      resolveMatchForPage(matchCandidates, {
        extractedAt,
        pageUrl: location.href,
      }) || {};
    pipeline.push({
      step: "mergeMatch",
      detail: matchBase.score ? `${matchBase.score} (${matchBase.source})` : "none",
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const meta = {
      version: VERSION,
      rootsScanned: getAllRoots().length,
      networkCaptures: networkLog.length,
      networkBridge: window.__bet365NetBridge ? "page-inject" : "isolated",
      frameTextsScanned: frameChunks.length,
      visibleTextLength: visibleText.length,
      visibleTextSample: visibleText.slice(0, 500),
      statsCount: stats.length,
      oddsCount: odds.length,
      sidePanelTimelineCount: sidePanel.timeline.length,
      sidePanelLineupCaptured: Boolean(sidePanel.lineup),
      sidePanelFinalizationsCount: sidePanel.playerFinalizations.length,
      sidePanelActionAreas: sidePanel.actionAreas || null,
      leftColumnScrollSteps: mergedScroll.scrollSteps,
      mainWorldScrollSteps: mainScrollCollect.scrollSteps,
      mainWorldPlayerMarkets: mainScrollCollect.playerMarkets ?? 0,
      tips: [],
    };

    if (!stats.length) {
      meta.tips.push(
        "Clique na aba 'Estat.' no painel do jogo",
        "Recarregue a página e tente novamente"
      );
    }

    if (!sidePanel.timeline.length && !sidePanel.lineup) {
      meta.tips.push(
        "Painel lateral (Cronologia/Escalação) pode não estar no texto visível — verifique rede no debug"
      );
    }

    const { match, inference, analysis } = finalizeMatchWithMarkets(
      matchBase,
      odds,
      visibleText,
      meta,
      extractedAt,
      location.href
    );
    pipeline.push({
      step: "marketInference",
      ok: inference.applied,
      detail: inference.applied ? `${matchBase.score} -> ${match.score}` : "not applied",
      ms: Date.now() - stepAt,
    });

    if (match.scoreWarnings?.length) {
      meta.tips.push(...match.scoreWarnings);
    }

    meta.debug = buildExtractionDebug({
      matchCandidates,
      frameChunks,
      visibleText,
      marketAnalysis: analysis,
      marketInference: inference,
      extractedAt,
      meta,
      pipeline,
      networkLog,
      sidePanelBlobDebug: sidePanel.network?.blobDebug || [],
      domProbe,
      stats,
      odds,
      selectedMatch: matchBase,
    });

    return {
      match: {
        ...match,
        eventId: (() => {
          const h = location.hash;
          const ev = h.match(/EV\d{8,}/i);
          if (ev) return ev[0];
          const e = h.match(/\/(E\d{6,})\b/i);
          return e ? e[1] : null;
        })(),
        url: location.href,
      },
      stats,
      odds,
      sidePanel,
      meta: {
        ...meta,
        scoreConfidence: match.scoreConfidence,
        scoreWarnings: match.scoreWarnings,
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "EXTRACT") return;
    if (window !== window.top) return;

    const tabId = message.tabId ?? sender.tab?.id;
    buildData(tabId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

    return true;
  });
})();