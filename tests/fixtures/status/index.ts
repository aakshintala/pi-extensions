// Test-only wrapper for the status TUI tests: makes pi's cwd a clean git repo
// on branch main (before pi's footer looks for one), serves a fixed quota feed
// instead of QuotaBar.app, and is loaded in place of the status extension.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import status from "../../../extensions/status/index.ts";

const FEED = {
  providers: [
    { id: "claude", status: "healthy", quotas: [{ label: "Session", percentRemaining: 78, status: "healthy" }, { label: "Weekly", percentRemaining: 41, status: "healthy" }] },
    { id: "codex", status: "healthy", quotas: [{ label: "Weekly", percentRemaining: 12, status: "low" }] },
  ],
};

export default function (pi: ExtensionAPI) {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  if (!existsSync(".git")) {
    // Once: pi runs extension factories again on /new.
    git("init", "-q", "-b", "main");
    writeFileSync("a.txt", "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
  }
  status(pi, { fetch: async () => Response.json(FEED) });
}
