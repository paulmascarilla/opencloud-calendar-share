<template>
  <oc-select
    :model-value="modelValue"
    :options="options"
    :loading="searching"
    :filter="keepServerResults"
    :get-option-label="optionLabel"
    :label="$gettext('Share with')"
    :label-hidden="true"
    :placeholder="$gettext('Search people by name, username or e-mail')"
    class="ext:flex-1 ext:min-w-56"
    @search:input="onSearch"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #option="user">
      <div class="ext:flex ext:items-center ext:gap-2">
        <oc-avatar :user-name="user.displayName" :width="24" />
        <span>{{ user.displayName }}</span>
        <span v-if="user.username" class="ext:text-role-on-surface-variant ext:text-sm"
          >@{{ user.username }}</span
        >
      </div>
    </template>
    <template #no-options>
      {{ query.length < 3 ? $gettext('Type at least 3 characters') : $gettext('No user found') }}
    </template>
  </oc-select>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { DirectoryUser, useUserDirectory } from '../composables/useUserDirectory'

const props = withDefaults(
  defineProps<{
    modelValue: DirectoryUser | null
    excludeIds?: string[]
  }>(),
  { excludeIds: () => [] }
)
const emit = defineEmits<{ (e: 'update:modelValue', value: DirectoryUser | null): void }>()

const { search } = useUserDirectory()
const options = ref<DirectoryUser[]>([])
const searching = ref(false)
const query = ref('')
let debounce: ReturnType<typeof setTimeout> | undefined
let latest = 0

function onSearch(value: string) {
  query.value = value
  clearTimeout(debounce)
  debounce = setTimeout(() => runSearch(value), 250)
}

async function runSearch(value: string) {
  const ticket = ++latest
  searching.value = true
  try {
    const users = await search(value)
    if (ticket === latest) {
      options.value = users.filter((u) => !props.excludeIds.includes(u.id))
    }
  } catch {
    if (ticket === latest) options.value = []
  } finally {
    if (ticket === latest) searching.value = false
  }
}

function optionLabel(user: DirectoryUser) {
  return user.displayName
}

// Results are already filtered by the Graph search; don't let vue-select filter them again.
function keepServerResults(items: DirectoryUser[]) {
  return items
}
</script>
