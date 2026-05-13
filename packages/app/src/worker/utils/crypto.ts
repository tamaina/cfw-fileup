const ITERATIONS = 100_000;
const HASH_LENGTH = 256;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt,
			hash: 'SHA-256',
			iterations: ITERATIONS,
		},
		keyMaterial,
		HASH_LENGTH,
	);

	const saltHex = Array.from(salt)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const hashHex = Array.from(new Uint8Array(derivedBits))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, expectedHashHex] = stored.split(':');
	if (!saltHex || !expectedHashHex) return false;

	const salt = Uint8Array.from(
		(saltHex.match(/.{2}/g) || []).map((byte) => parseInt(byte, 16)),
	);
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt,
			hash: 'SHA-256',
			iterations: ITERATIONS,
		},
		keyMaterial,
		HASH_LENGTH,
	);

	const hashHex = Array.from(new Uint8Array(derivedBits))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return hashHex === expectedHashHex;
}

export function generateToken(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
