<script setup lang="ts">
import { ref, computed, defineComponent, h } from 'vue';
import { Button, Popover, useTheme } from '@vuetify/v0';
import { mainRouter } from './router';
import { fetchCurrentUser, authStore, clearAuth } from './store/auth';
import { navigateFn } from './navigate';
import NirA from './components/nira.vue';

navigateFn.value = (path) => mainRouter.pushByPath(path);

const theme = useTheme();
const isDark = theme.isDark;

const appNavOpen = ref(false);

function closeAppNav() {
  appNavOpen.value = false;
};

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
	mainRouter.pushByPath('/');
}

function toggleTheme(): void {
	theme.cycle(['light', 'dark']);
}
</script>

<template>
  <div class="app-layout">
    <header class="app-nav">
      <div class="app-nav-inner">
        <NirA to="/" class="app-nav-brand">CFW FileUp</NirA>

        <div class="app-nav-links">
          <NirA to="/my/buckets" class="app-nav-link">マイバケット</NirA>
          <template v-if="authStore.user?.isAdmin">
            <NirA to="/admin" class="app-nav-link">管理</NirA>
          </template>
        </div>

        <div class="app-nav-spacer" />

        <Button.Root class="btn btn-ghost btn-icon" :aria-label="isDark ? 'ライトモードに切替' : 'ダークモードに切替'" @click="toggleTheme">
          <Button.Content>{{ isDark ? '☀️' : '🌙' }}</Button.Content>
        </Button.Root>

        <div class="app-nav-user">
          <template v-if="authStore.user">
            <Popover.Root v-model="appNavOpen">
              <Popover.Activator class="btn btn-ghost app-nav-username" aria-haspopup="true">
                {{ authStore.user.username }}
              </Popover.Activator>
              <Popover.Content class="app-nav-user-menu">
                <div class="app-nav-user-menu-inner">
                  <Button.Root :as="NirA" to="/my/uploadings" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>アップロード状況</Button.Content>
                  </Button.Root>
                  <Button.Root :as="NirA" to="/my/passkeys" class="btn btn-ghost w-full" @click="closeAppNav">
                    <Button.Content>パスキー</Button.Content>
                  </Button.Root>
                  <Button.Root class="btn btn-ghost w-full" @click="logout">
                    <Button.Content>ログアウト</Button.Content>
                  </Button.Root>
                </div>
              </Popover.Content>
            </Popover.Root>
          </template>
          <template v-else>
            <NirA to="/signin" class="btn btn-primary">サインイン</NirA>
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

<style module lang="scss">

</style>
