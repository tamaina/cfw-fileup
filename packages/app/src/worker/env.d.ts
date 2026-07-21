/** Secrets configured with `wrangler secret put` or `.dev.vars`. */
interface Env {
	SIGNUP_PASSPHRASE: string;
	TURNSTILE_SECRET: string;
	GOOGLE_CLIENT_SECRET: string;
	EVM_CHAIN_RPC_URLS: string;
	REOWN_PROJECT_ID: string;
}
