// Proposing another time, in a real (headless) Chromium with two users: a guest moves their copy in a
// CalDAV client (undone, becomes a proposal), the organizer accepts it; a guest proposes from the web app
// and from the invitation page, the organizer declines.
// usage: CHROMIUM=/snap/bin/chromium OC=https://localhost:9200 node test/ui-proposals.mjs <screenshot dir>
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const OC = process.env.OC ?? 'https://localhost:9200'
const out = process.argv[2] ?? '.'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/snap/bin/chromium', headless: true })
const errors = []

async function session(user) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, timezoneId: 'Europe/Paris', locale: 'fr-FR' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`[${user}] ${e.message}`))
  await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password]', { timeout: 30000 })
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(`Test-${user}-12345`)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.fc', { timeout: 30000 })
  const call = (method, path, body, headers = {}) =>
    page.evaluate(async ({ method, path, body, headers }) => {
      let token
      for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) {
        const v = s.getItem(s.key(i))
        if (v?.includes('access_token')) token = JSON.parse(v).access_token
      }
      const r = await fetch(path, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } })
      return { status: r.status, text: await r.text(), etag: r.headers.get('etag') }
    }, { method, path, body, headers })
  const id = JSON.parse((await call('GET', '/graph/v1.0/me')).text).id
  return { page, call, id }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const unfold = (text) => text.replace(/\r\n/g, '\n').replace(/\n /g, '')

const alice = await session('alice')
const bob = await session('bob')
const stamp = Date.now()
const file = `proposal-${stamp}.ics`
const master = `/caldav/${alice.id}/def-calendar/${file}`
const copy = `/caldav/${bob.id}/def-calendar/${file}`
const open = async (s, title) => {
  await s.page.goto(`${OC}/calendar?date=2026-10-19`)
  await s.page.waitForSelector(`.fc-event:has-text("${title}")`, { timeout: 20000 })
  await s.page.waitForTimeout(1500)
  await s.page.locator('.fc-event', { hasText: title }).first().evaluate((el) => el.click())
  await s.page.waitForSelector('#event-title')
}

try {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:proposal-${stamp}`,
    'DTSTAMP:20261001T000000Z', 'DTSTART:20261022T080000Z', 'DTEND:20261022T090000Z', 'SUMMARY:Test proposal',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  assert.equal((await alice.call('PUT', master, ics, { 'Content-Type': 'text/calendar' })).status, 201)
  assert.equal((await alice.call('PUT', `/calshare/v1/calendars/def-calendar/events/${file}/guests`, JSON.stringify({ guests: [bob.id] }),
    { 'Content-Type': 'application/json' })).status, 200)
  await wait(3000)

  // 1. bob's copy names everyone by e-mail: his CalDAV client sees an invitation, not his own event
  let got = await bob.call('GET', copy)
  assert.match(unfold(got.text), /\nORGANIZER[^\n]*:mailto:alice@example\.org\n/)
  assert.match(unfold(got.text), /\nATTENDEE[^\n]*:mailto:bob@example\.org\n/)
  console.log('ok 1 the copy is an invitation for CalDAV clients')

  // 2. bob moves his copy in GNOME Calendar: undone, and alice gets a proposal
  const moved = got.text
    .replace('DTSTART:20261022T080000Z', 'DTSTART;TZID=/freeassociation.sourceforge.net/Europe/Paris:20261023T140000')
    .replace('DTEND:20261022T090000Z', 'DTEND;TZID=/freeassociation.sourceforge.net/Europe/Paris:20261023T150000')
  assert.equal((await bob.call('PUT', copy, moved, { 'Content-Type': 'text/calendar', 'If-Match': got.etag })).status, 204)
  await wait(4000)
  assert.match((await bob.call('GET', copy)).text, /\nDTSTART:20261022T080000Z\r?\n/)
  await open(alice, 'Test proposal')
  assert.ok((await alice.page.locator('.fc-event', { hasText: 'Test proposal' }).first().getAttribute('class')).includes('oc-ev-proposal'))
  const proposal = alice.page.locator('.oc-modal .proposal')
  assert.match(await proposal.innerText(), /Propose ven\. 23 oct\.,? 14:00\s*–\s*15:00/)
  await alice.page.screenshot({ path: `${out}/proposals-2-organizer.png` })
  console.log('ok 2 a moved copy is put back and becomes a proposal')

  // 3. alice accepts: the event moves, bob's copy follows
  await proposal.getByRole('button', { name: 'Accepter' }).click()
  await wait(3500)
  assert.match((await alice.call('GET', master)).text, /\nDTSTART:20261023T120000Z\r?\n/)
  assert.match((await bob.call('GET', copy)).text, /\nDTSTART:20261023T120000Z\r?\n/)
  assert.equal(await alice.page.locator('.fc-timegrid-col[data-date="2026-10-23"] .fc-event', { hasText: 'Test proposal' }).count(), 1)
  console.log('ok 3 the organizer accepts the proposal')

  // 4. bob proposes from the web app; alice declines
  await open(bob, 'Test proposal')
  await bob.page.getByRole('button', { name: /Proposer un autre horaire/ }).click()
  const [start, end] = await bob.page.locator('.oc-modal form form input').all()
  await start.fill('2026-10-24T10:00')
  await end.fill('2026-10-24T11:00')
  await bob.page.screenshot({ path: `${out}/proposals-4-guest.png` })
  await bob.page.getByRole('button', { name: 'Envoyer la proposition' }).click()
  await wait(3000)
  assert.match(unfold((await alice.call('GET', master)).text), /X-OC-PROPOSED-START=20261024T080000Z/)
  await open(alice, 'Test proposal')
  await alice.page.locator('.oc-modal .proposal').getByRole('button', { name: 'Refuser' }).click()
  await wait(3000)
  assert.doesNotMatch((await alice.call('GET', master)).text, /X-OC-PROPOSED/)
  console.log('ok 4 the guest proposes from the web app, the organizer declines')

  // 5. the invitation page (the link in CalDAV clients) offers the same
  await bob.page.goto(`${OC}/calendar/respond?cal=def-calendar&event=${file}`)
  await bob.page.waitForSelector('text=Participerez', { timeout: 20000 })
  await bob.page.getByRole('button', { name: /Proposer un autre horaire/ }).click()
  const [s2, e2] = await bob.page.locator('form input').all()
  await s2.fill('2026-10-26T09:00')
  await e2.fill('2026-10-26T10:00')
  await bob.page.getByRole('button', { name: 'Envoyer la proposition' }).click()
  await wait(3000)
  assert.match(unfold((await alice.call('GET', master)).text), /X-OC-PROPOSED-START=20261026T080000Z/)
  await bob.page.screenshot({ path: `${out}/proposals-5-respond.png` })
  console.log('ok 5 proposing from the invitation page')

  assert.deepEqual(errors, [])
  console.log('all ok')
} finally {
  await alice.call('DELETE', master)
  await browser.close()
}
