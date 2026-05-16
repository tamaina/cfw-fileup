import pluginMisskey from '@misskey-dev/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
	...pluginMisskey.configs['recommended'],
	{
		files: ['**/*.ts'],
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
];
