function mountExtractPlayer(options = {}) {
  if (window !== window.top) return null;
  if (!isBet365MatchUrl(location.href)) return null;
  if (document.getElementById("bet365-extract-player-root")) return null;

  const buildDataFn = options.buildData || buildData;
  const version = options.version || VERSION;
  const ballSize = EXTRACT_PLAYER_BALL_SIZE_PX;
  const scheduler = createExtractPlayerScheduler();
  let lastData = null;
  let autoDownloadZip = shouldAutoDownloadZipAfterExtract(options);
  let tabId = options.tabId ?? null;
  let drag = null;
  let tickTimer = null;
  const getPageVisibleText =
    options.getPageVisibleText ||
    (() => document.body?.innerText || document.documentElement?.innerText || "");
  const hasMarketDom =
    options.hasMarketDom ||
    (() =>
      Boolean(
        document.querySelector(
          '[class*="MarketGroup"], [class*="CouponPage"], [class*="IPMarketView"], [class*="EventViewDetail"], [class*="ipe-EventView"]'
        )
      ));
  const getPageReadyContext = () => ({
    text: getPageVisibleText(),
    hasMarketDom: hasMarketDom(),
  });
  const isPageReady =
    options.isPageReady ||
    (() => {
      const ctx = getPageReadyContext();
      return isPageReadyForExtract(ctx.text, { hasMarketDom: ctx.hasMarketDom });
    });
  const isPageFailed =
    options.isPageFailed ||
    (() => {
      const ctx = getPageReadyContext();
      return isPageLikelyFailedToLoad(ctx.text, { hasMarketDom: ctx.hasMarketDom });
    });
  const RESTORE_FIRST_RUN_DELAY_MS = 8_000;

  const root = document.createElement("div");
  root.id = "bet365-extract-player-root";
  root.innerHTML = `
<style>
#bet365-extract-player-root {
  position: fixed;
  z-index: 2147483646;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  user-select: none;
  touch-action: none;
}
#bet365-extract-player-root .bet365-player-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  filter: drop-shadow(0 8px 20px rgba(0,0,0,.35));
}
#bet365-extract-player-root .bet365-player-ball {
  width: ${ballSize}px;
  height: ${ballSize}px;
  border-radius: 50%;
  cursor: grab;
  background:
    radial-gradient(circle at 30% 30%, #fff 0 14%, transparent 15%),
    radial-gradient(circle at 68% 38%, #fff 0 10%, transparent 11%),
    radial-gradient(circle at 42% 72%, #fff 0 12%, transparent 13%),
    radial-gradient(circle at 70% 68%, #fff 0 9%, transparent 10%),
    conic-gradient(from 200deg, #0a5f38 0 72deg, #f5f5f5 72deg 144deg, #0a5f38 144deg 216deg, #f5f5f5 216deg 288deg, #0a5f38 288deg 360deg);
  border: 3px solid #063d24;
  box-shadow: inset 0 -4px 10px rgba(0,0,0,.25);
  display: grid;
  place-items: center;
  color: #063d24;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  line-height: 1.1;
  padding: 6px;
}
#bet365-extract-player-root .bet365-player-ball:active { cursor: grabbing; }
#bet365-extract-player-root .bet365-player-ball.is-running {
  box-shadow: 0 0 0 3px rgba(16, 185, 129, .55), inset 0 -4px 10px rgba(0,0,0,.25);
}
#bet365-extract-player-root .bet365-player-ball.is-waiting-page {
  box-shadow: 0 0 0 3px rgba(245, 158, 11, .65), inset 0 -4px 10px rgba(0,0,0,.25);
}
#bet365-extract-player-root .bet365-player-panel {
  width: 240px;
  background: rgba(8, 20, 14, .94);
  color: #ecfdf5;
  border: 1px solid rgba(16, 185, 129, .35);
  border-radius: 12px;
  padding: 10px;
  backdrop-filter: blur(6px);
}
#bet365-extract-player-root label {
  display: block;
  font-size: 11px;
  opacity: .85;
  margin-bottom: 4px;
}
#bet365-extract-player-root input {
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,.15);
  background: rgba(255,255,255,.08);
  color: #fff;
  padding: 6px 8px;
  font-size: 13px;
}
#bet365-extract-player-root .bet365-player-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
#bet365-extract-player-root button {
  border: 0;
  border-radius: 8px;
  padding: 6px 10px;
  font-weight: 600;
  cursor: pointer;
}
#bet365-extract-player-root .bet365-btn-play {
  background: #10b981;
  color: #042f1a;
}
#bet365-extract-player-root .bet365-btn-stop {
  background: #f59e0b;
  color: #3b2500;
}
#bet365-extract-player-root .bet365-btn-zip {
  background: rgba(255,255,255,.12);
  color: #ecfdf5;
}
#bet365-extract-player-root .bet365-player-countdown {
  flex: 1;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
#bet365-extract-player-root .bet365-player-preview {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.35;
  opacity: .92;
  word-break: break-word;
}
#bet365-extract-player-root .bet365-player-status {
  margin-top: 6px;
  font-size: 10px;
  opacity: .75;
}
</style>
<div class="bet365-player-wrap">
  <div class="bet365-player-ball" data-role="ball" title="Arraste a bola · Player v${version}">B365</div>
  <div class="bet365-player-panel">
    <label for="bet365-player-interval">Intervalo (ex: 60, 1:30, 2m)</label>
    <input id="bet365-player-interval" data-role="interval" value="60" />
    <div class="bet365-player-row">
      <button type="button" data-role="toggle" class="bet365-btn-play">▶ Iniciar</button>
      <div class="bet365-player-countdown" data-role="countdown">Próxima: —</div>
    </div>
    <div class="bet365-player-row">
      <button type="button" data-role="zip" class="bet365-btn-zip">ZIP</button>
      <div class="bet365-player-status" data-role="status">Pausado</div>
    </div>
    <div class="bet365-player-preview" data-role="preview">Aguardando 1ª extração…</div>
  </div>
</div>`;

  const ball = root.querySelector('[data-role="ball"]');
  const intervalInput = root.querySelector('[data-role="interval"]');
  const toggleBtn = root.querySelector('[data-role="toggle"]');
  const countdownEl = root.querySelector('[data-role="countdown"]');
  const previewEl = root.querySelector('[data-role="preview"]');
  const statusEl = root.querySelector('[data-role="status"]');
  const zipBtn = root.querySelector('[data-role="zip"]');

  function saveState() {
    const rect = root.getBoundingClientRect();
    try {
      localStorage.setItem(
        EXTRACT_PLAYER_STORAGE_KEY,
        serializePlayerState({
          x: rect.left,
          y: rect.top,
          intervalInput: intervalInput.value,
          running: scheduler.getState().running,
          autoDownloadZip,
        })
      );
    } catch (_) {}
  }

  function applyPosition(pos) {
    const clamped = clampBallPosition(
      pos,
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      ballSize
    );
    root.style.left = `${clamped.x}px`;
    root.style.top = `${clamped.y}px`;
  }

  function restoreState() {
    let pos = defaultBallPosition(
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      ballSize
    );
    try {
      const saved = parsePlayerState(localStorage.getItem(EXTRACT_PLAYER_STORAGE_KEY));
      if (saved?.intervalInput) intervalInput.value = saved.intervalInput;
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        pos = clampBallPosition(
          { x: saved.x, y: saved.y },
          {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          ballSize
        );
      }
      if (saved?.running) {
        scheduler.setIntervalInput(intervalInput.value);
        scheduler.start(Date.now(), { firstRunDelayMs: RESTORE_FIRST_RUN_DELAY_MS });
        syncToggleUi();
      }
      if (saved && "autoDownloadZip" in saved) {
        autoDownloadZip = shouldAutoDownloadZipAfterExtract(saved);
      }
    } catch (_) {}
    scheduler.setIntervalInput(intervalInput.value);
    applyPosition(pos);
  }

  function syncToggleUi(context = {}) {
    const { running, extracting } = scheduler.getState();
    ball.classList.toggle("is-running", running);
    ball.classList.toggle("is-waiting-page", running && (context.failed || context.awaitingPage));
    toggleBtn.textContent = running ? "⏸ Pausar" : "▶ Iniciar";
    toggleBtn.className = running ? "bet365-btn-stop" : "bet365-btn-play";
    statusEl.textContent = getExtractPlayerStatusMessage({
      extracting: context.extracting ?? extracting,
      running,
      failed: context.failed,
      awaitingPage: context.awaitingPage,
      awaitingData: context.awaitingData,
    });
  }

  function updateCountdown(now = Date.now()) {
    const tick = scheduler.tick(now);
    if (!scheduler.getState().running) {
      countdownEl.textContent = "Próxima: —";
      return tick;
    }
    if (!isPageReady()) {
      countdownEl.textContent = isPageFailed()
        ? "Próxima: recarregue F5"
        : "Próxima: aguardando página";
    } else if (tick.action === "extract") {
      countdownEl.textContent = "Próxima: agora";
    } else if (tick.countdownMs != null) {
      countdownEl.textContent = `Próxima: ${formatPlayerCountdown(tick.countdownMs)}`;
    } else {
      countdownEl.textContent = "Próxima: —";
    }
    return tick;
  }

  async function resolveTabId() {
    if (tabId) return tabId;
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" });
      tabId = res?.tabId ?? tabId;
    } catch (_) {}
    return tabId;
  }

  async function downloadZip(data) {
    if (typeof JSZip === "undefined" || typeof buildZipEntries !== "function") {
      statusEl.textContent = "ZIP indisponível";
      return;
    }
    const zip = new JSZip();
    buildZipEntries(data).forEach(({ path, content }) => zip.file(path, content));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const reader = new FileReader();
    const zipBase64 = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || "").split(",")[1]);
      reader.onerror = () => reject(reader.error || new Error("zip read failed"));
      reader.readAsDataURL(blob);
    });
    const filename =
      typeof buildZipFilename === "function"
        ? buildZipFilename(data)
        : `bet365-extract-${Date.now()}.zip`;
    await chrome.runtime.sendMessage({ type: "DOWNLOAD_ZIP", zipBase64, filename });
  }

  async function runExtract() {
    if (scheduler.getState().extracting) return;
    if (!isPageReady()) {
      const failed = isPageFailed();
      previewEl.textContent = failed
        ? "Bet365 não exibiu o jogo. Recarregue a página (F5)."
        : "Aguardando jogo carregar…";
      syncToggleUi({ failed, awaitingPage: !failed });
      return;
    }
    scheduler.markExtractStart(Date.now());
    syncToggleUi({ extracting: true });
    let extractSucceeded = false;
    try {
      const id = await resolveTabId();
      const data = await buildDataFn(id);
      if (!isExtractDataReady(data)) {
        previewEl.textContent = summarizeExtractPreview(data);
        syncToggleUi({ awaitingData: true });
        return;
      }
      extractSucceeded = true;
      lastData = data;
      previewEl.textContent = summarizeExtractPreview(data);
      if (shouldDownloadExtractZip(data, { autoDownloadZip })) {
        syncToggleUi({ extracting: true });
        statusEl.textContent = "ZIP…";
        await downloadZip(data);
        statusEl.textContent = "ZIP ok";
      }
    } catch (err) {
      statusEl.textContent = String(err?.message || err).slice(0, 80);
    } finally {
      scheduler.markExtractEnd(Date.now(), { advanceInterval: extractSucceeded });
      syncToggleUi();
      saveState();
    }
  }

  async function onTick() {
    const tick = updateCountdown();
    if (tick.action === "extract") await runExtract();
    else if (scheduler.getState().running && !isPageReady()) {
      const failed = isPageFailed();
      previewEl.textContent = failed
        ? "Bet365 não exibiu o jogo. Recarregue a página (F5)."
        : "Aguardando jogo carregar…";
      syncToggleUi({ failed, awaitingPage: !failed });
    }
  }

  ball.addEventListener("pointerdown", (ev) => {
    drag = {
      pointerId: ev.pointerId,
      offsetX: ev.clientX - root.offsetLeft,
      offsetY: ev.clientY - root.offsetTop,
    };
    ball.setPointerCapture(ev.pointerId);
  });

  ball.addEventListener("pointermove", (ev) => {
    if (!drag || drag.pointerId !== ev.pointerId) return;
    applyPosition({
      x: ev.clientX - drag.offsetX,
      y: ev.clientY - drag.offsetY,
    });
  });

  const endDrag = (ev) => {
    if (!drag || drag.pointerId !== ev.pointerId) return;
    drag = null;
    saveState();
  };
  ball.addEventListener("pointerup", endDrag);
  ball.addEventListener("pointercancel", endDrag);

  toggleBtn.addEventListener("click", () => {
    scheduler.setIntervalInput(intervalInput.value);
    if (scheduler.getState().running) {
      scheduler.stop();
    } else {
      scheduler.start(Date.now());
    }
    syncToggleUi();
    saveState();
    onTick();
  });

  intervalInput.addEventListener("change", () => {
    scheduler.setIntervalInput(intervalInput.value);
    saveState();
  });

  zipBtn.addEventListener("click", async () => {
    if (!lastData) {
      statusEl.textContent = "Sem dados";
      return;
    }
    try {
      statusEl.textContent = "ZIP…";
      await downloadZip(lastData);
      statusEl.textContent = "ZIP ok";
    } catch (err) {
      statusEl.textContent = String(err?.message || err).slice(0, 80);
    }
  });

  window.addEventListener("resize", () => {
    const rect = root.getBoundingClientRect();
    applyPosition({ x: rect.left, y: rect.top });
  });

  document.documentElement.appendChild(root);
  restoreState();
  syncToggleUi();
  tickTimer = window.setInterval(onTick, 1000);
  onTick();

  return {
    root,
    scheduler,
    destroy() {
      if (tickTimer) window.clearInterval(tickTimer);
      root.remove();
    },
  };
}
