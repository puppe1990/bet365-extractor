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
const parsers = stripModuleSyntax(readFileSync(join(root, "lib/bet365-parsers.js"), "utf8"));
const format = stripModuleSyntax(readFileSync(join(root, "lib/bet365-format.js"), "utf8"));
const zip = stripModuleSyntax(readFileSync(join(root, "lib/bet365-zip.js"), "utf8"));

const pageSniffer = readFileSync(join(root, "templates/network-page-sniffer.js"), "utf8");
const network = readFileSync(join(root, "templates/network-snippet.js"), "utf8").replace(
  "/* __INSTALL_SNIFFER__ */",
  "initNetworkBridge();"
);
const frames = readFileSync(join(root, "templates/frame-utils-snippet.js"), "utf8");
const extTemplate = readFileSync(join(root, "templates/extension-content.js"), "utf8");
const content = extTemplate
  .replace(
    "/* __PARSERS__ */",
    `${marketInference}\n\n${protocolDecode}\n\n${networkParse}\n\n${parsers}`
  )
  .replace("/* __NETWORK__ */", network)
  .replace("/* __FRAMES__ */", frames);

mkdirSync(join(root, "extension/dist"), { recursive: true });
writeFileSync(join(root, "extension/dist/content.js"), content);
writeFileSync(join(root, "extension/dist/zip-utils.js"), `${format}\n\n${zip}\n`);
writeFileSync(join(root, "extension/dist/network-page-sniffer.js"), pageSniffer);

console.log("built extension/dist/content.js");
console.log("built extension/dist/zip-utils.js");