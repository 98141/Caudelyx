import ts from 'typescript-eslint';
import security from 'eslint-plugin-security';
export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', '.runtime/**'] },
  ...ts.configs.recommended,
  security.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } }
);
