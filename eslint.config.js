// eslint.config.js - Flat config format for ESLint v10+
const js = require('@eslint/js');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                ...require('globals').node,
                ...require('globals').jest
            }
        },
        rules: {
            // ERRORS — release blocked
            'no-undef': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
            'no-const-assign': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',

            // WARNINGS — tech debt
            'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
            'prefer-const': 'warn',
            'no-var': 'warn',
            'eqeqeq': ['warn', 'always'],

            // OFF — handled elsewhere or too noisy
            'no-empty': 'off'
        }
    },
    {
        files: ['**/*.test.js', '**/*.spec.js'],
        rules: {
            'no-console': 'off'
        }
    }
];