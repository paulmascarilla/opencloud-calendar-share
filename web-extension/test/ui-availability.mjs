// Availability, in a real (headless) Chromium with three users: bob's busy times over alice's week ("People"),
// without his titles and without what alice already sees; the editor's timeline finds a time free for everyone;
// Busy / Free on an event changes what others see. Fixtures in the week of 26 Oct 2026 (after the DST change).
// usage: [BROWSER=firefox] OC=https://localhost:9200 TOKENS_FILE=tokens.env node test/ui-availability.mjs <screenshot dir>
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { launch } from './browser.mjs'
const OC = process.env.OC ?? 'https://localhost:9200'
const out = process.argv[2] ?? '.'
const browser = await launch()
const errors = []

async function session(user, { viewport = { width: 1400, height: 900 }, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, colorScheme, timezoneId: 'Europe/Paris', locale: 'fr-FR' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`[${user}] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`[${user}] HTTP ${r.status()} ${r.url()}`) })
  await page.goto(`${OC}/calendar?date=2026-10-26`, { waitUntil: 'domcontentloaded' })
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
      return { status: r.status, text: await r.text() }
    }, { method, path, body, headers })
  const id = JSON.parse((await call('GET', '/graph/v1.0/me')).text).id
  return { page, call, id }
}

// admin only owns a fixture: app token from TOKENS_FILE (admin=<token>)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const tokens = readFileSync(process.env.TOKENS_FILE ?? 'tokens.env', 'utf8')
const adminAuth = 'Basic ' + Buffer.from(`admin:${tokens.match(/^admin=(.*)$/m)[1]}`).toString('base64')
const adminCall = async (method, path, body, headers = {}) => {
  const r = await fetch(OC + path, { method, body, headers: { Authorization: adminAuth, ...headers } })
  return { status: r.status, text: await r.text() }
}
const admin = { call: adminCall, id: JSON.parse((await adminCall('GET', '/graph/v1.0/me')).text).id }
const bob = await session('bob')
const alice = await session('alice')
const stamp = Date.now()
const files = []
async function put(who, name, lines) {
  const file = `/caldav/${who.id}/def-calendar/${name}-${stamp}.ics`
  files.push([who, file])
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', `UID:${name}-${stamp}`,
    'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  assert.equal((await who.call('PUT', file, ics, { 'Content-Type': 'text/calendar' })).status, 201)
  return file
}
const paris = (day, time) => `;TZID=Europe/Paris:202610${day}T${time.replace(':', '')}00`
const secret = `Secret-${stamp}`

try {
  // bob: a daily standup (expanded by Radicale), a private meeting, a "maybe", a vacation day, a birthday (free)
  await put(bob, 'standup', [`DTSTART${paris(26, '09:30')}`, `DTEND${paris(26, '09:45')}`, 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Standup'])
  await put(bob, 'secret', [`DTSTART${paris(28, '10:00')}`, `DTEND${paris(28, '11:00')}`, `SUMMARY:${secret}`, 'LOCATION:Salle RH'])
  await put(bob, 'maybe', [`DTSTART${paris(28, '15:00')}`, `DTEND${paris(28, '16:00')}`, 'STATUS:TENTATIVE', 'SUMMARY:Peut-être'])
  await put(bob, 'vacation', ['DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261031', 'TRANSP:OPAQUE', 'SUMMARY:Congés'])
  await put(bob, 'birthday', ['DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261030', 'SUMMARY:Anniversaire'])
  await put(bob, 'public', [`DTSTART${paris(29, '16:00')}`, `DTEND${paris(29, '17:00')}`, 'SUMMARY:Formation publique',
    'LOCATION:Salle 2', 'X-OC-VISIBILITY:PUBLIC', 'DESCRIPTION:notes internes'])
  await put(admin, 'review', [`DTSTART${paris(28, '11:00')}`, `DTEND${paris(28, '12:00')}`, 'SUMMARY:Revue'])
  // an event alice is invited to: she sees her own copy, and must not see bob's busy block for it too
  const shared = await put(bob, 'shared', [`DTSTART${paris(27, '14:00')}`, `DTEND${paris(27, '15:00')}`, `SUMMARY:Shared-${stamp}`])
  const guests = await bob.call('PUT', `/calshare/v1/calendars/def-calendar/events/${shared.split('/').pop()}/guests`,
    JSON.stringify({ guests: [alice.id] }), { 'Content-Type': 'application/json' })
  assert.equal(guests.status, 200, guests.text)
  await alice.page.waitForTimeout(3000)

  // 1. alice adds bob in "People": his busy times appear over her week
  const page = alice.page
  await page.reload()
  await page.waitForSelector('.fc-timegrid', { timeout: 20000 })
  await page.getByRole('heading', { name: 'Personnes' }).waitFor({ timeout: 10000 })
  await page.locator('aside').getByRole('button', { name: 'Ajouter une personne' }).click()
  const search = page.locator('.oc-modal input[placeholder="Rechercher par nom, identifiant ou e-mail"]')
  await search.click()
  await search.fill('bob')
  await page.locator('.vs__dropdown-option', { hasText: 'bob' }).first().click({ timeout: 10000 })
  await page.screenshot({ path: `${out}/availability-0-add-person.png` })
  await page.locator('.oc-modal').getByRole('button', { name: 'Ajouter', exact: true }).click()
  await page.waitForSelector('.fc-event.oc-busy', { timeout: 15000 })
  await page.waitForTimeout(1500)
  const busy = page.locator('.fc-event.oc-busy')
  const titles = await busy.evaluateAll((els) => els.map((e) => e.title))
  console.log('bob busy blocks:', titles)
  assert.equal(titles.filter((t) => /09:30/.test(t)).length, 5, 'one standup per day (recurrence expanded)')
  assert.ok(titles.some((t) => /10:00 - 11:00|10:00 – 11:00/.test(t) && /Occupé/.test(t)), 'the private meeting is busy')
  assert.ok(titles.some((t) => /Peut-être/.test(t)), 'the tentative event is a "maybe"')
  const html = await page.locator('.oc-calendar').innerHTML()
  for (const hidden of [secret, 'Salle RH', 'Congés', 'Anniversaire', 'notes internes']) assert.ok(!html.includes(hidden), `"${hidden}" must not show`)
  assert.ok(titles.some((t) => t.startsWith('bob · Formation publique')), 'a public event shows its title')
  assert.ok(html.includes('Salle 2'), 'and its place')
  assert.equal(await page.locator('.fc-daygrid-event.oc-busy').count(), 1, 'the vacation (busy all day), not the birthday')
  // the shared event: once, as alice's own copy, no busy block next to it
  assert.equal(await page.locator('.fc-event', { hasText: `Shared-${stamp}` }).count(), 1)
  assert.ok(!titles.some((t) => /14:00/.test(t)), 'no duplicate busy block for the event alice is invited to')
  await page.screenshot({ path: `${out}/availability-1-people.png` })
  console.log('ok 1 people overlay: busy times only, no duplicate')

  // 2. new event with bob and admin at a time both are busy: the timeline says so and finds a free time
  await page.getByRole('button', { name: /Nouvel événement/ }).click()
  await page.waitForSelector('#event-title')
  await page.locator('#event-title').fill(`Point dispo ${stamp}`)
  const [start, end] = await page.locator('.oc-modal input[type=datetime-local]').all()
  await start.fill('2026-10-28T10:30')
  await end.fill('2026-10-28T11:30')
  for (const name of ['bob', 'admin']) {
    const guest = page.locator('.oc-modal input[placeholder="Rechercher par nom, identifiant ou e-mail"]')
    await guest.click()
    await guest.fill(name)
    await page.locator('.vs__dropdown-option', { hasText: name === 'bob' ? 'bob' : 'Admin' }).first().click({ timeout: 10000 })
  }
  const timeline = page.locator('.oc-modal .availability')
  await timeline.waitFor({ timeout: 10000 })
  assert.equal(await timeline.locator('.legend').count(), 0, 'no legend')
  await timeline.locator('.state.clash').waitFor({ timeout: 10000 })
  const verdict = (await timeline.locator('.verdict').textContent()).replace(/\s+/g, ' ').trim()
  console.log('verdict:', verdict)
  assert.match(verdict, /bob et Admin ne sont pas disponibles/)
  assert.equal(await timeline.locator('.row:not(.axis)').count(), 3, 'you + 2 guests')
  assert.ok(await timeline.locator('.seg.conflict').count() >= 2)
  await timeline.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${out}/availability-2-conflict.png` })
  await timeline.locator('.suggest').click()
  await timeline.locator('.state.free').waitFor({ timeout: 5000 })
  const moved = await start.inputValue()
  console.log('moved to:', moved, '-', await end.inputValue())
  assert.notEqual(moved, '2026-10-28T10:30')
  assert.ok(moved >= '2026-10-28T12:00', 'after both conflicts')
  await page.screenshot({ path: `${out}/availability-3-free.png` })
  console.log('ok 2 the timeline finds the next time everyone is free')

  // 3. clicking the timeline moves the event there (same duration)
  const track = timeline.locator('.row:not(.axis) .track').first()
  await track.scrollIntoViewIfNeeded()
  const box = await track.boundingBox()
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
  const clicked = await start.inputValue()
  assert.match(clicked, /^2026-10-28T1[34]:/, `clicked mid-day: ${clicked}`)
  console.log('ok 3 click on the timeline moves the event:', clicked)

  // 3b. saved as public: bob sees its title in alice's availability
  await page.locator('.oc-modal').getByRole('radio', { name: 'Public' }).click()
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.waitForSelector(`.fc-event:has-text("Point dispo ${stamp}")`, { timeout: 15000 })
  const seen = JSON.parse((await bob.call('GET', `/calshare/v1/freebusy?users=${alice.id}&start=2026-10-28T00:00:00Z&end=2026-10-29T00:00:00Z`)).text)
  assert.ok(seen.users[0].busy.some((b) => b.title === `Point dispo ${stamp}`), JSON.stringify(seen))
  await page.locator('.fc-event', { hasText: `Point dispo ${stamp}` }).first().click()
  await page.getByRole('button', { name: /Supprimer l.événement/ }).click()
  await page.locator('.oc-modal').getByRole('button', { name: 'Supprimer' }).click()
  await page.waitForTimeout(1500)
  console.log('ok 3b a public event shows its title to others')

  // 4. bob marks his private meeting "Free": it leaves alice's overlay
  const secretFile = files.find(([, f]) => f.includes('/secret-'))[1]
  const ics = (await bob.call('GET', secretFile)).text.replace('LOCATION:Salle RH', 'LOCATION:Salle RH\r\nTRANSP:TRANSPARENT')
  assert.equal((await bob.call('PUT', secretFile, ics, { 'Content-Type': 'text/calendar' })).status, 204)
  await page.reload()
  await page.waitForSelector('.fc-event.oc-busy', { timeout: 20000 })
  await page.waitForTimeout(1500)
  const after = await page.locator('.fc-event.oc-busy').evaluateAll((els) => els.map((e) => e.title))
  assert.ok(!after.some((t) => /10:00 - 11:00|10:00 – 11:00/.test(t)), 'a free event is not busy')
  console.log('ok 4 an event shown as free does not block')

  // 5. dark theme, phone width
  const dark = await session('alice', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
  await dark.page.evaluate((id) => localStorage.setItem('calendar.people', JSON.stringify([{ id, name: 'bob', color: '#9370db' }])), bob.id)
  await dark.page.reload()
  await dark.page.waitForSelector('.fc', { timeout: 20000 })
  await dark.page.waitForTimeout(2000)
  await dark.page.screenshot({ path: `${out}/availability-5-phone-dark-agenda.png` })
  await dark.page.locator('button[aria-label="Afficher les agendas"], button[aria-label="Show calendars"]').first().click().catch(() => {})
  await dark.page.waitForTimeout(2000)
  await dark.page.screenshot({ path: `${out}/availability-4-phone-dark.png` })

  // cleanup: alice stops showing bob
  await page.locator('aside .person').filter({ hasText: 'bob' }).hover()
  await page.getByRole('button', { name: 'Ne plus afficher bob' }).click()
  await page.waitForTimeout(800)
  assert.equal(await page.locator('.fc-event.oc-busy').count(), 0)
  console.log('ok 5 removing a person clears the overlay')
} finally {
  for (const [who, file] of files.reverse()) await who.call('DELETE', file)
  await browser.close()
}
if (errors.length) {
  console.log(errors.join('\n'))
  process.exit(1)
}
