// Make every declared bin target executable so the published tarball carries
// the mode itself. npm <= 10 silently chmod +x'ed bin targets at install
// (fixBin); npm 11 (Node 24) stopped, so a 0644 dist/index.js in the tarball
// means `npx mailpouch` fails with EACCES on every fresh POSIX install.
// Runs as part of `npm run build` (an explicit step in CI and the attest
// flow), so it survives `npm publish --ignore-scripts`.
import { chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const target of Object.values(pkg.bin ?? {})) {
  chmodSync(new URL(`../${target}`, import.meta.url), 0o755);
}
