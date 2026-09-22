// netlify/functions/parley-waiver-check.js
//
// Proxy between the Outlook add-in and MIT Parley.
// Classifies request type(s) and runs the matching checklist(s):
//   - "waiver"       : Proposal Waiver Request (7 presence checks)
//   - "one_time_pi"  : One-time PI/Co-PI status request (14 packet elements + facts)
// An email may contain one or both. PARLEY_API_KEY stays server-side.

const PARLEY_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";

const RUBRIC = `You are a pre-check assistant for MIT School of Engineering (SoE) research-administration submissions. Two kinds of request can arrive, sometimes both in the same email:
  A) "waiver" - a Proposal Waiver Request (to submit a proposal after the RAS 5-business-day review deadline).
  B) "one_time_pi" - a request for one-time PI/Co-PI status for someone who does not have automatic PI status.

Your job: (1) identify which request type(s) the email contains, and (2) for each type present, check whether required elements are present and extract a few specific facts. You do NOT approve, deny, or judge the merits of anything. You do NOT decide whether any value is acceptable - only report what is stated.

First decide request_types: an array containing "waiver", "one_time_pi", or both.

IMPORTANT about the RAS contact: "RAS" means MIT Research Administration Services - the central office whose Contract Administrator will REVIEW the proposal. The RAS contact is that RAS-side reviewer. It is NOT the person sending or preparing the request, and NOT the DLC's own departmental research administrator, even if that person's title contains words like "Research Administration". Do not infer the RAS contact from a job title in the sender's signature. Only report a RAS contact if the submitter actually names the RAS-side reviewer; capture that name in ras_contact.value. If only the DLC preparer/sender is present, ras_contact is absent.

For a WAIVER, check these 7 required items (presence only):
  principal_investigator, project_title, sponsor_name, dlc, due_date (present AND a plausible calendar date), ras_contact (per the note above), late_reason (ANY stated reason counts; do NOT judge quality).

For ONE_TIME_PI, check these required packet elements (presence only). ALL are required EXCEPT abstract, which is optional and must NEVER affect completeness:
  researcher_name, endorsement, reason_needed, career_trajectory, mentoring_plan (present or absent only), prior_history (states number of previous PI-status requests and how many awarded), proposal_title, sponsor, budget (shows proposed effort and scope), salary_support, due_date, abstract (OPTIONAL), oversight_individual (faculty/SRS/PRS), research_landscape.

Also extract these ONE_TIME_PI facts (report what is stated; null/empty if not stated - NEVER guess):
  proposed_pi, dlc, sponsor, working_with_pi, proposal_period, salary_support, effort_percent (NUMBER or null), prior_requests (NUMBER or null), prior_awarded (NUMBER or null).

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
    "items": {
      "researcher_name": {"present": true, "note": ""},
      "endorsement": {"present": true, "note": ""},
      "reason_needed": {"present": true, "note": ""},
      "career_trajectory": {"present": true, "note": ""},
      "mentoring_plan": {"present": true, "note": ""},
      "prior_history": {"present": true, "note": ""},
      "proposal_title": {"present": true, "note": ""},
      "sponsor": {"present": true, "note": ""},
      "budget": {"present": true, "note": ""},
      "salary_support": {"present": true, "note": ""},
      "due_date": {"present": true, "note": ""},
      "abstract": {"present": false, "note": ""},
      "oversight_individual": {"present": true, "note": ""},
      "research_landscape": {"present": true, "note": ""}
    },
    "facts": {
      "proposed_pi": "", "dlc": "", "sponsor": "", "working_with_pi": "",
      "proposal_period": "", "salary_support": "",
      "effort_percent": null, "prior_requests": null, "prior_awarded": null
    },
    "all_required_present": true,
    "overall": "complete",
    "missing_summary": ""
  }
}

Rules:
- If a request type is not present, set its whole value to null.
- ras_contact.value = the RAS-side reviewer's name if the submitter named one, else empty string.
- one_time_pi.all_required_present = every required element present; abstract does NOT count.
- Presence only. Do NOT judge merits. Do NOT compute effort caps; just report effort_percent as a number if stated.
- NEVER invent a name, number, or fact. Use null/empty when not stated.
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

    // Robustness: if the model wrapped the JSON in commentary, extract the object itself.
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
