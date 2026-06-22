import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const scripts = {
  "index.html": readFileSync(join(root, "bet365-console-extractor.js"), "utf8"),
  "index-autorun.html": readFileSync(join(root, "bet365-autorun-bundle.js"), "utf8"),
};

for (const [file, script] of Object.entries(scripts)) {
  const path = join(root, file);
  const html = readFileSync(path, "utf8");
  const updated = html.replace(
    /(<script id="extractor-source" type="text\/plain">)[\s\S]*?(<\/script>)/,
    `$1\n${script}\n  $2`
  );
  writeFileSync(path, updated);
  console.log(`synced ${file}`);
}
