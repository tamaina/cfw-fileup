# Client-side coding notes

## Vuetify 0 フォームの書き方

### `<form>` 要素
`@vuetify/v0` の `Form` コンポーネントを使う。`@submit` イベントは `{ valid: boolean }` を受け取る。

```vue
<script setup>
import { Form } from '@vuetify/v0';
async function submit({ valid }) {
  if (!valid) return;
  // ...
}
</script>

<template>
  <Form @submit="submit">
    ...
  </Form>
</template>
```

### `<button type="submit">` 要素
**Vuetify 0 の `Button` コンポーネントは使わない。** 通常の HTML `<button>` をそのまま書く。

```vue
<button type="submit" class="btn btn-primary" :disabled="loading">
  送信
</button>
```

> `Button.Root` / `Button.Content` / `Button.Loading` は submit ボタンとして機能しないため不可。

### `Input` コンポーネント
`Input.Root` + `Input.Control` + `Input.Error` の組み合わせで使う。

```vue
<Input.Root v-model="value" type="password" required validate-on="submit">
  <Input.Control placeholder="..." class="form-input" />
  <Input.Error v-slot="{ errors }">
    <span v-for="e in errors" :key="e" class="form-error">{{ e }}</span>
  </Input.Error>
</Input.Root>
```
