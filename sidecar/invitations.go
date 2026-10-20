package main

// Event invitations between OpenCloud users (a minimal CalDAV scheduling agent).
//
// Radicale does not implement CalDAV scheduling (RFC 6638), so this agent does it:
//
//   - An event *master* lives in the organizer's calendar. Guests are ATTENDEE
//     properties carrying X-OC-USERID=<OpenCloud user id>.
//   - Each guest gets a *copy* in their own calendar (same file name, marked with
//     X-OC-ORGANIZER-HREF and X-OC-SYNC-HASH = hash of the master it mirrors).
//   - The organizer's version wins: copies are rewritten whenever the master changes.
//   - A guest answers by changing their own PARTSTAT in their copy (web app or any
//     CalDAV client). That answer is written back into the master, then fanned out.
//   - Deleting a copy declines the invitation; deleting the master deletes the copies.
//   - So any CalDAV client shows what still needs an answer, a copy is STATUS:TENTATIVE (drawn
//     as tentative by Thunderbird / Apple) and TRANSP:TRANSPARENT until the guest accepts, and its
//     description carries Accept / Maybe / Decline links (plain text, plus HTML buttons for clients
//     that render HTML descriptions) to the web app's respond page. The original texts are kept in
//     X-OC-SUMMARY / X-OC-DESCRIPTION.
//   - Events created in a CalDAV client name guests by e-mail (ATTENDEE:mailto:…). Those addresses
//     are resolved to OpenCloud users (resolveEmail) and tagged with X-OC-USERID in the master,
//     keeping the mailto value, so the guest's own client recognizes the invitation as theirs.
//
// Radicale calls its storage hook (inside its write lock) after every change; the
// hook only notifies us, and a single worker goroutine does the work afterwards.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	UserIDParam     = "X-OC-USERID"
	OrganizerHref   = "X-OC-ORGANIZER-HREF"
	SyncHash        = "X-OC-SYNC-HASH"
	OriginalSummary = "X-OC-SUMMARY"
	OriginalDescr   = "X-OC-DESCRIPTION"
	// In each VEVENT of a copy: hash of what the guest may not change (see contentHash).
	CopyHash = "X-OC-COPY-HASH"
	// ATTENDEE parameters in the organizer's event: another time proposed by that guest.
	ProposedStart = "X-OC-PROPOSED-START"
	ProposedEnd   = "X-OC-PROPOSED-END"
	// Bump when the content of copies changes, so existing copies get rewritten.
	CopyFormat = "7"
)

// Ignored when deciding whether a copy is up to date.
var volatile = map[string]bool{"DTSTAMP": true, "LAST-MODIFIED": true, "PRODID": true, OrganizerHref: true, SyncHash: true}

type texts struct {
	Invited string
	Answers map[string]string
	Buttons map[string]string
	Propose string
}

var allTexts = map[string]texts{
	"fr": {
		Invited: "Invitation de {organizer}. Votre réponse : {answer}.",
		Answers: map[string]string{"NEEDS-ACTION": "en attente", "ACCEPTED": "acceptée", "TENTATIVE": "peut-être",
			"DECLINED": "refusée"},
		Buttons: map[string]string{"accepted": "Accepter", "tentative": "Peut-être", "declined": "Refuser"},
		Propose: "Proposer un autre horaire",
	},
	"en": {
		Invited: "Invitation from {organizer}. Your answer: {answer}.",
		Answers: map[string]string{"NEEDS-ACTION": "pending", "ACCEPTED": "accepted", "TENTATIVE": "maybe",
			"DECLINED": "declined"},
		Buttons: map[string]string{"accepted": "Accept", "tentative": "Maybe", "declined": "Decline"},
		Propose: "Propose another time",
	},
}

var buttonStyle = map[string]string{
	"accepted":  "background:#1f7a4d;color:#fff",
	"tentative": "background:#e8e8e8;color:#1f1f1f",
	"declined":  "background:#b3261e;color:#fff",
}

var answerOrder = []string{"accepted", "tentative", "declined"}

// HTTPFunc performs a request; it returns an error only when the server could not be reached.
type HTTPFunc func(method, url string, headers map[string]string, body []byte) (int, []byte, http.Header, error)

type masterEntry struct {
	Copies map[string]string `json:"copies"` // guest id -> copy path
}

type invitationIndex struct {
	Masters map[string]*masterEntry `json:"masters"` // master path -> its copies
	Copies  map[string]string       `json:"copies"`  // copy path -> master path
	Mails   map[string]string       `json:"mails"`   // user id -> e-mail address, as the user's own Graph /me says
}

type job struct{ request, path, toPath string }

type Agent struct {
	http             HTTPFunc
	resolveEmail     func(email string) (*User, error) // nil disables invitations from CalDAV clients
	resolveID        func(id string) (*User, error)    // nil: organizer names are taken from the events
	publicURL        string
	texts            texts
	header           string
	radicale         string
	root             string
	indexPath        string
	fullScanInterval time.Duration

	qmu   sync.Mutex
	queue []job
	wake  chan struct{}

	mu    sync.Mutex // guards index
	index invitationIndex
}

func NewAgent(http HTTPFunc, remoteUserHeader, radicaleURL, collectionRoot, stateDir, publicURL, language string,
	resolveEmail, resolveID func(string) (*User, error), fullScanInterval time.Duration) (*Agent, error) {
	t, ok := allTexts[language]
	if !ok {
		t = allTexts["en"]
	}
	a := &Agent{
		http:             http,
		resolveEmail:     resolveEmail,
		resolveID:        resolveID,
		publicURL:        strings.TrimRight(publicURL, "/"),
		texts:            t,
		header:           remoteUserHeader,
		radicale:         radicaleURL,
		root:             strings.TrimRight(collectionRoot, "/"),
		indexPath:        filepath.Join(stateDir, "invitations.json"),
		fullScanInterval: fullScanInterval,
		wake:             make(chan struct{}, 1),
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return nil, err
	}
	a.index = a.loadIndex()
	return a, nil
}

// --- public API -----------------------------------------------------

func (a *Agent) Start() { go a.run(nil) }

// startForTest starts the worker and returns a function that stops it and waits for it.
func (a *Agent) startForTest() func() {
	stop, done := make(chan struct{}), make(chan struct{})
	go func() { a.run(stop); close(done) }()
	return func() { close(stop); <-done }
}

// Notify is called by the storage-hook endpoint: it must return immediately.
func (a *Agent) Notify(request, fsPath, fsToPath string) {
	path, ok := a.href(fsPath)
	if !ok || (request != "PUT" && request != "DELETE" && request != "MOVE") {
		return
	}
	toPath, _ := a.href(fsToPath)
	a.qmu.Lock()
	a.queue = append(a.queue, job{request, path, toPath})
	a.qmu.Unlock()
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// --- worker ----------------------------------------------------------

// next waits for a job; ok is false on timeout or stop.
func (a *Agent) next(timeout time.Duration, stop <-chan struct{}) (j job, ok, stopped bool) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		a.qmu.Lock()
		if len(a.queue) > 0 {
			j := a.queue[0]
			a.queue = a.queue[1:]
			a.qmu.Unlock()
			return j, true, false
		}
		a.qmu.Unlock()
		select {
		case <-a.wake:
		case <-deadline.C:
			return job{}, false, false
		case <-stop:
			return job{}, false, true
		}
	}
}

func (a *Agent) run(stop <-chan struct{}) {
	a.waitForRadicale()
	a.FullScan()
	lastScan := time.Now()
	for {
		timeout := max(time.Second, a.fullScanInterval-time.Since(lastScan))
		j, ok, stopped := a.next(timeout, stop)
		if stopped {
			return
		}
		if !ok {
			a.FullScan()
			lastScan = time.Now()
			continue
		}
		a.safe(fmt.Sprintf("%v", []string{j.request, j.path, j.toPath}), func() error {
			return a.handle(j.request, j.path, j.toPath)
		})
	}
}

// waitForRadicale: both containers start together, don't scan before Radicale answers.
func (a *Agent) waitForRadicale() {
	for range 60 {
		if _, _, _, err := a.http("GET", a.radicale+"/.well-known/caldav", map[string]string{}, nil); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
	slog.Warn("radicale not reachable after 60s, scanning anyway")
}

// safe runs fn with the index locked, logging failures (and panics) instead of stopping the worker.
func (a *Agent) safe(what string, fn func() error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	defer func() {
		if p := recover(); p != nil {
			slog.Error(fmt.Sprintf("invitation sync failed for %s: %v", what, p))
		}
	}()
	if err := fn(); err != nil {
		slog.Error(fmt.Sprintf("invitation sync failed for %s: %v", what, err))
	}
}

func (a *Agent) handle(request, path, toPath string) error {
	switch request {
	case "PUT":
		if !strings.HasSuffix(path, ".ics") {
			return nil
		}
		_, ics, _, err := a.get(path)
		if err != nil {
			return err
		}
		if ics != nil && (bytes.Contains(ics, []byte(OrganizerHref)) || a.index.Copies[path] != "") {
			return a.copyChanged(path, ics)
		}
		return a.masterChanged(path)
	case "DELETE":
		return a.deleted(path)
	case "MOVE":
		return a.moved(path, toPath)
	case refresh:
		if masterPath := a.index.Copies[path]; masterPath != "" {
			return a.rewriteCopy(masterPath, owner(path), path)
		}
	}
	return nil
}

// refresh is an internal job: rewrite one copy (e.g. an e-mail address became known).
const refresh = "REFRESH"

// LearnMail remembers a user's e-mail address, read with their own credentials (Graph hides
// it from a non-admin service account), and rewrites the copies that name them.
func (a *Agent) LearnMail(user, mail string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.index.Mails[user] == mail {
		return
	}
	a.index.Mails[user] = mail
	if err := a.saveIndex(); err != nil {
		slog.Warn(fmt.Sprintf("saving the invitations index: %v", err))
	}
	a.qmu.Lock()
	for _, copyPath := range sortedKeys(a.index.Copies) {
		if owner(copyPath) == user || owner(a.index.Copies[copyPath]) == user {
			a.queue = append(a.queue, job{refresh, copyPath, ""})
		}
	}
	a.qmu.Unlock()
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// FullScan catches up on changes missed while we were not running.
func (a *Agent) FullScan() {
	started := time.Now()
	var masters, copies []string
	a.mu.Lock()
	// The callback never returns an error: unreadable entries are skipped.
	_ = filepath.WalkDir(a.root, func(full string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if full != a.root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".ics") {
			return nil
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return nil
		}
		href, _ := a.href(full)
		if bytes.Contains(data, []byte(OrganizerHref)) || a.index.Copies[href] != "" {
			copies = append(copies, href)
		} else if bytes.Contains(data, []byte(UserIDParam)) || bytes.Contains(data, []byte("ATTENDEE")) {
			masters = append(masters, href)
		}
		return nil
	})
	a.mu.Unlock()
	for _, path := range masters {
		a.safe(path, func() error { return a.masterChanged(path) })
	}
	for _, path := range copies {
		a.safe(path, func() error { return a.copyChanged(path, nil) })
	}
	// Index entries whose master vanished while we were away.
	scanned := map[string]bool{}
	for _, m := range masters {
		scanned[m] = true
	}
	a.mu.Lock()
	var gone []string
	for path := range a.index.Masters {
		if !scanned[path] {
			gone = append(gone, path)
		}
	}
	a.mu.Unlock()
	sort.Strings(gone)
	for _, path := range gone {
		a.safe(path, func() error { return a.deleted(path) })
	}
	slog.Info(fmt.Sprintf("full scan: %d invitation(s), %d copie(s) in %.2fs",
		len(masters), len(copies), time.Since(started).Seconds()))
}

// --- master side ------------------------------------------------------

func (a *Agent) masterChanged(path string) error {
	status, ics, etag, err := a.get(path)
	if err != nil || status != 200 {
		return err
	}
	cal, err := ParseICal(ics)
	if err != nil {
		return err
	}
	if a.tagUsers(cal, path) {
		// Written back as the calendar owner; its storage hook brings us here again.
		return a.put(path, cal.Serialize(), map[string]string{"If-Match": etag})
	}
	master := masterEvent(cal)
	attendees := &orderedAnswers{}
	organizer := ""
	if master != nil {
		attendees = attendeesOf(master)
		organizer = userID(master.Get("ORGANIZER"))
	}
	attendees.remove(organizer)
	// An event in a guest's own calendar is that guest's copy (a client may have dropped
	// our marker); never "invite" the holder of the calendar to their own event.
	holder := owner(path)
	if attendees.has(holder) && organizer != "" && organizer != holder {
		if a.index.Copies[path] != "" {
			return a.copyChanged(path, ics)
		}
		slog.Info(fmt.Sprintf("%s: %s is a guest here, not the organizer; leaving it alone", path, holder))
		return nil
	}
	attendees.remove(holder)
	// Anyone can write any ORGANIZER into an event of their own calendar: only the calendar's
	// owner, or someone it is shared with for writing, may send invitations from it.
	if organizer != "" && organizer != holder {
		allowed, err := a.mayOrganize(organizer, path)
		if err != nil {
			return err
		}
		if !allowed {
			slog.Warn(fmt.Sprintf("%s: %s may not organize events in this calendar, no invitations sent", path, organizer))
			attendees = &orderedAnswers{answers: map[string]string{}}
		}
	}
	entry, known := a.index.Masters[path]
	if !known {
		entry = &masterEntry{Copies: map[string]string{}}
	}

	if attendees.len() == 0 {
		if known {
			for _, user := range sortedKeys(entry.Copies) {
				if err := a.deleteCopy(entry.Copies[user], path); err != nil {
					return err
				}
			}
			return a.forgetMaster(path)
		}
		return nil
	}

	digest := a.digest(cal)
	for _, user := range attendees.ids {
		partstat := attendees.answers[user]
		copyPath := entry.Copies[user]
		if copyPath == "" {
			if copyPath, err = a.copyPath(user, path); err != nil {
				return err
			}
		}
		if copyPath == "" {
			slog.Warn(fmt.Sprintf("no calendar found for attendee %s of %s", user, path))
			continue
		}
		currentStatus, current, currentEtag, err := a.get(copyPath)
		if err != nil {
			return err
		}
		if currentStatus == 200 {
			currentCal, err := ParseICal(current)
			if err != nil {
				return err
			}
			currentMaster := marker(currentCal)
			if currentMaster != path {
				// Same UID: the organizer moved the event to another calendar
				// (PUT new + DELETE old). Take the copy over instead of skipping it.
				currentEvent := masterEvent(currentCal)
				if currentEvent == nil || currentEvent.Value("UID") != master.Value("UID") {
					slog.Warn(fmt.Sprintf("%s exists and is not a copy of %s, skipping", copyPath, path))
					continue
				}
				if old := a.index.Masters[currentMaster]; currentMaster != "" && old != nil {
					delete(old.Copies, user)
				}
			}
			if currentMaster == path && currentCal.Value(SyncHash) == digest {
				entry.Copies[user] = copyPath
				continue
			}
			copyICS, err := a.makeCopy(cal, path, digest, user, copyPath)
			if err != nil {
				return err
			}
			if err := a.put(copyPath, copyICS, map[string]string{"If-Match": currentEtag}); err != nil {
				return err
			}
		} else if partstat != "DECLINED" {
			copyICS, err := a.makeCopy(cal, path, digest, user, copyPath)
			if err != nil {
				return err
			}
			if err := a.put(copyPath, copyICS, map[string]string{"If-None-Match": "*"}); err != nil {
				return err
			}
		} else {
			continue // declined by deleting their copy: don't push it back
		}
		entry.Copies[user] = copyPath
	}

	for _, user := range sortedKeys(entry.Copies) {
		if !attendees.has(user) {
			copyPath := entry.Copies[user]
			delete(entry.Copies, user)
			if err := a.deleteCopy(copyPath, path); err != nil {
				return err
			}
		}
	}
	return a.rememberMaster(path, entry)
}

func (a *Agent) deleted(path string) error {
	prefix := strings.TrimRight(path, "/") + "/"
	under := func(p string) bool { return p == path || strings.HasPrefix(p, prefix) }
	for _, m := range sortedKeys(a.index.Masters) {
		if !under(m) {
			continue
		}
		for _, user := range sortedKeys(a.index.Masters[m].Copies) {
			if err := a.deleteCopy(a.index.Masters[m].Copies[user], m); err != nil {
				return err
			}
		}
		if err := a.forgetMaster(m); err != nil {
			return err
		}
	}
	for _, c := range sortedKeys(a.index.Copies) {
		if !under(c) {
			continue
		}
		m := a.index.Copies[c]
		if err := a.setPartstat(m, owner(c), "DECLINED"); err != nil {
			return err
		}
		if entry := a.index.Masters[m]; entry != nil {
			delete(entry.Copies, owner(c))
		}
		delete(a.index.Copies, c)
	}
	return a.saveIndex()
}

func (a *Agent) moved(path, toPath string) error {
	if entry, ok := a.index.Masters[path]; ok {
		delete(a.index.Masters, path)
		a.index.Masters[toPath] = entry
		for c, m := range a.index.Copies {
			if m == path {
				a.index.Copies[c] = toPath
			}
		}
		if err := a.saveIndex(); err != nil {
			return err
		}
		return a.masterChanged(toPath) // rewrites copies with the new organizer href
	}
	if m, ok := a.index.Copies[path]; ok {
		delete(a.index.Copies, path)
		a.index.Copies[toPath] = m
		if entry := a.index.Masters[m]; entry != nil {
			entry.Copies[owner(toPath)] = toPath
		}
		return a.saveIndex()
	}
	return nil
}

// tagUsers tags mailto ORGANIZER/ATTENDEEs that are OpenCloud users with X-OC-USERID.
//
// That is how an event created in Thunderbird / DAVx⁵ (guests as e-mail addresses)
// becomes an invitation. Returns true when cal was changed.
func (a *Agent) tagUsers(cal *Component, path string) bool {
	if a.resolveEmail == nil {
		return false
	}
	changed := false
	for _, event := range cal.Walk("VEVENT") {
		attendees := event.All("ATTENDEE")
		if len(attendees) == 0 {
			continue
		}
		if organizer := event.Get("ORGANIZER"); organizer != nil && !organizer.HasParam(UserIDParam) {
			// The calendar owner wrote it: fall back to them when the address is unknown.
			id := owner(path)
			if user := a.lookup(organizer); user != nil {
				id = user.ID
			}
			organizer.SetParam(UserIDParam, id)
			changed = true
		}
		for _, attendee := range attendees {
			if attendee.HasParam(UserIDParam) {
				continue
			}
			if user := a.lookup(attendee); user != nil {
				attendee.SetParam(UserIDParam, user.ID)
				if !attendee.HasParam("CN") {
					attendee.SetParam("CN", user.DisplayName)
				}
				changed = true
			}
		}
	}
	return changed
}

func (a *Agent) lookup(address *Prop) *User {
	value := address.Value
	if !strings.HasPrefix(strings.ToLower(value), "mailto:") {
		return nil
	}
	user, err := a.resolveEmail(strings.ToLower(strings.TrimSpace(value[len("mailto:"):])))
	if err != nil {
		slog.Warn(fmt.Sprintf("could not resolve %s: %v", value, err))
		return nil
	}
	return user
}

// --- guest side -------------------------------------------------------

func (a *Agent) copyChanged(path string, ics []byte) error {
	if ics == nil {
		status, body, _, err := a.get(path)
		if err != nil || status != 200 {
			return err
		}
		ics = body
	}
	cal, err := ParseICal(ics)
	if err != nil {
		return err
	}
	masterPath := marker(cal)
	if masterPath == "" {
		masterPath = a.index.Copies[path]
	}
	if masterPath == "" {
		return nil
	}
	user := owner(path)
	answer := ""
	if copyEvent := masterEvent(cal); copyEvent != nil {
		answer = attendeesOf(copyEvent).answers[user]
	}

	status, masterICS, _, err := a.get(masterPath)
	if err != nil {
		return err
	}
	// A marker we did not write is just text in the guest's event: don't let it make us act
	// on (or reveal anything about) another user's calendar unless the guest is really invited.
	ours := a.index.Copies[path] == masterPath
	if status == 404 && ours {
		slog.Info(fmt.Sprintf("removing orphan copy %s (organizer event %s is gone)", path, masterPath))
		if err := a.deleteCopy(path, masterPath); err != nil {
			return err
		}
		return a.saveIndex()
	}
	if status != 200 {
		return nil
	}
	masterCal, err := ParseICal(masterICS)
	if err != nil {
		return err
	}
	masterEv := masterEvent(masterCal)
	if masterEv == nil {
		return nil
	}
	current, invited := attendeesOf(masterEv).answers[user]
	if !invited {
		return nil // no longer invited; the master sync removes the copy
	}
	a.index.Copies[path] = masterPath
	if answer != "" && answer != current {
		slog.Info(fmt.Sprintf("%s answered %s to %s", user, answer, masterPath))
		if err := a.setPartstat(masterPath, user, answer); err != nil { // its hook fans the answer out
			return err
		}
	}
	// The organizer's version wins: a guest's client may still let them edit their copy
	// (GNOME Calendar only knows read-only calendars, not read-only events).
	copyEvent := masterEvent(cal)
	if copyEvent != nil && copyEvent.Has(CopyHash) && copyEvent.Value(CopyHash) != contentHash(cal) {
		if start, end, moved := movedTo(cal, masterCal); moved {
			slog.Info(fmt.Sprintf("%s moved their copy %s: proposal to the organizer", user, path))
			if _, err := a.setProposal(masterPath, user, start, end); err != nil {
				return err
			}
		}
		if answer != "" && answer != current {
			return nil // the answer's fan-out rewrites the copy
		}
		slog.Info(fmt.Sprintf("%s changed their copy %s: putting the organizer's version back", user, path))
		return a.rewriteCopy(masterPath, user, path)
	}
	if answer != "" && answer != current {
		return nil
	}
	if cal.Value(SyncHash) != a.digest(masterCal) || cal.Value(OrganizerHref) == "" {
		return a.masterChanged(masterPath)
	}
	return nil
}

// movedTo tells whether the guest's copy of a single (non-recurring) event now has other times
// than the organizer's event, and returns them as a proposal.
func movedTo(copyCal, masterCal *Component) (start, end string, moved bool) {
	events := masterCal.Walk("VEVENT")
	if len(events) != 1 || events[0].Has("RRULE") || events[0].Has("RDATE") {
		return "", "", false
	}
	copyEvent := masterEvent(copyCal)
	cs, ce, cAllDay, ok1 := span(copyEvent)
	ms, me, mAllDay, ok2 := span(events[0])
	if !ok1 || !ok2 || (cs.Equal(ms) && ce.Equal(me) && cAllDay == mAllDay) || !ce.After(cs) {
		return "", "", false
	}
	return icalTime(cs, cAllDay), icalTime(ce, cAllDay), true
}

// icalTime writes a UTC DATE-TIME, or a DATE for an all-day event.
func icalTime(t time.Time, allDay bool) string {
	if allDay {
		return t.Format("20060102")
	}
	return t.UTC().Format("20060102T150405Z")
}

// guarded lists what a guest may not change in their copy.
var guarded = []string{"DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "SUMMARY", "LOCATION", "DESCRIPTION"}

// contentHash hashes the guarded properties of every VEVENT, in a form clients don't change
// when they only rewrite an event (instants for times, unescaped texts).
func contentHash(cal *Component) string {
	var lines []string
	for _, event := range cal.Walk("VEVENT") {
		occurrence := ""
		if rid := event.Get("RECURRENCE-ID"); rid != nil {
			occurrence = rid.Value
			if t, allDay, ok := rid.Time(); ok {
				occurrence = icalTime(t, allDay)
			}
		}
		for _, name := range guarded {
			for _, p := range event.All(name) {
				value := strings.TrimSpace(p.Value)
				switch name {
				case "DTSTART", "DTEND", "RDATE", "EXDATE":
					if t, allDay, ok := p.Time(); ok {
						value = icalTime(t, allDay)
					}
				case "SUMMARY", "LOCATION", "DESCRIPTION":
					value = strings.TrimSpace(strings.ReplaceAll(p.Text(), "\r\n", "\n"))
				}
				lines = append(lines, occurrence+"|"+name+"|"+value)
			}
		}
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:16])
}

// rewriteCopy puts the organizer's version of the event back into a guest's copy.
func (a *Agent) rewriteCopy(masterPath, user, copyPath string) error {
	status, masterICS, _, err := a.get(masterPath)
	if err != nil || status != 200 {
		return err
	}
	masterCal, err := ParseICal(masterICS)
	if err != nil {
		return err
	}
	status, _, etag, err := a.get(copyPath)
	if err != nil || status != 200 {
		return err
	}
	copyICS, err := a.makeCopy(masterCal, masterPath, a.digest(masterCal), user, copyPath)
	if err != nil {
		return err
	}
	return a.put(copyPath, copyICS, map[string]string{"If-Match": etag})
}

// MasterOf returns the organizer's event of a guest's copy, from our own index (never from the
// copy's marker, which the guest can write); "" if path is not a copy.
func (a *Agent) MasterOf(copyPath string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.index.Copies[copyPath]
}

// Propose records another time proposed by user for the organizer's event masterPath.
// Returns false when user is not invited to it.
func (a *Agent) Propose(masterPath, user, start, end string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.setProposal(masterPath, user, start, end)
}

func (a *Agent) setProposal(masterPath, user, start, end string) (bool, error) {
	return a.updateAttendee(masterPath, user, func(attendee *Prop) bool {
		if attendee.Param(ProposedStart) == start && attendee.Param(ProposedEnd) == end {
			return false
		}
		attendee.SetParam(ProposedStart, start)
		attendee.SetParam(ProposedEnd, end)
		return true
	})
}

// updateAttendee applies change to user's ATTENDEE in every VEVENT of the organizer's event and
// writes it back if anything changed. found is false when user is not an attendee.
func (a *Agent) updateAttendee(masterPath, user string, change func(*Prop) bool) (found bool, err error) {
	status, ics, etag, err := a.get(masterPath)
	if err != nil {
		return false, err
	}
	if status != 200 {
		return false, nil
	}
	cal, err := ParseICal(ics)
	if err != nil {
		return false, err
	}
	changed := false
	for _, event := range cal.Walk("VEVENT") {
		for _, attendee := range event.All("ATTENDEE") {
			if userID(attendee) == user {
				found = true
				changed = change(attendee) || changed
			}
		}
	}
	if !changed {
		return found, nil
	}
	status, _, _, err = a.request("PUT", masterPath, owner(masterPath), cal.Serialize(),
		map[string]string{"Content-Type": "text/calendar; charset=utf-8", "If-Match": etag})
	if err != nil {
		return found, err
	}
	if status == 412 {
		return found, apiErr(409, "event changed in the meantime, retry")
	}
	if status != 200 && status != 204 {
		return found, fmt.Errorf("PUT %s -> %d", masterPath, status)
	}
	return found, nil
}

func (a *Agent) setPartstat(masterPath, user, partstat string) error {
	_, err := a.updateAttendee(masterPath, user, func(attendee *Prop) bool {
		if attendee.HasParam("PARTSTAT") && attendee.Param("PARTSTAT") == partstat {
			return false
		}
		attendee.SetParam("PARTSTAT", partstat)
		attendee.DelParam("RSVP")
		return true
	})
	return err
}

// --- what a guest's copy looks like --------------------------------------

// digest is the master hash, salted with what else shapes a copy (format version, link base).
func (a *Agent) digest(masterCal *Component) string {
	return digest(masterCal, CopyFormat+"|"+a.publicURL+"|"+a.texts.Invited)
}

func (a *Agent) makeCopy(masterCal *Component, masterPath, digest, user, copyPath string) ([]byte, error) {
	cp := masterCal.Clone()
	master := masterEvent(masterCal)
	partstat, ok := attendeesOf(master).answers[user]
	if !ok {
		partstat = "NEEDS-ACTION"
	}
	organizerName := ""
	organizer := master.Get("ORGANIZER")
	if organizer != nil {
		organizerName = organizer.Param("CN")
		// The CN is whatever the event says: show the name OpenCloud knows instead.
		if id := userID(organizer); id != "" && a.resolveID != nil {
			user, err := a.resolveID(id)
			if err != nil {
				return nil, err // retried on the next change or scan
			}
			if user != nil {
				organizerName = user.DisplayName
			}
		}
	}
	parts := strings.SplitN(copyPath, "/", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("unexpected copy path %q", copyPath)
	}
	links := a.respondLinks(parts[2], parts[3])
	proposeURL := a.proposeURL(parts[2], parts[3])

	for _, event := range cp.Walk("VEVENT") {
		// E-mail addresses let the guest's client see an invitation sent to them, and lock it.
		for _, p := range append(event.All("ORGANIZER"), event.All("ATTENDEE")...) {
			if err := a.useMail(p); err != nil {
				return nil, err
			}
		}
		// Reminders are personal: guests don't inherit the organizer's alarms.
		subs := event.Subs[:0]
		for _, c := range event.Subs {
			if c.Name != "VALARM" {
				subs = append(subs, c)
			}
		}
		event.Subs = subs
		if org := event.Get("ORGANIZER"); org != nil && organizer != nil && userID(org) == userID(organizer) && organizerName != "" {
			org.SetParam("CN", organizerName)
		}
		summary := event.Text("SUMMARY")
		description := event.Text("DESCRIPTION")
		event.SetText(OrganizerHref, masterPath)
		event.SetText(OriginalSummary, summary)
		event.SetText(OriginalDescr, description)

		if partstat == "NEEDS-ACTION" {
			event.SetText("STATUS", "TENTATIVE")
		}
		if partstat == "NEEDS-ACTION" || partstat == "DECLINED" {
			event.SetText("TRANSP", "TRANSPARENT") // don't block the guest's free/busy
		}

		shownOrganizer := organizerName
		if shownOrganizer == "" {
			shownOrganizer = "?"
		}
		answer, ok := a.texts.Answers[partstat]
		if !ok {
			answer = strings.ToLower(partstat)
		}
		intro := strings.NewReplacer("{organizer}", shownOrganizer, "{answer}", answer).Replace(a.texts.Invited)
		text := "—\n" + intro
		if description != "" {
			text = description + "\n\n" + text
		}
		for _, l := range links {
			text += "\n" + a.texts.Buttons[l.response] + " : " + l.url
		}
		if proposeURL != "" {
			text += "\n" + a.texts.Propose + " : " + proposeURL
		}
		html := a.htmlDescription(description, intro, links, proposeURL)
		prop := NewText("DESCRIPTION", text)
		if html != "" {
			// RFC 5545 ALTREP (Thunderbird), X-ALT-DESC (Outlook): HTML with real buttons.
			prop.SetParam("ALTREP", "data:text/html,"+escapePath(html))
		}
		event.Remove("DESCRIPTION")
		event.Add(prop)
		event.Remove("X-ALT-DESC")
		if html != "" {
			alt := NewText("X-ALT-DESC", html)
			alt.SetParam("FMTTYPE", "text/html")
			event.Add(alt)
		}
	}

	cp.Remove(OrganizerHref)
	cp.Add(NewText(OrganizerHref, masterPath))
	cp.Remove(SyncHash)
	cp.Add(NewText(SyncHash, digest))
	hash := contentHash(cp)
	for _, event := range cp.Walk("VEVENT") {
		event.SetText(CopyHash, hash)
	}
	return cp.Serialize(), nil
}

// useMail replaces an OpenCloud address (urn:uuid:…) with the user's e-mail address, when known.
func (a *Agent) useMail(p *Prop) error {
	id := userID(p)
	if id == "" || !strings.HasPrefix(strings.ToLower(p.Value), "urn:uuid:") {
		return nil
	}
	mail := a.index.Mails[id]
	if mail == "" && a.resolveID != nil {
		user, err := a.resolveID(id)
		if err != nil {
			return err // retried on the next change or scan
		}
		if user != nil {
			mail = user.Mail
		}
	}
	if mail != "" {
		p.Value = "mailto:" + mail
	}
	return nil
}

type respondLink struct{ response, url string }

func (a *Agent) respondLinks(calendar, name string) []respondLink {
	if a.publicURL == "" {
		return nil
	}
	var links []respondLink
	for _, r := range answerOrder {
		query := "cal=" + escapeQuery(calendar) + "&event=" + escapeQuery(name) + "&response=" + r
		links = append(links, respondLink{r, a.publicURL + "/calendar/respond?" + query})
	}
	return links
}

// proposeURL opens the invitation page, where the guest can propose another time.
func (a *Agent) proposeURL(calendar, name string) string {
	if a.publicURL == "" {
		return ""
	}
	return a.publicURL + "/calendar/respond?cal=" + escapeQuery(calendar) + "&event=" + escapeQuery(name)
}

func (a *Agent) htmlDescription(description, intro string, links []respondLink, proposeURL string) string {
	if len(links) == 0 {
		return ""
	}
	var buttons []string
	for _, l := range links {
		buttons = append(buttons, fmt.Sprintf(`<a href="%s" style="%s;padding:6px 14px;border-radius:6px;`+
			`text-decoration:none;font-weight:600;display:inline-block;margin:2px">%s</a>`,
			escapeHTML(l.url), buttonStyle[l.response], escapeHTML(a.texts.Buttons[l.response])))
	}
	body := ""
	if description != "" {
		body = "<div>" + strings.ReplaceAll(escapeHTML(description), "\n", "<br>") + "</div>"
	}
	propose := ""
	if proposeURL != "" {
		propose = `<p style="margin:6px 0"><a href="` + escapeHTML(proposeURL) + `">` + escapeHTML(a.texts.Propose) + "</a></p>"
	}
	return body + `<hr><p style="margin:6px 0">` + escapeHTML(intro) + "</p><p>" + strings.Join(buttons, " ") + "</p>" + propose
}

// --- helpers ------------------------------------------------------------

// mayOrganize tells whether user may send invitations from the calendar holding masterPath:
// its owner shared it with them for writing.
func (a *Agent) mayOrganize(user, masterPath string) (bool, error) {
	holder := owner(masterPath)
	calendar := masterPath[:strings.LastIndex(masterPath, "/")+1]
	status, body, _, err := a.request("POST", "/.sharing/v1/map/list", holder, []byte("{}"),
		map[string]string{"Content-Type": "application/json", "Accept": "application/json"})
	if err != nil {
		return false, err
	}
	if status != 200 {
		return false, fmt.Errorf("radicale sharing list returned %d", status)
	}
	var answer struct {
		Content []struct {
			Owner, User, PathMapped, Permissions string
			EnabledByOwner                       bool
		}
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return false, err
	}
	for _, sh := range answer.Content {
		if sh.Owner == holder && sh.User == user && sh.PathMapped == calendar && sh.EnabledByOwner &&
			strings.Contains(sh.Permissions, "w") {
			return true, nil
		}
	}
	return false, nil
}

// copyPath is where user's copy goes: their main calendar, same file name ("" if they have none).
func (a *Agent) copyPath(user, masterPath string) (string, error) {
	name := masterPath[strings.LastIndex(masterPath, "/")+1:]
	calendar, err := a.defaultCalendar(user)
	if err != nil || calendar == "" {
		return "", err
	}
	return "/" + user + "/" + calendar + "/" + name, nil
}

func (a *Agent) defaultCalendar(user string) (string, error) {
	// Any authenticated request provisions the user's predefined collections.
	status, body, _, err := a.request("PROPFIND", "/"+user+"/", user, []byte{}, map[string]string{"Depth": "1"})
	if err != nil || status != 207 {
		return "", err
	}
	root, err := parseXML(body)
	if err != nil {
		return "", err
	}
	var names []string
	for _, h := range root.iter(nsDAV, "href", nil) {
		href := strings.TrimRight(unescape(h.Text), "/")
		if href == "/"+user {
			continue
		}
		names = append(names, href[strings.LastIndex(href, "/")+1:])
	}
	for _, n := range names {
		if n == "def-calendar" {
			return n, nil
		}
	}
	for _, n := range names {
		if n != "def-addressbook" && n != "def-tasks" {
			return n, nil
		}
	}
	return "", nil
}

func (a *Agent) deleteCopy(copyPath, masterPath string) error {
	status, ics, etag, err := a.get(copyPath)
	if err != nil {
		return err
	}
	if status != 200 {
		delete(a.index.Copies, copyPath)
		return nil
	}
	cal, err := ParseICal(ics)
	if err != nil {
		return err
	}
	if m := marker(cal); m != masterPath && m != "" {
		return nil // replaced by another event in the meantime (e.g. moved master)
	}
	delete(a.index.Copies, copyPath)
	_, _, _, err = a.request("DELETE", copyPath, owner(copyPath), nil, map[string]string{"If-Match": etag})
	return err
}

// get returns the body only for a 200.
func (a *Agent) get(path string) (int, []byte, string, error) {
	status, body, etag, err := a.request("GET", path, owner(path), nil, nil)
	if status != 200 {
		body = nil
	}
	return status, body, etag, err
}

func (a *Agent) put(path string, ics []byte, headers map[string]string) error {
	h := map[string]string{"Content-Type": "text/calendar; charset=utf-8"}
	for k, v := range headers {
		h[k] = v
	}
	status, body, _, err := a.request("PUT", path, owner(path), ics, h)
	if err != nil {
		return err
	}
	if status != 200 && status != 201 && status != 204 {
		if len(body) > 200 {
			body = body[:200]
		}
		slog.Warn(fmt.Sprintf("PUT %s -> %d %s", path, status, body))
	}
	return nil
}

func (a *Agent) request(method, path, user string, body []byte, headers map[string]string) (int, []byte, string, error) {
	h := map[string]string{a.header: user}
	for k, v := range headers {
		h[k] = v
	}
	status, data, respHeaders, err := a.http(method, a.radicale+escapePath(path), h, body)
	if err != nil {
		return 0, nil, "", err
	}
	return status, data, respHeaders.Get("ETag"), nil
}

func (a *Agent) href(fsPath string) (string, bool) {
	if fsPath == "" || !strings.HasPrefix(fsPath, a.root+"/") {
		return "", false
	}
	return fsPath[len(a.root):], true
}

func (a *Agent) rememberMaster(path string, entry *masterEntry) error {
	a.index.Masters[path] = entry
	for _, c := range entry.Copies {
		a.index.Copies[c] = path
	}
	return a.saveIndex()
}

func (a *Agent) forgetMaster(path string) error {
	if entry := a.index.Masters[path]; entry != nil {
		for _, c := range entry.Copies {
			if a.index.Copies[c] == path {
				delete(a.index.Copies, c)
			}
		}
	}
	delete(a.index.Masters, path)
	return a.saveIndex()
}

func (a *Agent) loadIndex() invitationIndex {
	idx := invitationIndex{}
	if data, err := os.ReadFile(a.indexPath); err == nil {
		if json.Unmarshal(data, &idx) != nil {
			idx = invitationIndex{}
		}
	}
	if idx.Masters == nil {
		idx.Masters = map[string]*masterEntry{}
	}
	if idx.Copies == nil {
		idx.Copies = map[string]string{}
	}
	if idx.Mails == nil {
		idx.Mails = map[string]string{}
	}
	for path, entry := range idx.Masters {
		if entry == nil {
			entry = &masterEntry{}
			idx.Masters[path] = entry
		}
		if entry.Copies == nil {
			entry.Copies = map[string]string{}
		}
	}
	return idx
}

func (a *Agent) saveIndex() error {
	data, err := json.MarshalIndent(a.index, "", " ")
	if err != nil {
		return err
	}
	tmp := a.indexPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, a.indexPath)
}

// PendingFor lists the upcoming invitations user has not answered yet (for the web app's bell).
func (a *Agent) PendingFor(user string) []Obj {
	now := time.Now().UTC()
	a.mu.Lock()
	var copies []string
	for _, c := range sortedKeys(a.index.Copies) {
		if owner(c) == user {
			copies = append(copies, c)
		}
	}
	a.mu.Unlock()

	type item struct {
		start string
		view  Obj
	}
	var items []item
	for _, c := range copies {
		status, ics, _, err := a.get(c)
		if err != nil || status != 200 {
			continue
		}
		cal, err := ParseICal(ics)
		if err != nil {
			continue
		}
		event := masterEvent(cal)
		if event == nil || attendeesOf(event).answers[user] != "NEEDS-ACTION" {
			continue
		}
		var start any
		startKey, allDay := "", false
		dtstart, dtend := event.Get("DTSTART"), event.Get("DTEND")
		if dtend == nil {
			dtend = dtstart
		}
		if dtstart != nil {
			if t, isDate, ok := dtstart.Time(); ok {
				startKey = t.Format("2006-01-02T15:04:05") + "+00:00"
				start, allDay = startKey, isDate
			}
		}
		recurring := event.Has("RRULE")
		if dtend != nil {
			if end, _, ok := dtend.Time(); ok && end.Before(now) && !recurring {
				continue // past one-off event: nothing to decide any more
			}
		}
		title := event.Text("SUMMARY")
		if event.Has(OriginalSummary) {
			title = event.Text(OriginalSummary)
		}
		organizer := ""
		if org := event.Get("ORGANIZER"); org != nil {
			organizer = org.Param("CN")
		}
		parts := strings.SplitN(c, "/", 4)
		if len(parts) != 4 {
			continue
		}
		items = append(items, item{startKey, Obj{
			{"calendar", parts[2]}, {"event", parts[3]}, {"title", title}, {"start", start},
			{"allDay", allDay}, {"recurring", recurring}, {"organizer", organizer},
		}})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].start < items[j].start })
	result := []Obj{}
	for _, it := range items {
		result = append(result, it.view)
	}
	return result
}

// ListFor lists the invitations organized by or sent to user (for the REST API).
func (a *Agent) ListFor(user string) Obj {
	a.mu.Lock()
	defer a.mu.Unlock()
	organized := []string{}
	for _, m := range sortedKeys(a.index.Masters) {
		if owner(m) == user {
			organized = append(organized, m)
		}
	}
	received := []Obj{}
	for _, c := range sortedKeys(a.index.Copies) {
		if owner(c) == user {
			received = append(received, Obj{{"copy", c}, {"master", a.index.Copies[c]}})
		}
	}
	return Obj{{"organized", organized}, {"received", received}}
}

// --- iCalendar helpers ------------------------------------------------------

func userID(p *Prop) string {
	if p == nil {
		return ""
	}
	return p.Param(UserIDParam)
}

// masterEvent is the first VEVENT that is not an override (or the first VEVENT).
func masterEvent(cal *Component) *Component {
	events := cal.Walk("VEVENT")
	for _, e := range events {
		if !e.Has("RECURRENCE-ID") {
			return e
		}
	}
	if len(events) > 0 {
		return events[0]
	}
	return nil
}

// orderedAnswers maps OpenCloud attendee ids to their PARTSTAT, in order of appearance.
type orderedAnswers struct {
	ids     []string
	answers map[string]string
}

func (o *orderedAnswers) has(id string) bool { _, ok := o.answers[id]; return ok }
func (o *orderedAnswers) len() int           { return len(o.ids) }
func (o *orderedAnswers) remove(id string) {
	if !o.has(id) {
		return
	}
	delete(o.answers, id)
	for i, x := range o.ids {
		if x == id {
			o.ids = append(o.ids[:i:i], o.ids[i+1:]...)
			break
		}
	}
}

// attendeesOf returns {user id: PARTSTAT} for the OpenCloud attendees of event.
func attendeesOf(event *Component) *orderedAnswers {
	o := &orderedAnswers{answers: map[string]string{}}
	if event == nil {
		return o
	}
	for _, attendee := range event.All("ATTENDEE") {
		user := userID(attendee)
		if user == "" {
			continue
		}
		partstat := "NEEDS-ACTION"
		if attendee.HasParam("PARTSTAT") {
			partstat = strings.ToUpper(attendee.Param("PARTSTAT"))
		}
		if !o.has(user) {
			o.ids = append(o.ids, user)
		}
		o.answers[user] = partstat
	}
	return o
}

func owner(path string) string {
	p := strings.Trim(path, "/")
	if i := strings.Index(p, "/"); i >= 0 {
		return p[:i]
	}
	return p
}

// digest hashes what matters in cal: stable across Radicale's re-serialization.
func digest(cal *Component, salt string) string {
	lines := []string{salt}
	for _, component := range cal.Walk("") {
		var props []string
		for _, p := range component.Props {
			if volatile[p.Name] {
				continue
			}
			params := make([]string, 0, len(p.Params))
			for _, prm := range p.Params {
				params = append(params, prm.Name+"="+unquoteParam(prm.Raw))
			}
			sort.Strings(params)
			props = append(props, p.Name+"["+strings.Join(params, ";")+"]="+p.Value)
		}
		sort.Strings(props)
		lines = append(lines, component.Name+"|"+strings.Join(props, "|"))
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])[:32]
}

// marker is the organizer's event path, from the VCALENDAR or (kept by more clients) any VEVENT.
func marker(cal *Component) string {
	if v := cal.Text(OrganizerHref); v != "" {
		return v
	}
	for _, e := range cal.Walk("VEVENT") {
		if v := e.Text(OrganizerHref); v != "" {
			return v
		}
	}
	return ""
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
