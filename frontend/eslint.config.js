import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist'] },
  /*
   * The test bootstrap and suites.
   *
   * They are `.mjs` because Node's test runner only discovers `*.test.?(c|m)js`
   * — a `.test.jsx` is never picked up — but they contain JSX, and the block
   * below only turns JSX parsing on for `{js,jsx}`. Without this ESLint parsed
   * them with its defaults and stopped at the first `<`.
   *
   * The bootstrap lives in `test-support/` rather than `test/` because Node's
   * discovery counts *every* `.mjs` under a directory named `test` as a test
   * file, so a helper module there is reported as a file containing no tests.
   *
   * Node globals as well as browser ones: `register.mjs` builds the DOM, so it
   * runs before one exists and uses `process` and `module`, while the suites
   * themselves touch `document`.
   */
  {
    files: ['test/**/*.{mjs,js,jsx}', 'test-support/**/*.{mjs,js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Same reason as below: without eslint-plugin-react, a component used only
      // as `<Healthy />` reads as an unused binding.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]
