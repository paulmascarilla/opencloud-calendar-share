<template>
  <a
    :href="SOURCE_URL"
    target="_blank"
    rel="noopener noreferrer"
    class="source-link ext:inline-flex ext:items-center ext:gap-1 ext:text-xs"
    :title="$gettext('Source code of this app (%{license})', { license: LICENSE })"
  >
    <oc-icon name="code-s-slash" size="xsmall" />
    {{ $gettext('Source code') }} · {{ LICENSE }}
  </a>
</template>

<script setup lang="ts">
import { LICENSE, SOURCE_URL } from '../about'
</script>

<style scoped>
.source-link {
  color: var(--oc-role-on-surface-variant);
  text-decoration: none;
}
.source-link:hover {
  color: var(--oc-role-on-surface);
  text-decoration: underline;
}
</style>
