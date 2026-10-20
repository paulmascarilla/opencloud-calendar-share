package main

// A guest's copy is the organizer's event: edits made to it in a CalDAV client are undone, and a
// changed date becomes a proposal the organizer accepts or declines.

import (
	"regexp"
	"strings"
	"testing"
)

func TestProposals(t *testing.T) {
	s := newScenario(t, launchGo)
	const ev = "rev-1.ics"
	master := func() string { _, b, _ := s.get("alice", cal("alice", "def-calendar", ev)); return b }
	bobCopy := func() (string, string) { _, b, etag := s.get("bob", cal("bob", "def-calendar", ev)); return b, etag }
	// edit rewrites bob's copy as a CalDAV client would, keeping every marker.
	edit := func(change func(line string) string) {
		c, etag := bobCopy()
		var lines []string
		for _, l := range strings.Split(strings.TrimSpace(c), "\n") {
			if l = change(l); l != "" {
				lines = append(lines, l)
			}
		}
		s.dav("bob", "PUT", cal("bob", "def-calendar", ev), strings.Join(lines, "\r\n")+"\r\n", "If-Match: "+etag)
		s.settle()
	}
	bobAttendee := func() string {
		return regexp.MustCompile(`(?m)^ATTENDEE[^\n]*X-OC-USERID=` + bobID + `[^\n]*$`).FindString(master())
	}
	check := func(name string, ok bool) {
		t.Helper()
		if !ok {
			t.Errorf("%s\nmaster:\n%s", name, master())
		}
	}

	s.dav("bob", "PROPFIND", home("bob"), "")
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), ics(event("rev-1", "Revue", "20261112T090000Z", "20261112T100000Z", "LOCATION:Salle 1")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["bob"]}`)
	s.settle()

	c, _ := bobCopy()
	check("the copy names the organizer and the guest by e-mail, for clients to see an invitation",
		regexp.MustCompile(`(?m)^ORGANIZER[^\n]*:mailto:alice@example.org$`).MatchString(c) &&
			regexp.MustCompile(`(?m)^ATTENDEE[^\n]*X-OC-USERID=`+bobID+`[^\n]*:mailto:bob@example.org$`).MatchString(c))
	check("the organizer's event keeps its OpenCloud addresses", strings.Contains(master(), ":urn:uuid:"+bobID))
	check("the copy offers to propose another time", strings.Contains(c, "Proposer un autre horaire : "+publicURL+"/calendar/respond?cal=def-calendar&event=rev-1.ics\n"))

	// 1. bob renames his copy and changes the place: undone
	edit(func(l string) string {
		switch {
		case strings.HasPrefix(l, "SUMMARY:"):
			return "SUMMARY:Revue (bob)"
		case strings.HasPrefix(l, "LOCATION:"):
			return "LOCATION:Chez bob"
		}
		return l
	})
	c, _ = bobCopy()
	check("title and place restored from the organizer", strings.Contains(c, "\nSUMMARY:Revue\n") && strings.Contains(c, "\nLOCATION:Salle 1\n"))
	check("no proposal for a text change", !strings.Contains(bobAttendee(), "X-OC-PROPOSED"))

	// 2. bob moves his copy in GNOME Calendar (Evolution's TZID): a proposal, and the copy is put back
	edit(func(l string) string {
		switch {
		case strings.HasPrefix(l, "DTSTART"):
			return "DTSTART;TZID=/freeassociation.sourceforge.net/Europe/Paris:20261112T110000"
		case strings.HasPrefix(l, "DTEND"):
			return "DTEND;TZID=/freeassociation.sourceforge.net/Europe/Paris:20261112T120000"
		}
		return l
	})
	check("bob's move recorded as a proposal (11:00 Paris = 10:00 UTC)",
		strings.Contains(bobAttendee(), "X-OC-PROPOSED-START=20261112T100000Z") && strings.Contains(bobAttendee(), "X-OC-PROPOSED-END=20261112T110000Z"))
	check("the organizer's time is unchanged", strings.Contains(master(), "\nDTSTART:20261112T090000Z\n"))
	c, _ = bobCopy()
	check("bob's copy is back at the organizer's time", strings.Contains(c, "\nDTSTART:20261112T090000Z\n"))
	_, guests := s.api("alice", "GET", "/calendars/def-calendar/events/"+ev+"/guests", "")
	check("the guest list shows the proposal", strings.Contains(guests, `"proposal": {"start": "2026-11-12T10:00:00Z", "end": "2026-11-12T11:00:00Z", "allDay": false}`))

	// 3. proposing from the web app
	st, _ := s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/propose", `{"start":"2026-11-12T14:00:00Z","end":"2026-11-12T13:00:00Z"}`)
	check("a proposal must end after it starts", st == 400)
	st, _ = s.api("alice", "POST", "/calendars/def-calendar/events/"+ev+"/propose", `{"start":"2026-11-12T13:00:00Z","end":"2026-11-12T14:00:00Z"}`)
	check("the organizer does not propose on their own event", st == 403)
	st, _ = s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/propose", `{"start":"2026-11-12T13:00:00Z","end":"2026-11-12T14:00:00Z"}`)
	s.settle()
	check("bob proposes from the web app", st == 200 && strings.Contains(bobAttendee(), "X-OC-PROPOSED-START=20261112T130000Z"))

	// 4. only the organizer decides
	st, _ = s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/proposals/"+bobID+"/accept", "")
	check("a guest cannot accept a proposal", st == 403)
	st, _ = s.api("alice", "POST", "/calendars/def-calendar/events/"+ev+"/proposals/"+bobID+"/decline", "")
	s.settle()
	check("the organizer declines: proposal gone", st == 200 && !strings.Contains(bobAttendee(), "X-OC-PROPOSED"))
	st, _ = s.api("alice", "POST", "/calendars/def-calendar/events/"+ev+"/proposals/"+bobID+"/accept", "")
	check("nothing to accept any more", st == 404)

	s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/propose", `{"start":"2026-11-13","end":"2026-11-14"}`)
	s.settle()
	st, _ = s.api("alice", "POST", "/calendars/def-calendar/events/"+ev+"/proposals/"+bobID+"/accept", "")
	s.settle()
	m := master()
	check("the organizer accepts: the event takes the proposed (all-day) date",
		st == 200 && strings.Contains(m, "\nDTSTART;VALUE=DATE:20261113\n") && strings.Contains(m, "\nDTEND;VALUE=DATE:20261114\n"))
	check("…bob's answer becomes accepted, the proposal is cleared",
		strings.Contains(bobAttendee(), "PARTSTAT=ACCEPTED") && !strings.Contains(bobAttendee(), "X-OC-PROPOSED"))
	c, _ = bobCopy()
	check("bob's copy follows", strings.Contains(c, "\nDTSTART;VALUE=DATE:20261113\n"))

	// 5. a series: moving the copy is undone, without a proposal (one date cannot stand for the series)
	const series = "weekly-9.ics"
	s.dav("alice", "PUT", cal("alice", "def-calendar", series), ics(event("weekly-9", "Point", "20261102T090000Z", "20261102T093000Z", "RRULE:FREQ=WEEKLY")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+series+"/guests", `{"guests":["bob"]}`)
	s.settle()
	_, sc, etag := s.get("bob", cal("bob", "def-calendar", series))
	s.dav("bob", "PUT", cal("bob", "def-calendar", series), strings.ReplaceAll(strings.Replace(sc, "DTSTART:20261102T090000Z", "DTSTART:20261102T150000Z", 1), "\n", "\r\n"), "If-Match: "+etag)
	s.settle()
	_, sc, _ = s.get("bob", cal("bob", "def-calendar", series))
	_, sm, _ := s.get("alice", cal("alice", "def-calendar", series))
	check("series copy put back", strings.Contains(sc, "\nDTSTART:20261102T090000Z\n"))
	check("no proposal on a series", !strings.Contains(sm, "X-OC-PROPOSED"))

	// 6. answering from the client still works, and is not taken for an edit
	edit(func(l string) string {
		if strings.Contains(l, "X-OC-USERID="+bobID) && strings.HasPrefix(l, "ATTENDEE") {
			return regexp.MustCompile(`PARTSTAT=[A-Z-]+`).ReplaceAllString(l, "PARTSTAT=TENTATIVE")
		}
		return l
	})
	check("bob's answer from his client reaches the organizer", strings.Contains(bobAttendee(), "PARTSTAT=TENTATIVE"))
}

// TestLearnedMail: with a non-admin service account, Graph hides e-mail addresses; each user's
// own address is learned from their requests, and their copies are rewritten with it.
func TestLearnedMail(t *testing.T) {
	graphHidesMail = true
	t.Cleanup(func() { graphHidesMail = false })
	s := newScenario(t, launchGo)
	const ev = "mail-1.ics"
	s.dav("bob", "PROPFIND", home("bob"), "")
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), ics(event("mail-1", "Adresses", "20261112T090000Z", "20261112T100000Z")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["bob"]}`)
	s.settle()
	bobCopy := func() string { _, c, _ := s.get("bob", cal("bob", "def-calendar", ev)); return c }
	organizer := regexp.MustCompile(`(?m)^ORGANIZER[^\n]*:mailto:alice@example.org$`)
	guest := regexp.MustCompile(`(?m)^ATTENDEE[^\n]*:mailto:bob@example.org$`)
	if c := bobCopy(); !organizer.MatchString(c) || guest.MatchString(c) {
		t.Fatalf("alice's address should be known (she called the API), not bob's yet:\n%s", c)
	}
	s.api("bob", "GET", "/invitations/pending", "")
	s.settle()
	if c := bobCopy(); !guest.MatchString(c) {
		t.Fatalf("bob's copy should name him by e-mail once he used the web app:\n%s", c)
	}
}
