import { readFileSync, writeFileSync } from "node:fs";
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
const format = stripModuleSyntax(readFileSync(join(root, "lib/bet365-format.js"), "utf8"));

const network = readFileSync(join(root, "templates/network-snippet.js"), "utf8");
const frames = readFileSync(join(root, "templates/frame-utils-snippet.js"), "utf8");
const shell = readFileSync(join(root, "templates/console-shell.js"), "utf8");

const output = shell
  .replace(
    "/* __PARSERS__ */",
    `${marketInference}\n\n${protocolDecode}\n\n${networkParse}\n\n${urlHelpers}\n\n${parsers}\n\n${format}`
  )
  .replace(
    "/* __NETWORK__ */",
    network.replace("/* __INSTALL_SNIFFER__ */", "installNetworkSniffer();")
  )
  .replace("/* __FRAMES__ */", frames);

writeFileSync(join(root, "bet365-console-extractor.js"), output);

const autorun = readFileSync(join(root, "bet365-autorun.js"), "utf8").trim();
writeFileSync(join(root, "bet365-autorun-bundle.js"), `${output}\n\n${autorun}\n`);

console.log("built bet365-console-extractor.js");
console.log("built bet365-autorun-bundle.js");
