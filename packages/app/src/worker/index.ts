import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { genEaidx } from '../shared/eaid-x';
import { authRoutes } from './api/auth';
import { bucketRoutes } from './api/buckets';
import { fileRoutes } from './api/files';
import { accountRoutes } from './api/account';
import { adminRoutes } from './api/admin';
import { directoryRoutes } from './api/directories';
import { metaRoutes } from './api/meta';
import { fileTokenRoutes } from './api/file-tokens';
import { downloadRoutes } from './routes/download';
import { uploadRoutes } from './routes/upload';
import { generateOpenAPISpec } from './openapi-generator';
import { validateBodyMiddleware } from './middleware/validate-body';

const app = new Hono<{ Bindings: Env }>();

app.use('*', validateBodyMiddleware);

app.onError((err, c) => {
	console.error('Error:', err);

	if (err instanceof HTTPException) {
		return c.json(
			{
				error: err.message || 'Internal Server Error',
			},
			err.status,
		);
	}

	return c.json(
		{
			error: 'Internal Server Error',
		},
		500,
	);
});

app.route('/api', authRoutes);
app.route('/api', metaRoutes);
app.route('/api/buckets', bucketRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/account', accountRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/directories', directoryRoutes);
app.route('/api/file-tokens', fileTokenRoutes);
app.route('/', downloadRoutes);
app.route('/', uploadRoutes);

app.get('/ping', (c) => {
	return c.text('pong');
});

app.get('/id', (c) => {
	return c.text(genEaidx(Date.now()));
});

app.get('/api.json', (c) => {
	const spec = generateOpenAPISpec();
	return c.json(spec);
});

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
