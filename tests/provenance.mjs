// Provenance check: every upstream/<name>/ dir needs SOURCE (version/commit) + LICENSE.
// Passes vacuously until the first upstream source lands.
import { readdirSync, existsSync } from "node:fs";

const entries = readdirSync("upstream", { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "node_modules")
  .map((d) => d.name);

let failed = false;
for (const name of entries) {
  if (!existsSync(`upstream/${name}/SOURCE`)) {
    console.error(`missing upstream/${name}/SOURCE`);
    failed = true;
  }
  if (!existsSync(`upstream/${name}/LICENSE`)) {
    console.error(`missing upstream/${name}/LICENSE`);
    failed = true;
  }
}
if (!failed) console.log("provenance ok");
process.exit(failed ? 1 : 0);
