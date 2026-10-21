package main

// Free/busy: times only, merged, with the Google / Outlook rules, and no duplicate of what the
// caller already sees.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

type fbBlock struct {
	Start, End, Status string
	AllDay             bool
}

type fbUser struct {
	ID       string
	Calendar bool
	Busy     []fbBlock
	Error    string
}

func TestFreeBusy(t *testing.T) {
	s := newScenario(t, launchGo)
	const day = "start=2026-11-12T00:00:00Z&end=2026-11-14T00:00:00Z"
	query := func(caller, params string) (int, string, map[string]fbUser) {
		t.Helper()
		status, body := s.api(caller, "GET", "/freebusy?"+params, "")
		var out struct{ Users []fbUser }
		users := map[string]fbUser{}
		if status == 200 {
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				t.Fatalf("invalid JSON: %v\n%s", err, body)
			}
			for _, u := range out.Users {
				users[u.ID] = u
			}
		}
		return status, body, users
	}
	blocks := func(u fbUser) string {
		var parts []string
		for _, b := range u.Busy {
			parts = append(parts, b.Start+"/"+b.End+" "+b.Status)
		}
		return strings.Join(parts, ", ")
	}
	put := func(user, calendar, uid string, lines ...string) {
		s.dav(user, "PUT", cal(user, calendar, uid+".ics"), ics(lines...))
	}

	put("bob", "def-calendar", "b1", event("b1", "Entretien confidentiel", "20261112T090000Z", "20261112T100000Z", "LOCATION:Salle RH"))
	put("bob", "def-calendar", "b2", event("b2", "Suite", "20261112T100000Z", "20261112T103000Z"))
	put("bob", "def-calendar", "b3", event("b3", "Lecture", "20261112T110000Z", "20261112T120000Z", "TRANSP:TRANSPARENT"))
	put("bob", "def-calendar", "b4", event("b4", "Peut-être", "20261112T130000Z", "20261112T140000Z", "STATUS:TENTATIVE"))
	put("bob", "def-calendar", "b5", event("b5", "Point", "20261112T133000Z", "20261112T134500Z"))
	put("bob", "def-calendar", "b6", event("b6", "Annulé", "20261112T150000Z", "20261112T160000Z", "STATUS:CANCELLED"))
	put("bob", "def-calendar", "b7", "BEGIN:VEVENT\r\nUID:b7\r\nDTSTAMP:20261016T120000Z\r\nDTSTART;VALUE=DATE:20261112\r\n"+
		"DTEND;VALUE=DATE:20261113\r\nSUMMARY:Anniversaire\r\nEND:VEVENT")
	put("bob", "def-calendar", "b8", "BEGIN:VEVENT\r\nUID:b8\r\nDTSTAMP:20261016T120000Z\r\nDTSTART;VALUE=DATE:20261113\r\n"+
		"DTEND;VALUE=DATE:20261114\r\nSUMMARY:Congés\r\nTRANSP:OPAQUE\r\nEND:VEVENT")
	s.dav("carol", "PROPFIND", home("carol"), "")
	// bob's first API call has his e-mail address learned, which rewrites his copies: get it done
	// before he answers.
	s.api("bob", "GET", "/invitations", "")
	put("carol", "def-calendar", "c1", event("c1", "Carol", "20261112T080000Z", "20261112T083000Z"))
	s.settle()

	status, body, users := query("alice", "users="+bobID+","+carolID+",ffffffff-ffff-4fff-8fff-ffffffffffff&"+day)
	if status != 200 {
		t.Fatalf("freebusy -> %d %s", status, body)
	}
	for _, secret := range []string{"Entretien", "Salle RH", "Anniversaire", "Congés", "b1", "def-calendar"} {
		if strings.Contains(body, secret) {
			t.Errorf("the answer reveals %q: %s", secret, body)
		}
	}
	want := "2026-11-13/2026-11-14 busy, " +
		"2026-11-12T09:00:00Z/2026-11-12T10:30:00Z busy, " + // adjacent events merged
		"2026-11-12T13:00:00Z/2026-11-12T13:30:00Z tentative, " +
		"2026-11-12T13:30:00Z/2026-11-12T13:45:00Z busy, " + // busy wins over tentative
		"2026-11-12T13:45:00Z/2026-11-12T14:00:00Z tentative"
	if got := blocks(users[bobID]); got != want {
		t.Errorf("bob's busy blocks:\n got %s\nwant %s", got, want)
	}
	if got := blocks(users[carolID]); got != "2026-11-12T08:00:00Z/2026-11-12T08:30:00Z busy" {
		t.Errorf("carol's busy blocks: %s", got)
	}
	if u := users["ffffffff-ffff-4fff-8fff-ffffffffffff"]; u.Calendar || len(u.Busy) != 0 {
		t.Errorf("a user without calendars: %+v", u)
	}
	if s.rad.collections["/ffffffff-ffff-4fff-8fff-ffffffffffff/def-calendar/"] != nil {
		t.Error("asking about a user without storage created their home")
	}

	// Blocks are clipped to the range asked.
	_, _, users = query("alice", "users="+bobID+"&start=2026-11-12T09:30:00Z&end=2026-11-12T10:00:00Z")
	if got := blocks(users[bobID]); got != "2026-11-12T09:30:00Z/2026-11-12T10:00:00Z busy" {
		t.Errorf("clipped: %s", got)
	}

	// An invitation from alice: tentative for bob until he answers, then busy.
	s.dav("alice", "PUT", cal("alice", "def-calendar", "sync.ics"), ics(event("sync", "Sync", "20261112T160000Z", "20261112T170000Z")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/sync.ics/guests", `{"guests":["bob"]}`)
	s.settle()
	sync := "2026-11-12T16:00:00Z/2026-11-12T17:00:00Z"
	_, _, users = query("carol", "users="+bobID+"&"+day)
	if !strings.Contains(blocks(users[bobID]), sync+" tentative") {
		t.Errorf("an unanswered invitation is tentative: %s", blocks(users[bobID]))
	}
	s.api("bob", "POST", "/calendars/def-calendar/events/sync.ics/respond", `{"response":"accepted"}`)
	s.settle()
	_, _, users = query("carol", "users="+bobID+"&"+day)
	if !strings.Contains(blocks(users[bobID]), sync+" busy") {
		t.Errorf("an accepted invitation is busy (the hook refreshed the cache): %s", blocks(users[bobID]))
	}
	_, _, users = query("alice", "users="+bobID+","+aliceID+"&"+day+"&except=sync")
	if strings.Contains(blocks(users[bobID]), sync) || strings.Contains(blocks(users[aliceID]), sync) {
		t.Errorf("except leaves out the event being edited: bob %s / alice %s", blocks(users[bobID]), blocks(users[aliceID]))
	}
	_, _, users = query("carol", "users="+bobID+"&"+day+"&except=sync")
	if !strings.Contains(blocks(users[bobID]), sync) {
		t.Errorf("except is ignored for an event the caller is not part of: %s", blocks(users[bobID]))
	}
	s.api("bob", "POST", "/calendars/def-calendar/events/sync.ics/respond", `{"response":"declined"}`)
	s.settle()
	_, _, users = query("carol", "users="+bobID+"&"+day)
	if strings.Contains(blocks(users[bobID]), sync) {
		t.Errorf("a declined invitation is free: %s", blocks(users[bobID]))
	}
	s.api("bob", "POST", "/calendars/def-calendar/events/sync.ics/respond", `{"response":"accepted"}`)
	s.settle()

	// omit=known: nothing alice already sees (the invitation, bob's calendar shared with her).
	s.dav("bob", "MKCALENDAR", home("bob")+"work/", "")
	put("bob", "work", "w1", event("w1", "Projet", "20261112T180000Z", "20261112T190000Z"))
	s.api("bob", "PUT", "/calendars/work/shares/alice", `{"permission":"read"}`)
	s.settle()
	work := "2026-11-12T18:00:00Z/2026-11-12T19:00:00Z busy"
	_, _, users = query("alice", "users="+bobID+"&"+day)
	if got := blocks(users[bobID]); !strings.Contains(got, sync) || !strings.Contains(got, work) {
		t.Errorf("without omit, everything: %s", got)
	}
	_, _, users = query("alice", "users="+bobID+"&"+day+"&omit=known")
	if got := blocks(users[bobID]); strings.Contains(got, sync) || strings.Contains(got, work) || !strings.Contains(got, "09:00:00Z") {
		t.Errorf("omit=known leaves out the shared event and calendar only: %s", got)
	}
	_, _, users = query("carol", "users="+bobID+"&"+day+"&omit=known")
	if got := blocks(users[bobID]); !strings.Contains(got, sync) || !strings.Contains(got, work) {
		t.Errorf("omit=known for someone outside: %s", got)
	}
	// A public event shows its title and place, as its own block; a private one next to it stays anonymous.
	put("carol", "def-calendar", "c2", event("c2", "Formation Go", "20261112T140000Z", "20261112T150000Z",
		"LOCATION:Salle 2", "X-OC-VISIBILITY:PUBLIC", "DESCRIPTION:notes privées"))
	put("carol", "def-calendar", "c3", event("c3", "Rendez-vous perso", "20261112T143000Z", "20261112T153000Z", "CLASS:PUBLIC"))
	s.settle()
	status, body, users = query("bob", "users="+carolID+"&"+day)
	if status != 200 || !strings.Contains(body, `"title": "Formation Go", "location": "Salle 2"`) ||
		strings.Contains(body, "notes privées") || strings.Contains(body, "Rendez-vous perso") {
		t.Errorf("public event: %s", body)
	}
	if got := blocks(users[carolID]); !strings.Contains(got, "14:00:00Z/2026-11-12T15:00:00Z busy") ||
		!strings.Contains(got, "14:30:00Z/2026-11-12T15:30:00Z busy") {
		t.Errorf("public and private blocks side by side, not merged: %s", got)
	}

	// Alice's calendar does not include what is shared with her.
	_, _, users = query("bob", "users="+aliceID+"&"+day)
	if got := blocks(users[aliceID]); got != sync+" busy" {
		t.Errorf("alice's own events only: %s", got)
	}

	var ids []string
	for i := range maxFreeBusyUsers + 1 {
		ids = append(ids, fmt.Sprintf("user-%d", i))
	}
	many := strings.Join(ids, ",")
	for _, bad := range []string{
		day,
		"users=" + bobID,
		"users=" + bobID + "&start=2026-11-12T00:00:00Z&end=2026-11-11T00:00:00Z",
		"users=" + bobID + "&start=2026-01-01T00:00:00Z&end=2026-12-01T00:00:00Z",
		"users=" + url.QueryEscape("../alice") + "&" + day,
		"users=" + many + "&" + day,
	} {
		if status, body, _ := query("alice", bad); status != 400 {
			t.Errorf("%s -> %d %s, want 400", bad, status, body)
		}
	}
}

func TestFreeBusyDisabled(t *testing.T) {
	s := &Server{cfg: Config{}}
	_, err := s.freeBusy(aliceID, url.Values{"users": {bobID}})
	if ae, ok := err.(*ApiError); !ok || ae.Status != 403 {
		t.Errorf("disabled: %v", err)
	}
}
