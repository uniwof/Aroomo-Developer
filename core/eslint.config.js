import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'error',
      // ESLint 10 新增的推荐规则；为修 osv（minimatch）升级 ESLint 时暂关，保持与 ESLint 9 相同的规则集（D248 osv 修复）
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 借来的 Ekko 代码（BSL 1.1，收费前剥离）只能经 src/borrowed/ekko.ts 一层引用（third_party/ekko/BORROWED.md）
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/third_party/**'], message: '借用代码只能经 src/borrowed/ekko.ts 引用（third_party/ekko/BORROWED.md）' }] }],
    },
  },
  {
    files: ['src/borrowed/ekko.ts', 'src/third_party/ekko/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
