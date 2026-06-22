import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isBet365PreMatchUrl,
  isBet365LiveUrl,
} from "../lib/bet365-url.js";
import {
  extractStatsFromVisibleText,
  parseMatchFromLines,
  mergeMatchCandidates,
  resolveMatchForPage,
  finalizeMatchWithMarkets,
  finalizeMatchData,
  parseOddsFromVisibleText,
} from "../lib/bet365-parsers.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PREMATCH_URL =
  "https://www.bet365.bet.br/#/AC/B1/C1/D8/E194699812/F3/I1/";
const LIVE_URL = "https://www.bet365.bet.br/#/IP/EV151352326532C1/";
const FIXTURE = readFileSync(
  join(__dir, "fixtures/nz-egypt-prematch.txt"),
  "utf8"
);

describe("isBet365PreMatchUrl", () => {
  it("identifica pré-jogo #/AC/.../E...", () => {
    assert.equal(isBet365PreMatchUrl(PREMATCH_URL), true);
    assert.equal(isBet365LiveUrl(PREMATCH_URL), false);
  });

  it("não marca ao vivo #/IP/EV... como pré-jogo", () => {
    assert.equal(isBet365PreMatchUrl(LIVE_URL), false);
    assert.equal(isBet365LiveUrl(LIVE_URL), true);
  });
});

describe("pré-jogo Nova Zelândia x Egito", () => {
  it("parseMatchFromLines pode achar 2-4 mas resolveMatchForPage descarta em pré-jogo", () => {
    const fromLines = parseMatchFromLines(FIXTURE, "2026-06-21T12:00:00.000Z");
    assert.equal(fromLines?.score, "2-4");

    const resolved = resolveMatchForPage(
      [{ ...fromLines, source: "visible-lines" }],
      { extractedAt: "2026-06-21T12:00:00.000Z", pageUrl: PREMATCH_URL }
    );

    assert.equal(resolved?.score, null);
    assert.equal(resolved?.clock, null);
  });

  it("não usa placar falso 2-4 de handicap em pré-jogo", () => {
    const resolved = resolveMatchForPage(
      [
        {
          score: "2-4",
          scoreHome: 2,
          scoreAway: 4,
          clock: null,
          source: "visible-lines",
        },
      ],
      { extractedAt: "2026-06-21T12:00:00.000Z", pageUrl: PREMATCH_URL }
    );

    assert.equal(resolved?.score, null);
  });

  it("rejeita stats com valores que parecem odds (11.00 / 12.00)", () => {
    const stats = extractStatsFromVisibleText(FIXTURE);
    const chutes = stats.find((s) => s.label === "Chutes ao Gol");
    assert.equal(chutes, undefined);
  });

  it("não extrai stats de visible-lines em pré-jogo", () => {
    const text = [
      "Copa do Mundo 2026",
      "Nova Zelândia v Egito",
      "Chutes",
      "Nova Zelândia",
      "6.00",
      "Empate",
      "4.20",
      "Jogador - Chutes ao Gol de Fora da Área",
      "11.00",
      "12.00",
    ].join("\n");

    assert.deepEqual(extractStatsFromVisibleText(text, PREMATCH_URL), []);
  });

  it("mantém odds do Resultado Final", () => {
    const odds = parseOddsFromVisibleText(FIXTURE);
    const bySelection = Object.fromEntries(odds.map((o) => [o.selection, o]));

    assert.equal(bySelection["Nova Zelândia"]?.odds, 6);
    assert.equal(bySelection.Empate?.odds, 4.2);
    assert.equal(bySelection.Egito?.odds, 1.55);
  });

  it("finalizeMatchWithMarkets não infere placar em pré-jogo", () => {
    const odds = parseOddsFromVisibleText(FIXTURE);
    const { match, inference } = finalizeMatchWithMarkets(
      { score: "2-4", scoreHome: 2, scoreAway: 4, clock: null },
      odds,
      FIXTURE,
      { statsCount: 0, visibleTextLength: FIXTURE.length },
      "2026-06-21T12:00:00.000Z",
      PREMATCH_URL
    );

    assert.equal(match.score, null);
    assert.equal(match.clock, null);
    assert.equal(inference.applied, false);
    assert.equal(match.scoreConfidence, "n/a");
  });

  it("finalizeMatchData preenche times e competição sem placar", () => {
    const match = finalizeMatchData(
      { score: null, clock: null },
      FIXTURE,
      { statsCount: 0, visibleTextLength: FIXTURE.length },
      "2026-06-21T12:00:00.000Z",
      PREMATCH_URL
    );

    assert.equal(match.homeTeam, "Nova Zelândia");
    assert.equal(match.awayTeam, "Egito");
    assert.equal(match.competition, "Copa do Mundo 2026");
    assert.equal(match.score, null);
    assert.ok(match.scoreWarnings.some((w) => /pré-jogo/i.test(w)));
  });
});