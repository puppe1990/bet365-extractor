// Bet365 Chrome Extension — content script (built from parsers + this template)
(function bet365ExtensionContent() {
  "use strict";

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

  function clickStatsTab() {
    for (const tab of queryDeep("[class*='LocationEventsMenu_Item'], [class*='EventsMenu'] *")) {
      const t = normalize(tab.textContent);
      if (/^Estat\.?$/i.test(t)) { tab.click(); return true; }
    }
    return false;
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
    if (!tabId || !chrome.runtime?.sendMessage) return false;
    try {
      const res = await chrome.runtime.sendMessage({ type: "INJECT_SNIFFER", tabId });
      return Boolean(res?.ok);
    } catch (_) {
      return false;
    }
  }

  async function buildData(tabId) {
    const pipeline = [];
    let stepAt = Date.now();

    const snifferOk = await ensurePageSniffer(tabId);
    pipeline.push({ step: "injectSniffer", ok: snifferOk, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const statsTabOk = clickStatsTab();
    pipeline.push({
      step: "clickStatsTab",
      ok: statsTabOk,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const extractedAt = new Date().toISOString();
    const visibleText = getAllVisibleText();
    pipeline.push({
      step: "visibleText",
      count: visibleText.length,
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
      extractStatsFromVisibleText(visibleText),
      extractStatsFromDOM(),
      fromNet.stats
    );

    const odds = mergeOdds(
      extractOddsFromDOM(),
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

    const matchBase = mergeMatchCandidates(...matchCandidates, { extractedAt }) || {};
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
      tips: [],
    };

    if (!stats.length) {
      meta.tips.push(
        "Clique na aba 'Estat.' no painel do jogo",
        "Recarregue a página e tente novamente"
      );
    }

    const { match, inference, analysis } = finalizeMatchWithMarkets(
      matchBase,
      odds,
      visibleText,
      meta,
      extractedAt
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

    buildData(sender.tab?.id)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

    return true;
  });
})();