import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldInjectSniffer,
  resolveExtractTabId,
  resolveInjectTabId,
  isSnifferInjectOk,
  buildDownloadOptions,
  sanitizeDownloadRequest,
  buildZipDataUrl,
  armDownloadFilename,
  resolveDeterminedFilename,
} from "../extension/extension-background.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

function readBuilt(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("extension-background helpers", () => {
  it("shouldInjectSniffer aceita URL de jogo ao vivo", () => {
    assert.equal(shouldInjectSniffer("https://www.bet365.bet.br/#/IP/EV151352326692C1/"), true);
    assert.equal(shouldInjectSniffer("https://www.bet365.com/#/IP/EV123456789012C1/"), true);
  });

  it("shouldInjectSniffer rejeita home e páginas sem evento", () => {
    assert.equal(shouldInjectSniffer("https://www.bet365.bet.br/"), false);
    assert.equal(shouldInjectSniffer("https://example.com/#/IP/EV123/"), false);
  });

  it("resolveExtractTabId prioriza tabId da mensagem", () => {
    assert.equal(resolveExtractTabId({ tabId: 42 }, { tab: { id: 7 } }), 42);
    assert.equal(resolveExtractTabId({}, { tab: { id: 7 } }), 7);
    assert.equal(resolveExtractTabId({}, {}), null);
  });

  it("resolveInjectTabId usa os mesmos fallbacks", () => {
    assert.equal(resolveInjectTabId({ tabId: 99 }, { tab: { id: 1 } }), 99);
    assert.equal(resolveInjectTabId({}, { tab: { id: 5 } }), 5);
  });

  it("isSnifferInjectOk reflete resposta do background", () => {
    assert.equal(isSnifferInjectOk({ ok: true }), true);
    assert.equal(isSnifferInjectOk({ ok: false }), false);
    assert.equal(isSnifferInjectOk(undefined), false);
  });

  it("sanitizeDownloadRequest limpa caracteres inválidos", () => {
    assert.equal(sanitizeDownloadRequest("copa/jogo:test.zip"), "copa-jogo-test.zip");
  });

  it("buildDownloadOptions preserva filename no service worker", () => {
    const options = buildDownloadOptions(
      "data:application/zip;base64,UEsFBg==",
      "copa-do-mundo-2026-argentina-austria-0-0-2026-06-22_17-25-29.zip"
    );

    assert.equal(options.url, "data:application/zip;base64,UEsFBg==");
    assert.equal(
      options.filename,
      "copa-do-mundo-2026-argentina-austria-0-0-2026-06-22_17-25-29.zip"
    );
    assert.equal(options.saveAs, false);
    assert.equal(options.conflictAction, "uniquify");
  });

  it("buildZipDataUrl monta data URL sem blob URL", () => {
    assert.equal(buildZipDataUrl("UEsFBg=="), "data:application/zip;base64,UEsFBg==");
  });

  it("resolveDeterminedFilename força nome salvo pelo Chrome", () => {
    const pending = { value: null };
    armDownloadFilename(
      pending,
      "copa-do-mundo-2026-argentina-austria-0-0-2026-06-22_17-27-16.zip"
    );

    const resolved = resolveDeterminedFilename({ byExtensionId: "ext-1" }, pending, "ext-1");

    assert.equal(resolved, "copa-do-mundo-2026-argentina-austria-0-0-2026-06-22_17-27-16.zip");
    assert.equal(pending.value, null);
  });
});

describe("extension sniffer wiring", () => {
  it("background envia tabId no EXTRACT", () => {
    const source = readBuilt("extension/background.js");
    assert.match(source, /type:\s*"EXTRACT"/);
    assert.match(source, /tabId/);
    assert.doesNotMatch(source, /sendMessage\(tabId,\s*\{\s*type:\s*"EXTRACT"\s*\}\)/);
  });

  it("content script resolve tabId da mensagem e injeta sniffer com fallback", () => {
    const template = readBuilt("templates/extension-content.js");
    assert.match(template, /message\.tabId/);
    assert.match(template, /injectPageNetworkSniffer/);
    assert.match(template, /INJECT_SNIFFER/);
    assert.match(template, /collectSidePanelTexts/);
    assert.match(template, /collectStatsSubTabTexts/);
    assert.match(template, /collectStatsSubTabTexts\(statsRoot, statsTab\)/);
    assert.match(template, /function collectStatsSubTabCandidates\(root, fromTab/);
    assert.match(template, /collectStatsSubTabCandidatesFromNodes/);
    assert.match(template, /STATS_SUB_TAB_LEAF_SELECTORS/);
    assert.match(template, /await scrollStatsSubTabBars\(searchRoot\)/);
    assert.match(template, /STATS_SUB_TAB_KEYS/);
    assert.match(template, /extractStatsFromSubTabTexts/);
    assert.match(template, /getSidePanelText/);
    assert.match(template, /findSidePanelRoot/);
    assert.match(template, /scrollLeftColumnMarkets/);
    assert.match(template, /visitMarketCategoryTabs/);
    assert.match(template, /collectMarketCategoryTabs/);
    assert.match(template, /dispatchMarketTabClick/);
    assert.match(template, /leafMarketTabKey/);
    assert.match(template, /scoreMarketTabBarContainer/);
    assert.match(template, /scrollPlayerPropGrids/);
    assert.match(template, /mergeSidePanelTabText/);
    assert.match(template, /marketTabsVisitList/);
    assert.match(template, /scrapeMarketsViaScripting/);
    assert.match(template, /SCROLL_MARKETS/);
    assert.match(template, /mainWorldScroll/);
    assert.match(template, /mergeScrollSnapshots/);
    assert.match(template, /EventViewDetailScroller/);
    assert.match(template, /scrollIntoView/);
    assert.match(template, /SIDE_PANEL_TAB_KEYS/);
    assert.match(template, /SIDE_PANEL_STATS_HARVEST_KEYS/);
    assert.match(template, /ingestSidePanelTabStats/);
    assert.match(template, /SIDE_PANEL_TAB_SCOPE_SELECTORS/);
    assert.match(template, /collectSidePanelTabElements/);
    assert.match(template, /getMarketTabsVisitList/);
    assert.match(template, /resolveMarketTabPageMode/);
    assert.match(template, /isPlayerMarketTabKey/);
    assert.match(template, /extractSidePanelFromTexts/);
    assert.doesNotMatch(
      template,
      /if\s*\(\s*!tabId\s*\|\|\s*!chrome\.runtime\?\.sendMessage\s*\)\s*return\s*false/
    );
  });

  it("build embute código do page sniffer para fallback local", () => {
    const built = readBuilt("extension/dist/content.js");
    assert.match(built, /__BET365_PAGE_SNIFFER_SOURCE__/);
    assert.match(built, /bet365PageNetworkSniffer/);
    assert.match(built, /injectPageNetworkSniffer\(__BET365_PAGE_SNIFFER_SOURCE__\)/);
    assert.match(built, /parseTimelineFromText/);
    assert.match(built, /collectSidePanelTexts/);
    assert.match(built, /scrapeMarketsViaScripting/);
    assert.match(built, /parseLineupFromNetworkBlob/);
  });

  it("page sniffer extrai lineupPlayers de blob ipe", () => {
    const sniffer = readBuilt("extension/dist/network-page-sniffer.js");
    assert.match(sniffer, /lineupPlayers/);
    assert.match(sniffer, /LINEUP_BLOB_URL_RE/);
    assert.match(sniffer, /extractLineupHints/);
  });

  it("page sniffer agrega buffer zap WS para escalação", () => {
    const sniffer = readBuilt("extension/dist/network-page-sniffer.js");
    assert.match(sniffer, /zapWireBuffer/);
    assert.match(sniffer, /appendZapWire/);
    assert.match(sniffer, /MAX_RAW_ZAP/);
    assert.match(sniffer, /MAX_ZAP_BUFFER/);
    assert.match(sniffer, /zapBufferLen/);
    assert.match(sniffer, /sportspublisher\\\/zap/);
  });

  it("background faz download do ZIP fora do popup", () => {
    const source = readBuilt("extension/background.js");
    assert.match(source, /DOWNLOAD_ZIP/);
    assert.match(source, /zipBase64/);
    assert.match(source, /buildZipDataUrl/);
    assert.match(source, /onDeterminingFilename/);
    assert.match(source, /chrome\.downloads\.download/);
  });

  it("popup delega download ao background", () => {
    const source = readBuilt("extension/popup/popup.js");
    assert.match(source, /DOWNLOAD_ZIP/);
    assert.match(source, /zipBase64/);
    assert.match(source, /readAsDataURL/);
    assert.doesNotMatch(source, /URL\.createObjectURL\(blob\)/);
    assert.doesNotMatch(source, /dataUrl/);
  });

  it("background valida instalação do sniffer no MAIN world", () => {
    const source = readBuilt("extension/background.js");
    assert.match(source, /__bet365PageSnifferInstalled/);
    assert.match(source, /sniffer-not-installed/);
    assert.match(
      source,
      /injectPageSniffer\(tabId\)\s*\n\s*\.then\(\(\)\s*=>\s*sendResponse\(\{\s*ok:\s*true\s*\}\)\)/
    );
  });

  it("background executa scroll de mercados no MAIN world", () => {
    const source = readBuilt("extension/background.js");
    assert.match(source, /SCROLL_MARKETS/);
    assert.match(source, /mainWorldMarketScrollFunc/);
    assert.match(source, /world:\s*"MAIN"/);
  });

  it("main world scroll visita abas horizontais de mercado", () => {
    const source = readBuilt("extension/main-world-scroll.js");
    assert.match(source, /visitMarketCategoryTabs/);
    assert.match(source, /collectMarketCategoryTabs/);
    assert.match(source, /scrollPlayerPropGrids/);
    assert.match(source, /MARKET_CATEGORY_TABS_VISIT/);
    assert.match(source, /Instantâneas/);
    assert.match(source, /Escanteios\/Cartões/);
    assert.match(source, /Jogador/);
    assert.match(source, /tabsVisited/);
    assert.match(source, /tabsFound/);
    assert.match(source, /dispatchTabClick/);
    assert.match(source, /collectMarketTabCandidates/);
    assert.match(source, /PREMATCH_MARKET_TABS_VISIT/);
    assert.match(source, /Jogador a Marcar/);
    assert.match(source, /MARKET_TAB_CONTAINER_SELECTORS/);
  });

  it("main-world-scroll é gerado a partir do template de build", () => {
    const template = readBuilt("templates/main-world-scroll.js");
    const built = readBuilt("extension/main-world-scroll.js");
    assert.match(template, /\/\* __MARKET_TABS__ \*\//);
    assert.doesNotMatch(built, /\/\* __MARKET_TABS__ \*\//);
    assert.match(built, /function collectMarketTabCandidates/);
  });
});
