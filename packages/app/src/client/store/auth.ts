import { reactive, readonly } from 'vue';

export interface AuthUser {
	id: string;
	username: string;
	isAdmin: boolean;
}

const TOKEN_KEY = 'cfw_fileup_token';
const USER_KEY = 'cfw_fileup_user';

function loadStoredUser(): AuthUser | null {
	try {
		const raw = localStorage.getItem(USER_KEY);
		return raw ? (JSON.parse(raw) as AuthUser) : null;
	} catch {
		return null;
	}
}

const state = reactive<{
	token: string | null;
	user: AuthUser | null;
	initialized: boolean;
}>({
	token: localStorage.getItem(TOKEN_KEY),
	user: loadStoredUser(),
	initialized: loadStoredUser() !== null || localStorage.getItem(TOKEN_KEY) === null,
});

export const authStore = readonly(state);

export function setToken(token: string): void {
	state.token = token;
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuth(): void {
	state.token = null;
	state.user = null;
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(USER_KEY);
}

export function authHeaders(): Record<string, string> {
	if (!state.token) return {};
	return { Authorization: `Bearer ${state.token}` };
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
	if (!state.token) {
		state.initialized = true;
		return null;
	}
	try {
		const res = await fetch('/api/account/me', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: JSON.stringify({}),
		});
		if (!res.ok) {
			clearAuth();
			state.initialized = true;
			return null;
		}
		const user = (await res.json()) as AuthUser;
		state.user = user;
		localStorage.setItem(USER_KEY, JSON.stringify(user));
		state.initialized = true;
		return user;
	} catch {
		state.initialized = true;
		return null;
	}
}
