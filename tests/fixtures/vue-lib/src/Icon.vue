<template>
  <span class="vt-icon" :style="{ '--icon-size': size }" role="img" :aria-label="name" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'VtIcon',
  props: {
    /** Icon glyph identifier. */
    name: {
      type: String,
      required: true,
    },
    /** Rendered edge length. */
    size: {
      type: String,
      default: '1rem',
    },
    /** Rotation in degrees. */
    rotation: Number,
  },
})
</script>

<style scoped>
.vt-icon {
  width: var(--icon-size);
  color: var(--color-icon-default);
}
</style>
