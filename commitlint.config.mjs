// Conventional Commits — https://www.conventionalcommits.org/
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test', 'deps'],
    ],
    'scope-enum': [1, 'always', ['web', 'ci', 'deps', 'docs']],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
