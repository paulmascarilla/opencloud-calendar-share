<template>
  <header
    class="ext:flex ext:flex-wrap ext:items-center ext:gap-x-4 ext:gap-y-3 ext:px-4 ext:py-3 ext:border-b ext:border-role-outline-variant"
  >
    <div class="ext:flex ext:items-center ext:gap-3 ext:min-w-0 ext:flex-1">
      <!-- today's date, as on a desk calendar -->
      <div
        class="date-badge ext:shrink-0 ext:flex ext:flex-col ext:items-center ext:rounded-lg ext:border ext:border-role-outline-variant ext:overflow-hidden"
        :title="todayLong"
        aria-hidden="true"
      >
        <span
          class="ext:w-full ext:text-center ext:text-[0.65rem] ext:font-semibold ext:uppercase ext:tracking-wide ext:bg-role-surface-container ext:text-role-on-surface-variant ext:py-0.5"
          >{{ todayMonth }}</span
        >
        <span class="ext:text-lg ext:font-bold ext:leading-tight ext:py-0.5">{{ today.getDate() }}</span>
      </div>
      <div class="ext:min-w-0">
        <h2 class="ext:m-0 ext:text-lg ext:font-semibold ext:truncate">{{ title }}</h2>
        <p class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant ext:truncate">{{ subtitle }}</p>
      </div>
    </div>

    <div class="ext:flex ext:flex-wrap ext:items-center ext:gap-2">
      <span
        class="sync ext:inline-flex ext:items-center ext:gap-1 ext:text-xs ext:text-role-on-surface-variant"
        :class="{ 'sync-failing': failing }"
        role="status"
      >
        <oc-button
          appearance="raw"
          size="small"
          :aria-label="$gettext('Refresh now')"
          :title="$gettext('Refresh now')"
          @click="emit('refresh')"
        >
          <oc-icon name="refresh" size="small" :class="{ 'ext:animate-spin': syncing }" />
        </oc-button>
        <span class="ext:hidden ext:lg:inline">{{ syncLabel }}</span>
      </span>

      <div
        class="ext:inline-flex ext:rounded-lg ext:border ext:border-role-outline-variant ext:overflow-hidden nav-group"
        role="group"
        :aria-label="$gettext('Navigate')"
      >
        <oc-button appearance="raw" size="small" :aria-label="$gettext('Previous')" @click="emit('prev')">
          <oc-icon name="arrow-left" size="small" />
        </oc-button>
        <oc-button appearance="raw" size="small" @click="emit('today')">{{ $gettext('Today') }}</oc-button>
        <oc-button appearance="raw" size="small" :aria-label="$gettext('Next')" @click="emit('next')">
          <oc-icon name="arrow-right" size="small" />
        </oc-button>
      </div>

      <oc-select
        class="view-select"
        :model-value="views.find((v) => v.value === view)"
        :options="views"
        option-label="label"
        :searchable="false"
        :clearable="false"
        :label="$gettext('View')"
        :label-hidden="true"
        @update:model-value="emit('view', $event.value)"
      />

      <oc-button appearance="filled" :disabled="!canCreate" @click="emit('create')">
        <oc-icon name="add" size="small" />
        {{ $gettext('New event') }}
      </oc-button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useGettext } from 'vue3-gettext'

const props = defineProps<{
  title: string
  subtitle: string
  view: string
  views: { value: string; label: string }[]
  canCreate: boolean
  syncing: boolean
  failing: boolean
  lastSync: Date | null
}>()
const emit = defineEmits<{
  (e: 'prev' | 'next' | 'today' | 'create' | 'refresh'): void
  (e: 'view', view: string): void
}>()

const { $gettext, current } = useGettext()

// Ticks every 30 s so "today" and "synced x ago" stay right on a long-open tab.
const now = ref(new Date())
const clock = setInterval(() => (now.value = new Date()), 30_000)
onBeforeUnmount(() => clearInterval(clock))

const today = computed(() => now.value)
const todayMonth = computed(() =>
  new Intl.DateTimeFormat(current, { month: 'short' }).format(today.value).replace('.', '')
)
const todayLong = computed(() => new Intl.DateTimeFormat(current, { dateStyle: 'full' }).format(today.value))

const syncLabel = computed(() => {
  if (props.failing) return $gettext('Offline, retrying…')
  if (!props.lastSync) return $gettext('Up to date')
  const time = new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' }).format(props.lastSync)
  return $gettext('Synced at %{time}', { time })
})
</script>

<style scoped>
.date-badge {
  width: 2.75rem;
  background: var(--oc-role-surface);
}
.nav-group :deep(.oc-button) {
  border-radius: 0;
  padding-inline: 0.6rem;
}
.nav-group :deep(.oc-button:hover) {
  background: var(--oc-role-surface-container-high);
}
.nav-group :deep(.oc-button + .oc-button) {
  border-left: 1px solid var(--oc-role-outline-variant);
}
/* The design system's raw buttons switch to a lighter text color and background on
   focus, and a mouse click leaves the focus on them: the icon stayed white. Use fixed
   role colors; only hover and keyboard focus (:focus-visible) highlight. */
.sync :deep(.oc-button),
.nav-group :deep(.oc-button) {
  color: var(--oc-role-on-surface-variant);
}
.sync :deep(.oc-button:hover),
.sync :deep(.oc-button:focus-visible),
.nav-group :deep(.oc-button:hover),
.nav-group :deep(.oc-button:focus-visible) {
  color: var(--oc-role-on-surface);
}
.sync :deep(.oc-button:focus:not(:focus-visible):not(:hover)),
.nav-group :deep(.oc-button:focus:not(:focus-visible):not(:hover)) {
  background: transparent;
  color: var(--oc-role-on-surface-variant);
}
.sync :deep(.oc-button) {
  border-radius: 9999px;
  padding: 0.25rem;
}
.sync :deep(.oc-button:hover) {
  background: var(--oc-role-surface-container-high);
}
.view-select {
  width: 11.5rem;
}
.sync-failing {
  color: var(--oc-role-error);
}
</style>
