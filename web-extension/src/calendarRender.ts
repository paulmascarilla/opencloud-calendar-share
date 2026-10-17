// FullCalendar render hooks for the OpenCloud look: plain DOM (no Vue), styled by
// calendar.css with the design system's color roles. Returning `true` keeps
// FullCalendar's default content (`undefined` would render nothing).
import type {
  CustomContentGenerator,
  DayHeaderContentArg,
  EventContentArg,
  EventMountArg,
  NowIndicatorContentArg
} from '@fullcalendar/core'

function el(tag: string, className: string, text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** "lun. 12" with the day number in a pill on today (week/day views only). */
export const dayHeaderContent: CustomContentGenerator<DayHeaderContentArg> = (arg) => {
  if (!arg.view.type.startsWith('timeGrid')) return true // FullCalendar's default rendering
  const weekday = arg.view.calendar.formatDate(arg.date, { weekday: 'short' })
  const day = el('span', arg.isToday ? 'oc-day-num is-today' : 'oc-day-num', String(arg.date.getDate()))
  if (arg.isToday) day.setAttribute('aria-current', 'date')
  return { domNodes: [el('span', 'oc-day-name', weekday), day] }
}

/** Title first, time below, as in the week view blocks. */
export const eventContent: CustomContentGenerator<EventContentArg> = (arg) => {
  if (!arg.view.type.startsWith('timeGrid') || arg.event.allDay) return true
  const nodes = [el('div', 'oc-ev-title', arg.event.title)]
  if (arg.timeText) nodes.push(el('div', 'oc-ev-time', arg.timeText))
  const location = arg.event.extendedProps.location as string
  if (location) nodes.push(el('div', 'oc-ev-location', location))
  return { domNodes: nodes }
}

/** Event color (event COLOR, else calendar color) exposed to CSS as --ev. */
export function eventDidMount(arg: EventMountArg) {
  arg.el.style.setProperty('--ev', arg.event.extendedProps.color as string)
}

/** Current time in the time axis, next to the dotted "now" line. */
export const nowIndicatorContent: CustomContentGenerator<NowIndicatorContentArg> = (arg) => {
  if (!arg.isAxis) return true
  const time = arg.view.calendar.formatDate(arg.date, { hour: '2-digit', minute: '2-digit' })
  return { domNodes: [el('span', 'oc-now-label', time)] }
}
