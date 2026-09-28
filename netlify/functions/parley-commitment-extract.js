/*
  parley-commitment-extract.js
  Netlify function (POST { subject, body, emailDate, choices }).
  Asks Parley to propose values for a Commitments record from an email thread and
  returns { result: { values: {...}, flags: [...] }, raw }.

  `choices` is the map returned by qb-commitment (mode "choices"), keyed by field ID.
  Parley is told to use only those values for the multiple-choice fields.

  BEFORE DEPLOYING:
    1. The Parley call is isolated in callParley() below. It is a stub written to the same
       shape as the other stubs in this project - REPLACE its fetch block with the exact
       call used in parley-calendar-extract.js (endpoint, auth header, request and
       response shape).
    2. Env var: PARLEY_COMMITMENT_API_KEY (falls back to PARLEY_API_KEY) so usage can be
       tracked separately, like the calendar tool.
*/

const CHOICE_LABELS = {
  6: "fyStart", 12: "department", 42: "generalCategory", 13: "detailedCategory",
  31: "inOut", 26: "status", 16: "type"
};

function json(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

async function callParley(prompt) {
  // --- REPLACE this block with the call pattern from parley-calendar-extract.js ---
  const key = process.env.PARLEY_COMMITMENT_API_KEY || process.env.PARLEY_API_KEY;
  const resp = await fetch(process.env.PARLEY_ENDPOINT || "https://parley.mit.edu/api/agents/chat/bedrock", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }] })
  });
  if (!resp.ok) throw new Error("Parley returned " + resp.status);
  const data = await resp.json();
  return (data.content && data.content[0] && data.content[0].text) || data.completion || "";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  let subject, body, emailDate, choices;
  try { ({ subject, body, emailDate, choices } = JSON.parse(event.body || "{}")); }
  catch (e) { return json(400, { error: "Invalid JSON body" }); }
  if (!body || !String(body).trim()) return json(400, { error: "Email body is empty" });

  const choiceLines = Object.keys(CHOICE_LABELS).map(function (id) {
    const opts = (choices && choices[id]) || [];
    return "- " + CHOICE_LABELS[id] + " (exactly one of these, or null): " + JSON.stringify(opts);
  }).join("\n");

  const prompt = `You are helping an Assistant Dean for Finance and Administration at MIT's School of Engineering (SoE) record a funding COMMITMENT from an email thread. Propose values for a database record. Never invent anything: if the thread does not state a value, use null.

Return ONLY this JSON, with no other text:
{
  "values": {
    "name": string|null, "person": string|null, "department": string|null, "fyStart": string|null,
    "years": number|null, "dateCommitted": "YYYY-MM-DD"|null, "amount": number|null,
    "status": string|null, "type": string|null, "inOut": string|null,
    "generalCategory": string|null, "detailedCategory": string|null,
    "adminContact": string|null, "notes": string|null
  },
  "flags": [string]
}

Field rules:
- name: a short label, e.g. "SoE transition funding - Schaadt".
- person: the person the commitment is FOR, formatted "Last, First".
- amount: a number ONLY if a dollar figure for the commitment is explicitly stated; otherwise null.
- fyStart: MIT's fiscal year runs July 1 to June 30 and is named for the year it ends. Academic year AY28/29 starts July 2028, so it is FY2029. Use the fiscal year the funding STARTS in, written in whatever style the allowed options use.
- years: number of fiscal years the commitment covers, if stated or clearly implied.
- dateCommitted: the date of the message in which the commitment was approved or confirmed. If you cannot tell, use the emailDate given below.
- notes: 2-4 sentences: what was committed, conditions or contingencies, who approved it, and any follow-up or reassessment terms.
- adminContact: only if a staff contact for administering it is named.
- Choice fields must be EXACTLY one of the allowed options below, or null if none clearly fits:
${choiceLines}

Extract only the School of Engineering commitment. If the thread also mentions funding from other units (for example a department or a fellowship), do not record it; mention it in flags.
Use flags for anything the person should double-check: conflicting dates or years across messages (prefer the latest confirmed one and say so), ambiguity, or key items that were missing. Keep each flag to one sentence.

emailDate of the message currently open: ${emailDate || "unknown"}
Subject: ${subject || ""}

EMAIL THREAD:
"""
${String(body).slice(0, 30000)}
"""`;

  try {
    const raw = await callParley(prompt);
    let parsed = null;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) { /* fall through with parsed = null */ }
    return json(200, { result: parsed, raw: parsed ? undefined : raw });
  } catch (err) {
    console.error("parley-commitment-extract failed:", err);
    return json(500, { error: String(err.message || err) });
  }
};
