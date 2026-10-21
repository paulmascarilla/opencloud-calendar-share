package main

// Free/busy: when other people are busy, never what they are doing.
//
//	GET /v1/freebusy?users=<id>,<id>&start=<RFC 3339>&end=<RFC 3339>[&except=<uid>][&omit=known]
//
// For each user, the busy blocks of their own calendars (not those shared with them), read through
// Radicale's expansion of recurring events. Only times and "busy" / "tentative" leave the server:
// no title, place, description or guest. Overlapping and adjacent blocks are merged, so the number
// of events behind a block does not show either.
//
// What counts (as in Google Calendar and Outlook): an event is busy unless it is TRANSP:TRANSPARENT,
// cancelled, or declined by the user. An all-day event is free unless marked TRANSP:OPAQUE (a
// birthday must not block a day, a vacation can). STATUS:TENTATIVE, a "maybe" and an invitation
// not answered yet are tentative.
//
//   - except: leaves out the event with this UID, if the caller is its organizer or a guest (the
//     event being edited must not conflict with itself). Other UIDs are ignored, so nothing can be
//     learned by guessing them.
//   - omit=known: leaves out what the caller already sees in full, so their calendar shows no
//     duplicate: events the caller organizes or is invited to, and calendars shared with the caller.
//
// A public event (X-OC-VISIBILITY:PUBLIC, set in the web app) also shows its title and place, as its
// own block, never merged. Not CLASS:PUBLIC: some clients (Evolution) write it on every event, and
// nobody would have chosen to show those titles.

import (
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// Visibility marks an event whose title and place anyone may see in free/busy ("PUBLIC").
	Visibility = "X-OC-VISIBILITY"

	maxFreeBusyUsers = 20
	maxFreeBusyRange = 100 * 24 * time.Hour
	// Busy blocks are kept this long at most; the storage hook drops a user's entries on every change.
	freeBusyTTL      = 2 * time.Minute
	maxFreeBusyCache = 1000
	freeBusyWorkers  = 4
)

// busyBlock is one busy event occurrence, before the caller-specific filtering and merging.
type busyBlock struct {
	start, end time.Time
	allDay     bool
	tentative  bool
	uid        string
	calendar   string   // collection id in the user's home
	involves   []string // OpenCloud ids of the organizer and the guests
	public     bool
	title      string // public events only
	location   string
}

type busyEntry struct {
	blocks   []busyBlock
	calendar bool // the user has calendar storage at all
	at       time.Time
}

type busyCache struct {
	mu      sync.Mutex
	entries map[string]busyEntry // "<user>|<start>|<end>"
}

func (c *busyCache) get(key string) (busyEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.at) > freeBusyTTL {
		return busyEntry{}, false
	}
	return e, true
}

func (c *busyCache) put(key string, e busyEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil || len(c.entries) >= maxFreeBusyCache {
		c.entries = map[string]busyEntry{}
	}
	c.entries[key] = e
}

// forget drops the cached blocks of user: one of their calendars changed.
func (c *busyCache) forget(user string) {
	if user == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.entries {
		if strings.HasPrefix(key, user+"|") {
			delete(c.entries, key)
		}
	}
}

// storageChanged is told by the storage hook which file changed (filesystem paths).
func (s *Server) storageChanged(fsPaths ...string) {
	root := strings.TrimRight(s.cfg.CollectionRoot, "/")
	for _, p := range fsPaths {
		if rel, ok := strings.CutPrefix(p, root+"/"); ok {
			s.busy.forget(owner(rel))
		}
	}
}

func (s *Server) freeBusy(caller string, q url.Values) (Obj, error) {
	if !s.cfg.FreeBusy {
		return nil, apiErr(403, "free/busy is disabled on this server")
	}
	var users []string
	seen := map[string]bool{}
	for _, u := range strings.Split(q.Get("users"), ",") {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			continue
		}
		if !nameRE.MatchString(u) {
			return nil, apiErr(400, "invalid user: %s", quoteString(u))
		}
		seen[u] = true
		users = append(users, u)
	}
	if len(users) == 0 {
		return nil, apiErr(400, "users is required")
	}
	if len(users) > maxFreeBusyUsers {
		return nil, apiErr(400, "at most %d users at a time", maxFreeBusyUsers)
	}
	start, err1 := time.Parse(time.RFC3339, q.Get("start"))
	end, err2 := time.Parse(time.RFC3339, q.Get("end"))
	if err1 != nil || err2 != nil {
		return nil, apiErr(400, "start and end must be RFC 3339 date-times")
	}
	start, end = start.UTC().Truncate(time.Second), end.UTC().Truncate(time.Second)
	if !end.After(start) || end.Sub(start) > maxFreeBusyRange {
		return nil, apiErr(400, "the end must be after the start, within 100 days")
	}
	except := q.Get("except")
	omitKnown := q.Get("omit") == "known"

	known := map[string]bool{} // "/<owner>/<calendar>/" shared with the caller
	if omitKnown {
		shares, err := s.listShares(caller)
		if err != nil {
			return nil, err
		}
		for _, sh := range shares {
			if sh.str("User") == caller && sh.str("Owner") != caller && truthy(sh["EnabledByUser"]) && !truthy(sh["HiddenByUser"]) {
				known[sh.str("PathMapped")] = true
			}
		}
	}

	views := make([]Obj, len(users))
	var wg sync.WaitGroup
	sem := make(chan struct{}, freeBusyWorkers)
	for i, user := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			entry, err := s.busyOf(user, start, end)
			view := Obj{{"id", user}, {"calendar", entry.calendar}}
			if err != nil {
				views[i] = append(view, KV{"busy", []Obj{}}, KV{"error", "unavailable"})
				return
			}
			var kept []busyBlock
			for _, b := range entry.blocks {
				withCaller := user == caller || slices.Contains(b.involves, caller)
				if except != "" && b.uid == except && withCaller {
					continue
				}
				if omitKnown && user != caller && (withCaller || known["/"+user+"/"+b.calendar+"/"]) {
					continue
				}
				kept = append(kept, b)
			}
			views[i] = append(view, KV{"busy", mergeBusy(kept, start, end)})
		}()
	}
	wg.Wait()
	return Obj{{"start", formatUTC(start)}, {"end", formatUTC(end)}, {"users", views}}, nil
}

// busyOf reads (or recalls) the busy blocks of user's own calendars between start and end.
func (s *Server) busyOf(user string, start, end time.Time) (busyEntry, error) {
	key := user + "|" + formatUTC(start) + "|" + formatUTC(end)
	if e, ok := s.busy.get(key); ok {
		return e, nil
	}
	// Never ask Radicale about a user without storage: acting as them would create their home.
	if _, err := os.Stat(filepath.Join(s.cfg.CollectionRoot, user)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return busyEntry{}, nil
		}
		return busyEntry{}, err
	}
	calendars, err := s.listCalendars(user)
	if err != nil {
		return busyEntry{}, err
	}
	entry := busyEntry{calendar: true, at: time.Now()}
	for _, c := range calendars {
		if c.Shared || (len(c.Components) > 0 && !slices.Contains(c.Components, "VEVENT")) {
			continue
		}
		blocks, err := s.calendarBusy(user, c, start, end)
		if err != nil {
			return busyEntry{}, err
		}
		entry.blocks = append(entry.blocks, blocks...)
	}
	s.busy.put(key, entry)
	return entry, nil
}

func (s *Server) calendarBusy(user string, c Calendar, start, end time.Time) ([]busyBlock, error) {
	rng := `start="` + icalTime(start, false) + `" end="` + icalTime(end, false) + `"`
	query := `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
		`<D:prop><C:calendar-data><C:expand ` + rng + `/></C:calendar-data></D:prop>` +
		`<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range ` + rng + `/>` +
		`</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`
	status, body, err := s.http("REPORT", s.cfg.RadicaleURL+escapePath(c.Href),
		map[string]string{s.cfg.RemoteUserHeader: user, "Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
		[]byte(query))
	if err != nil {
		return nil, err
	}
	if status != 207 {
		return nil, apiErr(502, "radicale REPORT returned %d", status)
	}
	root, err := parseXML(body)
	if err != nil {
		return nil, err
	}
	var blocks []busyBlock
	for _, data := range root.iter(nsCalDAV, "calendar-data", nil) {
		cal, err := ParseICal([]byte(data.Text))
		if err != nil {
			continue // one unreadable event must not hide the rest
		}
		for _, event := range cal.Walk("VEVENT") {
			from, to, allDay, ok := span(event)
			if !ok || !to.After(from) {
				continue
			}
			busy, tentative := availability(event, user, allDay)
			if !busy {
				continue
			}
			b := busyBlock{start: from, end: to, allDay: allDay, tentative: tentative, uid: event.Value("UID"), calendar: c.ID}
			if strings.EqualFold(event.Value(Visibility), "PUBLIC") {
				b.public, b.location = true, event.Text("LOCATION")
				b.title = event.Text("SUMMARY")
				if event.Has(OriginalSummary) { // a guest's copy: the organizer's title
					b.title = event.Text(OriginalSummary)
				}
			}
			if id := userID(event.Get("ORGANIZER")); id != "" {
				b.involves = append(b.involves, id)
			}
			b.involves = append(b.involves, attendeesOf(event).ids...)
			blocks = append(blocks, b)
		}
	}
	return blocks, nil
}

// availability tells whether an occurrence makes user busy, and whether only tentatively.
func availability(event *Component, user string, allDay bool) (busy, tentative bool) {
	if strings.EqualFold(event.Value("STATUS"), "CANCELLED") {
		return false, false
	}
	transp := strings.ToUpper(event.Value("TRANSP"))
	tentative = strings.EqualFold(event.Value("STATUS"), "TENTATIVE")
	if answers := attendeesOf(event); answers.has(user) {
		switch answers.answers[user] {
		case "DECLINED":
			return false, false
		case "NEEDS-ACTION":
			tentative = true
			if event.Has(OrganizerHref) {
				transp = "" // the agent marks unanswered copies transparent: judge by the event itself
			}
		case "TENTATIVE":
			tentative = true
		}
	}
	switch transp {
	case "TRANSPARENT":
		return false, false
	case "OPAQUE":
		return true, tentative
	}
	return !allDay, tentative
}

// mergeBusy unions the private blocks (busy wins over tentative) and lists the public ones with
// their title, timed ones clipped to [start, end).
func mergeBusy(blocks []busyBlock, start, end time.Time) []Obj {
	type span struct{ from, to time.Time }
	union := func(spans []span) []span {
		sort.Slice(spans, func(i, j int) bool { return spans[i].from.Before(spans[j].from) })
		var out []span
		for _, s := range spans {
			if n := len(out); n > 0 && !s.from.After(out[n-1].to) {
				if s.to.After(out[n-1].to) {
					out[n-1].to = s.to
				}
				continue
			}
			out = append(out, s)
		}
		return out
	}
	// minus removes the busy spans from the tentative ones.
	minus := func(spans, cut []span) []span {
		var out []span
		for _, s := range spans {
			pieces := []span{s}
			for _, c := range cut {
				var next []span
				for _, p := range pieces {
					if !c.to.After(p.from) || !p.to.After(c.from) {
						next = append(next, p)
						continue
					}
					if c.from.After(p.from) {
						next = append(next, span{p.from, c.from})
					}
					if p.to.After(c.to) {
						next = append(next, span{c.to, p.to})
					}
				}
				pieces = next
			}
			out = append(out, pieces...)
		}
		return out
	}
	type item struct {
		span
		allDay, tentative bool
		public            *busyBlock
	}
	var items []item
	for _, allDay := range []bool{true, false} {
		var busy, tentative []span
		for i, b := range blocks {
			if b.allDay != allDay {
				continue
			}
			s := span{b.start, b.end}
			if !allDay {
				if s.from.Before(start) {
					s.from = start
				}
				if s.to.After(end) {
					s.to = end
				}
				if !s.to.After(s.from) {
					continue
				}
			}
			if b.public {
				items = append(items, item{s, allDay, b.tentative, &blocks[i]})
				continue
			}
			if b.tentative {
				tentative = append(tentative, s)
			} else {
				busy = append(busy, s)
			}
		}
		busy = union(busy)
		for _, s := range busy {
			items = append(items, item{s, allDay, false, nil})
		}
		for _, s := range minus(union(tentative), busy) {
			items = append(items, item{s, allDay, true, nil})
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].allDay != items[j].allDay {
			return items[i].allDay
		}
		return items[i].from.Before(items[j].from)
	})
	out := []Obj{}
	for _, it := range items {
		status := "busy"
		if it.tentative {
			status = "tentative"
		}
		format := formatUTC
		if it.allDay {
			format = func(t time.Time) string { return t.Format("2006-01-02") }
		}
		view := Obj{{"start", format(it.from)}, {"end", format(it.to)}, {"allDay", it.allDay}, {"status", status}}
		if it.public != nil {
			view = append(view, KV{"title", it.public.title}, KV{"location", it.public.location})
		}
		out = append(out, view)
	}
	return out
}

func formatUTC(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }
