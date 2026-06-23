import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMarketCaExpandText,
  isMarketExpandControlText,
  isMarketGroupCollapsedHint,
  isMarketShowMoreText,
  shouldClickMarketExpandControl,
} from "../lib/bet365-market-expand.js";

describe("bet365 market expand controls", () => {
  it("detecta badge CA e Mostrar Mais", () => {
    assert.equal(isMarketCaExpandText("CA"), true);
    assert.equal(isMarketCaExpandText("ca"), true);
    assert.equal(isMarketShowMoreText("Mostrar Mais"), true);
    assert.equal(isMarketExpandControlText("CA"), true);
    assert.equal(isMarketExpandControlText("Mostrar Mais"), true);
    assert.equal(isMarketExpandControlText("Escanteios - Handicap"), false);
    assert.equal(isMarketExpandControlText("Cassino"), false);
  });

  it("só clica CA quando o grupo está recolhido", () => {
    assert.equal(shouldClickMarketExpandControl("CA", { collapsed: true }), true);
    assert.equal(shouldClickMarketExpandControl("CA", { collapsed: false }), false);
    assert.equal(shouldClickMarketExpandControl("Mostrar Mais", { collapsed: false }), true);
    assert.equal(shouldClickMarketExpandControl("Popular", { collapsed: true }), false);
  });

  it("infere estado recolhido por aria-expanded e classes", () => {
    assert.equal(isMarketGroupCollapsedHint({ ariaExpanded: "false" }), true);
    assert.equal(isMarketGroupCollapsedHint({ ariaExpanded: "true" }), false);
    assert.equal(isMarketGroupCollapsedHint({ className: "cm-MarketGroupCollapsed" }), true);
    assert.equal(isMarketGroupCollapsedHint({ className: "cm-MarketGroupExpanded" }), false);
    assert.equal(isMarketGroupCollapsedHint({ className: "cm-MarketGroup Open" }), false);
  });
});
