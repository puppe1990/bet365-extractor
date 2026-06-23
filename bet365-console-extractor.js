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

  function parseNextGoalMarkets(odds) {
    const markets = [];

    for (const o of odds || []) {
      const m = String(o.market || "").match(/(\d+)\s*°\s*Gol/i);
      if (m) markets.push(parseInt(m[1], 10));
    }

    return [...new Set(markets)].sort((a, b) => b - a);
  }

  function minTotalGoalsFromOdds(odds) {
    const next = parseNextGoalMarkets(odds)[0];
    if (!next || next < 2) return null;
    return next - 1;
  }

  function scoreTotalFromMatch(match) {
    if (match?.scoreHome != null && match?.scoreAway != null) {
      return match.scoreHome + match.scoreAway;
    }
    if (!match?.score) return null;

    const parts = match.score.split("-").map((n) => parseInt(n, 10));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
    return parts[0] + parts[1];
  }

  function isDrawFavored(odds) {
    const rf = (odds || []).filter((o) => /resultado\s*final/i.test(o.market));
    const empate = rf.find((o) => /^empate$/i.test(String(o.selection || "").trim()));
    const home = rf.find((o) => o !== empate && !/empate/i.test(String(o.selection || "")));

    if (!empate) return false;

    const homeOdd = home?.odds ?? 999;
    return empate.odds <= homeOdd * 0.85;
  }

  function suggestScoreForMinGoals(minGoals, drawFavored, currentHome, currentAway) {
    if (!minGoals || minGoals < 1) return null;

    if (drawFavored && minGoals % 2 === 0) {
      const each = minGoals / 2;
      return { score: `${each}-${each}`, scoreHome: each, scoreAway: each };
    }

    if (
      Number.isFinite(currentHome) &&
      Number.isFinite(currentAway) &&
      currentHome + currentAway < minGoals
    ) {
      const diff = minGoals - (currentHome + currentAway);
      if (drawFavored && currentHome >= currentAway) {
        return {
          score: `${currentHome}-${currentAway + diff}`,
          scoreHome: currentHome,
          scoreAway: currentAway + diff,
        };
      }
      return {
        score: `${currentHome + diff}-${currentAway}`,
        scoreHome: currentHome + diff,
        scoreAway: currentAway,
      };
    }

    return null;
  }

  function analyzeMarketScore(odds, match) {
    const nextGoalMarkets = parseNextGoalMarkets(odds);
    const minTotalGoals = minTotalGoalsFromOdds(odds);
    const domTotalGoals = scoreTotalFromMatch(match);
    const drawFavored = isDrawFavored(odds);

    const analysis = {
      nextGoalMarkets,
      minTotalGoals,
      domTotalGoals,
      drawFavored,
      consistent: domTotalGoals == null || minTotalGoals == null || domTotalGoals >= minTotalGoals,
      reasons: [],
    };

    if (minTotalGoals != null && domTotalGoals != null && domTotalGoals < minTotalGoals) {
      analysis.reasons.push(
        `Mercado ${nextGoalMarkets[0]}° Gol implica ≥${minTotalGoals} gols; DOM tem ${domTotalGoals} (${match?.score ?? "?"}).`
      );
    }

    if (drawFavored) {
      analysis.reasons.push("Empate favorito no Resultado Final.");
    }

    return analysis;
  }

  function applyMarketScoreInference(match, odds) {
    const analysis = analyzeMarketScore(odds, match);
    const result = { match: { ...match }, analysis, applied: false };

    if (analysis.minTotalGoals == null) return result;

    const missingScore = match?.score == null;
    const inconsistent =
      !missingScore &&
      analysis.domTotalGoals != null &&
      analysis.domTotalGoals < analysis.minTotalGoals;

    if (!missingScore && (analysis.consistent || !inconsistent)) return result;

    const home = Number.isFinite(match?.scoreHome)
      ? match.scoreHome
      : match?.score
        ? parseInt(String(match.score).split("-")[0], 10)
        : null;
    const away = Number.isFinite(match?.scoreAway)
      ? match.scoreAway
      : match?.score
        ? parseInt(String(match.score).split("-")[1], 10)
        : null;

    const suggested = suggestScoreForMinGoals(
      analysis.minTotalGoals,
      analysis.drawFavored,
      home,
      away
    );

    if (!suggested) {
      analysis.reasons.push("Não foi possível sugerir placar exato pelos mercados.");
      return result;
    }

    const canOverride =
      missingScore ||
      !match.clock ||
      match.scoreConfidence === "medium" ||
      match.scoreConfidence === "low" ||
      inconsistent;

    if (!canOverride) return result;

    result.applied = true;
    result.match = {
      ...match,
      score: suggested.score,
      scoreHome: suggested.scoreHome,
      scoreAway: suggested.scoreAway,
      scoreDom: match.score ?? null,
      scoreInferredFrom: "markets",
      scoreInference: {
        ...analysis,
        suggested,
        previousScore: match.score ?? null,
      },
    };

    if (missingScore) {
      analysis.reasons.push(
        `Placar inferido pelos mercados: ${suggested.score} (mín. ${analysis.minTotalGoals} gols).`
      );
    } else {
      analysis.reasons.push(
        `Placar ajustado: ${match.score} → ${suggested.score} (inferência por mercados).`
      );
    }

    return result;
  }

  const FIELD_KV_RE = /\b([A-Z][A-Z0-9]{1,3})=([^|\x00-\x1f\x14]{1,200})/g;
  const SCORE_PAIR_RE = /\b(?:SC|SS)=(\d{1,2})[-–](\d{1,2})\b/gi;
  const S1S2_RE = /\bS1=(\d{1,2})[\s\S]{0,60}?\bS2=(\d{1,2})\b/gi;
  const CLOCK_RE = /\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/gi;

  function parseBet365WireFields(text) {
    const fields = {};
    if (!text) return fields;

    const flat = String(text);
    let m;
    const re = new RegExp(FIELD_KV_RE.source, "g");

    while ((m = re.exec(flat)) !== null) {
      const key = m[1];
      const value = m[2].trim();
      if (!value) continue;
      if (!(key in fields)) fields[key] = value;
    }

    return fields;
  }

  function scanBet365WireText(text, limit = 2_000_000) {
    const sample = String(text || "").slice(0, limit);
    const matches = [];
    const clocks = new Set();

    const pushScore = (home, away, index, tag) => {
      const h = parseInt(home, 10);
      const a = parseInt(away, 10);
      if (!Number.isFinite(h) || !Number.isFinite(a) || h > 30 || a > 30) return;
      const window = sample.slice(Math.max(0, index - 120), index + 160);
      let clock = null;
      const cm = window.match(/\b(?:TU|TM|TC)=(\d{1,3})[:;](\d{2})\b/i);
      if (cm) {
        const mins = parseInt(cm[1], 10);
        if (mins <= 130) clock = `${mins}:${cm[2]}`;
      }
      matches.push({
        score: `${h}-${a}`,
        scoreHome: h,
        scoreAway: a,
        clock,
        tag,
      });
    };

    let sm;
    while ((sm = SCORE_PAIR_RE.exec(sample)) !== null) {
      pushScore(sm[1], sm[2], sm.index, "SC");
    }

    while ((sm = S1S2_RE.exec(sample)) !== null) {
      pushScore(sm[1], sm[2], sm.index, "S1S2");
    }

    let cm;
    while ((cm = CLOCK_RE.exec(sample)) !== null) {
      const mins = parseInt(cm[1], 10);
      if (mins <= 130) clocks.add(`${mins}:${cm[2]}`);
    }

    return {
      fields: parseBet365WireFields(sample),
      matches,
      clocks: [...clocks],
    };
  }

  function matchFromBet365Fields(fields, source = "net-ws") {
    if (!fields || typeof fields !== "object") return null;

    let scoreHome = null;
    let scoreAway = null;

    const sc = fields.SC || fields.SS;
    if (sc) {
      const parts = String(sc).split(/[-–]/);
      if (parts.length === 2) {
        scoreHome = parseInt(parts[0], 10);
        scoreAway = parseInt(parts[1], 10);
      }
    }

    if (scoreHome == null && fields.S1 != null && fields.S2 != null) {
      scoreHome = parseInt(fields.S1, 10);
      scoreAway = parseInt(fields.S2, 10);
    }

    if (!Number.isFinite(scoreHome) || !Number.isFinite(scoreAway)) return null;
    if (scoreHome > 30 || scoreAway > 30) return null;

    let clock = null;
    const rawClock = fields.TU || fields.TM || fields.TC;
    if (rawClock) {
      const cm = String(rawClock).match(/^(\d{1,3})[:;](\d{2})$/);
      if (cm && parseInt(cm[1], 10) <= 130) clock = `${cm[1]}:${cm[2]}`;
    }

    return {
      score: `${scoreHome}-${scoreAway}`,
      scoreHome,
      scoreAway,
      clock,
      status: fields.ST || fields.STATUS || null,
      homeTeam: fields.NA || fields.HN || null,
      awayTeam: fields.N2 || fields.AN || null,
      source,
    };
  }

  function extractFromBet365WirePayload(text, source = "net-text") {
    const scanned = scanBet365WireText(text);
    const fromFields = matchFromBet365Fields(scanned.fields, source);
    if (fromFields) return fromFields;

    if (!scanned.matches.length) return null;

    const best = scanned.matches[scanned.matches.length - 1];
    const clock = best.clock || scanned.clocks[scanned.clocks.length - 1] || null;

    return {
      score: best.score,
      scoreHome: best.scoreHome,
      scoreAway: best.scoreAway,
      clock,
      source,
    };
  }

  function isBet365BlobUrl(url) {
    return /\/Api\/1\/Blob\b/i.test(String(url || ""));
  }

  function isBet365ZapUrl(url) {
    return /sportspublisher\/zap/i.test(String(url || ""));
  }

  function extractNetworkHints(text, url = "") {
    const scanned = scanBet365WireText(text, isBet365BlobUrl(url) ? 2_000_000 : 120_000);
    const match = extractFromBet365WirePayload(text, isBet365ZapUrl(url) ? "net-ws" : "net-blob");
    const fieldKeys = Object.keys(scanned.fields).slice(0, 24);

    return {
      fieldKeys,
      fields: scanned.fields,
      matches: scanned.matches.slice(-5),
      clocks: scanned.clocks.slice(-5),
      match,
      blobUrl: isBet365BlobUrl(url),
      zapUrl: isBet365ZapUrl(url),
    };
  }

  const BET365_NETWORK_HOST_RE = /bet365/i;
  const NETWORK_PAYLOAD_HINTS =
    /stats|stat|odds|market|fixture|event|score|participant|mg|pa|ss|tu|tm|sc|xg|attack|possess|inplay|EV\d+/i;

  function resolveNetworkUrl(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof input === "object") {
      if (typeof input.url === "string") return input.url;
      if (input instanceof URL) return input.href;
    }
    return String(input);
  }

  function isBet365NetworkUrl(url) {
    return BET365_NETWORK_HOST_RE.test(resolveNetworkUrl(url));
  }

  function looksLikeBet365NetworkPayload(data) {
    if (data == null) return false;
    if (typeof data === "object") {
      const s = JSON.stringify(data).slice(0, 6000);
      return NETWORK_PAYLOAD_HINTS.test(s);
    }
    const text = String(data).slice(0, 6000);
    return NETWORK_PAYLOAD_HINTS.test(text);
  }

  function parseNetworkPayload(input) {
    if (input == null) return null;
    if (typeof input === "object" && !Array.isArray(input)) return input;

    const text = String(input).trim();
    if (!text) return null;

    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch (_) {}
    }

    const structured = { _bet365Protocol: true, segments: [] };
    const parts = text.split(/[|;\n]/);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch (_) {}
      }

      const kv = trimmed.match(/^([A-Za-z_]+)[=:](.+)$/);
      if (kv) {
        structured.segments.push({ key: kv[1], value: kv[2] });
        continue;
      }

      structured.segments.push({ key: null, value: trimmed });
    }

    return structured.segments.length ? structured : { _rawText: text.slice(0, 4000) };
  }

  function extractClockFromNetworkText(text) {
    if (!text) return null;

    const patterns = [
      /\bTU[=;](\d{1,3})[:;](\d{2})\b/i,
      /\bTM[=;](\d{1,3})[:;](\d{2})\b/i,
      /\btime[=;](\d{1,3})[:;](\d{2})\b/i,
      /\belapsed[=;](\d{1,3})[:;](\d{2})\b/i,
    ];

    for (const re of patterns) {
      const m = String(text).match(re);
      if (!m) continue;
      const mins = parseInt(m[1], 10);
      if (mins > 130) continue;
      return `${mins}:${m[2]}`;
    }

    return null;
  }

  function extractScoresFromNetworkText(text) {
    if (!text) return [];

    const found = [];
    const patterns = [
      /\bSC[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
      /\bSS[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
      /\bscore[=;](\d{1,2})[-–;:](\d{1,2})\b/gi,
      /"score"\s*:\s*"(\d{1,2})-(\d{1,2})"/gi,
      /"scoreHome"\s*:\s*(\d{1,2})[\s\S]{0,80}?"scoreAway"\s*:\s*(\d{1,2})/gi,
      /\bS1[=;](\d{1,2})[\s\S]{0,40}?\bS2[=;](\d{1,2})\b/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(String(text))) !== null) {
        const home = parseInt(m[1], 10);
        const away = parseInt(m[2], 10);
        if (!Number.isFinite(home) || !Number.isFinite(away) || home > 30 || away > 30) continue;
        found.push({
          score: `${home}-${away}`,
          scoreHome: home,
          scoreAway: away,
          clock: extractClockFromNetworkText(text.slice(Math.max(0, m.index - 80), m.index + 120)),
        });
      }
    }

    return found;
  }

  function matchCandidatesFromNetworkText(text, source = "net-text") {
    const scores = extractScoresFromNetworkText(text);
    const clock = extractClockFromNetworkText(text);

    const candidates = scores.map((s) => ({
      ...s,
      source,
      clock: s.clock || clock,
    }));

    const wire = extractFromBet365WirePayload(text, source);
    if (wire) candidates.push(wire);

    return candidates;
  }

  const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;

  /** Live in-play: #/IP/EV151352326532C1/ */
  const BET365_IP_EVENT_RE = /#\/IP\/EV\d+/i;

  /** Pre-match / competition: #/AC/.../E194699812/... */
  const BET365_AC_EVENT_RE = /\/E\d{6,}\b/i;

  function extractBet365EventId(urlOrHash = "") {
    const hash = String(urlOrHash).includes("#")
      ? String(urlOrHash).split("#")[1] || ""
      : String(urlOrHash);

    const ev = hash.match(/EV\d{8,}/i);
    if (ev) return ev[0];

    const e = hash.match(/\/(E\d{6,})\b/i) || hash.match(/\b(E\d{6,})\b/i);
    if (e) return e[1];

    return null;
  }

  function isBet365MatchUrl(url) {
    if (!BET365_HOST_RE.test(url || "")) return false;
    const hash = String(url).split("#")[1] || "";
    if (!hash) return false;
    if (BET365_IP_EVENT_RE.test(`#${hash}`)) return true;
    if (BET365_AC_EVENT_RE.test(hash)) return true;
    if (/EV\d{8,}/i.test(hash)) return true;
    return false;
  }

  function isBet365LiveUrl(url) {
    if (!BET365_HOST_RE.test(url || "")) return false;
    const hash = String(url).split("#")[1] || "";
    if (!hash) return false;
    return BET365_IP_EVENT_RE.test(`#${hash}`) || /EV\d{8,}/i.test(hash);
  }

  function isBet365PreMatchUrl(url) {
    return isBet365MatchUrl(url) && !isBet365LiveUrl(url);
  }

  function bet365UrlHint(url) {
    if (!BET365_HOST_RE.test(url || "")) {
      return "Abra o site bet365.bet.br";
    }
    if (isBet365MatchUrl(url)) return null;
    return "Abra a página do jogo (clique no confronto até a URL ter #/IP/EV... ou .../E123...)";
  }

  const VERSION = "3.10.26";

  const JUNK_ODDS_SELECTIONS =
    /^(Mais de|Menos de|Exatamente|Nenhum|Tabela|gol$|CA$|A Qualquer Momento|Cronologia|Escalação|Estat\.?|Estatísticas de Jogador)$/i;

  const SKIP_ODDS_LINES =
    /^(CA|SUBSTITUIÇÃO\+|Mostrar Mais|Popular|Criar Aposta|Instantâneas|Todos|Ao-Vivo|Jogador\/Contagem|Para Marcar ou Dar Assistência|1°|Jogadores Titulares|Mercado Suspenso|\d+)$/i;

  const JUNK_ODDS_MARKETS =
    /^(Escalação|FINALIZAÇÕES|Parceiros|Estat\.|Cronologia|Tabela|Exibir\b|Resultados\b|Configurações|Idioma|Esportes|Notícias de Apostas)/i;

  const TIMELINE_LEAK_MARKET_RE = /^\d+°\s*(?:Goal|Gol|Escanteio|Impedimento|Cart[aã]o)/i;

  const TIMELINE_LEAK_SELECTION_RE = /\s-\s(?:Chute|Assist)$/i;

  const PLAYER_SHORT_ODDS_NAME_RE = /^[A-ZÀ-Ú][\s.][A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{0,24}$/;

  const LEGAL_FOOTER_MARKET_RE =
    /\b(CNPJ|Portaria\s+SPA|regulada e autorizada|Sede registrada|©\s*\d{4}|Você não deve utilizar|Jogue com responsabilidade)\b/i;

  const BETTING_MARKET_HINTS =
    /\b(Gol|Gols|Resultado|Chance|Empate|Intervalo|Handicap|Total|Marcador|Chutes|Cartões|Escanteio|Tempo|Aposta|Dupla|Partida|Asiátic)/i;

  const STAT_LABEL_RE =
    /^(Goleiro|Precisão|Finalizações|Ataques|Ataques Perigosos|% de Posse|xG|Áreas de Ação|Passes Chave|Cruzamentos|Escanteios|Impedimentos|Defesas|Posse)\b/i;

  const STAT_LABELS = [
    "Finalizações / Chutes ao Gol",
    "Ataques Perigosos",
    "Ataques",
    "% de Posse",
    "Posse de Bola",
    "Chutes ao Gol",
    "Finalizações",
    "xG",
    "Escanteios",
    "Impedimentos",
    "Cartões Amarelos",
    "Cartões Vermelhos",
    "Defesas",
    "Faltas",
    "Posse",
  ];

  function splitAtaquesPerigososGlued(digits) {
    const d = String(digits || "");
    if (!d) return null;
    if (d.length === 4) {
      const home = d.slice(0, 2);
      const away = d.slice(2);
      const homeN = parseInt(home, 10);
      const awayN = parseInt(away, 10);
      if (homeN >= 0 && awayN >= 0 && homeN <= 99 && awayN <= 99) {
        return { home, away };
      }
    }
    if (d.length === 3) {
      const tail = parseInt(d.slice(1), 10);
      if (tail >= 10) return { home: d[0], away: String(tail) };
      return { home: d.slice(0, 2), away: d[2] };
    }
    const m = d.match(/^(\d{1,2})(\d{1,2})$/);
    return m ? { home: m[1], away: m[2] } : null;
  }

  const GLUED_STAT_RULES = [
    { label: "xG", regex: /(\d+\.\d+)xG(\d+\.\d+)/i },
    {
      label: "Ataques Perigosos",
      regex: /AtaquesPerigosos(\d+)(?=%dePosse|%)/i,
      map: splitAtaquesPerigososGlued,
    },
    { label: "Ataques", regex: /Ataques(\d{2})(\d{2})(?=AtaquesPerigosos|%)/i },
    { label: "% de Posse", regex: /%dePosse(\d{2})(\d{2})/i },
    {
      label: "Finalizações / Chutes ao Gol",
      regex: /Finalizacoes\/ChutesaoGol(\d+\/\d)(\d\/\d)/i,
    },
    { label: "Passes Chave", regex: /PassesChave(\d{1,2})(\d{1,2})/i },
    { label: "Goleiro - Defesas", regex: /Goleiro-Defesas(\d+)(\d+)/i },
    { label: "Precisão dos Passes", regex: /PrecisaodosPasses(\d{1,3}%)(\d{1,3}%)/i },
    { label: "Cruzamentos", regex: /Cruzamentos(\d{1,2})(\d{1,2})/i },
  ];

  function normalize(t) {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  function isNum(v) {
    return v && /^[\d.,/%-]+$/.test(v);
  }

  function isLikelyStatValue(v) {
    if (!v) return false;
    const s = String(v).trim();
    if (/^\d+\/\d+$/.test(s)) return true;
    if (/^\d{1,3}%$/.test(s)) return true;
    if (/^\d{1,2}$/.test(s)) return true;
    if (/^\d\.\d{1,2}$/.test(s)) {
      const n = parseOdd(s);
      if (n != null && isValidOdd(n) && n >= 2) return false;
      return true;
    }
    return false;
  }

  function toFlatBet365Text(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "");
  }

  function parseGluedStats(text) {
    const flat = toFlatBet365Text(text);
    const stats = [];
    const seen = new Set();

    GLUED_STAT_RULES.forEach(({ label, regex, map }) => {
      const m = flat.match(regex);
      if (!m) return;
      const pair = map ? map(m[1]) : { home: m[1], away: m[2] };
      if (!pair?.home || pair.away == null) return;
      const key = `${label}|${pair.home}|${pair.away}`;
      if (seen.has(key)) return;
      seen.add(key);
      stats.push({ label, home: pair.home, away: pair.away, source: "glued-text" });
    });

    return stats;
  }

  const GLUED_MATCH_RE =
    /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2})(\d{1,2})([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)(\d{1,2}:\d{2})/g;

  const SPACED_SCOREBOARD_RE =
    /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,2})\s+(\d{1,2})\s+([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,30}?)\s+(\d{1,3}:\d{2})/g;

  function parseClockMinutes(clock) {
    if (!clock) return -1;
    const m = String(clock).match(/^(\d{1,3}):(\d{2})$/);
    return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : -1;
  }

  function isWallClockTime(clock) {
    const m = String(clock || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const hours = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    return hours <= 23 && mins <= 59;
  }

  function isLikelyWallClock(clock, extractedAt) {
    if (!clock || !isWallClockTime(clock)) return false;

    const hours = parseInt(clock.split(":")[0], 10);
    if (hours > 23) return false;

    if (extractedAt) {
      const d = new Date(extractedAt);
      if (!Number.isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        const candidates = new Set();
        for (let offset = -2; offset <= 2; offset++) {
          const t = new Date(d.getTime() + offset * 60_000);
          candidates.add(`${pad(t.getHours())}:${pad(t.getMinutes())}`);
        }
        if (candidates.has(clock)) return true;
      }
    }

    return false;
  }

  function matchCandidateRank(candidate, options = {}) {
    const { extractedAt } = options;
    let rank = parseClockMinutes(candidate?.clock);

    if (!candidate?.clock) rank -= 5000;
    if (isLikelyWallClock(candidate?.clock, extractedAt)) rank -= 100_000;
    if (candidate?.source === "frame-scripting") rank += 15000;
    if (candidate?.source === "frame-walk") rank += 12000;
    if (candidate?.source === "frame-scoreboard") rank += 12000;
    if (candidate?.source === "dom-scoreboard") rank += 5000;
    if (candidate?.source === "net-ws") rank += 10000;
    if (candidate?.source === "net-blob") rank += 8000;
    if (candidate?.source === "net-fetch" || candidate?.source === "net-xhr") rank += 6000;
    if (candidate?.source === "net-text") rank += 4000;
    if (candidate?.source === "net") rank += 3000;
    if (/ao\s*vivo|live/i.test(candidate?.status || "")) rank += 1000;

    return rank;
  }

  function pickBestMatch(candidates, options = {}) {
    const valid = (candidates || []).filter((m) => m?.score != null);
    if (!valid.length) return null;
    return [...valid].sort(
      (a, b) => matchCandidateRank(b, options) - matchCandidateRank(a, options)
    )[0];
  }

  function pickBestClock(clocks, extractedAt) {
    if (!clocks.length) return null;
    const filtered = clocks.filter((c) => !isLikelyWallClock(c.clock, extractedAt));
    const pool = filtered.length ? filtered : clocks;
    return pool.sort((a, b) => b.minutes - a.minutes)[0];
  }

  function sanitizeMatchClock(match, extractedAt) {
    if (!match) return match;
    if (!isLikelyWallClock(match.clock, extractedAt)) return match;
    return { ...match, clock: null };
  }

  function collectGluedMatches(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    const matches = [];
    const re = new RegExp(GLUED_MATCH_RE.source, "g");
    let m;

    while ((m = re.exec(flat)) !== null) {
      const scoreHome = parseInt(m[2], 10);
      const scoreAway = parseInt(m[3], 10);
      if (scoreHome > 30 || scoreAway > 30) continue;

      matches.push({
        homeTeam: normalize(m[1]),
        awayTeam: normalize(m[4]),
        score: `${scoreHome}-${scoreAway}`,
        scoreHome,
        scoreAway,
        clock: m[5],
        status: flat.match(/Intervalo|INTERVALO|1T|2T|Ao Vivo/i)?.[0] || null,
      });
    }

    return matches;
  }

  function extractScoreboardStatusNear(flat, endIndex = 0) {
    const slice = flat.slice(Math.max(0, endIndex - 20), endIndex + 160);
    const afterClock = slice.match(/\b\d{1,3}:\d{2}\s+(Intervalo|INTERVALO|Ao\s*Vivo|1T|2T)\b/i);
    if (afterClock) {
      const raw = afterClock[1];
      if (/^INTERVALO$/i.test(raw)) return "Intervalo";
      if (/^Intervalo$/i.test(raw)) return "Intervalo";
      if (/^Ao\s*Vivo$/i.test(raw)) return "Ao Vivo";
      return raw;
    }
    if (/\bINTERVALO\b/i.test(slice) || /\bIntervalo\b/.test(slice)) return "Intervalo";
    return null;
  }

  function collectSpacedScoreboardMatches(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    const matches = [];
    const re = new RegExp(SPACED_SCOREBOARD_RE.source, "g");
    let m;

    while ((m = re.exec(flat)) !== null) {
      const scoreHome = parseInt(m[2], 10);
      const scoreAway = parseInt(m[3], 10);
      if (scoreHome > 30 || scoreAway > 30) continue;

      matches.push({
        homeTeam: normalize(m[1]),
        awayTeam: normalize(m[4]),
        score: `${scoreHome}-${scoreAway}`,
        scoreHome,
        scoreAway,
        clock: m[5],
        status:
          extractScoreboardStatusNear(flat, m.index + m[0].length) ||
          flat.match(/Intervalo|INTERVALO|1T|2T|Ao Vivo/i)?.[0] ||
          null,
      });
    }

    return matches;
  }

  function inferMatchStatusFromScoreboard(match, scoreboardText = "") {
    if (!match || match.status) return match;
    const flat = String(scoreboardText || "").replace(/\s+/g, " ");
    const clock = String(match.clock || "");
    const clockIndex = clock ? flat.indexOf(clock) : -1;
    const status =
      clockIndex >= 0
        ? extractScoreboardStatusNear(flat, clockIndex + clock.length)
        : extractScoreboardStatusNear(flat, flat.length);
    if (!status) return match;
    if (status === "Intervalo" && !/^45:\d{2}$/.test(clock) && clock !== "45:00") return match;
    return { ...match, status };
  }

  function parseHalftimeScore(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    const result = flat.match(/Resultado Após Primeira Parte\s*(\d+)\s*[-–]\s*(\d+)/i);
    if (!result) return null;

    return {
      score: `${result[1]}-${result[2]}`,
      scoreHome: +result[1],
      scoreAway: +result[2],
      status: flat.match(/Intervalo|INTERVALO/i)?.[0] || null,
      clock: flat.match(/\d{1,2}:\d{2}/)?.[0] || null,
    };
  }

  function parseMatchFromLines(text, extractedAt) {
    const lines = linesFromText(text);
    const scores = [];
    const clocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\d{1,2}\s*[-–]\s*\d{1,2}$/.test(line)) {
        const parts = line.split(/\s*[-–]\s*/);
        scores.push({
          score: `${parts[0]}-${parts[1]}`,
          scoreHome: +parts[0],
          scoreAway: +parts[1],
          lineIndex: i,
        });
      }

      if (
        i + 2 < lines.length &&
        /^\d{1,2}$/.test(line) &&
        /^[-–]$/.test(lines[i + 1]) &&
        /^\d{1,2}$/.test(lines[i + 2])
      ) {
        scores.push({
          score: `${line}-${lines[i + 2]}`,
          scoreHome: +line,
          scoreAway: +lines[i + 2],
          lineIndex: i,
        });
      }

      if (/^\d{1,3}:\d{2}$/.test(line)) {
        clocks.push({ clock: line, minutes: parseClockMinutes(line), lineIndex: i });
      }

      if (/^\d{1,3}'$/.test(line)) {
        const mins = parseInt(line, 10);
        clocks.push({ clock: `${mins}:00`, minutes: mins * 100, lineIndex: i });
      }
    }

    if (!scores.length) return null;

    const bestScore = scores[scores.length - 1];
    const bestClock = pickBestClock(clocks, extractedAt);

    let status = null;
    for (const l of lines) {
      if (/^(INTERVALO|Intervalo|1T|2T|HT|FT|Ao Vivo)$/i.test(l)) {
        status = l;
        break;
      }
    }

    return {
      score: bestScore.score,
      scoreHome: bestScore.scoreHome,
      scoreAway: bestScore.scoreAway,
      clock: bestClock?.clock || null,
      status,
    };
  }

  function isMergeOptions(value) {
    return (
      value &&
      typeof value === "object" &&
      "extractedAt" in value &&
      !("score" in value) &&
      !("scoreHome" in value)
    );
  }

  function mergeMatchCandidates(...args) {
    let options = {};
    if (isMergeOptions(args[args.length - 1])) {
      options = args.pop();
    }
    return sanitizeMatchClock(pickBestMatch(args.filter(Boolean), options), options.extractedAt);
  }

  function filterMatchCandidatesForPage(candidates, pageUrl) {
    if (!isBet365PreMatchUrl(pageUrl)) return candidates || [];
    return [];
  }

  function stripPreMatchScore(match, pageUrl) {
    if (!isBet365PreMatchUrl(pageUrl) || !match) return match;
    return {
      ...match,
      score: null,
      scoreHome: null,
      scoreAway: null,
      clock: null,
      status: null,
      preMatch: true,
    };
  }

  function resolveMatchForPage(candidates, options = {}) {
    const { extractedAt, pageUrl } = options;
    const filtered = filterMatchCandidatesForPage(candidates, pageUrl);
    const merged = sanitizeMatchClock(pickBestMatch(filtered, { extractedAt }), extractedAt);
    if (isBet365PreMatchUrl(pageUrl)) {
      return stripPreMatchScore(merged, pageUrl) ?? { score: null, clock: null, preMatch: true };
    }
    return merged;
  }

  function parseGluedMatch(text) {
    const best = pickBestMatch(collectGluedMatches(text));
    if (best) return best;
    return parseHalftimeScore(text);
  }

  const COMPETITION_RE =
    /(Copa do Mundo \d{4}|Champions League|Premier League|La Liga|Serie A|Bundesliga|Ligue 1)/i;

  const DRAW_SELECTION_RE = /^(empate|draw|tie|x)$/i;

  function extractPageTextFromMerged(text) {
    const chunks = String(text || "").split(/---PAGE---/);
    if (chunks.length > 1) {
      return [...chunks.slice(1)].sort((a, b) => b.length - a.length)[0] || chunks[0];
    }
    return String(text || "").split(/---SIDE-TAB---/)[0] || String(text || "");
  }

  function extractHeaderSlice(text, maxLines = 30) {
    return linesFromText(extractPageTextFromMerged(text)).slice(0, maxLines).join("\n");
  }

  function parseVsLineStrict(text) {
    for (const line of linesFromText(text)) {
      const m = line.match(
        /^([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})\s+v\s+([A-Za-zÀ-ú][A-Za-zÀ-ú'. -]{2,40})$/i
      );
      if (!m) continue;
      return { homeTeam: normalize(m[1]), awayTeam: normalize(m[2]) };
    }
    return null;
  }

  function extractCompetitionFromText(text) {
    return String(text || "").match(COMPETITION_RE)?.[0] || null;
  }

  function extractTeamsFromResultadoFinalOdds(odds) {
    const selections = [];
    const seen = new Set();

    for (const row of odds || []) {
      if (!/^resultado\s*final$/i.test(String(row?.market || "").trim())) continue;
      const selection = normalize(row?.selection);
      if (!selection || DRAW_SELECTION_RE.test(selection) || seen.has(selection)) continue;
      seen.add(selection);
      selections.push(selection);
      if (selections.length >= 2) break;
    }

    if (selections.length < 2) return null;
    return { homeTeam: selections[0], awayTeam: selections[1] };
  }

  function resolveMatchTeams(match = {}, options = {}) {
    const { headerText = "", odds = [], domHeader = null } = options;
    const headerSlice = extractHeaderSlice(headerText || "");
    const fromDom =
      domHeader?.homeTeam && domHeader?.awayTeam
        ? { homeTeam: domHeader.homeTeam, awayTeam: domHeader.awayTeam }
        : null;
    const fromOdds = extractTeamsFromResultadoFinalOdds(odds);
    const fromHeader = parseVsLineStrict(headerSlice) || parseVsLineStrict(headerText);
    const fromMatch =
      match.homeTeam && match.awayTeam
        ? { homeTeam: match.homeTeam, awayTeam: match.awayTeam }
        : null;

    const homeTeam =
      fromDom?.homeTeam ||
      fromOdds?.homeTeam ||
      fromMatch?.homeTeam ||
      fromHeader?.homeTeam ||
      null;
    const awayTeam =
      fromDom?.awayTeam ||
      fromOdds?.awayTeam ||
      fromMatch?.awayTeam ||
      fromHeader?.awayTeam ||
      null;
    const competition =
      match.competition ||
      extractCompetitionFromText(headerSlice) ||
      extractCompetitionFromText(headerText) ||
      null;

    return { homeTeam, awayTeam, competition };
  }

  function enrichMatchFromHeader(text, match = {}) {
    const headerSlice = extractHeaderSlice(text);
    const vs = parseVsLineStrict(headerSlice);
    const competition = extractCompetitionFromText(headerSlice) || extractCompetitionFromText(text);

    return {
      ...match,
      homeTeam: match.homeTeam || vs?.homeTeam || null,
      awayTeam: match.awayTeam || vs?.awayTeam || null,
      competition: match.competition || competition || null,
    };
  }

  function linesFromText(text) {
    return text
      .split(/\n|---IFRAME---/)
      .map(normalize)
      .filter(Boolean);
  }

  const MARKET_LINE_RE = /^(Mais de|Menos de|Jogador|Criar Aposta|Resultado Final|Ver$|Craques)/i;

  function extractStatsFromVisibleText(text, pageUrl) {
    const glued = parseGluedStats(text);
    if (glued.length) return glued;
    if (isBet365PreMatchUrl(pageUrl)) return [];

    const lines = linesFromText(text);
    const stats = [];
    const seen = new Set();

    for (const label of STAT_LABELS) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== label && !lines[i].includes(label)) continue;
        if (lines[i] !== label && MARKET_LINE_RE.test(lines[i])) continue;
        const home = lines[i + 1];
        const away = lines[i + 2];
        if (isNum(home) && isNum(away) && isLikelyStatValue(home) && isLikelyStatValue(away)) {
          const key = `${label}|${home}|${away}`;
          if (!seen.has(key)) {
            seen.add(key);
            stats.push({ label, home, away, source: "visible-lines" });
          }
          break;
        }
      }
    }

    return stats;
  }

  function collectMatchCandidatesFromText(text, source, extractedAt, maxLen = 3500) {
    const candidates = [];
    if (!text || text.length > maxLen) return candidates;

    collectGluedMatches(text).forEach((m) => candidates.push({ ...m, source }));
    collectSpacedScoreboardMatches(text).forEach((m) => candidates.push({ ...m, source }));
    const fromLines = parseMatchFromLines(text, extractedAt);
    if (fromLines) candidates.push({ ...fromLines, source });

    return candidates;
  }

  function looksLikeScoreboardText(text, homeTeam, awayTeam) {
    if (!text || text.length < 8 || text.length > 5000) return false;

    const hasGlued = collectGluedMatches(text).length > 0;
    const hasSpaced = collectSpacedScoreboardMatches(text).length > 0;
    const hasSplit = /^\d{1,2}\s*\n\s*[-–]\s*\n\s*\d{1,2}\s*$/m.test(text);
    const hasInline = /^\d{1,2}\s*[-–]\s*\d{1,2}$/m.test(text);
    const hasClock =
      /\b\d{2,3}:\d{2}\b/.test(text) ||
      /^\d{1,3}'$/m.test(text) ||
      /^(INTERVALO|Intervalo|Ao Vivo|1T|2T)$/im.test(text);

    if (!hasGlued && !hasSpaced && !hasSplit && !hasInline) return false;

    if (homeTeam && awayTeam) {
      const homeRe = new RegExp(homeTeam.slice(0, Math.min(homeTeam.length, 8)), "i");
      const awayRe = new RegExp(awayTeam.slice(0, Math.min(awayTeam.length, 8)), "i");
      return homeRe.test(text) && awayRe.test(text);
    }

    return hasClock || /\s+v\s+/i.test(text);
  }

  function extractMatchFromFrameChunks(frames, extractedAt, options = {}) {
    const candidates = [];
    const { homeTeam, awayTeam } = options;

    for (const frame of frames || []) {
      const text = frame?.text;
      if (!text) continue;

      const source = frame.source || "frame-scoreboard";
      const chunkCandidates = collectMatchCandidatesFromText(text, source, extractedAt, 3500);

      if (!chunkCandidates.length) {
        if (!looksLikeScoreboardText(text, homeTeam, awayTeam)) continue;
      } else {
        candidates.push(...chunkCandidates);
      }
    }

    const best = pickBestMatch(candidates, { extractedAt });
    return best ? sanitizeMatchClock(best, extractedAt) : null;
  }

  function extractMatchFromVisibleText(text) {
    const match =
      mergeMatchCandidates(...collectGluedMatches(text), parseMatchFromLines(text)) ||
      parseHalftimeScore(text);

    if (match) return enrichMatchFromHeader(text, match);

    return enrichMatchFromHeader(text, {
      homeTeam: null,
      awayTeam: null,
      score: null,
      clock: null,
      status: null,
      competition: null,
    });
  }

  function parseOdd(v) {
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  function isLineValue(s) {
    return /^[+-]?\d+([.,]\d+)?$/.test(s);
  }

  function isTotalsLineValue(s) {
    const n = String(s || "").replace(",", ".");
    return /^[+-]?\d+(\.5)$/.test(n) || /^[+-]?\d{1,2}$/.test(n);
  }

  function isValidOdd(n) {
    return n >= 1.01 && n <= 501;
  }

  function isValidSelection(s) {
    if (!s || s.length < 2) return false;
    if (isLineValue(s)) return false;
    if (/^\d+[.,]\d+$/.test(s)) return false;
    return /[A-Za-zÀ-ú]/.test(s);
  }

  function isSkippedOddsLine(line) {
    return !line || SKIP_ODDS_LINES.test(line);
  }

  function isCornerBettingMarket(market) {
    const s = normalize(market);
    if (!s) return false;
    if (/^Escanteios(?:\s*-\s*.+)?$/i.test(s)) return true;
    if (/^Mais Escanteios$/i.test(s)) return true;
    if (/^Número de Cartões$/i.test(s)) return true;
    if (/^Cartões\s*-/i.test(s)) return true;
    return false;
  }

  function isStatLabel(text) {
    const n = normalize(text);
    if (!n) return false;
    if (isCornerBettingMarket(n)) return false;
    if (STAT_LABELS.some((label) => n === label)) return true;
    if (STAT_LABELS.some((label) => label.includes(" ") && n.includes(label))) return true;
    return STAT_LABEL_RE.test(n);
  }

  function isValidTotalsLine(value) {
    if (!isLineValue(value)) return false;
    const n = parseFloat(String(value).replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 7.5;
  }

  function isTimelineLeakMarket(market) {
    const s = normalize(market);
    if (!s) return false;
    if (/^\d+°\s*Gol$/i.test(s)) return false;
    if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
    if (/^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]*\s-\s(?:Chute|Assist)$/i.test(s)) return true;
    if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
    return false;
  }

  function isTimelineLeakSelection(selection) {
    const s = normalize(selection);
    if (!s) return false;
    if (TIMELINE_LEAK_SELECTION_RE.test(s)) return true;
    if (TIMELINE_LEAK_MARKET_RE.test(s)) return true;
    if (/^Perdeu o P[eê]nalti$/i.test(s)) return true;
    return false;
  }

  function isLikelyTeamNameSelection(selection) {
    return /^(Argentina|Áustria|Austria|Uruguai|Brasil|França|France|Alemanha|Germany|Portugal|Inglaterra|England)$/i.test(
      normalize(selection)
    );
  }

  function isLikelyScoreboardSelection(selection) {
    const s = normalize(selection);
    if (/Resultado Após|Primeira Parte|Intervalo/i.test(s)) return true;
    return /\d+\s*[-–]\s*\d+/.test(s);
  }

  function isLikelyStatCountAsOdd(odd, market, selection) {
    if (!isPlayerPropMarket(market)) return false;
    if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 20) return false;
    const sel = normalize(selection);
    if (/\s-\s\d{1,2}\+$/.test(sel)) return false;
    return /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(sel);
  }

  function isLikelyMinuteAsOdd(odd, market, selection) {
    if (!Number.isFinite(odd) || !Number.isInteger(odd) || odd < 1 || odd > 120) return false;
    if (isTimelineLeakMarket(market) || isTimelineLeakSelection(selection)) return true;
    if (isLikelyTeamNameSelection(selection)) return true;
    if (isLikelyScoreboardSelection(selection)) return true;
    const sel = normalize(selection);
    if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && isTimelineLeakMarket(market)) return true;
    if (PLAYER_SHORT_ODDS_NAME_RE.test(sel) && /Escanteio/i.test(market || "")) return true;
    return false;
  }

  function isJunkOddsMarket(market) {
    if (!market || market === "—" || market === "Mercado") return true;
    if (market.length > 55) return true;
    if (JUNK_ODDS_MARKETS.test(market)) return true;
    if (LEGAL_FOOTER_MARKET_RE.test(market)) return true;
    if (isCornerBettingMarket(market)) return false;
    if (isStatLabel(market)) return true;
    if (isTimelineLeakMarket(market)) return true;
    return false;
  }

  function isTeamGoalsMarket(market) {
    return / - Gols$/i.test(market || "");
  }

  function isPlayerPropMarket(market) {
    return /^Jogador\s*-/i.test(market || "");
  }

  function isJunkTeamGoalsSelection(market, selection) {
    if (!isTeamGoalsMarket(market)) return false;
    return !/^(Mais de|Menos de)\s+\d/.test(normalize(selection));
  }

  function isJunkPlayerPropSelection(market, selection) {
    if (!isPlayerPropMarket(market)) return false;
    return /^(Mais de|Menos de)\s+/i.test(normalize(selection));
  }

  function isPlayerGridColumnHeader(line) {
    const s = normalize(line);
    if (!s) return false;
    if (/^\d{1,2}\+$/.test(s)) return true;
    if (s === "1+") return true;
    return false;
  }

  function normalizePlayerGridColumn(line) {
    const s = normalize(line);
    if (/^\d{1,2}\+$/.test(s)) return s;
    if (s === "1") return "1+";
    return s;
  }

  function collectPlayerGridColumns(lines, start) {
    const columns = [];
    let i = start;

    if (lines[i] === "1" && isPlayerGridColumnHeader(lines[i + 1])) {
      columns.push("1+");
      i++;
    }

    while (i < lines.length && isPlayerGridColumnHeader(lines[i])) {
      columns.push(normalizePlayerGridColumn(lines[i]));
      i++;
    }

    return { columns, nextIndex: i };
  }

  function isLikelyPlayerNameLine(line) {
    return (
      isValidSelection(line) &&
      /^[A-Za-zÀ-ú][A-Za-zÀ-ú' .-]{2,}$/.test(line) &&
      !isPlayerGridColumnHeader(line) &&
      !/^Jogador\b/i.test(line)
    );
  }

  function consumePlayerPropRow(lines, start, columns, market, pushOdd) {
    if (!columns.length) return null;

    let i = start;
    if (/^\d{1,2}$/.test(lines[i]) && isLikelyPlayerNameLine(lines[i + 1])) i++;
    const name = lines[i];
    if (!isLikelyPlayerNameLine(name)) return null;
    i++;

    if (/^\d{1,2}$/.test(lines[i]) && !isValidOdd(parseOdd(lines[i]))) i++;

    const values = [];
    while (i < lines.length && values.length < columns.length) {
      const odd = parseOdd(lines[i]);
      if (!isValidOdd(odd)) break;
      values.push(odd);
      i++;
    }

    if (!values.length) return null;

    const count = Math.min(columns.length, values.length);
    for (let c = 0; c < count; c++) {
      pushOdd({
        market,
        selection: `${name} - ${columns[c]}`,
        odds: values[c],
      });
    }

    return i - 1;
  }

  function isJunkOddsSelection(selection) {
    const s = normalize(selection);
    if (!s) return true;
    if (isTimelineLeakSelection(s)) return true;
    if (isLikelyScoreboardSelection(s)) return true;
    if (isStatLabel(s)) return true;
    if (/^Perdeu o\b/i.test(s)) return true;
    if (/^Jogadores Titulares$/i.test(s)) return true;
    if (/^Exibir Totais da Partida$/i.test(s)) return true;
    if (/^\d+°\s/.test(s)) return true;
    if (/^1° Impedimento$/i.test(s)) return true;
    if (/^\d+\s+[A-Za-zÀ-ú]{3,}.*\d/.test(s)) return true;
    if (/^(Mais de|Menos de)\s+/.test(s)) {
      const linePart = s.replace(/^(Mais de|Menos de)\s+/, "");
      return !isValidTotalsLine(linePart);
    }
    return false;
  }

  function isLikelyBettingMarket(market) {
    if (isJunkOddsMarket(market)) return false;
    if (isTimelineLeakMarket(market)) return false;
    if (isCornerBettingMarket(market)) return true;
    if (/^(Empate|Sim|Não|Nenhum)$/i.test(market)) return false;
    if (market.includes(" - ")) return true;
    if (/\s/.test(market)) return BETTING_MARKET_HINTS.test(market);
    return /^(Resultado|Partida|Chance|Total|Marcador|Handicap|Intervalo)/i.test(market);
  }

  function isLikelyShirtNumberPair(selection, oddRaw, lines, oddIndex) {
    if (!/^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(selection)) return false;
    if (!/^\d{1,2}$/.test(String(oddRaw).trim())) return false;
    const n = parseInt(oddRaw, 10);
    if (n < 1 || n > 99) return false;
    const next = lines[oddIndex + 1];
    return Boolean(
      next && /^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(next) && !isValidOdd(parseOdd(next))
    );
  }

  function isHandicapSelectionLine(line, lines, index) {
    if (!/[+-]\d/.test(line)) return false;
    let j = index + 1;
    while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
    return j < lines.length && isValidOdd(parseOdd(lines[j]));
  }

  function isCornerBettingSubMarket(line) {
    const s = normalize(line);
    return /^\d+[º°]\s*Escanteio$/i.test(s) || /^Último$/i.test(s);
  }

  function isLikelyMarketHeader(line, lines, index) {
    if (isSkippedOddsLine(line)) return false;
    if (isTimelineLeakMarket(line)) return false;
    if (isHandicapSelectionLine(line, lines, index)) return false;
    if (isLineValue(line)) return false;
    if (isValidOdd(parseOdd(line))) return false;
    if (line.length < 4) return false;
    if (!/[A-Za-zÀ-ú]/.test(line)) return false;

    let j = index + 1;
    while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
    if (j >= lines.length) return false;

    const next = lines[j];
    if (isLineValue(next)) return isLikelyBettingMarket(line) || line.includes(" - ");
    if (isValidSelection(next) && !isValidOdd(parseOdd(next))) {
      return isLikelyBettingMarket(line);
    }
    return false;
  }

  function parseOddsFromVisibleText(text) {
    const odds = [];
    const seen = new Set();
    const lines = linesFromText(text);
    let market = "—";
    let pendingLines = [];
    let playerNames = [];
    let playerGridColumns = [];
    let inPlayerGrid = false;
    let inCornerGroup = false;
    let cornerSubMarket = null;
    let lastTotalsLine = null;

    function pushOdd(entry) {
      const { market: mkt, selection, odds: odd } = entry;
      if (!isLikelyBettingMarket(mkt)) return;
      if (!isValidOdd(odd)) return;
      if (JUNK_ODDS_SELECTIONS.test(selection)) return;
      if (isJunkTeamGoalsSelection(mkt, selection)) return;
      if (isJunkPlayerPropSelection(mkt, selection)) return;
      if (isJunkOddsSelection(selection)) return;
      if (isLikelyMinuteAsOdd(odd, mkt, selection)) return;
      if (isLikelyStatCountAsOdd(odd, mkt, selection)) return;
      const validSelection = isValidSelection(selection) || /^.+\s-\s\d{1,2}\+$/.test(selection);
      if (!validSelection) return;
      const key = `${mkt}|${selection}|${odd}`;
      if (seen.has(key)) return;
      seen.add(key);
      odds.push({ market: mkt, selection, odds: odd, source: "visible-text" });
    }

    function resetMarketContext() {
      pendingLines = [];
      playerNames = [];
      playerGridColumns = [];
      inPlayerGrid = false;
      inCornerGroup = false;
      cornerSubMarket = null;
      lastTotalsLine = null;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^Escanteios$/i.test(line)) {
        let j = i + 1;
        while (j < lines.length && isSkippedOddsLine(lines[j])) j++;
        if (j < lines.length && isCornerBettingSubMarket(lines[j])) {
          market = line;
          resetMarketContext();
          inCornerGroup = true;
          continue;
        }
      }

      if (inCornerGroup && isCornerBettingSubMarket(line)) {
        cornerSubMarket = line;
        continue;
      }

      if (
        (/^Jogador\s*-/i.test(line) && line.includes(" - ")) ||
        isLikelyMarketHeader(line, lines, i)
      ) {
        market = line;
        resetMarketContext();
        continue;
      }

      if (inCornerGroup && cornerSubMarket && isValidSelection(line)) {
        const odd = parseOdd(lines[i + 1]);
        if (isValidOdd(odd)) {
          pushOdd({
            market: `Escanteios - ${cornerSubMarket}`,
            selection: line,
            odds: odd,
          });
          i++;
          continue;
        }
      }

      if (/^Marcadores/i.test(market)) {
        if (/^A Qualquer Momento$/i.test(line)) {
          let j = i + 1;
          let p = 0;
          while (j < lines.length && p < playerNames.length) {
            const odd = parseOdd(lines[j]);
            if (!isValidOdd(odd)) break;
            pushOdd({ market, selection: playerNames[p], odds: odd });
            p++;
            j++;
          }
          i = j - 1;
          playerNames = [];
          continue;
        }
        if (
          isValidSelection(line) &&
          /^[A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,}$/.test(line) &&
          !/^(Mercado|SUBSTITUI)/i.test(line)
        ) {
          playerNames.push(line);
          continue;
        }
      }

      if (/^Jogador\/Contagem$/i.test(line) && isPlayerPropMarket(market)) {
        const collected = collectPlayerGridColumns(lines, i + 1);
        playerGridColumns = collected.columns;
        inPlayerGrid = playerGridColumns.length > 0;
        i = collected.nextIndex - 1;
        continue;
      }

      if (inPlayerGrid && playerGridColumns.length) {
        const consumed = consumePlayerPropRow(lines, i, playerGridColumns, market, pushOdd);
        if (consumed != null) {
          i = consumed;
          continue;
        }
      }

      if (isSkippedOddsLine(line)) continue;

      if (isLineValue(line) && market !== "—") {
        pendingLines.push(line);
        continue;
      }

      if (/^(Mais de|Menos de)$/i.test(line) && !isPlayerPropMarket(market)) {
        const direction = line;
        const lineAfter = lines[i + 1];
        const oddAfterLine = parseOdd(lines[i + 2]);
        if (isTotalsLineValue(lineAfter) && isValidOdd(oddAfterLine)) {
          pushOdd({
            market,
            selection: `${direction} ${lineAfter}`,
            odds: oddAfterLine,
          });
          lastTotalsLine = lineAfter;
          pendingLines = [lineAfter];
          i += 2;
          continue;
        }
        if (
          /^Menos de$/i.test(direction) &&
          pendingLines.length <= 1 &&
          isValidOdd(parseOdd(lines[i + 1])) &&
          (lastTotalsLine || pendingLines[0])
        ) {
          const lineVal = lastTotalsLine || pendingLines[0];
          pushOdd({
            market,
            selection: `Menos de ${lineVal}`,
            odds: parseOdd(lines[i + 1]),
          });
          i++;
          pendingLines = [];
          continue;
        }
        if (pendingLines.length > 1) {
          let j = i + 1;
          let col = 0;
          while (j < lines.length && col < pendingLines.length) {
            const odd = parseOdd(lines[j]);
            if (!isValidOdd(odd)) break;
            pushOdd({
              market,
              selection: `${direction} ${pendingLines[col]}`,
              odds: odd,
            });
            col++;
            j++;
          }
          i = j - 1;
        } else {
          const odd = parseOdd(lines[i + 1]);
          const lineVal = pendingLines[0];
          const selection = lineVal ? `${direction} ${lineVal}` : direction;
          pushOdd({ market, selection, odds: odd });
          if (lineVal) lastTotalsLine = lineVal;
          i++;
        }
        if (/^Menos de$/i.test(direction)) {
          pendingLines = [];
        }
        continue;
      }

      const odd = parseOdd(lines[i + 1]);
      if (isValidSelection(line) && isValidOdd(odd)) {
        if (isLikelyShirtNumberPair(line, lines[i + 1], lines, i + 1)) {
          i++;
          continue;
        }
        pushOdd({ market, selection: line, odds: odd });
        pendingLines = [];
        i++;
      }
    }

    const selectionOddSeen = new Set([...seen].map((key) => key.slice(key.indexOf("|") + 1)));
    const glued = /([A-Za-zÀ-ú][A-Za-zÀ-ú' ]{2,28})\s+(\d+[.,]\d{1,3})\b/g;
    let m;
    while ((m = glued.exec(text)) !== null) {
      const selection = normalize(m[1]);
      const odd = parseOdd(m[2]);
      if (!isValidSelection(selection) || !isValidOdd(odd)) continue;
      if (JUNK_ODDS_SELECTIONS.test(selection)) continue;
      if (isJunkOddsSelection(selection)) continue;
      const selectionKey = `${selection}|${odd}`;
      if (selectionOddSeen.has(selectionKey)) continue;
      const key = `—|${selectionKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selectionOddSeen.add(selectionKey);
      odds.push({ market: "—", selection, odds: odd, source: "visible-text" });
    }

    return odds;
  }

  function cleanOdds(odds) {
    const filtered = odds.filter(
      (o) =>
        !JUNK_ODDS_SELECTIONS.test(o.selection) &&
        !isJunkOddsMarket(o.market) &&
        !isJunkTeamGoalsSelection(o.market, o.selection) &&
        !isJunkPlayerPropSelection(o.market, o.selection) &&
        !isJunkOddsSelection(o.selection) &&
        !isTimelineLeakMarket(o.market) &&
        !isTimelineLeakSelection(o.selection) &&
        !isLikelyMinuteAsOdd(o.odds, o.market, o.selection) &&
        !isLikelyStatCountAsOdd(o.odds, o.market, o.selection) &&
        o.market !== "Mercado" &&
        o.market !== "—"
    );

    const byKey = new Map();
    filtered.forEach((o) => {
      const key = `${o.selection}|${o.odds}`;
      const prev = byKey.get(key);
      if (!prev || (prev.source !== "dom" && o.source === "dom")) byKey.set(key, o);
    });

    return [...byKey.values()].sort((a, b) => a.market.localeCompare(b.market));
  }

  function mergeOdds(...lists) {
    const flat = lists.flat();
    const domNet = flat.filter(
      (o) => o.source === "dom" || String(o.source || "").startsWith("net:")
    );
    const visible = flat.filter((o) => o.source === "visible-text");

    if (!domNet.length) return cleanOdds(visible);

    const domKeys = new Set(domNet.map((o) => `${o.market}|${o.selection}|${o.odds}`));
    const domMarkets = new Set(domNet.map((o) => o.market));
    const domSelectionsByMarket = new Map();

    domNet.forEach((o) => {
      const selections = domSelectionsByMarket.get(o.market) || new Set();
      selections.add(o.selection);
      domSelectionsByMarket.set(o.market, selections);
    });

    const visibleSupplement = visible.filter((o) => {
      if (!isLikelyBettingMarket(o.market)) return false;
      const key = `${o.market}|${o.selection}|${o.odds}`;
      if (domKeys.has(key)) return false;
      if (domMarkets.has(o.market)) {
        return !domSelectionsByMarket.get(o.market)?.has(o.selection);
      }
      return true;
    });

    return cleanOdds([...domNet, ...visibleSupplement]);
  }

  function mergeStats(...lists) {
    const out = [];
    const seen = new Set();
    lists.flat().forEach((s) => {
      const key = `${s.label}|${s.home}|${s.away}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(s);
    });
    return out;
  }

  function tryExtractMatchFromNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;

    let scoreHome =
      node.scoreHome ?? node.homeScore ?? node.HomeScore ?? node.S1 ?? node.T1G ?? node.HG;
    let scoreAway =
      node.scoreAway ?? node.awayScore ?? node.AwayScore ?? node.S2 ?? node.T2G ?? node.AG;

    const rawScore = node.score ?? node.SC ?? node.SS;
    if (typeof rawScore === "string" && /^\d+\s*[-–]\s*\d+$/.test(rawScore.trim())) {
      const parts = rawScore.trim().split(/\s*[-–]\s*/);
      scoreHome = scoreHome ?? parts[0];
      scoreAway = scoreAway ?? parts[1];
    }

    if (scoreHome == null || scoreAway == null) return null;

    const home = parseInt(String(scoreHome), 10);
    const away = parseInt(String(scoreAway), 10);
    if (!Number.isFinite(home) || !Number.isFinite(away) || home > 30 || away > 30) return null;

    const rawClock = node.clock ?? node.Clock ?? node.TU ?? node.time ?? node.TM ?? node.elapsed;
    let clock = null;
    if (rawClock != null) {
      const s = String(rawClock).trim();
      if (/^\d{1,3}:\d{2}$/.test(s)) clock = s;
      else if (/^\d{1,3}'?$/.test(s)) clock = `${parseInt(s, 10)}:00`;
    }

    return {
      score: `${home}-${away}`,
      scoreHome: home,
      scoreAway: away,
      clock,
      status: node.status ?? node.ST ?? null,
      source: "net",
    };
  }

  function walkBet365Json(node, path, out) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walkBet365Json(v, `${path}[${i}]`, out));
      return;
    }

    if (node._bet365Protocol && Array.isArray(node.segments)) {
      const text = node.segments.map((s) => `${s.key || ""}=${s.value}`).join(";");
      matchCandidatesFromNetworkText(text, "net-text").forEach((m) => out.matches.push(m));
      return;
    }

    const keys = Object.keys(node);
    const kl = keys.map((k) => k.toLowerCase());

    const match = tryExtractMatchFromNode(node);
    if (match) out.matches.push(match);

    if (kl.some((k) => /name|label|stat/.test(k)) && kl.some((k) => /home|h|team1|t1/.test(k))) {
      const label = node.name || node.label || node.stat || node.NA || node.n;
      const home = node.home ?? node.h ?? node.team1 ?? node.T1 ?? node.H;
      const away = node.away ?? node.a ?? node.team2 ?? node.T2 ?? node.A;
      if (label != null && (home != null || away != null)) {
        out.stats.push({
          label: String(label),
          home: String(home ?? ""),
          away: String(away ?? ""),
          source: `net:${path}`,
        });
      }
    }

    if (
      kl.some((k) => /odds|od|price|coef/.test(k)) &&
      kl.some((k) => /name|na|selection|team/.test(k))
    ) {
      const selection = node.name || node.NA || node.selection || node.team;
      const odds = node.odds ?? node.OD ?? node.price ?? node.coef;
      const market = node.market || node.marketName || node.MG || "Mercado";
      if (selection && odds) {
        out.odds.push({
          market: String(market),
          selection: String(selection),
          odds: parseFloat(String(odds).replace(",", ".")) || odds,
          source: `net:${path}`,
        });
      }
    }

    keys.forEach((k) => walkBet365Json(node[k], `${path}.${k}`, out));
  }

  function tagNetworkMatches(out, startIndex, source) {
    for (let i = startIndex; i < out.matches.length; i++) {
      if (!out.matches[i].source || out.matches[i].source === "net") {
        out.matches[i].source = source;
      }
    }
  }

  function ingestNetworkLogEntry(entry, out, extractedAt) {
    const { data, kind = "fetch", hints, url = "" } = entry || {};
    const isBlob = /\/Api\/1\/Blob\b/i.test(url);
    const isZap = /sportspublisher\/zap/i.test(url);
    const source = isZap
      ? "net-ws"
      : isBlob
        ? "net-blob"
        : kind === "ws"
          ? "net-ws"
          : kind === "xhr"
            ? "net-xhr"
            : kind === "fetch"
              ? "net-fetch"
              : "net-text";

    if (hints?.match) {
      out.matches.push({ ...hints.match, source: hints.match.source || source });
    }

    if (typeof data === "string") {
      const parsed = parseNetworkPayload(data);
      if (parsed && typeof parsed === "object") {
        const start = out.matches.length;
        walkBet365Json(parsed, "root", out);
        tagNetworkMatches(out, start, source);
      }
      matchCandidatesFromNetworkText(data, source).forEach((m) => out.matches.push(m));
      return;
    }

    if (data && typeof data === "object") {
      const start = out.matches.length;
      walkBet365Json(data, "root", out);
      tagNetworkMatches(out, start, source);
      matchCandidatesFromNetworkText(JSON.stringify(data), source).forEach((m) =>
        out.matches.push(m)
      );
    }
  }

  function extractFromNetworkLog(networkLog, extractedAt) {
    const out = { stats: [], odds: [], matches: [] };
    const seenS = new Set();
    const seenO = new Set();

    (networkLog || []).forEach((entry) => {
      const enriched = { ...entry };
      if (!enriched.hints && typeof enriched.data === "string") {
        enriched.hints = extractNetworkHints(enriched.data, enriched.url);
      }
      if (enriched.hints && !enriched.hints.match && typeof enriched.data === "string") {
        const wire = extractFromBet365WirePayload(
          enriched.data,
          enriched.kind === "ws" ? "net-ws" : "net-blob"
        );
        if (wire) enriched.hints.match = wire;
      }
      ingestNetworkLogEntry(enriched, out, extractedAt);
    });

    return {
      stats: out.stats.filter((s) => {
        const k = `${s.label}|${s.home}|${s.away}`;
        if (seenS.has(k)) return false;
        seenS.add(k);
        return true;
      }),
      odds: out.odds.filter((o) => {
        const k = `${o.market}|${o.selection}|${o.odds}`;
        if (seenO.has(k)) return false;
        seenO.add(k);
        return true;
      }),
      match: sanitizeMatchClock(pickBestMatch(out.matches, { extractedAt }), extractedAt),
    };
  }

  function assessMatchConfidence(match, meta = {}) {
    const warnings = [];
    let confidence = "high";

    if (meta.preMatch || match?.preMatch) {
      return {
        confidence: "n/a",
        warnings: ["Página pré-jogo — placar indisponível"],
      };
    }

    if (!match?.score) {
      warnings.push("Placar não encontrado");
      confidence = "low";
    }

    if (!match?.clock) {
      warnings.push("Minuto de jogo não encontrado");
      if (confidence === "high") confidence = "medium";
    }

    if (match?.clock && isLikelyWallClock(match.clock, match.extractedAt)) {
      warnings.push("Relógio parece horário local, não minuto de jogo");
      confidence = "low";
    }

    if ((meta.visibleTextLength || 0) > 0 && meta.visibleTextLength < 3000) {
      warnings.push("Pouco texto capturado — painel do jogo pode não ter carregado");
      if (confidence === "high") confidence = "medium";
    }

    if ((meta.statsCount || 0) > 0 && !match?.score) {
      warnings.push("Stats OK mas placar ausente — scoreboard fora do alcance");
      confidence = "low";
    }

    return { confidence, warnings };
  }

  function gatherMatchCandidates(options = {}) {
    const { frameChunks = [], visibleText = "", extractedAt, extraCandidates = [] } = options;
    const candidates = [...extraCandidates];

    for (const frame of frameChunks) {
      candidates.push(
        ...collectMatchCandidatesFromText(
          frame.text,
          frame.source || "frame-scoreboard",
          extractedAt,
          3500
        )
      );
    }

    collectGluedMatches(visibleText).forEach((m) =>
      candidates.push({ ...m, source: "visible-glued" })
    );

    const fromLines = parseMatchFromLines(visibleText, extractedAt);
    if (fromLines) candidates.push({ ...fromLines, source: "visible-lines" });

    return candidates;
  }

  function annotateCandidateRanks(candidates, extractedAt) {
    return (candidates || [])
      .filter((c) => c?.score != null)
      .map((c) => ({
        ...c,
        rank: matchCandidateRank(c, { extractedAt }),
        wallClock: isLikelyWallClock(c.clock, extractedAt),
        clockMinutes: parseClockMinutes(c.clock),
      }))
      .sort((a, b) => b.rank - a.rank);
  }

  function buildClockDebug(candidates, extractedAt) {
    const clocks = (candidates || [])
      .filter((c) => c?.clock)
      .map((c) => ({
        clock: c.clock,
        source: c.source,
        score: c.score,
        minutes: parseClockMinutes(c.clock),
        wallClock: isLikelyWallClock(c.clock, extractedAt),
      }));

    const unique = [...new Map(clocks.map((c) => [`${c.clock}|${c.source}`, c])).values()];
    const filtered = unique.filter((c) => !c.wallClock);
    const best = pickBestClock(
      filtered.map((c) => ({ clock: c.clock, minutes: c.minutes })),
      extractedAt
    );

    return {
      found: unique.length,
      afterWallFilter: filtered.length,
      clocks: unique.slice(0, 25),
      bestClock: best?.clock ?? null,
      extractedAtLocal: extractedAt
        ? new Date(extractedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
        : null,
    };
  }

  function buildSourceBreakdown(stats, odds) {
    const countBySource = (items) => {
      const counts = {};
      for (const item of items || []) {
        const source = item.source || "unknown";
        counts[source] = (counts[source] || 0) + 1;
      }
      return counts;
    };

    return {
      stats: countBySource(stats),
      odds: countBySource(odds),
    };
  }

  function buildNetworkDebugSamples(networkLog, limit = 15) {
    return (networkLog || []).slice(0, limit).map((entry) => {
      const url = String(entry.url || "");
      const hints =
        entry.hints ||
        (typeof entry.data === "string" ? extractNetworkHints(entry.data, entry.url) : null);
      const isIpeBlob = /ipe\/5378|ipe-BR/i.test(url);
      const isZapWs = /sportspublisher\/zap|zap-ws/i.test(url);
      const hintPlayers = Array.isArray(hints?.lineupPlayers) ? hints.lineupPlayers : [];
      const dataText = typeof entry.data === "string" ? entry.data : entry.data?._rawText || "";
      const naSamples = [];
      if (isIpeBlob && dataText) {
        for (const m of dataText.matchAll(/\bNA=([^|;\x00-\x1f\x14]{2,60})/g)) {
          if (naSamples.length >= 12) break;
          naSamples.push(m[1].trim());
        }
      }

      return {
        url: url.slice(0, 220),
        at: entry.at || null,
        kind: entry.kind || "fetch",
        rawLen: entry.rawLen ?? null,
        isIpeBlob,
        isZapWs,
        zapBufferLen: hints?.zapBufferLen ?? null,
        fieldKeys: hints?.fieldKeys || [],
        lineupPlayersCount: hintPlayers.length,
        lineupPlayers: hintPlayers.slice(0, 16).map((p) => p?.name || p),
        naSamples,
        wireMatches: hints?.matches || [],
        wireClocks: hints?.clocks || [],
        wireMatch: hints?.match || null,
        keys:
          entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
            ? Object.keys(entry.data).slice(0, 14)
            : [],
        preview:
          typeof entry.data === "string"
            ? entry.data.slice(0, 320)
            : JSON.stringify(entry.data ?? null).slice(0, 320),
      };
    });
  }

  function buildExtractionDebug({
    matchCandidates = [],
    frameChunks = [],
    visibleText = "",
    marketAnalysis = null,
    marketInference = null,
    extractedAt,
    meta = {},
    pipeline = [],
    networkLog = [],
    sidePanelBlobDebug = [],
    domProbe = [],
    stats = [],
    odds = [],
    selectedMatch = null,
  }) {
    const ranked = annotateCandidateRanks(matchCandidates, extractedAt);
    const clockDebug = buildClockDebug(matchCandidates, extractedAt);
    const sourceBreakdown = buildSourceBreakdown(stats, odds);
    const networkSamples = buildNetworkDebugSamples(networkLog);

    return {
      extractedAt,
      pipeline,
      frameTextsScanned: frameChunks.length,
      frameSamples: frameChunks.map((f) => ({
        source: f.source,
        href: f.href || null,
        depth: f.depth ?? null,
        len: f.text?.length || 0,
        scoreHint: f.scoreHint ?? null,
        preview: (f.text || "").slice(0, 320),
      })),
      matchCandidates: ranked.slice(0, 20).map((c) => ({
        score: c.score,
        clock: c.clock,
        source: c.source,
        status: c.status || null,
        homeTeam: c.homeTeam || null,
        awayTeam: c.awayTeam || null,
        rank: c.rank,
        wallClock: c.wallClock,
        clockMinutes: c.clockMinutes,
      })),
      selectedMatch:
        selectedMatch?.score != null
          ? {
              score: selectedMatch.score,
              clock: selectedMatch.clock,
              source: selectedMatch.source,
              status: selectedMatch.status || null,
              rank: matchCandidateRank(selectedMatch, { extractedAt }),
              wallClock: isLikelyWallClock(selectedMatch.clock, extractedAt),
            }
          : null,
      clockDebug,
      sourceBreakdown,
      networkSamples,
      sidePanelBlobDebug: (sidePanelBlobDebug || []).slice(0, 6),
      networkBreakdown: (networkLog || []).reduce((acc, entry) => {
        const kind = entry.kind || "fetch";
        acc[kind] = (acc[kind] || 0) + 1;
        return acc;
      }, {}),
      domProbe: (domProbe || []).slice(0, 20),
      marketAnalysis,
      marketInference: marketInference
        ? {
            applied: marketInference.applied,
            analysis: marketInference.analysis,
            previousScore: marketInference.match?.scoreDom || null,
          }
        : null,
      visibleTextLength: visibleText.length,
      visibleTextSample: visibleText.slice(0, 2000),
      rootsScanned: meta.rootsScanned ?? null,
      networkCaptures: meta.networkCaptures ?? networkLog.length,
      tips: meta.tips || [],
    };
  }

  function finalizeMatchData(match, visibleText, meta, extractedAt, pageUrl, options = {}) {
    const preMatch = isBet365PreMatchUrl(pageUrl);
    const headerText = options.headerText || visibleText;
    const teams = resolveMatchTeams(stripPreMatchScore(match, pageUrl), {
      headerText,
      odds: options.odds || [],
      domHeader: options.domHeader || null,
    });
    const enriched = {
      ...stripPreMatchScore(match, pageUrl),
      ...teams,
      extractedAt,
    };
    const confidence = assessMatchConfidence(enriched, {
      ...meta,
      statsCount: meta.statsCount ?? 0,
      preMatch,
    });

    return {
      ...enriched,
      scoreConfidence: confidence.confidence,
      scoreWarnings: confidence.warnings,
    };
  }

  function finalizeMatchWithMarkets(
    match,
    odds,
    visibleText,
    meta,
    extractedAt,
    pageUrl,
    options = {}
  ) {
    const finalized = finalizeMatchData(match, visibleText, meta, extractedAt, pageUrl, {
      ...options,
      odds,
      headerText: options.headerText || visibleText,
    });
    if (isBet365PreMatchUrl(pageUrl)) {
      const analysis = analyzeMarketScore(odds, finalized);
      return {
        match: finalized,
        inference: { match: finalized, analysis, applied: false },
        analysis,
      };
    }
    const inference = applyMarketScoreInference(finalized, odds);
    let result = inference.match;

    if (inference.applied) {
      const warnings = [...(result.scoreWarnings || [])];
      warnings.push(
        `Placar inferido por mercados (mín. ${inference.analysis.minTotalGoals} gols).`
      );

      let confidence = result.scoreConfidence;
      if (!result.clock && confidence === "high") confidence = "medium";

      result = {
        ...result,
        scoreConfidence: confidence,
        scoreWarnings: warnings,
      };
    }

    return { match: result, inference, analysis: inference.analysis };
  }

  function slugifyFilenamePart(text) {
    if (!text) return null;
    return String(text)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
  }

  function buildBet365Slug(data) {
    const m = data?.match || {};
    const parts = [m.homeTeam, m.awayTeam]
      .filter(Boolean)
      .map((team) => slugifyFilenamePart(team))
      .filter(Boolean);
    if (parts.length >= 2) return parts.join("-");
    if (m.eventId) return slugifyFilenamePart(m.eventId) || "jogo";
    return parts[0] || "jogo";
  }

  function slugifyClockPart(clock) {
    if (!clock) return "sem-tempo";
    const normalized = String(clock).trim().replace(/:/g, "-").replace(/\+/g, "mais");
    return slugifyFilenamePart(normalized) || "sem-tempo";
  }

  function buildBet365Filename(data, ext, isoDate = new Date().toISOString()) {
    const m = data?.match || {};
    const competition = slugifyFilenamePart(m.competition) || "campeonato";
    const game = buildBet365Slug(data);
    const score = slugifyFilenamePart(m.score) || "sem-placar";
    const clock = slugifyClockPart(m.clock);
    const ts = (m.extractedAt || isoDate)
      .replace(/\.\d{3}Z?$/i, "")
      .replace(/Z$/i, "")
      .replace("T", "_")
      .replace(/:/g, "-");
    return `${competition}-${game}-${score}-${clock}-${ts}.${ext}`;
  }

  function formatBet365Logs(data) {
    const m = data?.match || {};
    const meta = data?.meta || {};
    const debug = meta.debug || {};
    const stats = data?.stats || [];
    const odds = data?.odds || [];
    const inference = m.scoreInference;

    const lines = [
      `=== BET365 EXTRACT v${meta.version || "?"} ===`,
      `Jogo: ${m.homeTeam ?? "?"} vs ${m.awayTeam ?? "?"}`,
      `Competição: ${m.competition ?? "—"}`,
      `Placar: ${m.score ?? "—"} | ${m.clock ?? "—"} | ${m.status ?? "—"}`,
      `Confiança: ${m.scoreConfidence ?? meta.scoreConfidence ?? "—"}`,
      `Origem placar: ${m.scoreInferredFrom ?? (m.scoreDom ? "dom+markets" : "dom/text")}`,
    ];

    if (m.scoreDom && m.scoreDom !== m.score) {
      lines.push(`Placar DOM original: ${m.scoreDom}`);
    }

    const warnings = m.scoreWarnings || meta.scoreWarnings || [];
    if (warnings.length) {
      lines.push(`Avisos: ${warnings.join(" | ")}`);
    }

    if (debug.selectedMatch) {
      lines.push(
        `Candidato escolhido: ${debug.selectedMatch.score} (${debug.selectedMatch.source}, rank=${debug.selectedMatch.rank})`
      );
    }

    const breakdown = debug.sourceBreakdown;
    if (breakdown) {
      const fmt = (obj) =>
        Object.entries(obj || {})
          .map(([k, v]) => `${k}:${v}`)
          .join(", ");
      lines.push(`Fontes stats: ${fmt(breakdown.stats) || "—"}`);
      lines.push(`Fontes odds: ${fmt(breakdown.odds) || "—"}`);
    }

    if (inference?.reasons?.length) {
      lines.push("", "--- INFERÊNCIA MERCADOS ---", ...inference.reasons);
    }

    const sidePanel = data?.sidePanel || {};
    const timeline = sidePanel.timeline || [];
    const lineup = sidePanel.lineup;
    const finals = sidePanel.playerFinalizations || [];
    const areas = sidePanel.actionAreas;

    lines.push(
      "",
      "--- PAINEL LATERAL ---",
      `Cronologia: ${timeline.length} evento(s)`,
      `Escalação: ${
        lineup
          ? `casa ${lineup.home?.starters?.length ?? 0} tit. / fora ${lineup.away?.starters?.length ?? 0} tit.`
          : "não capturada"
      }`,
      `Finalizações: ${finals.length} jogador(es)`,
      areas
        ? `Áreas de Ação: E ${areas.left} | C ${areas.center} | D ${areas.right}`
        : "Áreas de Ação: —"
    );

    if (timeline.length) {
      lines.push(
        "",
        "--- CRONOLOGIA ---",
        ...timeline.map(
          (e) => `${e.minute ?? "?"}' [${e.type}] ${e.description} (${e.source || "?"})`
        )
      );
    }

    if (finals.length) {
      lines.push(
        "",
        "--- FINALIZAÇÕES ---",
        ...finals.map((r) => `${r.player}: ${r.shots} chutes, ${r.onTarget} no gol`)
      );
    }

    if (lineup) {
      lines.push(
        "",
        "--- ESCALAÇÃO (casa) ---",
        ...(lineup.home?.starters || []).map((p) => `  ${p}`),
        "Suplentes:",
        ...(lineup.home?.subs || []).map((p) => `  ${p}`),
        "",
        "--- ESCALAÇÃO (fora) ---",
        ...(lineup.away?.starters || []).map((p) => `  ${p}`),
        "Suplentes:",
        ...(lineup.away?.subs || []).map((p) => `  ${p}`)
      );
    }

    lines.push(
      "",
      "--- STATS ---",
      ...stats.map((s) => `${s.label}: ${s.home} | ${s.away} (${s.source || "?"})`),
      "",
      "--- ODDS ---",
      ...odds.map((o) => `${o.market} | ${o.selection}: ${o.odds} (${o.source || "?"})`)
    );

    return lines.join("\n");
  }

  function formatBet365DebugLogs(data) {
    const m = data?.match || {};
    const meta = data?.meta || {};
    const debug = meta.debug || {};
    const analysis = debug.marketAnalysis || m.scoreInference || null;

    const lines = [
      `=== BET365 DEBUG v${meta.version || "?"} ===`,
      `extractedAt: ${m.extractedAt ?? "—"}`,
      `url: ${m.url ?? "—"}`,
      `eventId: ${m.eventId ?? "—"}`,
      "",
      "--- AMBIENTE ---",
      `version: ${meta.version ?? "—"}`,
      `rootsScanned: ${meta.rootsScanned ?? debug.rootsScanned ?? "—"}`,
      `frameTextsScanned: ${meta.frameTextsScanned ?? debug.frameTextsScanned ?? "—"}`,
      `networkCaptures: ${meta.networkCaptures ?? debug.networkCaptures ?? "—"}`,
      `networkBridge: ${meta.networkBridge ?? "—"}`,
      `visibleTextLength: ${meta.visibleTextLength ?? debug.visibleTextLength ?? "—"}`,
      `statsCount: ${meta.statsCount ?? data.stats?.length ?? 0}`,
      `oddsCount: ${meta.oddsCount ?? data.odds?.length ?? 0}`,
      `sidePanelTimeline: ${meta.sidePanelTimelineCount ?? data.sidePanel?.timeline?.length ?? 0}`,
      `sidePanelLineup: ${(meta.sidePanelLineupCaptured ?? Boolean(data.sidePanel?.lineup)) ? "yes" : "no"}`,
      `sidePanelFinalizations: ${meta.sidePanelFinalizationsCount ?? data.sidePanel?.playerFinalizations?.length ?? 0}`,
      "",
      "--- PLACAR ---",
      `score: ${m.score ?? "—"}`,
      `scoreDom: ${m.scoreDom ?? "—"}`,
      `scoreInferredFrom: ${m.scoreInferredFrom ?? "—"}`,
      `clock: ${m.clock ?? "—"}`,
      `status: ${m.status ?? "—"}`,
      `scoreConfidence: ${m.scoreConfidence ?? "—"}`,
    ];

    if (m.scoreWarnings?.length) {
      lines.push("warnings:", ...m.scoreWarnings.map((w) => `  - ${w}`));
    }

    if (debug.selectedMatch) {
      lines.push(
        "",
        "--- CANDIDATO ESCOLHIDO ---",
        `score: ${debug.selectedMatch.score ?? "—"}`,
        `clock: ${debug.selectedMatch.clock ?? "—"}`,
        `source: ${debug.selectedMatch.source ?? "—"}`,
        `rank: ${debug.selectedMatch.rank ?? "—"}`,
        `wallClock: ${debug.selectedMatch.wallClock ?? "—"}`
      );
    }

    if (debug.clockDebug) {
      const cd = debug.clockDebug;
      lines.push(
        "",
        "--- RELÓGIOS ---",
        `found: ${cd.found ?? 0}`,
        `afterWallFilter: ${cd.afterWallFilter ?? 0}`,
        `bestClock: ${cd.bestClock ?? "—"}`,
        `extractedAtLocal: ${cd.extractedAtLocal ?? "—"}`
      );
      if (cd.clocks?.length) {
        cd.clocks.forEach((c, i) => {
          lines.push(
            `${i + 1}. ${c.clock} | ${c.source} | score=${c.score ?? "?"} | wall=${c.wallClock}`
          );
        });
      }
    }

    if (debug.sourceBreakdown) {
      const fmt = (obj) =>
        Object.entries(obj || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
      lines.push(
        "",
        "--- FONTES ---",
        `stats: ${fmt(debug.sourceBreakdown.stats) || "—"}`,
        `odds: ${fmt(debug.sourceBreakdown.odds) || "—"}`
      );
    }

    if (analysis) {
      lines.push(
        "",
        "--- ANÁLISE MERCADOS ---",
        `nextGoalMarkets: ${JSON.stringify(analysis.nextGoalMarkets ?? [])}`,
        `minTotalGoals: ${analysis.minTotalGoals ?? "—"}`,
        `domTotalGoals: ${analysis.domTotalGoals ?? "—"}`,
        `drawFavored: ${analysis.drawFavored ?? "—"}`,
        `consistent: ${analysis.consistent ?? "—"}`
      );
      if (analysis.reasons?.length) {
        lines.push("reasons:", ...analysis.reasons.map((r) => `  - ${r}`));
      }
    }

    if (debug.matchCandidates?.length) {
      lines.push("", "--- CANDIDATOS PLACAR (rank) ---");
      debug.matchCandidates.forEach((c, i) => {
        lines.push(
          `${i + 1}. rank=${c.rank ?? "?"} | ${c.score ?? "?"} | ${c.clock ?? "—"} | ${c.source ?? "?"} | wall=${c.wallClock ?? "?"}`
        );
      });
    }

    if (debug.domProbe?.length) {
      lines.push("", "--- DOM PROBE ---");
      debug.domProbe.forEach((d, i) => {
        lines.push(`${i + 1}. ${d.sel} | hits=${d.hits} | source=${d.source}`);
        (d.samples || []).forEach((s) => lines.push(`    > ${s.replace(/\n/g, "\\n")}`));
      });
    }

    if (debug.networkBreakdown && Object.keys(debug.networkBreakdown).length) {
      lines.push(
        "",
        "--- NETWORK BREAKDOWN ---",
        Object.entries(debug.networkBreakdown)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      );
    }

    if (debug.networkSamples?.length) {
      lines.push("", "--- NETWORK SAMPLES ---");
      debug.networkSamples.forEach((n, i) => {
        lines.push(`${i + 1}. [${n.kind || "?"}] ${n.url}`);
        if (n.rawLen != null) lines.push(`    rawLen: ${n.rawLen}`);
        if (n.isIpeBlob) lines.push(`    ipeBlob: yes`);
        if (n.fieldKeys?.length) lines.push(`    fields: ${n.fieldKeys.join(", ")}`);
        if (n.lineupPlayersCount != null) {
          lines.push(`    hintLineupPlayers: ${n.lineupPlayersCount}`);
          if (n.lineupPlayers?.length) lines.push(`    hintPlayers: ${n.lineupPlayers.join(", ")}`);
        }
        if (n.naSamples?.length) lines.push(`    naSamples: ${n.naSamples.join(", ")}`);
        if (n.wireMatch)
          lines.push(`    wireMatch: ${n.wireMatch.score} @ ${n.wireMatch.clock ?? "—"}`);
        if (n.wireMatches?.length) lines.push(`    wireScores: ${JSON.stringify(n.wireMatches)}`);
        if (n.wireClocks?.length) lines.push(`    wireClocks: ${n.wireClocks.join(", ")}`);
        if (n.keys?.length) lines.push(`    keys: ${n.keys.join(", ")}`);
        if (n.preview) lines.push(`    preview: ${n.preview}`);
      });
    } else {
      lines.push("", "--- NETWORK SAMPLES ---", "(nenhuma captura relevante)");
    }

    if (debug.frameSamples?.length) {
      lines.push("", "--- FRAMES ---");
      debug.frameSamples.forEach((f, i) => {
        lines.push(
          `${i + 1}. [${f.source}] len=${f.len} depth=${f.depth ?? "—"} href=${f.href ?? "—"}`
        );
        if (f.preview) lines.push(`    preview: ${f.preview.replace(/\n/g, "\\n")}`);
      });
    } else {
      lines.push("", "--- FRAMES ---", "(nenhum frame com placar capturado)");
    }

    if (debug.marketInference) {
      lines.push(
        "",
        "--- INFERÊNCIA APLICADA ---",
        `applied: ${debug.marketInference.applied}`,
        `previousScore: ${debug.marketInference.previousScore ?? "—"}`
      );
    }

    if (debug.pipeline?.length) {
      lines.push("", "--- PIPELINE (resumo) ---");
      debug.pipeline.forEach((p) => {
        lines.push(
          `${p.step}: ${p.detail ?? ""}${p.ms != null ? ` (${p.ms}ms)` : ""}${p.count != null ? ` count=${p.count}` : ""}`
        );
      });
    }

    const sidePanel = data?.sidePanel || {};
    if (sidePanel.tabCapture && Object.keys(sidePanel.tabCapture).length) {
      lines.push("", "--- SIDE PANEL TABS ---");
      Object.entries(sidePanel.tabCapture).forEach(([k, v]) => {
        lines.push(`${k}: len=${v.length} captured=${v.captured}`);
      });
    }
    if (sidePanel.timeline?.length) {
      lines.push("", "--- SIDE PANEL TIMELINE ---");
      sidePanel.timeline.forEach((e, i) => {
        lines.push(`${i + 1}. ${e.minute ?? "?"}' [${e.type}] ${e.description} (${e.source})`);
      });
    }
    if (sidePanel.network?.playerNames?.length) {
      lines.push("", "--- SIDE PANEL NETWORK HINTS ---", sidePanel.network.playerNames.join(", "));
    }

    if (debug.sidePanelBlobDebug?.length) {
      lines.push("", "--- LINEUP WIRE DEBUG ---");
      debug.sidePanelBlobDebug.forEach((b, i) => {
        const isZap = b.source === "zap-ws";
        const label = isZap ? "zap-ws" : "ipe/5378";
        if (isZap) {
          lines.push(
            `${i + 1}. [${label}] messages=${b.messageCount ?? 0} mergedLen=${b.mergedLen ?? "—"} largest=${b.largestMessage ?? "—"} hintLineup=${b.hintLineupCount ?? 0} wirePlayers=${b.wirePlayerCount ?? 0} lineupParsed=${b.lineupParsed ? "yes" : "no"}`
          );
        } else {
          lines.push(
            `${i + 1}. [${label}] [${b.kind || "?"}] rawLen=${b.rawLen ?? "—"} storedLen=${b.storedLen ?? "—"} hintLineup=${b.hintLineupCount ?? 0} wirePlayers=${b.wirePlayerCount ?? 0} naPlayerLike=${b.naPlayerLikeCount ?? 0} lineupParsed=${b.lineupParsed ? "yes" : "no"}`
          );
        }
        if (b.url) lines.push(`    url: ${b.url}`);
        if (b.fieldKeys?.length) lines.push(`    fields: ${b.fieldKeys.join(", ")}`);
        if (b.hintLineupPlayers?.length) {
          lines.push(`    hintLineupPlayers: ${b.hintLineupPlayers.map((p) => p.name).join(", ")}`);
        }
        if (b.wirePlayers?.length) {
          lines.push(
            `    wirePlayers: ${b.wirePlayers.map((p) => `${p.name}${p.team != null ? `(T${p.team})` : ""}`).join(", ")}`
          );
        }
        if (b.naSamples?.length) {
          const sample = b.naSamples
            .filter((s) => s.playerLike)
            .map((s) => s.name)
            .slice(0, 16);
          if (sample.length) lines.push(`    naPlayerLike: ${sample.join(", ")}`);
          const junk = b.naSamples
            .filter((s) => !s.playerLike)
            .map((s) => s.name)
            .slice(0, 8);
          if (junk.length) lines.push(`    naOther: ${junk.join(", ")}`);
        }
        if (b.messageSamples?.length) {
          b.messageSamples.slice(0, 3).forEach((m, j) => {
            lines.push(`    msg[${j}]: rawLen=${m.rawLen ?? "—"} ${m.preview ?? ""}`);
          });
        }
        if (b.wireRecordSamples?.length) {
          lines.push(`    wireRecord[0]: ${b.wireRecordSamples[0]}`);
        }
        if (b.lineupStarters) {
          lines.push(
            `    lineupStarters: home=${b.lineupStarters.home} away=${b.lineupStarters.away} (${b.lineupStarters.source})`
          );
        }
        if (b.finalsCount) {
          lines.push(
            `    finals: ${b.finalsSample?.map((f) => `${f.player} ${f.shots}/${f.onTarget}`).join(", ")}`
          );
        }
      });
    }

    lines.push(
      "",
      "--- VISIBLE TEXT SAMPLE ---",
      debug.visibleTextSample || meta.visibleTextSample || "(vazio)",
      "",
      "--- TIPS ---",
      ...(meta.tips?.length ? meta.tips.map((t) => `- ${t}`) : ["(nenhuma)"])
    );

    return lines.join("\n");
  }

  function formatBet365TraceLogs(data) {
    const m = data?.match || {};
    const meta = data?.meta || {};
    const debug = meta.debug || {};

    const lines = [
      `=== BET365 TRACE v${meta.version || "?"} ===`,
      `extractedAt: ${m.extractedAt ?? debug.extractedAt ?? "—"}`,
      `url: ${m.url ?? "—"}`,
      "",
      "--- PIPELINE ---",
    ];

    if (debug.pipeline?.length) {
      debug.pipeline.forEach((p, i) => {
        const parts = [`${i + 1}. ${p.step}`];
        if (p.ms != null) parts.push(`${p.ms}ms`);
        if (p.count != null) parts.push(`count=${p.count}`);
        if (p.ok != null) parts.push(`ok=${p.ok}`);
        if (p.detail) parts.push(p.detail);
        lines.push(parts.join(" | "));
      });
    } else {
      lines.push("(pipeline não registrado)");
    }

    lines.push("", "--- MERGE DECISION ---");
    if (debug.selectedMatch) {
      lines.push(
        `winner: ${debug.selectedMatch.score} from ${debug.selectedMatch.source} (rank=${debug.selectedMatch.rank})`
      );
      lines.push(`clock kept: ${debug.selectedMatch.clock ?? "null"}`);
      lines.push(`wallClock rejected: ${debug.selectedMatch.wallClock ?? "—"}`);
    } else {
      lines.push("(nenhum candidato selecionado)");
    }

    if (debug.matchCandidates?.length) {
      lines.push("", "--- ALL RANKED CANDIDATES ---");
      debug.matchCandidates.forEach((c, i) => {
        lines.push(
          `${i + 1}. rank=${c.rank} score=${c.score} clock=${c.clock ?? "—"} src=${c.source} wall=${c.wallClock}`
        );
      });
    }

    if (debug.clockDebug) {
      lines.push("", "--- CLOCK FILTER ---");
      lines.push(`local time at extract: ${debug.clockDebug.extractedAtLocal ?? "—"}`);
      lines.push(`candidates before filter: ${debug.clockDebug.found}`);
      lines.push(`after wall-clock filter: ${debug.clockDebug.afterWallFilter}`);
      lines.push(`best clock picked: ${debug.clockDebug.bestClock ?? "—"}`);
    }

    if (debug.domProbe?.length) {
      lines.push("", "--- DOM SELECTORS ---");
      debug.domProbe.forEach((d) => {
        lines.push(`${d.sel}: ${d.hits} hit(s) [${d.source}]`);
      });
    }

    if (debug.networkSamples?.length) {
      lines.push("", "--- NETWORK ---");
      debug.networkSamples.forEach((n, i) => {
        const extra = n.isZapWs
          ? ` zap hintLineup=${n.lineupPlayersCount ?? 0} buf=${n.zapBufferLen ?? "—"}`
          : n.isIpeBlob
            ? ` ipe hintLineup=${n.lineupPlayersCount ?? 0}`
            : "";
        lines.push(`${i + 1}. [${n.kind || "?"}] ${n.at ?? "?"} | ${n.url}${extra}`);
      });
    }

    if (debug.sidePanelBlobDebug?.length) {
      lines.push("", "--- LINEUP WIRE ---");
      debug.sidePanelBlobDebug.forEach((b, i) => {
        const isZap = b.source === "zap-ws";
        const src = isZap ? "zap-ws" : "ipe/5378";
        if (isZap) {
          lines.push(
            `${i + 1}. [${src}] msgs=${b.messageCount ?? 0} merged=${b.mergedLen ?? "—"} hint=${b.hintLineupCount ?? 0} wire=${b.wirePlayerCount ?? 0} parsed=${b.lineupParsed ? "yes" : "no"}`
          );
        } else {
          lines.push(
            `${i + 1}. [${src}] hint=${b.hintLineupCount ?? 0} wire=${b.wirePlayerCount ?? 0} naLike=${b.naPlayerLikeCount ?? 0} parsed=${b.lineupParsed ? "yes" : "no"} rawLen=${b.rawLen ?? "—"}`
          );
        }
        if (b.hintLineupPlayers?.length) {
          lines.push(
            `    hints: ${b.hintLineupPlayers
              .map((p) => p.name)
              .slice(0, 8)
              .join(", ")}`
          );
        }
      });
    }

    if (debug.marketInference?.applied) {
      lines.push(
        "",
        "--- MARKET OVERRIDE ---",
        `previous: ${debug.marketInference.previousScore}`,
        `final: ${m.score}`,
        ...(debug.marketInference.analysis?.reasons || []).map((r) => `  - ${r}`)
      );
    }

    lines.push(
      "",
      "--- ENV ---",
      `roots=${debug.rootsScanned ?? meta.rootsScanned ?? "?"}`,
      `frames=${debug.frameTextsScanned ?? meta.frameTextsScanned ?? "?"}`,
      `network=${debug.networkCaptures ?? meta.networkCaptures ?? "?"}`,
      `visibleText=${debug.visibleTextLength ?? meta.visibleTextLength ?? "?"}`
    );

    return lines.join("\n");
  }

  const networkLog = [];
  const MAX_NET = 120;

  function receiveNetworkEntry(entry) {
    if (!entry) return;
    const keepRaw =
      typeof entry.data === "string" &&
      (/\/Api\/1\/Blob\b/i.test(entry.url || "") ||
        /sportspublisher\/zap/i.test(entry.url || "") ||
        (entry.data.length || 0) > 4000);
    const normalized = keepRaw
      ? entry.data
      : typeof entry.data === "string"
        ? (parseNetworkPayload(entry.data) ?? { _rawText: entry.data.slice(0, 4000) })
        : entry.data;

    networkLog.unshift({
      url: entry.url,
      at: entry.at || new Date().toISOString(),
      kind: entry.kind || "fetch",
      data: normalized ?? entry.data,
      rawLen: entry.rawLen ?? (typeof entry.data === "string" ? entry.data.length : null),
      hints: entry.hints || null,
    });
    if (networkLog.length > MAX_NET) networkLog.length = MAX_NET;
  }

  function pushNetwork(url, data, kind = "fetch") {
    const u = resolveNetworkUrl(url);
    const normalized =
      typeof data === "string"
        ? (parseNetworkPayload(data) ?? { _rawText: data.slice(0, 4000) })
        : data;

    if (!isBet365NetworkUrl(u) && !looksLikeBet365NetworkPayload(normalized ?? data)) return;

    receiveNetworkEntry({
      url: u || `unknown:${kind}`,
      kind,
      data: normalized ?? data,
      rawLen: typeof data === "string" ? data.length : null,
    });
  }

  function decodeSocketData(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      try {
        return new TextDecoder("utf-8").decode(data);
      } catch (_) {
        return null;
      }
    }
    if (ArrayBuffer.isView(data)) {
      try {
        return new TextDecoder("utf-8").decode(data.buffer);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function installNetworkSniffer() {
    if (window.__bet365SnifferInstalled) return;
    window.__bet365SnifferInstalled = true;

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const clone = res.clone();
          const ct = (clone.headers.get("content-type") || "").toLowerCase();
          const url = resolveNetworkUrl(args[0]);
          if (ct.includes("json")) {
            const data = await clone.json().catch(() => null);
            if (data) pushNetwork(url, data, "fetch");
          } else if (ct.includes("text") || ct.includes("plain") || !ct) {
            const text = await clone.text().catch(() => null);
            if (text) pushNetwork(url, text, "fetch");
          }
        } catch (_) {}
        return res;
      };
    }

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__bet365Url = resolveNetworkUrl(url);
      return XO.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const url = this.__bet365Url || "";
          const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
          const body = this.responseText;
          if (!body) return;
          if (ct.includes("json")) {
            pushNetwork(url, JSON.parse(body), "xhr");
          } else {
            pushNetwork(url, body, "xhr");
          }
        } catch (_) {}
      });
      return XS.apply(this, args);
    };

    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const Bet365WS = function (url, protocols) {
        const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
        const wsUrl = resolveNetworkUrl(url);

        if (isBet365NetworkUrl(wsUrl)) {
          ws.addEventListener("message", (ev) => {
            const text = decodeSocketData(ev.data);
            if (text) pushNetwork(`ws:${wsUrl}`, text, "ws");
          });
        }

        return ws;
      };
      Bet365WS.prototype = OrigWS.prototype;
      Object.defineProperty(Bet365WS, "CONNECTING", { value: OrigWS.CONNECTING });
      Object.defineProperty(Bet365WS, "OPEN", { value: OrigWS.OPEN });
      Object.defineProperty(Bet365WS, "CLOSING", { value: OrigWS.CLOSING });
      Object.defineProperty(Bet365WS, "CLOSED", { value: OrigWS.CLOSED });
      window.WebSocket = Bet365WS;
    }
  }

  function initNetworkBridge() {
    if (window.__bet365NetBridge) return;
    window.__bet365NetBridge = true;

    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.data?.channel !== "bet365-extractor-net") return;
      receiveNetworkEntry(ev.data.entry);
    });
  }

  function injectPageNetworkSniffer(pageSnifferSource) {
    initNetworkBridge();
    const script = document.createElement("script");
    script.textContent = pageSnifferSource;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  installNetworkSniffer();

  function walkWindowFrames(win, depth, out, seen) {
    if (!win || depth > 14 || seen.has(win)) return;
    seen.add(win);

    try {
      const doc = win.document;
      if (!doc) return;

      const text = doc.documentElement?.innerText || doc.body?.innerText || "";
      const href = win.location?.href || "";

      if (text && text.length > 0 && text.length < 8000) {
        out.push({
          text: text.slice(0, 3500),
          href,
          depth,
          source: depth > 0 ? "frame-walk" : "frame-root",
        });
      }

      for (let i = 0; i < win.frames.length; i++) {
        walkWindowFrames(win.frames[i], depth + 1, out, seen);
      }
    } catch (_) {}
  }

  function collectFrameWalkTexts() {
    const out = [];
    const seen = new Set();
    walkWindowFrames(window, 0, out, seen);
    return out.filter(
      (f) =>
        f.depth > 0 || /\d{1,2}\s*[-–]\s*\d{1,2}/.test(f.text) || /\b\d{2,3}:\d{2}\b/.test(f.text)
    );
  }

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
