import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNetworkUrl,
  isBet365NetworkUrl,
  looksLikeBet365NetworkPayload,
  parseNetworkPayload,
  extractScoresFromNetworkText,
  extractClockFromNetworkText,
  matchCandidatesFromNetworkText,
} from "../lib/bet365-network-parse.js";
import { extractFromNetworkLog } from "../lib/bet365-parsers.js";

describe("resolveNetworkUrl", () => {
  it("extrai URL de Request object", () => {
    const req = new Request("https://www.bet365.bet.br/statsapi/event");
    assert.equal(resolveNetworkUrl(req), "https://www.bet365.bet.br/statsapi/event");
  });
});

describe("isBet365NetworkUrl", () => {
  it("aceita hosts bet365", () => {
    assert.equal(isBet365NetworkUrl("https://www.bet365.bet.br/matchbettingcontentapi"), true);
    assert.equal(isBet365NetworkUrl("https://example.com/x"), false);
  });
});

describe("parseNetworkPayload", () => {
  it("parseia JSON e protocolo pipe", () => {
    assert.deepEqual(parseNetworkPayload('{"score":"2-2"}'), { score: "2-2" });
    const proto = parseNetworkPayload("SC=2-2;TU=89:19;EV=151352326532");
    assert.equal(proto._bet365Protocol, true);
    assert.ok(proto.segments.some((s) => s.key === "SC"));
  });
});

describe("extractScoresFromNetworkText", () => {
  it("lê SC/SS e relógio TU", () => {
    const text = "OV151352326532C1|SC=2-2|TU=89:19|SS=2-2";
    const scores = extractScoresFromNetworkText(text);
    assert.ok(scores.some((s) => s.score === "2-2"));
    assert.equal(extractClockFromNetworkText(text), "89:19");
  });
});

describe("extractFromNetworkLog", () => {
  it("extrai match de captura websocket", () => {
    const result = extractFromNetworkLog(
      [
        {
          url: "wss://www.bet365.bet.br/zap",
          kind: "ws",
          data: "INPLAY|SC=2-2|TU=90:05|EV151352326532",
        },
      ],
      "2026-06-21T23:54:55.508Z"
    );

    assert.equal(result.match?.score, "2-2");
    assert.equal(result.match?.clock, "90:05");
    assert.equal(result.match?.source, "net-ws");
  });

  it("extrai match de JSON via fetch", () => {
    const result = extractFromNetworkLog(
      [
        {
          url: "https://www.bet365.bet.br/statsapi",
          kind: "fetch",
          data: { scoreHome: 2, scoreAway: 2, clock: "88:10" },
        },
      ],
      "2026-06-21T23:54:55.508Z"
    );

    assert.equal(result.match?.score, "2-2");
    assert.equal(result.match?.source, "net-fetch");
  });
});

describe("matchCandidatesFromNetworkText", () => {
  it("retorna candidatos com source customizado", () => {
    const list = matchCandidatesFromNetworkText("SC=1-0;TU=12:30", "net-ws");
    assert.equal(list[0].source, "net-ws");
    assert.equal(list[0].score, "1-0");
  });
});

describe("looksLikeBet365NetworkPayload", () => {
  it("detecta payload com EV e score", () => {
    assert.equal(looksLikeBet365NetworkPayload("EV151352326532|SC=2-2"), true);
    assert.equal(looksLikeBet365NetworkPayload("hello world"), false);
  });
});
