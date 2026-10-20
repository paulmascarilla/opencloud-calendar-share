package main

// Event invitations, REST side: guest lists and answers.

import (
	"strconv"
	"strings"
	"time"
)

// loadEvent GETs an event as user (works for own calendars and mounted shares).
func (s *Server) loadEvent(user, cal, event string) (path string, calObj, master *Component, etag string, err error) {
	path = "/" + user + "/" + cal + "/" + event
	status, body, headers, err := s.httpFull("GET", s.cfg.RadicaleURL+escapePath(path),
		map[string]string{s.cfg.RemoteUserHeader: user}, nil)
	if err != nil {
		return "", nil, nil, "", err
	}
	if status == 404 {
		return "", nil, nil, "", apiErr(404, "event not found")
	}
	if status != 200 {
		return "", nil, nil, "", apiErr(map[bool]int{true: 403, false: 502}[status == 403], "cannot read event (%d)", status)
	}
	calObj, err = ParseICal(body)
	if err != nil {
		return "", nil, nil, "", err
	}
	master = masterEvent(calObj)
	if master == nil {
		return "", nil, nil, "", apiErr(400, "not an event")
	}
	return path, calObj, master, headers.Get("ETag"), nil
}

func (s *Server) storeEvent(user, path string, calObj *Component, etag string) error {
	status, _, err := s.http("PUT", s.cfg.RadicaleURL+escapePath(path),
		map[string]string{s.cfg.RemoteUserHeader: user, "Content-Type": "text/calendar; charset=utf-8", "If-Match": etag},
		calObj.Serialize())
	if err != nil {
		return err
	}
	if status == 412 {
		return apiErr(409, "event changed in the meantime, retry")
	}
	if status != 200 && status != 201 && status != 204 {
		return apiErr(map[bool]int{true: 403, false: 502}[status == 403], "cannot write event (%d)", status)
	}
	return nil
}

func guestsView(master *Component) Obj {
	var organizer any
	if org := master.Get("ORGANIZER"); org != nil {
		var id any
		if uid := userID(org); uid != "" {
			id = uid
		}
		organizer = Obj{{"id", id}, {"displayName", org.Param("CN")}}
	}
	guests := []Obj{}
	for _, a := range master.All("ATTENDEE") {
		uid := userID(a)
		if uid == "" {
			continue
		}
		response, ok := responseNames[strings.ToUpper(a.Param("PARTSTAT"))]
		if !ok {
			response = "pending"
		}
		guests = append(guests, Obj{{"id", uid}, {"displayName", a.Param("CN")}, {"response", response},
			{"proposal", proposalView(a)}})
	}
	return Obj{{"organizer", organizer}, {"guests", guests}}
}

// proposalView is the time a guest proposed instead (ISO 8601 dates), or nil.
func proposalView(attendee *Prop) any {
	start, end := attendee.Param(ProposedStart), attendee.Param(ProposedEnd)
	if start == "" || end == "" {
		return nil
	}
	iso := func(v string) string {
		if t, err := time.Parse("20060102T150405Z", v); err == nil {
			return t.Format(time.RFC3339)
		}
		if t, err := time.Parse("20060102", v); err == nil {
			return t.Format("2006-01-02")
		}
		return v
	}
	return Obj{{"start", iso(start)}, {"end", iso(end)}, {"allDay", len(start) == 8}}
}

func calAddress(u *User) *Prop {
	p := &Prop{Name: "ATTENDEE", Value: "urn:uuid:" + u.ID}
	p.SetParam("CN", u.DisplayName)
	p.SetParam(UserIDParam, u.ID)
	return p
}

func (s *Server) getGuests(user, cal, event string) (Obj, error) {
	_, _, master, _, err := s.loadEvent(user, cal, event)
	if err != nil {
		return nil, err
	}
	return guestsView(master), nil
}

func (s *Server) putGuests(user, cal, event string, body map[string]any, authHeader string) (Obj, error) {
	list, ok := body["guests"].([]any)
	var names []string
	for _, n := range list {
		name, isStr := n.(string)
		if !isStr || !nameRE.MatchString(name) {
			ok = false
			break
		}
		names = append(names, name)
	}
	if !ok {
		return nil, apiErr(400, "guests must be a list of usernames, e-mails or ids")
	}
	path, calObj, master, etag, err := s.loadEvent(user, cal, event)
	if err != nil {
		return nil, err
	}
	organizer := master.Get("ORGANIZER")
	organizerID := userID(organizer)
	if organizerID == "" {
		organizerID = user
	}
	if err := s.checkOrganizer(user, path, calObj, master, "only the organizer can change the guest list"); err != nil {
		return nil, err
	}

	var wantedIDs []string
	wanted := map[string]*User{}
	for _, name := range names {
		resolved, err := s.resolveUser(name, authHeader)
		if err != nil {
			return nil, err
		}
		if resolved.ID == organizerID {
			continue
		}
		if _, seen := wanted[resolved.ID]; !seen {
			wantedIDs = append(wantedIDs, resolved.ID)
		}
		wanted[resolved.ID] = resolved
	}
	previous := map[string]*Prop{}
	var external []*Prop
	for _, a := range master.All("ATTENDEE") {
		if uid := userID(a); uid != "" {
			previous[uid] = a
		} else {
			external = append(external, a)
		}
	}

	master.Remove("ATTENDEE")
	for _, id := range wantedIDs {
		old := previous[id]
		// Keep a mailto: address set by a CalDAV client: it lets the guest's client
		// recognize the invitation as theirs.
		address := calAddress(wanted[id])
		if old != nil && strings.HasPrefix(strings.ToLower(old.Value), "mailto:") {
			address = old
		}
		partstat := "NEEDS-ACTION"
		if old != nil && old.HasParam("PARTSTAT") {
			partstat = old.Param("PARTSTAT")
		}
		address.SetParam("PARTSTAT", partstat)
		address.SetParam("ROLE", "REQ-PARTICIPANT")
		if old == nil || partstat == "NEEDS-ACTION" {
			address.SetParam("RSVP", "TRUE")
		}
		master.Add(address)
	}
	// Keep external (non-OpenCloud) attendees added by other clients.
	for _, a := range external {
		master.Add(a)
	}

	if len(wanted) > 0 && organizer == nil {
		me, err := s.resolveUser(user, authHeader)
		if err != nil {
			if !isApiError(err) {
				return nil, err
			}
			me = &User{ID: user, DisplayName: user}
		}
		org := calAddress(me)
		org.Name = "ORGANIZER"
		master.Add(org)
	} else if len(wanted) == 0 && !master.Has("ATTENDEE") && organizer != nil {
		master.Remove("ORGANIZER")
	}
	sequence := 0
	if removed := master.Remove("SEQUENCE"); len(removed) > 0 {
		sequence, _ = strconv.Atoi(strings.TrimSpace(removed[0].Value))
	}
	master.Add(&Prop{Name: "SEQUENCE", Value: strconv.Itoa(sequence + 1)})
	if err := s.storeEvent(user, path, calObj, etag); err != nil {
		return nil, err
	}
	return guestsView(master), nil
}

// checkOrganizer: a guest's copy is managed by the agent; in a shared calendar, the calendar
// owner (or whoever organizes the event) may manage its guests.
func (s *Server) checkOrganizer(user, path string, calObj, master *Component, message string) error {
	forbidden := calObj.Has(OrganizerHref)
	if organizer := master.Get("ORGANIZER"); !forbidden && organizer != nil && userID(organizer) != "" && userID(organizer) != user {
		owner, err := s.ownerOf(path, user)
		if err != nil {
			return err
		}
		forbidden = owner != user
	}
	if forbidden {
		return apiErr(403, "%s", message)
	}
	return nil
}

// propose records another time for an invitation, on the organizer's event (the guest cannot
// write it, the agent does).
func (s *Server) propose(user, cal, event string, body map[string]any) (Obj, error) {
	start, end, err := parseProposal(body)
	if err != nil {
		return nil, err
	}
	path, _, master, _, err := s.loadEvent(user, cal, event)
	if err != nil {
		return nil, err
	}
	masterPath := s.agent.MasterOf(path)
	if masterPath == "" {
		return nil, apiErr(403, "only a guest can propose another time")
	}
	if master.Has("RRULE") || master.Has("RDATE") {
		return nil, apiErr(400, "cannot propose another time for a recurring event")
	}
	found, err := s.agent.Propose(masterPath, user, start, end)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apiErr(404, "you are not invited to this event")
	}
	proposal := &Prop{}
	proposal.SetParam(ProposedStart, start)
	proposal.SetParam(ProposedEnd, end)
	return Obj{{"proposal", proposalView(proposal)}}, nil
}

// parseProposal reads {"start", "end"}: two dates (all day, end exclusive) or two date-times.
func parseProposal(body map[string]any) (start, end string, err error) {
	rawStart, _ := body["start"].(string)
	rawEnd, _ := body["end"].(string)
	parse := func(v string) (time.Time, bool, bool) {
		if t, err := time.Parse("2006-01-02", v); err == nil {
			return t, true, true
		}
		t, err := time.Parse(time.RFC3339, v)
		return t.UTC(), false, err == nil
	}
	s, sDate, ok1 := parse(rawStart)
	e, eDate, ok2 := parse(rawEnd)
	if !ok1 || !ok2 || sDate != eDate {
		return "", "", apiErr(400, "start and end must be two dates or two date-times (ISO 8601)")
	}
	if !e.After(s) || e.Sub(s) > 366*24*time.Hour || s.Year() < 1900 || e.Year() > 2200 {
		return "", "", apiErr(400, "the end must be after the start, within a year")
	}
	return icalTime(s, sDate), icalTime(e, eDate), nil
}

// decideProposal accepts a guest's proposal (the event moves there, other proposals are
// dropped) or declines it.
func (s *Server) decideProposal(user, cal, event, guest string, accept bool) (Obj, error) {
	path, calObj, master, etag, err := s.loadEvent(user, cal, event)
	if err != nil {
		return nil, err
	}
	if err := s.checkOrganizer(user, path, calObj, master, "only the organizer decides on proposals"); err != nil {
		return nil, err
	}
	var proposer *Prop
	for _, a := range master.All("ATTENDEE") {
		if userID(a) == guest && a.Param(ProposedStart) != "" && a.Param(ProposedEnd) != "" {
			proposer = a
		}
	}
	if proposer == nil {
		return nil, apiErr(404, "no proposal from this guest")
	}
	if accept {
		start, end := proposer.Param(ProposedStart), proposer.Param(ProposedEnd)
		master.Remove("DTSTART")
		master.Remove("DTEND")
		master.Remove("DURATION")
		for name, value := range map[string]string{"DTSTART": start, "DTEND": end} {
			p := &Prop{Name: name, Value: value}
			if len(value) == 8 {
				p.SetParam("VALUE", "DATE")
			}
			master.Add(p)
		}
		for _, a := range master.All("ATTENDEE") {
			a.DelParam(ProposedStart)
			a.DelParam(ProposedEnd)
		}
		proposer.SetParam("PARTSTAT", "ACCEPTED")
		proposer.DelParam("RSVP")
		sequence := 0
		if removed := master.Remove("SEQUENCE"); len(removed) > 0 {
			sequence, _ = strconv.Atoi(strings.TrimSpace(removed[0].Value))
		}
		master.Add(&Prop{Name: "SEQUENCE", Value: strconv.Itoa(sequence + 1)})
	} else {
		proposer.DelParam(ProposedStart)
		proposer.DelParam(ProposedEnd)
	}
	if err := s.storeEvent(user, path, calObj, etag); err != nil {
		return nil, err
	}
	return guestsView(master), nil
}

func (s *Server) respond(user, cal, event string, body map[string]any) (Obj, error) {
	answer, _ := body["response"].(string)
	partstat := responses[answer]
	if partstat == "" {
		return nil, apiErr(400, "response must be 'accepted', 'tentative' or 'declined'")
	}
	path, calObj, master, etag, err := s.loadEvent(user, cal, event)
	if err != nil {
		return nil, err
	}
	found := false
	for _, vevent := range calObj.Walk("VEVENT") {
		for _, attendee := range vevent.All("ATTENDEE") {
			if userID(attendee) == user {
				attendee.SetParam("PARTSTAT", partstat)
				attendee.DelParam("RSVP")
				found = true
			}
		}
	}
	if !found {
		return nil, apiErr(404, "you are not invited to this event")
	}
	if err := s.storeEvent(user, path, calObj, etag); err != nil {
		return nil, err
	}
	return guestsView(master), nil
}
