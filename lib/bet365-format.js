export function slugifyFilenamePart(text) {
  if (!text) return null;
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

export function buildBet365Slug(data) {
  const m = data?.match || {};
  const parts = [m.homeTeam, m.awayTeam]
    .filter(Boolean)
    .map((team) => slugifyFilenamePart(team))
    .filter(Boolean);
  return parts.join("-") || "jogo";
}

export function buildBet365Filename(data, ext, isoDate = new Date().toISOString()) {
  const m = data?.match || {};
  const competition = slugifyFilenamePart(m.competition) || "campeonato";
  const game = buildBet365Slug(data);
  const score = slugifyFilenamePart(m.score) || "sem-placar";
  const ts = (m.extractedAt || isoDate)
    .replace(/\.\d{3}Z?$/i, "")
    .replace(/Z$/i, "")
    .replace("T", "_")
    .replace(/:/g, "-");
  return `${competition}-${game}-${score}-${ts}.${ext}`;
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

  const sidePanel = data?.sidePanel || {};
  const timeline = sidePanel.timeline || [];
  const lineup = sidePanel.lineup;
  const finals = sidePanel.playerFinalizations || [];
  const areas = sidePanel.actionAreas;

  lines.push(
    "",
    "--- PAINEL LATERAL ---",
    `Cronologia: ${timeline.length} evento(s)`,
    `Escalação: ${
      lineup
        ? `casa ${lineup.home?.starters?.length ?? 0} tit. / fora ${lineup.away?.starters?.length ?? 0} tit.`
        : "não capturada"
    }`,
    `Finalizações: ${finals.length} jogador(es)`,
    areas
      ? `Áreas de Ação: E ${areas.left} | C ${areas.center} | D ${areas.right}`
      : "Áreas de Ação: —"
  );

  if (timeline.length) {
    lines.push(
      "",
      "--- CRONOLOGIA ---",
      ...timeline.map(
        (e) =>
          `${e.minute ?? "?"}' [${e.type}] ${e.description} (${e.source || "?"})`
      )
    );
  }

  if (finals.length) {
    lines.push(
      "",
      "--- FINALIZAÇÕES ---",
      ...finals.map((r) => `${r.player}: ${r.shots} chutes, ${r.onTarget} no gol`)
    );
  }

  if (lineup) {
    lines.push(
      "",
      "--- ESCALAÇÃO (casa) ---",
      ...(lineup.home?.starters || []).map((p) => `  ${p}`),
      "Suplentes:",
      ...(lineup.home?.subs || []).map((p) => `  ${p}`),
      "",
      "--- ESCALAÇÃO (fora) ---",
      ...(lineup.away?.starters || []).map((p) => `  ${p}`),
      "Suplentes:",
      ...(lineup.away?.subs || []).map((p) => `  ${p}`)
    );
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
    `sidePanelTimeline: ${meta.sidePanelTimelineCount ?? data.sidePanel?.timeline?.length ?? 0}`,
    `sidePanelLineup: ${meta.sidePanelLineupCaptured ?? Boolean(data.sidePanel?.lineup) ? "yes" : "no"}`,
    `sidePanelFinalizations: ${meta.sidePanelFinalizationsCount ?? data.sidePanel?.playerFinalizations?.length ?? 0}`,
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
      if (n.isIpeBlob) lines.push(`    ipeBlob: yes`);
      if (n.fieldKeys?.length) lines.push(`    fields: ${n.fieldKeys.join(", ")}`);
      if (n.lineupPlayersCount != null) {
        lines.push(`    hintLineupPlayers: ${n.lineupPlayersCount}`);
        if (n.lineupPlayers?.length) lines.push(`    hintPlayers: ${n.lineupPlayers.join(", ")}`);
      }
      if (n.naSamples?.length) lines.push(`    naSamples: ${n.naSamples.join(", ")}`);
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

  const sidePanel = data?.sidePanel || {};
  if (sidePanel.tabCapture && Object.keys(sidePanel.tabCapture).length) {
    lines.push("", "--- SIDE PANEL TABS ---");
    Object.entries(sidePanel.tabCapture).forEach(([k, v]) => {
      lines.push(`${k}: len=${v.length} captured=${v.captured}`);
    });
  }
  if (sidePanel.timeline?.length) {
    lines.push("", "--- SIDE PANEL TIMELINE ---");
    sidePanel.timeline.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.minute ?? "?"}' [${e.type}] ${e.description} (${e.source})`);
    });
  }
  if (sidePanel.network?.playerNames?.length) {
    lines.push("", "--- SIDE PANEL NETWORK HINTS ---", sidePanel.network.playerNames.join(", "));
  }

  if (debug.sidePanelBlobDebug?.length) {
    lines.push("", "--- LINEUP WIRE DEBUG ---");
    debug.sidePanelBlobDebug.forEach((b, i) => {
      const isZap = b.source === "zap-ws";
      const label = isZap ? "zap-ws" : "ipe/5378";
      if (isZap) {
        lines.push(
          `${i + 1}. [${label}] messages=${b.messageCount ?? 0} mergedLen=${b.mergedLen ?? "—"} largest=${b.largestMessage ?? "—"} hintLineup=${b.hintLineupCount ?? 0} wirePlayers=${b.wirePlayerCount ?? 0} lineupParsed=${b.lineupParsed ? "yes" : "no"}`
        );
      } else {
        lines.push(
          `${i + 1}. [${label}] [${b.kind || "?"}] rawLen=${b.rawLen ?? "—"} storedLen=${b.storedLen ?? "—"} hintLineup=${b.hintLineupCount ?? 0} wirePlayers=${b.wirePlayerCount ?? 0} naPlayerLike=${b.naPlayerLikeCount ?? 0} lineupParsed=${b.lineupParsed ? "yes" : "no"}`
        );
      }
      if (b.url) lines.push(`    url: ${b.url}`);
      if (b.fieldKeys?.length) lines.push(`    fields: ${b.fieldKeys.join(", ")}`);
      if (b.hintLineupPlayers?.length) {
        lines.push(
          `    hintLineupPlayers: ${b.hintLineupPlayers.map((p) => p.name).join(", ")}`
        );
      }
      if (b.wirePlayers?.length) {
        lines.push(
          `    wirePlayers: ${b.wirePlayers.map((p) => `${p.name}${p.team != null ? `(T${p.team})` : ""}`).join(", ")}`
        );
      }
      if (b.naSamples?.length) {
        const sample = b.naSamples
          .filter((s) => s.playerLike)
          .map((s) => s.name)
          .slice(0, 16);
        if (sample.length) lines.push(`    naPlayerLike: ${sample.join(", ")}`);
        const junk = b.naSamples
          .filter((s) => !s.playerLike)
          .map((s) => s.name)
          .slice(0, 8);
        if (junk.length) lines.push(`    naOther: ${junk.join(", ")}`);
      }
      if (b.messageSamples?.length) {
        b.messageSamples.slice(0, 3).forEach((m, j) => {
          lines.push(`    msg[${j}]: rawLen=${m.rawLen ?? "—"} ${m.preview ?? ""}`);
        });
      }
      if (b.wireRecordSamples?.length) {
        lines.push(`    wireRecord[0]: ${b.wireRecordSamples[0]}`);
      }
      if (b.lineupStarters) {
        lines.push(
          `    lineupStarters: home=${b.lineupStarters.home} away=${b.lineupStarters.away} (${b.lineupStarters.source})`
        );
      }
      if (b.finalsCount) {
        lines.push(
          `    finals: ${b.finalsSample?.map((f) => `${f.player} ${f.shots}/${f.onTarget}`).join(", ")}`
        );
      }
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
      const extra = n.isZapWs
        ? ` zap hintLineup=${n.lineupPlayersCount ?? 0} buf=${n.zapBufferLen ?? "—"}`
        : n.isIpeBlob
          ? ` ipe hintLineup=${n.lineupPlayersCount ?? 0}`
          : "";
      lines.push(`${i + 1}. [${n.kind || "?"}] ${n.at ?? "?"} | ${n.url}${extra}`);
    });
  }

  if (debug.sidePanelBlobDebug?.length) {
    lines.push("", "--- LINEUP WIRE ---");
    debug.sidePanelBlobDebug.forEach((b, i) => {
      const isZap = b.source === "zap-ws";
      const src = isZap ? "zap-ws" : "ipe/5378";
      if (isZap) {
        lines.push(
          `${i + 1}. [${src}] msgs=${b.messageCount ?? 0} merged=${b.mergedLen ?? "—"} hint=${b.hintLineupCount ?? 0} wire=${b.wirePlayerCount ?? 0} parsed=${b.lineupParsed ? "yes" : "no"}`
        );
      } else {
        lines.push(
          `${i + 1}. [${src}] hint=${b.hintLineupCount ?? 0} wire=${b.wirePlayerCount ?? 0} naLike=${b.naPlayerLikeCount ?? 0} parsed=${b.lineupParsed ? "yes" : "no"} rawLen=${b.rawLen ?? "—"}`
        );
      }
      if (b.hintLineupPlayers?.length) {
        lines.push(`    hints: ${b.hintLineupPlayers.map((p) => p.name).slice(0, 8).join(", ")}`);
      }
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