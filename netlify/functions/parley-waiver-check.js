// netlify/functions/parley-waiver-check.js
//  
// Proxy between the Outlook "Waiver Pre-Check" add-in and MIT Parley.
// The add-in POSTs { subject, body }; this function calls Parley with the
// waiver rubric and returns the structured result. The PARLEY_API_KEY stays
// here (Netlify environment), never in the client-side add-in.
//
// Deploy: place at  netlify/functions/parley-waiver-check.js
// Env var (Netlify > Site settings > Environment variables):  PARLEY_API_KEY

const PARLEY_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";

// The 7-field presence rubric (RAS contact enforced; justification presence-only).
const RUBRIC = `You are a pre-check assistant for MIT School of Engineering Proposal Waiver Requests submitted to the SOE-research list. A waiver lets a DLC submit a proposal after the standard RAS 5-working-day review deadline has passed. Your ONLY job is to check whether a submission contains the required information, so staff don't spend time chasing incomplete requests. You do NOT approve or deny waivers — RAS does that.

Evaluate the submission below against these required items:
1. principal_investigator — name of the PI is present
2. project_title — title of the project is present
3. sponsor_name — sponsor is named
4. dlc — the DLC (department/lab/center) is named
5. due_date — an actual proposal due date is present AND is a plausible calendar date
6. ras_contact — a RAS contact person is named
7. late_reason — some explanation of why the proposal is late is present (ANY explanation counts; do NOT judge its quality or sufficiency)

Return ONLY valid JSON, no preamble:
{
  "items": {
    "principal_investigator": {"present": true/false, "note": "brief note if missing/unclear, else empty"},
    "project_title": {"present": true/false, "note": ""},
    "sponsor_name": {"present": true/false, "note": ""},
    "dlc": {"present": true/false, "note": ""},
    "due_date": {"present": true/false, "value_found": "the date as written, or empty", "note": ""},
    "ras_contact": {"present": true/false, "note": ""},
    "late_reason": {"present": true/false, "bad_faith": true/false, "note": "set bad_faith true ONLY if the reason explicitly dismisses the process (e.g. 'RAS time doesn't matter'); otherwise false"}
  },
  "all_required_present": true/false,
  "overall": "complete" | "incomplete",
  "missing_summary": "one plain sentence listing what's missing, for the reply; empty if complete"
}

Rules:
- Judge only what's in the submission. Do not infer a field that isn't there.
- For late_reason, presence is all that matters — any stated reason counts, however brief. Do NOT assess quality.
- Do not compute how many days until the due date; that is handled separately.
- No commentary outside the JSON.

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

  // Preflight (only relevant if the add-in is hosted on a different origin;
  // if it's on the same Netlify site there's no preflight at all).
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Use POST" }) };
  }

  const apiKey = process.env.PARLEY_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: "PARLEY_API_KEY is not set in the Netlify environment." }),
    };
  }

  let subject = "";
  let body = "";
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
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: "Parley returned an error", status: resp.status, detail: text }),
      };
    }

    const data = JSON.parse(text);
    let content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    // Strip any code fences the model may add, then try to parse the JSON.
    content = content.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      /* leave parsed null; the raw text is still returned for inspection */
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ result: parsed, raw: content }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e) }) };
  }
};
