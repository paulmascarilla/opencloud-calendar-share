import { useGettext } from 'vue3-gettext'
import { Preset, presetOf, Repeat, Weekday, WEEKDAYS, weekOfMonth } from '../repeat'

/** Words for repeat rules: preset labels and a one-line summary. */
export function useRepeatText() {
  const { $gettext, $ngettext, current } = useGettext()
  const locale = () => current.replace('_', '-')

  /** Full weekday name, for a day code (MO, TU, …). */
  function dayName(day: Weekday, style: 'long' | 'short' = 'long') {
    // 2023-01-01 was a Sunday: offset by the index of the code.
    const date = new Date(2023, 0, 1 + WEEKDAYS.indexOf(day))
    return new Intl.DateTimeFormat(locale(), { weekday: style }).format(date)
  }

  function nthDay(start: Date) {
    const day = dayName(WEEKDAYS[start.getDay()])
    switch (weekOfMonth(start)) {
      case 1:
        return $gettext('the first %{day}', { day })
      case 2:
        return $gettext('the second %{day}', { day })
      case 3:
        return $gettext('the third %{day}', { day })
      case 4:
        return $gettext('the fourth %{day}', { day })
      default:
        return $gettext('the last %{day}', { day })
    }
  }

  function presetLabel(preset: Preset, start: Date) {
    switch (preset) {
      case 'none':
        return $gettext('Does not repeat')
      case 'daily':
        return $gettext('Every day')
      case 'weekdays':
        return $gettext('Every weekday (Monday to Friday)')
      case 'weekly':
        return $gettext('Every week on %{day}', { day: dayName(WEEKDAYS[start.getDay()]) })
      case 'monthly':
        return $gettext('Every month on day %{n}', { n: String(start.getDate()) })
      case 'monthly-weekday':
        return $gettext('Every month on %{nth}', { nth: nthDay(start) })
      case 'yearly':
        return $gettext('Every year on %{date}', {
          date: new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long' }).format(start)
        })
      default:
        return $gettext('Custom…')
    }
  }

  function unit(repeat: Repeat) {
    const n = repeat.interval
    // "Every day" is also a preset label: plural forms only from 2 on.
    switch (repeat.freq) {
      case 'DAILY':
        return n === 1 ? $gettext('Every day') : $ngettext('Every %{n} day', 'Every %{n} days', n, { n: String(n) })
      case 'WEEKLY':
        return n === 1 ? $gettext('Every week') : $ngettext('Every %{n} week', 'Every %{n} weeks', n, { n: String(n) })
      case 'MONTHLY':
        return n === 1 ? $gettext('Every month') : $ngettext('Every %{n} month', 'Every %{n} months', n, { n: String(n) })
      default:
        return n === 1 ? $gettext('Every year') : $ngettext('Every %{n} year', 'Every %{n} years', n, { n: String(n) })
    }
  }

  /** e.g. "Every 2 weeks on Monday, Thursday, until 31 December 2026". */
  function summary(repeat: Repeat, start: Date) {
    const preset = presetOf(repeat, start)
    let text = preset === 'custom' ? unit(repeat) : presetLabel(preset, start)
    if (preset === 'custom') {
      if (repeat.freq === 'WEEKLY') {
        const days = WEEKDAYS.filter((d) => repeat.weekdays.includes(d)).map((d) => dayName(d))
        text = $gettext('%{every} on %{days}', { every: text, days: new Intl.ListFormat(locale()).format(days) })
      } else if (repeat.freq === 'MONTHLY') {
        text =
          repeat.monthlyBy === 'weekday'
            ? $gettext('%{every} on %{nth}', { every: text, nth: nthDay(start) })
            : $gettext('%{every} on day %{n}', { every: text, n: String(start.getDate()) })
      }
    }
    if (repeat.until) {
      const [y, m, d] = repeat.until.split('-').map(Number)
      const date = new Intl.DateTimeFormat(locale(), { dateStyle: 'long' }).format(new Date(y, m - 1, d))
      text = $gettext('%{rule}, until %{date}', { rule: text, date })
    } else if (repeat.count) {
      text = $ngettext('%{rule}, %{n} time', '%{rule}, %{n} times', repeat.count, { rule: text, n: String(repeat.count) })
    }
    return text
  }

  return { dayName, nthDay, presetLabel, summary }
}
