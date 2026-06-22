export function buildBet365Slug(data) {
  const m = data?.match || {};
  const slug = [m.homeTeam, m.awayTeam]
    .filter(Boolean)
    .join("-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w-]+/g, "")
    .toLowerCase();
  return slug || "bet365";
}

export function buildBet365Filename(data, ext, isoDate = new Date().toISOString()) {
  const ts = isoDate.replace(/[:.]/g, "-");
  return `bet365-${buildBet365Slug(data)}-${ts}.${ext}`;
}

export function formatBet365Logs(data) {
  const m = data?.match || {};
  const meta = data?.meta || {};
  const debug = meta.debug || {};
  const stats = data?.stats || [];
  const odds = data?.odds || [];
  const inference = m.scoreInference;

  const lines = [
    `=== BET365 EXTRACT v${meta.version || "?"} ===`,
    `Jogo: ${m.homeTeam ?? "?"} vs ${m.awayTeam ?? "?"}`,
    `Competição: ${m.competition ?? "—"}`,
    `Placar: ${m.score ?? "—"} | ${m.clock ?? "—"} | ${m.status ?? "—"}`,
    `Confiança: ${m.scoreConfidence ?? meta.scoreConfidence ?? "—"}`,
    `Origem placar: ${m.scoreInferredFrom ?? (m.scoreDom ? "dom+markets" : "dom/text")}`,
  ];

  if (m.scoreDom && m.scoreDom !== m.score) {
    lines.push(`Placar DOM original: ${m.scoreDom}`);
  }

  const warnings = m.scoreWarnings || meta.scoreWarnings || [];
  if (warnings.length) {
    lines.push(`Avisos: ${warnings.join(" | ")}`);
  }

  if (debug.selectedMatch) {
    lines.push(
      `Candidato escolhido: ${debug.selectedMatch.score} (${debug.selectedMatch.source}, rank=${debug.selectedMatch.rank})`
    );
  }

  const breakdown = debug.sourceBreakdown;
  if (breakdown) {
    const fmt = (obj) =>
      Object.entries(obj || {})
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
    lines.push(`Fontes stats: ${fmt(breakdown.stats) || "—"}`);
    lines.push(`Fontes odds: ${fmt(breakdown.odds) || "—"}`);
  }

  if (inference?.reasons?.length) {
    lines.push("", "--- INFERÊNCIA MERCADOS ---", ...inference.reasons);
  }

  lines.push(
    "",
    "--- STATS ---",
    ...stats.map((s) => `${s.label}: ${s.home} | ${s.away} (${s.source || "?"})`),
    "",
    "--- ODDS ---",
    ...odds.map((o) => `${o.market} | ${o.selection}: ${o.odds} (${o.source || "?"})`)
  );

  return lines.join("\n");
}

export function formatBet365DebugLogs(data) {
  const m = data?.match || {};
  const meta = data?.meta || {};
  const debug = meta.debug || {};
  const analysis = debug.marketAnalysis || m.scoreInference || null;

  const lines = [
    `=== BET365 DEBUG v${meta.version || "?"} ===`,
    `extractedAt: ${m.extractedAt ?? "—"}`,
    `url: ${m.url ?? "—"}`,
    `eventId: ${m.eventId ?? "—"}`,
    "",
    "--- AMBIENTE ---",
    `version: ${meta.version ?? "—"}`,
    `rootsScanned: ${meta.rootsScanned ?? debug.rootsScanned ?? "—"}`,
    `frameTextsScanned: ${meta.frameTextsScanned ?? debug.frameTextsScanned ?? "—"}`,
    `networkCaptures: ${meta.networkCaptures ?? debug.networkCaptures ?? "—"}`,
    `networkBridge: ${meta.networkBridge ?? "—"}`,
    `visibleTextLength: ${meta.visibleTextLength ?? debug.visibleTextLength ?? "—"}`,
    `statsCount: ${meta.statsCount ?? data.stats?.length ?? 0}`,
    `oddsCount: ${meta.oddsCount ?? data.odds?.length ?? 0}`,
    "",
    "--- PLACAR ---",
    `score: ${m.score ?? "—"}`,
    `scoreDom: ${m.scoreDom ?? "—"}`,
    `scoreInferredFrom: ${m.scoreInferredFrom ?? "—"}`,
    `clock: ${m.clock ?? "—"}`,
    `status: ${m.status ?? "—"}`,
    `scoreConfidence: ${m.scoreConfidence ?? "—"}`,
  ];

  if (m.scoreWarnings?.length) {
    lines.push("warnings:", ...m.scoreWarnings.map((w) => `  - ${w}`));
  }

  if (debug.selectedMatch) {
    lines.push(
      "",
      "--- CANDIDATO ESCOLHIDO ---",
      `score: ${debug.selectedMatch.score ?? "—"}`,
      `clock: ${debug.selectedMatch.clock ?? "—"}`,
      `source: ${debug.selectedMatch.source ?? "—"}`,
      `rank: ${debug.selectedMatch.rank ?? "—"}`,
      `wallClock: ${debug.selectedMatch.wallClock ?? "—"}`
    );
  }

  if (debug.clockDebug) {
    const cd = debug.clockDebug;
    lines.push(
      "",
      "--- RELÓGIOS ---",
      `found: ${cd.found ?? 0}`,
      `afterWallFilter: ${cd.afterWallFilter ?? 0}`,
      `bestClock: ${cd.bestClock ?? "—"}`,
      `extractedAtLocal: ${cd.extractedAtLocal ?? "—"}`
    );
    if (cd.clocks?.length) {
      cd.clocks.forEach((c, i) => {
        lines.push(
          `${i + 1}. ${c.clock} | ${c.source} | score=${c.score ?? "?"} | wall=${c.wallClock}`
        );
      });
    }
  }

  if (debug.sourceBreakdown) {
    const fmt = (obj) =>
      Object.entries(obj || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    lines.push(
      "",
      "--- FONTES ---",
      `stats: ${fmt(debug.sourceBreakdown.stats) || "—"}`,
      `odds: ${fmt(debug.sourceBreakdown.odds) || "—"}`
    );
  }

  if (analysis) {
    lines.push(
      "",
      "--- ANÁLISE MERCADOS ---",
      `nextGoalMarkets: ${JSON.stringify(analysis.nextGoalMarkets ?? [])}`,
      `minTotalGoals: ${analysis.minTotalGoals ?? "—"}`,
      `domTotalGoals: ${analysis.domTotalGoals ?? "—"}`,
      `drawFavored: ${analysis.drawFavored ?? "—"}`,
      `consistent: ${analysis.consistent ?? "—"}`
    );
    if (analysis.reasons?.length) {
      lines.push("reasons:", ...analysis.reasons.map((r) => `  - ${r}`));
    }
  }

  if (debug.matchCandidates?.length) {
    lines.push("", "--- CANDIDATOS PLACAR (rank) ---");
    debug.matchCandidates.forEach((c, i) => {
      lines.push(
        `${i + 1}. rank=${c.rank ?? "?"} | ${c.score ?? "?"} | ${c.clock ?? "—"} | ${c.source ?? "?"} | wall=${c.wallClock ?? "?"}`
      );
    });
  }

  if (debug.domProbe?.length) {
    lines.push("", "--- DOM PROBE ---");
    debug.domProbe.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.sel} | hits=${d.hits} | source=${d.source}`);
      (d.samples || []).forEach((s) => lines.push(`    > ${s.replace(/\n/g, "\\n")}`));
    });
  }

  if (debug.networkBreakdown && Object.keys(debug.networkBreakdown).length) {
    lines.push(
      "",
      "--- NETWORK BREAKDOWN ---",
      Object.entries(debug.networkBreakdown)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    );
  }

  if (debug.networkSamples?.length) {
    lines.push("", "--- NETWORK SAMPLES ---");
    debug.networkSamples.forEach((n, i) => {
      lines.push(`${i + 1}. [${n.kind || "?"}] ${n.url}`);
      if (n.rawLen != null) lines.push(`    rawLen: ${n.rawLen}`);
      if (n.fieldKeys?.length) lines.push(`    fields: ${n.fieldKeys.join(", ")}`);
      if (n.wireMatch) lines.push(`    wireMatch: ${n.wireMatch.score} @ ${n.wireMatch.clock ?? "—"}`);
      if (n.wireMatches?.length) lines.push(`    wireScores: ${JSON.stringify(n.wireMatches)}`);
      if (n.wireClocks?.length) lines.push(`    wireClocks: ${n.wireClocks.join(", ")}`);
      if (n.keys?.length) lines.push(`    keys: ${n.keys.join(", ")}`);
      if (n.preview) lines.push(`    preview: ${n.preview}`);
    });
  } else {
    lines.push("", "--- NETWORK SAMPLES ---", "(nenhuma captura relevante)");
  }

  if (debug.frameSamples?.length) {
    lines.push("", "--- FRAMES ---");
    debug.frameSamples.forEach((f, i) => {
      lines.push(
        `${i + 1}. [${f.source}] len=${f.len} depth=${f.depth ?? "—"} href=${f.href ?? "—"}`
      );
      if (f.preview) lines.push(`    preview: ${f.preview.replace(/\n/g, "\\n")}`);
    });
  } else {
    lines.push("", "--- FRAMES ---", "(nenhum frame com placar capturado)");
  }

  if (debug.marketInference) {
    lines.push(
      "",
      "--- INFERÊNCIA APLICADA ---",
      `applied: ${debug.marketInference.applied}`,
      `previousScore: ${debug.marketInference.previousScore ?? "—"}`
    );
  }

  if (debug.pipeline?.length) {
    lines.push("", "--- PIPELINE (resumo) ---");
    debug.pipeline.forEach((p) => {
      lines.push(
        `${p.step}: ${p.detail ?? ""}${p.ms != null ? ` (${p.ms}ms)` : ""}${p.count != null ? ` count=${p.count}` : ""}`
      );
    });
  }

  lines.push(
    "",
    "--- VISIBLE TEXT SAMPLE ---",
    debug.visibleTextSample || meta.visibleTextSample || "(vazio)",
    "",
    "--- TIPS ---",
    ...(meta.tips?.length ? meta.tips.map((t) => `- ${t}`) : ["(nenhuma)"])
  );

  return lines.join("\n");
}

export function formatBet365TraceLogs(data) {
  const m = data?.match || {};
  const meta = data?.meta || {};
  const debug = meta.debug || {};

  const lines = [
    `=== BET365 TRACE v${meta.version || "?"} ===`,
    `extractedAt: ${m.extractedAt ?? debug.extractedAt ?? "—"}`,
    `url: ${m.url ?? "—"}`,
    "",
    "--- PIPELINE ---",
  ];

  if (debug.pipeline?.length) {
    debug.pipeline.forEach((p, i) => {
      const parts = [`${i + 1}. ${p.step}`];
      if (p.ms != null) parts.push(`${p.ms}ms`);
      if (p.count != null) parts.push(`count=${p.count}`);
      if (p.ok != null) parts.push(`ok=${p.ok}`);
      if (p.detail) parts.push(p.detail);
      lines.push(parts.join(" | "));
    });
  } else {
    lines.push("(pipeline não registrado)");
  }

  lines.push("", "--- MERGE DECISION ---");
  if (debug.selectedMatch) {
    lines.push(
      `winner: ${debug.selectedMatch.score} from ${debug.selectedMatch.source} (rank=${debug.selectedMatch.rank})`
    );
    lines.push(`clock kept: ${debug.selectedMatch.clock ?? "null"}`);
    lines.push(`wallClock rejected: ${debug.selectedMatch.wallClock ?? "—"}`);
  } else {
    lines.push("(nenhum candidato selecionado)");
  }

  if (debug.matchCandidates?.length) {
    lines.push("", "--- ALL RANKED CANDIDATES ---");
    debug.matchCandidates.forEach((c, i) => {
      lines.push(
        `${i + 1}. rank=${c.rank} score=${c.score} clock=${c.clock ?? "—"} src=${c.source} wall=${c.wallClock}`
      );
    });
  }

  if (debug.clockDebug) {
    lines.push("", "--- CLOCK FILTER ---");
    lines.push(`local time at extract: ${debug.clockDebug.extractedAtLocal ?? "—"}`);
    lines.push(`candidates before filter: ${debug.clockDebug.found}`);
    lines.push(`after wall-clock filter: ${debug.clockDebug.afterWallFilter}`);
    lines.push(`best clock picked: ${debug.clockDebug.bestClock ?? "—"}`);
  }

  if (debug.domProbe?.length) {
    lines.push("", "--- DOM SELECTORS ---");
    debug.domProbe.forEach((d) => {
      lines.push(`${d.sel}: ${d.hits} hit(s) [${d.source}]`);
    });
  }

  if (debug.networkSamples?.length) {
    lines.push("", "--- NETWORK ---");
    debug.networkSamples.forEach((n, i) => {
      lines.push(`${i + 1}. [${n.kind || "?"}] ${n.at ?? "?"} | ${n.url}`);
    });
  }

  if (debug.marketInference?.applied) {
    lines.push(
      "",
      "--- MARKET OVERRIDE ---",
      `previous: ${debug.marketInference.previousScore}`,
      `final: ${m.score}`,
      ...(debug.marketInference.analysis?.reasons || []).map((r) => `  - ${r}`)
    );
  }

  lines.push(
    "",
    "--- ENV ---",
    `roots=${debug.rootsScanned ?? meta.rootsScanned ?? "?"}`,
    `frames=${debug.frameTextsScanned ?? meta.frameTextsScanned ?? "?"}`,
    `network=${debug.networkCaptures ?? meta.networkCaptures ?? "?"}`,
    `visibleText=${debug.visibleTextLength ?? meta.visibleTextLength ?? "?"}`
  );

  return lines.join("\n");
}