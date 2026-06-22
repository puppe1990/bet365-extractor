import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBet365MatchUrl,
  extractBet365EventId,
  bet365UrlHint,
} from "../lib/bet365-url.js";

describe("isBet365MatchUrl", () => {
  it("aceita jogo ao vivo #/IP/EV...", () => {
    assert.equal(
      isBet365MatchUrl("https://www.bet365.bet.br/#/IP/EV151352326532C1/"),
      true
    );
  });

  it("aceita pré-jogo #/AC/.../E...", () => {
    assert.equal(
      isBet365MatchUrl(
        "https://www.bet365.bet.br/#/AC/B1/C1/D8/E194699812/F3/I1/"
      ),
      true
    );
  });

  it("rejeita página genérica sem evento", () => {
    assert.equal(isBet365MatchUrl("https://www.bet365.bet.br/#/AS/B1/"), false);
  });
});

describe("extractBet365EventId", () => {
  it("lê EV ao vivo", () => {
    assert.equal(
      extractBet365EventId("#/IP/EV151352326532C1/"),
      "EV151352326532"
    );
  });

  it("lê E pré-jogo", () => {
    assert.equal(
      extractBet365EventId("#/AC/B1/C1/D8/E194699812/F3/I1/"),
      "E194699812"
    );
  });
});

describe("bet365UrlHint", () => {
  it("retorna null para URL válida", () => {
    assert.equal(
      bet365UrlHint("https://www.bet365.bet.br/#/AC/B1/C1/D8/E194699812/F3/I1/"),
      null
    );
  });
});