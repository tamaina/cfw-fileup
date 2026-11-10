import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const noisyWorkerdWebSocketDisconnectLog = 'workerd/api/web-socket.c++:828: disconnected: WebSocket peer disconnected';
const noisyWorkerdNetworkLogs = [
	'connect(): Connection refused',
	'Network connection lost.',
];

function installWorkerdLogFilter(stream: NodeJS.WriteStream): void {
	const originalWrite = stream.write.bind(stream);
	stream.write = ((chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
		const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
		if (noisyWorkerdNetworkLogs.some(pattern => text.includes(pattern))) {
			if (typeof encodingOrCallback === 'function') encodingOrCallback();
			callback?.();
			return true;
		}
		if (!text.includes(noisyWorkerdWebSocketDisconnectLog)) {
			return originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
		}

		const filtered = text
			.split(/\r?\n/)
			.filter((line) => !line.includes(noisyWorkerdWebSocketDisconnectLog))
			.join('\n');
		if (typeof encodingOrCallback === 'function') encodingOrCallback();
		callback?.();
		if (filtered.length === 0) return true;
		return originalWrite(filtered, 'utf8');
	}) as typeof stream.write;
}

installWorkerdLogFilter(process.stdout);
installWorkerdLogFilter(process.stderr);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		// Client/shared tests use Node APIs (including transferable MessagePorts)
		// and run in vitest.config.ts. Only API/DB tests belong in workerd.
		include: ['test/worker/**/*.test.ts'],
		exclude: ['**/node_modules/**', 'test/e2e/**'],
	},
});
