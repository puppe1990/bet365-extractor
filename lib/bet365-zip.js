import {
  formatBet365Logs,
  formatBet365DebugLogs,
  formatBet365TraceLogs,
  buildBet365Filename,
} from "./bet365-format.js";

export function buildZipMeta(data) {
  const m = data?.match || {};
  const meta = data?.meta || {};

  return {
    version: meta.version || "3.8.0",
    url: m.url || null,
    eventId: m.eventId || null,
    extractedAt: m.extractedAt || new Date().toISOString(),
    homeTeam: m.homeTeam || null,
    awayTeam: m.awayTeam || null,
    competition: m.competition || null,
    score: m.score || null,
    scoreDom: m.scoreDom || null,
    scoreInferredFrom: m.scoreInferredFrom || null,
    clock: m.clock || null,
    status: m.status || null,
    scoreConfidence: meta.scoreConfidence || m.scoreConfidence || null,
    scoreWarnings: meta.scoreWarnings || m.scoreWarnings || [],
    statsCount: (data?.stats || []).length,
    oddsCount: (data?.odds || []).length,
    sidePanelTimelineCount:
      meta.sidePanelTimelineCount ?? data?.sidePanel?.timeline?.length ?? 0,
    sidePanelLineupCaptured:
      meta.sidePanelLineupCaptured ?? Boolean(data?.sidePanel?.lineup),
    sidePanelFinalizationsCount:
      meta.sidePanelFinalizationsCount ?? data?.sidePanel?.playerFinalizations?.length ?? 0,
    sidePanelActionAreas: meta.sidePanelActionAreas ?? data?.sidePanel?.actionAreas ?? null,
    leftColumnScrollSteps: meta.leftColumnScrollSteps ?? null,
    visibleTextLength: meta.visibleTextLength ?? null,
    frameTextsScanned: meta.frameTextsScanned ?? null,
    rootsScanned: meta.rootsScanned ?? null,
    networkCaptures: meta.networkCaptures ?? null,
    hasDebugLog: Boolean(meta.debug),
    hasTraceLog: Boolean(meta.debug?.pipeline?.length || meta.debug),
  };
}

export function buildZipEntries(data) {
  return [
    {
      path: "data.json",
      content: JSON.stringify(data, null, 2),
    },
    {
      path: "logs.txt",
      content: formatBet365Logs(data),
    },
    {
      path: "debug.txt",
      content: formatBet365DebugLogs(data),
    },
    {
      path: "trace.txt",
      content: formatBet365TraceLogs(data),
    },
    {
      path: "meta.json",
      content: JSON.stringify(buildZipMeta(data), null, 2),
    },
  ];
}

export function sanitizeDownloadFilename(name, fallback = "bet365-extract.zip") {
  const raw = String(name || "").trim() || fallback;
  const safe = raw
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

export function buildZipFilename(data, isoDate = new Date().toISOString()) {
  return sanitizeDownloadFilename(buildBet365Filename(data, "zip", isoDate));
}