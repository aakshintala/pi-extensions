// Test-only producer for FleetView tests, loaded separately from extensions/fleet.
// `/fx <json array of ops>` applies each op, then reports event "fx":
//   {"add": id, "kind", "label", "parent"?, "activity"?, "status"?}
//   {"act": id, "text"}                       new activity line
//   {"update": id, ...fields}                 registry.update(id, fields)
//   {"add": ..., "throws": true}              activity() throws
//   {"add": ..., "log": path}                 viewer shows that log file (default /dev/null)
//   {"add": ..., "transcript": text}          viewer shows a transcript component with that text
//   {"add": ..., "steer": true}               steer handler: activity becomes "steered: <text>"
//                                             stop always finishes the item as stopped
//   {"watchers": true}                        reports event "watchers:<n>", the process's file watchers
//   {"mismatch": true}                        adds a fourth child to Pi's document container
//   {"finish": id, "status", "result", "notice"?}  notice: the model's line; none if absent
//   {"notify": id, "text"}
//   {"clock": seconds}                        the registry's clock (starts at 0)
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
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
            view: "transcript" in op ? { transcript: () => new Text(op.transcript, 1, 0) } : { log: op.log ?? "/dev/null" },
            stop: () => registry.finish(op.add, "stopped", "stopped by user", null),
            steer: op.steer
              ? (text: string) => {
                  activity.set(op.add, `steered: ${text}`);
                  registry.update(op.add);
                }
              : undefined,
          });
        } else if ("act" in op) {
          activity.set(op.act, op.text);
          registry.update(op.act);
        } else if ("update" in op) {
          const { update, ...change } = op;
          registry.update(update, change);
        } else if ("finish" in op) registry.finish(op.finish, op.status, op.result, op.notice ?? null);
        else if ("notify" in op) registry.notify(op.notify, op.text);
        else if ("watchers" in op) {
          const n = process.getActiveResourcesInfo().filter((r) => r === "StatWatcher").length;
          appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: `watchers:${n}` }) + "\n");
        } else if ("mismatch" in op) {
          ctx.ui.setWidget(
            "fx-mismatch",
            (tui: TUI) => {
              (tui.children[0] as Container).addChild(new Container());
              return new Container();
            },
            { placement: "belowEditor" },
          );
        } else if ("clock" in op) {
          now = op.clock;
          for (const item of registry.items()) registry.update(item.id);
        }
      }
      appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: "fx" }) + "\n");
    },
  });
}
