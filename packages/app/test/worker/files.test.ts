import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupUserAndBucket() {
	const { data } = await signup('user1');
	const token = String(data.token);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: 'test_bucket' }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	return { token, bucketId };
}

async function createClosedFile(options: {
	token: string;
	bucketId: string;
	path: string;
	visibility?: 'public' | 'private' | 'passphrase';
	isListed?: boolean;
	passphrase?: string;
}) {
	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(options.token),
		body: JSON.stringify({ bucketId: options.bucketId, path: options.path }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };
	await env.R2.put(fileId, `Content for ${options.path}`);
	await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(options.token),
		body: JSON.stringify({
			fileId,
			visibility: options.visibility ?? 'public',
			isListed: options.isListed,
			passphrase: options.passphrase,
		}),
	}, env);
	return fileId;
}

describe('POST /api/files/create/open', () => {
	test('creates file record and returns fileId + uploadExpiry', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.fileId).toBe('string');
		expect(typeof body.uploadExpiry).toBe('number');
	});

	test('opened but unclosed file is not downloadable', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'draft.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		await env.R2.put(fileId, 'draft');

		const res = await app.request(`/d/${fileId}`, { method: 'GET' }, env);
		expect(res.status).toBe(404);
	});

	test('nonexistent bucket returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId: 'nonexistent', path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('cannot create file in another user\'s bucket', async () => {
		const { bucketId } = await setupUserAndBucket();
		const { data: d2 } = await signup('user2');
		const t2 = String(d2.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(403);
	});

	test('duplicate closed file path returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Put data in R2 and close the file
		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		// Try to create the same path again
		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(409);
	});

	test('missing bucketId or path returns 400', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ path: 'hello.txt' }),
		}, env);
		expect(res.status).toBe(400);
	});

	test('invalid file path returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		for (const path of ['bad?.txt', 'dir/bad:name.txt', 'dir/trailingdot.']) {
			const res = await app.request('/api/files/create/open', {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ bucketId, path }),
			}, env);
			expect(res.status).toBe(400);
		}
	});

	test('file path that conflicts with a directory returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const mkdirRes = await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs/' }),
		}, env);
		expect(mkdirRes.status).toBe(200);

		const fileAtDirRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs' }),
		}, env);
		expect(fileAtDirRes.status).toBe(409);
	});

	test('file below an existing file path returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const parentRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs' }),
		}, env);
		expect(parentRes.status).toBe(200);

		const childRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs/readme.txt' }),
		}, env);
		expect(childRes.status).toBe(409);
	});
});

describe('POST /api/files/ls', () => {
	test('owner listing includes access key for files', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		await env.R2.put(fileId, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const res = await app.request('/api/files/ls', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', path: '' }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as { items: Array<{ name: string; fileId?: string }> };
		expect(body.items).toContainEqual(expect.objectContaining({ name: 'hello.txt', fileId }));
	});

	test('public listing only includes listed public files for anonymous users', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		const listedFileId = await createClosedFile({ token, bucketId, path: 'listed.txt', visibility: 'public', isListed: true });
		const unlistedFileId = await createClosedFile({ token, bucketId, path: 'unlisted.txt', visibility: 'public', isListed: false });
		await createClosedFile({ token, bucketId, path: 'private.txt', visibility: 'private', isListed: true });
		await createClosedFile({ token, bucketId, path: 'passphrase.txt', visibility: 'passphrase', isListed: true, passphrase: 'secret' });

		const publicRes = await app.request('/api/files/ls?bucketName=test_bucket&path=', {}, env);
		expect(publicRes.status).toBe(200);
		const publicBody = await publicRes.json() as { items: Array<{ name: string; fileId?: string }> };
		expect(publicBody.items).toContainEqual(expect.objectContaining({ name: 'listed.txt', fileId: listedFileId }));
		expect(publicBody.items).not.toContainEqual(expect.objectContaining({ name: 'unlisted.txt', fileId: unlistedFileId }));
		expect(publicBody.items.map(entry => entry.name)).not.toContain('private.txt');
		expect(publicBody.items.map(entry => entry.name)).not.toContain('passphrase.txt');

		const ownerRes = await app.request('/api/files/ls', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', path: '' }),
		}, env);
		expect(ownerRes.status).toBe(200);
		const ownerBody = await ownerRes.json() as { items: Array<{ name: string; fileId?: string; isListed?: boolean }> };
		expect(ownerBody.items).toContainEqual(expect.objectContaining({ name: 'unlisted.txt', fileId: unlistedFileId, isListed: false }));
	});

	test.each(['GET', 'POST'])('%s listing paginates files by descending ID', async (method) => {
		const { token, bucketId } = await setupUserAndBucket();
		const ids = [];
		for (const path of ['z.txt', 'a.txt', 'm.txt']) {
			ids.push(await createClosedFile({ token, bucketId, path }));
		}
		const actual: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < ids.length; page++) {
			const input = { bucketName: 'test_bucket', limit: 1, cursor };
			const response = method === 'POST'
				? await app.request('/api/files/ls', { method, headers: authHeaders(token), body: JSON.stringify(input) }, env)
				: await app.request(`/api/files/ls?bucketName=test_bucket&limit=1${cursor ? `&cursor=${cursor}` : ''}`, {}, env);
			expect(response.status).toBe(200);
			const body = await response.json() as { items: { fileId: string }[]; nextCursor: string | null; hasMore: boolean };
			actual.push(...body.items.map(entry => entry.fileId));
			expect(body.hasMore).toBe(page < ids.length - 1);
			cursor = body.nextCursor;
		}
		expect(actual).toEqual(ids.sort().reverse());
		expect(cursor).toBeNull();
	});

	test.each(['tar', 'targz'])('%s archive listing follows physical entry order', async (format) => {
		const { token, bucketId } = await setupUserAndBucket();
		const opened = await app.request('/api/files/create/open', {
			method: 'POST', headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await opened.json() as { fileId: string };
		const entries = [
			{ path: 'dir/a.txt', position: 2 },
			{ path: 'dir/z.txt', position: 0 },
			{ path: 'dir/m.txt', position: 1 },
		].map(({ path, position }) => format === 'tar'
			? { path, mimeType: 'text/plain', offset: 512 + position * 1024, size: 1 }
			: { path, mimeType: 'text/plain', aStart: position === 2 ? 512 : 0, aFirstEnd: position === 2 ? 1024 : 512,
							aFinalStart: position === 2 ? 512 : 0, aEnd: position === 2 ? 1024 : 512,
							rStartOffset: position === 1 ? 1024 : 512, rEndOffset: 0 });
		const indexed = await app.request(`/api/files/create/${format}-index`, {
			method: 'POST', headers: authHeaders(token), body: JSON.stringify({ fileId, files: entries }),
		}, env);
		expect(indexed.status).toBe(200);
		await env.R2.put(fileId, new Uint8Array(4096));
		const closed = await app.request('/api/files/create/close', {
			method: 'POST', headers: authHeaders(token), body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closed.status).toBe(200);
		for (const suffix of ['?list', '?list=dir/']) {
			const response = await app.request(`/d/${fileId}${suffix}`, {}, env);
			expect(response.status).toBe(200);
			const body = await response.json() as { path: string }[];
			expect(body.map(entry => entry.path)).toEqual(['dir/z.txt', 'dir/m.txt', 'dir/a.txt']);
		}
	});

	test('lists direct entries with cursor pagination', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'a/' }),
		}, env);
		await createClosedFile({ token, bucketId, path: 'a/nested.txt' });
		await createClosedFile({ token, bucketId, path: 'b/nested.txt' });
		await createClosedFile({ token, bucketId, path: 'c.txt' });

		const firstRes = await app.request('/api/files/ls', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', path: '', limit: 2 }),
		}, env);
		expect(firstRes.status).toBe(200);
		const first = await firstRes.json() as { items: Array<{ name: string; type: 'dir' | 'file' }>; nextCursor: string | null; hasMore: boolean };
		expect(first.items.map(entry => entry.name)).toEqual(['a', 'b']);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBeTypeOf('string');

		const secondRes = await app.request('/api/files/ls', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', path: '', limit: 2, cursor: first.nextCursor }),
		}, env);
		expect(secondRes.status).toBe(200);
		const second = await secondRes.json() as { items: Array<{ name: string; type: 'dir' | 'file' }>; nextCursor: string | null; hasMore: boolean };
		expect(second.items.map(entry => entry.name)).toEqual(['c.txt']);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeNull();
	});
});

describe('POST /api/files/create/targz-index', () => {
	test('registers targz index entries', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{
						path: 'file1.txt',
						mimeType: 'text/plain',
						aStart: 0,
						aFirstEnd: 512,
						aFinalStart: 512,
						aEnd: 512,
						rStartOffset: 0,
						rEndOffset: 0,
					},
				],
			}),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test('invalid targz index path returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{
					path: 'bad?.txt',
					mimeType: 'text/plain',
					aStart: 0,
					aFirstEnd: 512,
					aFinalStart: 512,
					aEnd: 512,
					rStartOffset: 0,
					rEndOffset: 0,
				}],
			}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('targz index outside uploaded object returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar.gz' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		await env.R2.put(fileId, new Uint8Array(8));

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{
					path: 'file.txt',
					mimeType: 'text/plain',
					aStart: 0,
					aFirstEnd: 4,
					aFinalStart: 4,
					aEnd: 9,
					rStartOffset: 0,
					rEndOffset: 0,
				}],
			}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('nonexistent fileId returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/targz-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId: 'nonexistent',
				files: [],
			}),
		}, env);
		expect(res.status).toBe(404);
	});
});

describe('POST /api/files/create/tar-index', () => {
	test('tar index outside uploaded object returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		await env.R2.put(fileId, new Uint8Array(8));

		const res = await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'file.txt', mimeType: 'text/plain', offset: 4, size: 5 }],
			}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('invalid tar index path returns 400', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{
					path: 'bad:name.txt',
					mimeType: 'text/plain',
					offset: 0,
					size: 1,
				}],
			}),
		}, env);
		expect(res.status).toBe(400);
	});

	test('tar index path that conflicts with a virtual directory returns 409', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'archive.tar' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [
					{ path: 'dir', mimeType: 'text/plain', offset: 0, size: 1 },
					{ path: 'dir/file.txt', mimeType: 'text/plain', offset: 1, size: 1 },
				],
			}),
		}, env);
		expect(res.status).toBe(409);
	});
});

describe('POST /api/files/create/close', () => {
	test('closes file after R2 upload', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Simulate upload to R2
		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(200);
		const body = await closeRes.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	test('returns 400 if R2 object not yet uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'missing.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(400);
	});

	test('closes private file with passphrase', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'mypassphrase' }),
		}, env);
		expect(closeRes.status).toBe(200);
	});

	test('rejects mismatched content type when the setting is enabled', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'not-text.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(400);
		const body = await closeRes.json() as { error: string; message: string };
		expect(body).toEqual({
			error: 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION',
			message: 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION',
		});
	});

	test('stores svg xml content as image/svg+xml', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'vector.svg' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(200);

		const metaRes = await app.request('/api/files/meta?bucketName=test_bucket&path=vector.svg', {
			method: 'GET',
			headers: authHeaders(token),
		}, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as {
			mimeType: string;
			extensionMimeType: string;
			hasMimeTypeMismatch: boolean;
		};
		expect(meta.mimeType).toBe('image/svg+xml');
		expect(meta.extensionMimeType).toBe('image/svg+xml');
		expect(meta.hasMimeTypeMismatch).toBe(false);
	});

	test('reports mismatched executable content in file metadata', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'not-an-image.png' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(200);

		const metaRes = await app.request('/api/files/meta?bucketName=test_bucket&path=not-an-image.png', {
			method: 'GET',
			headers: authHeaders(token),
		}, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as {
			mimeType: string;
			extensionMimeType: string;
			hasMimeTypeMismatch: boolean;
			hasExecutableContent: boolean;
		};
		expect(meta.mimeType).toBe('application/wasm');
		expect(meta.extensionMimeType).toBe('image/png');
		expect(meta.hasMimeTypeMismatch).toBe(true);
		expect(meta.hasExecutableContent).toBe(true);
	});

	test('rejects unknown binary content with a text extension when the setting is enabled', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'binary.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(400);
	});

	test('rejects executable signatures even when magic-bytes does not detect a mime type', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'program.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0x4d, 0x5a, 0x90, 0x00]));

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(400);
	});

	test('rejects jpeg content with a png extension when the setting is enabled', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'photo.png' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));

		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(400);
	});
});

describe('POST /api/files/create/status', () => {
	test('returns partCount 0 and offset 0 before any parts are uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'upload.bin' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.partCount).toBe(0);
		expect(body.offset).toBe(0);
	});

	test('returns correct partCount and offset after a part is uploaded', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		// デフォルトのpartSizeは32MiB
		const DEFAULT_PART_SIZE = 32 * 1024 * 1024;

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'upload.bin' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		// Upload one small part (server counts parts, not bytes)
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		await app.request(`/upload/${fileId}/resume`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/offset+octet-stream',
				'Upload-Offset': '0',
				'Content-Length': String(data.length),
			},
			body: data.buffer,
		}, env);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.partCount).toBe(1);
		expect(body.offset).toBe(DEFAULT_PART_SIZE);
	});

	test('nonexistent fileId returns 404', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId: 'nonexistent' }),
		}, env);
		expect(res.status).toBe(404);
	});

	test('unauthenticated access returns 401', async () => {
		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileId: 'some-id' }),
		}, env);
		expect(res.status).toBe(401);
	});

	test('missing fileId returns 400', async () => {
		const { data } = await signup('user1');
		const token = String(data.token);

		const res = await app.request('/api/files/create/status', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({}),
		}, env);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/files/update', () => {
	test('cannot make a public file private', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'public.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/public.txt`, 'Public Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const updateRes = await app.request('/api/files/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', filePath: 'public.txt', visibility: 'passphrase', passphrase: 'secret' }),
		}, env);
		expect(updateRes.status).toBe(400);
		const body = await updateRes.json() as { error: string; message: string };
		expect(body).toEqual({
			error: 'PUBLIC_FILES_CANNOT_CHANGE_VISIBILITY',
			message: 'PUBLIC_FILES_CANNOT_CHANGE_VISIBILITY',
		});

		const metaRes = await app.request('/api/files/meta?bucketName=test_bucket&path=public.txt', {}, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as { visibility: string };
		expect(meta.visibility).toBe('public');
	});

	test('can make a private file public', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'private.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/private.txt`, 'Private Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'secret' }),
		}, env);

		const updateRes = await app.request('/api/files/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', filePath: 'private.txt', visibility: 'public' }),
		}, env);
		expect(updateRes.status).toBe(200);

		const downloadRes = await app.request(`/d/${fileId}`, {}, env);
		expect(downloadRes.status).toBe(200);
		expect(await downloadRes.text()).toBe('Private Content');
	});

	test('can update listed setting', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await createClosedFile({ token, bucketId, path: 'listed-setting.txt', visibility: 'public' });

		const updateRes = await app.request('/api/files/update', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', filePath: 'listed-setting.txt', visibility: 'public', isListed: false }),
		}, env);
		expect(updateRes.status).toBe(200);

		const publicRes = await app.request('/api/files/ls?bucketName=test_bucket&path=', {}, env);
		expect(publicRes.status).toBe(200);
		const publicBody = await publicRes.json() as { items: Array<{ name: string }> };
		expect(publicBody.items.map(entry => entry.name)).not.toContain('listed-setting.txt');

		const metaRes = await app.request('/api/files/meta?bucketName=test_bucket&path=listed-setting.txt', {
			headers: authHeaders(token),
		}, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as { isListed?: boolean };
		expect(meta.isListed).toBe(false);
	});

	test('can update listed setting for a directory target', async () => {
		const { data } = await signup('directorylistinguser');
		const token = String(data.token);
		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'directory_listing_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };
		await app.request('/api/directories/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'docs/' }),
		}, env);
		await createClosedFile({ token, bucketId, path: 'docs/a.txt', visibility: 'public' });
		await createClosedFile({ token, bucketId, path: 'docs/nested/b.txt', visibility: 'public' });
		await createClosedFile({ token, bucketId, path: 'outside.txt', visibility: 'public' });

		const updateRes = await app.request('/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				bucketId,
				isListed: false,
				targets: [{ type: 'directory', path: 'docs/' }],
			}),
		}, env);
		expect(updateRes.status).toBe(200);
		const updateBody = await updateRes.json() as { updatedCount: number };
		expect(updateBody.updatedCount).toBe(1);

		const rootRes = await app.request('/api/files/ls?bucketName=directory_listing_bucket&path=', {}, env);
		expect(rootRes.status).toBe(200);
		const rootBody = await rootRes.json() as { items: Array<{ name: string }> };
		expect(rootBody.items.map(entry => entry.name)).toEqual(['outside.txt']);

		const ownerRes = await app.request('/api/files/ls', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'directory_listing_bucket', path: 'docs/' }),
		}, env);
		expect(ownerRes.status).toBe(200);
		const ownerBody = await ownerRes.json() as { items: Array<{ name: string; isListed?: boolean }> };
		expect(ownerBody.items).toContainEqual(expect.objectContaining({ name: 'a.txt', isListed: false }));
		expect(ownerBody.items).toContainEqual(expect.objectContaining({ name: 'nested' }));
	});

	test('cannot update listed setting in another user bucket', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await createClosedFile({ token, bucketId, path: 'owner.txt', visibility: 'public' });
		const { data } = await signup('listingattacker');
		const attackerToken = String(data.token);

		const updateRes = await app.request('/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(attackerToken),
			body: JSON.stringify({
				bucketId,
				isListed: false,
				targets: [{ type: 'file', path: 'owner.txt' }],
			}),
		}, env);
		expect(updateRes.status).toBe(403);
	});

	test('update listed setting respects excludePaths', async () => {
		const { data } = await signup('listingexcludeuser');
		const token = String(data.token);
		const bucketRes = await app.request('/api/buckets/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'listing_exclude_bucket' }),
		}, env);
		const { bucketId } = await bucketRes.json() as { bucketId: string };
		for (const path of ['docs/', 'docs/keep-dir/', 'docs/hide-dir/']) {
			await app.request('/api/directories/create', {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ bucketId, path }),
			}, env);
		}
		await createClosedFile({ token, bucketId, path: 'docs/a.txt', visibility: 'public' });
		await createClosedFile({ token, bucketId, path: 'docs/keep.txt', visibility: 'public' });
		await createClosedFile({ token, bucketId, path: 'docs/keep-dir/b.txt', visibility: 'public' });
		await createClosedFile({ token, bucketId, path: 'docs/hide-dir/c.txt', visibility: 'public' });

		const updateRes = await app.request('/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				bucketId,
				isListed: false,
				targets: [{ type: 'directory', path: 'docs/', excludePaths: ['docs/', 'docs/keep-dir/'] }],
			}),
		}, env);
		expect(updateRes.status).toBe(200);
		const updateBody = await updateRes.json() as { updatedCount: number };
		expect(updateBody.updatedCount).toBe(1);

		const publicRes = await app.request('/api/files/ls?bucketName=listing_exclude_bucket&path=docs/', {}, env);
		expect(publicRes.status).toBe(200);
		const publicBody = await publicRes.json() as { items: Array<{ name: string }> };
		expect(publicBody.items.map(entry => entry.name)).toEqual(['keep-dir']);
	});

	test('update listed setting returns 404 when no files match', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const updateRes = await app.request('/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				bucketId,
				isListed: false,
				targets: [{ type: 'file', path: 'missing.txt' }],
			}),
		}, env);
		expect(updateRes.status).toBe(404);
	});
});

describe('GET /api/files/meta', () => {
	test('returns fileId for a private file when a valid file access token is provided', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'secret.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(`${bucketId}/secret.txt`, 'Secret Content');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'passphrase', passphrase: 'secret' }),
		}, env);

		const tokenRes = await app.request('/api/file-tokens/create', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketName: 'test_bucket', filePath: 'secret.txt', expiresIn: 3600 }),
		}, env);
		expect(tokenRes.status).toBe(200);
		const { token: fileToken } = await tokenRes.json() as { token: string };

		const metaWithoutTokenRes = await app.request('/api/files/meta?bucketName=test_bucket&path=secret.txt', {}, env);
		expect(metaWithoutTokenRes.status).toBe(200);
		const metaWithoutToken = await metaWithoutTokenRes.json() as { fileId?: string };
		expect(metaWithoutToken.fileId).toBeUndefined();

		const metaRes = await app.request(`/api/files/meta?bucketName=test_bucket&path=secret.txt&token=${encodeURIComponent(fileToken)}`, {}, env);
		expect(metaRes.status).toBe(200);
		const meta = await metaRes.json() as { fileId?: string; visibility: string };
		expect(meta.fileId).toBe(fileId);
		expect(meta.visibility).toBe('passphrase');
	});
});

describe('POST /api/files/move', () => {
	test('rejects rename that creates a content type mismatch when the setting is enabled', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (\'reject_mismatched_file_type\', \'true\')').run();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'image.png' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };

		await env.R2.put(fileId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const closeRes = await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);
		expect(closeRes.status).toBe(200);

		const moveRes = await app.request('/api/files/move', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				type: 'file',
				sourceBucketId: bucketId,
				sourcePath: 'image.png',
				targetBucketId: bucketId,
				targetPath: 'image.txt',
			}),
		}, env);
		expect(moveRes.status).toBe(400);
		const body = await moveRes.json() as { error: string; message: string };
		expect(body).toEqual({
			error: 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION',
			message: 'FILE_CONTENT_TYPE_DOES_NOT_MATCH_FILE_EXTENSION',
		});
	});
});

describe('POST /api/files/delete', () => {
	test('owner can delete own file', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId: _ } = await openRes.json() as { fileId: string };
		void _;

		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId: _, visibility: 'public' }),
		}, env);

		const deleteRes = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(deleteRes.status).toBe(200);
	});

	test('other user cannot delete another user\'s file', async () => {
		const { token, bucketId } = await setupUserAndBucket();
		const { data: d2 } = await signup('user2');
		const t2 = String(d2.token);

		const openRes = await app.request('/api/files/create/open', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		const { fileId } = await openRes.json() as { fileId: string };
		void fileId;

		await env.R2.put(`${bucketId}/hello.txt`, 'Hello World');
		await app.request('/api/files/create/close', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ fileId, visibility: 'public' }),
		}, env);

		const deleteRes = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(t2),
			body: JSON.stringify({ bucketId, path: 'hello.txt' }),
		}, env);
		expect(deleteRes.status).toBe(403);
	});

	test('nonexistent file returns 404', async () => {
		const { token, bucketId } = await setupUserAndBucket();

		const res = await app.request('/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'nonexistent.txt' }),
		}, env);
		expect(res.status).toBe(404);
	});
});
