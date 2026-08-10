<template>
  <p class="vt-healthy">{{ text }}</p>
</template>

<script setup lang="ts">
/**
 * A perfectly valid component sitting next to a broken one.
 */
defineProps<{
  /** Text to render. */
  text: string
}>()
</script>

<style scoped>
.vt-healthy {
  color: var(--color-text-default);
}
</style>
