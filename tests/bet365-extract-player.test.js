import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_EXTRACT_PLAYER_INTERVAL_MS,
  parseIntervalInput,
  formatPlayerCountdown,
  clampBallPosition,
  summarizeExtractPreview,
  createExtractPlayerScheduler,
  defaultBallPosition,
  shouldAutoDownloadZipAfterExtract,
  shouldDownloadExtractZip,
  isPageTextReadyForExtract,
  isPageReadyForExtract,
  isPageLikelyFailedToLoad,
  getExtractPlayerStatusMessage,
  isExtractDataReady,
  serializePlayerState,
  parsePlayerState,
  MIN_PAGE_TEXT_FOR_EXTRACT,
  EXTRACT_RETRY_DELAY_MS,
} from "../lib/bet365-extract-player.js";

describe("parseIntervalInput", () => {
  it("parseia segundos numéricos", () => {
    assert.equal(parseIntervalInput("60"), 60_000);
    assert.equal(parseIntervalInput("45s"), 45_000);
  });

  it("parseia mm:ss e minutos abreviados", () => {
    assert.equal(parseIntervalInput("1:30"), 90_000);
    assert.equal(parseIntervalInput("2m"), 120_000);
  });

  it("aplica intervalo mínimo", () => {
    assert.equal(parseIntervalInput("10"), MIN_EXTRACT_PLAYER_INTERVAL_MS);
    assert.equal(parseIntervalInput("0"), MIN_EXTRACT_PLAYER_INTERVAL_MS);
  });

  it("retorna null para entrada inválida", () => {
    assert.equal(parseIntervalInput(""), null);
    assert.equal(parseIntervalInput("abc"), null);
  });
});

describe("formatPlayerCountdown", () => {
  it("formata mm:ss com zero à esquerda", () => {
    assert.equal(formatPlayerCountdown(83_000), "01:23");
    assert.equal(formatPlayerCountdown(5_000), "00:05");
    assert.equal(formatPlayerCountdown(0), "00:00");
  });
});

describe("clampBallPosition", () => {
  it("mantém a bola dentro da viewport", () => {
    const pos = clampBallPosition({ x: -10, y: 5000 }, { width: 1200, height: 800 }, 72);

    assert.equal(pos.x, 0);
    assert.equal(pos.y, 800 - 72);
  });
});

describe("defaultBallPosition", () => {
  it("posiciona a bola centralizada abaixo da área do jogo", () => {
    const pos = defaultBallPosition({ width: 1200, height: 900 }, 72);

    assert.equal(pos.x, (1200 - 72) / 2);
    assert.ok(pos.y >= 700);
  });
});

describe("summarizeExtractPreview ready data", () => {
  it("resume placar e contagens", () => {
    const text = summarizeExtractPreview({
      match: {
        homeTeam: "Noruega",
        awayTeam: "Senegal",
        score: "3-1",
        clock: "66:12",
        scoreConfidence: "high",
      },
      meta: { visibleTextLength: 120_000 },
      stats: [{}, {}],
      odds: [{}, {}, {}],
      sidePanel: { timeline: [{}, {}] },
    });

    assert.match(text, /Noruega/);
    assert.match(text, /3-1/);
    assert.match(text, /66:12/);
    assert.match(text, /2 stats/);
    assert.match(text, /3 odds/);
  });
});

describe("isPageTextReadyForExtract", () => {
  it("rejeita página com pouco texto", () => {
    assert.equal(isPageTextReadyForExtract("Noruega v Senegal"), false);
  });

  it("rejeita shell da bet365 sem times no cabeçalho", () => {
    const text = `${"x".repeat(MIN_PAGE_TEXT_FOR_EXTRACT)} Ao-Vivo Cassino Promoções Resultado Final`;
    assert.equal(isPageTextReadyForExtract(text), false);
  });

  it("aceita página com mercados visíveis", () => {
    const text = `${"x".repeat(MIN_PAGE_TEXT_FOR_EXTRACT)} Noruega v Senegal Resultado Final`;
    assert.equal(isPageTextReadyForExtract(text), true);
  });
});

describe("isPageReadyForExtract", () => {
  it("exige DOM de mercados quando informado", () => {
    const text = `${"x".repeat(MIN_PAGE_TEXT_FOR_EXTRACT)} Noruega v Senegal Resultado Final`;
    assert.equal(isPageReadyForExtract(text, { hasMarketDom: true }), true);
    assert.equal(isPageReadyForExtract(text, { hasMarketDom: false }), false);
  });
});

describe("isPageLikelyFailedToLoad", () => {
  it("detecta página escura sem mercados nem times", () => {
    assert.equal(
      isPageLikelyFailedToLoad("Ao-Vivo\nCassino\nPromoções", { hasMarketDom: false }),
      true
    );
  });

  it("não marca jogo válido como falha", () => {
    const text = `${"x".repeat(MIN_PAGE_TEXT_FOR_EXTRACT)} Noruega v Senegal Resultado Final`;
    assert.equal(isPageLikelyFailedToLoad(text, { hasMarketDom: true }), false);
  });
});

describe("getExtractPlayerStatusMessage", () => {
  it("orienta recarregar quando a página falhou", () => {
    assert.match(getExtractPlayerStatusMessage({ failed: true }), /F5/);
  });
});

describe("summarizeExtractPreview", () => {
  it("não mostra lixo quando extract está vazio", () => {
    const text = summarizeExtractPreview({
      match: { homeTeam: "7", awayTeam: "7" },
      meta: { visibleTextLength: 1500 },
      odds: [],
      stats: [],
    });
    assert.equal(text, "Aguardando jogo carregar…");
  });
});

describe("isExtractDataReady", () => {
  it("rejeita extract vazio antes do jogo carregar", () => {
    const ready = isExtractDataReady({
      match: { scoreConfidence: "low" },
      meta: { visibleTextLength: 1505 },
      odds: [],
      stats: [],
    });
    assert.equal(ready, false);
  });

  it("aceita extract com times e odds", () => {
    const ready = isExtractDataReady({
      match: { homeTeam: "Noruega", awayTeam: "Senegal", scoreConfidence: "high" },
      meta: { visibleTextLength: 120_000 },
      odds: [{ market: "Resultado Final" }],
      stats: [],
    });
    assert.equal(ready, true);
  });
});

describe("shouldDownloadExtractZip", () => {
  it("não baixa ZIP quando dados ainda não carregaram", () => {
    const ok = shouldDownloadExtractZip(
      {
        match: { scoreConfidence: "low" },
        meta: { visibleTextLength: 1505 },
        odds: [],
        stats: [],
      },
      { autoDownloadZip: true }
    );
    assert.equal(ok, false);
  });

  it("baixa ZIP quando extract está pronto e auto-download ligado", () => {
    const ok = shouldDownloadExtractZip(
      {
        match: {
          homeTeam: "Noruega",
          awayTeam: "Senegal",
          score: "3-1",
          scoreConfidence: "high",
        },
        meta: { visibleTextLength: 118_000 },
        odds: [{ market: "Resultado Final" }],
        stats: [{ label: "xG" }],
      },
      { autoDownloadZip: true }
    );
    assert.equal(ok, true);
  });
});

describe("shouldAutoDownloadZipAfterExtract", () => {
  it("ativa download automático por padrão", () => {
    assert.equal(shouldAutoDownloadZipAfterExtract(), true);
    assert.equal(shouldAutoDownloadZipAfterExtract({}), true);
  });

  it("permite desativar download automático", () => {
    assert.equal(shouldAutoDownloadZipAfterExtract({ autoDownloadZip: false }), false);
  });
});

describe("serializePlayerState / parsePlayerState", () => {
  it("persiste autoDownloadZip ligado por padrão", () => {
    const raw = serializePlayerState({ x: 10, y: 20, intervalInput: "90", running: true });
    const parsed = parsePlayerState(raw);

    assert.equal(parsed.autoDownloadZip, true);
  });

  it("restaura autoDownloadZip quando salvo", () => {
    const raw = serializePlayerState({
      x: 0,
      y: 0,
      intervalInput: "60",
      running: false,
      autoDownloadZip: false,
    });
    const parsed = parsePlayerState(raw);

    assert.equal(parsed.autoDownloadZip, false);
  });
});

describe("createExtractPlayerScheduler", () => {
  it("dispara extração imediata ao iniciar", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("60");
    scheduler.start(1_000);

    const tick = scheduler.tick(1_000);
    assert.equal(tick.action, "extract");
  });

  it("atrasa primeira extração quando pedido", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("60");
    scheduler.start(0, { firstRunDelayMs: 5_000 });

    assert.equal(scheduler.tick(4_999).action, "wait");
    assert.equal(scheduler.tick(5_000).action, "extract");
  });

  it("agenda próxima extração após concluir uma", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("60");
    scheduler.start(0);
    scheduler.tick(0);
    scheduler.markExtractStart(0);
    scheduler.markExtractEnd(0);

    const tick = scheduler.tick(30_000);
    assert.equal(tick.action, "wait");
    assert.equal(tick.countdownMs, 30_000);

    const due = scheduler.tick(60_000);
    assert.equal(due.action, "extract");
  });

  it("para o timer ao pausar", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("60");
    scheduler.start(0);
    scheduler.stop();

    assert.equal(scheduler.tick(120_000).action, "none");
  });

  it("não dispara extração enquanto uma está em andamento", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("30");
    scheduler.start(0);
    scheduler.tick(0);
    scheduler.markExtractStart(0);

    assert.equal(scheduler.tick(60_000).action, "none");
  });

  it("reagenda rápido quando extract falha", () => {
    const scheduler = createExtractPlayerScheduler();
    scheduler.setIntervalInput("60");
    scheduler.start(0);
    scheduler.tick(0);
    scheduler.markExtractStart(0);
    scheduler.markExtractEnd(0, { advanceInterval: false });

    assert.equal(scheduler.tick(EXTRACT_RETRY_DELAY_MS - 1).action, "wait");
    assert.equal(scheduler.tick(EXTRACT_RETRY_DELAY_MS).action, "extract");
  });
});
