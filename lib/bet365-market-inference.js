export function parseNextGoalMarkets(odds) {
  const markets = [];

  for (const o of odds || []) {
    const m = String(o.market || "").match(/(\d+)\s*°\s*Gol/i);
    if (m) markets.push(parseInt(m[1], 10));
  }

  return [...new Set(markets)].sort((a, b) => b - a);
}

export function minTotalGoalsFromOdds(odds) {
  const next = parseNextGoalMarkets(odds)[0];
  if (!next || next < 2) return null;
  return next - 1;
}

export function scoreTotalFromMatch(match) {
  if (match?.scoreHome != null && match?.scoreAway != null) {
    return match.scoreHome + match.scoreAway;
  }
  if (!match?.score) return null;

  const parts = match.score.split("-").map((n) => parseInt(n, 10));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] + parts[1];
}

export function isDrawFavored(odds) {
  const rf = (odds || []).filter((o) => /resultado\s*final/i.test(o.market));
  const empate = rf.find((o) => /^empate$/i.test(String(o.selection || "").trim()));
  const home = rf.find(
    (o) => o !== empate && !/empate/i.test(String(o.selection || ""))
  );

  if (!empate) return false;

  const homeOdd = home?.odds ?? 999;
  return empate.odds <= homeOdd * 0.85;
}

export function suggestScoreForMinGoals(minGoals, drawFavored, currentHome, currentAway) {
  if (!minGoals || minGoals < 1) return null;

  if (drawFavored && minGoals % 2 === 0) {
    const each = minGoals / 2;
    return { score: `${each}-${each}`, scoreHome: each, scoreAway: each };
  }

  if (
    Number.isFinite(currentHome) &&
    Number.isFinite(currentAway) &&
    currentHome + currentAway < minGoals
  ) {
    const diff = minGoals - (currentHome + currentAway);
    if (drawFavored && currentHome >= currentAway) {
      return {
        score: `${currentHome}-${currentAway + diff}`,
        scoreHome: currentHome,
        scoreAway: currentAway + diff,
      };
    }
    return {
      score: `${currentHome + diff}-${currentAway}`,
      scoreHome: currentHome + diff,
      scoreAway: currentAway,
    };
  }

  return null;
}

export function analyzeMarketScore(odds, match) {
  const nextGoalMarkets = parseNextGoalMarkets(odds);
  const minTotalGoals = minTotalGoalsFromOdds(odds);
  const domTotalGoals = scoreTotalFromMatch(match);
  const drawFavored = isDrawFavored(odds);

  const analysis = {
    nextGoalMarkets,
    minTotalGoals,
    domTotalGoals,
    drawFavored,
    consistent:
      domTotalGoals == null || minTotalGoals == null || domTotalGoals >= minTotalGoals,
    reasons: [],
  };

  if (minTotalGoals != null && domTotalGoals != null && domTotalGoals < minTotalGoals) {
    analysis.reasons.push(
      `Mercado ${nextGoalMarkets[0]}° Gol implica ≥${minTotalGoals} gols; DOM tem ${domTotalGoals} (${match?.score ?? "?"}).`
    );
  }

  if (drawFavored) {
    analysis.reasons.push("Empate favorito no Resultado Final.");
  }

  return analysis;
}

export function applyMarketScoreInference(match, odds) {
  const analysis = analyzeMarketScore(odds, match);
  const result = { match: { ...match }, analysis, applied: false };

  if (analysis.minTotalGoals == null) return result;

  const missingScore = match?.score == null;
  const inconsistent =
    !missingScore &&
    analysis.domTotalGoals != null &&
    analysis.domTotalGoals < analysis.minTotalGoals;

  if (!missingScore && (analysis.consistent || !inconsistent)) return result;

  const home = Number.isFinite(match?.scoreHome)
    ? match.scoreHome
    : match?.score
      ? parseInt(String(match.score).split("-")[0], 10)
      : null;
  const away = Number.isFinite(match?.scoreAway)
    ? match.scoreAway
    : match?.score
      ? parseInt(String(match.score).split("-")[1], 10)
      : null;

  const suggested = suggestScoreForMinGoals(
    analysis.minTotalGoals,
    analysis.drawFavored,
    home,
    away
  );

  if (!suggested) {
    analysis.reasons.push("Não foi possível sugerir placar exato pelos mercados.");
    return result;
  }

  const canOverride =
    missingScore ||
    !match.clock ||
    match.scoreConfidence === "medium" ||
    match.scoreConfidence === "low" ||
    inconsistent;

  if (!canOverride) return result;

  result.applied = true;
  result.match = {
    ...match,
    score: suggested.score,
    scoreHome: suggested.scoreHome,
    scoreAway: suggested.scoreAway,
    scoreDom: match.score ?? null,
    scoreInferredFrom: "markets",
    scoreInference: {
      ...analysis,
      suggested,
      previousScore: match.score ?? null,
    },
  };

  if (missingScore) {
    analysis.reasons.push(
      `Placar inferido pelos mercados: ${suggested.score} (mín. ${analysis.minTotalGoals} gols).`
    );
  } else {
    analysis.reasons.push(
      `Placar ajustado: ${match.score} → ${suggested.score} (inferência por mercados).`
    );
  }

  return result;
}