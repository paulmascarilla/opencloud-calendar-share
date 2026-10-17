// Integration test of src/ical.ts against the real Radicale, through the OpenCloud proxy.
//   OC=https://localhost:9200 ALICE=alice:<app token> BOB=bob:<app token> pnpm test:integration
import assert from 'node:assert/strict'
import { EventDraft, newEventIcs, parseInstances, updatedEventIcs } from "../src/ical"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const OC = process.env.OC ?? 'https://localhost:9200'
const ALICE_ID = 'be578ae3-5d68-4ad0-9cb2-0e0c9123e76d'
const BOB_ID = '4fbd8358-64a7-419a-87a7-61485582660e'

async function call(who: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const auth = 'Basic ' + Buffer.from(process.env[who.toUpperCase()]!).toString('base64')
  const res = await fetch(OC + path, { method, body, headers: { Authorization: auth, ...headers } })
  return { status: res.status, etag: res.headers.get('etag') ?? '', text: await res.text() }
}

async function report(who: string, cal: string) {
  const range = 'start="20261001T000000Z" end="20261201T000000Z"'
  const { text } = await call(who, 'REPORT', cal,
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand ${range}/></C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range ${range}/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
    { Depth: '1', 'Content-Type': 'application/xml' })
  const out = []
  for (const m of text.matchAll(/<href>([^<]+)<\/href>.*?<C:calendar-data>([^<]*)<\/C:calendar-data>/gs)) {
    const ics = m[2].replace(/&#13;/g, '\r').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    out.push(...parseInstances(ics, decodeURIComponent(m[1]), '', cal))
  }
  return out
}

const put = (who: string, href: string, ics: string, h: Record<string, string>) =>
  call(who, 'PUT', href, ics, { 'Content-Type': 'text/calendar; charset=utf-8', ...h })

const aliceCal = `/caldav/${ALICE_ID}/def-calendar/`
const draft = (over: Partial<EventDraft>): EventDraft => ({
  calendarHref: aliceCal, title: 'Déjeuner équipe', allDay: false,
  start: new Date('2026-10-22T10:00:00Z'), end: new Date('2026-10-22T11:30:00Z'),
  location: 'Cantine', description: 'ligne 1\nligne 2, avec ; et \\', guests: [], color: null, ...over })

// 1. create a timed event
const uid = `test-${Date.now()}`
const href = `${aliceCal}${uid}.ics`
assert.equal((await put('alice', href, newEventIcs(draft({}), uid), { 'If-None-Match': '*' })).status, 201)
let ev = (await report('alice', aliceCal)).find((e) => e.href === href)!
assert.deepEqual([ev.title, ev.start, ev.end, ev.allDay, ev.location, ev.description, ev.recurring],
  ['Déjeuner équipe', '2026-10-22T10:00:00.000Z', '2026-10-22T11:30:00.000Z', false, 'Cantine', 'ligne 1\nligne 2, avec ; et \\', false])
console.log('ok 1 create timed event')

// 2. turn it into a 2-day all-day event, with If-Match on the current etag
let got = await call('alice', 'GET', href)
const allDay = draft({ allDay: true, start: new Date(2026, 9, 23), end: new Date(2026, 9, 25), location: '' })
assert.equal((await put('alice', href, updatedEventIcs(got.text, allDay, true), { 'If-Match': got.etag })).status, 204)
ev = (await report('alice', aliceCal)).find((e) => e.href === href)!
assert.deepEqual([ev.allDay, ev.start, ev.end, ev.location], [true, '2026-10-23', '2026-10-25', ''])
assert.match((await call('alice', 'GET', href)).text, /SEQUENCE:1/)
console.log('ok 2 switch to all-day, clear location, bump SEQUENCE')

// 3. stale etag is rejected (what the UI reports as a conflict)
assert.equal((await put('alice', href, updatedEventIcs(got.text, draft({}), true), { 'If-Match': got.etag })).status, 412)
console.log('ok 3 stale etag -> 412')

// 4. recurring series (TZID Europe/Paris): rename only, times and DST must be preserved
const rec = `${aliceCal}recur-1.ics`
got = await call('alice', 'GET', rec)
assert.equal(got.status, 200, 'recur-1.ics must exist (created during manual testing)')
const before = (await report('alice', aliceCal)).filter((e) => e.href === rec).map((e) => e.start)
assert.equal((await put('alice', rec, updatedEventIcs(got.text, draft({ title: 'Point hebdo (renommé)' }), false), { 'If-Match': got.etag })).status, 204)
const after = (await report('alice', aliceCal)).filter((e) => e.href === rec)
assert.deepEqual(after.map((e) => e.start), before)
assert.deepEqual(before, ['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z'])
assert.ok(after.every((e) => e.title === 'Point hebdo (renommé)' && e.recurring))
assert.match((await call('alice', 'GET', rec)).text, /DTSTART;TZID=Europe\/Paris:20261019T100000/)
console.log('ok 4 rename recurring series, TZID + DST kept')

// 5. bob moves his own event into alice's calendar shared with him (write)
const share = await call('alice', 'PUT', '/calshare/v1/calendars/def-calendar/shares/bob', '{"permission":"write"}', { 'Content-Type': 'application/json' })
assert.ok([200, 201].includes(share.status), `share: ${share.status} ${share.text}`)
const mount = `/caldav/${BOB_ID}/def-calendar-${ALICE_ID.slice(0, 8)}/`
const bobCal = `/caldav/${BOB_ID}/def-calendar/`
const bobUid = `bob-${Date.now()}`
assert.equal((await put('bob', `${bobCal}${bobUid}.ics`, newEventIcs(draft({ calendarHref: bobCal, title: 'De Bob' }), bobUid), { 'If-None-Match': '*' })).status, 201)
got = await call('bob', 'GET', `${bobCal}${bobUid}.ics`)
assert.equal((await put('bob', `${mount}${bobUid}.ics`, updatedEventIcs(got.text, draft({ calendarHref: mount, title: 'De Bob' }), true), { 'If-None-Match': '*' })).status, 201)
assert.equal((await call('bob', 'DELETE', `${bobCal}${bobUid}.ics`, undefined, { 'If-Match': got.etag })).status, 200)
assert.ok((await report('alice', aliceCal)).some((e) => e.uid === bobUid && e.title === 'De Bob'), 'alice sees it')
assert.ok((await report('bob', mount)).some((e) => e.uid === bobUid), 'bob sees it through the mount')
assert.ok(!(await report('bob', bobCal)).some((e) => e.uid === bobUid), 'gone from bob\'s calendar')
console.log('ok 5 move event into a shared calendar')

// cleanup
for (const h of [href, `${aliceCal}${bobUid}.ics`]) await call('alice', 'DELETE', h)
await call('alice', 'DELETE', '/calshare/v1/calendars/def-calendar/shares/bob')
console.log('all ok')
