import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*\n/gm, "")
    .replace(/^export \{[\s\S]*?\};\s*\n/gm, "")
    .replace(/^export /gm, "")
    .trim();
}

const marketInference = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-market-inference.js"), "utf8")
);
const protocolDecode = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-protocol-decode.js"), "utf8")
);
const networkParse = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-network-parse.js"), "utf8")
);
const urlHelpers = stripModuleSyntax(readFileSync(join(root, "lib/bet365-url.js"), "utf8"));
const parsers = stripModuleSyntax(readFileSync(join(root, "lib/bet365-parsers.js"), "utf8"));
const sidePanel = stripModuleSyntax(readFileSync(join(root, "lib/bet365-side-panel.js"), "utf8"));
const sidePanelTabs = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-side-panel-tabs.js"), "utf8")
);
const marketTabs = stripModuleSyntax(readFileSync(join(root, "lib/bet365-market-tabs.js"), "utf8"));
const marketExpand = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-market-expand.js"), "utf8")
);
const statsSubtabs = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-stats-subtabs.js"), "utf8")
);
const format = stripModuleSyntax(readFileSync(join(root, "lib/bet365-format.js"), "utf8"));
const zip = stripModuleSyntax(readFileSync(join(root, "lib/bet365-zip.js"), "utf8"));
const extractPlayer = stripModuleSyntax(
  readFileSync(join(root, "lib/bet365-extract-player.js"), "utf8")
);
const playerSnippet = readFileSync(join(root, "templates/extract-player-snippet.js"), "utf8");

const pageSniffer = readFileSync(join(root, "templates/network-page-sniffer.js"), "utf8");
const network = readFileSync(join(root, "templates/network-snippet.js"), "utf8").replace(
  "/* __INSTALL_SNIFFER__ */",
  `initNetworkBridge();\n  const __BET365_PAGE_SNIFFER_SOURCE__ = ${JSON.stringify(pageSniffer)};`
);
const frames = readFileSync(join(root, "templates/frame-utils-snippet.js"), "utf8");
const extTemplate = readFileSync(join(root, "templates/extension-content.js"), "utf8");
const parserBundle = [
  marketInference,
  protocolDecode,
  networkParse,
  urlHelpers,
  parsers,
  marketTabs,
  marketExpand,
  statsSubtabs,
  sidePanel,
  sidePanelTabs,
  extractPlayer,
].join("\n\n");
const inject = (source, marker, chunk) => source.split(marker).join(chunk);
const content = inject(
  inject(
    inject(inject(extTemplate, "/* __PARSERS__ */", parserBundle), "/* __NETWORK__ */", network),
    "/* __FRAMES__ */",
    frames
  ),
  "/* __EXTRACT_PLAYER__ */",
  playerSnippet
);

mkdirSync(join(root, "extension/dist"), { recursive: true });
writeFileSync(join(root, "extension/dist/content.js"), content);

const mainWorldTemplate = readFileSync(join(root, "templates/main-world-scroll.js"), "utf8");
const mainWorldScroll = mainWorldTemplate
  .replace("/* __MARKET_TABS__ */", () => marketTabs)
  .replace("/* __MARKET_EXPAND__ */", () => marketExpand);
writeFileSync(join(root, "extension/main-world-scroll.js"), mainWorldScroll);
const zipUtils = `${format}\n\n${zip}\n
globalThis.buildZipEntries = buildZipEntries;
globalThis.buildZipFilename = buildZipFilename;
globalThis.buildZipMeta = buildZipMeta;
globalThis.sanitizeDownloadFilename = sanitizeDownloadFilename;
`;
writeFileSync(join(root, "extension/dist/zip-utils.js"), zipUtils);
writeFileSync(join(root, "extension/dist/network-page-sniffer.js"), pageSniffer);

console.log("built extension/dist/content.js");
console.log("built extension/main-world-scroll.js");
console.log("built extension/dist/zip-utils.js");
