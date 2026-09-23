// Pi resolves `@earendil-works/pi-tui` for extensions itself; plain node cannot, because
// the package is nested under pi-coding-agent. Import this first, then import modules
// that use pi-tui dynamically (static imports resolve before this runs).
// ponytail: a pi-tui devDependency in package.json would make this hook unnecessary.
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const piTui = pathToFileURL(
  createRequire(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))).resolve("@earendil-works/pi-tui"),
).href;

registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "@earendil-works/pi-tui" ? { url: piTui, shortCircuit: true } : next(specifier, context),
});
