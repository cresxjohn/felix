// Felix calendar bridge. Felix on your Mac calls this web app to read your work calendar and the Tech Team
// Vacation Tracker, and to send your reply to an invite (Yes, Maybe, No). Nothing else: it can't make, change or
// delete events, and it reads no other calendar. Every call must carry the key below, which only your Mac's
// Keychain has. To shut it off, archive the deployment (Deploy → Manage deployments) or delete this project.
const KEY = "__FELIX_KEY__";
const TRACKER = "c_jieq9t3t5r8c2ino7235kp71vo@group.calendar.google.com";
const CALENDARS = ["primary", TRACKER];
const REPLIES = ["accepted", "tentative", "declined"];

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ error: "bad-request" });
  }
  if (!body || body.key !== KEY) return out({ error: "key" });
  try {
    if (body.action === "ping") return out({ ok: true, felix: "calendar-bridge", version: 2 });
    if (body.action === "events") return out(events(body.calendar, body.params || {}));
    if (body.action === "rsvp") return out(rsvp(body.eventId, body.response, body.comment));
    return out({ error: "bad-request" });
  } catch (err) {
    return out({ error: "google", message: String((err && err.message) || err) });
  }
}

function doGet() {
  return out({ felix: "calendar-bridge" });
}

// Events on one of the two calendars, repeating ones expanded, in the same shape as Google's Calendar API.
function events(calendar, params) {
  if (CALENDARS.indexOf(calendar) < 0) return { error: "calendar" };
  const max = Math.min(Number(params.maxResults) || 250, 500);
  const query = { singleEvents: true, orderBy: "startTime", maxResults: Math.min(max, 250), timeMin: params.timeMin, timeMax: params.timeMax };
  const items = [];
  let pageToken = null;
  do {
    const page = Calendar.Events.list(calendar, pageToken ? Object.assign({}, query, { pageToken: pageToken }) : query);
    Array.prototype.push.apply(items, page.items || []);
    pageToken = page.nextPageToken;
  } while (pageToken && items.length < max);
  return { items: items };
}

// Your reply to an invite on your own calendar, with an optional note. Google tells the organizer, as when you
// reply in Calendar.
function rsvp(eventId, response, comment) {
  if (!eventId || REPLIES.indexOf(response) < 0) return { error: "bad-request" };
  const event = Calendar.Events.get("primary", eventId);
  const attendees = event.attendees || [];
  const me = attendees.filter(function (a) { return a.self; })[0];
  if (!me) return { error: "not-invited" };
  me.responseStatus = response;
  if (typeof comment === "string") me.comment = comment.slice(0, 500);
  Calendar.Events.patch({ attendees: attendees }, "primary", eventId, { sendUpdates: "all" });
  return { ok: true, response: response, comment: typeof comment === "string" };
}

function out(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
