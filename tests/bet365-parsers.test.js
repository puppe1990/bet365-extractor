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
  extractScoreboardStatusNear,
  inferMatchStatusFromScoreboard,
  pickBestMatch,
  parseMatchFromLines,
  enrichMatchFromHeader,
  extractMatchFromVisibleText,
  parseOddsFromVisibleText,
  cleanOdds,
  mergeOdds,
  mergeMatchCandidates,
  isLikelyWallClock,
  sanitizeMatchClock,
  isLikelyBettingMarket,
  isJunkOddsMarket,
  isJunkOddsSelection,
  isTimelineLeakMarket,
  isTimelineLeakSelection,
  isLikelyMinuteAsOdd,
  isLikelyStatCountAsOdd,
  isLikelyScoreboardSelection,
  assessMatchConfidence,
  finalizeMatchData,
  looksLikeScoreboardText,
  extractMatchFromFrameChunks,
  collectMatchCandidatesFromText,
  isValidSelection,
  isValidOdd,
  parseOdd,
  splitAtaquesPerigososGlued,
  isJunkTeamGoalsSelection,
  isJunkPlayerPropSelection,
} from "../lib/bet365-parsers.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dir, "fixtures/uruguay-cabo-verde-glued.txt"), "utf8");
const INPLAY_ODDS_FIXTURE = readFileSync(join(__dir, "fixtures/inplay-odds-visible.txt"), "utf8");
const INPLAY_NOISE_FIXTURE = readFileSync(join(__dir, "fixtures/inplay-noise-visible.txt"), "utf8");
const PLAYER_GRIDS_FIXTURE = readFileSync(
  join(__dir, "fixtures/argentina-austria-player-grids.txt"),
  "utf8"
);
const TEAM_GOALS_FIXTURE = readFileSync(
  join(__dir, "fixtures/argentina-austria-team-goals.txt"),
  "utf8"
);
const CRONOLOGIA_ODDS_LEAK_FIXTURE = readFileSync(
  join(__dir, "fixtures/cronologia-odds-leak.txt"),
  "utf8"
);
const INTERVAL_ODDS_LEAK_FIXTURE = readFileSync(
  join(__dir, "fixtures/interval-odds-leak.txt"),
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

  it("não confunde 4 e 13 em Ataques Perigosos colados", () => {
    const stats = parseGluedStats("Ataques1519Ataques Perigosos413% de Posse5050Finalizações");
    const row = stats.find((s) => s.label === "Ataques Perigosos");
    assert.equal(row?.home, "4");
    assert.equal(row?.away, "13");
  });

  it("separa 17 e 27 em Ataques Perigosos colados", () => {
    const stats = parseGluedStats("Ataques1725Ataques Perigosos1727% de Posse4852Finalizações");
    const row = stats.find((s) => s.label === "Ataques Perigosos");
    assert.equal(row?.home, "17");
    assert.equal(row?.away, "27");
  });
});

describe("splitAtaquesPerigososGlued", () => {
  it("mantém splits já corrigidos para 3 dígitos", () => {
    assert.deepEqual(splitAtaquesPerigososGlued("413"), { home: "4", away: "13" });
    assert.deepEqual(splitAtaquesPerigososGlued("407"), { home: "40", away: "7" });
    assert.deepEqual(splitAtaquesPerigososGlued("519"), { home: "5", away: "19" });
  });

  it("faz split 2+2 para valores altos", () => {
    assert.deepEqual(splitAtaquesPerigososGlued("1727"), { home: "17", away: "27" });
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

describe("extractScoreboardStatusNear", () => {
  it("extrai Intervalo após relógio 45:00", () => {
    const flat = "Noruega 1 0 Senegal 45:00 Intervalo M Pedersen 43'";
    const clockEnd = flat.indexOf("45:00") + "45:00".length;
    assert.equal(extractScoreboardStatusNear(flat, clockEnd), "Intervalo");
  });

  it("retorna null quando não há status próximo ao relógio", () => {
    const flat = "Noruega 1 0 Senegal 48:46 M Pedersen 43'";
    assert.equal(extractScoreboardStatusNear(flat, flat.length), null);
  });
});

describe("inferMatchStatusFromScoreboard", () => {
  it("define status Intervalo quando placar está em 45:00", () => {
    const match = { score: "1-0", clock: "45:00" };
    const text = "Noruega 1 0 Senegal 45:00 Intervalo M Pedersen 43'";
    const out = inferMatchStatusFromScoreboard(match, text);

    assert.equal(out.status, "Intervalo");
  });

  it("não força Intervalo fora do minuto 45", () => {
    const match = { score: "1-0", clock: "48:46" };
    const text = "Noruega 1 0 Senegal 48:46 Intervalo M Pedersen 43'";
    const out = inferMatchStatusFromScoreboard(match, text);

    assert.equal(out.status, undefined);
  });

  it("preserva status existente no match", () => {
    const match = { score: "1-0", clock: "45:00", status: "Ao Vivo" };
    const out = inferMatchStatusFromScoreboard(match, "45:00 Intervalo");

    assert.equal(out.status, "Ao Vivo");
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

  it("captura status Intervalo no placar norueguês", () => {
    const text =
      "Noruega 1 0 Senegal 45:00 Intervalo M Pedersen 43' 1 0 Estat. Cronologia Escalação";
    const matches = collectSpacedScoreboardMatches(text);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, "Intervalo");
    assert.equal(matches[0].clock, "45:00");
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
    const matches = collectGluedMatches("Uruguai21Cabo Verde45:00 Uruguai22Cabo Verde72:14");

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
    const match = parseMatchFromLines("Uruguai\n2\n-\n2\nCabo Verde\n72:14\n20:42", extractedAt);

    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "72:14");
  });
});

function localClockFromIso(extractedAt) {
  const d = new Date(extractedAt);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("isLikelyWallClock", () => {
  it("detecta horário local coincidente com extractedAt", () => {
    const extractedAt = "2026-06-21T23:42:05.176Z";
    assert.equal(isLikelyWallClock(localClockFromIso(extractedAt), extractedAt), true);
    assert.equal(isLikelyWallClock("72:14", extractedAt), false);
    assert.equal(isLikelyWallClock("45:00", extractedAt), false);
  });

  it("não trata minutos iniciais de jogo como horário de parede", () => {
    const extractedAt = "2026-06-22T17:05:17.930Z";
    assert.equal(isLikelyWallClock("04:18", extractedAt), false);
    assert.equal(isLikelyWallClock("12:30", extractedAt), false);
    assert.equal(isLikelyWallClock("23:15", extractedAt), false);
  });
});

describe("sanitizeMatchClock", () => {
  it("preserva relógio de início de jogo no scoreboard", () => {
    const extractedAt = "2026-06-22T17:05:17.930Z";
    const match = sanitizeMatchClock(
      { score: "0-0", clock: "04:18", source: "dom-scoreboard" },
      extractedAt
    );

    assert.equal(match.clock, "04:18");
  });

  it("integra relógio cedo via mergeMatchCandidates", () => {
    const extractedAt = "2026-06-22T17:05:17.930Z";
    const match = mergeMatchCandidates(
      { score: "0-0", clock: "04:18", source: "dom-scoreboard" },
      { extractedAt }
    );

    assert.equal(match.clock, "04:18");
  });
});

describe("mergeMatchCandidates", () => {
  it("remove relógio de parede do candidato vencedor", () => {
    const extractedAt = "2026-06-21T23:42:05.176Z";
    const match = mergeMatchCandidates(
      {
        score: "2-1",
        scoreHome: 2,
        scoreAway: 1,
        clock: localClockFromIso(extractedAt),
      },
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

  it("associa mercados e linhas de gols do texto visível ao vivo", () => {
    const odds = parseOddsFromVisibleText(INPLAY_ODDS_FIXTURE);
    const byKey = Object.fromEntries(odds.map((o) => [`${o.market}|${o.selection}`, o]));

    assert.equal(byKey["Resultado Final|Time Casa"].odds, 1.5);
    assert.equal(byKey["Resultado Final|Empate"].odds, 4);
    assert.equal(byKey["Resultado Final|Time Fora"].odds, 7);
    assert.equal(byKey["Partida - Gols|Mais de 2.5"].odds, 2);
    assert.equal(byKey["Partida - Gols|Menos de 2.5"].odds, 1.8);
    assert.equal(byKey["Intervalo - Resultado|Time Casa"].odds, 2.1);
    assert.ok(odds.every((o) => o.market !== "CA" && o.market !== "—"));
  });
});

describe("isLikelyBettingMarket", () => {
  it("aceita mercados de aposta e rejeita ruído de UI", () => {
    assert.equal(isLikelyBettingMarket("Partida - Gols"), true);
    assert.equal(isLikelyBettingMarket("Intervalo - Resultado"), true);
    assert.equal(isLikelyBettingMarket("Escalação"), false);
    assert.equal(isLikelyBettingMarket("—"), false);
  });
});

describe("isJunkOddsMarket", () => {
  it("rejeita rodapé legal, stats e botões de UI", () => {
    assert.equal(
      isJunkOddsMarket(
        "HS do Brasil Ltda é regulada e autorizada pela Secretaria de Prêmios e Apostas do Ministério da Fazenda (Portaria SPA/MF Nº 250, de 07/02/2025)."
      ),
      true
    );
    assert.equal(
      isJunkOddsMarket(
        "Você não deve utilizar os recursos de programas e benefícios assistenciais para apostar."
      ),
      true
    );
    assert.equal(isJunkOddsMarket("Goleiro - Defesas"), true);
    assert.equal(isJunkOddsMarket("Exibir Totais da Partida"), true);
    assert.equal(isJunkOddsMarket("Resultados"), true);
    assert.equal(isJunkOddsMarket("Partida - Gols"), false);
  });
});

describe("team and player junk filters", () => {
  it("rejeita seleções inválidas em mercados Time - Gols", () => {
    assert.equal(isJunkTeamGoalsSelection("Áustria - Gols", "Áustria"), true);
    assert.equal(isJunkTeamGoalsSelection("Áustria - Gols", "M Gregoritsch"), true);
    assert.equal(isJunkTeamGoalsSelection("Áustria - Gols", "Mais de 1.5"), false);
    assert.equal(isJunkTeamGoalsSelection("Áustria - Gols", "Menos de 1.5"), false);
    assert.equal(isJunkTeamGoalsSelection("Partida - Gols", "Mais de 2.5"), false);
  });

  it("rejeita linhas Mais/Menos em mercados de jogador", () => {
    assert.equal(isJunkPlayerPropSelection("Jogador - Assistências", "Menos de 5.50"), true);
    assert.equal(isJunkPlayerPropSelection("Jogador - Assistências", "Lionel Messi - 1+"), false);
  });
});

describe("timeline leak odds filters", () => {
  it("identifica mercados e seleções da cronologia", () => {
    assert.equal(isTimelineLeakMarket("1° Escanteio"), true);
    assert.equal(isTimelineLeakMarket("4° Gol"), false);
    assert.equal(isTimelineLeakMarket("Messi - Chute"), true);
    assert.equal(isTimelineLeakSelection("Medina - Assist"), true);
    assert.equal(isLikelyMinuteAsOdd(41, "1° Escanteio", "S Posch"), true);
    assert.equal(isLikelyMinuteAsOdd(39, "Messi - Chute", "Medina - Assist"), true);
    assert.equal(isLikelyStatCountAsOdd(3, "Jogador - Chutes", "Lionel Messi"), true);
    assert.equal(isLikelyScoreboardSelection("Resultado Após Primeira Parte 1-0"), true);
    assert.equal(isLikelyMinuteAsOdd(45, "Jogador - Chutes", "Áustria"), true);
    assert.equal(isLikelyBettingMarket("Messi - Chute"), false);
  });

  it("não promove eventos da cronologia a odds", () => {
    const odds = parseOddsFromVisibleText(CRONOLOGIA_ODDS_LEAK_FIXTURE);

    assert.ok(!odds.some((o) => o.market === "Messi - Chute"));
    assert.ok(!odds.some((o) => o.selection === "Medina - Assist"));
    assert.ok(!odds.some((o) => o.market === "1° Escanteio" && o.selection === "S Posch"));
    assert.ok(odds.some((o) => o.market === "Resultado Final" && o.selection === "Argentina"));
  });

  it("filtra minuto, placar e contagem de chutes vazando como odd", () => {
    const odds = parseOddsFromVisibleText(INTERVAL_ODDS_LEAK_FIXTURE);

    assert.ok(!odds.some((o) => o.selection === "Áustria" && o.odds === 45));
    assert.ok(!odds.some((o) => o.selection === "Lionel Messi" && o.odds === 3));
    assert.ok(
      !odds.some((o) => o.selection === "Resultado Após Primeira Parte 1-0" && o.odds === 41)
    );
    assert.ok(odds.some((o) => o.market === "Resultado Final" && o.selection === "Argentina"));
    assert.ok(!odds.some((o) => o.selection === "Cronologia"));
  });
});

describe("isJunkOddsSelection", () => {
  it("rejeita stats, placares de outros jogos e linhas inválidas", () => {
    assert.equal(isJunkOddsSelection("Ataques"), true);
    assert.equal(isJunkOddsSelection("% de Posse"), true);
    assert.equal(isJunkOddsSelection("3 Jordânia 1 -2 0"), true);
    assert.equal(isJunkOddsSelection("Menos de 19.00"), true);
    assert.equal(isJunkOddsSelection("Mais de 2.5"), false);
    assert.equal(isJunkOddsSelection("Jogadores Titulares"), true);
    assert.equal(isJunkOddsSelection("Exibir Totais da Partida"), true);
    assert.equal(isJunkOddsSelection("Lionel Messi"), false);
  });
});

describe("parseOddsFromVisibleText noise filtering", () => {
  it("parseia grades de gols e ignora ruído de footer, stats e outros jogos", () => {
    const odds = parseOddsFromVisibleText(INPLAY_NOISE_FIXTURE);
    const byKey = Object.fromEntries(odds.map((o) => [`${o.market}|${o.selection}`, o]));

    assert.equal(byKey["Partida - Gols - Mais Opções|Mais de 0.5"].odds, 1.083);
    assert.equal(byKey["Partida - Gols - Mais Opções|Menos de 5.5"].odds, 1.02);
    assert.equal(byKey["Total de Gols - 1º Tempo|Mais de 2.5"].odds, 11);
    assert.equal(byKey["Total de Gols - 1º Tempo|Menos de 2.5"].odds, 1.05);
    assert.equal(byKey["Marcadores de Gol|Lionel Messi"].odds, 1.95);

    assert.ok(!odds.some((o) => o.market.includes("HS do Brasil")));
    assert.ok(!odds.some((o) => o.market === "Goleiro - Defesas"));
    assert.ok(!odds.some((o) => o.market === "Exibir Totais da Partida"));
    assert.ok(!odds.some((o) => o.market === "Resultados"));
    assert.ok(!odds.some((o) => o.selection === "Exibir Totais da Partida"));
    assert.ok(!odds.some((o) => o.selection.includes("Jordânia")));
    assert.ok(!odds.some((o) => /Menos de (19|11)\.00/.test(o.selection)));
    assert.ok(!odds.some((o) => o.selection === "Ataques"));
  });

  it("parseia grades de jogador e filtra ruído em Time - Gols", () => {
    const odds = parseOddsFromVisibleText(`${PLAYER_GRIDS_FIXTURE}\n${TEAM_GOALS_FIXTURE}`);
    const byKey = Object.fromEntries(odds.map((o) => [`${o.market}|${o.selection}`, o]));

    assert.equal(byKey["Jogador - Assistências|Lionel Messi - 1+"].odds, 4.33);
    assert.equal(byKey["Jogador - Assistências|Rodrigo De Paul - 1+"].odds, 4.5);
    assert.equal(byKey["Jogador - Assistências|Thiago Almada - 1+"].odds, 6);
    assert.equal(byKey["Jogador - Chutes|Lionel Messi - 1+"].odds, 1.04);
    assert.equal(byKey["Jogador - Chutes|Lionel Messi - 2+"].odds, 1.22);
    assert.equal(byKey["Jogador - Chutes|Lautaro Martinez - 3+"].odds, 2.62);
    assert.equal(byKey["Áustria - Gols|Mais de 1.5"].odds, 8);
    assert.equal(byKey["Áustria - Gols|Menos de 1.5"].odds, 1.083);
    assert.equal(byKey["Argentina - Gols|Mais de 2.5"].odds, 5.8);

    assert.ok(!odds.some((o) => o.market === "Áustria - Gols" && o.selection === "Áustria"));
    assert.ok(!odds.some((o) => o.market === "Áustria - Gols" && o.selection === "M Gregoritsch"));
    assert.ok(
      !odds.some((o) => o.market === "Jogador - Assistências" && /^Menos de /.test(o.selection))
    );
  });

  it("cleanOdds remove entradas lixo que escaparem do parser", () => {
    const cleaned = cleanOdds([
      { market: "Resultado Final", selection: "Time Casa", odds: 1.5, source: "dom" },
      {
        market: "HS do Brasil Ltda é regulada",
        selection: "Ataques",
        odds: 5,
        source: "visible-text",
      },
      { market: "Partida - Gols", selection: "Mais de 2.5", odds: 2.2, source: "visible-text" },
    ]);

    assert.equal(cleaned.length, 2);
    assert.ok(cleaned.every((o) => !o.market.includes("HS do Brasil")));
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
    const merged = mergeOdds([
      { market: "Resultado Final", selection: "Uruguai", odds: 1.071, source: "visible-text" },
    ]);

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

  it("inclui mercados novos do visible-text além dos do DOM", () => {
    const merged = mergeOdds(
      [
        { market: "Resultado Final", selection: "Time Casa", odds: 1.5, source: "dom" },
        { market: "Resultado Final", selection: "Empate", odds: 4, source: "dom" },
        { market: "Resultado Final", selection: "Time Fora", odds: 7, source: "dom" },
      ],
      [
        { market: "Partida - Gols", selection: "Mais de 2.5", odds: 2, source: "visible-text" },
        { market: "Partida - Gols", selection: "Menos de 2.5", odds: 1.8, source: "visible-text" },
        {
          market: "Intervalo - Resultado",
          selection: "Time Casa",
          odds: 2.1,
          source: "visible-text",
        },
        { market: "Escalação", selection: "Ataques", odds: 76, source: "visible-text" },
      ]
    );

    assert.equal(merged.length, 6);
    assert.ok(merged.some((o) => o.market === "Partida - Gols"));
    assert.ok(merged.some((o) => o.market === "Intervalo - Resultado"));
    assert.ok(merged.every((o) => o.market !== "Escalação"));
  });

  it("combina DOM parcial com parseOddsFromVisibleText completo", () => {
    const visible = parseOddsFromVisibleText(INPLAY_ODDS_FIXTURE);
    const merged = mergeOdds(
      [
        { market: "Resultado Final", selection: "Time Casa", odds: 1.5, source: "dom" },
        { market: "Resultado Final", selection: "Empate", odds: 4, source: "dom" },
      ],
      visible
    );

    assert.ok(merged.length >= 8);
    assert.ok(merged.some((o) => o.market === "Partida - Gols"));
    assert.ok(merged.some((o) => o.selection === "Menos de 2.5"));
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
    assert.deepEqual(cleaned.map((o) => o.selection).sort(), ["Empate", "Uruguai"]);
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
    const { annotateCandidateRanks, buildExtractionDebug } =
      await import("../lib/bet365-parsers.js");
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
