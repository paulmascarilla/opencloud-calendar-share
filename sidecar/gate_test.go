package main

import (
	"net/http"
	"strings"
	"testing"
)

// TestGateDisablesHeuristicCaching: Radicale sends Last-Modified without Cache-Control, so a browser may
// reuse an old GET of an event changed elsewhere (a guest's answer, another client), and its stale ETag
// then makes every If-Match write fail with 412.
func TestGateDisablesHeuristicCaching(t *testing.T) {
	s := newScenario(t, launchGoWithSecret)
	href := cal("alice", "def-calendar", "cache-1.ics")
	s.dav("alice", "PUT", href, ics(event("cache-1", "x", "20261201T090000Z", "20261201T100000Z")))

	req, _ := http.NewRequest("GET", gateURLs[s.sidecar]+href, nil)
	req.Header.Set("X-Remote-User", aliceID)
	req.Header.Set(SecretHeader, testSecret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET through the gate: %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-cache") || !strings.Contains(cc, "private") {
		t.Errorf("GET through the gate: Cache-Control %q, want private, no-cache", cc)
	}
}
