package main

import (
	"strings"
	"testing"
)

// TestCalendarSettings: renaming and recoloring a calendar reaches its shares (unless the recipient was given
// another name), and deleting it removes its shares and the guests' copies of its invitations.
func TestCalendarSettings(t *testing.T) {
	s := newScenario(t, launchGo)
	s.dav("alice", "PROPFIND", home("alice"), "")
	s.dav("bob", "PROPFIND", home("bob"), "")
	s.dav("carol", "PROPFIND", home("carol"), "")
	s.dav("alice", "MKCALENDAR", home("alice")+"work/", "")
	s.api("alice", "PUT", "/calendars/work/shares/bob", `{"permission":"read"}`)
	s.api("alice", "PUT", "/calendars/work/shares/carol", `{"permission":"read","displayName":"Projets Alice"}`)
	listing := func(user string) string {
		_, body, _ := s.dav(user, "PROPFIND", home(user), "")
		return body
	}
	mount := "work-be578ae3/"

	status, body := s.api("alice", "PATCH", "/calendars/work", `{"displayName":"R&D <2027>","color":"#10b981"}`)
	if status != 200 || !strings.Contains(body, `"displayName": "R&D <2027>"`) || !strings.Contains(body, `"color": "#10b981"`) {
		t.Errorf("rename: %d %s", status, body)
	}
	if got := listing("bob"); !strings.Contains(got, mount) || !strings.Contains(got, "R&amp;D &lt;2027&gt; (") ||
		!strings.Contains(got, "#10b981") {
		t.Errorf("bob's mount follows the new name and color: %s", got)
	}
	if got := listing("carol"); !strings.Contains(got, "Projets Alice") || strings.Contains(got, "R&amp;D") ||
		!strings.Contains(got, "#10b981") {
		t.Errorf("carol keeps the name she was given, takes the color: %s", got)
	}
	status, body = s.api("alice", "PATCH", "/calendars/work", `{"color":"#ef4444"}`)
	if status != 200 || !strings.Contains(body, `"displayName": "R&D <2027>"`) {
		t.Errorf("color alone keeps the name: %d %s", status, body)
	}

	for _, bad := range []struct{ user, cal, body string }{
		{"alice", "work", `{}`},
		{"alice", "work", `{"displayName":"  "}`},
		{"alice", "work", `{"displayName":42}`},
		{"alice", "work", `{"color":"red"}`},
		{"alice", "work", `{"color":"#10b98180"}`},
	} {
		if status, body := s.api(bad.user, "PATCH", "/calendars/"+bad.cal, bad.body); status != 400 {
			t.Errorf("PATCH %s -> %d %s, want 400", bad.body, status, body)
		}
	}
	if status, _ := s.api("bob", "PATCH", "/calendars/"+strings.TrimSuffix(mount, "/"), `{"displayName":"x"}`); status != 404 {
		t.Errorf("a recipient cannot rename the owner's calendar: %d", status)
	}
	if status, _ := s.api("alice", "PATCH", "/calendars/nope", `{"displayName":"x"}`); status != 404 {
		t.Errorf("unknown calendar: %d", status)
	}

	// An invitation sent from the calendar, to check its copy goes with it.
	s.dav("alice", "PUT", cal("alice", "work", "kickoff.ics"), ics(event("kickoff", "Lancement", "20261201T090000Z", "20261201T100000Z")))
	s.api("alice", "PUT", "/calendars/work/events/kickoff.ics/guests", `{"guests":["bob"]}`)
	s.settle()
	if st, _, _ := s.get("bob", cal("bob", "def-calendar", "kickoff.ics")); st != 200 {
		t.Fatalf("bob was not invited: %d", st)
	}

	for _, def := range []string{"def-calendar", "def-tasks"} {
		if status, _ := s.api("alice", "DELETE", "/calendars/"+def, ""); status != 403 {
			t.Errorf("deleting %s: %d, want 403", def, status)
		}
	}
	if status, _ := s.api("bob", "DELETE", "/calendars/"+strings.TrimSuffix(mount, "/"), ""); status != 404 {
		t.Errorf("a recipient cannot delete the owner's calendar: %d", status)
	}
	if status, _ := s.api("alice", "DELETE", "/calendars/work", ""); status != 204 {
		t.Fatalf("delete: %d", status)
	}
	s.settle()
	if got := listing("alice"); strings.Contains(got, "/work/") {
		t.Errorf("calendar still listed: %s", got)
	}
	if got := listing("bob"); strings.Contains(got, mount) {
		t.Errorf("bob's mount still listed: %s", got)
	}
	if _, body := s.api("alice", "GET", "/shares", ""); strings.Contains(body, "/work/") {
		t.Errorf("shares left behind: %s", body)
	}
	if st, _, _ := s.get("bob", cal("bob", "def-calendar", "kickoff.ics")); st != 404 {
		t.Errorf("bob's copy of the invitation: %d, want 404", st)
	}
	if status, _ := s.api("alice", "DELETE", "/calendars/work", ""); status != 404 {
		t.Errorf("deleting again: %d, want 404", status)
	}
	if t.Failed() {
		t.Logf("transcript:\n%s", s.out.String())
	}
}
