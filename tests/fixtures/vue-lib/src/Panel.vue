<template>
  <section class="vt-panel">
    <slot name="header" />
    <slot />
  </section>
</template>

<script lang="ts">
/**
 * A plain object-literal Options API component.
 */
export default {
  name: 'VtPanel',
  props: {
    /** Heading text. */
    heading: {
      type: String,
      required: true,
    },
    /** Whether the panel starts collapsed. */
    collapsed: {
      type: Boolean,
      default: false,
    },
    /** Arbitrary metadata. */
    meta: {
      type: Object,
      default: () => ({}),
    },
  },
}
</script>

<style scoped>
.vt-panel {
  border: 1px solid var(--color-border-default);
  padding: var(--spacing-lg);
}
</style>
