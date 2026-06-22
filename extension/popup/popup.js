const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const btnExtract = document.getElementById("btnExtract");

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status${type ? ` ${type}` : ""}`;
}

const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;

function isBet365MatchUrl(url) {
  if (!BET365_HOST_RE.test(url || "")) return false;
  const hash = String(url).split("#")[1] || "";
  if (!hash) return false;
  if (/#\/IP\/EV\d+/i.test(`#${hash}`)) return true;
  if (/\/E\d{6,}\b/i.test(hash)) return true;
  if (/EV\d{8,}/i.test(hash)) return true;
  return false;
}

function urlHint(url) {
  if (!BET365_HOST_RE.test(url || "")) return "Abra o site bet365.bet.br";
  if (isBet365MatchUrl(url)) return null;
  return "Abra a página do jogo (clique no confronto até a URL ter #/IP/EV... ou .../E123...)";
}

function renderPreview(data) {
  const m = data.match || {};
  const meta = data.meta || {};
  const confidence = meta.scoreConfidence || m.scoreConfidence || "unknown";
  const warnings = meta.scoreWarnings || m.scoreWarnings || [];

  let confidenceLine = "";
  if (confidence === "low") {
    confidenceLine = `<div class="warn">⚠ Placar/relógio com baixa confiança</div>`;
  } else if (confidence === "medium") {
    confidenceLine = `<div class="warn">⚠ Confira placar e minuto antes de usar</div>`;
  }

  const warningsLine = warnings.length
    ? `<div class="warn">${warnings.slice(0, 2).join(" · ")}</div>`
    : "";

  previewEl.innerHTML = `
    <div><strong>${m.homeTeam ?? "?"}</strong> vs <strong>${m.awayTeam ?? "?"}</strong></div>
    <div>Placar: ${m.score ?? "—"} · ${m.clock ?? "—"} · ${m.status ?? "—"}</div>
    <div>Stats: ${data.stats?.length ?? 0} · Odds: ${data.odds?.length ?? 0}</div>
    ${confidenceLine}
    ${warningsLine}
  `;
  previewEl.classList.remove("hidden");
}

async function extractFromTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "EXTRACT" });
}

async function createZipBlob(data) {
  const zip = new JSZip();
  const entries = buildZipEntries(data);

  entries.forEach(({ path, content }) => {
    zip.file(path, content);
  });

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, saveAs: false },
      (id) => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      }
    );
  });
}

btnExtract.addEventListener("click", async () => {
  btnExtract.disabled = true;
  setStatus("Extraindo...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) throw new Error("Nenhuma aba ativa");
    const hint = urlHint(tab.url);
    if (hint) throw new Error(hint);

    let response;
    try {
      response = await extractFromTab(tab.id);
    } catch {
      throw new Error("Recarregue a página Bet365 e tente de novo");
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Falha na extração");
    }

    const { data } = response;
    const confidence = data.meta?.scoreConfidence || data.match?.scoreConfidence;
    const hasStats = data.stats?.length > 0;
    const hasScore = Boolean(data.match?.score);

    if (!hasStats && !hasScore) {
      setStatus("Extração vazia — abra o jogo e clique em Estat.", "err");
    } else if (!hasScore || confidence === "low") {
      setStatus("ZIP gerado — confira placar/relógio no preview", "err");
    } else if (confidence === "medium") {
      setStatus("ZIP gerado — confira placar e minuto", "ok");
    } else {
      setStatus("Gerando ZIP...", "ok");
    }

    renderPreview(data);

    const blob = await createZipBlob(data);
    const filename = buildZipFilename(data);
    await downloadBlob(blob, filename);

    if (hasStats && hasScore && confidence === "high") {
      setStatus(`ZIP baixado: ${filename}`, "ok");
    }
  } catch (err) {
    setStatus(err.message || String(err), "err");
    previewEl.classList.add("hidden");
  } finally {
    btnExtract.disabled = false;
  }
});

document.querySelector(".version").textContent = `v${chrome.runtime.getManifest().version}`;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.url) return;
  const hint = urlHint(tab.url);
  if (hint) setStatus(hint, "err");
  else setStatus("Pronto para extrair este jogo", "ok");
});