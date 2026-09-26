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

Also extract these WAIVER values for logging (stated only; null/empty if not stated; NEVER guess): kc_number (KC or proposal number as a NUMBER if present), pi (PI name), dlc, sponsor, prime_sponsor, proposal_title, sponsor_deadline (the proposal due date / sponsor deadline, normalized to YYYY-MM-DD if determinable), reason_text (the stated reason the proposal is late), kerberos (the PI's Kerberos / MIT username ONLY if explicitly stated - e.g. "Kerberos: eliz", "MIT ID: eliz", or an @mit.edu address whose local part is clearly the PI's username - else "").

For ONE_TIME_PI, FIRST infer requester_type from context (there is NO explicit flag - infer from cues; when cues are absent or ambiguous, DEFAULT to "standard", the strictest):
  - "incoming_faculty": the researcher is NOT yet at MIT but has an incoming/visiting faculty appointment and work authorization (cues: "visiting appointment", "not yet at MIT", "will join", "incoming faculty", "starting <date>").
  - "emeritus": a senior faculty member who no longer holds AUTOMATIC PI status - this includes emeritus, retired, post-retirement, AND post-tenure faculty. At MIT the appointment label for such a professor is often "Post-Tenure" (also written "Post Tenure"). Cues: "emeritus", "retired", "post-retirement", "post-tenure", "post tenure", or any indication the person is a current/former tenured or senior professor (e.g. "Prof.", "Professor", a chaired/named professorship) seeking PI status for a specific proposal rather than a junior/developing researcher building a career. When the request is plainly for an established professor and shows no career-development plan, treat it as "emeritus", NOT "standard".
  - "standard": everyone else (a developing researcher seeking PI status for career growth).
requester_type MUST be exactly one of these three literal strings: "standard", "incoming_faculty", or "emeritus". Post-tenure, retired, and post-retirement faculty ALL map to "emeritus" - do NOT invent a "post_tenure" or other value. Report requester_type and requester_type_basis (a short phrase naming the cue, or "no special cues; treated as standard").

Then report presence {present, note} for the elements relevant to the inferred type:
  - standard: researcher_name, endorsement, reason_needed, career_trajectory, mentor_relationship (evidence that a mentor/mentee relationship exists - an identified mentor/advisor for the researcher; the FULL mentoring plan is NOT required at submission, only that the relationship is established), proposal_title, sponsor, budget, salary_support, due_date, abstract (OPTIONAL), oversight_individual, research_landscape.
  - incoming_faculty: researcher_name, proposal_title, sponsor, due_date, visiting_appointment (confirmation of the incoming/visiting appointment), work_authorization (confirmation of work authorization).
  - emeritus: researcher_name, proposal_title, sponsor, due_date, emeritus_confirmation (confirmation of emeritus, retired, or post-tenure status - the stated appointment status counts as this confirmation).
Do NOT compute completeness - the application does that.

Extract these facts (stated only; null/empty if not stated; NEVER guess):
  proposed_pi, dlc, sponsor, proposal_title, working_with_pi, proposal_period,
  salary_support (the salary support the proposed PI/Co-PI would receive from THIS proposal, e.g. "3 months per year" or "2 summer months"; this is NOT the total budget or the amount to MIT; "" if not stated),
  effort_percent (the proposed PI's effort as a NUMBER, ONLY if a percentage or person-months figure is EXPLICITLY stated in the request or budget; do NOT infer or estimate it from the award mechanism or from general knowledge - if the budget gives only dollars and no effort figure, effort_percent MUST be null), prior_requests (NUMBER or null), prior_awarded (NUMBER or null),
  proposal_start_date (the proposal's project start date, normalized to YYYY-MM-DD if determinable, else ""),
  faculty_start_date (the researcher's official MIT faculty start date, normalized to YYYY-MM-DD if determinable, else ""),
  status_label (for the emeritus/incoming types, the researcher's stated status term such as "post-tenure", "emeritus", "retired", or "incoming faculty"; "" for standard),
  reason_summary (one concise sentence stating why PI status is warranted or the researcher's role/expertise on the project, drawn from the request; "" if not stated).
  salary_percent (the salary-coverage or Level-of-Effort percentage as a NUMBER, ONLY if a percentage is explicitly stated - e.g. "75% LOE" or "covers 75% of salary" gives 75; null if salary support is not expressed as a percentage).
  cap_exception_reason (if the request acknowledges that salary coverage or effort EXCEEDS the usual 25% limit and gives a justification for the exception, capture that justification here, e.g. "the funding continues the researcher's existing Gates Foundation effort"; otherwise "").
  is_postdoc (true if the text anywhere indicates the researcher is or has been a postdoc / postdoctoral associate / postdoctoral fellow - e.g. "has been a postdoc", "postdoctoral" - otherwise false; check the career-trajectory and reason text carefully, this is often stated there).
  call_postdoc_note (if the proposal names a funding mechanism that is specifically a POSTDOCTORAL career-transition / mentored award - e.g. NIH K99/R00, NIH F32 or other F-series, NIH K-series career awards, NSF postdoctoral fellowship - OR the text says the call requires a postdoc, name that mechanism briefly here, e.g. "NIH K99/R00 (postdoc career-transition award)"; otherwise "". ALWAYS set this whenever "K99", "R00", "K99/R00", an NIH F- or K-series award, or a named postdoctoral fellowship appears anywhere in the request.
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
    "values": {
      "kc_number": null, "pi": "", "dlc": "", "sponsor": "", "prime_sponsor": "",
      "proposal_title": "", "sponsor_deadline": "", "reason_text": "", "kerberos": ""
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
      "proposed_pi": "", "dlc": "", "sponsor": "", "proposal_title": "", "working_with_pi": "",
      "proposal_period": "", "salary_support": "",
      "effort_percent": null, "prior_requests": null, "prior_awarded": null,
      "proposal_start_date": "", "faculty_start_date": "",
      "status_label": "", "reason_summary": "", "salary_percent": null, "cap_exception_reason": "", "is_postdoc": false, "call_postdoc_note": ""
    }
  }
}

Rules:
- If a request type is not present, set its whole value to null.
- ras_contact.value = the RAS-side reviewer's name if the submitter named one, else "".
- Presence only. Do NOT judge merits. Do NOT compute effort caps or date gaps; just report numbers and normalized dates.
- NEVER invent a name, number, or date. Use null/"" when not stated.
- The "note" field on any item is ONLY for a brief, neutral clarification when that element is MISSING or ambiguous. NEVER put merit, eligibility, or policy judgments in a note (for example, do NOT write "above the 25% limit", "exceeds the cap", "may not qualify", "significant salary source"). Those determinations are made downstream in code, not by you. Leave notes empty for elements that are clearly present.
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
