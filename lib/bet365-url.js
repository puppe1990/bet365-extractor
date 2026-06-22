export const BET365_HOST_RE = /bet365\.(bet\.br|com|bet)/i;

/** Live in-play: #/IP/EV151352326532C1/ */
export const BET365_IP_EVENT_RE = /#\/IP\/EV\d+/i;

/** Pre-match / competition: #/AC/.../E194699812/... */
export const BET365_AC_EVENT_RE = /\/E\d{6,}\b/i;

export function extractBet365EventId(urlOrHash = "") {
  const hash = String(urlOrHash).includes("#")
    ? String(urlOrHash).split("#")[1] || ""
    : String(urlOrHash);

  const ev = hash.match(/EV\d{8,}/i);
  if (ev) return ev[0];

  const e = hash.match(/\/(E\d{6,})\b/i) || hash.match(/\b(E\d{6,})\b/i);
  if (e) return e[1];

  return null;
}

export function isBet365MatchUrl(url) {
  if (!BET365_HOST_RE.test(url || "")) return false;
  const hash = String(url).split("#")[1] || "";
  if (!hash) return false;
  if (BET365_IP_EVENT_RE.test(`#${hash}`)) return true;
  if (BET365_AC_EVENT_RE.test(hash)) return true;
  if (/EV\d{8,}/i.test(hash)) return true;
  return false;
}

export function bet365UrlHint(url) {
  if (!BET365_HOST_RE.test(url || "")) {
    return "Abra o site bet365.bet.br";
  }
  if (isBet365MatchUrl(url)) return null;
  return "Abra a página do jogo (clique no confronto até a URL ter #/IP/EV... ou .../E123...)";
}