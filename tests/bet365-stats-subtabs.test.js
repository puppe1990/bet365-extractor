import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STATS_SUB_TAB_KEYS,
  extractStatsFromSubTabTexts,
  leafStatsSubTabKey,
  mergeStatsSubTabTexts,
  scoreStatsSubTabBarContainer,
  statsSubTabKey,
  summarizeStatsSubTabCapture,
} from "../lib/bet365-stats-subtabs.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => readFileSync(join(__dir, "fixtures", name), "utf8");

describe("bet365 stats sub-tabs", () => {
  it("reconhece abas horizontais de estatísticas ao vivo", () => {
    for (const tab of [
      "Marcadores",
      "Chutes",
      "Cartões/Faltas",
      "Estatísticas do Jogador",
      "Escanteios",
      "Gols",
      "1º Tempo/2º Tempo",
    ]) {
      assert.equal(statsSubTabKey(tab), tab);
    }
    assert.equal(statsSubTabKey("Outr ›"), "Outros");
  });

  it("detecta barra com várias sub-abas", () => {
    const glued =
      "Marcadores Chutes Cartões/Faltas Estatísticas do Jogador Resultado Escanteios Gols";
    assert.ok(scoreStatsSubTabBarContainer(glued) >= 5);
    assert.equal(leafStatsSubTabKey(glued), null);
    assert.equal(leafStatsSubTabKey("Chutes", ["Chutes"]), null);
    assert.equal(leafStatsSubTabKey("Chutes", []), "Chutes");
  });

  it("extrai stats da aba Chutes", () => {
    const textBySubTab = { chutes: readFixture("stats-subtab-chutes.txt") };
    const stats = extractStatsFromSubTabTexts(textBySubTab);

    assert.ok(stats.some((s) => s.label === "Chutes ao Gol" && s.home === "5" && s.away === "2"));
    assert.ok(stats.every((s) => s.subTab === "chutes"));
  });

  it("resume captura por sub-aba", () => {
    const summary = summarizeStatsSubTabCapture(
      { chutes: "Chutes\n5\n2", marcadores: "Marcadores" },
      { chutes: true }
    );

    assert.equal(summary.chutes.clicked, true);
    assert.equal(summary.chutes.captured, true);
    assert.equal(summary.marcadores.clicked, false);
    assert.equal(STATS_SUB_TAB_KEYS.length, 9);
  });

  it("merge de textos preserva ordem das chaves", () => {
    const merged = mergeStatsSubTabTexts({
      marcadores: "Marcadores",
      chutes: "Chutes",
    });

    assert.match(merged, /Marcadores[\s\S]*---STATS-SUBTAB---[\s\S]*Chutes/);
  });
});
