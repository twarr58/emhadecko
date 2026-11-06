// Conventional Commits — https://www.conventionalcommits.org/
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test', 'deps'],
    ],
    'scope-enum': [1, 'always', ['web', 'worker', 'ci', 'deps', 'docs']],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    // Allow sentence-case (capitalized first word) and lowercase.
    // Still reject Start Case, PascalCase, and UPPER CASE.
    // @commitlint/config-conventional forbids sentence-case too; that rejects
    // subjects such as "Bump the actions group with 4 updates".
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
  },
};
