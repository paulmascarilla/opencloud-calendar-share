package main

// Tests of the fixes made after the security audit.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testSecret = "s3cret-from-the-proxy"

func launchGoWithSecret(t *testing.T, radicaleURL, graphURL, root, state string) (string, func()) {
	s, err := NewServer(Config{
		BasePath: "/calshare", RadicaleURL: radicaleURL, OCURL: graphURL, OCServiceAuth: "svc:token",
		AutoAccept: true, RemoteUserHeader: "X-Remote-User", CollectionRoot: root, StateDir: state,
		PublicURL: publicURL, InviteLanguage: "fr", ProxySecret: testSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(s)
	gate := httptest.NewServer(s.CalDAVGate())
	stop := s.agent.startForTest()
	gateURLs[api.URL] = gate.URL
	return api.URL, func() { stop(); api.Close(); gate.Close() }
}

var gateURLs = map[string]string{}

func TestProxySecret(t *testing.T) {
	s := newScenario(t, launchGoWithSecret)
	forged := map[string]string{"X-Remote-User": aliceID}
	st, body := s.raw("GET", "/calshare/v1/shares", forged, "")
	if st != 401 {
		t.Errorf("forged X-Remote-User without the secret: %d %s", st, body)
	}
	forged[SecretHeader] = "wrong"
	if st, _ = s.raw("GET", "/calshare/v1/shares", forged, ""); st != 401 {
		t.Errorf("wrong secret: %d", st)
	}
	forged[SecretHeader] = testSecret
	if st, body = s.raw("GET", "/calshare/v1/shares", forged, ""); st != 200 {
		t.Errorf("with the secret: %d %s", st, body)
	}
	if st, _ = s.raw("GET", "/healthz", nil, ""); st != 200 {
		t.Errorf("healthz must stay open for probes: %d", st)
	}

	// Radicale's storage hook comes from localhost without the secret and must still work.
	s.dav("alice", "PUT", cal("alice", "def-calendar", "sec-1.ics"), ics(event("sec-1", "x", "20261201T090000Z", "20261201T100000Z")))
	st, body = s.raw("PUT", "/calshare/v1/calendars/def-calendar/events/sec-1.ics/guests",
		map[string]string{"X-Remote-User": aliceID, SecretHeader: testSecret, "Authorization": basicAuth("alice")}, `{"guests":["bob"]}`)
	if st != 200 {
		t.Fatalf("invite: %d %s", st, body)
	}
	s.settle()
	if st, _, _ := s.get("bob", cal("bob", "def-calendar", "sec-1.ics")); st != 200 {
		t.Errorf("hook without the secret no longer reaches the agent: copy %d", st)
	}

	// The CalDAV gate: refused without the secret, forwarded (secret removed) with it.
	gate := gateURLs[s.sidecar]
	req, _ := http.NewRequest("PROPFIND", gate+home("alice"), nil)
	req.Header.Set("X-Remote-User", aliceID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("gate without the secret: %d", resp.StatusCode)
	}
	// as the OpenCloud proxy sends it: /caldav prefix announced in X-Script-Name
	req, _ = http.NewRequest("PROPFIND", gate+"/caldav"+home("alice"), nil)
	req.Header.Set("X-Remote-User", aliceID)
	req.Header.Set("X-Script-Name", "/caldav")
	req.Header.Set(SecretHeader, testSecret)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 207 {
		t.Errorf("gate with the secret: %d", resp.StatusCode)
	}
	s.rad.mu.Lock()
	leaked := s.rad.sawSecret
	s.rad.mu.Unlock()
	if leaked {
		t.Error("the proxy secret reached Radicale")
	}
}

func TestOrganizerSpoofing(t *testing.T) {
	s := newScenario(t, launchGo)
	s.dav("carol", "PROPFIND", home("carol"), "")
	s.dav("admin", "PROPFIND", home("admin"), "")

	// bob claims, in his own calendar, that alice invites carol (Thunderbird style and pre-tagged)
	s.dav("bob", "PUT", cal("bob", "def-calendar", "spoof-1.ics"), ics(event("spoof-1", "Urgent", "20261120T090000Z", "20261120T100000Z",
		"ORGANIZER;CN=alice:mailto:alice@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol@example.org")))
	s.dav("bob", "PUT", cal("bob", "def-calendar", "spoof-2.ics"), ics(event("spoof-2", "Urgent", "20261120T090000Z", "20261120T100000Z",
		"ORGANIZER;CN=alice;X-OC-USERID="+aliceID+":urn:uuid:"+aliceID,
		"ATTENDEE;PARTSTAT=NEEDS-ACTION;X-OC-USERID="+carolID+":urn:uuid:"+carolID)))
	// bob organizes himself but pretends to be "alice" in the CN
	s.dav("bob", "PUT", cal("bob", "def-calendar", "spoof-3.ics"), ics(event("spoof-3", "Urgent", "20261120T090000Z", "20261120T100000Z",
		"ORGANIZER;CN=alice;X-OC-USERID="+bobID+":urn:uuid:"+bobID,
		"ATTENDEE;PARTSTAT=NEEDS-ACTION;X-OC-USERID="+adminID+":urn:uuid:"+adminID)))
	s.settle()
	for _, e := range []string{"spoof-1.ics", "spoof-2.ics"} {
		if st, _, _ := s.get("carol", cal("carol", "def-calendar", e)); st != 404 {
			t.Errorf("%s: invitation sent on alice's behalf by bob (copy %d)", e, st)
		}
	}
	st, c, _ := s.get("admin", cal("admin", "def-calendar", "spoof-3.ics"))
	if st != 200 || !strings.Contains(c, "Invitation de bob.") || !strings.Contains(c, "ORGANIZER;CN=bob;") {
		t.Errorf("spoof-3: the guest must see the real organizer (%d):\n%s", st, c)
	}
	_, pending := s.api("admin", "GET", "/invitations/pending", "")
	if !strings.Contains(pending, `"organizer": "bob"`) {
		t.Errorf("pending list shows a forged organizer: %s", pending)
	}

	// Delegation stays possible: alice shares her calendar with bob for writing.
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"write"}`)
	s.dav("bob", "PUT", cal("bob", "def-calendar-be578ae3", "team-2.ics"), ics(event("team-2", "Équipe", "20261105T090000Z", "20261105T100000Z")))
	s.api("bob", "PUT", "/calendars/def-calendar-be578ae3/events/team-2.ics/guests", `{"guests":["carol"]}`)
	s.settle()
	if st, _, _ := s.get("carol", cal("carol", "def-calendar", "team-2.ics")); st != 200 {
		t.Errorf("a write share must still allow organizing (copy %d)", st)
	}
	// ...and read access does not.
	s.api("alice", "PUT", "/calendars/def-calendar/shares/bob", `{"permission":"read"}`)
	_, m, etag := s.get("alice", cal("alice", "def-calendar", "team-2.ics"))
	s.dav("alice", "PUT", cal("alice", "def-calendar", "team-2.ics"), strings.Replace(m, "SUMMARY:Équipe", "SUMMARY:Équipe 2", 1), "If-Match: "+etag)
	s.settle()
	if st, _, _ := s.get("carol", cal("carol", "def-calendar", "team-2.ics")); st != 404 {
		t.Errorf("bob lost write access: his invitations must be withdrawn (copy %d)", st)
	}
}

func TestMarkerOracle(t *testing.T) {
	s := newScenario(t, launchGo)
	s.dav("alice", "PUT", cal("alice", "def-calendar", "secret-meeting.ics"), ics(event("secret", "Confidentiel", "20261120T090000Z", "20261120T100000Z")))
	// bob probes alice's calendar with markers of his own
	for _, name := range []string{"secret-meeting.ics", "does-not-exist.ics"} {
		s.dav("bob", "PUT", cal("bob", "def-calendar", "probe-"+name), ics(
			"X-OC-ORGANIZER-HREF:"+cal("alice", "def-calendar", name),
			event("probe-"+name, "probe", "20261120T090000Z", "20261120T100000Z")))
	}
	s.settle()
	for _, name := range []string{"secret-meeting.ics", "does-not-exist.ics"} {
		if st, _, _ := s.get("bob", cal("bob", "def-calendar", "probe-"+name)); st != 200 {
			t.Errorf("probe-%s: the agent reacted to a forged marker (%d), which tells bob whether the event exists", name, st)
		}
	}
	_, m, _ := s.get("alice", cal("alice", "def-calendar", "secret-meeting.ics"))
	if strings.Contains(m, "ATTENDEE") || strings.Contains(m, "SEQUENCE") {
		t.Errorf("alice's event was touched:\n%s", m)
	}
}

func TestGraphFailureIsNotTrusted(t *testing.T) {
	s := newScenario(t, launchGo)
	s.dav("alice", "PROPFIND", home("alice"), "")
	st, body := s.api("alice", "PUT", "/calendars/def-calendar/shares/"+graphFailureID, `{}`)
	if st != 502 {
		t.Errorf("share with an id Graph could not check: %d %s", st, body)
	}
	_, shares := s.api("alice", "GET", "/shares", "")
	if strings.Contains(shares, graphFailureID) {
		t.Errorf("share created anyway: %s", shares)
	}
}
