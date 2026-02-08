module.exports = {
  extends: 'erb',
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    'react/prop-types': 'off',
    'lines-between-class-members': 'off',
    'class-methods-use-this': 'off',

    // Desktop app — console output is fine
    'no-console': 'off',

    // Modern JS — for-of, generators are standard
    'no-restricted-syntax': 'off',

    // Binary data parsing needs bitwise ops
    'no-bitwise': 'off',

    // Performance-sensitive loops use continue, ++, await-in-loop
    'no-continue': 'off',
    'no-plusplus': 'off',
    'no-await-in-loop': 'off',

    // Function hoisting is intentional
    'no-use-before-define': 'off',

    // Named exports are fine
    'import/prefer-default-export': 'off',

    // TypeScript handles prop types and default props
    'react/require-default-props': 'off',

    // Desktop app — not a web accessibility target
    'jsx-a11y/label-has-associated-control': 'off',
    'jsx-a11y/no-static-element-interactions': 'off',
    'jsx-a11y/click-events-have-key-events': 'off',
    'jsx-a11y/control-has-associated-label': 'off',

    // Intentional patterns in this codebase
    'no-nested-ternary': 'off',
    'consistent-return': 'off',
    'no-underscore-dangle': 'off',
    'max-classes-per-file': 'off',
    'no-restricted-exports': 'off',
    'no-multi-assign': 'off',
    'no-param-reassign': 'off',
    'prefer-destructuring': 'off',
    'no-case-declarations': 'off',
    'react/no-array-index-key': 'off',

    // React hooks dep arrays are intentional — adding deps causes re-render loops
    'react-hooks/exhaustive-deps': 'off',

    // Promise patterns used intentionally (fire-and-forget IPC)
    'promise/catch-or-return': 'off',
    'promise/always-return': 'off',

    // Constructor naming (slippi-js uses lowercase constructors)
    'new-cap': 'off',

    // Allow unused vars prefixed with _ (common convention for intentionally unused params)
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
  globals: {
    React: 'readonly',
    JSX: 'readonly',
    NodeJS: 'readonly',
  },
  overrides: [
    {
      // Allow `self` in web workers
      files: ['src/renderer/workers/**', 'src/models/Worker.ts'],
      globals: {
        self: 'readonly',
      },
      rules: {
        'no-restricted-globals': 'off',
      },
    },
    {
      // JS files used as scripts
      files: ['src/**/*.js'],
      rules: {
        'no-undef': 'off',
      },
    },
  ],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    createDefaultProgram: true,
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {},
      webpack: {
        config: require.resolve('./.erb/configs/webpack.config.eslint.ts'),
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
}
