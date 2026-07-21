/**
 * IndexedDB-backed store for client-side E2E encryption keys.
 *
 * Keys are stored per fileId as multibase strings (see shared/encryption.ts).
 * The server never sees these keys; they only live in the browser.
 */

const DB_NAME = 'cfw-fileup-encryption-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

export interface KeyRecord {
	fileId: string;
	keyMultibase: string;
	createdAt: number;
	/** ファイルの保存先バケット名（閲覧ページへのリンクに使う。古いレコードには無い場合がある） */
	bucketName?: string;
	/** ファイルパス（閲覧ページへのリンクに使う。古いレコードには無い場合がある） */
	path?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'fileId' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return dbPromise;
}

export interface SaveEncryptionKeyLocation {
	bucketName?: string;
	path?: string;
}

export async function saveEncryptionKey(fileId: string, keyMultibase: string, location?: SaveEncryptionKeyLocation): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);
		const writeRecord = (previous?: KeyRecord) => {
			const record: KeyRecord = {
				fileId,
				keyMultibase,
				createdAt: previous?.createdAt ?? Date.now(),
				// 位置情報が渡されなかった場合は既存レコードの値を維持する
				bucketName: location?.bucketName ?? previous?.bucketName,
				path: location?.path ?? previous?.path,
			};
			store.put(record);
		};
		// 既存レコードがあれば createdAt と位置情報を引き継ぐ
		const getRequest = store.get(fileId);
		getRequest.onsuccess = () => writeRecord(getRequest.result as KeyRecord | undefined);
		getRequest.onerror = () => writeRecord();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getEncryptionKey(fileId: string): Promise<string | null> {
	const db = await openDb();
	return await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readonly');
		const request = tx.objectStore(STORE_NAME).get(fileId);
		request.onsuccess = () => {
			const record = request.result as KeyRecord | undefined;
			resolve(record?.keyMultibase ?? null);
		};
		request.onerror = () => reject(request.error);
	});
}

/**
 * bucketName + path で暗号化キーを検索する。
 * fileId が未取得の場合（合言葉ファイルでトークンなし等）のフォールバック。
 */
export async function getEncryptionKeyByLocation(bucketName: string, path: string): Promise<string | null> {
	const db = await openDb();
	return await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readonly');
		const store = tx.objectStore(STORE_NAME);
		const request = store.getAll();
		request.onsuccess = () => {
			const records = request.result as KeyRecord[];
			const match = records.find(r => r.bucketName === bucketName && r.path === path);
			resolve(match?.keyMultibase ?? null);
		};
		request.onerror = () => reject(request.error);
	});
}

export async function deleteEncryptionKey(fileId: string): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).delete(fileId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function clearAllEncryptionKeys(): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** List all stored encryption keys (for the security settings page). */
export async function listEncryptionKeys(): Promise<KeyRecord[]> {
	const db = await openDb();
	return await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readonly');
		const request = tx.objectStore(STORE_NAME).getAll();
		request.onsuccess = () => resolve(request.result as KeyRecord[]);
		request.onerror = () => reject(request.error);
	});
}

/**
 * インポート用のJSON形式。
 * エクスポート時にこの形式で出力し、インポート時にこの形式を受け付ける。
 */
export interface EncryptionKeyExport {
	version: 1;
	app: 'cfw-fileup';
	exportedAt: string;
	keys: KeyRecord[];
}

/** 現在の全キーをエクスポート用オブジェクトとして返す。 */
export async function exportEncryptionKeys(): Promise<EncryptionKeyExport> {
	const keys = await listEncryptionKeys();
	return {
		version: 1,
		app: 'cfw-fileup',
		exportedAt: new Date().toISOString(),
		keys,
	};
}

export interface ImportEncryptionKeysResult {
	imported: number;
	skipped: number;
}

/**
 * エクスポートされたJSONからキーをインポートする。
 * 既に同じ fileId が存在する場合はスキップする（上書きしない）。
 */
export async function importEncryptionKeys(data: EncryptionKeyExport): Promise<ImportEncryptionKeysResult> {
	if (data.version !== 1 || data.app !== 'cfw-fileup' || !Array.isArray(data.keys)) {
		throw new Error('無効なエクスポートファイルです');
	}

	const db = await openDb();
	let imported = 0;
	let skipped = 0;

	for (const key of data.keys) {
		if (!key.fileId || !key.keyMultibase) {
			skipped++;
			continue;
		}

		const exists = await new Promise<boolean>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const request = tx.objectStore(STORE_NAME).get(key.fileId);
			request.onsuccess = () => resolve(request.result != null);
			request.onerror = () => reject(request.error);
		});

		if (exists) {
			skipped++;
			continue;
		}

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			tx.objectStore(STORE_NAME).put({
				fileId: key.fileId,
				keyMultibase: key.keyMultibase,
				createdAt: key.createdAt ?? Date.now(),
				bucketName: key.bucketName,
				path: key.path,
			} satisfies KeyRecord);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		imported++;
	}

	return { imported, skipped };
}
