// ─── AUTO-RUN: executa todos os comandos automaticamente ───────────────────
(async function bet365AutoRunAll() {
  const C = window.bet365C || {
    dim: "",
    ok: "color:#69F0AE;font-weight:bold",
    title: "color:#FFD700;font-weight:bold",
    warn: "color:#FFB74D;font-weight:bold",
  };

  console.log("%c▸ AUTO-RUN iniciado — aguardando render da página...", C.dim);

  await refreshBet365Data(600);

  console.log("\n%c▸ [1/4] refreshBet365Data() ✓", C.ok);

  const discover = discoverBet365DOM();
  console.log("%c▸ [2/4] discoverBet365DOM() ✓", C.ok, discover);

  const network = showBet365Network();
  console.log("%c▸ [3/4] showBet365Network() ✓", C.ok, `capturas: ${network.length}`);

  const logs = copyBet365Logs();
  console.log("%c▸ [4/4] copyBet365Logs() ✓", C.ok);

  console.log("\n%c═══ RESUMO AUTO-RUN ═══", C.title);
  console.log("  bet365Data.match   →", bet365Data.match);
  console.log("  bet365Data.stats   →", bet365Data.stats.length, "linhas");
  console.log("  bet365Data.odds    →", bet365Data.odds.length, "linhas");
  console.log("  copyBet365Data()   → copia JSON");
  console.log("  copyBet365Logs()   → copia texto");

  window.bet365AutoRunResult = {
    match: bet365Data.match,
    stats: bet365Data.stats,
    odds: bet365Data.odds,
    discover,
    networkCount: network.length,
    logsPreview: logs,
    completedAt: new Date().toISOString(),
  };

  console.log("%c▸ AUTO-RUN concluído → bet365AutoRunResult", C.ok, window.bet365AutoRunResult);

  if (typeof downloadBet365Data === "function") downloadBet365Data();
  if (typeof downloadBet365Logs === "function") downloadBet365Logs();

  return window.bet365AutoRunResult;
})();
