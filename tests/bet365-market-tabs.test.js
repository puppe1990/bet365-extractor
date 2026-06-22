import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MARKET_CATEGORY_TABS,
  MARKET_CATEGORY_TABS_VISIT,
  gluedMarketTabCount,
  isGluedMarketTabContainer,
  isInMarketTabBand,
  isMarketCategoryTabLabel,
  leafMarketTabKey,
  marketCategoryTabKey,
  normalizeMarketTabLabel,
  pickSmallestTabCandidates,
  scoreMarketTabBarContainer,
} from "../lib/bet365-market-tabs.js";

describe("bet365 market category tabs", () => {
  it("reconhece abas horizontais do jogo ao vivo", () => {
    for (const tab of [
      "Popular",
      "Instantâneas",
      "Escanteios/Cartões",
      "Gols",
      "1º Tempo/2º Tempo",
      "Jogador",
    ]) {
      assert.ok(isMarketCategoryTabLabel(tab), tab);
      assert.equal(marketCategoryTabKey(tab), tab);
    }
  });

  it("ignora Criar Aposta e abas do painel lateral", () => {
    assert.equal(isMarketCategoryTabLabel("Criar Aposta"), false);
    assert.equal(isMarketCategoryTabLabel("Estat."), false);
    assert.equal(isMarketCategoryTabLabel("Cronologia"), false);
    assert.equal(isMarketCategoryTabLabel("Escalação"), false);
  });

  it("normaliza espaços no rótulo", () => {
    assert.equal(normalizeMarketTabLabel("  Jogador \n"), "Jogador");
    assert.equal(MARKET_CATEGORY_TABS.length, 9);
    assert.ok(MARKET_CATEGORY_TABS_VISIT.includes("Jogador"));
    assert.ok(MARKET_CATEGORY_TABS_VISIT.length < MARKET_CATEGORY_TABS.length);
  });

  it("detecta container colado com várias abas", () => {
    const glued = "Popular Instantâneas Gols Jogador Escanteios/Cartões";
    assert.equal(gluedMarketTabCount(glued), 5);
    assert.equal(isGluedMarketTabContainer(glued), true);
    assert.equal(leafMarketTabKey(glued), null);
    assert.ok(scoreMarketTabBarContainer(glued) >= 5);
  });

  it("prefere folha em vez de container pai", () => {
    assert.equal(leafMarketTabKey("Jogador", ["Jogador"]), null);
    assert.equal(leafMarketTabKey("Jogador", []), "Jogador");
    assert.equal(leafMarketTabKey("  Gols  ", ["Outro"]), "Gols");
  });

  it("relaxa faixa vertical das abas", () => {
    assert.equal(isInMarketTabBand({ top: 350, left: 120, width: 60, height: 24 }, 900, 1200), true);
    assert.equal(isInMarketTabBand({ top: 420, left: 120, width: 60, height: 24 }, 900, 1200), false);
    assert.equal(isInMarketTabBand({ top: 450, left: 120, width: 60, height: 24 }, 1200, 1400), true);
  });

  it("escolhe candidato com menor área por rótulo", () => {
    const picked = pickSmallestTabCandidates([
      { label: "Jogador", area: 4000, el: {} },
      { label: "Jogador", area: 900, el: {} },
      { label: "Gols", area: 1200, el: {} },
    ]);
    assert.equal(picked.length, 2);
    assert.equal(picked.find((t) => t.label === "Jogador").area, 900);
  });
});