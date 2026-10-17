<template>
  <nav class="ext:flex ext:flex-col ext:gap-3" :aria-label="$gettext('Calendars')">
    <section v-for="group in groups" :key="group.title">
      <h2
        class="ext:text-xs ext:font-semibold ext:uppercase ext:tracking-wide ext:text-role-on-surface-variant ext:mt-0 ext:mb-2"
      >
        {{ group.title }}
      </h2>
      <p v-if="!group.items.length" class="ext:text-sm ext:text-role-on-surface-variant ext:m-0">
        {{ group.empty }}
      </p>
      <ul class="ext:list-none ext:m-0 ext:p-0 ext:flex ext:flex-col ext:gap-1">
        <li v-for="cal in group.items" :key="cal.href">
          <label
            class="calendar-row ext:flex ext:items-center ext:gap-2 ext:px-2 ext:py-1.5 ext:rounded ext:cursor-pointer"
          >
            <input
              type="checkbox"
              class="swatch"
              :style="{ '--swatch': cal.color }"
              :checked="!hidden.includes(cal.href)"
              @change="emit('toggle', cal.href)"
            />
            <span class="ext:flex-1 ext:min-w-0">
              <span class="ext:block ext:truncate ext:text-sm">{{ cal.name }}</span>
              <span
                v-if="owners[cal.href]"
                class="ext:block ext:truncate ext:text-xs ext:text-role-on-surface-variant"
              >
                {{ $gettext('by %{name}', { name: displayName(owners[cal.href]) }) }}
              </span>
            </span>
            <oc-icon
              v-if="!cal.writable"
              name="eye"
              size="xsmall"
              :title="$gettext('Read only')"
              class="ext:text-role-on-surface-variant"
            />
          </label>
        </li>
      </ul>
    </section>

    <oc-button appearance="outline" size="small" @click="emit('create')">
      <oc-icon name="add" size="small" />
      {{ $gettext('New calendar') }}
    </oc-button>
    <oc-button type="router-link" :to="{ name: 'calendar-sharing' }" appearance="outline" size="small">
      <oc-icon name="share" size="small" />
      {{ $gettext('Manage sharing') }}
    </oc-button>

    <source-link class="ext:mt-2" />
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import { CalendarSource } from '../composables/useCaldav'
import SourceLink from './SourceLink.vue'
import { useUserDirectory } from '../composables/useUserDirectory'

const props = defineProps<{
  calendars: CalendarSource[]
  hidden: string[]
  /** calendar href -> owner user id, for calendars shared with the current user */
  owners: Record<string, string>
}>()
const emit = defineEmits<{ (e: 'toggle', href: string): void; (e: 'create'): void }>()

const { $gettext } = useGettext()
const { displayName } = useUserDirectory()

const groups = computed(() => [
  {
    title: $gettext('My calendars'),
    empty: $gettext('No calendar yet.'),
    items: props.calendars.filter((c) => !props.owners[c.href])
  },
  {
    title: $gettext('Shared with me'),
    empty: $gettext('Nothing shared with you yet.'),
    items: props.calendars.filter((c) => props.owners[c.href])
  }
])
</script>

<style scoped>
.calendar-row:hover {
  background-color: var(--oc-role-surface-container-high);
}
.swatch {
  appearance: none;
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  margin: 0;
  border-radius: 0.25rem;
  border: 2px solid var(--swatch);
  cursor: pointer;
}
.swatch:checked {
  background: var(--swatch)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E")
    center / 0.8rem no-repeat;
}
.swatch:focus-visible {
  outline: 2px solid var(--oc-role-primary);
  outline-offset: 2px;
}
</style>
