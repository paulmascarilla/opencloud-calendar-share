package main

// Reference outputs of the encodings: do not edit by hand.

var encodingCases = []struct{ in, dumps, quote, quotePlus, htmlEscape, repr string }{
	{"simple", "\"simple\"", "simple", "simple", "simple", "'simple'"},
	{"Tâches (alice)", "\"T\\u00e2ches (alice)\"", "T%C3%A2ches%20%28alice%29", "T%C3%A2ches+%28alice%29", "Tâches (alice)", "'Tâches (alice)'"},
	{"é\"\\\n\t\u0001<&>'", "\"\\u00e9\\\"\\\\\\n\\t\\u0001<&>'\"", "%C3%A9%22%5C%0A%09%01%3C%26%3E%27", "%C3%A9%22%5C%0A%09%01%3C%26%3E%27", "é&quot;\\\n\t\u0001&lt;&amp;&gt;&#x27;", "'é\"\\\\\\n\\t\\x01<&>\\''"},
	{"emoji 😀 €", "\"emoji \\ud83d\\ude00 \\u20ac\"", "emoji%20%F0%9F%98%80%20%E2%82%AC", "emoji+%F0%9F%98%80+%E2%82%AC", "emoji 😀 €", "'emoji 😀 €'"},
	{"a/b c+d@e.f~g", "\"a/b c+d@e.f~g\"", "a/b%20c%2Bd%40e.f~g", "a%2Fb+c%2Bd%40e.f~g", "a/b c+d@e.f~g", "'a/b c+d@e.f~g'"},
	{"", "\"\"", "", "", "", "''"},
	{"x'y", "\"x'y\"", "x%27y", "x%27y", "x&#x27;y", "\"x'y\""},
	{"x'y\"z", "\"x'y\\\"z\"", "x%27y%22z", "x%27y%22z", "x&#x27;y&quot;z", "'x\\'y\"z'"},
	{"日本", "\"\\u65e5\\u672c\"", "%E6%97%A5%E6%9C%AC", "%E6%97%A5%E6%9C%AC", "日本", "'日本'"},
}

var objDump = "{\"id\": \"x\", \"n\": null, \"b\": true, \"l\": [\"\\u00e9\", 1792236570], \"o\": {\"k\": \"v\"}}"
