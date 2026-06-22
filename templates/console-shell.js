/**
 * Bet365 Console Extractor v3.2
 * Cole no Console (F12) na página do jogo aberta.
 *
 * A Bet365 renderiza via BLOB/módulos — este script usa:
 *   1) texto visível da página (innerText + iframes)
 *   2) interceptação de fetch/XHR (JSON da API)
 *   3) busca profunda no DOM
 *
 * Comandos:
 *   refreshBet365Data()     → re-extrai tudo
 *   discoverBet365DOM()     → debug
 *   showBet365Network()     → JSON capturado da rede
 *   copyBet365Data()        → copia JSON
 */

(function bet365ConsoleExtractorV3() {
  "use strict";

  /* __PARSERS__ */

  /* __NETWORK__ */

  /* __FRAMES__ */

  const C = {
    title:
      "color:#FFD700;font-weight:bold;font-size:14px;background:#1a1a1a;padding:2px 6px;border-radius:3px",
    section: "color:#00E5FF;font-weight:bold;font-size:12px",
    key: "color:#A0AEC0",
    value: "color:#FFFFFF;font-weight:bold",
    odds: "color:#76FF03;font-weight:bold",
    warn: "color:#FFB74D;font-weight:bold",
    ok: "color:#69F0AE;font-weight:bold",
    dim: "color:#718096;font-size:11px",
    json: "color:#E2E8F0;font-family:monospace;font-size:11px",
  };

  console.log("%c[sniffer] fetch/XHR/WebSocket Bet365 ativo", C.dim);

  function getAllVisibleText() {
    const chunks = [];
    const seen = new Set();

    function walkDoc(doc, depth = 0) {
      if (!doc || depth > 8 || seen.has(doc)) return;
      seen.add(doc);
      try {
        const t = doc.documentElement?.innerText || doc.body?.innerText || "";
        if (t) chunks.push(t);
        doc.querySelectorAll("iframe").forEach((f) => {
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
        }
      } catch (_) {}
    });

    return [...new Set(chunks)].join("\n---IFRAME---\n");
  }

  function getAllRoots() {
    const roots = [];
    const seen = new Set();
    function walk(node, d = 0) {
      if (!node || d > 8 || seen.has(node)) return;
      seen.add(node);
      if (node.querySelectorAll) roots.push(node);
      node.querySelectorAll?.("iframe").forEach((f) => {
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
    getAllRoots().forEach((r) => {
      r.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      });
    });
    return out;
  }

  function clickStatsTab() {
    for (const tab of queryDeep("[class*='LocationEventsMenu_Item'], [class*='EventsMenu'] *")) {
      const t = normalize(tab.textContent);
      if (/^Estat\.?$/i.test(t)) {
        tab.click();
        return true;
      }
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

  function extractFromNetwork(extractedAt) {
    return extractFromNetworkLog(networkLog, extractedAt);
  }

  function extractOddsFromDOM() {
    const odds = [];
    const seen = new Set();

    const marketSels =
      "[class*='MarketGroup'], [class*='HorizontalMarket'], [class*='Market_Column']";

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

          const fullSelection =
            handicap && isLineValue(handicap) ? `${selection} (${handicap})` : selection;

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
        if (/v\s+[A-Za-zÀ-ú]|\d{1,2}:\d{2}/i.test(chunk) && chunk.length < 800) {
          pushMatchCandidatesFromText(candidates, chunk, "dom-scoreboard", extractedAt);
        }
      });

    const best = pickBestMatch(candidates, { extractedAt });
    return best ? sanitizeMatchClock(best, extractedAt) : null;
  }

  function buildData() {
    const pipeline = [];
    let stepAt = Date.now();

    const statsTabOk = clickStatsTab();
    pipeline.push({ step: "clickStatsTab", ok: statsTabOk, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const extractedAt = new Date().toISOString();
    const visibleText = getAllVisibleText();
    pipeline.push({ step: "visibleText", count: visibleText.length, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const fromNet = extractFromNetwork(extractedAt);
    pipeline.push({
      step: "networkParse",
      count: networkLog.length,
      detail: `stats=${fromNet.stats.length} odds=${fromNet.odds.length} match=${fromNet.match ? "yes" : "no"}`,
      ms: Date.now() - stepAt,
    });
    stepAt = Date.now();

    const header = enrichMatchFromHeader(visibleText, {});
    const domProbe = probeDomScoreboardSelectors();
    pipeline.push({ step: "domProbe", count: domProbe.length, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const frameChunks = collectFrameWalkTexts();
    pipeline.push({ step: "frameCollect", count: frameChunks.length, ms: Date.now() - stepAt });
    stepAt = Date.now();

    const frameMatch = extractMatchFromFrameChunks(frameChunks, extractedAt, {
      homeTeam: header.homeTeam,
      awayTeam: header.awayTeam,
    });

    const stats = mergeStats(
      extractStatsFromVisibleText(visibleText, location.href),
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
      frameTextsScanned: frameChunks.length,
      visibleTextLength: visibleText.length,
      visibleTextSample: visibleText.slice(0, 500),
      statsCount: stats.length,
      oddsCount: odds.length,
      tips: [],
    };

    if (!stats.length) {
      meta.tips.push(
        "1. Clique na aba 'Estat.' no painel do jogo",
        "2. Rode refreshBet365Data()",
        "3. Rode discoverBet365DOM() e me mande o resultado",
        "4. Se ainda vazio: showBet365Network() — dados podem vir só da API"
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

    if (match.scoreWarnings?.length) meta.tips.push(...match.scoreWarnings);

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

  function safeCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;z-index:99999";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    if (ok) return { ok: true, text };
    return {
      ok: false,
      text,
      hint: "Clique na página Bet365 (fora do DevTools) e rode copyBet365Data() de novo",
    };
  }

  function printData(data) {
    console.log(`%c⚽ Bet365 Extractor v${VERSION}`, C.title);
    console.log("%c▸ PARTIDA", C.section, data.match);
    console.log("%c▸ ESTATÍSTICAS", C.section);
    data.stats.length
      ? console.table(data.stats)
      : console.log("%c  vazio — veja meta.tips", C.warn);
    console.log("%c▸ ODDS", C.section);
    data.odds.length
      ? console.table(data.odds)
      : console.log("%c  vazio — role até os mercados", C.warn);
    if (!data.stats.length)
      console.log("%c▸ DICA: meta.visibleTextSample", C.dim, data.meta.visibleTextSample);
    console.log("%c▸ JSON", C.section);
    console.log("%c" + JSON.stringify(data, null, 2), C.json);
  }

  function getClassNames(el) {
    const raw = el.getAttribute?.("class") ?? el.className;
    if (!raw) return [];
    const str = typeof raw === "string" ? raw : raw.baseVal || String(raw);
    return str.split(/\s+/).filter(Boolean);
  }

  function discoverBet365DOM() {
    const classes = new Map();
    getAllRoots().forEach((root) => {
      root.querySelectorAll("[class]").forEach((el) => {
        getClassNames(el).forEach((cls) => {
          if (/ml1|ipe|gl-|srb|cm-|Stats|Odds|Market|Participant|Location|Event/i.test(cls))
            classes.set(cls, (classes.get(cls) || 0) + 1);
        });
      });
    });
    const top = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log("%c▸ DISCOVER", C.section);
    console.table(top.map(([cls, n]) => ({ class: cls, count: n })));
    console.log("roots:", getAllRoots().length, "| network:", networkLog.length);
    console.log("visible text (300 chars):", getAllVisibleText().slice(0, 300));
    return { classes: top, network: networkLog.length };
  }

  let data = buildData();
  printData(data);

  window.bet365Data = data;
  window.bet365NetworkLog = networkLog;
  window.bet365C = C;

  window.refreshBet365Data = function (delayMs = 300) {
    return new Promise((resolve) => {
      setTimeout(() => {
        data = buildData();
        window.bet365Data = data;
        printData(data);
        resolve(data);
      }, delayMs);
    });
  };

  window.discoverBet365DOM = discoverBet365DOM;
  window.showBet365Network = () => {
    console.table(networkLog.map((n) => ({ url: n.url.slice(0, 80), at: n.at })));
    return networkLog;
  };

  function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  window.copyBet365Data = function (pretty = true) {
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    const r = safeCopy(text);
    if (r.ok) console.log("%c✓ JSON copiado", C.ok);
    else console.log("%c⚠ " + r.hint, C.warn);
    return r.text;
  };

  window.copyBet365Logs = function () {
    const text = formatBet365Logs(data);
    const r = safeCopy(text);
    if (r.ok) console.log("%c✓ Logs copiados", C.ok);
    else console.log("%c⚠ " + r.hint, C.warn);
    return text;
  };

  window.downloadBet365Data = function (pretty = true) {
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    downloadText(buildBet365Filename(data, "json"), text, "application/json;charset=utf-8");
    console.log("%c✓ JSON baixado", C.ok);
    return text;
  };

  window.downloadBet365Logs = function () {
    const text = formatBet365Logs(data);
    downloadText(buildBet365Filename(data, "txt"), text);
    console.log("%c✓ Logs baixados", C.ok);
    return text;
  };

  console.log("\n%cComandos v3:", C.ok);
  console.log("  refreshBet365Data()  |  discoverBet365DOM()  |  showBet365Network()");
  console.log("  copyBet365Data()     |  copyBet365Logs()");
  console.log("  downloadBet365Data()   |  downloadBet365Logs()");

  return data;
})();
