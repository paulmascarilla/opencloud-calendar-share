package main

// Encodings with a fixed, byte-stable output that clients and scripts rely on: JSON with
// ", " and ": " separators, percent-encoding of paths and queries, HTML escaping and quoted
// strings for logs and errors.

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// KV is one member of an Obj.
type KV struct {
	K string
	V any
}

// Obj is a JSON object that keeps its members in order.
type Obj []KV

func (o Obj) Get(k string) (any, bool) {
	for _, kv := range o {
		if kv.K == k {
			return kv.V, true
		}
	}
	return nil, false
}

// encodeJSON encodes v with ", " and ": " separators and non-ASCII characters as \uXXXX.
func encodeJSON(v any) []byte {
	var b strings.Builder
	writeJSON(&b, v)
	return []byte(b.String())
}

func writeJSON(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJSONString(b, x)
	case json.Number:
		b.WriteString(x.String())
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1e16 {
			b.WriteString(strconv.FormatFloat(x, 'f', 1, 64))
		} else {
			b.WriteString(strconv.FormatFloat(x, 'g', -1, 64))
		}
	case Obj:
		b.WriteByte('{')
		for i, kv := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeJSONString(b, kv.K)
			b.WriteString(": ")
			writeJSON(b, kv.V)
		}
		b.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := make(Obj, 0, len(keys))
		for _, k := range keys {
			o = append(o, KV{k, x[k]})
		}
		writeJSON(b, o)
	case []string:
		b.WriteByte('[')
		for i, s := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeJSONString(b, s)
		}
		b.WriteByte(']')
	case []Obj:
		b.WriteByte('[')
		for i, o := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeJSON(b, o)
		}
		b.WriteByte(']')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			writeJSON(b, e)
		}
		b.WriteByte(']')
	default:
		panic(fmt.Sprintf("encodeJSON: unsupported type %T", v))
	}
}

func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (r > 0x7f && r < 0x10000):
				fmt.Fprintf(b, `\u%04x`, r)
			case r >= 0x10000:
				r1, r2 := surrogates(r)
				fmt.Fprintf(b, `\u%04x\u%04x`, r1, r2)
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

func surrogates(r rune) (rune, rune) {
	r -= 0x10000
	return 0xd800 + (r>>10)&0x3ff, 0xdc00 + r&0x3ff
}

// escapePath percent-encodes s, except unreserved characters and "/".
func escapePath(s string) string { return percentEncode(s, "/", false) }

// escapeQuery percent-encodes a query value: "/" is encoded too and spaces become "+".
func escapeQuery(s string) string { return percentEncode(s, "", true) }

func percentEncode(s, safe string, plus bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '_', c == '.', c == '-', c == '~', strings.IndexByte(safe, c) >= 0:
			b.WriteByte(c)
		case c == ' ' && plus:
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// unescape decodes percent escapes; invalid escapes are left as they are.
func unescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var raw []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			raw = append(raw, byte(n))
			i += 2
			continue
		}
		raw = append(raw, s[i])
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	return strings.ToValidUTF8(string(raw), "�")
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// escapeHTML escapes &, <, >, " and '.
func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;").Replace(s)
}

// quoteString quotes s for logs and errors: single quotes (double if s only contains single
// quotes), backslash escapes for control characters.
func quoteString(s string) string {
	q := byte('\'')
	if strings.Contains(s, "'") && !strings.Contains(s, `"`) {
		q = '"'
	}
	var b strings.Builder
	b.WriteByte(q)
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == rune(q):
			b.WriteByte('\\')
			b.WriteByte(q)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\x%02x`, r)
		case r >= 0x80 && r < 0xa0:
			fmt.Fprintf(&b, `\x%02x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte(q)
	return b.String()
}

// truthy reports whether a decoded JSON value is set: null, false, 0, "", [] and {} are not.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err != nil || f != 0
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}
