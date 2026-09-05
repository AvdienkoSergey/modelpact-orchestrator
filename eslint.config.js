import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig(
  // `src/surface.ts` is compiled and never run, by `tsconfig.surface.json`
  // alone: it imports from `../dist`, which does not exist until a build, so
  // no lint project can read it. `demo/` is its own package, against the
  // published `exports` map and with its own tsconfig; linting it from here
  // type-checks it against the wrong project.
  { ignores: ["dist/**", "demo/**", "src/surface.ts"] },
  {
    files: ["**/*.ts", "**/*.js"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.js", "*.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
    },
  },
  {
    files: ["**/*.config.{js,ts}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["**/*.test-d.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
