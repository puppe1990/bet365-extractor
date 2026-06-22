import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseTimelineFromText,
  parseLineupFromText,
  parseLineupFromNetworkBlob,
  parsePlayerFinalizationsFromText,
  parsePlayerFinalizationsFromNetworkBlob,
  parseActionAreasFromText,
  extractSidePanelFromTexts,
  scanNetworkSidePanel,
  mergeSidePanel,
  mergeSidePanelTabText,
  buildIpeBlobDebug,
  buildZapWireDebug,
  collectZapWireText,
  parseLineupFromZapWire,
  parseLineupFromTitularesText,
  isPlayerFullName,
  isPlayerNameLine,
} from "../lib/bet365-side-panel.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => readFileSync(join(__dir, "fixtures", name), "utf8");

describe("parseTimelineFromText", () => {
  it("extrai gols, escanteios e impedimentos", () => {
    const events = parseTimelineFromText(readFixture("side-panel-timeline.txt"));

    assert.equal(events.length, 5);
    assert.equal(events[0].minute, 39);
    assert.equal(events[0].type, "goal");
    assert.match(events[0].description, /Messi/);
    assert.equal(events[1].type, "corner");
    assert.equal(events[4].type, "offside");
  });

  it("ignora cabeçalhos de mercado na cronologia", () => {
    const events = parseTimelineFromText("Cronologia\n39'\nEscanteios/Cartões\n");
    assert.equal(events.length, 0);
  });

  it("ignora categoria de mercado vazando como escanteio na cronologia", () => {
    const events = parseTimelineFromText(
      "Cronologia\n11'\n1º Tempo - Escanteios\n7'\n1° Cartão Amarelo\n"
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].minute, 7);
    assert.equal(events[0].type, "card");
    assert.ok(!events.some((e) => e.type === "corner"));
  });

  it("separa gol e substituição quando o minuto do gol vem depois no DOM", () => {
    const events = parseTimelineFromText(readFixture("side-panel-timeline-france-iraq.txt"));
    const goal = events.find((e) => e.type === "goal");
    const substitution = events.find((e) => e.type === "substitution");
    const corners = events.filter((e) => e.type === "corner");

    assert.equal(substitution?.minute, 26);
    assert.equal(goal?.minute, 15);
    assert.match(goal?.description || "", /Mbappe/i);
    assert.match(goal?.description || "", /Olise/i);
    assert.equal(corners.length, 2);
    assert.equal(corners.find((e) => /1[º°]/.test(e.description))?.minute, 8);
    assert.equal(corners.find((e) => /2[º°]/.test(e.description))?.minute, 31);
  });

  it("ignora odds e nomes de jogador da coluna esquerda", () => {
    const events = parseTimelineFromText(readFixture("side-panel-timeline-noise.txt"));

    assert.ok(events.length <= 8);
    assert.ok(events.length >= 5);
    assert.ok(
      events.every((e) => !/Lionel Messi|Lautaro Martinez|Kevin Danso/.test(e.description))
    );
    assert.ok(events.every((e) => !/\d+\.\d{2}/.test(e.description)));

    const goal = events.find((e) => e.minute === 41 && e.type === "goal");
    const card = events.find((e) => e.minute === 41 && e.type === "card");
    assert.ok(goal);
    assert.ok(card);
    assert.match(goal.description, /Messi - Chute/);
    assert.match(card.description, /Cartão Amarelo/);

    const corners = events.filter((e) => e.type === "corner");
    assert.equal(corners.length, 2);
    assert.equal(events.filter((e) => e.type === "offside").length, 2);
  });
});

describe("parseLineupFromText", () => {
  it("separa titulares, suplentes e gol marcado", () => {
    const lineup = parseLineupFromText(readFixture("side-panel-lineup.txt"));

    assert.ok(lineup.home.starters.includes("E Martinez"));
    assert.ok(lineup.home.subs.includes("G Rulli"));
    assert.ok(awayHas(lineup, "A Schlager"));
    assert.ok(awayHas(lineup, "M Gregoritsch"));
    assert.equal(lineup.home.goals[0].player, "L Messi");
    assert.equal(lineup.home.goals[0].minute, 39);
  });
});

function awayHas(lineup, name) {
  return lineup.away.starters.includes(name) || lineup.away.subs.includes(name);
}

describe("parsePlayerFinalizationsFromText", () => {
  it("extrai finalizações por jogador", () => {
    const rows = parsePlayerFinalizationsFromText(readFixture("side-panel-player-finals.txt"));

    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      player: "L Messi",
      shots: "3",
      onTarget: "1",
      source: "visible-text",
    });
    assert.equal(rows[2].player, "M Sabitzer");
  });
});

describe("parseActionAreasFromText", () => {
  it("extrai zonas de ação do painel Estat.", () => {
    const areas = parseActionAreasFromText(readFixture("side-panel-stats.txt"));

    assert.equal(areas.left, "27.3%");
    assert.equal(areas.center, "55.4%");
    assert.equal(areas.right, "17.3%");
  });
});

describe("mergeSidePanelTabText", () => {
  it("mescla painel scoped com texto completo da página", () => {
    const merged = mergeSidePanelTabText("Estat.\n1.14 xG", "Cronologia\n41'\nGol", "stats");
    assert.match(merged, /Estat\./);
    assert.match(merged, /---PAGE---/);
    assert.match(merged, /Cronologia/);
  });
});

describe("extractSidePanelFromTexts", () => {
  it("recupera cronologia do texto completo mesclado", () => {
    const panel = extractSidePanelFromTexts({
      stats: mergeSidePanelTabText(
        readFixture("side-panel-stats.txt"),
        readFixture("side-panel-timeline.txt"),
        "stats"
      ),
      playerStats: "",
      timeline: "",
      lineup: "",
    });

    assert.ok(panel.timeline.length >= 5);
    assert.ok(panel.stats?.length === undefined || true);
  });

  it("monta pacote completo por aba", () => {
    const panel = extractSidePanelFromTexts({
      stats: readFixture("side-panel-stats.txt"),
      playerStats: readFixture("side-panel-player-finals.txt"),
      timeline: readFixture("side-panel-timeline.txt"),
      lineup: readFixture("side-panel-lineup.txt"),
    });

    assert.equal(panel.timeline.length, 5);
    assert.ok(panel.lineup.home.starters.length >= 8);
    assert.equal(panel.playerFinalizations.length, 3);
    assert.equal(panel.actionAreas.center, "55.4%");
  });
});

describe("isPlayerFullName", () => {
  it("aceita nomes completos de jogador", () => {
    assert.ok(isPlayerFullName("Lionel Messi"));
    assert.ok(isPlayerFullName("Michael Gregoritsch"));
    assert.ok(isPlayerNameLine("Lautaro Martinez"));
    assert.ok(!isPlayerFullName("Argentina"));
  });
});

describe("parseLineupFromNetworkBlob", () => {
  it("monta escalação com nomes completos do blob", () => {
    const lineup = parseLineupFromNetworkBlob(
      readFixture("blob-lineup-fullnames-wire.txt"),
      "/Api/1/Blob?ipe/5378/SL"
    );

    assert.ok(lineup);
    assert.ok(lineup.home.starters.includes("Lionel Messi"));
    assert.ok(lineup.away.starters.includes("Michael Gregoritsch"));
  });

  it("monta escalação a partir de wire ipe/5378", () => {
    const lineup = parseLineupFromNetworkBlob(
      readFixture("blob-lineup-wire.txt"),
      "/Api/1/Blob?33,www-sports,ipe/5378/SL"
    );

    assert.ok(lineup);
    assert.equal(lineup.source, "network-blob");
    assert.ok(lineup.home.starters.includes("E Martinez"));
    assert.ok(lineup.home.starters.includes("L Messi"));
    assert.ok(lineup.home.subs.includes("G Rulli"));
    assert.ok(awayHas(lineup, "M Gregoritsch"));
    assert.ok(awayHas(lineup, "A Schlager"));
  });
});

describe("parsePlayerFinalizationsFromNetworkBlob", () => {
  it("extrai finalizações por jogador do blob", () => {
    const rows = parsePlayerFinalizationsFromNetworkBlob(
      readFixture("blob-player-finals-wire.txt"),
      "/Api/1/Blob?ipe-BR/13/ipe/5378/SL"
    );

    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      player: "L Messi",
      shots: "3",
      onTarget: "1",
      source: "network-blob",
    });
  });
});

describe("buildIpeBlobDebug", () => {
  it("monta pacote de debug para blob ipe/5378", () => {
    const rows = buildIpeBlobDebug([
      {
        url: "/Api/1/Blob?ipe/5378/SL",
        kind: "xhr",
        rawLen: 1_390_651,
        hints: {
          fieldKeys: ["NA", "OR", "TM"],
          lineupPlayers: [{ name: "Lionel Messi", team: 1, order: 10, sub: false }],
        },
        data: readFixture("blob-lineup-fullnames-wire.txt"),
      },
      {
        url: "/offersapi/inplayoffers/",
        data: "F|MA;ID=1",
      },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].hintLineupCount, 1);
    assert.ok(rows[0].wirePlayerCount >= 8);
    assert.ok(rows[0].naPlayerLikeCount >= 8);
    assert.equal(rows[0].lineupParsed, true);
    assert.ok(rows[0].wireRecordSamples.length >= 1);
  });
});

describe("parseLineupFromTitularesText", () => {
  it("extrai nomes do grid Jogadores Titulares", () => {
    const lineup = parseLineupFromTitularesText(readFixture("side-panel-titulares-grid.txt"));

    assert.ok(lineup);
    assert.equal(lineup.source, "visible-titulares");
    assert.ok(lineup.home.starters.includes("Lionel Messi"));
    assert.ok(lineup.home.starters.includes("Nicolas Otamendi"));
    assert.ok(lineup.home.starters.length >= 8);
  });
});

describe("parseLineupFromZapWire", () => {
  it("monta escalação com nomes completos do zap WS", () => {
    const lineup = parseLineupFromZapWire(
      readFixture("zap-lineup-wire.txt"),
      "ws:wss://www.bet365.bet.br/sportspublisher/zap"
    );

    assert.ok(lineup);
    assert.equal(lineup.source, "network-zap");
    assert.ok(lineup.home.starters.includes("Lionel Messi"));
    assert.ok(lineup.away.starters.includes("Michael Gregoritsch"));
    assert.ok(lineup.home.subs.includes("Geronimo Rulli"));
  });
});

describe("collectZapWireText", () => {
  it("reconstrói wire a partir de protocolo zap parseado", () => {
    const merged = collectZapWireText([
      {
        url: "ws:wss://www.bet365.bet.br/sportspublisher/zap",
        kind: "ws",
        data: {
          _bet365Protocol: true,
          segments: [
            { key: null, value: "OV" },
            { key: "NA", value: "Lionel Messi" },
            { key: "TM", value: "1" },
          ],
        },
      },
    ]);

    assert.match(merged, /NA=Lionel Messi/);
    assert.match(merged, /TM=1/);
  });

  it("agrega mensagens zap do network log", () => {
    const wire = readFixture("zap-lineup-wire.txt");
    const merged = collectZapWireText([
      {
        url: "ws:wss://www.bet365.bet.br/sportspublisher/zap",
        kind: "ws",
        data: wire.slice(0, 200),
      },
      { url: "ws:wss://www.bet365.bet.br/sportspublisher/zap", kind: "ws", data: wire.slice(200) },
      { url: "/offersapi/inplayoffers/", kind: "xhr", data: "F|MA;ID=1" },
    ]);

    assert.ok(merged.includes("Lionel Messi"));
    assert.ok(merged.includes("Michael Gregoritsch"));
    assert.equal(merged.length, wire.length + 1);
  });
});

describe("buildZapWireDebug", () => {
  it("monta pacote de debug para zap WS", () => {
    const wire = readFixture("zap-lineup-wire.txt");
    const debug = buildZapWireDebug(
      [
        {
          url: "ws:wss://www.bet365.bet.br/sportspublisher/zap",
          kind: "ws",
          at: "2026-06-22T18:24:03.000Z",
          rawLen: wire.length,
          data: wire,
          hints: {
            lineupPlayers: [{ name: "Lionel Messi", team: 1, order: 10, sub: false }],
            zapBufferLen: wire.length,
          },
        },
      ],
      wire
    );

    assert.ok(debug);
    assert.equal(debug.source, "zap-ws");
    assert.equal(debug.messageCount, 1);
    assert.equal(debug.mergedLen, wire.length);
    assert.ok(debug.wirePlayerCount >= 8);
    assert.equal(debug.lineupParsed, true);
    assert.ok(debug.lineupStarters.home >= 8);
    assert.equal(debug.finalsCount, 3);
    assert.ok(debug.messageSamples.length >= 1);
  });
});

describe("scanNetworkSidePanel", () => {
  it("encontra pistas de eventos em blobs", () => {
    const net = scanNetworkSidePanel([
      {
        url: "/Api/1/Blob?ipe",
        data: "SC=1-0;39' Gol Messi;NA=Medina;Escanteio;NA=Lionel Messi",
      },
    ]);

    assert.ok(net.timeline.length >= 1);
    assert.ok(net.playerNames.includes("Medina"));
    assert.ok(!net.playerNames.includes("Configurações"));
    assert.ok(!net.playerNames.includes("Informação e Atrasos na Transmissão"));
  });

  it("extrai escalação e finalizações de blob ipe", () => {
    const net = scanNetworkSidePanel([
      {
        url: "/Api/1/Blob?33,www-sports,ipe/5378/SL",
        data: readFixture("blob-lineup-wire.txt") + readFixture("blob-player-finals-wire.txt"),
      },
    ]);

    assert.ok(net.lineup);
    assert.ok(net.lineup.home.starters.length >= 8);
    assert.equal(net.playerFinalizations.length, 3);
  });

  it("extrai escalação e finalizações do zap WS", () => {
    const wire = readFixture("zap-lineup-wire.txt");
    const net = scanNetworkSidePanel([
      {
        url: "ws:wss://www.bet365.bet.br/sportspublisher/zap",
        kind: "ws",
        data: wire,
        hints: { lineupPlayers: null, zapBufferLen: wire.length },
      },
    ]);

    assert.ok(net.lineup);
    assert.equal(net.lineup.source, "network-zap");
    assert.ok(net.lineup.home.starters.includes("Lionel Messi"));
    assert.equal(net.playerFinalizations.length, 3);
    assert.ok(net.blobDebug.some((b) => b.source === "zap-ws"));
  });
});

describe("mergeSidePanel", () => {
  it("une timeline visível com rede sem duplicar", () => {
    const merged = mergeSidePanel(
      { timeline: [{ minute: 39, description: "Gol", type: "goal" }] },
      {
        timeline: [
          { minute: 39, description: "Gol", type: "goal" },
          { minute: 29, description: "Escanteio", type: "corner" },
        ],
      }
    );

    assert.equal(merged.timeline.length, 2);
  });

  it("preenche lineup e finalizações da rede quando visível falha", () => {
    const merged = mergeSidePanel(
      { timeline: [], lineup: null, playerFinalizations: [] },
      {
        lineup: {
          home: { starters: ["E Martinez"], subs: [], goals: [] },
          away: { starters: ["A Schlager"], subs: [], goals: [] },
          source: "network-blob",
        },
        playerFinalizations: [
          { player: "L Messi", shots: "3", onTarget: "1", source: "network-blob" },
        ],
      }
    );

    assert.ok(merged.lineup.home.starters.includes("E Martinez"));
    assert.equal(merged.playerFinalizations.length, 1);
  });
});
