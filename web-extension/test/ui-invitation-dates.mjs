// How invitations show their dates, in a real (headless) Chromium with two users: answer page (multi-day,
// recurring, after midnight), "Open in the calendar", invitations tab count, an invitation in a calendar
// shared with the guest, default calendar for new events, week headers on a phone.
// usage: CHROMIUM=/snap/bin/chromium OC=https://localhost:9200 node test/ui-invitation-dates.mjs <screenshot dir>
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const OC = process.env.OC ?? 'https://localhost:9200'
const out = process.argv[2] ?? '.'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/snap/bin/chromium', headless: true })
const errors = []

async function session(user, viewport = { width: 1400, height: 900 }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, timezoneId: 'Europe/Paris', locale: 'fr-FR' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`[${user}] ${e.message}`))
  await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password]', { timeout: 30000 })
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(`Test-${user}-12345`)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.fc', { timeout: 30000 })
  // requests through the page's own session
  const call = (method, path, body, headers = {}) =>
    page.evaluate(async ({ method, path, body, headers }) => {
      let token
      for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) {
        const v = s.getItem(s.key(i))
        if (v?.includes('access_token')) token = JSON.parse(v).access_token
      }
      const r = await fetch(path, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } })
      return { status: r.status, text: await r.text() }
    }, { method, path, body, headers })
  const id = JSON.parse((await call('GET', '/graph/v1.0/me')).text).id
  return { page, call, id }
}

const bob = await session('bob')
const alice = await session('alice')
const stamp = Date.now()
const files = []
const cleanups = []
async function invite(name, lines) {
  const file = `${name}-${stamp}.ics`
  files.push(`/caldav/${bob.id}/def-calendar/${file}`)
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${name}-${stamp}`,
    'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  assert.equal((await bob.call('PUT', files.at(-1), ics, { 'Content-Type': 'text/calendar' })).status, 201)
  const guests = await bob.call('PUT', `/calshare/v1/calendars/def-calendar/events/${file}/guests`,
    JSON.stringify({ guests: [alice.id] }), { 'Content-Type': 'application/json' })
  assert.equal(guests.status, 200, guests.text)
}
const pending = async () => JSON.parse((await alice.call('GET', '/calshare/v1/invitations/pending')).text)
async function respondPage(title) {
  const invitation = (await pending()).find((i) => i.title === title)
  assert.ok(invitation, `no invitation "${title}"`)
  await alice.page.goto(`${OC}/calendar/respond?cal=${invitation.calendar}&event=${invitation.event}`)
  await alice.page.waitForSelector('text=Participerez', { timeout: 20000 })
  return (await alice.page.locator('h1 + p').first().textContent()).trim()
}
const openInCalendar = async () => {
  await alice.page.getByRole('link', { name: /Ouvrir dans l'agenda/ }).click()
  await alice.page.waitForSelector('.fc', { timeout: 20000 })
  await alice.page.waitForTimeout(2500)
}

try {
  await invite('late', ['DTSTART:20261025T233000Z', 'DTEND:20261026T003000Z', 'SUMMARY:Test late night'])
  await invite('offsite', ['DTSTART;VALUE=DATE:20261027', 'DTEND;VALUE=DATE:20261030', 'SUMMARY:Test offsite'])
  await invite('standup', ['DTSTART;TZID=Europe/Paris:20261005T090000', 'DTEND;TZID=Europe/Paris:20261005T093000',
    'RRULE:FREQ=WEEKLY', 'SUMMARY:Test standup'])
  await alice.page.waitForTimeout(2000)

  // 1. Monday 00:30 in Paris (Sunday 23:30 UTC): "Open in the calendar" shows that Monday's week
  assert.equal(await respondPage('Test late night'), 'lundi 26 octobre 2026 · 00:30 – 01:30')
  await openInCalendar()
  assert.match(alice.page.url(), /date=2026-10-26/)
  assert.equal(await alice.page.locator('.fc-event', { hasText: 'Test late night' }).count(), 1)
  console.log('ok 1 open in the calendar: local date of the event')

  // 2. a multi-day all-day invitation shows its last day
  assert.equal(await respondPage('Test offsite'), 'mardi 27 – jeudi 29 octobre 2026 · Toute la journée')
  await alice.page.screenshot({ path: `${out}/dates-2-offsite.png` })
  console.log('ok 2 multi-day all-day range')

  // 3. a series says it repeats, and opens the calendar on today rather than its first occurrence
  assert.equal(await respondPage('Test standup'), 'Récurrent, à partir du lundi 5 octobre 2026 · 09:00 – 09:30')
  await openInCalendar()
  assert.doesNotMatch(alice.page.url(), /date=/)
  await alice.page.locator('#oc-calendar-invitations-bell').click()
  await alice.page.waitForTimeout(800)
  const bell = await alice.page.locator('#oc-calendar-invitations-drop li', { hasText: 'Test standup' }).innerText()
  assert.match(bell, /Récurrent, à partir du lun\. 5 oct\., 09:00/)
  console.log('ok 3 recurring invitation')

  // 4. the invitations tab counts every pending invitation, like the bell, whatever the visible week
  await alice.page.goto(`${OC}/calendar?date=2026-10-19`)
  await alice.page.waitForSelector('.fc')
  await alice.page.waitForTimeout(2500)
  const total = (await pending()).length
  const tab = (await alice.page.getByRole('radio', { name: /Invitations/ }).innerText()).replace(/\s+/g, ' ').trim()
  assert.equal(tab, `Invitations ${total}`)
  console.log('ok 4 invitations tab count')

  // 5. another own calendar listed before "Agenda" (cal-… < def-calendar), shared with bob
  const extra = `/caldav/${alice.id}/cal-test-${stamp}/`
  assert.equal((await alice.call('MKCALENDAR', extra, `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Test extra</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`)).status, 201)
  cleanups.push(() => alice.call('DELETE', extra))
  const shared = await alice.call('PUT', `/calshare/v1/calendars/cal-test-${stamp}/shares/${bob.id}`, '{"permission":"read"}', { 'Content-Type': 'application/json' })
  assert.ok([200, 201].includes(shared.status), shared.text)
  // new events still go to "Agenda"
  await alice.page.evaluate(() => localStorage.removeItem('calendar.lastCalendar'))
  await alice.page.goto(`${OC}/calendar?date=2026-10-19`)
  await alice.page.waitForSelector('.fc')
  await alice.page.waitForTimeout(2000)
  await alice.page.getByRole('button', { name: /Nouvel événement/ }).click()
  await alice.page.waitForSelector('#event-title')
  assert.equal((await alice.page.locator('.oc-modal .vs__selected').first().textContent()).trim(), 'Agenda')
  await alice.page.keyboard.press('Escape')
  console.log('ok 5 new events default to the default calendar')

  // 6. bob, invited to an event of that calendar, sees it once: his own copy
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:shared-${stamp}`, 'DTSTAMP:20261001T000000Z',
    'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:Test shared invite', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  assert.equal((await alice.call('PUT', `${extra}shared.ics`, ics, { 'Content-Type': 'text/calendar' })).status, 201)
  assert.equal((await alice.call('PUT', `/calshare/v1/calendars/cal-test-${stamp}/events/shared.ics/guests`, JSON.stringify({ guests: [bob.id] }), { 'Content-Type': 'application/json' })).status, 200)
  await bob.page.goto(`${OC}/calendar?date=2026-10-19`)
  await bob.page.waitForSelector('.fc-event:has-text("Test shared invite")', { timeout: 20000 })
  await bob.page.waitForTimeout(2000)
  const copies = await bob.page.$$eval('.fc-event', (els) => els.filter((e) => e.textContent.includes('Test shared invite')).map((e) => e.className.includes('oc-ev-invitation')))
  assert.deepEqual(copies, [true])
  console.log('ok 6 invitation in a calendar shared with the guest shown once')

  // 7. phone width, week view: day headers don't overlap
  await alice.page.setViewportSize({ width: 390, height: 800 })
  await alice.page.waitForTimeout(1000)
  const boxes = await alice.page.$$eval('.fc-col-header-cell-cushion', (els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return [r.left, r.right]
  }))
  assert.equal(boxes.length, 7)
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], `header ${i} overlaps the previous one`)
  await alice.page.screenshot({ path: `${out}/dates-5-phone.png` })
  console.log('ok 7 week headers on a phone')

  assert.deepEqual(errors, [])
  console.log('all ok')
} finally {
  for (const f of files) await bob.call('DELETE', f)
  for (const cleanup of cleanups) await cleanup()
  await browser.close()
}
