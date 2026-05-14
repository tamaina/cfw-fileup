<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<a :href="to" @click="nav"><slot></slot></a>
</template>

<script lang="ts" setup>
import { navigateTo } from '@/navigate';

const props = defineProps<{
	to: string;
}>();

function nav(ev: MouseEvent): void {
	if (ev.metaKey || ev.altKey || ev.ctrlKey) return;
	ev.preventDefault();
	navigateTo(props.to);
}
</script>
