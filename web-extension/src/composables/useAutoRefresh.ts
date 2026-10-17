import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface AutoRefreshOptions {
  /** Delay between two checks while the page is visible */
  intervalMs: number
  /** Return true to skip a tick (e.g. while the user drags an event) */
  paused?: () => boolean
}

/**
 * Runs ``check`` periodically while the tab is visible, right away when the tab
 * comes back to the foreground, and backs off (up to 4x) after failures.
 */
export function useAutoRefresh(check: () => Promise<void>, options: AutoRefreshOptions) {
  const lastSync = ref<Date | null>(null)
  const syncing = ref(false)
  const failing = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let stopped = false

  async function run() {
    clearTimeout(timer)
    if (stopped) return
    if (document.visibilityState === 'visible' && !syncing.value && !options.paused?.()) {
      syncing.value = true
      try {
        await check()
        lastSync.value = new Date()
        failures = 0
        failing.value = false
      } catch {
        failures = Math.min(failures + 1, 2)
        failing.value = true
      } finally {
        syncing.value = false
      }
    }
    schedule()
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(run, options.intervalMs * 2 ** failures)
  }

  function onVisible() {
    if (document.visibilityState === 'visible') run()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    schedule()
  })

  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  })

  return { lastSync, syncing, failing, refreshNow: run }
}
