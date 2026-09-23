// Test-only extension for the /rig menu tests: declares two sections with
// settings and one without, and reports every value it sees change as an
// event `<section>.<key>=<value>` in $PI_HARNESS_EVENTS.
import { appendFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../../shared/settings/index.ts";

export default function (_pi: ExtensionAPI) {
  const rig = rigSettings(getAgentDir());
  const sections = [
    rig.declare("alpha", [
      { key: "enabled", type: "boolean", default: true, description: "Turn alpha on" },
      { key: "count", type: "integer", min: 1, max: 32, default: 10, description: "How many alphas" },
      { key: "mode", type: "enum", values: ["fast", "slow", "off"], default: "fast", description: "Alpha mode" },
    ]),
    rig.declare("beta", [
      { key: "limit", type: "integer", min: 0, max: 4, default: 2, description: "Beta limit" },
      {
        key: "tone",
        type: "enum",
        values: ["low", "high"],
        other: { label: "a number", test: (v) => /^\d+$/.test(v) },
        default: "low",
        description: "Beta tone",
      },
    ]),
    rig.declare("gamma", []),
  ];
  for (const section of sections) {
    section.onChange((key) => {
      const event = `${section.name}.${key}=${section.get(key)}`;
      appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event }) + "\n");
    });
  }
}
