import { shallowRef } from 'vue';

export const navigateFn = shallowRef<((path: string) => void) | null>(null);

export function navigateTo(path: string): void {
	if (navigateFn.value) {
		navigateFn.value(path);
	} else {
		window.location.href = path;
	}
}
