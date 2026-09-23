// Loads inline-skills only once `enable-inline-skills` exists in the working directory,
// so a test can enable it through /reload.
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inlineSkills from "../../../extensions/inline-skills/index.ts";

export default function (pi: ExtensionAPI) {
  if (existsSync("enable-inline-skills")) inlineSkills(pi);
}
