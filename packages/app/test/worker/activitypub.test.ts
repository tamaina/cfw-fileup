import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { env, app, setupDb, clearDb, signup, authHeaders, createAdminUser } from './helpers';

beforeAll(async () => {
	await setupDb();
});

beforeEach(async () => {
	await clearDb();
});

async function setupPublicFile(path = 'hello.txt', options: { isListed?: boolean; visibility?: 'public' | 'private' | 'passphrase'; passphrase?: string } = {}) {
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
		body: JSON.stringify({ fileId, visibility: options.visibility ?? 'public', isListed: options.isListed, passphrase: options.passphrase }),
	}, env);

	return { token, bucketId, fileId };
}

function envWithAssets(): Env {
	return {
		...env,
		ASSETS: {
			fetch: () => new Response('<!doctype html><html><head><title>CFW FileUp</title></head><body><div id="app"></div></body></html>', {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			}),
		},
	};
}

const activityJsonRequest = {
	headers: { Accept: 'application/activity+json' },
};

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

		const res = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		expect(res.status).toBe(200);
		const note = await res.json() as {
			id: string;
			type: string;
			attributedTo: string;
			attachment: Array<{ type: string; name: string; url: string }>;
		};
		expect(note.id).toBe(`https://example.test/a/files/${fileId}`);
		expect(note.type).toBe('Note');
		expect(note.attributedTo).toBe(`https://example.test/a/buckets/${bucketId}`);
		expect(note).not.toHaveProperty('name');
		expect(note).not.toHaveProperty('content');
		expect(note).not.toHaveProperty('url');
		expect(note.attachment[0]).toEqual(expect.objectContaining({
			type: 'Document',
			name: 'hello.txt',
			url: `https://example.test/d/${fileId}`,
		}));
	});

	test('redirects browser requests for ActivityPub file notes to the file page', async () => {
		const { fileId } = await setupPublicFile('dir/hello #1 & 2.txt');

		const res = await app.request(`https://example.test/a/files/${fileId}`, {
			headers: { Accept: 'text/html' },
			redirect: 'manual',
		}, env);
		expect(res.status).toBe(302);
		expect(res.headers.get('Vary')).toBe('Accept');
		expect(res.headers.get('Location')).toBe('https://example.test/v/ap_bucket/dir/hello%20%231%20%26%202.txt');
	});

	test('does not serve an unlisted public file as Note', async () => {
		const { fileId } = await setupPublicFile('hidden.txt', { isListed: false });

		const res = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		expect(res.status).toBe(404);
	});

	test('adds ActivityPub alternate tags to public listed file pages', async () => {
		const { fileId } = await setupPublicFile('dir/hello #1 & 2.txt');

		const res = await app.request('https://example.test/v/ap_bucket/dir/hello%20%231%20%26%202.txt', {}, envWithAssets());
		expect(res.status).toBe(200);
		const href = `https://example.test/a/files/${fileId}`;
		expect(res.headers.get('Link')).toContain(`<${href}>; rel="alternate"; type="application/activity+json"`);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=10800');
		expect(await res.text()).toContain(`<link rel="alternate" type="application/activity+json" href="${href}">`);
	});

	test('serves /v file pages with correct cache headers', async () => {
		const { fileId } = await setupPublicFile('cached-view.txt');
		const requestUrl = 'https://example.test/v/ap_bucket/cached-view.txt';

		const res = await app.request(requestUrl, {}, envWithAssets());
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=10800');
		expect(await res.text()).toContain(`/a/files/${fileId}`);
	});

	test('serves /v file pages regardless of query strings', async () => {
		const { fileId } = await setupPublicFile('query-cache.txt');
		const requestUrl = 'https://example.test/v/ap_bucket/query-cache.txt';

		const firstRes = await app.request(`${requestUrl}?utm_source=first`, {}, envWithAssets());
		expect(firstRes.status).toBe(200);
		expect(await firstRes.text()).toContain(`/a/files/${fileId}`);

		const secondRes = await app.request(`${requestUrl}?utm_source=second`, {}, envWithAssets());
		expect(secondRes.status).toBe(200);
		expect(await secondRes.text()).toContain(`/a/files/${fileId}`);
	});

	test('serves /v file pages for different origins', async () => {
		const { fileId } = await setupPublicFile('origin-cache.txt');
		const path = '/v/ap_bucket/origin-cache.txt';

		const firstRes = await app.request(`https://example.test${path}`, {}, envWithAssets());
		expect(await firstRes.text()).toContain(`https://example.test/a/files/${fileId}`);

		const otherOriginRes = await app.request(`https://alt.example.test${path}`, {}, envWithAssets());
		expect(await otherOriginRes.text()).toContain(`https://alt.example.test/a/files/${fileId}`);
	});

	test('serves ActivityPub file notes with correct cache headers', async () => {
		const { fileId } = await setupPublicFile('cached-note.txt');

		const res = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
		const note = await res.json() as Record<string, unknown>;
		expect(note).not.toHaveProperty('url');
	});

	test('keeps ActivityPub JSON separate from browser redirects via Vary', async () => {
		const { fileId } = await setupPublicFile('cache-variant.txt');
		const noteUrl = `https://example.test/a/files/${fileId}`;

		const jsonRes = await app.request(noteUrl, activityJsonRequest, env);
		expect(jsonRes.status).toBe(200);
		expect(jsonRes.headers.get('Vary')).toBe('Accept');

		const browserRes = await app.request(noteUrl, {
			headers: { Accept: 'text/html' },
			redirect: 'manual',
		}, env);
		expect(browserRes.status).toBe(302);
		expect(browserRes.headers.get('Vary')).toBe('Accept');
		expect(browserRes.headers.get('Location')).toBe('https://example.test/v/ap_bucket/cache-variant.txt');
	});

	test('purges /v and /a file resolve caches when a file is deleted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('delete-cached.txt');

		const viewRes = await app.request('https://example.test/v/ap_bucket/delete-cached.txt', {}, envWithAssets());
		await viewRes.text();
		const noteRes = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		await noteRes.text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'delete-cached.txt' }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const afterDeleteViewRes = await app.request('https://example.test/v/ap_bucket/delete-cached.txt', {}, envWithAssets());
		expect(afterDeleteViewRes.status).toBe(200);
		expect(afterDeleteViewRes.headers.get('Link')).toBeNull();
		expect(await afterDeleteViewRes.text()).not.toContain(`/a/files/${fileId}`);

		const afterDeleteNoteRes = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		expect(afterDeleteNoteRes.status).toBe(404);
	});

	test('purges /v and /a file resolve caches when a public file is unlisted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('unlist-cached.txt');

		await (await app.request('https://example.test/v/ap_bucket/unlist-cached.txt', {}, envWithAssets())).text();
		await (await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const updateRes = await app.request('https://example.test/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, isListed: false, targets: [{ type: 'file', path: 'unlist-cached.txt' }] }),
		}, env);
		expect(updateRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request('https://example.test/v/ap_bucket/unlist-cached.txt', {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		expect(await viewRes.text()).not.toContain(`/a/files/${fileId}`);

		const noteRes = await app.request(`https://example.test/a/files/${fileId}`, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('purges query-normalized resolve caches when a public file is unlisted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('unlist-query-cached.txt');
		const viewUrl = 'https://example.test/v/ap_bucket/unlist-query-cached.txt';

		await (await app.request(`${viewUrl}?preview=1`, {}, envWithAssets())).text();
		await (await app.request(`https://example.test/a/files/${fileId}?preview=1`, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const updateRes = await app.request('https://example.test/api/files/update-listing', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, isListed: false, targets: [{ type: 'file', path: 'unlist-query-cached.txt' }] }),
		}, env);
		expect(updateRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request(`${viewUrl}?preview=2`, {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		expect(await viewRes.text()).not.toContain(`/a/files/${fileId}`);

		const noteRes = await app.request(`https://example.test/a/files/${fileId}?preview=2`, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('purges old and new resolve cache paths when a file is renamed', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('before-rename.txt');
		const oldUrl = 'https://example.test/v/ap_bucket/before-rename.txt';
		const newUrl = 'https://example.test/v/ap_bucket/after-rename.txt';

		await (await app.request(oldUrl, {}, envWithAssets())).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const moveRes = await app.request('https://example.test/api/files/move', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				type: 'file',
				sourceBucketId: bucketId,
				sourcePath: 'before-rename.txt',
				targetBucketId: bucketId,
				targetPath: 'after-rename.txt',
			}),
		}, env);
		expect(moveRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const oldRes = await app.request(oldUrl, {}, envWithAssets());
		expect(oldRes.headers.get('Link')).toBeNull();
		await oldRes.text();

		const newRes = await app.request(newUrl, {}, envWithAssets());
		expect(newRes.headers.get('Link')).toContain(`/a/files/${fileId}`);
		expect(await newRes.text()).toContain(`/a/files/${fileId}`);
	});

	test('purges bucket actor resolve cache when a bucket is deleted', async () => {
		const { token, bucketId } = await setupPublicFile('bucket-delete.txt');

		const firstRes = await app.request(`https://example.test/a/buckets/${bucketId}`, {}, env);
		expect(firstRes.status).toBe(200);
		await firstRes.text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const afterDeleteRes = await app.request(`https://example.test/a/buckets/${bucketId}`, {}, env);
		expect(afterDeleteRes.status).toBe(404);
	});

	test('does not add ActivityPub alternate tags to unlisted file pages', async () => {
		await setupPublicFile('hidden.txt', { isListed: false });

		const res = await app.request('https://example.test/v/ap_bucket/hidden.txt', {}, envWithAssets());
		expect(res.status).toBe(200);
		expect(res.headers.get('Link')).toBeNull();
		expect(await res.text()).not.toContain('application/activity+json');
	});

	test('does not serve listed non-public files as Note', async () => {
		const { fileId: privateFileId } = await setupPublicFile('private.txt', { visibility: 'private', isListed: true });
		const { fileId: passphraseFileId } = await setupPublicFile('passphrase.txt', { visibility: 'passphrase', isListed: true, passphrase: 'secret' });

		const privateRes = await app.request(`https://example.test/a/files/${privateFileId}`, activityJsonRequest, env);
		expect(privateRes.status).toBe(404);
		const passphraseRes = await app.request(`https://example.test/a/files/${passphraseFileId}`, activityJsonRequest, env);
		expect(passphraseRes.status).toBe(404);
	});

	test('encodes file paths in public note browser redirects', async () => {
		const { fileId } = await setupPublicFile('dir/hello #1 & 2.txt');

		const res = await app.request(`https://example.test/a/files/${fileId}`, {
			headers: { Accept: 'text/html' },
			redirect: 'manual',
		}, env);
		expect(res.status).toBe(302);
		expect(res.headers.get('Vary')).toBe('Accept');
		expect(res.headers.get('Location')).toBe('https://example.test/v/ap_bucket/dir/hello%20%231%20%26%202.txt');
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
		const res = await app.request(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`, activityJsonRequest, env);
		expect(res.status).toBe(200);
		const note = await res.json() as { id: string; attachment: Array<{ name: string; url: string }> };
		expect(note.id).toBe(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`);
		expect(note).not.toHaveProperty('name');
		expect(note).not.toHaveProperty('content');
		expect(note).not.toHaveProperty('url');
		expect(note.attachment[0]).toEqual(expect.objectContaining({
			name: 'entry.txt',
			url: `https://example.test/d/${fileId}/%3Aentries/${encodedEntryPath}`,
		}));
	});

	test('redirects browser requests for ActivityPub archive entry notes to the entry page', async () => {
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
		const res = await app.request(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`, {
			headers: { Accept: 'text/html' },
			redirect: 'manual',
		}, env);
		expect(res.status).toBe(302);
		expect(res.headers.get('Vary')).toBe('Accept');
		expect(res.headers.get('Location')).toBe(`https://example.test/v/ap_bucket/archive.tar/%3Aentries/${encodedEntryPath}`);
	});

	test('adds ActivityPub alternate tags to public archive entry pages', async () => {
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
		const href = `https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`;
		const res = await app.request(`https://example.test/v/ap_bucket/archive.tar/%3Aentries/${encodedEntryPath}`, {}, envWithAssets());
		expect(res.status).toBe(200);
		expect(res.headers.get('Link')).toContain(`<${href}>; rel="alternate"; type="application/activity+json"`);
		expect(await res.text()).toContain(`<link rel="alternate" type="application/activity+json" href="${href}">`);
	});

	test('purges archive entry resolve caches when the archive is deleted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('delete-archive.tar');

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const viewUrl = `https://example.test/v/ap_bucket/delete-archive.tar/%3Aentries/${encodedEntryPath}`;
		const noteUrl = `https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`;
		await (await app.request(viewUrl, {}, envWithAssets())).text();
		await (await app.request(noteUrl, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/files/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'delete-archive.tar' }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request(viewUrl, {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		await viewRes.text();

		const noteRes = await app.request(noteUrl, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('purges archive entry resolve caches when a directory is deleted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('dir/delete-archive.tar');

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const viewUrl = `https://example.test/v/ap_bucket/dir/delete-archive.tar/%3Aentries/${encodedEntryPath}`;
		const noteUrl = `https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`;
		await (await app.request(viewUrl, {}, envWithAssets())).text();
		await (await app.request(noteUrl, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/directories/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId, path: 'dir/' }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request(viewUrl, {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		await viewRes.text();

		const noteRes = await app.request(noteUrl, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('purges archive entry resolve caches when a bucket is deleted', async () => {
		const { token, bucketId, fileId } = await setupPublicFile('bucket-delete-archive.tar');

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const viewUrl = `https://example.test/v/ap_bucket/bucket-delete-archive.tar/%3Aentries/${encodedEntryPath}`;
		const noteUrl = `https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`;
		await (await app.request(viewUrl, {}, envWithAssets())).text();
		await (await app.request(noteUrl, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/buckets/delete', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({ bucketId }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request(viewUrl, {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		await viewRes.text();

		const noteRes = await app.request(noteUrl, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('purges archive entry resolve caches when an admin deletes an archive', async () => {
		const { token: adminToken } = await createAdminUser();
		const { token, fileId } = await setupPublicFile('admin-delete-archive.tar');

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const viewUrl = `https://example.test/v/ap_bucket/admin-delete-archive.tar/%3Aentries/${encodedEntryPath}`;
		const noteUrl = `https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`;
		await (await app.request(viewUrl, {}, envWithAssets())).text();
		await (await app.request(noteUrl, activityJsonRequest, env)).text();
		await new Promise(resolve => setTimeout(resolve, 0));

		const deleteRes = await app.request('https://example.test/api/admin/delete-file', {
			method: 'POST',
			headers: authHeaders(adminToken),
			body: JSON.stringify({ fileId }),
		}, env);
		expect(deleteRes.status).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 0));

		const viewRes = await app.request(viewUrl, {}, envWithAssets());
		expect(viewRes.headers.get('Link')).toBeNull();
		await viewRes.text();

		const noteRes = await app.request(noteUrl, activityJsonRequest, env);
		expect(noteRes.status).toBe(404);
	});

	test('does not serve entries from an unlisted public archive', async () => {
		const { token, fileId } = await setupPublicFile('hidden-archive.tar', { isListed: false });

		await app.request('/api/files/create/tar-index', {
			method: 'POST',
			headers: authHeaders(token),
			body: JSON.stringify({
				fileId,
				files: [{ path: 'dir/entry.txt', mimeType: 'text/plain', offset: 0, size: 5 }],
			}),
		}, env);

		const encodedEntryPath = encodeURIComponent('dir/entry.txt');
		const res = await app.request(`https://example.test/a/files/${fileId}/%3Aentries/${encodedEntryPath}`, activityJsonRequest, env);
		expect(res.status).toBe(404);
	});
});
