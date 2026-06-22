import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectSidePanelTabCandidates,
  isInSidePanelTabBand,
  leafSidePanelTabKey,
  normalizeSidePanelTabLabel,
  scoreSidePanelTabBarContainer,
  sidePanelTabKeyFromText,
} from "../lib/bet365-side-panel-tabs.js";

describe("bet365 side panel tabs", () => {
  it("normaliza rótulos com seta e espaços", () => {
    assert.equal(normalizeSidePanelTabLabel("  Estat. › "), "Estat.");
    assert.equal(normalizeSidePanelTabLabel("Cronologia >"), "Cronologia");
  });

  it("reconhece abas do painel lateral", () => {
    assert.equal(sidePanelTabKeyFromText("Estat."), "stats");
    assert.equal(sidePanelTabKeyFromText("Estatísticas"), "stats");
    assert.equal(sidePanelTabKeyFromText("Cronologia"), "timeline");
    assert.equal(sidePanelTabKeyFromText("Escalação"), "lineup");
    assert.equal(sidePanelTabKeyFromText("Estatísticas de Jogador"), "playerStats");
    assert.equal(sidePanelTabKeyFromText("Popular"), null);
    assert.equal(sidePanelTabKeyFromText("Jogador a Marcar"), null);
  });

  it("prefere folha em vez de container pai", () => {
    assert.equal(leafSidePanelTabKey("Estat.", ["Estat."]), null);
    assert.equal(leafSidePanelTabKey("Estat.", []), "stats");
    assert.equal(leafSidePanelTabKey("Cronologia", ["Outro"]), "timeline");
  });

  it("detecta container colado do painel lateral", () => {
    const glued = "Estat. Cronologia Escalação Estatísticas de Jogador";
    assert.ok(scoreSidePanelTabBarContainer(glued) >= 6);
  });

  it("restringe abas à faixa direita da tela", () => {
    assert.equal(isInSidePanelTabBand({ top: 120, left: 820, width: 60, height: 24 }, 1200), true);
    assert.equal(isInSidePanelTabBand({ top: 120, left: 120, width: 60, height: 24 }, 1200), false);
  });

  it("coleta candidatos na coluna direita e ignora mercados à esquerda", () => {
    const picked = collectSidePanelTabCandidates(
      [
        { text: "Popular", rect: { top: 120, left: 120, width: 80, height: 24 } },
        { text: "Jogador", rect: { top: 120, left: 200, width: 80, height: 24 } },
        { text: "Estat.", rect: { top: 180, left: 900, width: 50, height: 22 }, childTexts: [] },
        {
          text: "Cronologia",
          rect: { top: 180, left: 980, width: 90, height: 22 },
          childTexts: [],
        },
        {
          text: "Estat. Cronologia Escalação",
          rect: { top: 180, left: 900, width: 240, height: 22 },
          childTexts: ["Estat.", "Cronologia", "Escalação"],
        },
        {
          text: "Escalação",
          rect: { top: 180, left: 1080, width: 80, height: 22 },
          childTexts: [],
        },
      ],
      1200
    );

    assert.deepEqual(picked.map((t) => t.key).sort(), ["lineup", "stats", "timeline"]);
  });
});
