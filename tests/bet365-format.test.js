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
    competition: "Copa do Mundo 2026",
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
  sidePanel: {
    timeline: [{ minute: 39, type: "goal", description: "Gol | Messi", source: "visible-text" }],
    lineup: {
      home: { starters: ["E Martinez"], subs: ["G Rulli"], goals: [] },
      away: { starters: ["A Schlager"], subs: [], goals: [] },
    },
    playerFinalizations: [{ player: "L Messi", shots: "3", onTarget: "1" }],
    actionAreas: { left: "27.3%", center: "55.4%", right: "17.3%" },
  },
};

describe("formatBet365Logs", () => {
  it("gera texto legível com stats e odds", () => {
    const text = formatBet365Logs(SAMPLE);

    assert.match(text, /Uruguai vs Cabo Verde/);
    assert.match(text, /Placar: 2-1/);
    assert.match(text, /xG: 1.92 \| 0.14/);
    assert.match(text, /Resultado Final \| Uruguai: 1.071/);
    assert.match(text, /PAINEL LATERAL/);
    assert.match(text, /Cronologia: 1 evento/);
    assert.match(text, /FINALIZAÇÕES/);
    assert.match(text, /L Messi: 3 chutes/);
  });
});

describe("buildBet365Filename", () => {
  it("monta campeonato-jogo-placar-timestamp", () => {
    const name = buildBet365Filename(SAMPLE, "json", "2026-06-21T23:30:00.000Z");

    assert.equal(
      name,
      "copa-do-mundo-2026-uruguai-cabo-verde-2-1-2026-06-21_23-30-00.json"
    );
  });

  it("usa fallback quando faltam campeonato ou placar", () => {
    const name = buildBet365Filename(
      { match: { homeTeam: "Time A", awayTeam: "Time B" } },
      "zip",
      "2026-06-21T12:00:00.000Z"
    );

    assert.equal(name, "campeonato-time-a-time-b-sem-placar-2026-06-21_12-00-00.zip");
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

  it("inclui blob lineup debug no debug.txt", () => {
    const text = formatBet365DebugLogs({
      match: { score: "1-0" },
      meta: {
        version: "3.10.5",
        debug: {
          sidePanelBlobDebug: [
            {
              url: "/Api/1/Blob?ipe/5378/SL",
              rawLen: 1000,
              hintLineupCount: 2,
              hintLineupPlayers: [{ name: "Lionel Messi" }, { name: "Lautaro Martinez" }],
              wirePlayerCount: 0,
              naPlayerLikeCount: 1,
              naSamples: [{ name: "Lionel Messi", playerLike: true }],
              lineupParsed: false,
            },
          ],
        },
      },
    });

    assert.match(text, /LINEUP WIRE DEBUG/);
    assert.match(text, /Lionel Messi/);
    assert.match(text, /hintLineupPlayers/);
  });

  it("inclui zap WS debug no debug.txt", () => {
    const text = formatBet365DebugLogs({
      match: { score: "1-0" },
      meta: {
        version: "3.10.5",
        debug: {
          sidePanelBlobDebug: [
            {
              source: "zap-ws",
              url: "ws:sportspublisher/zap",
              kind: "ws",
              messageCount: 12,
              mergedLen: 48_000,
              largestMessage: 12_000,
              hintLineupCount: 0,
              wirePlayerCount: 22,
              lineupParsed: true,
              lineupStarters: { home: 11, away: 11, source: "network-zap" },
              wirePlayers: [{ name: "Lionel Messi", team: 1 }],
              messageSamples: [{ rawLen: 12000, preview: "OV|SC=1-0|PA;NA=Lionel Messi;" }],
            },
          ],
        },
      },
    });

    assert.match(text, /LINEUP WIRE DEBUG/);
    assert.match(text, /zap-ws/);
    assert.match(text, /mergedLen=48000/);
    assert.match(text, /Lionel Messi/);
  });
});

describe("buildBet365Slug", () => {
  it("normaliza nomes dos times", () => {
    assert.equal(buildBet365Slug(SAMPLE), "uruguai-cabo-verde");
  });
});