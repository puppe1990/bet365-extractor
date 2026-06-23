export const MIN_EXTRACT_PLAYER_INTERVAL_MS = 30_000;
export const EXTRACT_PLAYER_STORAGE_KEY = "bet365-extract-player-state";
export const EXTRACT_PLAYER_BALL_SIZE_PX = 72;

export function parseIntervalInput(raw, minMs = MIN_EXTRACT_PLAYER_INTERVAL_MS) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return null;

  let ms = null;
  const mmss = s.match(/^(\d{1,3}):(\d{2})$/);
  if (mmss) {
    ms = (parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10)) * 1000;
  } else if (/^\d+\s*m$/.test(s)) {
    ms = parseInt(s, 10) * 60_000;
  } else if (/^\d+\s*s$/.test(s)) {
    ms = parseInt(s, 10) * 1000;
  } else if (/^\d+$/.test(s)) {
    ms = parseInt(s, 10) * 1000;
  }

  if (!Number.isFinite(ms)) return null;
  return Math.max(ms, minMs);
}

export function formatPlayerCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function clampBallPosition(pos, viewport, ballSize = EXTRACT_PLAYER_BALL_SIZE_PX) {
  const width = Math.max(ballSize, Number(viewport?.width || 0));
  const height = Math.max(ballSize, Number(viewport?.height || 0));
  return {
    x: Math.min(Math.max(0, Number(pos?.x || 0)), width - ballSize),
    y: Math.min(Math.max(0, Number(pos?.y || 0)), height - ballSize),
  };
}

export function defaultBallPosition(viewport, ballSize = EXTRACT_PLAYER_BALL_SIZE_PX) {
  const width = Number(viewport?.width || 1200);
  const height = Number(viewport?.height || 900);
  return clampBallPosition(
    {
      x: (width - ballSize) / 2,
      y: Math.min(height - ballSize - 24, Math.round(height * 0.78)),
    },
    { width, height },
    ballSize
  );
}

export function summarizeExtractPreview(data = {}) {
  const m = data.match || {};
  const home = m.homeTeam || "?";
  const away = m.awayTeam || "?";
  const score = m.score || "—";
  const clock = m.clock || "—";
  const stats = (data.stats || []).length;
  const odds = (data.odds || []).length;
  const events = (data.sidePanel?.timeline || []).length;
  return `${home} vs ${away} · ${score} @ ${clock} · ${stats} stats · ${odds} odds · ${events} evt`;
}

export function createExtractPlayerScheduler(options = {}) {
  const minIntervalMs = options.minIntervalMs ?? MIN_EXTRACT_PLAYER_INTERVAL_MS;
  let intervalMs = minIntervalMs;
  let running = false;
  let extracting = false;
  let nextRunAt = null;
  let lastRunAt = null;

  const countdownMs = (now) => {
    if (!running || extracting || nextRunAt == null) return null;
    return Math.max(0, nextRunAt - now);
  };

  return {
    getState() {
      return { intervalMs, running, extracting, nextRunAt, lastRunAt };
    },
    setIntervalInput(input) {
      const parsed = parseIntervalInput(input, minIntervalMs);
      if (parsed) intervalMs = parsed;
      return intervalMs;
    },
    getIntervalMs() {
      return intervalMs;
    },
    start(now) {
      running = true;
      extracting = false;
      nextRunAt = now;
      return this.getState();
    },
    stop() {
      running = false;
      extracting = false;
      nextRunAt = null;
      return this.getState();
    },
    markExtractStart(now) {
      extracting = true;
      lastRunAt = now;
      return this.getState();
    },
    markExtractEnd(now) {
      extracting = false;
      if (running) nextRunAt = now + intervalMs;
      return this.getState();
    },
    tick(now) {
      if (!running) return { action: "none", countdownMs: null };
      if (extracting) return { action: "none", countdownMs: countdownMs(now) };
      if (nextRunAt != null && now >= nextRunAt) {
        return { action: "extract", countdownMs: 0 };
      }
      return { action: "wait", countdownMs: countdownMs(now) };
    },
  };
}

export function serializePlayerState(state = {}) {
  return JSON.stringify({
    x: state.x,
    y: state.y,
    intervalInput: state.intervalInput ?? "60",
    running: Boolean(state.running),
  });
}

export function parsePlayerState(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      x: Number.isFinite(parsed.x) ? parsed.x : null,
      y: Number.isFinite(parsed.y) ? parsed.y : null,
      intervalInput: String(parsed.intervalInput || "60"),
      running: Boolean(parsed.running),
    };
  } catch (_) {
    return null;
  }
}
