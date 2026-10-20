// Editing edge cases in a real (headless) Chromium: recurring all-day series, changes made elsewhere while the page
// is open, occurrences changed on their own, "All day" toggle.
// usage: CHROMIUM=/snap/bin/chromium OC=https://localhost:9200 node test/ui-editing.mjs <screenshot dir> [user] [password]
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const OC = process.env.OC ?? 'https://localhost:9200'
const [out, user = 'alice', pass = 'Test-alice-12345'] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/snap/bin/chromium', headless: true })
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, timezoneId: 'Europe/Paris', locale: 'fr-FR' })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type=password], .fc', { timeout: 30000 })
if (await page.locator('input[type=password]').count()) {
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(pass)
  await page.keyboard.press('Enter')
}
await page.waitForSelector('.fc', { timeout: 30000 })

// CalDAV through the page's own session
const dav = (method, path, body, headers = {}) =>
  page.evaluate(async ({ method, path, body, headers }) => {
    let token
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) {
      const v = s.getItem(s.key(i))
      if (v?.includes('access_token')) token = JSON.parse(v).access_token
    }
    const r = await fetch(path, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } })
    return { status: r.status, text: await r.text() }
  }, { method, path, body, headers })
const me = JSON.parse((await dav('GET', '/graph/v1.0/me')).text).id
const cal = `/caldav/${me}/def-calendar/`
const stamp = Date.now()
const files = []
const put = (name, ...vevents) => {
  files.push(`${cal}${name}-${stamp}.ics`)
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    ...vevents.flatMap((v) => ['BEGIN:VEVENT', `UID:${name}-${stamp}`, 'DTSTAMP:20261001T000000Z', ...v, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n')
  return dav('PUT', `${cal}${name}-${stamp}.ics`, ics, { 'Content-Type': 'text/calendar' })
}
const stored = async (name) => (await dav('GET', `${cal}${name}-${stamp}.ics`)).text
const reload = async () => {
  await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.fc-event', { timeout: 20000 })
  await page.waitForTimeout(1500)
}
const event = (text) => page.locator('.fc-event', { hasText: text }).first()
const open = async (text) => { await event(text).evaluate((el) => el.click()); await page.waitForSelector('#event-title') }
const dates = () => page.locator('.field input').evaluateAll((els) => els.map((e) => e.value))

try {
  await put('ui-plain', ['DTSTART:20261020T080000Z', 'DTEND:20261020T090000Z', 'SUMMARY:UI plain', 'LOCATION:L1'])
  await put('ui-daily', ['DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261021', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:UI astreinte'])
  await put('ui-series',
    ['DTSTART;TZID=Europe/Paris:20261019T120000', 'DTEND;TZID=Europe/Paris:20261019T130000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:UI lunch'],
    ['RECURRENCE-ID;TZID=Europe/Paris:20261021T120000', 'DTSTART;TZID=Europe/Paris:20261021T150000', 'DTEND;TZID=Europe/Paris:20261021T160000', 'SUMMARY:UI lunch moved'])
  await reload()

  // 1. a recurring all-day series doesn't hide the calendar
  assert.equal(await page.locator('.fc-event', { hasText: 'UI astreinte' }).count(), 3)
  assert.equal(await page.locator('.fc-event', { hasText: 'UI plain' }).count(), 1)
  await page.screenshot({ path: `${out}/editing-1-week.png` })
  console.log('ok 1 recurring all-day series shown with the rest of the calendar')

  // 2. a drag from a page that hasn't seen a rename made elsewhere only moves the event
  await dav('PUT', `${cal}ui-plain-${stamp}.ics`, (await stored('ui-plain')).replace('SUMMARY:UI plain', 'SUMMARY:UI plain renamed').replace('LOCATION:L1', 'LOCATION:L2'), { 'Content-Type': 'text/calendar' })
  await event('UI plain').scrollIntoViewIfNeeded()
  const box = await event('UI plain').boundingBox()
  const day = async (d) => (await page.locator(`.fc-timegrid-col[data-date="${d}"]`).boundingBox()).x
  const dx = (await day('2026-10-21')) - (await day('2026-10-20'))
  await page.mouse.move(box.x + 10, box.y + 8); await page.mouse.down()
  await page.mouse.move(box.x + 10 + dx, box.y + 8, { steps: 10 }); await page.mouse.up()
  await page.waitForTimeout(2500)
  const moved = await stored('ui-plain')
  assert.match(moved, /DTSTART:20261021T080000Z/)
  assert.match(moved, /SUMMARY:UI plain renamed/)
  assert.match(moved, /LOCATION:L2/)
  console.log('ok 2 drag keeps a rename made elsewhere')

  // 3. an occurrence changed on its own is edited alone
  await reload()
  await open('UI lunch moved')
  await page.waitForSelector('text=modifiée séparément', { timeout: 5000 })
  await page.screenshot({ path: `${out}/editing-3-occurrence.png` })
  await page.locator('#event-title').fill('UI lunch moved (edited)')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.waitForTimeout(2500)
  const titles = (await page.locator('.fc-event').allTextContents()).filter((t) => t.includes('UI lunch'))
  assert.equal(titles.filter((t) => t.includes('UI lunch moved (edited)')).length, 1)
  assert.equal(titles.filter((t) => !t.includes('moved')).length, 2)
  console.log('ok 3 edit one occurrence changed on its own')

  // 4. "All day" keeps the dates visible
  await open('UI astreinte')
  await page.keyboard.press('Escape')
  await open('UI plain renamed')
  assert.deepEqual(await dates(), ['2026-10-21T10:00', '2026-10-21T11:00'])
  await page.getByText('Toute la journée', { exact: true }).last().click()
  assert.deepEqual(await dates(), ['2026-10-21', '2026-10-21'])
  await page.screenshot({ path: `${out}/editing-4-all-day.png` })
  await page.getByText('Toute la journée', { exact: true }).last().click()
  assert.deepEqual(await dates(), ['2026-10-21T09:00', '2026-10-21T10:00'])
  await page.keyboard.press('Escape')
  console.log('ok 4 all-day toggle keeps the dates')

  assert.deepEqual(errors, [])
  console.log('all ok')
} finally {
  for (const f of files) await dav('DELETE', f)
  await browser.close()
}
