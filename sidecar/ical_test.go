package main

import (
	"strings"
	"testing"
	"time"
)

const sample = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\n" +
	"SUMMARY:Long title with accents éèà that goes well beyond the seventy-five octets of a line\r\n" +
	"ATTENDEE;CN=\"Doe, John\";PARTSTAT=NEEDS-ACTION;X-OC-USERID=42:mailto:j@x.org\r\n" +
	"DESCRIPTION:a\\nb\\, c\\; d\\\\e\r\n" +
	"END:VEVENT\r\nEND:VCALENDAR\r\n"

func TestICalRoundTrip(t *testing.T) {
	cal, err := ParseICal([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	out := cal.Serialize()
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\r\n"), "\r\n") {
		if len(line) > 75 {
			t.Errorf("line longer than 75 octets: %q", line)
		}
	}
	again, err := ParseICal(out)
	if err != nil {
		t.Fatal(err)
	}
	ev := masterEvent(again)
	if got := ev.Text("SUMMARY"); got != "Long title with accents éèà that goes well beyond the seventy-five octets of a line" {
		t.Errorf("summary: %q", got)
	}
	if got := ev.Text("DESCRIPTION"); got != "a\nb, c; d\\e" {
		t.Errorf("description: %q", got)
	}
	a := ev.Get("ATTENDEE")
	if a.Param("CN") != "Doe, John" || userID(a) != "42" || a.Value != "mailto:j@x.org" {
		t.Errorf("attendee: %+v", a)
	}
	a.SetParam("CN", "Doe; Jane")
	a.DelParam("PARTSTAT")
	if got := a.line(); got != `ATTENDEE;CN="Doe; Jane";X-OC-USERID=42:mailto:j@x.org` {
		t.Errorf("line: %s", got)
	}
	clone := again.Clone()
	masterEvent(clone).Get("ATTENDEE").SetParam("CN", "changed")
	masterEvent(clone).Subs = append(masterEvent(clone).Subs, &Component{Name: "VALARM"})
	if a.Param("CN") != "Doe; Jane" || len(ev.Subs) != 0 {
		t.Error("Clone must not share state with the original")
	}
}

func TestICalErrors(t *testing.T) {
	for _, bad := range []string{"", "BEGIN:VCALENDAR\r\n", "END:VEVENT\r\n", "SUMMARY:x\r\n",
		"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"} {
		if _, err := ParseICal([]byte(bad)); err == nil {
			t.Errorf("no error for %q", bad)
		}
	}
}

func TestPropTime(t *testing.T) {
	cases := []struct {
		line   string
		want   string
		allDay bool
	}{
		{"DTSTART:20261028T130000Z", "2026-10-28T13:00:00Z", false},
		{"DTSTART;VALUE=DATE:20261102", "2026-11-02T00:00:00Z", true},
		{"DTSTART:20261102", "2026-11-02T00:00:00Z", true},
		{"DTSTART;TZID=Europe/Paris:20261029T100000", "2026-10-29T09:00:00Z", false},
		{"DTSTART;TZID=Europe/Paris:20260701T100000", "2026-07-01T08:00:00Z", false},
		{"DTSTART;TZID=Custom zone:20261029T100000", "2026-10-29T10:00:00Z", false},
		{"DTSTART:20261029T100000", "2026-10-29T10:00:00Z", false},
	}
	for _, c := range cases {
		p, _ := parseLine(c.line)
		got, allDay, ok := p.Time()
		if !ok || got.Format(time.RFC3339) != c.want || allDay != c.allDay {
			t.Errorf("%s: %v %v %v", c.line, got, allDay, ok)
		}
	}
	if p, _ := parseLine("DTSTART:garbage"); func() bool { _, _, ok := p.Time(); return ok }() {
		t.Error("garbage must not parse")
	}
}

// Line breaks in values must never reach the output raw: they would inject iCalendar lines.
func TestICalInjection(t *testing.T) {
	p := &Prop{Name: "ATTENDEE", Value: "urn:uuid:1"}
	p.SetParam("CN", "x\r\nATTENDEE:evil")
	if got := p.line(); got != `ATTENDEE;CN="x^nATTENDEE:evil":urn:uuid:1` {
		t.Errorf("param: %s", got)
	}
	if p.Param("CN") != "x\nATTENDEE:evil" {
		t.Errorf("param round trip: %q", p.Param("CN"))
	}
	p.SetParam("CN", `q"u^o`)
	if got := p.line(); got != `ATTENDEE;CN=q^'u^^o:urn:uuid:1` || p.Param("CN") != `q"u^o` {
		t.Errorf("param: %s / %q", got, p.Param("CN"))
	}
	if got := NewText("SUMMARY", "a\rb\r\nc").line(); got != `SUMMARY:a\nb\nc` {
		t.Errorf("text: %s", got)
	}
}
