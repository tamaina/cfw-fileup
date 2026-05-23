import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupPublicFile(path = 'hello.txt') {
	const { data } = await signup('user1');
	const token = String(data.token);

	const bucketRes = await app.request('/api/buckets/create', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketName: 'ap_bucket' }),
	}, env);
	const { bucketId } = await bucketRes.json() as { bucketId: string };

	const openRes = await app.request('/api/files/create/open', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ bucketId, path }),
	}, env);
	const { fileId } = await openRes.json() as { fileId: string };

	await env.R2.put(fileId, 'Hello ActivityPub');
	await app.request('/api/files/create/close', {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ fileId, visibility: 'public' }),
	}, env);

	return { token, bucketId, fileId };
}

describe('ActivityPub routes', () => {
	test('serves a bucket actor', async () => {
		const { bucketId } = await setupPublicFile();

		const res = await app.request(`https://example.test/a/buckets/${bucketId}`, {}, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/activity+json');
		const actor = await res.json() as { id: string; type: string; preferredUsername: string; inbox: string; outbox: string };
		expect(actor.id).toBe(`https://example.test/a/buckets/${bucketId}`);
		expect(actor.type).toBe('Service');
		expect(actor.preferredUsername).toBe('ap_bucket');
		expect(actor.inbox).toBe(`https://example.test/a/buckets/${bucketId}/inbox`);
		expect(actor.outbox).toBe(`https://example.test/a/buckets/${bucketId}/outbox`);
	});

	test('does not serve collections or inbox for unknown buckets', async () => {
		const outboxRes = await app.request('https://example.test/a/buckets/unknown/outbox', {}, env);
		expect(outboxRes.status).toBe(404);

		const followersRes = await app.request('https://example.test/a/buckets/unknown/followers', {}, env);
		expect(followersRes.status).toBe(404);

		const inboxRes = await app.request('https://example.test/a/buckets/unknown/inbox', { method: 'POST' }, env);
		expect(inboxRes.status).toBe(404);
	});

	test('serves a public file as Note with attachment', async () => {
		const { bucketId, fileId } = await setupPublicFile();

		const res = await app.request(`https://example.test/a/files/${fileId}`, {}, env);
		expect(res.status).toBe(200);
		const note = await res.json() as {
			id: string;
			type: string;
			attributedTo: string;
			url: string;
			attachment: Array<{ type: string; name: string; url: string }>;
		};
		expect(note.id).toBe(`https://example.test/a/files/${fileId}`);
		expect(note.type).toBe('Note');
		expect(note.attributedTo).toBe(`https://example.test/a/buckets/${bucketId}`);
		expect(note.url).toBe('https://example.test/v/ap_bucket/hello.txt');
		expect(note.attachment[0]).toEqual(expect.objectContaining({
			type: 'Document',
			name: 'hello.txt',
			url: `https://example.test/d/${fileId}`,
		}));
	});

	test('encodes file paths in public Note URLs', async () => {
		const { fileId } = await setupPublicFile('dir/hello #1.txt');

		const res = await app.request(`https://example.test/a/files/${fileId}`, {}, env);
		expect(res.status).toBe(200);
		const note = await res.json() as { url: string };
		expect(note.url).toBe('https://example.test/v/ap_bucket/dir/hello%20%231.txt');
	});

	test('serves a public tar entry as its own Note', async () => {
		const { token, fileId } = await setupPublicFile('archive.tar');

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const res = await app.request(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`, {}, env);
		expect(res.status).toBe(200);
		const note = await res.json() as { id: string; url: string; attachment: Array<{ name: string; url: string }> };
		expect(note.id).toBe(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`);
		expect(note.url).toBe(`https://example.test/v/ap_bucket/archive.tar/%3Aentries/${encodedEntryPath}`);
		expect(note.attachment[0]).toEqual(expect.objectContaining({
			name: 'entry.txt',
			url: `https://example.test/d/${fileId}/%3Aentries/${encodedEntryPath}`,
		}));
	});
});
