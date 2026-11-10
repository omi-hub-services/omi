// Lets `node` run tools that import `src/` modules. Source files use NodeNext-style `.js`
// import specifiers (AGENTS.md §3); Node's type stripping does not map those to `.ts`.
// Usage: node --import ./tools/register-ts-imports.ts tools/<tool>.ts
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
