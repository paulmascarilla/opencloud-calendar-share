package main

import (
	"encoding/json"
	"testing"
)

func TestEncodings(t *testing.T) {
	for _, c := range encodingCases {
		if got := string(encodeJSON(c.in)); got != c.dumps {
			t.Errorf("encodeJSON(%q) = %s, want %s", c.in, got, c.dumps)
		}
		if got := escapePath(c.in); got != c.quote {
			t.Errorf("escapePath(%q) = %s, want %s", c.in, got, c.quote)
		}
		if got := escapeQuery(c.in); got != c.quotePlus {
			t.Errorf("escapeQuery(%q) = %s, want %s", c.in, got, c.quotePlus)
		}
		if got := escapeHTML(c.in); got != c.htmlEscape {
			t.Errorf("escapeHTML(%q) = %s, want %s", c.in, got, c.htmlEscape)
		}
		if got := quoteString(c.in); got != c.repr {
			t.Errorf("quoteString(%q) = %s, want %s", c.in, got, c.repr)
		}
		if got := unescape(c.quote); got != c.in {
			t.Errorf("unescape(%q) = %q, want %q", c.quote, got, c.in)
		}
	}
	obj := Obj{{"id", "x"}, {"n", nil}, {"b", true}, {"l", []any{"é", json.Number("1792236570")}}, {"o", map[string]any{"k": "v"}}}
	if got := string(encodeJSON(obj)); got != objDump {
		t.Errorf("encodeJSON(obj) = %s, want %s", got, objDump)
	}
	if got := unescape("100%"); got != "100%" {
		t.Errorf("invalid escapes must be kept: %q", got)
	}
}
