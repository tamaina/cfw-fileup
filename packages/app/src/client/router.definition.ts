/*
 * SPDX-FileCopyrightText: tamaina, syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// https://github.com/misskey-dev/misskey/blob/e2335567005ccd6e45db1556ae1095bb00d87e52/packages/frontend/src/router.definition.ts

import { defineAsyncComponent } from 'vue';
import type { AsyncComponentLoader } from 'vue';
import MkLoading from './components/Loading.vue';
import MkError from './components/Error.vue';
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
		component: page(() => import('@/pages/auth.vue')),
	},
	{
		path: '/signup',
		name: 'signup',
		component: page(() => import('@/pages/auth.vue')),
	},
	{
		path: '/my/buckets',
		name: 'my-buckets',
		component: page(() => import('@/pages/my/buckets.vue')),
	},
	{
		path: '/my/uploadings',
		name: 'my-uploadings',
		component: page(() => import('@/pages/my/uploadings.vue')),
	},
	{
		path: '/my/downloads',
		name: 'my-downloads',
		component: page(() => import('@/pages/my/downloads.vue')),
	},
	{
		path: '/my/passkeys',
		name: 'my-passkeys',
		component: page(() => import('@/pages/my/passkeys.vue')),
	},
	{
		path: '/my/tokens',
		name: 'my-tokens',
		component: page(() => import('@/pages/my/tokens.vue')),
	},
	{
		path: '/uploader',
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
		component: page(() => import('@/pages/admin/index.vue')),
	},
	{
		path: '/admin/settings',
		name: 'admin-settings',
		component: page(() => import('@/pages/admin/settings.vue')),
	},
	{
		path: '/admin/users',
		name: 'admin-users',
		component: page(() => import('@/pages/admin/users/index.vue')),
	},
	{
		path: '/admin/ip-bans',
		name: 'admin-ip-bans',
		component: page(() => import('@/pages/admin/ip-bans.vue')),
	},
	{
		path: '/admin/file-reports',
		name: 'admin-file-reports',
		component: page(() => import('@/pages/admin/file-reports.vue')),
	},
	{
		path: '/admin/file-reports/:reportId',
		name: 'admin-file-report',
		component: page(() => import('@/pages/admin/file-report.vue')),
	},
	{
		path: '/admin/global-quota',
		name: 'admin-global-quota',
		component: page(() => import('@/pages/admin/global-quota.vue')),
	},
	{
		path: '/admin/plans',
		name: 'admin-plans',
		component: page(() => import('@/pages/admin/plans.vue')),
	},
	{
		path: '/admin/users/:userId',
		name: 'admin-user-quota',
		component: page(() => import('@/pages/admin/users/user-quota.vue')),
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
