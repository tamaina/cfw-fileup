import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { genEaidx } from '../shared/eaid-x';
import authRoutes from './api/auth';
import bucketRoutes from './api/buckets';
import fileRoutes from './api/files';
import accountRoutes from './api/account';
import adminRoutes from './api/admin';
import directoryRoutes from './api/directories';
import downloadRoutes from './routes/download';
import uploadRoutes from './routes/upload';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
	console.error('Error:', err);

	if (err instanceof HTTPException) {
		return c.json(
			{
				error: err.message || 'Internal Server Error',
			},
			err.status || 500,
		);
	}

	return c.json(
		{
			error: 'Internal Server Error',
		},
		500,
	);
});

app.get('/ping', (c) => {
	return c.text('pong');
});

app.get('/id', (c) => {
	return c.text(genEaidx(Date.now()));
});

app.route('/api', authRoutes);
app.route('/api/buckets', bucketRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/account', accountRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/directories', directoryRoutes);
app.route('/', downloadRoutes);
app.route('/', uploadRoutes);

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
