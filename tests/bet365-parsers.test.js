import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseGluedStats,
  extractStatsFromVisibleText,
  parseGluedMatch,
  collectGluedMatches,
  collectSpacedScoreboardMatches,
  pickBestMatch,
  parseMatchFromLines,
  enrichMatchFromHeader,
  extractMatchFromVisibleText,
  parseOddsFromVisibleText,
  cleanOdds,
  mergeOdds,
  mergeMatchCandidates,
  isLikelyWallClock,
  assessMatchConfidence,
  finalizeMatchData,
  looksLikeScoreboardText,
  extractMatchFromFrameChunks,
  collectMatchCandidatesFromText,
  isValidSelection,
  isValidOdd,
  parseOdd,
} from "../lib/bet365-parsers.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(__dir, "fixtures/uruguay-cabo-verde-glued.txt"),
  "utf8"
);

describe("parseGluedStats", () => {
  it("extrai xG, ataques e posse do texto colado da Bet365", () => {
    const stats = parseGluedStats(FIXTURE);
    const byLabel = Object.fromEntries(stats.map((s) => [s.label, s]));

    assert.equal(byLabel.xG.home, "1.92");
    assert.equal(byLabel.xG.away, "0.14");
    assert.equal(byLabel.Ataques.home, "55");
    assert.equal(byLabel.Ataques.away, "37");
    assert.equal(byLabel["Ataques Perigosos"].home, "40");
    assert.equal(byLabel["Ataques Perigosos"].away, "7");
    assert.equal(byLabel["% de Posse"].home, "65");
    assert.equal(byLabel["% de Posse"].away, "35");
    assert.equal(byLabel["Finalizações / Chutes ao Gol"].home, "11/2");
    assert.equal(byLabel["Finalizações / Chutes ao Gol"].away, "2/1");
    assert.equal(byLabel["Passes Chave"].home, "8");
    assert.equal(byLabel["Passes Chave"].away, "0");
    assert.equal(byLabel["Cruzamentos"].home, "9");
    assert.equal(byLabel["Cruzamentos"].away, "2");
  });

  it("retorna array vazio para texto sem stats", () => {
    assert.deepEqual(parseGluedStats("nada aqui"), []);
  });
});

describe("extractStatsFromVisibleText", () => {
  it("usa glued stats como caminho principal", () => {
    const stats = extractStatsFromVisibleText(FIXTURE);
    assert.ok(stats.length >= 4);
    assert.equal(stats[0].source, "glued-text");
  });
});

describe("parseGluedMatch", () => {
  it("extrai times e placar do padrão Uruguai21Cabo Verde45:00", () => {
    const match = parseGluedMatch(FIXTURE);

    assert.equal(match.homeTeam, "Uruguai");
    assert.equal(match.awayTeam, "Cabo Verde");
    assert.equal(match.score, "2-1");
    assert.equal(match.scoreHome, 2);
    assert.equal(match.scoreAway, 1);
    assert.equal(match.clock, "45:00");
    assert.equal(match.status, "Intervalo");
  });
});

describe("enrichMatchFromHeader", () => {
  it("preenche competição e times do cabeçalho Uruguai v Cabo Verde", () => {
    const enriched = enrichMatchFromHeader(FIXTURE, {});

    assert.equal(enriched.competition, "Copa do Mundo 2026");
    assert.equal(enriched.homeTeam, "Uruguai");
    assert.equal(enriched.awayTeam, "Cabo Verde");
  });
});

describe("extractMatchFromVisibleText", () => {
  it("combina glued match com header enrichment", () => {
    const match = extractMatchFromVisibleText(FIXTURE);

    assert.equal(match.competition, "Copa do Mundo 2026");
    assert.equal(match.homeTeam, "Uruguai");
    assert.equal(match.awayTeam, "Cabo Verde");
    assert.equal(match.score, "2-1");
  });

  it("prefere placar ao vivo com relógio mais alto", () => {
    const text = [
      "Copa do Mundo 2026",
      "Uruguai v Cabo Verde",
      "Uruguai21Cabo Verde20:32",
      "Uruguai22Cabo Verde72:14",
      "Resultado Após Primeira Parte 2-1",
    ].join("\n");

    const match = extractMatchFromVisibleText(text);

    assert.equal(match.score, "2-2");
    assert.equal(match.scoreHome, 2);
    assert.equal(match.scoreAway, 2);
    assert.equal(match.clock, "72:14");
  });

  it("extrai placar em linhas separadas com relógio ao vivo", () => {
    const text = [
      "Copa do Mundo 2026",
      "Uruguai v Cabo Verde",
      "2",
      "-",
      "2",
      "72:14",
      "20:32",
      "Resultado Após Primeira Parte 2-1",
    ].join("\n");

    const match = extractMatchFromVisibleText(text);

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
  });
});

describe("pickBestMatch", () => {
  it("escolhe candidato com maior minuto de jogo", () => {
    const best = pickBestMatch([
      { score: "2-1", clock: "45:00" },
      { score: "2-2", clock: "72:14" },
      { score: "2-1", clock: "20:32" },
    ]);

    assert.equal(best.score, "2-2");
    assert.equal(best.clock, "72:14");
  });
});

describe("collectSpacedScoreboardMatches", () => {
  it("extrai placar com gols separados por espaço no widget Bet365", () => {
    const text =
      "Uruguai 2 2 Cabo Verde 88:08 S Moreira Cabo Verde Com Posse Marcadores de Gols Estat.";

    const matches = collectSpacedScoreboardMatches(text);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].score, "2-2");
    assert.equal(matches[0].clock, "88:08");
    assert.equal(matches[0].homeTeam, "Uruguai");
    assert.equal(matches[0].awayTeam, "Cabo Verde");
  });

  it("integra formato espaçado em collectMatchCandidatesFromText", () => {
    const candidates = collectMatchCandidatesFromText(
      "Uruguai 2 2 Cabo Verde 88:08",
      "dom-scoreboard",
      "2026-06-21T23:53:45.333Z"
    );

    assert.ok(candidates.some((c) => c.score === "2-2" && c.clock === "88:08"));
  });
});

describe("collectGluedMatches", () => {
  it("encontra múltiplos placares colados na página", () => {
    const matches = collectGluedMatches(
      "Uruguai21Cabo Verde45:00 Uruguai22Cabo Verde72:14"
    );

    assert.equal(matches.length, 2);
    assert.equal(pickBestMatch(matches).score, "2-2");
  });
});

describe("parseMatchFromLines", () => {
  it("lê placar quando home, traço e away estão em linhas distintas", () => {
    const match = parseMatchFromLines("Uruguai\n2\n-\n2\nCabo Verde\n72:14");

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
  });

  it("ignora horário de parede quando há minuto de jogo", () => {
    const extractedAt = "2026-06-21T23:42:05.176Z";
    const match = parseMatchFromLines(
      "Uruguai\n2\n-\n2\nCabo Verde\n72:14\n20:42",
      extractedAt
    );

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
  });
});

describe("isLikelyWallClock", () => {
  it("detecta horário local coincidente com extractedAt", () => {
    const extractedAt = "2026-06-21T23:42:05.176Z";
    assert.equal(isLikelyWallClock("20:42", extractedAt), true);
    assert.equal(isLikelyWallClock("72:14", extractedAt), false);
    assert.equal(isLikelyWallClock("45:00", extractedAt), false);
  });
});

describe("mergeMatchCandidates", () => {
  it("remove relógio de parede do candidato vencedor", () => {
    const extractedAt = "2026-06-21T23:42:05.176Z";
    const match = mergeMatchCandidates(
      { score: "2-1", scoreHome: 2, scoreAway: 1, clock: "20:42" },
      { extractedAt }
    );

    assert.equal(match.score, "2-1");
    assert.equal(match.clock, null);
  });
});

describe("extractMatchFromFrameChunks", () => {
  it("extrai placar ao vivo de iframe do painel lateral", () => {
    const frames = [
      {
        source: "frame-scripting",
        text: "Uruguai\n2\n-\n2\nCabo Verde\n72:14\nAo Vivo",
      },
      {
        source: "frame-walk",
        text: "Uruguai21Cabo Verde20:42",
      },
    ];

    const match = extractMatchFromFrameChunks(frames, "2026-06-21T23:46:59.591Z", {
      homeTeam: "Uruguai",
      awayTeam: "Cabo Verde",
    });

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
    assert.equal(match.status, "Ao Vivo");
  });

  it("prefere frame-scripting sobre placar colado antigo", () => {
    const frames = [
      { source: "frame-scripting", text: "Uruguai22Cabo Verde72:14Ao Vivo" },
      { source: "frame-walk", text: "Uruguai21Cabo Verde45:00Intervalo" },
    ];

    const match = extractMatchFromFrameChunks(frames, "2026-06-21T23:46:59.591Z", {
      homeTeam: "Uruguai",
      awayTeam: "Cabo Verde",
    });

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
  });
});

describe("looksLikeScoreboardText", () => {
  it("identifica texto do widget de placar", () => {
    assert.equal(
      looksLikeScoreboardText("Uruguai\n2\n-\n2\nCabo Verde\n72:14", "Uruguai", "Cabo Verde"),
      true
    );
    assert.equal(
      looksLikeScoreboardText("Resultado Final\nUruguai\n2.50", "Uruguai", "Cabo Verde"),
      false
    );
  });
});

describe("assessMatchConfidence", () => {
  it("marca baixa confiança quando só há placar sem minuto confiável", () => {
    const result = assessMatchConfidence(
      {
        score: "2-1",
        clock: null,
        extractedAt: "2026-06-21T23:42:05.176Z",
      },
      { statsCount: 9, visibleTextLength: 4253 }
    );

    assert.equal(result.confidence, "medium");
    assert.ok(result.warnings.some((w) => /Minuto de jogo/.test(w)));
  });

  it("finaliza match com scoreConfidence no objeto", () => {
    const match = finalizeMatchData(
      { score: "2-2", scoreHome: 2, scoreAway: 2, clock: "72:14" },
      "Uruguai v Cabo Verde\nCopa do Mundo 2026",
      { statsCount: 9, visibleTextLength: 5000 },
      "2026-06-21T23:42:05.176Z"
    );

    assert.equal(match.homeTeam, "Uruguai");
    assert.equal(match.scoreConfidence, "high");
  });
});

describe("parseOddsFromVisibleText", () => {
  it("extrai odds do bloco Resultado Final do fixture", () => {
    const odds = parseOddsFromVisibleText(FIXTURE);

    assert.ok(odds.length >= 3);
    const bySelection = Object.fromEntries(odds.map((o) => [o.selection, o]));

    assert.equal(bySelection.Uruguai.odds, 1.071);
    assert.equal(bySelection.Empate.odds, 9.5);
    assert.equal(bySelection["Cabo Verde"].odds, 34);
    assert.ok(odds.every((o) => o.source === "visible-text"));
  });
});

describe("mergeOdds", () => {
  it("prefere odds do DOM quando há duplicata", () => {
    const merged = mergeOdds(
      [{ market: "—", selection: "Uruguai", odds: 1.08, source: "visible-text" }],
      [{ market: "Resultado Final", selection: "Uruguai", odds: 1.071, source: "dom" }]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].market, "Resultado Final");
    assert.equal(merged[0].source, "dom");
  });

  it("ignora visible-text quando já existem odds do DOM", () => {
    const merged = mergeOdds(
      [
        { market: "Resultado Final", selection: "Uruguai", odds: 1.071, source: "dom" },
        { market: "Resultado Final", selection: "Empate", odds: 9, source: "dom" },
        { market: "4° Gol", selection: "Uruguai", odds: 1.8, source: "dom" },
      ],
      [
        { market: "Escalação", selection: "Ataques", odds: 76, source: "visible-text" },
        { market: "FINALIZAÇÕES", selection: "M Araujo", odds: 2, source: "visible-text" },
        { market: "Parceiros", selection: "Uruguai", odds: 2, source: "visible-text" },
      ]
    );

    assert.equal(merged.length, 3);
    assert.ok(merged.every((o) => o.source === "dom"));
  });

  it("usa visible-text como fallback quando não há DOM", () => {
    const merged = mergeOdds(
      [{ market: "Resultado Final", selection: "Uruguai", odds: 1.071, source: "visible-text" }]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "visible-text");
  });

  it("completa seleções faltantes do DOM com visible-text do mesmo mercado", () => {
    const merged = mergeOdds(
      [
        { market: "Chance Dupla", selection: "Empate ou Cabo Verde", odds: 9.5, source: "dom" },
        { market: "Chance Dupla", selection: "Uruguai ou Cabo Verde", odds: 1.062, source: "dom" },
        { market: "Resultado Final", selection: "Uruguai", odds: 1.062, source: "dom" },
      ],
      [
        {
          market: "Chance Dupla",
          selection: "Uruguai ou Empate",
          odds: 1.004,
          source: "visible-text",
        },
        { market: "Escalação", selection: "Ataques", odds: 76, source: "visible-text" },
        { market: "Parceiros", selection: "Uruguai", odds: 2, source: "visible-text" },
      ]
    );

    assert.equal(merged.length, 4);

    const chanceDupla = merged.filter((o) => o.market === "Chance Dupla");
    assert.equal(chanceDupla.length, 3);

    const uruguaiEmpate = chanceDupla.find((o) => o.selection === "Uruguai ou Empate");
    assert.equal(uruguaiEmpate.odds, 1.004);
    assert.equal(uruguaiEmpate.source, "visible-text");

    assert.ok(merged.every((o) => o.market !== "Escalação" && o.market !== "Parceiros"));
  });

  it("não sobrescreve seleção do DOM com visible-text do mesmo mercado", () => {
    const merged = mergeOdds(
      [{ market: "Resultado Final", selection: "Uruguai", odds: 1.062, source: "dom" }],
      [{ market: "Resultado Final", selection: "Uruguai", odds: 1.09, source: "visible-text" }]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].odds, 1.062);
    assert.equal(merged[0].source, "dom");
  });
});

describe("cleanOdds", () => {
  it("remove mercado genérico e seleções lixo", () => {
    const raw = [
      { market: "Resultado Final", selection: "Uruguai", odds: 1.071, source: "dom" },
      { market: "Mercado", selection: "Uruguai", odds: 1.071, source: "dom" },
      { market: "Resultado Final", selection: "Empate", odds: 9.5, source: "dom" },
      { market: "—", selection: "Mais de", odds: 2.1, source: "visible-text" },
      { market: "—", selection: "Tabela", odds: 1.92, source: "visible-text" },
    ];

    const cleaned = cleanOdds(raw);

    assert.equal(cleaned.length, 2);
    assert.ok(cleaned.every((o) => o.market === "Resultado Final"));
    assert.deepEqual(
      cleaned.map((o) => o.selection).sort(),
      ["Empate", "Uruguai"]
    );
  });
});

describe("odds validators", () => {
  it("rejeita handicap como seleção", () => {
    assert.equal(isValidSelection("3.5"), false);
    assert.equal(isValidSelection("Uruguai"), true);
  });

  it("aceita odds entre 1.01 e 501", () => {
    assert.equal(isValidOdd(1.071), true);
    assert.equal(isValidOdd(3.5), true);
    assert.equal(isValidOdd(0.5), false);
    assert.equal(parseOdd("9,50"), 9.5);
  });
});

describe("extraction debug helpers", () => {
  it("rankeia candidatos e monta debug enriquecido", async () => {
    const { annotateCandidateRanks, buildExtractionDebug } = await import(
      "../lib/bet365-parsers.js"
    );
    const extractedAt = "2026-06-21T23:30:00.000Z";
    const candidates = [
      { score: "2-1", clock: "20:42", source: "visible-glued" },
      { score: "2-2", clock: "72:14", source: "frame-scripting" },
    ];

    const ranked = annotateCandidateRanks(candidates, extractedAt);
    assert.ok(ranked[0].rank > ranked[1].rank);
    assert.equal(ranked.find((c) => c.source === "frame-scripting").wallClock, false);

    const debug = buildExtractionDebug({
      matchCandidates: candidates,
      extractedAt,
      pipeline: [{ step: "visibleText", count: 1000, ms: 5 }],
      selectedMatch: ranked[0],
      stats: [{ source: "dom" }],
      odds: [{ source: "dom" }, { source: "visible-text" }],
    });

    assert.equal(debug.pipeline.length, 1);
    assert.equal(debug.sourceBreakdown.odds.dom, 1);
    assert.equal(debug.matchCandidates[0].rank, ranked[0].rank);
    assert.ok(debug.clockDebug.found >= 1);
  });
});