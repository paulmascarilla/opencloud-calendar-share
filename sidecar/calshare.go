// calshare: REST API for sharing Radicale calendars between OpenCloud users.
//
// Runs as a sidecar next to Radicale. The OpenCloud proxy authenticates the
// caller and forwards the request with "X-Remote-User: <user id>"; this service
// translates REST calls into Radicale's native sharing API (/.sharing/v1/map)
// and resolves recipients (username, e-mail or id) through the OpenCloud Graph API.
//
// Endpoints (all under BASE_PATH, default /calshare):
//
//	GET    /v1/calendars                          caller's own calendars
//	GET    /v1/calendars/{cal}/shares             who has access to {cal}
//	PUT    /v1/calendars/{cal}/shares/{user}      share {cal} with {user}  body: {"permission": "read"|"write"}
//	DELETE /v1/calendars/{cal}/shares/{user}      revoke
//	GET    /v1/shares                             every share the caller owns
//	GET    /v1/shared-with-me                     shares received by the caller
//	POST   /v1/shared-with-me/{mount}/accept      show a received share in CalDAV clients
//	POST   /v1/shared-with-me/{mount}/decline     hide it again
//
//	GET    /v1/calendars/{cal}/events/{event}/guests   organizer and guests of an event, with their answers
//	PUT    /v1/calendars/{cal}/events/{event}/guests   invite people  body: {"guests": ["bob", "carol@example.org", "<id>"]}
//	POST   /v1/calendars/{cal}/events/{event}/respond  answer an invitation  body: {"response": "accepted"|"tentative"|"declined"}
//	GET    /v1/invitations                         events the caller organizes / is invited to
//	GET    /v1/invitations/pending                 upcoming invitations the caller has not answered
//	GET    /healthz
//
// Event invitations are delivered and kept in sync by the invitations Agent, which
// Radicale's storage hook notifies on POST /internal/storage-changed (localhost only).
package main

import (
	"bytes"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`)
	uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

	permissions = map[string]string{"read": "r", "write": "rw"}
	// REST answer -> PARTSTAT
	responses     = map[string]string{"accepted": "ACCEPTED", "tentative": "TENTATIVE", "declined": "DECLINED"}
	responseNames = map[string]string{"ACCEPTED": "accepted", "TENTATIVE": "tentative", "DECLINED": "declined"}
)

type Config struct {
	Listen           string
	BasePath         string
	RadicaleURL      string
	OCURL            string
	OCInsecure       bool
	OCServiceAuth    string // "user:app-token" of a plain OpenCloud user, for Graph lookups without a caller
	AutoAccept       bool
	RemoteUserHeader string
	CollectionRoot   string
	StateDir         string
	PublicURL        string // public OpenCloud URL, for the Accept / Maybe / Decline links
	InviteLanguage   string
	// Shared with the OpenCloud proxy, which adds it to every request (SecretHeader). Without it,
	// anything that can reach the pod could send a forged X-Remote-User.
	ProxySecret string
	// Address of the CalDAV gate: checks ProxySecret, then forwards to Radicale (which only
	// listens on localhost). Empty: no gate.
	CalDAVListen string
}

// SecretHeader carries Config.ProxySecret from the OpenCloud proxy.
const SecretHeader = "X-Calshare-Secret"

func env(name, def string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return def
}

func ConfigFromEnv() Config {
	return Config{
		Listen:           env("LISTEN", "0.0.0.0:8080"),
		BasePath:         strings.TrimRight(env("BASE_PATH", "/calshare"), "/"),
		RadicaleURL:      strings.TrimRight(env("RADICALE_URL", "http://127.0.0.1:5232"), "/"),
		OCURL:            strings.TrimRight(env("OC_URL", "https://opencloud:9200"), "/"),
		OCInsecure:       strings.ToLower(env("OC_INSECURE", "false")) == "true",
		OCServiceAuth:    env("OC_SERVICE_AUTH", ""),
		AutoAccept:       strings.ToLower(env("AUTO_ACCEPT", "true")) == "true",
		RemoteUserHeader: env("REMOTE_USER_HEADER", "X-Remote-User"),
		CollectionRoot:   env("COLLECTION_ROOT", "/var/lib/radicale/collections/collection-root"),
		StateDir:         env("STATE_DIR", "/var/lib/radicale/calshare"),
		PublicURL:        env("PUBLIC_URL", ""),
		InviteLanguage:   env("INVITE_LANGUAGE", "en"),
		ProxySecret:      env("PROXY_SECRET", ""),
		CalDAVListen:     env("CALDAV_LISTEN", ""),
	}
}

type ApiError struct {
	Status  int
	Message string
}

func (e *ApiError) Error() string { return e.Message }

func apiErr(status int, format string, args ...any) *ApiError {
	return &ApiError{status, fmt.Sprintf(format, args...)}
}

type Server struct {
	cfg    Config
	gate   http.Handler // CalDAV gate to Radicale
	client *http.Client
	agent  *Agent

	emailMu    sync.Mutex
	emailCache map[string]emailHit // bounded by maxEmailCache
}

// maxEmailCache bounds the e-mail lookup cache: addresses come from events anyone can write.
const maxEmailCache = 10000

type emailHit struct {
	user *User
	at   time.Time
}

func NewServer(cfg Config) (*Server, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if cfg.OCInsecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	s := &Server{
		cfg:        cfg,
		client:     &http.Client{Transport: transport, Timeout: 10 * time.Second},
		emailCache: map[string]emailHit{},
	}
	var resolveEmail, resolveID func(string) (*User, error)
	if cfg.OCServiceAuth != "" { // background lookups have no caller token: needs OC_SERVICE_AUTH
		resolveEmail, resolveID = s.resolveEmail, s.resolveID
	}
	agent, err := NewAgent(s.httpFull, cfg.RemoteUserHeader, cfg.RadicaleURL, cfg.CollectionRoot, cfg.StateDir,
		cfg.PublicURL, cfg.InviteLanguage, resolveEmail, resolveID, 600*time.Second)
	if err != nil {
		return nil, err
	}
	s.agent = agent
	target, err := url.Parse(cfg.RadicaleURL)
	if err != nil {
		return nil, err
	}
	s.gate = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			// Radicale honours X-Script-Name (the /caldav prefix) only behind a reverse proxy,
			// which it recognizes by these headers.
			r.SetXForwarded()
			r.Out.Header.Del(SecretHeader)
		},
		ErrorLog: slog.NewLogLogger(slog.Default().Handler(), slog.LevelWarn),
	}
	return s, nil
}

// fromProxy tells whether a request carries the proxy secret (always true when none is configured).
func (s *Server) fromProxy(r *http.Request) bool {
	if s.cfg.ProxySecret == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(r.Header.Get(SecretHeader)), []byte(s.cfg.ProxySecret)) == 1
}

// CalDAVGate only lets requests from the OpenCloud proxy through to Radicale.
func (s *Server) CalDAVGate() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.fromProxy(r) {
			http.Error(w, "not authenticated", http.StatusUnauthorized)
			return
		}
		s.gate.ServeHTTP(w, r)
	})
}

// httpFull performs a request; transport failures become a 502 ApiError.
func (s *Server) httpFull(method, rawURL string, headers map[string]string, body []byte) (int, []byte, http.Header, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, reader)
	if err != nil {
		return 0, nil, nil, apiErr(502, "upstream unreachable: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return 0, nil, nil, apiErr(502, "upstream unreachable: %v", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, nil, apiErr(502, "upstream unreachable: %v", err)
	}
	return resp.StatusCode, data, resp.Header, nil
}

func (s *Server) http(method, rawURL string, headers map[string]string, body []byte) (int, []byte, error) {
	status, data, _, err := s.httpFull(method, rawURL, headers, body)
	return status, data, err
}

func decodeJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return dec.Decode(v)
}

// --- Radicale -------------------------------------------------------------

// Share is one entry of Radicale's sharing map, as Radicale returns it.
type Share map[string]any

func (s Share) str(k string) string {
	v, _ := s[k].(string)
	return v
}

// radicaleSharing calls Radicale's sharing API as user and returns the decoded answer.
func (s *Server) radicaleSharing(user, action string, payload any) (map[string]any, error) {
	status, body, err := s.http("POST", s.cfg.RadicaleURL+"/.sharing/v1/map/"+action,
		map[string]string{s.cfg.RemoteUserHeader: user, "Content-Type": "application/json", "Accept": "application/json"},
		encodeJSON(payload))
	if err != nil {
		return nil, err
	}
	if status == 200 {
		var out map[string]any
		if err := decodeJSON(body, &out); err != nil {
			return nil, fmt.Errorf("radicale %s: invalid JSON: %w", action, err)
		}
		return out, nil
	}
	message := map[int]string{403: "forbidden", 404: "not found", 409: "share already exists"}[status]
	if message == "" {
		// Radicale's own text stays in the log: it may describe internals.
		slog.Warn(fmt.Sprintf("radicale %s returned %d: %.200s", action, status, strings.TrimSpace(string(body))))
		message = fmt.Sprintf("radicale error (%d)", status)
	}
	code := 502
	if status == 400 || status == 403 || status == 404 || status == 409 {
		code = status
	}
	return nil, apiErr(code, "radicale %s: %s", action, message)
}

// listShares returns every map share where user is the owner or the recipient.
func (s *Server) listShares(user string) ([]Share, error) {
	out, err := s.radicaleSharing(user, "list", Obj{})
	if err != nil {
		return nil, err
	}
	content, _ := out["Content"].([]any)
	shares := make([]Share, 0, len(content))
	for _, c := range content {
		if m, ok := c.(map[string]any); ok {
			shares = append(shares, Share(m))
		}
	}
	return shares, nil
}

// lastSegment is path.strip("/").split("/", 1)[-1].
func lastSegment(p string) string {
	p = strings.Trim(p, "/")
	if i := strings.Index(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

type Calendar struct {
	ID          string
	DisplayName string
	Color       string
	Components  []string
	Href        string
	Shared      bool
}

func (c Calendar) view() Obj {
	var color any
	if c.Color != "" {
		color = c.Color
	}
	components := c.Components
	if components == nil {
		components = []string{}
	}
	return Obj{{"id", c.ID}, {"displayName", c.DisplayName}, {"color", color},
		{"components", components}, {"href", c.Href}, {"shared", c.Shared}}
}

const propfindCalendars = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ` +
	`xmlns:ICAL="http://apple.com/ns/ical/"><D:prop><D:resourcetype/><D:displayname/>` +
	`<ICAL:calendar-color/><C:supported-calendar-component-set/></D:prop></D:propfind>`

const (
	nsDAV    = "DAV:"
	nsCalDAV = "urn:ietf:params:xml:ns:caldav"
	nsICal   = "http://apple.com/ns/ical/"
)

func (s *Server) listCalendars(user string) ([]Calendar, error) {
	status, body, err := s.http("PROPFIND", s.cfg.RadicaleURL+"/"+user+"/",
		map[string]string{s.cfg.RemoteUserHeader: user, "Depth": "1", "Content-Type": "application/xml"},
		[]byte(propfindCalendars))
	if err != nil {
		return nil, err
	}
	if status != 207 {
		return nil, apiErr(502, "radicale PROPFIND returned %d", status)
	}
	shares, err := s.listShares(user)
	if err != nil {
		return nil, err
	}
	// Accepted shares show up in the home listing next to real collections.
	mounted := map[string]bool{}
	for _, sh := range shares {
		if sh.str("User") == user && sh.str("Owner") != user {
			mounted[lastSegment(sh.str("PathOrToken"))] = true
		}
	}
	root, err := parseXML(body)
	if err != nil {
		return nil, err
	}
	calendars := []Calendar{}
	for _, resp := range root.children(nsDAV, "response") {
		href := unescape(resp.childText(nsDAV, "href"))
		prop := resp.find(nsDAV, "propstat").find(nsDAV, "prop")
		if prop == nil || prop.find(nsDAV, "resourcetype").find(nsCalDAV, "calendar") == nil {
			continue
		}
		trimmed := strings.TrimRight(href, "/")
		name := trimmed[strings.LastIndex(trimmed, "/")+1:]
		displayName := prop.childText(nsDAV, "displayname")
		if displayName == "" {
			displayName = name
		}
		components := []string{}
		for _, comp := range prop.find(nsCalDAV, "supported-calendar-component-set").children(nsCalDAV, "comp") {
			components = append(components, comp.attr("name"))
		}
		calendars = append(calendars, Calendar{
			ID: name, DisplayName: displayName, Color: prop.childText(nsICal, "calendar-color"),
			Components: components, Href: href, Shared: mounted[name],
		})
	}
	return calendars, nil
}

// --- OpenCloud Graph ------------------------------------------------------

type User struct {
	ID          string
	DisplayName string
	Username    *string
}

func (u *User) view() Obj {
	var username any
	if u.Username != nil {
		username = *u.Username
	}
	return Obj{{"id", u.ID}, {"displayName", u.DisplayName}, {"username", username}}
}

func (s *Server) graphGet(path, authHeader string) (int, map[string]any, error) {
	headers := map[string]string{"Accept": "application/json"}
	switch {
	case authHeader != "":
		headers["Authorization"] = authHeader // the caller's own rights when there is a caller
	case s.cfg.OCServiceAuth != "":
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(s.cfg.OCServiceAuth))
	default:
		return 0, nil, apiErr(500, "cannot query OpenCloud Graph: no caller credentials and OC_SERVICE_AUTH unset")
	}
	status, body, err := s.http("GET", s.cfg.OCURL+"/graph/v1.0"+path, headers, nil)
	if err != nil {
		return 0, nil, err
	}
	data := map[string]any{}
	if len(body) > 0 {
		if err := decodeJSON(body, &data); err != nil {
			return status, nil, fmt.Errorf("graph %s: invalid JSON (status %d)", path, status)
		}
	}
	return status, data, nil
}

func userView(u map[string]any) *User {
	id, _ := u["id"].(string)
	name, _ := u["displayName"].(string)
	if name == "" {
		name = id
	}
	user := &User{ID: id, DisplayName: name}
	if sam, ok := u["onPremisesSamAccountName"].(string); ok {
		user.Username = &sam
	}
	return user
}

// resolveUser turns a username, e-mail or id into a User.
func (s *Server) resolveUser(who, authHeader string) (*User, error) {
	if uuidRE.MatchString(who) {
		status, data, err := s.graphGet("/users/"+escapePath(who), authHeader)
		if err != nil {
			return nil, err
		}
		switch status {
		case 200:
			return userView(data), nil
		case 404:
			return nil, apiErr(404, "unknown user: %s", who)
		}
		// Any user may read /users/{id}: an error here is a real failure, never trust the id blindly.
		return nil, apiErr(502, "graph user lookup returned %d", status)
	}

	query := "%24search=" + escapeQuery(`"`+who+`"`)
	status, data, err := s.graphGet("/users?"+query, authHeader)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, apiErr(502, "graph user search returned %d", status)
	}
	needle := strings.ToLower(who)
	var found []map[string]any
	if values, ok := data["value"].([]any); ok {
		for _, v := range values {
			if m, ok := v.(map[string]any); ok {
				found = append(found, m)
			}
		}
	}
	var matches []map[string]any
	for _, u := range found {
		sam, _ := u["onPremisesSamAccountName"].(string)
		mail, _ := u["mail"].(string)
		if needle == strings.ToLower(sam) || needle == strings.ToLower(mail) {
			matches = append(matches, u)
		}
	}
	if len(matches) == 0 && strings.Contains(who, "@") && len(found) == 1 {
		if _, hasMail := found[0]["mail"]; !hasMail {
			// Graph hides "mail" from non-admin callers; a single hit on an e-mail search is that user.
			matches = found
		}
	}
	if len(matches) == 0 {
		return nil, apiErr(404, "unknown user: %s", who)
	}
	if len(matches) > 1 {
		return nil, apiErr(409, "ambiguous user: %s", who)
	}
	return userView(matches[0]), nil
}

var emailTTL = map[bool]time.Duration{true: 24 * time.Hour, false: time.Hour}

// resolveID returns the OpenCloud user with this id (service account), cached; nil if unknown.
// The agent uses it to show organizer names it can trust, instead of the event's CN.
func (s *Server) resolveID(id string) (*User, error) {
	if !uuidRE.MatchString(id) {
		return nil, nil
	}
	return s.cachedLookup("id:"+id, id)
}

// resolveEmail finds the OpenCloud user of an e-mail address (service account search),
// cached; nil if unknown.
func (s *Server) resolveEmail(email string) (*User, error) {
	return s.cachedLookup(email, email)
}

func (s *Server) cachedLookup(key, who string) (*User, error) {
	now := time.Now()
	s.emailMu.Lock()
	hit, ok := s.emailCache[key]
	s.emailMu.Unlock()
	if ok && now.Sub(hit.at) < emailTTL[hit.user != nil] {
		return hit.user, nil
	}
	user, err := s.resolveUser(who, "")
	if err != nil {
		var ae *ApiError
		if !errors.As(err, &ae) || (ae.Status != 404 && ae.Status != 409) {
			return nil, err // Graph unreachable: don't cache, retry next time
		}
		user = nil
	}
	s.emailMu.Lock()
	if len(s.emailCache) >= maxEmailCache {
		for k, hit := range s.emailCache { // drop expired entries, or everything if none expired
			if now.Sub(hit.at) >= emailTTL[hit.user != nil] {
				delete(s.emailCache, k)
			}
		}
		if len(s.emailCache) >= maxEmailCache {
			clear(s.emailCache)
		}
	}
	s.emailCache[key] = emailHit{user, now}
	s.emailMu.Unlock()
	return user, nil
}

// --- Share operations -----------------------------------------------------

func shareView(s Share, users map[string]*User) Obj {
	perm := "read"
	if p, _ := s["Permissions"].(string); strings.Contains(p, "w") {
		perm = "write"
	}
	var user any = Obj{{"id", s.str("User")}}
	if u, ok := users[s.str("User")]; ok {
		user = u.view()
	}
	var displayName any
	if props, ok := s["Properties"].(map[string]any); ok {
		displayName = props["D:displayname"]
	}
	return Obj{
		{"owner", s["Owner"]},
		{"calendar", lastSegment(s.str("PathMapped"))},
		{"user", user},
		{"permission", perm},
		{"mount", lastSegment(s.str("PathOrToken"))},
		{"displayName", displayName},
		{"accepted", truthy(s["EnabledByUser"]) && !truthy(s["HiddenByUser"])},
		{"enabledByOwner", truthy(s["EnabledByOwner"])},
		{"created", s["TimestampCreated"]},
		{"updated", s["TimestampUpdated"]},
	}
}

func shareViews(shares []Share, keep func(Share) bool) []Obj {
	out := []Obj{}
	for _, sh := range shares {
		if keep(sh) {
			out = append(out, shareView(sh, nil))
		}
	}
	return out
}

func (s *Server) findShare(owner, cal, recipientID string) (Share, error) {
	shares, err := s.listShares(owner)
	if err != nil {
		return nil, err
	}
	for _, sh := range shares {
		if sh.str("Owner") == owner && sh.str("PathMapped") == "/"+owner+"/"+cal+"/" && sh.str("User") == recipientID {
			return sh, nil
		}
	}
	return nil, nil
}

func (s *Server) checkOwnCalendar(owner, cal string) (*Calendar, error) {
	calendars, err := s.listCalendars(owner)
	if err != nil {
		return nil, err
	}
	for _, c := range calendars {
		if c.ID == cal && !c.Shared {
			return &c, nil
		}
	}
	return nil, apiErr(404, "calendar not found: %s", cal)
}

func (s *Server) putShare(owner, cal, who string, body map[string]any, authHeader string) (int, Obj, error) {
	permission := "read"
	if v, ok := body["permission"]; ok {
		permission, _ = v.(string) // not a string: "" is rejected below
	}
	if _, ok := permissions[permission]; !ok {
		return 0, nil, apiErr(400, "permission must be 'read' or 'write'")
	}
	calendar, err := s.checkOwnCalendar(owner, cal)
	if err != nil {
		return 0, nil, err
	}
	recipient, err := s.resolveUser(who, authHeader)
	if err != nil {
		return 0, nil, err
	}
	if recipient.ID == owner {
		return 0, nil, apiErr(400, "cannot share a calendar with yourself")
	}

	existing, err := s.findShare(owner, cal, recipient.ID)
	if err != nil {
		return 0, nil, err
	}
	created := false
	if existing != nil {
		if _, err := s.radicaleSharing(owner, "update", Obj{{"PathOrToken", existing["PathOrToken"]},
			{"Permissions", permissions[permission]}}); err != nil {
			return 0, nil, err
		}
	} else {
		ownerName := owner
		if me, err := s.resolveUser(owner, authHeader); err == nil {
			ownerName = me.DisplayName
		} else if !isApiError(err) {
			return 0, nil, err
		}
		displayName, _ := body["displayName"].(string)
		if displayName == "" {
			displayName = fmt.Sprintf("%s (%s)", calendar.DisplayName, ownerName)
		}
		properties := Obj{{"D:displayname", displayName}}
		if calendar.Color != "" {
			properties = append(properties, KV{"ICAL:calendar-color", calendar.Color})
		}
		prefix := owner
		if len(prefix) > 8 {
			prefix = prefix[:8]
		}
		mount := "/" + recipient.ID + "/" + cal + "-" + prefix + "/"
		if _, err := s.radicaleSharing(owner, "create", Obj{
			{"PathMapped", "/" + owner + "/" + cal + "/"}, {"PathOrToken", mount}, {"User", recipient.ID},
			{"Permissions", permissions[permission]}, {"Enabled", true}, {"Hidden", false},
			{"Properties", properties}}); err != nil {
			return 0, nil, err
		}
		if s.cfg.AutoAccept {
			for _, action := range []string{"enable", "unhide"} {
				if _, err := s.radicaleSharing(recipient.ID, action, Obj{{"PathOrToken", mount}}); err != nil {
					return 0, nil, err
				}
			}
		}
		created = true
	}

	share, err := s.findShare(owner, cal, recipient.ID)
	if err != nil {
		return 0, nil, err
	}
	if share == nil {
		return 0, nil, errors.New("share vanished right after being written")
	}
	status := 200
	if created {
		status = 201
	}
	return status, shareView(share, map[string]*User{recipient.ID: recipient}), nil
}

func isApiError(err error) bool {
	var ae *ApiError
	return errors.As(err, &ae)
}

func (s *Server) deleteShare(owner, cal, who, authHeader string) error {
	recipientID := who
	if !uuidRE.MatchString(who) {
		u, err := s.resolveUser(who, authHeader)
		if err != nil {
			return err
		}
		recipientID = u.ID
	}
	share, err := s.findShare(owner, cal, recipientID)
	if err != nil {
		return err
	}
	if share == nil {
		return apiErr(404, "share not found")
	}
	_, err = s.radicaleSharing(owner, "delete", Obj{{"PathOrToken", share["PathOrToken"]}})
	return err
}

func (s *Server) respondIncoming(user, mount string, accept bool) (Obj, error) {
	path := "/" + user + "/" + mount + "/"
	shares, err := s.listShares(user)
	if err != nil {
		return nil, err
	}
	found := false
	for _, sh := range shares {
		if sh.str("PathOrToken") == path && sh.str("User") == user {
			found = true
		}
	}
	if !found {
		return nil, apiErr(404, "share not found")
	}
	actions := []string{"disable", "hide"}
	if accept {
		actions = []string{"enable", "unhide"}
	}
	for _, action := range actions {
		if _, err := s.radicaleSharing(user, action, Obj{{"PathOrToken", path}}); err != nil {
			return nil, err
		}
	}
	if shares, err = s.listShares(user); err != nil {
		return nil, err
	}
	for _, sh := range shares {
		if sh.str("PathOrToken") == path {
			return shareView(sh, nil), nil
		}
	}
	return nil, errors.New("share vanished right after being answered")
}

// ownerOf returns the owner of the calendar holding path (resolves mounted shares).
func (s *Server) ownerOf(path, user string) (string, error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	mount := ""
	if len(parts) > 1 {
		mount = parts[1]
	}
	shares, err := s.listShares(user)
	if err != nil {
		return "", err
	}
	for _, sh := range shares {
		if sh.str("User") == user && sh.str("PathOrToken") == "/"+user+"/"+mount+"/" {
			return sh.str("Owner"), nil
		}
	}
	return user, nil
}

// --- HTTP layer -----------------------------------------------------------

func (s *Server) send(w http.ResponseWriter, status int, payload any) {
	var body []byte
	if payload != nil {
		body = encodeJSON(payload)
		w.Header().Set("Content-Type", "application/json")
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body) // the client went away: nothing left to do
}

// maxBody bounds request bodies (a guest list or a share is a few hundred bytes).
const maxBody = 1 << 20

func readBody(r *http.Request) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(400, "cannot read body")
	}
	if len(data) > maxBody {
		return nil, apiErr(413, "body too large")
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if dec.Decode(&v) != nil || dec.Decode(new(any)) != io.EOF { // trailing data is invalid too
		return nil, apiErr(400, "invalid JSON body")
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, apiErr(400, "JSON body must be an object")
	}
	return m, nil
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec := &statusRecorder{ResponseWriter: w, status: 200}
	defer func() {
		if p := recover(); p != nil {
			slog.Error(fmt.Sprintf("unhandled error: %v", p))
			s.send(rec, 500, Obj{{"error", "internal error"}})
		}
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		slog.Info(fmt.Sprintf("%s \"%s %s %s\" %d -", host, r.Method, r.RequestURI, r.Proto, rec.status))
	}()
	switch r.Method {
	case "GET", "PUT", "POST", "DELETE":
	default:
		http.Error(rec, "Unsupported method ("+quoteString(r.Method)+")", http.StatusNotImplemented)
		return
	}
	payload, status, err := s.route(r)
	if err != nil {
		var ae *ApiError
		if errors.As(err, &ae) {
			s.send(rec, ae.Status, Obj{{"error", ae.Message}})
		} else {
			slog.Error("unhandled error", "err", err)
			s.send(rec, 500, Obj{{"error", "internal error"}})
		}
		return
	}
	s.send(rec, status, payload)
}

func (s *Server) route(r *http.Request) (any, int, error) {
	method := r.Method
	path := r.URL.EscapedPath()
	if path == "/healthz" {
		return Obj{{"status", "ok"}}, 200, nil
	}
	if path == "/internal/storage-changed" && method == "POST" {
		// Radicale's storage hook, from the same pod only (never through the proxy).
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if host != "127.0.0.1" || r.Header.Get("X-Forwarded-For") != "" {
			return nil, 0, apiErr(403, "forbidden")
		}
		s.agent.Notify(r.Header.Get("X-Calshare-Request"), r.Header.Get("X-Calshare-Path"), r.Header.Get("X-Calshare-To"))
		return Obj{{"status", "queued"}}, 202, nil
	}
	if !s.fromProxy(r) { // everything below comes through the OpenCloud proxy only
		return nil, 0, apiErr(401, "not authenticated")
	}
	if s.cfg.BasePath != "" && strings.HasPrefix(path, s.cfg.BasePath+"/") {
		path = path[len(s.cfg.BasePath):]
	}
	user := r.Header.Get(s.cfg.RemoteUserHeader)
	if user == "" || !nameRE.MatchString(user) {
		return nil, 0, apiErr(401, "not authenticated")
	}
	auth := r.Header.Get("Authorization")
	var parts []string
	for _, p := range strings.Split(strings.Trim(path, "/"), "/") {
		parts = append(parts, unescape(p))
	}
	if parts[0] != "v1" {
		return nil, 0, apiErr(404, "not found")
	}
	parts = parts[1:]
	for _, p := range parts {
		if !nameRE.MatchString(p) {
			return nil, 0, apiErr(400, "invalid path segment: %s", quoteString(p))
		}
	}

	is := func(m string, pattern ...string) bool {
		if m != method || len(pattern) != len(parts) {
			return false
		}
		for i, p := range pattern {
			if p != "*" && p != parts[i] {
				return false
			}
		}
		return true
	}
	switch {
	case is("GET", "calendars"):
		calendars, err := s.listCalendars(user)
		if err != nil {
			return nil, 0, err
		}
		out := []Obj{}
		for _, c := range calendars {
			if !c.Shared {
				out = append(out, c.view())
			}
		}
		return out, 200, nil
	case is("GET", "calendars", "*", "shares"):
		cal := parts[1]
		if _, err := s.checkOwnCalendar(user, cal); err != nil {
			return nil, 0, err
		}
		shares, err := s.listShares(user)
		if err != nil {
			return nil, 0, err
		}
		return shareViews(shares, func(sh Share) bool {
			return sh.str("Owner") == user && sh.str("PathMapped") == "/"+user+"/"+cal+"/"
		}), 200, nil
	case is("PUT", "calendars", "*", "shares", "*"):
		body, err := readBody(r)
		if err != nil {
			return nil, 0, err
		}
		status, view, err := s.putShare(user, parts[1], parts[3], body, auth)
		return view, status, err
	case is("DELETE", "calendars", "*", "shares", "*"):
		return nil, 204, s.deleteShare(user, parts[1], parts[3], auth)
	case is("GET", "shares"):
		shares, err := s.listShares(user)
		if err != nil {
			return nil, 0, err
		}
		return shareViews(shares, func(sh Share) bool { return sh.str("Owner") == user }), 200, nil
	case is("GET", "shared-with-me"):
		shares, err := s.listShares(user)
		if err != nil {
			return nil, 0, err
		}
		return shareViews(shares, func(sh Share) bool {
			return sh.str("User") == user && sh.str("Owner") != user
		}), 200, nil
	case is("POST", "shared-with-me", "*", "accept"), is("POST", "shared-with-me", "*", "decline"):
		view, err := s.respondIncoming(user, parts[1], parts[2] == "accept")
		return view, 200, err
	case is("GET", "calendars", "*", "events", "*", "guests"):
		view, err := s.getGuests(user, parts[1], parts[3])
		return view, 200, err
	case is("PUT", "calendars", "*", "events", "*", "guests"):
		body, err := readBody(r)
		if err != nil {
			return nil, 0, err
		}
		view, err := s.putGuests(user, parts[1], parts[3], body, auth)
		return view, 200, err
	case is("POST", "calendars", "*", "events", "*", "respond"):
		body, err := readBody(r)
		if err != nil {
			return nil, 0, err
		}
		view, err := s.respond(user, parts[1], parts[3], body)
		return view, 200, err
	case is("GET", "invitations"):
		return s.agent.ListFor(user), 200, nil
	case is("GET", "invitations", "pending"):
		return s.agent.PendingFor(user), 200, nil
	}
	return nil, 0, apiErr(404, "not found")
}
