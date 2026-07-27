import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tsEslint from 'typescript-eslint';

import apify from '@apify/eslint-config/ts.js';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist'] },
    ...apify,
    prettier,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsEslint.parser,
            parserOptions: {
                project: 'tsconfig.json',
            },
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            '@typescript-eslint': tsEslint.plugin,
        },
        rules: {
            'no-console': 0,
        },
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-console': 0,
        },
    },
    {
        // vitest's `test`/`it` calls are fire-and-forget by design — the
        // runner tracks the returned promise itself, callers don't await it.
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-floating-promises': 0,
            // vi.mock() factories commonly define more than one small fixture
            // class per file (e.g. mocked error constructors).
            'max-classes-per-file': 0,
        },
    },
    {
        // Dev-only tooling, not shipped with the package — its deps belong
        // in devDependencies, not dependencies.
        files: ['scripts/**/*.mjs'],
        rules: {
            'import/no-extraneous-dependencies': 0,
        },
    },
    {
        // 'vitest/config' is a subpath export the extensions rule can't
        // resolve to a concrete file, so it falls back to demanding one.
        files: ['vitest.config.ts'],
        rules: {
            'import/extensions': 0,
        },
    },
];
