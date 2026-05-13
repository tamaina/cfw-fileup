import pluginMisskey from '@misskey-dev/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { globalIgnores } from 'eslint/config';

export default [
	...pluginMisskey.configs['recommended'],
	{
		files: ['**/*.js', '**/*.jsx'],
		languageOptions: {
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
			},
		},
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parserOptions: {
				ecmaVersion: 'latest',
				parser: tsParser,
				project: ['./tsconfig.json'],
				sourceType: 'module',
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
  globalIgnores([
    './vite.config.ts',
  ]),
];
