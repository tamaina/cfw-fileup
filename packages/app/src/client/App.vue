<script setup lang="ts">
import { ref, computed, onMounted, defineComponent, h } from 'vue';
import { mainRouter } from './router';
import { fetchCurrentUser, authStore, clearAuth } from './store/auth';
import { navigateFn } from './navigate';
import NirA from './components/nira.vue';

navigateFn.value = (path) => mainRouter.pushByPath(path);

const isReady = ref(false);

onMounted(async () => {
	await fetchCurrentUser();
	isReady.value = true;
});

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
</script>

<template>
  <div>
    <nav style="padding:8px; border-bottom:1px solid #ccc; margin-bottom:16px">
      <NirA to="/">CFW FileUp</NirA>
      &nbsp;|&nbsp;
      <NirA to="/my/buckets">マイバケット</NirA>
      &nbsp;|&nbsp;
      <NirA to="/my/uploadings">アップロード中</NirA>
      &nbsp;
      <template v-if="authStore.user?.isAdmin">
        |&nbsp;
        <NirA to="/admin">管理</NirA>
        &nbsp;
      </template>
      <template v-if="authStore.user">
        <span>{{ authStore.user.username }}</span>
        &nbsp;
        <button type="button" @click="clearAuth(); mainRouter.pushByPath('/signin')">ログアウト</button>
      </template>
      <template v-else>
        <NirA to="/signin">サインイン</NirA>
      </template>
    </nav>

    <main style="padding:0 16px">
      <p v-if="!isReady">読み込み中...</p>
      <component :is="CurrentPage" v-else-if="CurrentPage" />
    </main>
  </div>
</template>
