import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/e/*', (c) => c.env.ASSETS.fetch(new Request(new URL('/embed', c.req.url))));

export const embedRoutes = app;
