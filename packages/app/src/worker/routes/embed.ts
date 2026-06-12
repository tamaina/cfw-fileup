import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/e/*', (c) => c.env.ASSETS.fetch('/embed'));

export const embedRoutes = app;
