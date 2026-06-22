import {
  armDownloadFilename,
  buildDownloadOptions,
  buildZipDataUrl,
  resolveDeterminedFilename,
  resolveInjectTabId,
  shouldInjectSniffer,
} from "./extension-background.js";
import { mainWorldMarketScrollFunc } from "./main-world-scroll.js";

const pendingDownloadFilename = { value: null };

function injectPageSniffer(tabId) {
  if (!tabId) {
    return Promise.reject(new Error("no-tab"));
  }

  return chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      files: ["dist/network-page-sniffer.js"],
    })
    .then(() =>
      chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        func: () => Boolean(window.__bet365PageSnifferInstalled),
      })
    )
    .then((results) => {
      if (!results?.[0]?.result) {
        throw new Error("sniffer-not-installed");
      }
    });
}

function injectContentScript(tabId) {
  return chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      files: ["dist/content.js"],
    })
    .catch((err) => {
      throw new Error(err?.message || "Falha ao injetar content script");
    });
}

async function pingExtract(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "EXTRACT", tabId });
}

function scrollMarketsInMainWorld(tabId, maxSteps = 14) {
  if (!tabId) {
    return Promise.reject(new Error("no-tab"));
  }

  return chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: mainWorldMarketScrollFunc,
      args: [maxSteps],
    })
    .then((results) => results?.[0]?.result ?? {
      snapshots: [],
      scrollSteps: 0,
      container: null,
      playerMarkets: 0,
      world: "MAIN",
    });
}

async function extractFromTab(tabId) {
  try {
    return await pingExtract(tabId);
  } catch (_) {
    await injectContentScript(tabId);
    await new Promise((r) => setTimeout(r, 200));
    return await pingExtract(tabId);
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const customName = resolveDeterminedFilename(
    item,
    pendingDownloadFilename,
    chrome.runtime.id
  );
  if (customName) {
    suggest({ filename: customName, conflictAction: "uniquify" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !shouldInjectSniffer(tab.url)) return;
  injectPageSniffer(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DOWNLOAD_ZIP") {
    try {
      const url = buildZipDataUrl(message.zipBase64);
      const options = buildDownloadOptions(url, message.filename);
      armDownloadFilename(pendingDownloadFilename, options.filename);

      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError) {
          pendingDownloadFilename.value = null;
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, id, filename: options.filename });
      });
    } catch (err) {
      pendingDownloadFilename.value = null;
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (message?.type === "EXTRACT_TAB") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "Aba não encontrada" });
      return false;
    }
    extractFromTab(tabId)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          ok: false,
          error:
            err?.message ||
            "Recarregue a página Bet365 (F5) e tente de novo",
        })
      );
    return true;
  }

  if (message?.type === "SCROLL_MARKETS") {
    const tabId = resolveInjectTabId(message, sender);
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    scrollMarketsInMainWorld(tabId, message.maxSteps ?? 14)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (message?.type !== "INJECT_SNIFFER") return false;

  const tabId = resolveInjectTabId(message, sender);
  if (!tabId) {
    sendResponse({ ok: false, error: "no-tab" });
    return false;
  }
  injectPageSniffer(tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});