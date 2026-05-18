import js from "@eslint/js";

const browserGlobals = {
  alert: "readonly",
  Blob: "readonly",
  cancelAnimationFrame: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  ClipboardEvent: "readonly",
  ClipboardItem: "readonly",
  console: "readonly",
  crypto: "readonly",
  CSS: "readonly",
  DOMParser: "readonly",
  document: "readonly",
  Element: "readonly",
  Event: "readonly",
  fetch: "readonly",
  File: "readonly",
  FormData: "readonly",
  HTMLTableCellElement: "readonly",
  KeyboardEvent: "readonly",
  location: "readonly",
  MouseEvent: "readonly",
  MutationObserver: "readonly",
  navigator: "readonly",
  Node: "readonly",
  performance: "readonly",
  requestAnimationFrame: "readonly",
  Response: "readonly",
  sessionStorage: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
};

const correctnessRules = {
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
};

export default [
  {
    ignores: [
      "node_modules/**",
      "logs/**",
      "test-results/**",
      "__pycache__/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["client/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: correctnessRules,
  },
  {
    files: ["tests/e2e/**/*.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...browserGlobals, ...nodeGlobals },
    },
    rules: correctnessRules,
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...browserGlobals, ...nodeGlobals },
    },
    rules: correctnessRules,
  },
];
