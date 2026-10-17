// Captures the real calendar app (OpenCloud Web + extension) in each state the film shows.
// Snapshots are the film's source of truth: 1200 × 730 window points at 3×, plus element rects.
// usage: CHROMIUM=/snap/bin/chromium OC=https://localhost:9200 node tools/capture.mjs
// Needs the demo data of tools/seed.sh (tokens in tools/tokens.env).
import { chromium } from '../../../web-extension/node_modules/playwright-core/index.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'assets', 'capture')
const OC = process.env.OC ?? 'https://localhost:9200'
const W = 1200, H = 730, TALL = 2520, SCALE = 3
const env = Object.fromEntries(readFileSync(join(HERE, 'tokens.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
const PASS = { camille: 'Demo-camille-2026!' }
mkdirSync(OUT, { recursive: true })
const ONLY = process.env.ONLY ?? ''
const rects = ONLY ? JSON.parse(readFileSync(join(OUT, 'rects.json'), 'utf8')) : {}

const auth = (u) => 'Basic ' + Buffer.from(`${u}:${env[u]}`).toString('base64')
const api = (u, method, path, body) =>
  fetch(OC + path, { method, body, headers: { Authorization: auth(u), 'Content-Type': 'application/json' } }).then((r) => r.status)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/snap/bin/chromium', headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: SCALE,
  colorScheme: 'light', locale: 'en-US', timezoneId: 'Europe/Paris'
})
const page = await context.newPage()
page.on('pageerror', (e) => console.warn('page error:', e.message))

// Hide what must not be in the film: the moving "now" line, tooltips, the text caret.
const FILM_CSS = `
  .fc-timegrid-now-indicator-line, .fc-timegrid-now-indicator-arrow { display: none !important; }
  * { caret-color: transparent !important; }
  .tippy-box, [data-tippy-root] { display: none !important; }`

async function settle(ms = 900) {
  await page.addStyleTag({ content: FILM_CSS }).catch(() => {})
  await page.waitForTimeout(ms)
}

/** Rect of the first element matching each selector, in window points (relative to the page). */
async function measure(selectors) {
  const out = {}
  for (const [name, sel] of Object.entries(selectors)) {
    const box = await page.locator(sel).first().boundingBox().catch(() => null)
    if (box) out[name] = { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 }
  }
  return out
}

async function shot(name, selectors = {}) {
  await settle()
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  rects[name] = await measure(selectors)
  console.log('captured', name, Object.keys(rects[name]).join(' '))
}

/** The whole day of the time grid, for scrolling in the film. */
async function tallShot(name, selectors = {}) {
  await page.setViewportSize({ width: W, height: TALL })
  await settle(1200)
  await page.screenshot({ path: join(OUT, `${name}-tall.png`) })
  rects[`${name}-tall`] = await measure({
    scroller: '.fc-timegrid-body', h08: '.fc-timegrid-slot-lane[data-time="08:00:00"]', h14: '.fc-timegrid-slot-lane[data-time="14:00:00"]', ...selectors
  })
  await page.setViewportSize({ width: W, height: H })
  await settle(600)
  console.log('captured', `${name}-tall`)
}

const scrollGridTo = (time) =>
  page.evaluate((t) => {
    const lane = document.querySelector(`.fc-timegrid-slot-lane[data-time="${t}"]`)
    const scroller = lane?.closest('.fc-scroller')
    if (lane && scroller) scroller.scrollTop = lane.offsetTop
  }, time)

const CAL = {
  card: '.oc-calendar', toolbar: '.oc-calendar header', sidebar: 'aside', scroller: '.fc-timegrid-body',
  scrollView: '.fc-scroller-liquid-absolute, .fc-timegrid .fc-scroller', newEvent: 'button:has-text("New event")',
  next: 'button[aria-label="Next"]', bell: '#oc-calendar-invitations-bell'
}
const ev = (title) => `.fc-event:has-text("${title}")`

// ---- 0. prepare the "new invitation" moment: Camille is not invited yet ---------------------------
await api('ines', 'PUT', '/calshare/v1/calendars/def-calendar/events/film-demo.ics/guests', '{"guests":["noah"]}')
await sleep(2500)

// ---- 1. log in as Camille, the week of 19 Oct ------------------------------------------------------
await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type=password]')
await page.locator('input:not([type=password]):not([type=hidden])').first().fill('camille')
await page.locator('input[type=password]').fill(PASS.camille)
await page.keyboard.press('Enter')
await page.waitForSelector('.fc-event', { timeout: 30000 })
await page.locator('.v-select.view-select').click()
await page.getByRole('option', { name: 'Week view' }).click()
await settle(1500)

// ONLY=editor: recapture the week afternoon, the New event dialog and "Event created" (deletes the earlier Design review)
if (ONLY === 'editor') {
  const old = await page.evaluate(() => [...document.querySelectorAll('.fc-event')].some((e) => e.textContent.includes('Design review')))
  if (old) {
    const res = await fetch(`${OC}/caldav/${env.camille_id}/def-calendar/`, { method: 'REPORT', headers: { Authorization: auth('camille'), Depth: '1', 'Content-Type': 'application/xml' },
      body: '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>' }).then((r) => r.text())
    for (const m of res.matchAll(/<[\w:]*response>([\s\S]*?)<\/[\w:]*response>/g)) {
      const href = m[1].match(/<[\w:]*href>([^<]+)/)?.[1]
      if (href && m[1].includes('SUMMARY:Design review')) await fetch(OC + href, { method: 'DELETE', headers: { Authorization: auth('camille') } })
    }
    await sleep(3000)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.fc-event', { timeout: 30000 })
    await settle(1500)
  }
}

/** The dialog's scrolling body: its rect, scrollTop, and optionally scroll it to the bottom. */
const modalBody = (toBottom = false) =>
  page.evaluate((bottom) => {
    const modal = document.querySelector('.oc-modal')
    const el = [modal, ...modal.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
    if (!el) return null
    if (bottom) el.scrollTop = el.scrollHeight
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, scroll: el.scrollTop }
  }, toBottom)

if (!ONLY || ONLY === 'editor') {
if (!ONLY) {
await shot('week', { ...CAL, sprint: ev('Sprint planning'), roadmap: ev('Roadmap workshop') })
await tallShot('week', { sprint: ev('Sprint planning'), weekly: ev('Weekly review') })
}

// ---- 2. plan: drag Wednesday 14:00–15:30 → New event ------------------------------------------------
await scrollGridTo('12:00:00')
await settle()
await shot('week-afternoon', { ...CAL, wed: '.fc-timegrid-col[data-date="2026-10-21"]', s14: '.fc-timegrid-slot-lane[data-time="14:00:00"]', s15: '.fc-timegrid-slot-lane[data-time="15:00:00"]' })
const col = await page.locator('.fc-timegrid-col[data-date="2026-10-21"]').boundingBox()
const y14 = (await page.locator('.fc-timegrid-slot-lane[data-time="14:00:00"]').boundingBox()).y
const y15 = (await page.locator('.fc-timegrid-slot-lane[data-time="15:00:00"]').boundingBox()).y
const slot = y15 - y14
await page.mouse.move(col.x + col.width / 2, y14 + 4)
await page.mouse.down()
await page.mouse.move(col.x + col.width / 2, y15 + slot / 2 + 4, { steps: 8 })
await shot('select', { mirror: '.fc-highlight, .fc-event-mirror' })
await page.mouse.up()
await page.waitForSelector('#event-title')
await shot('editor-empty', { modal: '.oc-modal', title: '#event-title', save: '.oc-modal button:has-text("Save")' })
await page.locator('#event-title').fill('Design review')
await shot('editor-title', { modal: '.oc-modal', title: '#event-title' })
await page.getByRole('radio', { name: 'Purple' }).click()
await shot('editor-color', { modal: '.oc-modal', swatch: '[role=radio][aria-label="Purple"]', guests: 'input[placeholder^="Search people"]' })
const search = page.locator('input[placeholder^="Search people"]')
await search.click()
await search.fill('noa')
await page.waitForSelector('.vs__dropdown-option:has-text("Noah")', { timeout: 15000 })
const bodyColor = await modalBody()
await page.waitForTimeout(300)
const bodySearch = await modalBody(true) // the result list lies under the field: scroll it into view
await shot('editor-search', { modal: '.oc-modal', option: '.vs__dropdown-option:has-text("Noah")', guests: 'input[placeholder^="Search people"]' })
rects['editor-search'].body = bodySearch
rects['editor-color'].body = bodyColor ?? { ...bodySearch, scroll: 0 }
await page.locator('.vs__dropdown-option', { hasText: 'Noah' }).first().click()
await page.locator('.oc-modal').getByText('New event', { exact: true }).first().click() // close the dropdown, no text selected
await page.waitForTimeout(300)
const bodyGuest = await modalBody(true)
await shot('editor-guest', { modal: '.oc-modal', guest: '.oc-modal li:has-text("Noah")', save: '.oc-modal button:has-text("Save")' })
rects['editor-guest'].body = bodyGuest
await page.locator('.oc-modal button:has-text("Save")').click()
await page.waitForSelector(ev('Design review'), { timeout: 15000 })
await page.locator('.oc-notification-message').first().waitFor({ state: 'visible', timeout: 10000 })
await page.waitForTimeout(600)
await shot('saved', { ...CAL, created: ev('Design review'), toast: '.oc-notification-message, .oc-notification' })
await page.waitForTimeout(5500) // toast gone

}
if (!ONLY) {
// ---- 3. invited: Camille works in Files, Inès invites her ------------------------------------------
await page.goto(`${OC}/files`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#files, .files-list, #oc-notifications-bell', { timeout: 30000 })
await page.waitForTimeout(6000) // feed baseline taken
await api('ines', 'PUT', '/calshare/v1/calendars/def-calendar/events/film-demo.ics/guests', '{"guests":["camille","noah"]}')
await page.locator('#oc-calendar-invitations-bell').waitFor({ timeout: 60000 })
await page.getByText('New invitation').first().waitFor({ timeout: 10000 })
await shot('files-invited', { bell: '#oc-calendar-invitations-bell', bellNative: '#oc-notifications-bell', toast: '.oc-notification-message:has-text("New invitation")', topbar: '#oc-topbar, header' })
await page.waitForTimeout(6500) // toast gone

// the invitation as it looks in the week before answering (dashed, pending)
await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.fc-event', { timeout: 30000 })
await scrollGridTo('12:00:00')
await shot('week-pending', { ...CAL, demo: ev('Customer demo') })
await tallShot('week-pending', { demo: ev('Customer demo') })

// back in Files: the bell, its dropdown, Accept
await page.goto(`${OC}/files`, { waitUntil: 'domcontentloaded' })
await page.locator('#oc-calendar-invitations-bell').waitFor({ timeout: 30000 })
await shot('files-bell', { bell: '#oc-calendar-invitations-bell', bellNative: '#oc-notifications-bell' })
await page.locator('#oc-calendar-invitations-bell').click()
await page.waitForSelector('#oc-calendar-invitations-drop li')
await shot('bell-open', { bell: '#oc-calendar-invitations-bell', drop: '#oc-calendar-invitations-drop', accept: '#oc-calendar-invitations-drop button:has-text("Accept")' })
await page.locator('#oc-calendar-invitations-drop button:has-text("Accept")').first().click()
await page.waitForTimeout(1500)
await shot('bell-accepted', { toast: '.oc-notification-message', bell: '#oc-notifications-bell' })
await page.waitForTimeout(5500)

// ---- 4. the week with the invitation (filled), Friday afternoon -------------------------------------
await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.fc-event', { timeout: 30000 })
await scrollGridTo('12:00:00')
await shot('week-invite', { ...CAL, demo: ev('Customer demo'), design: ev('Design review') })
await tallShot('week-invite', { demo: ev('Customer demo'), design: ev('Design review'), coffee: ev('Coffee chat') })

// ---- 5. answer from a CalDAV client's link: a new tab opened on the link -----------------------------
const retroIcs = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//launch-film//EN', 'BEGIN:VEVENT', 'UID:film-retro', 'DTSTAMP:20261017T080000Z',
  'DTSTART;TZID=Europe/Paris:20261022T163000', 'DTEND;TZID=Europe/Paris:20261022T173000', 'SUMMARY:Sprint retro', 'COLOR:teal',
  'DESCRIPTION:What went well, what we change for sprint 43.', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
await fetch(`${OC}/caldav/${env.noah_id}/def-calendar/film-retro.ics`, { method: 'PUT', body: retroIcs, headers: { Authorization: auth('noah'), 'Content-Type': 'text/calendar' } })
await api('noah', 'PUT', '/calshare/v1/calendars/def-calendar/events/film-retro.ics/guests', '{"guests":["camille"]}')
await sleep(3000)
const answer = await context.newPage()
await answer.goto(`${OC}/calendar/respond?cal=def-calendar&event=film-retro.ics&response=accepted`, { waitUntil: 'domcontentloaded' })
await answer.waitForSelector('.saved', { timeout: 30000 })
await answer.addStyleTag({ content: FILM_CSS })
await answer.waitForTimeout(150)
await answer.screenshot({ path: join(OUT, 'respond.png') })
rects.respond = {}
for (const [k, s] of Object.entries({ card: 'section', saved: '.saved', buttons: 'section .ext\\:border-t', source: '.source-link' })) {
  const b = await answer.locator(s).first().boundingBox().catch(() => null)
  if (b) rects.respond[k] = { x: b.x, y: b.y, w: b.width, h: b.height }
}
console.log('captured respond', answer.url().replace(OC, ''))
await answer.close().catch(() => {})

} // !ONLY

if (!ONLY || ONLY === 'sharing') {
// ---- 6. share a calendar with Inès -------------------------------------------------------------------
await page.goto(`${OC}/calendar/sharing`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.calendar-card', { timeout: 30000 })
await shot('sharing', { card: '.calendar-card:has-text("Events")', picker: '.calendar-card input[placeholder^="Search people"]' })
// the card titled exactly "Calendar" (not Tasks, not another events calendar)
const card = page.locator('.calendar-card').filter({ has: page.locator('h3', { hasText: /^\s*Calendar\b/ }) }).first()
const picker = card.locator('input[placeholder^="Search people"]')
await picker.click()
await picker.fill('Inè')
await page.waitForSelector('.vs__dropdown-option:has-text("Inès")', { timeout: 15000 })
await shot('sharing-search', { card: '.calendar-card:has-text("Events")', option: '.vs__dropdown-option:has-text("Inès")' })
await page.locator('.vs__dropdown-option', { hasText: 'Inès' }).first().click()
const perm = card.locator('.v-select').nth(1)
await perm.click()
await page.getByRole('option', { name: 'Can edit' }).click()
await shot('sharing-ready', { card: '.calendar-card:has-text("Events")', share: '.calendar-card:has-text("Events") button:has-text("Share")' })
await card.locator('button:has-text("Share")').click()
await page.getByText('is now shared with').first().waitFor({ timeout: 15000 })
await shot('sharing-done', { card: '.calendar-card:has-text("Events")', row: '.calendar-card:has-text("Events") li:has-text("Inès")', toast: '.oc-notification-message' })
await page.waitForTimeout(5500)
}

if (!ONLY) {
// ---- 7. a new calendar -------------------------------------------------------------------------------
await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.fc-event', { timeout: 30000 })
await shot('sidebar', { button: 'aside button:has-text("New calendar")', sidebar: 'aside' })
await page.locator('aside button:has-text("New calendar")').click()
await page.locator('#calendar-name').fill('Projects')
await page.getByRole('radio', { name: 'Orange' }).click()
await shot('newcal', { modal: '.oc-modal', name: '#calendar-name', create: '.oc-modal button:has-text("Create")' })
await page.locator('.oc-modal button:has-text("Create")').click()
await page.locator('aside', { hasText: 'Projects' }).waitFor({ timeout: 15000 })
await page.waitForTimeout(5500)
await shot('newcal-done', { item: 'aside li:has-text("Projects")', sidebar: 'aside' })

// ---- 8. month view -----------------------------------------------------------------------------------
await page.locator('.v-select.view-select').click()
await page.getByRole('option', { name: 'Month view' }).click()
await shot('month', { card: '.oc-calendar' })

} // !ONLY

writeFileSync(join(OUT, 'rects.json'), JSON.stringify(rects, null, 1))
console.log(`done: ${Object.keys(rects).length} states in ${OUT}`)
await browser.close()
