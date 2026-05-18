/*
 * SPDX-FileCopyrightText: tamaina, syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// https://github.com/misskey-dev/misskey/blob/e2335567005ccd6e45db1556ae1095bb00d87e52/packages/frontend/src/router.definition.ts

import { defineAsyncComponent } from 'vue';
import type { AsyncComponentLoader } from 'vue';
import MkLoading from './components/loading.vue';
import MkError from './components/error.vue';
import type { RouteDef } from './nirax';

export const page = (loader: AsyncComponentLoader) => defineAsyncComponent({
	loader: loader,
	loadingComponent: MkLoading,
	errorComponent: MkError,
});

export const ROUTE_DEF = [
	{
		path: '/',
		name: 'home',
		component: page(() => import('@/pages/not-found.vue')),
	},
	{
		path: '/signin',
		name: 'signin',
		component: page(() => import('@/pages/signin.vue')),
	},
	{
		path: '/signup',
		name: 'signup',
		component: page(() => import('@/pages/signup.vue')),
	},
	{
		path: '/my/buckets',
		name: 'my-buckets',
		component: page(() => import('@/pages/my-buckets.vue')),
	},
	{
		path: '/my/uploadings',
		name: 'my-uploadings',
		component: page(() => import('@/pages/my-uploadings.vue')),
	},
	{
		path: '/my/passkeys',
		name: 'my-passkeys',
		component: page(() => import('@/pages/my-passkeys.vue')),
	},
	{
		path: '/my/buckets/:bucketName/upload',
		name: 'upload',
		component: page(() => import('@/pages/upload.vue')),
	},
	{
		path: '/v/:bucketName/:filePath(*)?',
		name: 'browse',
		component: page(() => import('@/pages/browse.vue')),
	},
	{
		path: '/admin',
		name: 'admin',
		component: page(() => import('@/pages/admin-index.vue')),
	},
	{
		path: '/admin/settings',
		name: 'admin-settings',
		component: page(() => import('@/pages/admin-settings.vue')),
	},
	{
		path: '/admin/users',
		name: 'admin-users',
		component: page(() => import('@/pages/admin-users.vue')),
	},
	{
		path: '/admin/global-quota',
		name: 'admin-global-quota',
		component: page(() => import('@/pages/admin-global-quota.vue')),
	},
	{
		path: '/admin/users/:userId',
		name: 'admin-user-quota',
		component: page(() => import('@/pages/admin-user-quota.vue')),
	},
	{
		path: '/api-doc',
		name: 'api-doc',
		component: page(() => import('@/pages/api-doc.vue')),
	},
	{
		path: '/:(*)',
		component: page(() => import('@/pages/not-found.vue')),
	},
] as const satisfies RouteDef[];
