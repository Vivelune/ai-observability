import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "apps/web/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["loadtest/**/*.js"],
    languageOptions: {
      globals: { __VU: "readonly", __ITER: "readonly", __ENV: "readonly" },
    },
  },
  prettier,
);