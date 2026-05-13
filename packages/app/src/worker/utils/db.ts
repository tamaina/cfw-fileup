import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../scheme/index';

export function getDb(env: CloudflareBindings) {
	return drizzle(env.DB, { schema });
}
