const BET365_MATCH_RE = /bet365\.(bet\.br|com|bet)/i;
const BET365_EVENT_RE = /#\/IP\/EV\d+/i;

function shouldInject(url) {
  return BET365_MATCH_RE.test(url || "") && BET365_EVENT_RE.test(url || "");
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

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !shouldInject(tab.url)) return;
  injectPageSniffer(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "INJECT_SNIFFER") return;
  const tabId = message.tabId ?? sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "no-tab" });
    return;
  }
  injectPageSniffer(tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});