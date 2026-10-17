package main

// In-memory stand-ins for Radicale (CalDAV store, owner_only rights, map sharing API,
// storage hook) and the OpenCloud Graph API, so the whole sidecar can be exercised
// without a cluster.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type fakeCollection struct {
	displayName, color string
	components         []string // nil: not a calendar (address book)
}

type fakeShare struct {
	Owner, User, PathMapped, PathOrToken, Permissions string
	EnabledByOwner, EnabledByUser, HiddenByOwner      bool
	HiddenByUser                                      bool
	Properties                                        map[string]string
	TimestampCreated, TimestampUpdated                int
}

type fakeRadicale struct {
	mu           sync.Mutex
	root         string // filesystem collection root (for the agent's full scan)
	collections  map[string]*fakeCollection
	items        map[string][]byte
	shares       []*fakeShare
	clock        int
	hookURL      string
	pendingHooks [][3]string // notifications while no sidecar runs
	sawSecret    bool        // a request reached Radicale with the proxy secret (must never happen)
	lastRequest  time.Time
	srv          *httptest.Server
}

func newFakeRadicale(root string) *fakeRadicale {
	f := &fakeRadicale{root: root, collections: map[string]*fakeCollection{}, items: map[string][]byte{}, clock: 1792236000}
	f.srv = httptest.NewServer(f)
	return f
}

func etagOf(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}

func (f *fakeRadicale) touch() {
	f.mu.Lock()
	f.lastRequest = time.Now()
	f.mu.Unlock()
}

func (f *fakeRadicale) lastSeen() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastRequest
}

// idleSince is how long nothing talked to Radicale.
func (f *fakeRadicale) idleSince() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return time.Since(f.lastRequest)
}

// provision creates the predefined collections of a user's home.
func (f *fakeRadicale) provision(user string) {
	if _, ok := f.collections["/"+user+"/def-calendar/"]; ok {
		return
	}
	f.collections["/"+user+"/def-calendar/"] = &fakeCollection{"Agenda", "#3b82f6", []string{"VEVENT"}}
	f.collections["/"+user+"/def-tasks/"] = &fakeCollection{"Tâches", "#f59e0b", []string{"VTODO"}}
	f.collections["/"+user+"/def-addressbook/"] = &fakeCollection{"Contacts", "", nil}
}

// resolve maps a request path to the owner's real path, following mounted shares.
// It returns write=false when the caller may only read.
func (f *fakeRadicale) resolve(user, path string) (real string, write, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 3)
	if parts[0] != user {
		return "", false, false
	}
	if len(parts) >= 2 {
		mount := "/" + user + "/" + parts[1] + "/"
		for _, s := range f.shares {
			if s.PathOrToken == mount && s.User == user {
				if !s.EnabledByOwner || !s.EnabledByUser {
					return "", false, false
				}
				rest := ""
				if len(parts) == 3 {
					rest = parts[2]
				}
				return s.PathMapped + rest, strings.Contains(s.Permissions, "w"), true
			}
		}
	}
	return path, true, true
}

// setHook points the storage hook at a sidecar and replays what happened while there was none
// (the real hook reaches the sidecar as soon as it listens).
func (f *fakeRadicale) setHook(url string) {
	f.mu.Lock()
	f.hookURL = url
	pending := f.pendingHooks
	f.pendingHooks = nil
	f.mu.Unlock()
	for _, h := range pending {
		f.hook(h[0], h[1], h[2])
	}
}

func (f *fakeRadicale) hook(request, path, toPath string) {
	f.mu.Lock()
	url := f.hookURL
	if url == "" {
		f.pendingHooks = append(f.pendingHooks, [3]string{request, path, toPath})
	}
	f.mu.Unlock()
	if url == "" {
		return
	}
	req, _ := http.NewRequest("POST", url+"/internal/storage-changed", nil)
	req.Header.Set("X-Calshare-Request", request)
	req.Header.Set("X-Calshare-Path", f.root+path)
	if toPath != "" {
		req.Header.Set("X-Calshare-To", f.root+toPath)
	}
	client := &http.Client{Timeout: time.Second}
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
	}
}

func (f *fakeRadicale) writeFile(path string, data []byte) {
	full := filepath.Join(f.root, filepath.FromSlash(path))
	os.MkdirAll(filepath.Dir(full), 0o755)
	os.WriteFile(full, data, 0o644)
}

func (f *fakeRadicale) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.touch()
	defer f.touch()
	if r.URL.Path == "/.well-known/caldav" {
		w.WriteHeader(200)
		return
	}
	if r.Header.Get(SecretHeader) != "" {
		f.mu.Lock()
		f.sawSecret = true
		f.mu.Unlock()
	}
	// Like Radicale: X-Script-Name is only honoured behind a reverse proxy (X-Forwarded-*).
	if prefix := r.Header.Get("X-Script-Name"); prefix != "" && r.Header.Get("X-Forwarded-For") != "" {
		r.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
	}
	user := r.Header.Get("X-Remote-User")
	body, _ := io.ReadAll(r.Body)
	if strings.HasPrefix(r.URL.Path, "/.sharing/v1/map/") {
		f.sharing(w, user, strings.TrimPrefix(r.URL.Path, "/.sharing/v1/map/"), body)
		return
	}
	var hooks [][3]string
	f.mu.Lock()
	status, out, headers := f.dav(r.Method, user, r.URL.Path, r.Header, body, &hooks)
	f.mu.Unlock()
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
	w.Write(out)
	// Radicale runs the hook before answering; after is close enough and avoids deadlocks here.
	for _, h := range hooks {
		f.hook(h[0], h[1], h[2])
	}
}

func (f *fakeRadicale) dav(method, user, path string, h http.Header, body []byte, hooks *[][3]string) (int, []byte, map[string]string) {
	if user == "" {
		return 401, nil, nil
	}
	f.provision(user)
	real, write, ok := f.resolve(user, path)
	if !ok {
		if strings.HasPrefix(path, "/"+user+"/") {
			return 404, nil, nil
		}
		return 403, nil, nil
	}
	switch method {
	case "PROPFIND":
		if path != "/"+user+"/" {
			return 501, nil, nil
		}
		return 207, f.homeListing(user), map[string]string{"Content-Type": "text/xml"}
	case "MKCALENDAR":
		if _, exists := f.collections[real]; exists {
			return 405, nil, nil
		}
		f.collections[real] = &fakeCollection{strings.Trim(real[strings.LastIndex(strings.TrimSuffix(real, "/"), "/"):], "/"), "", []string{"VEVENT"}}
		return 201, nil, nil
	case "GET":
		data, ok := f.items[real]
		if !ok {
			return 404, nil, nil
		}
		return 200, data, map[string]string{"ETag": etagOf(data), "Content-Type": "text/calendar"}
	case "PUT":
		if !write {
			return 403, nil, nil
		}
		collection := real[:strings.LastIndex(real, "/")+1]
		if _, ok := f.collections[collection]; !ok {
			return 409, nil, nil
		}
		current, exists := f.items[real]
		if m, ok := h["If-Match"]; ok && (!exists || m[0] != etagOf(current)) {
			return 412, nil, nil
		}
		if h.Get("If-None-Match") == "*" && exists {
			return 412, nil, nil
		}
		if _, err := ParseICal(body); err != nil {
			return 400, []byte(err.Error()), nil
		}
		f.items[real] = body
		f.writeFile(real, body)
		*hooks = append(*hooks, [3]string{"PUT", real, ""})
		status := 201
		if exists {
			status = 204
		}
		return status, nil, map[string]string{"ETag": etagOf(body)}
	case "DELETE":
		if !write {
			return 403, nil, nil
		}
		if strings.HasSuffix(real, "/") {
			if _, ok := f.collections[real]; !ok {
				return 404, nil, nil
			}
			for p := range f.items {
				if strings.HasPrefix(p, real) {
					delete(f.items, p)
				}
			}
			delete(f.collections, real)
			os.RemoveAll(filepath.Join(f.root, filepath.FromSlash(real)))
			*hooks = append(*hooks, [3]string{"DELETE", strings.TrimSuffix(real, "/"), ""})
			return 204, nil, nil
		}
		current, exists := f.items[real]
		if !exists {
			return 404, nil, nil
		}
		if m, ok := h["If-Match"]; ok && m[0] != etagOf(current) {
			return 412, nil, nil
		}
		delete(f.items, real)
		os.Remove(filepath.Join(f.root, filepath.FromSlash(real)))
		*hooks = append(*hooks, [3]string{"DELETE", real, ""})
		return 204, nil, nil
	}
	return 405, nil, nil
}

func (f *fakeRadicale) homeListing(user string) []byte {
	type entry struct {
		href string
		c    *fakeCollection
	}
	var entries []entry
	for p, c := range f.collections {
		if strings.HasPrefix(p, "/"+user+"/") {
			entries = append(entries, entry{p, c})
		}
	}
	for _, s := range f.shares {
		if s.User == user && s.EnabledByOwner && s.EnabledByUser && !s.HiddenByUser {
			c := *f.collections[s.PathMapped]
			if dn := s.Properties["D:displayname"]; dn != "" {
				c.displayName = dn
			}
			entries = append(entries, entry{s.PathOrToken, &c})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].href > entries[j].href })
	var b strings.Builder
	b.WriteString(`<?xml version='1.0' encoding='utf-8'?>` + "\n" + `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">`)
	fmt.Fprintf(&b, `<response><href>/%s/</href><propstat><prop><resourcetype><principal/><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`, user)
	for _, e := range entries {
		fmt.Fprintf(&b, `<response><href>%s</href><propstat><prop><resourcetype><collection/>`, strings.ReplaceAll(e.href, "@", "%40"))
		if e.c.components != nil {
			b.WriteString(`<C:calendar/>`)
		}
		fmt.Fprintf(&b, `</resourcetype><displayname>%s</displayname>`, e.c.displayName)
		if e.c.color != "" {
			fmt.Fprintf(&b, `<ICAL:calendar-color>%s</ICAL:calendar-color>`, e.c.color)
		}
		if e.c.components != nil {
			b.WriteString(`<C:supported-calendar-component-set>`)
			for _, comp := range e.c.components {
				fmt.Fprintf(&b, `<C:comp name="%s"/>`, comp)
			}
			b.WriteString(`</C:supported-calendar-component-set>`)
		}
		b.WriteString(`</prop><status>HTTP/1.1 200 OK</status></propstat></response>`)
	}
	b.WriteString(`</multistatus>`)
	return []byte(b.String())
}

func (f *fakeRadicale) sharing(w http.ResponseWriter, user, action string, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var req struct {
		PathMapped, PathOrToken, User, Permissions string
		Enabled, Hidden                            bool
		Properties                                 map[string]string
	}
	if len(body) > 0 && json.Unmarshal(body, &req) != nil {
		http.Error(w, "bad json", 400)
		return
	}
	find := func() *fakeShare {
		for _, s := range f.shares {
			if s.PathOrToken == req.PathOrToken && (s.Owner == user || s.User == user) {
				return s
			}
		}
		return nil
	}
	ok := func() {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ApiVersion": 1, "Status": "success"}`))
	}
	f.clock++
	switch action {
	case "list":
		f.clock--
		var content []*fakeShare
		for _, s := range f.shares {
			if s.Owner == user || s.User == user {
				content = append(content, s)
			}
		}
		out, _ := json.Marshal(map[string]any{"ApiVersion": 1, "Status": "success", "Lines": len(content), "Content": content})
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	case "create":
		if !strings.HasPrefix(req.PathMapped, "/"+user+"/") || f.collections[req.PathMapped] == nil {
			http.Error(w, "", http.StatusForbidden)
			return
		}
		for _, s := range f.shares {
			if s.PathOrToken == req.PathOrToken {
				http.Error(w, "", http.StatusConflict)
				return
			}
		}
		f.shares = append(f.shares, &fakeShare{Owner: user, User: req.User, PathMapped: req.PathMapped,
			PathOrToken: req.PathOrToken, Permissions: req.Permissions, EnabledByOwner: req.Enabled,
			HiddenByOwner: req.Hidden, HiddenByUser: true, Properties: req.Properties,
			TimestampCreated: f.clock, TimestampUpdated: f.clock})
		ok()
	case "update", "delete", "enable", "disable", "hide", "unhide":
		s := find()
		if s == nil {
			http.Error(w, "", 404)
			return
		}
		switch action {
		case "update":
			if s.Owner != user {
				http.Error(w, "", http.StatusForbidden)
				return
			}
			s.Permissions = req.Permissions
		case "delete":
			for i, x := range f.shares {
				if x == s {
					f.shares = append(f.shares[:i], f.shares[i+1:]...)
				}
			}
		case "enable", "disable":
			if s.User == user {
				s.EnabledByUser = action == "enable"
			} else {
				s.EnabledByOwner = action == "enable"
			}
		case "hide", "unhide":
			if s.User == user {
				s.HiddenByUser = action == "hide"
			} else {
				s.HiddenByOwner = action == "hide"
			}
		}
		s.TimestampUpdated = f.clock
		ok()
	default:
		http.Error(w, "", 404)
	}
}

// item returns a stored item (nil if absent).
func (f *fakeRadicale) item(path string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.items[path]
}

// --- Graph -------------------------------------------------------------------

type fakeUser struct{ ID, Name, Display, Mail string }

var testUsers = []fakeUser{
	{"be578ae3-5d68-4ad0-9cb2-0e0c9123e76d", "alice", "alice", "alice@example.org"},
	{"4fbd8358-64a7-419a-87a7-61485582660e", "bob", "bob", "bob@example.org"},
	{"51d6a323-3cac-49ca-9150-c16458f0d362", "admin", "Admin", "admin@example.org"},
	{"0d2c1b9e-6f1a-4f43-9d55-0a7b6c3e8f21", "carol", "Carol Martin", "carol@example.org"},
	{"6a0e0f3b-2b8c-4d0e-8a51-3f2a1d9c7e44", "caroline", "Caroline", "caroline@example.org"},
}

// graphFailureID makes the fake Graph fail.
const graphFailureID = "99999999-9999-4999-8999-999999999999"

const (
	aliceID = "be578ae3-5d68-4ad0-9cb2-0e0c9123e76d"
	bobID   = "4fbd8358-64a7-419a-87a7-61485582660e"
	adminID = "51d6a323-3cac-49ca-9150-c16458f0d362"
	carolID = "0d2c1b9e-6f1a-4f43-9d55-0a7b6c3e8f21"
)

func newFakeGraph() *httptest.Server {
	view := func(u fakeUser) map[string]any {
		return map[string]any{"id": u.ID, "displayName": u.Display, "onPremisesSamAccountName": u.Name, "mail": u.Mail}
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if id, ok := strings.CutPrefix(r.URL.Path, "/graph/v1.0/users/"); ok {
			if id == graphFailureID {
				w.WriteHeader(500)
				return
			}
			for _, u := range testUsers {
				if u.ID == id {
					json.NewEncoder(w).Encode(view(u))
					return
				}
			}
			w.WriteHeader(404)
			w.Write([]byte(`{"error": {"code": "itemNotFound"}}`))
			return
		}
		if r.URL.Path == "/graph/v1.0/users" {
			term := strings.ToLower(strings.Trim(r.URL.Query().Get("$search"), `"`))
			found := []map[string]any{}
			for _, u := range testUsers {
				if strings.Contains(strings.ToLower(u.Name+" "+u.Display+" "+u.Mail), term) {
					found = append(found, view(u))
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"value": found})
			return
		}
		w.WriteHeader(404)
	}))
}
