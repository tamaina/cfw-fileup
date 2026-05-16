import pluginMisskey from '@misskey-dev/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

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
		files: ['**/*.js'],
		rules: {
			'import/no-default-export': 'off',
		},
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		ignores: ['src/client/**'],
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
	{
		files: ['src/worker/**/*.ts', 'src/worker/**/*.tsx'],
		languageOptions: {
			parserOptions: {
				ecmaVersion: 'latest',
				parser: tsParser,
				project: ['./src/worker/tsconfig.json'],
				sourceType: 'module',
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ['src/client/**/*.ts', 'src/client/**/*.tsx', 'src/client/**/*.vue'],
		languageOptions: {
			parserOptions: {
				ecmaVersion: 'latest',
				parser: tsParser,
				project: ['./src/client/tsconfig.json'],
				sourceType: 'module',
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
];
