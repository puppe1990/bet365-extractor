const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;
const BET365_EVENT_RE = /#\/IP\/EV\d+|\/E\d{6,}\b|EV\d{8,}/i;

function isBet365Tab(url) {
  return BET365_HOST_RE.test(url || "");
}

function shouldInjectSniffer(url) {
  return isBet365Tab(url) && BET365_EVENT_RE.test(url || "");
}

function injectPageSniffer(tabId) {
  return chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      files: ["dist/network-page-sniffer.js"],
    })
    .catch(() => {});
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
  return chrome.tabs.sendMessage(tabId, { type: "EXTRACT" });
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

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !shouldInjectSniffer(tab.url)) return;
  injectPageSniffer(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (message?.type !== "INJECT_SNIFFER") return false;

  const tabId = message.tabId ?? sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "no-tab" });
    return false;
  }
  injectPageSniffer(tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});