import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { openAPIRouteHandler } from 'hono-openapi';
import { genEaidx } from '../shared/eaid-x';
import { authRoutes } from './api/auth';
import { bucketRoutes } from './api/buckets';
import { fileRoutes } from './api/files';
import { accountRoutes } from './api/account';
import { adminRoutes } from './api/admin';
import { adminBillingRoutes } from './api/admin-billing';
import { billingRoutes } from './api/billing';
import { directoryRoutes } from './api/directories';
import { metaRoutes } from './api/meta';
import { fileTokenRoutes } from './api/file-tokens';
import { fileReportRoutes } from './api/file-reports';
import { passkeyRoutes } from './api/passkey';
import { googleAuthRoutes } from './api/google-auth';
import { indieAuthRoutes } from './api/indieauth';
import { activityPubRoutes } from './routes/activitypub';
import { downloadRoutes } from './routes/download';
import { uploadRoutes } from './routes/upload';
import { viewHtmlRoutes } from './routes/view-html';
import { embedRoutes } from './routes/embed';
import { ApiError, createApiErrorResponse } from './utils/api-error';
import { rejectIpBan } from './utils/moderation';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
	await rejectIpBan(c);
	await next();
});

app.use('/upload/*', async (c, next) => {
	await rejectIpBan(c);
	await next();
});

app.use('/v/*', async (c, next) => {
	await rejectIpBan(c);
	await next();
});

app.use('/d/*', async (c, next) => {
	await rejectIpBan(c);
	await next();
});

app.use('/e/*', async (c, next) => {
	await rejectIpBan(c);
	await next();
});

app.onError((err, c) => {
	console.error('Error:', err);

	if (err instanceof ApiError) {
		return c.json(
			createApiErrorResponse(err.code, err.message),
			err.status,
		);
	}

	if (err instanceof HTTPException) {
		return c.json(createApiErrorResponse('INTERNAL_SERVER_ERROR'), err.status);
	}

	if (isFilesUniqueConstraintError(err)) {
		return c.json(createApiErrorResponse('FILE_ALREADY_EXISTS'), 409);
	}

	return c.json(
		createApiErrorResponse('INTERNAL_SERVER_ERROR'),
		500,
	);
});

function isFilesUniqueConstraintError(err: unknown): boolean {
	const message = errorMessages(err).join('\n');
	return message.includes('UNIQUE constraint failed')
		&& (
			message.includes('files.bucket_id, files.path')
			|| message.includes('files.r2_key')
		);
}

function errorMessages(err: unknown): string[] {
	if (err instanceof Error) {
		return [
			err.message,
			...errorMessages(err.cause),
		];
	}
	if (err === undefined || err === null) return [];
	return [String(err)];
}

app.route('/api', authRoutes);
app.route('/api', metaRoutes);
app.route('/api/buckets', bucketRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/account', accountRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin', adminBillingRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/directories', directoryRoutes);
app.route('/api/file-tokens', fileTokenRoutes);
app.route('/api/file-reports', fileReportRoutes);
app.route('/api/passkey', passkeyRoutes);
app.route('/api/auth/google', googleAuthRoutes);
app.route('/api/auth/indieauth', indieAuthRoutes);
app.route('/', activityPubRoutes);
app.route('/', downloadRoutes);
app.route('/', uploadRoutes);
app.route('/', viewHtmlRoutes);
app.route('/', embedRoutes);

app.get('/ping', (c) => {
	return c.text('pong');
});

app.get('/id', (c) => {
	return c.text(genEaidx(Date.now()));
});

app.get(
	'/api.json',
	openAPIRouteHandler(app, {
		documentation: {
			info: { title: 'CFW FileUp API', version: '1.0.0' },
			servers: [{ url: '/', description: 'Current server' }],
		},
	}),
);

app.get('/api-doc', (c) => {
	return c.html(`<!DOCTYPE html>
<html>
	<head>
		<title>CFW FileUp API Documentation</title>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<style>
			html {
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
				background: #fff;
			}
			body {
				margin: 0;
				padding: 0;
			}
			#error-message {
				display: none;
				padding: 20px;
				background-color: #ffebee;
				color: #c62828;
				margin: 20px;
				border-radius: 4px;
			}
		</style>
	</head>
	<body>
		<div id="error-message">Failed to load API specification. Please refresh the page.</div>
		<script id="api-reference" data-url="/api.json"></script>
		<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
		<script>
			// Error handling for API spec loading
			const apiRefElement = document.getElementById('api-reference');
			const errorElement = document.getElementById('error-message');

			if (!apiRefElement) {
				errorElement.style.display = 'block';
			}

			// Fallback if Scalar fails to load
			setTimeout(() => {
				if (!document.querySelector('.scalar-api-reference')) {
					errorElement.style.display = 'block';
				}
			}, 3000);
		</script>
	</body>
</html>`);
});

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// eslint-disable-next-line import/no-default-export
export default app;
