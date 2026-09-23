// Test-only producer for FleetView tests, loaded separately from extensions/fleet.
// `/fx <json array of ops>` applies each op, then reports event "fx":
//   {"add": id, "kind", "label", "parent"?, "activity"?, "status"?}
//   {"act": id, "text"}                       new activity line
//   {"update": id, ...fields}                 registry.update(id, fields)
//   {"add": ..., "throws": true}              activity() throws
//   {"finish": id, "status", "result", "notice"?}  notice: the model's line
//   {"notify": id, "text"}
//   {"clock": seconds}                        the registry's clock (starts at 0)
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleet } from "../../../shared/fleet/index.ts";

export default function (pi: ExtensionAPI) {
  const activity = new Map<string, string>();
  let now = 0;

  pi.registerCommand("fx", {
    description: "Test producer",
    handler: async (args, ctx) => {
      const registry = fleet();
      registry.now = () => now * 1000;
      for (const op of JSON.parse(args)) {
        if ("add" in op) {
          activity.set(op.add, op.activity ?? "");
          registry.register({
            id: op.add,
            owner: ctx.sessionManager.getSessionId(),
            kind: op.kind,
            label: op.label,
            parentId: op.parent,
            status: op.status,
            activity: () => {
              if (op.throws) throw new Error("producer bug");
              return activity.get(op.add) ?? "";
            },
            view: { log: "/dev/null" },
            stop() {},
          });
        } else if ("act" in op) {
          activity.set(op.act, op.text);
          registry.update(op.act);
        } else if ("update" in op) {
          const { update, ...change } = op;
          registry.update(update, change);
        } else if ("finish" in op) registry.finish(op.finish, op.status, op.result, op.notice);
        else if ("notify" in op) registry.notify(op.notify, op.text);
        else if ("clock" in op) {
          now = op.clock;
          for (const item of registry.items()) registry.update(item.id);
        }
      }
      appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: "fx" }) + "\n");
    },
  });
}
