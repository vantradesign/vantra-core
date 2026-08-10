<template>
  <div class="vt-alert" role="alert" :data-severity="severity">
    <strong>{{ title }}</strong>
    <p v-if="message">{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { colorVariable } from '@fixture/tokens'
import type { ColorRole } from '@fixture/tokens'
import { clampLines } from '@/utils/text'

defineOptions({ name: 'VtAlert' })

defineProps<{
  /** Bold heading of the alert. */
  title: string
  /** Optional supporting copy. */
  message?: string
  /** Semantic severity, mapped onto a colour role. */
  severity?: ColorRole
}>()
</script>

<style scoped>
.vt-alert {
  border-left: 2px solid var(--vt-color-brand);
  background: var(--vt-color-surface);
  padding: var(--vt-spacing-md);
}
</style>
