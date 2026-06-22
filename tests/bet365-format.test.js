import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBet365Logs,
  formatBet365DebugLogs,
  buildBet365Filename,
  buildBet365Slug,
} from "../lib/bet365-format.js";

const SAMPLE = {
  match: {
    homeTeam: "Uruguai",
    awayTeam: "Cabo Verde",
    score: "2-1",
    clock: "45:00",
    status: "Intervalo",
  },
  stats: [
    { label: "xG", home: "1.92", away: "0.14" },
    { label: "Ataques", home: "55", away: "37" },
  ],
  odds: [
    { market: "Resultado Final", selection: "Uruguai", odds: 1.071 },
    { market: "Resultado Final", selection: "Empate", odds: 9.5 },
  ],
};

describe("formatBet365Logs", () => {
  it("gera texto legível com stats e odds", () => {
    const text = formatBet365Logs(SAMPLE);

    assert.match(text, /Uruguai vs Cabo Verde/);
    assert.match(text, /Placar: 2-1/);
    assert.match(text, /xG: 1.92 \| 0.14/);
    assert.match(text, /Resultado Final \| Uruguai: 1.071/);
  });
});

describe("buildBet365Filename", () => {
  it("monta slug com times e extensão", () => {
    const name = buildBet365Filename(SAMPLE, "json", "2026-06-21T23:30:00.000Z");

    assert.match(name, /^bet365-uruguai-caboverde-/);
    assert.ok(name.endsWith(".json"));
  });
});

describe("formatBet365DebugLogs", () => {
  it("gera debug com seções de ambiente e frames", () => {
    const text = formatBet365DebugLogs({
      match: { score: "2-2", extractedAt: "2026-06-21T23:00:00.000Z" },
      meta: { version: "3.7.0", debug: { frameSamples: [] } },
    });

    assert.match(text, /BET365 DEBUG/);
    assert.match(text, /AMBIENTE/);
  });
});

describe("buildBet365Slug", () => {
  it("normaliza nomes dos times", () => {
    assert.equal(buildBet365Slug(SAMPLE), "uruguai-caboverde");
  });
});