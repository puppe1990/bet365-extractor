import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBet365WireFields,
  scanBet365WireText,
  extractFromBet365WirePayload,
  extractNetworkHints,
  isBet365BlobUrl,
} from "../lib/bet365-protocol-decode.js";
import { extractFromNetworkLog } from "../lib/bet365-parsers.js";

const WS_TIME = "\u0014__time\u0001F|IN|TI=20260622005943869|UF=55";
const WS_SCORE = "OV|SC=2-2|TU=94:10|S1=2|S2=2|NA=Uruguai|N2=Cabo Verde";
const BLOB_SNIPPET =
  "(function(){var x='live';return {SC:'2-2',TU:'94:10',EV:'EV151352326532'};})();" +
  "x".repeat(5000) +
  "|SC=2-2|TU=94:10|";

describe("parseBet365WireFields", () => {
  it("extrai campos TI/UF do zap", () => {
    const fields = parseBet365WireFields(WS_TIME);
    assert.equal(fields.TI, "20260622005943869");
    assert.equal(fields.UF, "55");
  });

  it("extrai placar e relógio do protocolo pipe", () => {
    const fields = parseBet365WireFields(WS_SCORE);
    assert.equal(fields.SC, "2-2");
    assert.equal(fields.TU, "94:10");
    assert.equal(fields.S1, "2");
    assert.equal(fields.S2, "2");
  });
});

describe("scanBet365WireText", () => {
  it("encontra SC e TU em blob minificado", () => {
    const scanned = scanBet365WireText(BLOB_SNIPPET);
    assert.ok(scanned.matches.some((m) => m.score === "2-2"));
    assert.ok(scanned.clocks.includes("94:10"));
  });
});

describe("extractFromBet365WirePayload", () => {
  it("monta candidato de match a partir dos campos", () => {
    const match = extractFromBet365WirePayload(WS_SCORE, "net-ws");
    assert.equal(match.score, "2-2");
    assert.equal(match.clock, "94:10");
    assert.equal(match.source, "net-ws");
  });
});

describe("extractFromNetworkLog with hints", () => {
  it("usa hints embutidos na captura blob", () => {
    const result = extractFromNetworkLog(
      [
        {
          url: "/Api/1/Blob?33,www-sports,ipe-BR",
          kind: "xhr",
          data: BLOB_SNIPPET.slice(0, 12000),
          rawLen: BLOB_SNIPPET.length,
          hints: extractNetworkHints(BLOB_SNIPPET, "/Api/1/Blob?33,www-sports,ipe-BR"),
        },
      ],
      "2026-06-21T23:59:47.653Z"
    );

    assert.equal(result.match?.score, "2-2");
    assert.equal(result.match?.clock, "94:10");
    assert.equal(result.match?.source, "net-blob");
  });
});

describe("isBet365BlobUrl", () => {
  it("detecta endpoint Blob", () => {
    assert.equal(isBet365BlobUrl("/Api/1/Blob?33,www-sports"), true);
  });
});
