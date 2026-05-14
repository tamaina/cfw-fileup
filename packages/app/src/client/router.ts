/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// https://github.com/misskey-dev/misskey/blob/e2335567005ccd6e45db1556ae1095bb00d87e52/packages/frontend/src/router.ts

import { inject } from 'vue';
import { page } from '@/router.definition.js';
import { Nirax } from '@/nirax.js';
import { ROUTE_DEF } from '@/router.definition.js';

export type Router = Nirax<typeof ROUTE_DEF>;

export function createRouter(fullPath: string, loggedIn: boolean = false): Router {
	return new Nirax(ROUTE_DEF, fullPath, loggedIn, page(() => import('@/pages/not-found.vue')));
}

export const mainRouter = createRouter(window.location.pathname + window.location.search + window.location.hash);

window.addEventListener('popstate', (event) => {
	mainRouter.replaceByPath(window.location.pathname + window.location.search + window.location.hash);
});

mainRouter.addListener('push', ctx => {
	window.history.pushState({ }, '', ctx.fullPath);
});

mainRouter.addListener('replace', ctx => {
	window.history.replaceState({ }, '', ctx.fullPath);
});

mainRouter.addListener('forceReplace', ctx => {
	window.location.replace(ctx.fullPath);
});

mainRouter.addListener('forcePush', ctx => {
	window.location.href = ctx.fullPath;
});

mainRouter.addListener('change', ctx => {
	//if (_DEV_) console.log('mainRouter: change', ctx.fullPath);
	//analytics.page({
	//	path: ctx.fullPath,
	//	title: ctx.fullPath,
	//});
});

mainRouter.init();

const ROUTER_SYMBOL = Symbol();

export function useRouter(): Router {
	return inject(ROUTER_SYMBOL, null) ?? mainRouter;
}
