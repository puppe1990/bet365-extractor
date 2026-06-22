import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildZipEntries, buildZipFilename, sanitizeDownloadFilename } from "../lib/bet365-zip.js";
import { formatBet365DebugLogs, formatBet365TraceLogs } from "../lib/bet365-format.js";

const SAMPLE = {
  match: {
    homeTeam: "Uruguai",
    awayTeam: "Cabo Verde",
    competition: "Copa do Mundo 2026",
    score: "2-2",
    scoreDom: "2-1",
    scoreInferredFrom: "markets",
    eventId: "EV151352326532",
    url: "https://www.bet365.bet.br/#/IP/EV151352326532C1/",
    extractedAt: "2026-06-21T23:30:00.000Z",
    scoreConfidence: "medium",
    scoreWarnings: ["Minuto de jogo não encontrado"],
  },
  stats: [{ label: "xG", home: "1.92", away: "0.14", source: "glued-text" }],
  odds: [
    { market: "5° Gol", selection: "Uruguai", odds: 2.5, source: "dom" },
    { market: "Resultado Final", selection: "Uruguai", odds: 2.62, source: "dom" },
  ],
  meta: {
    version: "3.8.0",
    rootsScanned: 3,
    networkCaptures: 0,
    frameTextsScanned: 1,
    debug: {
      pipeline: [{ step: "visibleText", count: 4200, ms: 12 }],
      selectedMatch: { score: "2-1", source: "visible-glued", rank: 100 },
      sourceBreakdown: { stats: { "glued-text": 1 }, odds: { dom: 2 } },
      clockDebug: { found: 1, afterWallFilter: 0, bestClock: null },
      matchCandidates: [
        { score: "2-1", clock: null, source: "visible-glued", rank: 100, wallClock: false },
      ],
      frameSamples: [{ source: "frame-walk", len: 120, preview: "Uruguai 2-2" }],
      visibleTextSample: "Copa do Mundo 2026",
      domProbe: [{ sel: "[class*='Score']", hits: 2, source: "dom", samples: ["2 - 1"] }],
    },
  },
};

describe("buildZipEntries", () => {
  it("retorna data.json, logs.txt, debug.txt, trace.txt e meta.json", () => {
    const entries = buildZipEntries(SAMPLE);
    const paths = entries.map((e) => e.path);

    assert.deepEqual(
      paths.sort(),
      ["data.json", "debug.txt", "logs.txt", "meta.json", "trace.txt"].sort()
    );

    const logs = entries.find((e) => e.path === "logs.txt").content;
    assert.match(logs, /Origem placar: markets/);
    assert.match(logs, /Placar DOM original: 2-1/);
    assert.match(logs, /Fontes stats:/);

    const debug = entries.find((e) => e.path === "debug.txt").content;
    assert.match(debug, /CANDIDATOS PLACAR \(rank\)/);
    assert.match(debug, /DOM PROBE/);
    assert.match(debug, /PIPELINE \(resumo\)/);

    const trace = entries.find((e) => e.path === "trace.txt").content;
    assert.match(trace, /BET365 TRACE/);
    assert.match(trace, /visibleText/);

    const meta = JSON.parse(entries.find((e) => e.path === "meta.json").content);
    assert.equal(meta.scoreInferredFrom, "markets");
    assert.equal(meta.hasDebugLog, true);
    assert.equal(meta.hasTraceLog, true);
  });
});

describe("formatBet365DebugLogs", () => {
  it("inclui candidatos rankeados e dom probe", () => {
    const text = formatBet365DebugLogs(SAMPLE);
    assert.match(text, /frameTextsScanned: 1/);
    assert.match(text, /visible-glued/);
    assert.match(text, /rank=100/);
  });
});

describe("formatBet365TraceLogs", () => {
  it("inclui pipeline e merge decision", () => {
    const text = formatBet365TraceLogs(SAMPLE);
    assert.match(text, /MERGE DECISION/);
    assert.match(text, /ALL RANKED CANDIDATES/);
  });
});

describe("buildZipFilename", () => {
  it("gera nome campeonato-jogo-placar-timestamp.zip", () => {
    const name = buildZipFilename(SAMPLE, "2026-06-21T23:30:00.000Z");
    assert.equal(name, "copa-do-mundo-2026-uruguai-cabo-verde-2-2-2026-06-21_23-30-00.zip");
  });
});

describe("sanitizeDownloadFilename", () => {
  it("remove caracteres inválidos para chrome.downloads", () => {
    const safe = sanitizeDownloadFilename("copa/jogo:test.zip", "fallback.zip");
    assert.equal(safe, "copa-jogo-test.zip");
  });
});
