---
name: ecma-stream
description: "TypeScript/JavaScriptでStreamを扱う際の注意点。バックプレッシャーの話など。"
context: fork
tags: [typescript, stream]
---

# TransformStream: Write and read must run concurrently
writer.write/close to stall if the readable side is not being drained.

## Good

```typescript
async function compressDeflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	const cs = new CompressionStream('deflate-raw');
	const chunks: Uint8Array[] = [];

	const writePromise = (async () => {
		const writer = cs.writable.getWriter();
		await writer.write(data);
		await writer.close();
	})();

	const readPromise = (async () => {
		const reader = cs.readable.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value instanceof Uint8Array) chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();

	await Promise.all([writePromise, readPromise]);

	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) { out.set(c, pos); pos += c.length; }
	return out;
}
```

## Bad

```typescript
async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream('deflate-raw');
	const writer = cs.writable.getWriter();
	await writer.write(new Uint8Array(data));
	await writer.close();
	const chunks: Uint8Array[] = [];
	const reader = cs.readable.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value instanceof Uint8Array) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) { out.set(c, pos); pos += c.length; }
	return out;
}
```
