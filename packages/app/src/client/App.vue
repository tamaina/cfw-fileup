<script setup lang="ts">
import { ref, computed, defineComponent, h } from 'vue';
import { Button } from '@vuetify/v0';
import { mainRouter } from './router';
import { fetchCurrentUser, authStore, clearAuth } from './store/auth';
import { navigateFn } from './navigate';
import { isDark, toggleTheme } from './store/theme';
import NirA from './components/nira.vue';

navigateFn.value = (path) => mainRouter.pushByPath(path);

const isReady = ref(false);

(async () => {
	await fetchCurrentUser();
	isReady.value = true;
})();

const CurrentPage = computed(() => {
	const resolved = mainRouter.currentRef.value;
	if (!resolved) return null;
	const route = resolved.route;
	if (!('component' in route)) return null;
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

function logout(): void {
	clearAuth();
	mainRouter.pushByPath('/signin');
}
</script>

<template>
  <div class="app-layout">
    <header class="app-nav">
      <div class="app-nav-inner">
        <NirA to="/" class="app-nav-brand">CFW FileUp</NirA>

        <NirA to="/my/buckets" class="app-nav-link">マイバケット</NirA>
        <NirA to="/my/uploadings" class="app-nav-link">アップロード中</NirA>
        <template v-if="authStore.user?.isAdmin">
          <NirA to="/admin" class="app-nav-link">管理</NirA>
        </template>

        <div class="app-nav-spacer" />

        <Button.Root class="btn btn-ghost btn-icon" :aria-label="isDark ? 'ライトモードに切替' : 'ダークモードに切替'" @click="toggleTheme">
          <Button.Content>{{ isDark ? '☀️' : '🌙' }}</Button.Content>
        </Button.Root>

        <div class="app-nav-user">
          <template v-if="authStore.user">
            <span class="app-nav-username">{{ authStore.user.username }}</span>
            <Button.Root class="btn btn-ghost btn-sm" @click="logout">
              <Button.Content>ログアウト</Button.Content>
            </Button.Root>
          </template>
          <template v-else>
            <NirA to="/signin" class="btn btn-primary btn-sm">サインイン</NirA>
          </template>
        </div>
      </div>
    </header>

    <main class="app-main">
      <div v-if="!isReady" class="page-loading">
        <span class="spinner" />
        読み込み中...
      </div>
      <component :is="CurrentPage" v-else-if="CurrentPage" />
    </main>
  </div>
</template>
