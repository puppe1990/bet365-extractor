import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MARKET_CATEGORY_TABS,
  MARKET_CATEGORY_TABS_VISIT,
  PREMATCH_MARKET_TABS_VISIT,
  collectMarketTabCandidates,
  gluedMarketTabCount,
  isGluedMarketTabContainer,
  isInLeftMarketColumn,
  isInMarketTabBand,
  isMarketCategoryTabLabel,
  isMarketTabLeafText,
  isPlayerMarketTabKey,
  isCornerMarketTabKey,
  leafMarketTabKey,
  marketCategoryTabKey,
  marketTabsVisitList,
  normalizeMarketTabLabel,
  pickSmallestTabCandidates,
  resolveMarketTabPageMode,
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
    assert.equal(MARKET_CATEGORY_TABS.length, 15);
    assert.ok(isMarketCategoryTabLabel("Todos"));
    assert.ok(MARKET_CATEGORY_TABS_VISIT.includes("Todos"));
    assert.ok(MARKET_CATEGORY_TABS_VISIT.includes("Jogador"));
    assert.ok(MARKET_CATEGORY_TABS_VISIT.length < MARKET_CATEGORY_TABS.length);
  });

  it("reconhece abas de mercado no cupom pré-jogo", () => {
    for (const tab of ["Jogador a Marcar", "Handicap", "Odds Asiáticas", "Resultado"]) {
      assert.ok(isMarketCategoryTabLabel(tab), tab);
      assert.equal(marketCategoryTabKey(tab), tab);
    }
    assert.ok(PREMATCH_MARKET_TABS_VISIT.includes("Jogador a Marcar"));
    assert.ok(PREMATCH_MARKET_TABS_VISIT.includes("Escanteios"));
    assert.ok(isMarketCategoryTabLabel("Escanteios"));
    assert.equal(
      marketTabsVisitList(
        resolveMarketTabPageMode("https://www.bet365.bet.br/#/AC/B1/C1/D8/E194699812/")
      ),
      PREMATCH_MARKET_TABS_VISIT
    );
    assert.equal(
      marketTabsVisitList(
        resolveMarketTabPageMode("https://www.bet365.bet.br/#/IP/EV151352326532C1/")
      ),
      MARKET_CATEGORY_TABS_VISIT
    );
    assert.ok(isPlayerMarketTabKey("Jogador a Marcar"));
  });

  it("identifica aba de escanteios para scroll dedicado", () => {
    assert.equal(isCornerMarketTabKey("Escanteios/Cartões"), true);
    assert.equal(isCornerMarketTabKey("Escanteios"), true);
    assert.equal(isCornerMarketTabKey("Gols"), false);
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
    assert.equal(
      isInMarketTabBand({ top: 350, left: 120, width: 60, height: 24 }, 900, 1200, "live"),
      true
    );
    assert.equal(
      isInMarketTabBand({ top: 480, left: 120, width: 60, height: 24 }, 900, 1200, "live"),
      true
    );
    assert.equal(
      isInMarketTabBand({ top: 450, left: 120, width: 60, height: 24 }, 1200, 1400, "live"),
      true
    );
    assert.equal(
      isInMarketTabBand({ top: 420, left: 120, width: 60, height: 24 }, 900, 1200, "prematch"),
      true
    );
    assert.equal(isInLeftMarketColumn({ top: 120, left: 120, width: 60, height: 24 }, 1200), true);
    assert.equal(isInLeftMarketColumn({ top: 120, left: 980, width: 60, height: 24 }, 1200), false);
  });

  it("aceita folha curta e container colado da faixa in-play", () => {
    assert.equal(isMarketTabLeafText("Escanteios/Cartões"), true);
    assert.equal(isMarketTabLeafText("Popular Instantâneas Gols"), false);

    const containerRects = [{ score: 6, rect: { top: 500, left: 40, bottom: 560, right: 900 } }];
    const picked = collectMarketTabCandidates(
      [
        {
          text: "Escanteios/Cartões",
          rect: { top: 520, left: 320, width: 120, height: 24, bottom: 544, right: 440 },
        },
        {
          text: "Popular",
          rect: { top: 520, left: 120, width: 70, height: 24, bottom: 544, right: 190 },
        },
      ],
      900,
      1200,
      "live",
      containerRects
    );

    assert.deepEqual(picked.map((t) => t.label).sort(), ["Escanteios/Cartões", "Popular"]);
  });

  it("coleta abas na coluna esquerda e ignora painel lateral", () => {
    const picked = collectMarketTabCandidates(
      [
        { text: "Popular", rect: { top: 410, left: 120, width: 80, height: 24 } },
        { text: "Jogador a Marcar", rect: { top: 410, left: 220, width: 120, height: 24 } },
        { text: "Estat.", rect: { top: 180, left: 900, width: 50, height: 22 } },
        { text: "Cronologia", rect: { top: 180, left: 980, width: 90, height: 22 } },
        {
          text: "Popular Jogador a Marcar Odds Asiáticas",
          rect: { top: 410, left: 120, width: 320, height: 24 },
          childTexts: ["Popular", "Jogador a Marcar", "Odds Asiáticas"],
        },
      ],
      900,
      1200,
      "prematch"
    );

    assert.deepEqual(picked.map((t) => t.label).sort(), ["Jogador a Marcar", "Popular"]);
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
