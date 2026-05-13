import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/worker/scheme/*.ts',
	out: './drizzle/migrations',
});
