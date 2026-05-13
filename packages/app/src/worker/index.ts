import { Hono } from 'hono';
import { genEaidx } from '../shared/eaid-x';

const app = new Hono();

app.get('/ping', (c) => {
	return c.text('pong');
});

app.get('/id', (c) => {
  return c.text(genEaidx(Date.now()));
});

export default app;
