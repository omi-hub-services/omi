import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", ".tmp/", "node_modules/", "tests/fixtures/"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "typeLike",
          format: ["PascalCase"],
          custom: { regex: "^(BaseAgent|BaseRepository|BaseService|SquadService)$", match: false },
        },
        { selector: "function", format: ["camelCase"] },
        { selector: "variable", format: ["camelCase"] },
        { selector: "variable", modifiers: ["const"], format: ["camelCase", "UPPER_CASE"] },
      ],
    },
  },
  {
    files: ["src/domain/**/*.ts", "src/application/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "fetch",
        "process",
        "setTimeout",
        "setInterval",
        "WebSocket",
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "Pass time in through a clock port.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Pass time in through a clock port.",
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: "Pass time in through a clock port.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "Pass randomness and IDs in through a port.",
        },
      ],
    },
  },
  {
    files: ["src/interfaces/**/*.ts"],
    rules: { "no-restricted-globals": ["error", "fetch"] },
  },
);
