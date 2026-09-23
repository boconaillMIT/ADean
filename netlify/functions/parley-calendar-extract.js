// parley-calendar-extract.js  (v1.2, 2026-09-23 - own key: PARLEY_CALENDAR_API_KEY)
// Netlify function: port of the VBA CreateCalendarFromEmail / CallParleyAPIforCal pair.
// Location in repo: same functions folder as parley-waiver-check.js
//
// Flow:
//   1. Task pane POSTs { subject, body, today } where today = the browser's local date (YYYY-MM-DD).
//      The server runs in UTC, so "today" must come from the client, never from new Date() here.
//   2. We build an AUTHORITATIVE DATE FACTS table (date -> weekday, next 120 days) and prepend it,
//      same lesson as BuildDateFactsFromEmail: the model looks dates up, it never computes them.
//   3. Parley returns JSON events. We re-check every event's weekday in code and flag mismatches.

// ---------- Constants ----------
const API_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";
const DATE_FACT_DAYS = 120;
const MAX_BODY_CHARS = 30000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------- Date helpers (pure calendar math, UTC-safe) ----------

// Parse "YYYY-MM-DD" into a UTC-midnight Date so weekday math never drifts with timezones
function parseIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function toIsoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

// Build the lookup table the model must use instead of doing calendar arithmetic
function buildDateFacts(todayIso) {
  const today = parseIsoDate(todayIso);
  const lines = [];
  for (let offset = 0; offset < DATE_FACT_DAYS; offset++) {
    const d = new Date(today.getTime() + offset * 86400000);
    lines.push(`${toIsoDate(d)} = ${WEEKDAYS[d.getUTCDay()]}${offset === 0 ? " (TODAY)" : ""}`);
  }
  return lines.join("\n");
}

// Weekday check done in code, never trusted from the model.
// Two separate checks:
//   emailWeekday   - what the email says (catches sender typos like "Thursday, Oct 7")
//   claimedWeekday - what the model says (catches model calendar-arithmetic errors)
function checkWeekday(startLocal, claimedWeekday, emailWeekday) {
  const datePart = (startLocal || "").slice(0, 10);
  const d = parseIsoDate(datePart);
  if (!d) return { ok: false, actual: null, note: "Start date could not be read" };
  const actual = WEEKDAYS[d.getUTCDay()];
  const fromEmail = (emailWeekday || "").trim();
  const claimed = (claimedWeekday || "").trim();
  if (fromEmail && !actual.toLowerCase().startsWith(fromEmail.toLowerCase().slice(0, 3))) {
    return { ok: false, actual, note: `The email says ${fromEmail}, but ${datePart} is a ${actual}` };
  }
  if (claimed && claimed.toLowerCase() !== actual.toLowerCase()) {
    return { ok: false, actual, note: `Parley implied ${claimed}, but ${datePart} is a ${actual}` };
  }
  return { ok: true, actual, note: "" };
}

// ---------- Prompt ----------
function buildPrompt(subject, body, todayIso) {
  return [
    "Extract ALL calendar events from this email.",
    "",
    "AUTHORITATIVE DATE FACTS (use this table to resolve every date and weekday;",
    "do not compute weekdays yourself):",
    buildDateFacts(todayIso),
    "",
    "Return ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:",
    '{ "events": [ {',
    '  "summary": "concise event title",',
    '  "start": "YYYY-MM-DDTHH:MM (24-hour, local time as stated in the email)",',
    '  "end": "YYYY-MM-DDTHH:MM (24-hour); if no end is given, start + 1 hour",',
    '  "all_day": false,',
    '  "weekday": "weekday name of the start date, copied from the table above",',
    '  "email_weekday": "the weekday the email itself states for this event, exactly as written, or empty string if the email names none",',
    '  "location": "location or empty string",',
    '  "description": "one-sentence description",',
    '  "recurring": "no | weekly_monday | weekly_tuesday | weekly_wednesday | weekly_thursday | weekly_friday | weekly_saturday | weekly_sunday",',
    '  "confidence": "high | medium | low",',
    '  "ambiguity": "empty string, or one short sentence on anything you had to guess"',
    "} ] }",
    "",
    "Rules:",
    "- For recurring events with no specific start date, use the NEXT occurrence from today.",
    "- If an event recurs on multiple days of the week (e.g. 'Wed and Thu 11-1'), output SEPARATE events for each day.",
    "- For events with GPS/navigation hints, use the human-readable place name, and append the GPS address in parentheses.",
    "- For all-day events set all_day true and use T00:00 for start and end.",
    "- Skip items that are not actual calendar events (e.g. 'call your rep', 'buy a sweatshirt', 'donate').",
    "- If there are no events, return { \"events\": [] }.",
    "",
    "EMAIL SUBJECT:",
    subject || "(no subject)",
    "",
    "EMAIL BODY:",
    (body || "").slice(0, MAX_BODY_CHARS),
  ].join("\n");
}

// Pull the JSON object out of the model text even if it adds fences or stray words
function extractJson(text) {
  const cleaned = (text || "").replace(/```json|```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("No JSON object in model response");
  return JSON.parse(cleaned.slice(first, last + 1));
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// ---------- Handler ----------
exports.handler = async (event) => {
  // Step 1: validate request
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Use POST" });

  // Calendar uses its own key so its Parley usage is tracked separately from the research tools.
  // No fallback to PARLEY_API_KEY on purpose: a silent fallback would mix the usage again.
  const apiKey = process.env.PARLEY_CALENDAR_API_KEY;
  if (!apiKey) return jsonResponse(500, { error: "PARLEY_CALENDAR_API_KEY is not set in Netlify environment variables" });

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Request body is not valid JSON" });
  }

  const { subject, body, today } = input;
  if (!parseIsoDate(today)) return jsonResponse(400, { error: "Missing or malformed 'today' (expected YYYY-MM-DD)" });
  if (!body && !subject) return jsonResponse(400, { error: "Email subject and body are both empty" });

  // Step 2: call Parley
  let parleyText;
  try {
    const parleyResp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(subject, body, today) }],
      }),
    });
    if (!parleyResp.ok) {
      const errText = await parleyResp.text();
      return jsonResponse(502, { error: `Parley returned ${parleyResp.status}`, detail: errText.slice(0, 500) });
    }
    const parleyData = await parleyResp.json();
    parleyText = parleyData?.choices?.[0]?.message?.content || "";
  } catch (err) {
    return jsonResponse(502, { error: "Could not reach Parley", detail: String(err) });
  }

  // Step 3: parse and validate in code
  let parsed;
  try {
    parsed = extractJson(parleyText);
  } catch (err) {
    return jsonResponse(502, { error: "Parley response was not usable JSON", detail: parleyText.slice(0, 500) });
  }

  const events = (Array.isArray(parsed.events) ? parsed.events : []).map((ev) => {
    const weekdayCheck = checkWeekday(ev.start, ev.weekday, ev.email_weekday);
    return { ...ev, weekday_actual: weekdayCheck.actual, weekday_ok: weekdayCheck.ok, weekday_note: weekdayCheck.note };
  });

  return jsonResponse(200, { today, events });
};
