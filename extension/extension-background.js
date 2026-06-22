export const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;
export const BET365_EVENT_RE = /#\/IP\/EV\d+|\/E\d{6,}\b|EV\d{8,}/i;

export function isBet365Tab(url) {
  return BET365_HOST_RE.test(url || "");
}

export function shouldInjectSniffer(url) {
  return isBet365Tab(url) && BET365_EVENT_RE.test(url || "");
}

export function resolveInjectTabId(message = {}, sender = {}) {
  return message.tabId ?? sender.tab?.id ?? null;
}

export function resolveExtractTabId(message = {}, sender = {}) {
  return message.tabId ?? sender.tab?.id ?? null;
}

export function isSnifferInjectOk(response) {
  return Boolean(response?.ok);
}

export function sanitizeDownloadRequest(filename, fallback = "bet365-extract.zip") {
  const raw = String(filename || "").trim() || fallback;
  const safe = raw
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.endsWith(".zip") ? safe : `${safe || "bet365-extract"}.zip`;
}

export function buildZipDataUrl(base64) {
  const payload = String(base64 || "").trim();
  if (!payload) {
    throw new Error("Sem dados para download");
  }
  return `data:application/zip;base64,${payload}`;
}

export function buildDownloadOptions(url, filename) {
  if (!url) {
    throw new Error("Sem URL para download");
  }
  return {
    url,
    filename: sanitizeDownloadRequest(filename),
    saveAs: false,
    conflictAction: "uniquify",
  };
}

export function armDownloadFilename(state, filename) {
  state.value = sanitizeDownloadRequest(filename);
}

export function resolveDeterminedFilename(item, state, extensionId) {
  if (extensionId && item?.byExtensionId && item.byExtensionId !== extensionId) {
    return null;
  }
  if (!state?.value) return null;
  const custom = state.value;
  state.value = null;
  return custom;
}