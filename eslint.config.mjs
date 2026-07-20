export default [
    {
        files: ['**/*.js'],
        ignores: ['build/**', 'dist/**', 'node_modules/**'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                console: 'readonly',
                global: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
            },
        },
        rules: {
            'brace-style': ['error', '1tbs'],
            'comma-dangle': ['error', 'always-multiline'],
            'indent': ['error', 4, {SwitchCase: 1}],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            'no-var': 'error',
            'object-curly-spacing': ['error', 'never'],
            'prefer-const': 'error',
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
        },
    },
];
