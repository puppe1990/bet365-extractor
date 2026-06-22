import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseNextGoalMarkets,
  minTotalGoalsFromOdds,
  analyzeMarketScore,
  applyMarketScoreInference,
  isDrawFavored,
} from "../lib/bet365-market-inference.js";

const LIVE_ODDS = [
  { market: "5° Gol", selection: "Uruguai", odds: 2.5 },
  { market: "5° Gol", selection: "Sem 5° gol", odds: 1.8 },
  { market: "Resultado Final", selection: "Uruguai", odds: 2.62 },
  { market: "Resultado Final", selection: "Empate", odds: 1.66 },
  { market: "Resultado Final", selection: "Cabo Verde", odds: 10 },
];

describe("parseNextGoalMarkets", () => {
  it("detecta mercado N° Gol", () => {
    assert.deepEqual(parseNextGoalMarkets(LIVE_ODDS), [5]);
    assert.equal(minTotalGoalsFromOdds(LIVE_ODDS), 4);
  });
});

describe("isDrawFavored", () => {
  it("identifica empate favorito", () => {
    assert.equal(isDrawFavored(LIVE_ODDS), true);
  });
});

describe("applyMarketScoreInference", () => {
  it("ajusta 2-1 para 2-2 quando 5° Gol contradiz DOM", () => {
    const match = {
      score: "2-1",
      scoreHome: 2,
      scoreAway: 1,
      scoreConfidence: "medium",
      clock: null,
    };

    const result = applyMarketScoreInference(match, LIVE_ODDS);

    assert.equal(result.applied, true);
    assert.equal(result.match.score, "2-2");
    assert.equal(result.match.scoreHome, 2);
    assert.equal(result.match.scoreAway, 2);
    assert.equal(result.match.scoreDom, "2-1");
    assert.equal(result.match.scoreInferredFrom, "markets");
  });

  it("infere 2-2 quando placar ausente mas mercados implicam empate", () => {
    const result = applyMarketScoreInference({ scoreConfidence: "low", clock: null }, LIVE_ODDS);

    assert.equal(result.applied, true);
    assert.equal(result.match.score, "2-2");
    assert.equal(result.match.scoreInferredFrom, "markets");
  });

  it("não altera placar consistente com mercados", () => {
    const match = {
      score: "2-2",
      scoreHome: 2,
      scoreAway: 2,
      scoreConfidence: "high",
      clock: "72:14",
    };

    const result = applyMarketScoreInference(match, LIVE_ODDS);

    assert.equal(result.applied, false);
    assert.equal(result.analysis.consistent, true);
  });
});

describe("analyzeMarketScore", () => {
  it("documenta inconsistência entre DOM e mercados", () => {
    const analysis = analyzeMarketScore(LIVE_ODDS, { score: "2-1" });

    assert.equal(analysis.minTotalGoals, 4);
    assert.equal(analysis.domTotalGoals, 3);
    assert.equal(analysis.consistent, false);
    assert.ok(analysis.reasons.some((r) => /5° Gol/.test(r)));
  });
});
