import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    ...tseslint.configs.recommended.map(config => ({
        ...config,
        files: ["src/**/*.ts", "frontend/src/**/*.ts"],
    })),
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.worker,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
        },
    },
    {
        files: ["frontend/src/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
    {
        ignores: ["dist/**", "node_modules/**", "frontend/src/global.d.ts"],
    },
);
