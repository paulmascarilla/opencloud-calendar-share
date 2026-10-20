package main

// Minimal iCalendar (RFC 5545) object model: enough to read, edit and write back events
// without losing anything. Values are kept as written (raw); text values are escaped and
// unescaped on demand.

import (
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Param struct {
	Name string // upper case
	Raw  string // as written, quotes included
	Bare bool   // written without "=value" (invalid, kept as found)
}

type Prop struct {
	Name   string // upper case
	Params []Param
	Value  string // raw value
}

type Component struct {
	Name  string // upper case
	Props []*Prop
	Subs  []*Component
}

// --- parsing ---------------------------------------------------------------

func ParseICal(data []byte) (*Component, error) {
	var lines []string
	for _, l := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		l = strings.TrimSuffix(l, "\r")
		if (strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] += l[1:]
			continue
		}
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	var root *Component
	var stack []*Component
	for _, l := range lines {
		p, ok := parseLine(l)
		if !ok {
			continue // not a content line: skip it rather than reject the whole object
		}
		switch p.Name {
		case "BEGIN":
			c := &Component{Name: strings.ToUpper(p.Value)}
			if len(stack) > 0 {
				top := stack[len(stack)-1]
				top.Subs = append(top.Subs, c)
			} else if root == nil {
				root = c
			} else {
				return nil, errors.New("ical: several top-level components")
			}
			stack = append(stack, c)
		case "END":
			if len(stack) == 0 || stack[len(stack)-1].Name != strings.ToUpper(p.Value) {
				return nil, errors.New("ical: unbalanced END:" + p.Value)
			}
			stack = stack[:len(stack)-1]
		default:
			if len(stack) == 0 {
				return nil, errors.New("ical: property outside of a component")
			}
			top := stack[len(stack)-1]
			top.Props = append(top.Props, p)
		}
	}
	if root == nil {
		return nil, errors.New("ical: no component")
	}
	if len(stack) > 0 {
		return nil, errors.New("ical: missing END:" + stack[len(stack)-1].Name)
	}
	return root, nil
}

// parseLine splits "NAME;P=V;Q=\"a:b\":value".
func parseLine(line string) (*Prop, bool) {
	i := strings.IndexAny(line, ";:")
	if i <= 0 {
		return nil, false
	}
	p := &Prop{Name: strings.ToUpper(line[:i])}
	rest := line[i:]
	for strings.HasPrefix(rest, ";") {
		rest = rest[1:]
		eq := strings.IndexAny(rest, "=;:")
		if eq < 0 {
			return nil, false
		}
		if rest[eq] != '=' { // parameter without value: keep it as is
			p.Params = append(p.Params, Param{Name: strings.ToUpper(rest[:eq]), Bare: true})
			rest = rest[eq:]
			continue
		}
		name := strings.ToUpper(rest[:eq])
		rest = rest[eq+1:]
		end, inQuote := 0, false
		for end < len(rest) {
			c := rest[end]
			if c == '"' {
				inQuote = !inQuote
			} else if !inQuote && (c == ';' || c == ':') {
				break
			}
			end++
		}
		p.Params = append(p.Params, Param{Name: name, Raw: rest[:end]})
		rest = rest[end:]
	}
	if !strings.HasPrefix(rest, ":") {
		return nil, false
	}
	p.Value = rest[1:]
	return p, true
}

// --- writing ---------------------------------------------------------------

func (c *Component) Serialize() []byte {
	var b strings.Builder
	c.write(&b)
	return []byte(b.String())
}

func (c *Component) write(b *strings.Builder) {
	writeFolded(b, "BEGIN:"+c.Name)
	for _, p := range c.Props {
		writeFolded(b, p.line())
	}
	for _, s := range c.Subs {
		s.write(b)
	}
	writeFolded(b, "END:"+c.Name)
}

func (p *Prop) line() string {
	var b strings.Builder
	b.WriteString(p.Name)
	// Sorted by name: stable output (clients and tests may rely on it).
	params := append([]Param(nil), p.Params...)
	sort.SliceStable(params, func(i, j int) bool { return params[i].Name < params[j].Name })
	for _, prm := range params {
		b.WriteByte(';')
		b.WriteString(prm.Name)
		if !prm.Bare {
			b.WriteByte('=')
			b.WriteString(prm.Raw)
		}
	}
	b.WriteByte(':')
	b.WriteString(p.Value)
	return b.String()
}

// writeFolded folds lines at 75 octets without splitting UTF-8 sequences.
func writeFolded(b *strings.Builder, line string) {
	limit := 75
	for len(line) > limit {
		cut := limit
		for cut > 0 && line[cut]&0xC0 == 0x80 {
			cut--
		}
		b.WriteString(line[:cut])
		b.WriteString("\r\n ")
		line = line[cut:]
		limit = 74 // the leading space counts
	}
	b.WriteString(line)
	b.WriteString("\r\n")
}

// Clone returns a deep copy.
func (c *Component) Clone() *Component {
	out := &Component{Name: c.Name}
	for _, p := range c.Props {
		cp := *p
		cp.Params = append([]Param(nil), p.Params...)
		out.Props = append(out.Props, &cp)
	}
	for _, s := range c.Subs {
		out.Subs = append(out.Subs, s.Clone())
	}
	return out
}

// --- components ------------------------------------------------------------

// Walk returns this component and its descendants named name (all when name is ""), depth first.
func (c *Component) Walk(name string) []*Component {
	var out []*Component
	if name == "" || c.Name == name {
		out = append(out, c)
	}
	for _, s := range c.Subs {
		out = append(out, s.Walk(name)...)
	}
	return out
}

func (c *Component) Get(name string) *Prop {
	for _, p := range c.Props {
		if p.Name == name {
			return p
		}
	}
	return nil
}

func (c *Component) All(name string) []*Prop {
	var out []*Prop
	for _, p := range c.Props {
		if p.Name == name {
			out = append(out, p)
		}
	}
	return out
}

func (c *Component) Has(name string) bool { return c.Get(name) != nil }

// Remove drops every property named name and returns them.
func (c *Component) Remove(name string) []*Prop {
	var kept, removed []*Prop
	for _, p := range c.Props {
		if p.Name == name {
			removed = append(removed, p)
		} else {
			kept = append(kept, p)
		}
	}
	c.Props = kept
	return removed
}

func (c *Component) Add(p *Prop) { c.Props = append(c.Props, p) }

// Value is the raw value of the first property named name ("" when absent).
func (c *Component) Value(name string) string {
	if p := c.Get(name); p != nil {
		return p.Value
	}
	return ""
}

// Text is the unescaped text value of the first property named name.
func (c *Component) Text(name string) string {
	if p := c.Get(name); p != nil {
		return p.Text()
	}
	return ""
}

// SetText replaces name with a single text property; an empty value removes it.
func (c *Component) SetText(name, value string) {
	c.Remove(name)
	if value != "" {
		c.Add(NewText(name, value))
	}
}

// --- properties --------------------------------------------------------------

func NewText(name, text string) *Prop { return &Prop{Name: name, Value: EscapeText(text)} }

func (p *Prop) Text() string { return UnescapeText(p.Value) }

func (p *Prop) HasParam(name string) bool {
	for _, prm := range p.Params {
		if prm.Name == name {
			return true
		}
	}
	return false
}

// Param is the value of a parameter, without the surrounding quotes.
func (p *Prop) Param(name string) string {
	for _, prm := range p.Params {
		if prm.Name == name {
			return unquoteParam(prm.Raw)
		}
	}
	return ""
}

func (p *Prop) SetParam(name, value string) {
	raw := quoteParam(value)
	for i, prm := range p.Params {
		if prm.Name == name {
			p.Params[i] = Param{Name: name, Raw: raw}
			return
		}
	}
	p.Params = append(p.Params, Param{Name: name, Raw: raw})
}

func (p *Prop) DelParam(name string) {
	kept := p.Params[:0]
	for _, prm := range p.Params {
		if prm.Name != name {
			kept = append(kept, prm)
		}
	}
	p.Params = kept
}

func unquoteParam(raw string) string {
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' && !strings.Contains(raw[1:len(raw)-1], `"`) {
		raw = raw[1 : len(raw)-1]
	}
	return paramDecoder.Replace(raw)
}

// RFC 6868: a parameter value cannot hold a line break or a DQUOTE, so they are written ^n and ^'.
// Without it, a display name with a line break would inject iCalendar lines.
var (
	paramEncoder = strings.NewReplacer("^", "^^", "\r\n", "^n", "\n", "^n", "\r", "^n", `"`, "^'")
	paramDecoder = strings.NewReplacer("^^", "^", "^n", "\n", "^N", "\n", "^'", `"`)
)

func quoteParam(v string) string {
	v = paramEncoder.Replace(v)
	if strings.ContainsAny(v, ",;:") {
		return `"` + v + `"`
	}
	return v
}

func EscapeText(s string) string {
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`)
	return r.Replace(s)
}

func UnescapeText(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case 'n', 'N':
				b.WriteByte('\n')
				i++
				continue
			case '\\', ';', ',':
				b.WriteByte(s[i+1])
				i++
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// Time reads a DATE or DATE-TIME property as UTC. allDay is true for a DATE.
// Floating times and unknown time zones are taken as UTC: close enough to sort and filter.
func (p *Prop) Time() (t time.Time, allDay bool, ok bool) {
	v := strings.TrimSpace(p.Value)
	if strings.EqualFold(p.Param("VALUE"), "DATE") || len(v) == 8 {
		t, err := time.Parse("20060102", v)
		return t, true, err == nil
	}
	if strings.HasSuffix(v, "Z") {
		t, err := time.Parse("20060102T150405Z", v)
		return t, false, err == nil
	}
	loc := time.UTC
	if l := location(p.Param("TZID")); l != nil {
		loc = l
	}
	t, err := time.ParseInLocation("20060102T150405", v, loc)
	return t.UTC(), false, err == nil
}

// location finds the zone of a TZID, also behind a prefix such as Evolution's
// "/freeassociation.sourceforge.net/Europe/Paris". nil when unknown.
func location(tzid string) *time.Location {
	parts := strings.Split(strings.Trim(tzid, "/"), "/")
	for i := range parts {
		if l, err := time.LoadLocation(strings.Join(parts[i:], "/")); err == nil && parts[i] != "" {
			return l
		}
	}
	return nil
}

// span returns when an event starts and ends (DTEND, else DTSTART + DURATION, else one day for
// an all-day event and no time otherwise), in UTC.
func span(event *Component) (start, end time.Time, allDay, ok bool) {
	dtstart := event.Get("DTSTART")
	if dtstart == nil {
		return
	}
	if start, allDay, ok = dtstart.Time(); !ok {
		return
	}
	end = start
	if allDay {
		end = start.AddDate(0, 0, 1)
	}
	if dtend := event.Get("DTEND"); dtend != nil {
		if t, _, good := dtend.Time(); good {
			end = t
		}
	} else if d, good := parseDuration(event.Value("DURATION")); good {
		end = start.Add(d)
	}
	return start, end, allDay, true
}

var durationRE = regexp.MustCompile(`^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

// parseDuration reads an RFC 5545 DURATION such as PT1H30M or P1D.
func parseDuration(v string) (time.Duration, bool) {
	m := durationRE.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil || v == "P" {
		return 0, false
	}
	units := []time.Duration{7 * 24 * time.Hour, 24 * time.Hour, time.Hour, time.Minute, time.Second}
	var d time.Duration
	for i, unit := range units {
		if n, err := strconv.Atoi(m[i+2]); err == nil {
			d += time.Duration(n) * unit
		}
	}
	if m[1] == "-" {
		d = -d
	}
	return d, true
}
