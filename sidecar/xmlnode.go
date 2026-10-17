package main

import (
	"bytes"
	"encoding/xml"
)

// xmlNode is a namespace-aware DOM, enough for WebDAV multistatus answers.
type xmlNode struct {
	Name     xml.Name
	Attrs    []xml.Attr
	Text     string
	Children []*xmlNode
}

func parseXML(data []byte) (*xmlNode, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := &xmlNode{}
	stack := []*xmlNode{root}
	for {
		tok, err := dec.Token()
		if err != nil {
			if len(stack) == 1 && len(root.Children) == 1 {
				return root.Children[0], nil
			}
			return nil, apiErr(502, "invalid XML from radicale: %v", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &xmlNode{Name: t.Name, Attrs: t.Attr}
			top := stack[len(stack)-1]
			top.Children = append(top.Children, n)
			stack = append(stack, n)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			top := stack[len(stack)-1]
			if len(top.Children) == 0 { // ElementTree's .text: the text before the first child
				top.Text += string(t)
			}
		}
	}
}

// find returns the first child named {ns}local; nil-safe.
func (n *xmlNode) find(ns, local string) *xmlNode {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Name.Space == ns && c.Name.Local == local {
			return c
		}
	}
	return nil
}

func (n *xmlNode) children(ns, local string) []*xmlNode {
	if n == nil {
		return nil
	}
	var out []*xmlNode
	for _, c := range n.Children {
		if c.Name.Space == ns && c.Name.Local == local {
			out = append(out, c)
		}
	}
	return out
}

func (n *xmlNode) childText(ns, local string) string {
	if c := n.find(ns, local); c != nil {
		return c.Text
	}
	return ""
}

func (n *xmlNode) attr(local string) string {
	for _, a := range n.Attrs {
		if a.Name.Space == "" && a.Name.Local == local {
			return a.Value
		}
	}
	return ""
}

// iter returns every descendant named {ns}local (document order).
func (n *xmlNode) iter(ns, local string, out []*xmlNode) []*xmlNode {
	if n.Name.Space == ns && n.Name.Local == local {
		out = append(out, n)
	}
	for _, c := range n.Children {
		out = c.iter(ns, local, out)
	}
	return out
}
