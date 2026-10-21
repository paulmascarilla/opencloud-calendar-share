package main

// End-to-end scenarios (ports of test/e2e.sh and test/invitations-e2e.sh plus edge cases)
// against the fake Radicale and Graph. Every step is written to a transcript.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

const publicURL = "https://cloud.example"

var userIDs = map[string]string{"alice": aliceID, "bob": bobID, "admin": adminID, "carol": carolID}

// launcher starts a sidecar against the fakes and returns its URL and a stop function.
type launcher func(t *testing.T, radicaleURL, graphURL, root, state string) (string, func())

func launchGo(t *testing.T, radicaleURL, graphURL, root, state string) (string, func()) {
	s, err := NewServer(Config{
		BasePath: "/calshare", RadicaleURL: radicaleURL, OCURL: graphURL, OCServiceAuth: "svc:token",
		AutoAccept: true, RemoteUserHeader: "X-Remote-User", CollectionRoot: root, StateDir: state,
		PublicURL: publicURL, InviteLanguage: "fr", FreeBusy: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s)
	stop := s.agent.startForTest()
	return srv.URL, func() { stop(); srv.Close() }
}

// sc drives one scenario run.
type sc struct {
	t       *testing.T
	rad     *fakeRadicale
	graph   string
	root    string
	state   string
	sidecar string
	stop    func()
	out     strings.Builder
	failed  []string
}

func newScenario(t *testing.T, launch launcher) *sc {
	root := filepath.Join(t.TempDir(), "collection-root")
	os.MkdirAll(root, 0o755)
	s := &sc{t: t, rad: newFakeRadicale(root), graph: newFakeGraph().URL, root: root, state: t.TempDir()}
	s.start(launch)
	t.Cleanup(func() { s.stop() })
	return s
}

func (s *sc) start(launch launcher) {
	started := time.Now()
	s.sidecar, s.stop = launch(s.t, s.rad.srv.URL, s.graph, s.root, s.state)
	s.rad.setHook(s.sidecar)
	// The agent's first move is to wait for Radicale, then it scans: wait for that to happen.
	for deadline := time.Now().Add(10 * time.Second); !s.rad.lastSeen().After(started); {
		if time.Now().After(deadline) {
			s.t.Fatal("the agent never contacted radicale")
		}
		time.Sleep(20 * time.Millisecond)
	}
	s.settle()
}

// restart stops the sidecar, runs offline() while it is down, then starts launch on the same data.
func (s *sc) restart(launch launcher, offline func()) {
	s.stop()
	s.rad.setHook("")
	if offline != nil {
		offline()
	}
	s.start(launch)
}

func (s *sc) logf(format string, args ...any) { fmt.Fprintf(&s.out, format+"\n", args...) }

func (s *sc) step(name string) { s.logf("\n### %s", name) }

// settle waits until nobody talked to Radicale for a while: the agent is done.
func (s *sc) settle() {
	deadline := time.Now().Add(20 * time.Second)
	for s.rad.idleSince() < 400*time.Millisecond {
		if time.Now().After(deadline) {
			s.t.Fatal("radicale never went idle")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *sc) check(name string, ok bool) {
	if ok {
		s.logf("  ok  %s", name)
	} else {
		s.logf("  KO  %s", name)
		s.failed = append(s.failed, name)
	}
}

func basicAuth(user string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":token"))
}

// raw sends a request to the sidecar.
func (s *sc) raw(method, path string, headers map[string]string, body string) (int, string) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, s.sidecar+path, reader)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

// api calls the REST API as user (as the OpenCloud proxy would) and records the answer.
func (s *sc) api(user, method, path, body string) (int, string) {
	headers := map[string]string{}
	if user != "" {
		headers["X-Remote-User"] = userIDs[user]
		headers["Authorization"] = basicAuth(user)
	}
	if body != "" {
		headers["Content-Type"] = "application/json"
	}
	status, data := s.raw(method, "/calshare/v1"+path, headers, body)
	if path == "/invitations" && status == 200 {
		data = sortedInvitations(data)
	}
	s.logf("%s %s %s %s -> %d %s", user, method, path, body, status, data)
	return status, data
}

// dav calls Radicale directly as user; headers are "Name: value" strings.
func (s *sc) dav(user, method, path, body string, headers ...string) (int, string, string) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, s.rad.srv.URL+path, reader)
	req.Header.Set("X-Remote-User", userIDs[user])
	for _, h := range headers {
		k, v, _ := strings.Cut(h, ": ")
		req.Header.Set(k, v)
	}
	if method == "PROPFIND" {
		req.Header.Set("Depth", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	s.logf("dav %s %s %s -> %d", user, method, path, resp.StatusCode)
	return resp.StatusCode, string(data), resp.Header.Get("ETag")
}

// get reads an item as user without recording it; unfolded, LF line ends.
func (s *sc) get(user, path string) (int, string, string) {
	req, _ := http.NewRequest("GET", s.rad.srv.URL+path, nil)
	req.Header.Set("X-Remote-User", userIDs[user])
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	text := strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n ", "")
	return resp.StatusCode, text, resp.Header.Get("ETag")
}

// show records a normalized view of a stored item (order, quoting and folding removed).
func (s *sc) show(path string) {
	data := s.rad.item(path)
	if data == nil {
		s.logf("  %s: absent", path)
		return
	}
	cal, err := ParseICal(data)
	if err != nil {
		s.logf("  %s: unparsable: %v", path, err)
		return
	}
	s.logf("  %s:\n%s", path, normalizeICal(cal, "    "))
}

var hashRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

func normalizeICal(c *Component, indent string) string {
	var lines []string
	for _, p := range c.Props {
		var params []string
		for _, prm := range p.Params {
			params = append(params, prm.Name+"="+unquoteParam(prm.Raw))
		}
		sort.Strings(params)
		value := p.Value
		switch {
		case p.Name == SyncHash && hashRE.MatchString(value):
			value = "<hash>"
		case p.Name == OriginalSummary || p.Name == OriginalDescr:
			// Compare the texts, whatever their escaping.
			value = UnescapeText(value)
		case p.Name == "RRULE":
			parts := strings.Split(value, ";")
			sort.Strings(parts)
			value = strings.Join(parts, ";")
		}
		lines = append(lines, indent+"  "+strings.Join(append([]string{p.Name}, params...), ";")+":"+value)
	}
	sort.Strings(lines)
	out := indent + c.Name + "\n" + strings.Join(lines, "\n")
	var subs []string
	for _, sub := range c.Subs {
		subs = append(subs, normalizeICal(sub, indent+"  "))
	}
	sort.Strings(subs)
	for _, sub := range subs {
		out += "\n" + sub
	}
	return out
}

// sortedInvitations sorts the lists of a GET /invitations answer, so that transcripts do not
// depend on their order (the web app does not either).
func sortedInvitations(data string) string {
	var v struct {
		Organized []string            `json:"organized"`
		Received  []map[string]string `json:"received"`
	}
	if json.Unmarshal([]byte(data), &v) != nil {
		return data
	}
	sort.Strings(v.Organized)
	received := []Obj{}
	sort.Slice(v.Received, func(i, j int) bool { return v.Received[i]["copy"] < v.Received[j]["copy"] })
	for _, r := range v.Received {
		received = append(received, Obj{{"copy", r["copy"]}, {"master", r["master"]}})
	}
	return string(encodeJSON(Obj{{"organized", v.Organized}, {"received", received}}))
}

func home(user string) string { return "/" + userIDs[user] + "/" }

func cal(user, calendar, name string) string { return home(user) + calendar + "/" + name }

func ics(lines ...string) string {
	return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n" + strings.Join(lines, "\r\n") + "\r\nEND:VCALENDAR\r\n"
}

func event(uid, summary, start, end string, extra ...string) string {
	lines := []string{"BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:20261016T120000Z", "DTSTART:" + start}
	if end != "" {
		lines = append(lines, "DTEND:"+end)
	}
	lines = append(lines, "SUMMARY:"+summary)
	lines = append(lines, extra...)
	return strings.Join(append(lines, "END:VEVENT"), "\r\n")
}

// --- scenarios ----------------------------------------------------------------

func sharingScenario(s *sc) {
	s.step("provision CalDAV homes (first login)")
	s.dav("alice", "PROPFIND", home("alice"), "")
	s.dav("bob", "PROPFIND", home("bob"), "")

	s.step("basics")
	status, body := s.raw("GET", "/healthz", nil, "")
	s.logf("healthz -> %d %s", status, body)
	s.check("unauthenticated (401)", func() bool { st, _ := s.api("", "GET", "/shares", ""); return st == 401 }())
	status, _ = s.raw("GET", "/calshare/v1/shares", map[string]string{"X-Remote-User": "../etc"}, "")
	s.check("invalid remote user (401)", status == 401)
	s.check("unknown route (404)", func() bool { st, _ := s.api("alice", "GET", "/nope", ""); return st == 404 }())
	status, body = s.raw("GET", "/calshare/v2/shares", map[string]string{"X-Remote-User": aliceID}, "")
	s.logf("v2 -> %d %s", status, body)
	s.check("wrong method (404)", func() bool { st, _ := s.api("alice", "POST", "/shares", ""); return st == 404 }())
	s.check("invalid segment (400)", func() bool {
		st, _ := s.api("alice", "GET", "/calendars/%2Fetc%27x/shares", "")
		return st == 400
	}())
	status, body = s.raw("GET", "/v1/calendars", map[string]string{"X-Remote-User": aliceID}, "")
	s.logf("without base path -> %d %s", status, body)
	status, body = s.raw("POST", "/internal/storage-changed", map[string]string{"X-Forwarded-For": "10.0.0.1"}, "")
	s.check("storage hook through a proxy (403)", status == 403)
	s.logf("  %d %s", status, body)

	s.step("alice: list own calendars")
	s.api("alice", "GET", "/calendars", "")
	s.step("alice: share def-calendar with bob (read, by username)")
	status, _ = s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"read"}`)
	s.check("share created (201)", status == 201)
	s.api("alice", "GET", "/shares", "")
	s.api("alice", "GET", "/calendars/def-calendar/shares", "")
	s.api("bob", "GET", "/shared-with-me", "")
	_, listing, _ := s.dav("bob", "PROPFIND", home("bob"), "")
	s.check("bob's home lists the mount", strings.Contains(listing, "def-calendar-be578ae3/</href>") && strings.Contains(listing, "Agenda (alice)"))
	s.api("bob", "GET", "/calendars", "")

	s.step("alice: create event, bob reads it through his mount")
	s.dav("alice", "PUT", cal("alice", "def-calendar", "e2e-1.ics"), ics(event("e2e-1", "Reunion Alice", "20261020T090000Z", "20261020T100000Z")))
	_, got, _ := s.get("bob", cal("bob", "def-calendar-be578ae3", "e2e-1.ics"))
	s.check("bob reads alice's event", strings.Contains(got, "SUMMARY:Reunion Alice"))
	st, _, _ := s.dav("bob", "PUT", cal("bob", "def-calendar-be578ae3", "e2e-2.ics"), ics(event("e2e-2", "Bob", "20261021T090000Z", "")))
	s.check("bob cannot write with read permission (403)", st == 403)

	s.step("alice: upgrade bob to write (by e-mail)")
	status, _ = s.api("alice", "PUT", "/calendars/def-calendar/shares/bob@example.org", `{"permission":"write"}`)
	s.check("share updated (200)", status == 200)
	st, _, _ = s.dav("bob", "PUT", cal("bob", "def-calendar-be578ae3", "e2e-2.ics"), ics(event("e2e-2", "Bob", "20261021T090000Z", "")))
	s.check("bob writes (201)", st == 201)
	_, got, _ = s.get("alice", cal("alice", "def-calendar", "e2e-2.ics"))
	s.check("alice sees bob's event", strings.Contains(got, "SUMMARY:Bob"))

	s.step("share options and errors")
	s.api("alice", "PUT", "/calendars/def-tasks/shares/"+adminID, `{"permission":"write","displayName":"Tâches partagées"}`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/carol", "")
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"admin"}`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":null}`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{bad json`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `["read"]`)
	s.check("trailing JSON data rejected (400)", func() bool {
		st, _ := s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"read"} x`)
		return st == 400
	}())
	s.api("alice", "PUT", "/calendars/def-calendar/shares/alice", `{}`)
	s.api("alice", "PUT", "/calendars/nope/shares/bob", `{}`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/nobody", `{}`)
	s.api("alice", "PUT", "/calendars/def-calendar/shares/00000000-0000-0000-0000-000000000000", `{}`)
	s.api("bob", "PUT", "/calendars/def-calendar-be578ae3/shares/admin", `{}`)
	s.api("alice", "GET", "/shares", "")
	s.api("admin", "GET", "/shared-with-me", "")
	st, _, _ = s.dav("bob", "PROPFIND", home("alice"), "")
	s.check("bob cannot list alice's home (403)", st == 403)

	s.step("bob: decline then accept")
	s.api("bob", "POST", "/shared-with-me/def-calendar-be578ae3/decline", "")
	_, listing, _ = s.dav("bob", "PROPFIND", home("bob"), "")
	s.check("mount hidden after decline", !strings.Contains(listing, "def-calendar-be578ae3"))
	s.api("bob", "POST", "/shared-with-me/def-calendar-be578ae3/accept", "")
	_, listing, _ = s.dav("bob", "PROPFIND", home("bob"), "")
	s.check("mount back after accept", strings.Contains(listing, "def-calendar-be578ae3"))
	s.api("bob", "POST", "/shared-with-me/nope/accept", "")

	s.step("alice: revoke")
	status, _ = s.api("alice", "DELETE", "/calendars/def-calendar/shares/bob", "")
	s.check("revoked (204)", status == 204)
	s.api("alice", "DELETE", "/calendars/def-calendar/shares/bob", "")
	s.api("alice", "DELETE", "/calendars/def-calendar/shares/carol", "")
	s.api("alice", "DELETE", "/calendars/def-tasks/shares/"+adminID, "")
	_, listing, _ = s.dav("bob", "PROPFIND", home("bob"), "")
	s.check("mount gone", !strings.Contains(listing, "def-calendar-be578ae3"))
	st, _, _ = s.get("bob", cal("bob", "def-calendar-be578ae3", "e2e-1.ics"))
	s.check("bob cannot read any more", st == 404 || st == 403)
	s.dav("alice", "DELETE", cal("alice", "def-calendar", "e2e-1.ics"), "")
	s.dav("alice", "DELETE", cal("alice", "def-calendar", "e2e-2.ics"), "")
	s.settle()
}

func invitationsScenario(s *sc) {
	const ev = "inv-1.ics"
	alarm := []string{"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:rappel", "END:VALARM"}
	guests := func() string {
		_, b := s.api("alice", "GET", "/calendars/def-calendar/events/"+ev+"/guests", "")
		return b
	}
	copyOf := func(user string) (int, string) { st, b, _ := s.get(user, cal(user, "def-calendar", ev)); return st, b }
	answered := func(id, name, response string) bool {
		return strings.Contains(guests(), fmt.Sprintf(`"id": "%s", "displayName": "%s", "response": "%s"`, id, name, response))
	}

	s.step("alice creates " + ev + " and invites bob + admin (by username)")
	s.dav("bob", "PROPFIND", home("bob"), "")
	s.dav("admin", "PROPFIND", home("admin"), "")
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), ics(event("inv-1", "Comité projet", "20261028T130000Z", "20261028T140000Z", alarm...)))
	s.settle()
	_, r := s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["bob","admin"]}`)
	s.check("both guests pending", strings.Count(r, `"response": "pending"`) == 2)
	s.settle()
	_, bobCopy := copyOf("bob")
	s.check("bob got a copy", strings.Contains(bobCopy, "\nX-OC-SUMMARY:Comité projet\n"))
	s.check("pending copy is flagged for CalDAV clients", strings.Contains(bobCopy, "\nSUMMARY:Comité projet\n") &&
		strings.Contains(bobCopy, "\nSTATUS:TENTATIVE") && strings.Contains(bobCopy, "\nTRANSP:TRANSPARENT"))
	s.check("copy has an Accept link to the web app", strings.Contains(bobCopy,
		"Accepter : "+publicURL+"/calendar/respond?cal=def-calendar&event="+ev+"&response=accepted"))
	_, adminCopy := copyOf("admin")
	s.check("admin got a copy", strings.Contains(adminCopy, "X-OC-ORGANIZER-HREF:"+cal("alice", "def-calendar", ev)))
	s.check("organizer alarm not copied", !strings.Contains(bobCopy, "VALARM"))
	s.show(cal("alice", "def-calendar", ev))
	s.show(cal("bob", "def-calendar", ev))
	s.api("bob", "GET", "/invitations/pending", "")
	s.api("alice", "GET", "/invitations", "")
	s.api("bob", "GET", "/invitations", "")

	s.step("bob accepts (REST respond on his copy)")
	s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/respond", `{"response":"accepted"}`)
	s.settle()
	s.check("alice sees bob accepted", answered(bobID, "bob", "accepted"))
	_, bobCopy = copyOf("bob")
	s.check("bob's copy is no longer flagged", strings.Contains(bobCopy, "\nSUMMARY:Comité projet\n") && !strings.Contains(bobCopy, "STATUS:TENTATIVE"))
	_, adminCopy = copyOf("admin")
	s.check("admin's copy shows bob accepted", regexp.MustCompile(`ATTENDEE[^\n]*PARTSTAT=ACCEPTED[^\n]*X-OC-USERID=`+bobID).MatchString(adminCopy))
	s.api("bob", "GET", "/invitations/pending", "")
	s.api("admin", "GET", "/invitations/pending", "")
	s.api("bob", "POST", "/calendars/def-calendar/events/"+ev+"/respond", `{"response":"maybe"}`)
	s.api("carol", "POST", "/calendars/def-calendar/events/"+ev+"/respond", `{"response":"accepted"}`)
	s.api("bob", "POST", "/calendars/def-calendar/events/nope.ics/respond", `{"response":"accepted"}`)

	s.step("alice renames and moves the event")
	_, master, etag := s.get("alice", cal("alice", "def-calendar", ev))
	master = strings.NewReplacer("SUMMARY:Comité projet", "SUMMARY:Comité projet (salle 2)",
		"DTSTART:20261028T130000Z", "DTSTART:20261028T150000Z", "DTEND:20261028T140000Z", "DTEND:20261028T160000Z").Replace(master)
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), master, "If-Match: "+etag)
	s.settle()
	_, bobCopy = copyOf("bob")
	s.check("bob's copy updated (title + time)", strings.Contains(bobCopy, "SUMMARY:Comité projet (salle 2)") && strings.Contains(bobCopy, "DTSTART:20261028T150000Z"))
	s.check("bob's answer survived the update", answered(bobID, "bob", "accepted"))

	s.step("bob cannot change the guest list")
	st, _ := s.api("bob", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["alice"]}`)
	s.check("bob cannot invite people himself", st == 403)
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":"bob"}`)
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["bob","../x"]}`)
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["nobody"]}`)

	s.step("admin deletes his copy (what Thunderbird does) -> declined, not pushed back")
	s.dav("admin", "DELETE", cal("admin", "def-calendar", ev), "")
	s.settle()
	s.check("alice sees admin declined", answered(adminID, "Admin", "declined"))
	st, _ = copyOf("admin")
	s.check("admin's copy not recreated", st == 404)

	s.step("alice removes bob from the guests")
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["admin"]}`)
	s.settle()
	st, _ = copyOf("bob")
	s.check("bob's copy removed", st == 404)
	s.show(cal("alice", "def-calendar", ev))

	s.step("alice moves the event to another of her calendars (PUT new + DELETE old, like the web app)")
	s.dav("alice", "MKCALENDAR", home("alice")+"e2e-moves/", "")
	_, master, _ = s.get("alice", cal("alice", "def-calendar", ev))
	s.dav("alice", "PUT", cal("alice", "e2e-moves", ev), master, "If-None-Match: *")
	s.dav("alice", "DELETE", cal("alice", "def-calendar", ev), "")
	s.settle()
	st, _ = copyOf("admin")
	s.check("admin still has no copy (declined)", st == 404)
	_, index := s.api("alice", "GET", "/invitations", "")
	s.check("index follows the move", strings.Contains(index, "e2e-moves/"+ev))
	_, master, _ = s.get("alice", cal("alice", "e2e-moves", ev))
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), master)
	s.dav("alice", "DELETE", cal("alice", "e2e-moves", ev), "")
	s.dav("alice", "DELETE", home("alice")+"e2e-moves/", "")
	s.settle()

	s.step("alice re-invites bob, then deletes the event")
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+ev+"/guests", `{"guests":["admin","bob"]}`)
	s.settle()
	st, _ = copyOf("bob")
	s.check("bob invited again", st == 200)
	s.dav("alice", "MKCALENDAR", home("alice")+"e2e-moves/", "")
	_, master, _ = s.get("alice", cal("alice", "def-calendar", ev))
	s.dav("alice", "PUT", cal("alice", "e2e-moves", ev), master, "If-None-Match: *")
	s.dav("alice", "DELETE", cal("alice", "def-calendar", ev), "")
	s.settle()
	_, bobCopy = copyOf("bob")
	s.check("bob keeps his copy when alice moves the event", strings.Contains(bobCopy, "X-OC-ORGANIZER-HREF:"+cal("alice", "e2e-moves", ev)))
	_, master, _ = s.get("alice", cal("alice", "e2e-moves", ev))
	s.dav("alice", "PUT", cal("alice", "def-calendar", ev), master)
	s.dav("alice", "DELETE", home("alice")+"e2e-moves/", "")
	s.settle()
	_, bobCopy = copyOf("bob")
	s.check("and again when she moves it back", strings.Contains(bobCopy, "X-OC-ORGANIZER-HREF:"+cal("alice", "def-calendar", ev)))
	s.dav("alice", "DELETE", cal("alice", "def-calendar", ev), "")
	s.settle()
	st, _ = copyOf("bob")
	s.check("bob's copy deleted with the event", st == 404)
	_, index = s.api("alice", "GET", "/invitations", "")
	s.check("event gone from the invitation index", !strings.Contains(index, ev))
}

func timezoneScenario(s *sc) {
	const tz = "tz-1.ics"
	s.step("event with a time zone (TZID + VTIMEZONE, as Thunderbird / phones write them)")
	s.dav("alice", "PUT", cal("alice", "def-calendar", tz), ics(
		"BEGIN:VTIMEZONE", "TZID:Europe/Paris",
		"BEGIN:STANDARD", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD",
		"BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:DAYLIGHT",
		"END:VTIMEZONE",
		"BEGIN:VEVENT", "UID:"+tz, "DTSTAMP:20261016T120000Z", "DTSTART;TZID=Europe/Paris:20261029T100000",
		"DTEND;TZID=Europe/Paris:20261029T110000", "SUMMARY:Réunion fuseau",
		"DESCRIPTION:Ordre du jour : budget\\, planning\\; divers", "END:VEVENT"))
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+tz+"/guests", `{"guests":["bob"]}`)
	s.settle()
	st, _, _ := s.get("bob", cal("bob", "def-calendar", tz))
	s.check("copy delivered for a TZID event", st == 200)
	s.show(cal("bob", "def-calendar", tz))

	s.step("all-day and recurring invitations in the pending list")
	s.dav("alice", "PUT", cal("alice", "def-calendar", "day-1.ics"), ics(
		"BEGIN:VEVENT", "UID:day-1", "DTSTAMP:20261016T120000Z", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103",
		"SUMMARY:Séminaire", "END:VEVENT"))
	s.dav("alice", "PUT", cal("alice", "def-calendar", "weekly-1.ics"), ics(
		event("weekly-1", "Point hebdo", "20200106T080000Z", "20200106T083000Z", "RRULE:FREQ=WEEKLY")))
	s.dav("alice", "PUT", cal("alice", "def-calendar", "past-1.ics"), ics(event("past-1", "Passé", "20200106T080000Z", "20200106T083000Z")))
	for _, e := range []string{"day-1.ics", "weekly-1.ics", "past-1.ics"} {
		s.api("alice", "PUT", "/calendars/def-calendar/events/"+e+"/guests", `{"guests":["bob","carol@example.org"]}`)
	}
	s.settle()
	s.api("bob", "GET", "/invitations/pending", "")
	s.api("carol", "GET", "/invitations/pending", "")
	s.api("alice", "GET", "/invitations", "")
	s.api("alice", "PUT", "/calendars/def-calendar/events/past-1.ics/guests", `{"guests":[]}`)
	s.settle()
	s.show(cal("alice", "def-calendar", "past-1.ics"))
	st, _, _ = s.get("bob", cal("bob", "def-calendar", "past-1.ics"))
	s.check("no guests left: copy removed", st == 404)
	for _, e := range []string{tz, "day-1.ics", "weekly-1.ics", "past-1.ics"} {
		s.dav("alice", "DELETE", cal("alice", "def-calendar", e), "")
	}
	s.settle()
}

func caldavClientScenario(s *sc) {
	const tb = "tb-1.ics"
	tbCopy := func() (int, string, string) { return s.get("bob", cal("bob", "def-calendar", tb)) }
	tbMaster := func() string { _, b, _ := s.get("alice", cal("alice", "def-calendar", tb)); return b }
	answered := func(response string) bool {
		_, b := s.api("alice", "GET", "/calendars/def-calendar/events/"+tb+"/guests", "")
		return regexp.MustCompile(`"id": "` + bobID + `", "displayName": "[^"]*", "response": "` + response + `"`).MatchString(b)
	}

	s.step("invitation created in a CalDAV client (Thunderbird style: guests as e-mail addresses)")
	s.dav("alice", "PUT", cal("alice", "def-calendar", tb), "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN\r\n"+
		"BEGIN:VEVENT\r\nUID:"+tb+"\r\nDTSTAMP:20261016T120000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\n"+
		"SUMMARY:Créé dans Thunderbird\r\nORGANIZER;CN=alice:mailto:alice@example.org\r\n"+
		"ATTENDEE;CN=alice;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:alice@example.org\r\n"+
		"ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:bob@example.org\r\n"+
		"ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:someone@external.test\r\n"+
		"END:VEVENT\r\nEND:VCALENDAR\r\n")
	s.settle()
	m := tbMaster()
	s.check("e-mail guest resolved to the OpenCloud user", regexp.MustCompile(`(?m)^ATTENDEE.*X-OC-USERID=`+bobID+`.*:mailto:bob@example.org$`).MatchString(m))
	s.check("organizer tagged", regexp.MustCompile(`(?m)^ORGANIZER.*X-OC-USERID=`+aliceID).MatchString(m))
	s.check("external address kept, untouched", regexp.MustCompile(`(?m)^ATTENDEE[^X]*:mailto:someone@external.test$`).MatchString(m))
	_, c, etag := tbCopy()
	s.check("bob got a copy, his address still mailto", regexp.MustCompile(`(?m)^ATTENDEE.*PARTSTAT=NEEDS-ACTION.*:mailto:bob@example.org$`).MatchString(c))
	s.show(cal("alice", "def-calendar", tb))

	s.step("bob accepts in his client (rewrites his PARTSTAT in his copy)")
	var lines []string
	for _, l := range strings.Split(c, "\n") {
		if strings.HasSuffix(l, "mailto:bob@example.org") {
			l = strings.Replace(l, "PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED", 1)
		}
		lines = append(lines, l)
	}
	s.dav("bob", "PUT", cal("bob", "def-calendar", tb), strings.Join(lines, "\r\n"), "If-Match: "+etag)
	s.settle()
	s.check("alice sees bob accepted (answered from his CalDAV client)", answered("accepted"))

	s.step("bob's client rewrites his copy without our markers (what Thunderbird does when editing)")
	_, c, etag = tbCopy()
	lines = nil
	for _, l := range strings.Split(c, "\n") {
		switch {
		case strings.HasPrefix(l, "X-OC-ORGANIZER-HREF"), strings.HasPrefix(l, "X-OC-SYNC-HASH"):
			continue
		case strings.HasPrefix(l, "SUMMARY:"):
			l = "SUMMARY:Titre changé par bob"
		case strings.HasSuffix(l, "mailto:bob@example.org"):
			l = regexp.MustCompile(`PARTSTAT=[A-Z-]*`).ReplaceAllString(l, "PARTSTAT=TENTATIVE")
		}
		lines = append(lines, l)
	}
	s.dav("bob", "PUT", cal("bob", "def-calendar", tb), strings.Join(lines, "\r\n"), "If-Match: "+etag)
	s.settle()
	s.check("his answer still reaches alice", answered("tentative"))
	_, c, _ = tbCopy()
	s.check("copy restored from the organizer (title + marker)", strings.Contains(c, "\nSUMMARY:Créé dans Thunderbird") && strings.Contains(c, "X-OC-ORGANIZER-HREF"))
	s.show(cal("bob", "def-calendar", tb))

	s.step("the organizer edits guests from the web app: mailto addresses and external guests are kept")
	s.api("alice", "PUT", "/calendars/def-calendar/events/"+tb+"/guests", `{"guests":["bob","admin"]}`)
	s.settle()
	s.show(cal("alice", "def-calendar", tb))
	s.dav("alice", "DELETE", cal("alice", "def-calendar", tb), "")
	s.settle()
	st, _, _ := tbCopy()
	s.check("bob's copy removed with the event", st == 404)
	st, _, _ = s.get("admin", cal("admin", "def-calendar", tb))
	s.check("admin's copy removed with the event", st == 404)
}

func sharedCalendarScenario(s *sc) {
	s.step("invitations in a shared calendar: the owner and the organizer may edit guests, others not")
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"write"}`)
	s.dav("bob", "PUT", cal("bob", "def-calendar-be578ae3", "team-1.ics"), ics(event("team-1", "Équipe", "20261105T090000Z", "20261105T100000Z")))
	s.settle()
	s.api("bob", "PUT", "/calendars/def-calendar-be578ae3/events/team-1.ics/guests", `{"guests":["carol"]}`)
	s.settle()
	s.show(cal("alice", "def-calendar", "team-1.ics"))
	s.api("alice", "PUT", "/calendars/def-calendar/events/team-1.ics/guests", `{"guests":["carol","admin"]}`)
	s.settle()
	s.api("bob", "GET", "/calendars/def-calendar-be578ae3/events/team-1.ics/guests", "")
	s.api("carol", "GET", "/invitations/pending", "")
	s.api("carol", "PUT", "/calendars/def-calendar/events/team-1.ics/guests", `{"guests":["bob"]}`)
	s.dav("alice", "DELETE", cal("alice", "def-calendar", "team-1.ics"), "")
	s.api("alice", "DELETE", "/calendars/def-calendar/shares/bob", "")
	s.settle()
}

func catchUpScenario(s *sc, launch launcher) {
	s.step("changes made while the sidecar is down are caught up at start (full scan)")
	s.dav("alice", "PUT", cal("alice", "def-calendar", "late-1.ics"), ics(event("late-1", "En retard", "20261110T090000Z", "20261110T100000Z")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/late-1.ics/guests", `{"guests":["bob"]}`)
	s.settle()
	s.restart(launch, func() {
		// Thunderbird-style invitation and a deleted master, both unseen by the agent.
		s.dav("alice", "PUT", cal("alice", "def-calendar", "late-2.ics"), ics(
			event("late-2", "Hors ligne", "20261111T090000Z", "20261111T100000Z",
				"ORGANIZER;CN=alice:mailto:alice@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:admin@example.org")))
		s.dav("alice", "DELETE", cal("alice", "def-calendar", "late-1.ics"), "")
	})
	s.settle()
	st, _, _ := s.get("bob", cal("bob", "def-calendar", "late-1.ics"))
	s.check("copy of a master deleted while down is removed", st == 404)
	st, _, _ = s.get("admin", cal("admin", "def-calendar", "late-2.ics"))
	s.check("invitation written while down is delivered", st == 200)
	s.api("alice", "GET", "/invitations", "")
	s.dav("alice", "DELETE", cal("alice", "def-calendar", "late-2.ics"), "")
	s.settle()
}

func runAll(t *testing.T, launch launcher) *sc {
	s := newScenario(t, launch)
	sharingScenario(s)
	invitationsScenario(s)
	timezoneScenario(s)
	caldavClientScenario(s)
	sharedCalendarScenario(s)
	catchUpScenario(s, launch)
	return s
}

func TestScenarios(t *testing.T) {
	s := runAll(t, launchGo)
	writeTranscript(t, "go", s.out.String())
	for _, f := range s.failed {
		t.Errorf("KO: %s", f)
	}
	if t.Failed() {
		t.Logf("transcript:\n%s", s.out.String())
	}
}

// TestMultilineDescription: an invitation whose description has several lines is delivered,
// with X-OC-DESCRIPTION escaped.
func TestMultilineDescription(t *testing.T) {
	s := newScenario(t, launchGo)
	s.dav("bob", "PROPFIND", home("bob"), "")
	s.dav("alice", "PUT", cal("alice", "def-calendar", "ml-1.ics"), ics(event("ml-1", "Plusieurs lignes",
		"20261105T090000Z", "20261105T100000Z", "DESCRIPTION:Ordre du jour :\\n1. budget\\n2. divers")))
	s.api("alice", "PUT", "/calendars/def-calendar/events/ml-1.ics/guests", `{"guests":["bob"]}`)
	s.settle()
	st, c, _ := s.get("bob", cal("bob", "def-calendar", "ml-1.ics"))
	if st != 200 {
		t.Fatalf("copy not delivered: %d", st)
	}
	for _, want := range []string{
		"\nX-OC-DESCRIPTION:Ordre du jour :\\n1. budget\\n2. divers\n",
		"\nDESCRIPTION;ALTREP=\"data:text/html,%3Cdiv%3EOrdre%20du%20jour%20%3A%3Cbr%3E1.%20budget%3Cbr%3E2.%20divers%3C/div%3E",
		":Ordre du jour :\\n1. budget\\n2. divers\\n\\n—\\nInvitation de alice.",
	} {
		if !strings.Contains(c, want) {
			t.Errorf("copy lacks %q:\n%s", want, c)
		}
	}
}

func writeTranscript(t *testing.T, name, text string) {
	if dir := os.Getenv("CALSHARE_TRANSCRIPTS"); dir != "" {
		os.WriteFile(filepath.Join(dir, name+".txt"), []byte(text), 0o644)
	}
}
