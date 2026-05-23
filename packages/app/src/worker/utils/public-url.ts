import { apiError } from './api-error';

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split('.');
	if (parts.length !== 4) return false;
	const nums = parts.map((part) => Number(part));
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a = 0, b = 0] = nums;
	return a === 10
		|| a === 127
		|| a === 0
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| a >= 224;
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return host === 'localhost'
		|| host.endsWith('.localhost')
		|| host === 'metadata.google.internal'
		|| isPrivateIpv4(host)
		|| host === '::1'
		|| host === '::'
		|| host.startsWith('fc')
		|| host.startsWith('fd')
		|| host.startsWith('fe80:');
}

export function assertPublicHttpsUrl(urlString: string, errorCode: 'INVALID_PROFILE_URL' | 'INDIEAUTH_DISCOVERY_FAILED' = 'INVALID_PROFILE_URL'): URL {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		throw apiError(400, errorCode);
	}

	if (url.protocol !== 'https:' || isBlockedHostname(url.hostname)) {
		throw apiError(400, errorCode);
	}

	return url;
}

export async function fetchPublicHttps(input: string, init?: RequestInit, redirects = 0): Promise<Response> {
	const url = assertPublicHttpsUrl(input, 'INDIEAUTH_DISCOVERY_FAILED');
	const res = await fetch(url.toString(), { ...init, redirect: 'manual' });

	if (res.status >= 300 && res.status < 400) {
		if (redirects >= 3) return res;
		const location = res.headers.get('Location');
		if (!location) return res;
		return fetchPublicHttps(new URL(location, url).toString(), init, redirects + 1);
	}

	return res;
}
