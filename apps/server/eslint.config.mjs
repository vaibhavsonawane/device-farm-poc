import base from '@devicelab/config/eslint';

export default [
  ...base,
  {
    // Nest resolves constructor injection from emitted decorator metadata, so
    // injected classes must stay value imports.
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
];
