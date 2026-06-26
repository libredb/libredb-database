import tseslint from "typescript-eslint";

// Type-aware gate ONLY. Oxlint (.oxlintrc.json) owns all syntactic/correctness
// linting; ESLint is reduced to the small set of rules that need the real
// TypeScript type checker, run against the durability core. The promise rules
// are near-no-ops today (the core is synchronous) but cost nothing and guard
// against future async drift in the guarded core.
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".remember/**", "eslint.config.js"],
  },
  {
    files: ["src/**/*.ts"],
    // base (not `recommended`) registers tseslint.parser without re-adding the
    // syntactic rules oxlint already owns.
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
);
