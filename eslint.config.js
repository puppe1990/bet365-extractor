import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "extension/dist/**",
      "extension/vendor/**",
      "outputs/**",
      "bet365-autorun-bundle.js",
      "bet365-console-extractor.js",
      "index-autorun.html",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        chrome: "readonly",
        JSZip: "readonly",
        __BET365_PAGE_SNIFFER_SOURCE__: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-undef": "error",
      "no-control-regex": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "templates/**/*.js",
      "bet365-autorun.js",
      "extension/popup/popup.js",
      "extension/background.js",
      "extension/extension-background.js",
      "extension/main-world-scroll.js",
    ],
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
