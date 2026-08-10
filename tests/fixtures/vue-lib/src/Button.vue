<template>
  <button class="vt-button" :class="`vt-button--${variant}`" :disabled="disabled">
    <VtIcon v-if="icon" :name="icon" />
    <slot />
  </button>
</template>

<script setup lang="ts">
import VtIcon from './Icon.vue'
import { useTheme } from './composables/useTheme'
import type { ButtonVariant } from './composables/useTheme'

/**
 * Primary call-to-action button.
 */
interface Props {
  /** Visual emphasis of the button. */
  variant?: ButtonVariant
  /** Optional leading icon name. */
  icon?: string
  /** Disables interaction. */
  disabled?: boolean
  /** Accessible label, required when the button has no text content. */
  label: string
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  disabled: false,
})

const { theme } = useTheme()
</script>

<style scoped>
.vt-button {
  background: var(--color-brand-primary);
  color: var(--color-text-inverse);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
}
</style>
