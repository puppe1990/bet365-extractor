import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readScript(name) {
  return readFileSync(join(root, name), "utf8");
}

describe("build output", () => {
  it("bet365-console-extractor.js tem sintaxe válida", () => {
    const path = join(root, "bet365-console-extractor.js");
    assert.ok(existsSync(path));
    execSync(`node --check "${path}"`, { stdio: "pipe" });
  });

  it("bet365-autorun-bundle.js concatena extractor + auto-run sem erros", () => {
    const path = join(root, "bet365-autorun-bundle.js");
    assert.ok(existsSync(path), "rode npm run build");

    const source = readScript("bet365-autorun-bundle.js");
    execSync(`node --check "${path}"`, { stdio: "pipe" });

    assert.match(source, /\(function bet365ConsoleExtractorV3\(\)/);
    assert.match(source, /\(async function bet365AutoRunAll\(\)/);
    assert.match(source, /bet365AutoRunResult/);
    assert.match(source, /window\.bet365C\s*=\s*C/);
    assert.match(source, /downloadBet365Data/);

    const closers = source.match(/\}\)\(\);/g) || [];
    assert.equal(closers.length, 2, "bundle deve ter exatamente 2 IIFEs fechadas");
  });

  it("extension/background.js tem sintaxe válida", () => {
    const path = join(root, "extension/background.js");
    execSync(`node --check "${path}"`, { stdio: "pipe" });
  });

  it("extension/dist/network-page-sniffer.js tem sintaxe válida", () => {
    const path = join(root, "extension/dist/network-page-sniffer.js");
    assert.ok(existsSync(path), "rode npm run build:extension");
    execSync(`node --check "${path}"`, { stdio: "pipe" });
  });

  it("extension/dist/content.js tem sintaxe válida", () => {
    const path = join(root, "extension/dist/content.js");
    assert.ok(existsSync(path), "rode npm run build:extension");
    execSync(`node --check "${path}"`, { stdio: "pipe" });
    const source = readScript("extension/dist/content.js");
    assert.match(source, /chrome\.runtime\.onMessage/);
    assert.match(source, /buildData/);
    const hostDecls = source.match(/const BET365_HOST_RE\b/g) || [];
    assert.equal(hostDecls.length, 1, "bundle não pode declarar BET365_HOST_RE mais de uma vez");
    assert.match(source, /STATS_SUB_TAB_KEYS/);
    assert.match(source, /collectStatsSubTabTexts/);
    assert.match(source, /extractStatsFromSubTabTexts/);
  });

  it("extension/dist/zip-utils.js expõe buildZipEntries", () => {
    const path = join(root, "extension/dist/zip-utils.js");
    assert.ok(existsSync(path));
    execSync(`node --check "${path}"`, { stdio: "pipe" });
    const source = readScript("extension/dist/zip-utils.js");
    assert.match(source, /function buildZipEntries/);
    assert.match(source, /function formatBet365Logs/);
    assert.match(source, /function formatBet365DebugLogs/);
    assert.match(source, /function formatBet365TraceLogs/);
    assert.match(source, /trace\.txt/);
    assert.match(source, /globalThis\.buildZipFilename/);
    assert.match(source, /globalThis\.buildZipEntries/);
  });

  it("index-autorun.html embute o bundle auto-run completo", () => {
    const html = readFileSync(join(root, "index-autorun.html"), "utf8");
    const match = html.match(
      /<script id="extractor-source" type="text\/plain">([\s\S]*?)<\/script>/
    );

    assert.ok(match, "extractor-source não encontrado");
    const embedded = match[1].trim();

    assert.match(embedded, /bet365AutoRunAll/);
    assert.doesNotMatch(embedded, /\}\)\(\);\s*\}\)\(\);\s*\}\)\(\);/);
  });
});
