export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
	const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ secret, response: token }),
	});
	const data = await res.json() as { success: boolean };
	return data.success;
}
