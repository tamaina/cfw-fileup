<script setup lang="ts">
import { ref, computed, onMounted, defineComponent, h } from 'vue';
import { Nirax } from './nirax';
import { ROUTE_DEF } from './router.definition';
import { fetchCurrentUser, authStore, clearAuth } from './store/auth';
import { navigateFn } from './navigate';
import NirA from './components/nira.vue';

const NotFound = defineComponent({
	render: () => h('div', [
		h('h1', '404 - ページが見つかりません'),
		h('p', [h('a', { href: '/' }, 'トップへ戻る')]),
	]),
});

const router = new Nirax(
	ROUTE_DEF as never,
	window.location.pathname + window.location.search + window.location.hash,
	false,
	NotFound,
);

const currentResolved = ref(router.current);

navigateFn.value = (path) => router.pushByPath(path);

router.on('push', ({ fullPath }) => {
	window.history.pushState(null, '', fullPath);
	currentResolved.value = router.current;
});
router.on('replace', ({ fullPath }) => {
	window.history.replaceState(null, '', fullPath);
	currentResolved.value = router.current;
});
router.on('forceReplace', ({ fullPath }) => {
	window.location.replace(fullPath);
});
router.on('forcePush', ({ fullPath }) => {
	window.location.href = fullPath;
});

window.addEventListener('popstate', () => {
	router.pushByPath(window.location.pathname + window.location.search + window.location.hash);
});

const isReady = ref(false);

onMounted(async () => {
	await fetchCurrentUser();
	router.init();
	isReady.value = true;
});

const CurrentPage = computed(() => {
	const resolved = currentResolved.value;
	if (!resolved) return null;
	const route = resolved.route;
	if (!('component' in route)) return null;
	// Capture component and props outside of render closure to preserve type narrowing
	const component = route.component;
	const propsMap = resolved.props;
	return defineComponent({
		render() {
			const props: Record<string, unknown> = {};
			propsMap.forEach((v, k) => { props[k] = v; });
			return h(component, props);
		},
	});
});

</script>

<template>
  <div>
    <nav style="padding:8px; border-bottom:1px solid #ccc; margin-bottom:16px">
      <NirA to="/">CFW FileUp</NirA>
      &nbsp;|&nbsp;
      <NirA to="/my/buckets">マイバケット</NirA>
      &nbsp;
      <template v-if="authStore.user">
        <span>{{ authStore.user.username }}</span>
        &nbsp;
        <button type="button" @click="clearAuth(); router.pushByPath('/signin')">ログアウト</button>
      </template>
      <template v-else>
        <NirA to="/signin">サインイン</NirA>
      </template>
    </nav>

    <main style="padding:0 16px">
      <p v-if="!isReady">読み込み中...</p>
      <component :is="CurrentPage" v-else-if="CurrentPage" />
      <NotFound v-else />
    </main>
  </div>
</template>
