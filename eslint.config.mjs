import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat config. Two rules here are not style, they are brief invariants:
 *  - packages/engine must not read the clock (CLAUDE.md rule 9, brief section 8):
 *    `Date.now()`, `new Date()` with no arguments and `performance` are banned, while
 *    the Date type and date arithmetic from given values are not.
 *  - packages/ingest must stay framework-agnostic (brief section 4).
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  {
    // Everything here runs on Node: the scripts, the worker, the ingest pipeline.
    languageOptions: { globals: { ...globals.node } },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // brief section 8 / CLAUDE.md rule 9: "Time is a parameter. No hidden clock reads
    // inside engines." Every engine function takes `now`, so the simulator and the
    // time-travel tests can move the clock themselves.
    files: ['packages/engine/**/*.ts'],
    rules: {
      /*
       * What is banned is READING the clock, not using the Date type.
       *
       * This started as a blanket ban on the `Date` global, which was over-broad and
       * only looked right while no engine constructed a date. `new Date(iso)` and
       * `Date.UTC(y, m, d)` are pure functions of their arguments — the cohort rules
       * need both to work out which week a signup falls in — and banning them pushes
       * perfectly deterministic code into epoch-millisecond arithmetic for nothing.
       *
       * So the three ways to actually read the clock are banned by name, and the
       * type is left alone.
       */
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'engines take `now` as an argument (CLAUDE.md rule 9)',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'engines take `now` as an argument (CLAUDE.md rule 9)' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'engines take `now` as an argument (CLAUDE.md rule 9)',
        },
      ],
    },
  },
  {
    /*
     * CLAUDE.md rule 9 again, this time in SQL.
     *
     * The funnel jobs and the stored reads all take `now` as a parameter, and one of
     * them still read `current_date` inside its query. That is the same hidden clock
     * the rule is about: it made the 8-week trend impossible to test over simulated
     * data (which happens months in the past) and it would have answered a question
     * about last August with the last eight weeks of this month.
     */
    files: [
      'packages/ingest/src/funnel/**/*.ts',
      'packages/ingest/src/intent/**/*.ts',
      'packages/ingest/src/leaks/**/*.ts',
      'packages/db/src/funnel-reads.ts',
      'packages/db/src/dashboard-reads.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/current_date|current_timestamp|\\bnow\\(\\)/i]',
          message:
            'these queries take `now` as a parameter: a clock read in SQL is still a hidden clock read (CLAUDE.md rule 9)',
        },
      ],
    },
  },
  {
    // brief section 4: ingest must be framework-agnostic so it can move to its own service.
    files: ['packages/ingest/**/*.ts', 'packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message:
                'packages/ingest and packages/engine must not import Next.js (brief section 4)',
            },
            {
              group: ['@dripmetric/web', '../../apps/*'],
              message: 'packages must not import from apps/* (CLAUDE.md invariants)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', 'packages/sim/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
