import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { files } from './files';

export const fileReports = sqliteTable('file_reports', {
	id: text('id').primaryKey(),
	fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
	reporterName: text('reporter_name').notNull(),
	reporterEmail: text('reporter_email'),
	reasonId: text('reason_id', { enum: ['copyright', 'malware', 'phishing', 'leaked_data', 'illegal_goods', 'privacy', 'impersonation', 'defamation', 'obscenity', 'animal_abuse', 'human_abuse'] }),
	relationshipId: text('relationship_id', { enum: ['rights_holder', 'agent', 'third_party'] }),
	contact: text('contact'),
	summary: text('summary').notNull(),
	detail: text('detail').notNull(),
	status: text('status', { enum: ['open', 'in_progress', 'resolved', 'junk'] }).notNull().default('open'),
	adminNote: text('admin_note').notNull().default(''),
	reporterIpAddress: text('reporter_ip_address'),
	reporterUserAgent: text('reporter_user_agent'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
}, (table) => [
	index('file_reports_file_id_id_idx').on(table.fileId, table.id),
	index('file_reports_status_id_idx').on(table.status, table.id),
]);
