// netlify/functions/parley-waiver-check.js
//
// Proxy between the Outlook add-in and MIT Parley.
// Classifies request type(s) and runs the matching checklist(s):
//   - "waiver"       : Proposal Waiver Request (7 presence checks)
//   - "one_time_pi"  : One-time PI/Co-PI status request. Requester-type aware:
//                      standard | incoming_faculty | emeritus (inferred, no flag).
// An email may contain one or both. PARLEY_API_KEY stays server-side.

const PARLEY_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";

const RUBRIC = `You are a pre-check assistant for MIT School of Engineering (SoE) research-administration submissions. Two kinds of request can arrive, sometimes both in the same email:
  A) "waiver" - a Proposal Waiver Request (to submit a proposal after the RAS 5-business-day review deadline).
  B) "one_time_pi" - a request for one-time PI/Co-PI status for someone who does not have automatic PI status.

Your job: (1) identify which request type(s) the email contains, and (2) for each type present, report presence of the required elements and extract specific facts. You do NOT approve, deny, or judge merits. You do NOT decide whether any value is acceptable, and you do NOT compute completeness or any date interval - only report what is stated.

First decide request_types: an array containing "waiver", "one_time_pi", or both.

IMPORTANT about the RAS contact (waiver): "RAS" means MIT Research Administration Services - the central office whose Contract Administrator will REVIEW the proposal. The RAS contact is that RAS-side reviewer. It is NOT the person sending or preparing the request, and NOT the DLC's own departmental research administrator, even if that person's title contains "Research Administration". Do not infer the RAS contact from a title in the sender's signature. Only report a RAS contact if the submitter names the RAS-side reviewer; capture that name in ras_contact.value.

For a WAIVER, check these 7 required items (presence only):
  principal_investigator, project_title, sponsor_name, dlc, due_date (present AND a plausible calendar date), ras_contact (per the note above), late_reason (ANY stated reason counts; do NOT judge quality).

For ONE_TIME_PI, FIRST infer requester_type from context (there is NO explicit flag - infer from cues; when cues are absent or ambiguous, DEFAULT to "standard", the strictest):
  - "incoming_faculty": the researcher is NOT yet at MIT but has an incoming/visiting faculty appointment and work authorization (cues: "visiting appointment", "not yet at MIT", "will join", "incoming faculty", "starting <date>").
  - "emeritus": a retired, emeritus, or post-tenure faculty member who no longer holds automatic PI status (cues: "emeritus", "retired", "post-retirement", "post-tenure", "post tenure"). At MIT, "Post-Tenure" is the appointment status for retired faculty who retain a paid appointment, so treat "post-tenure" as this type.
  - "standard": everyone else (a developing researcher seeking PI status for career growth).
Report requester_type and requester_type_basis (a short phrase naming the cue, or "no special cues; treated as standard").

Then report presence {present, note} for the elements relevant to the inferred type:
  - standard: researcher_name, endorsement, reason_needed, career_trajectory, mentoring_plan, prior_history, proposal_title, sponsor, budget, salary_support, due_date, abstract (OPTIONAL), oversight_individual, research_landscape.
  - incoming_faculty: researcher_name, proposal_title, sponsor, due_date, visiting_appointment (confirmation of the incoming/visiting appointment), work_authorization (confirmation of work authorization).
  - emeritus: researcher_name, proposal_title, sponsor, due_date, emeritus_confirmation (confirmation of emeritus, retired, or post-tenure status).
Do NOT compute completeness - the application does that.

Extract these facts (stated only; null/empty if not stated; NEVER guess):
  proposed_pi, dlc, sponsor, working_with_pi, proposal_period, salary_support, effort_percent (NUMBER or null), prior_requests (NUMBER or null), prior_awarded (NUMBER or null),
  proposal_start_date (the proposal's project start date, normalized to YYYY-MM-DD if determinable, else ""),
  faculty_start_date (the researcher's official MIT faculty start date, normalized to YYYY-MM-DD if determinable, else "").
Normalize dates only; do NOT compute any interval or gap between them - the application does that.

Return ONLY valid JSON, no preamble:
{
  "request_types": ["waiver" and/or "one_time_pi"],
  "waiver": null OR {
    "items": {
      "principal_investigator": {"present": true, "note": ""},
      "project_title": {"present": true, "note": ""},
      "sponsor_name": {"present": true, "note": ""},
      "dlc": {"present": true, "note": ""},
      "due_date": {"present": true, "value_found": "", "note": ""},
      "ras_contact": {"present": true, "value": "", "note": ""},
      "late_reason": {"present": true, "bad_faith": false, "note": ""}
    },
    "all_required_present": true,
    "overall": "complete",
    "missing_summary": ""
  },
  "one_time_pi": null OR {
    "requester_type": "standard",
    "requester_type_basis": "",
    "items": {
      "researcher_name": {"present": true, "note": ""}
      // ... plus the other elements relevant to the inferred type, each {"present": bool, "note": ""};
      // for "standard" include abstract too (optional)
    },
    "facts": {
      "proposed_pi": "", "dlc": "", "sponsor": "", "working_with_pi": "",
      "proposal_period": "", "salary_support": "",
      "effort_percent": null, "prior_requests": null, "prior_awarded": null,
      "proposal_start_date": "", "faculty_start_date": ""
    }
  }
}

Rules:
- If a request type is not present, set its whole value to null.
- ras_contact.value = the RAS-side reviewer's name if the submitter named one, else "".
- Presence only. Do NOT judge merits. Do NOT compute effort caps or date gaps; just report numbers and normalized dates.
- NEVER invent a name, number, or date. Use null/"" when not stated.
- No commentary, reasoning, or explanation of any kind outside the JSON. Do NOT think out loud. Your entire response must start with { and end with } and contain nothing else.

Submission:
Subject: {{subject}}
Body:
{{body}}`;

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Use POST" }) };

  const apiKey = process.env.PARLEY_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "PARLEY_API_KEY is not set in the Netlify environment." }) };
  }

  let subject = "", body = "";
  try {
    const input = JSON.parse(event.body || "{}");
    subject = input.subject || "";
    body = input.body || "";
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const prompt = RUBRIC.replace("{{subject}}", subject).replace("{{body}}", body);

  try {
    const resp = await fetch(PARLEY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model: MODEL, max_tokens: 2500, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Parley returned an error", status: resp.status, detail: text }) };
    }

    const data = JSON.parse(text);
    let content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    content = content.replace(/```json/gi, "").replace(/```/g, "").trim();
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      content = content.slice(firstBrace, lastBrace + 1);
    }

    let parsed = null;
    try { parsed = JSON.parse(content); } catch { /* raw returned for inspection */ }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ result: parsed, raw: content }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e) }) };
  }
};
