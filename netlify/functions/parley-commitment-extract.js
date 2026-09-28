/*
  parley-commitment-extract.js
  Netlify function (POST { subject, body, emailDate, choices }).
  Asks Parley to propose values for a Commitments record from an email thread and
  returns { result: { values: {...}, flags: [...] }, raw }.

  `choices` is the map returned by qb-commitment (mode "choices"), keyed by field ID.
  Parley is told to use only those values for the multiple-choice fields.

  PARLEY: uses the same endpoint, model and request/response shape as parley-waiver-check.js.

  BEFORE DEPLOYING:
    Set PARLEY_COMMITMENT_API_KEY in Netlify env vars (a key created for this tool, so its
    usage is tracked separately). There is deliberately no fallback to PARLEY_API_KEY.
    Environment variables only take effect on a new deploy.
*/

const CHOICE_LABELS = {
  6: "fyStart", 12: "department", 42: "generalCategory", 13: "detailedCategory",
  31: "inOut", 26: "status", 16: "type"
};

function json(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

const PARLEY_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";

async function callParley(prompt) {
  // Own key so this tool's Parley usage is tracked separately (same approach as the calendar tool).
  // No fallback to PARLEY_API_KEY on purpose: a silent fallback would mix the usage again.
  const apiKey = process.env.PARLEY_COMMITMENT_API_KEY;
  if (!apiKey) throw new Error("PARLEY_COMMITMENT_API_KEY is not set in Netlify environment variables");

  const resp = await fetch(PARLEY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, temperature: 0, messages: [{ role: "user", content: prompt }] })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error("Parley returned " + resp.status + ": " + text.slice(0, 300));
  const data = JSON.parse(text);
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

const KEY_TO_ID = {};
Object.keys(CHOICE_LABELS).forEach(function (id) { KEY_TO_ID[CHOICE_LABELS[id]] = Number(id); });

function fiscalYearOf(emailDate) {
  // MIT fiscal year: Jul 1 - Jun 30, named for the year it ends.
  let y, m;
  const mt = /^(\d{4})-(\d{2})/.exec(emailDate || "");
  if (mt) { y = Number(mt[1]); m = Number(mt[2]); }
  else { const n = new Date(); y = n.getFullYear(); m = n.getMonth() + 1; }
  return m >= 7 ? y + 1 : y;
}

function matchFY(options, fy) {
  const yyyy = String(fy), yy = yyyy.slice(-2);
  let hit = options.find(function (o) { const d = String(o).replace(/\D/g, ""); return d === yyyy || d === yy; });
  if (hit) return hit;
  const re = new RegExp("(^|\\D)(20)?" + yy + "($|\\D)");
  return options.find(function (o) { return re.test(String(o)); }) || null;
}

// Deterministic defaults and clean-up. The model proposes; the code fills the gaps it can decide by rule.
function applyDefaults(values, choices, emailDate) {
  const flags = [];
  const opts = function (id) { return (choices && choices[id]) || []; };

  // Snap any choice value to the exact allowed spelling (case-insensitive); drop it if it isn't allowed.
  Object.keys(KEY_TO_ID).forEach(function (k) {
    const v = values[k];
    if (v === null || v === undefined || v === "") return;
    const list = opts(KEY_TO_ID[k]);
    if (!list.length) return;
    const hit = list.find(function (o) { return String(o).trim().toLowerCase() === String(v).trim().toLowerCase(); });
    values[k] = hit || null;
  });

  if (!values.status) {
    const c = opts(26).find(function (o) { return /^active$/i.test(String(o).trim()); });
    if (c) { values.status = c; flags.push("Status defaulted to " + c + "."); }
  }
  if (!values.fyStart) {
    const fy = fiscalYearOf(emailDate);
    const c = matchFY(opts(6), fy);
    if (c) { values.fyStart = c; flags.push("Start year defaulted to the current fiscal year (" + c + ") - the email did not give one."); }
  }
  if (Number(values.years) > 1) {
    const c = opts(16).find(function (o) { return /^multi[\s-]?year$/i.test(String(o).trim()); });
    if (c && values.type !== c) { values.type = c; flags.push("Type set to " + c + " because it spans " + values.years + " years."); }
  }
  return flags;
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
- name: a short label that includes what it is for and the account if one is named, e.g. "B1 new roof - Cabot account" or "SoE transition funding - Schaadt". There is no separate account field, so always put a named account in the name and in notes.
- person: the person the commitment is FOR, formatted "Last, First". Use null if it is for a project, building or purchase rather than a person.
- amount: a number ONLY if a dollar figure is explicitly stated. Convert shorthand: "$3M" = 3000000, "$250K" = 250000, "$1.5M" = 1500000. Otherwise null.
- years: number of fiscal years the commitment covers, e.g. "spread over 5 yrs" = 5.
- fyStart: if the email states a start year, use it (MIT's fiscal year runs July 1 to June 30 and is named for the year it ends; AY28/29 starts July 2028, so it is FY2029). If none is stated use null - the system fills in the current fiscal year.
- status: if not stated use "Active".
- type: choose from the allowed options. Use the "Multi Year" option when the commitment spans more than one fiscal year, the "Recurring Expense" option when it repeats indefinitely, and the "One Time" option for a single payment.
- inOut: decide whether SoE is committing to PAY money out or is RECEIVING money in, and choose the allowed option that means that. Spending on a roof, a salary or a purchase is outgoing.
- department: make your best guess, from the allowed options, at the department or unit the commitment benefits or is charged to. If it is only a guess, say so in flags.
- generalCategory and detailedCategory: infer both from the purpose (for example a roof replacement is a facilities/building item) and choose the best-fitting allowed option for each. The detailed category must be consistent with the general one. Use null only if nothing plausibly fits. If either is a guess, say so in flags.
- dateCommitted: the date of the message in which the commitment was approved or confirmed. If you cannot tell, use the emailDate given below.
- notes: 2-4 sentences: what was committed, the purpose, the account, conditions or contingencies, who approved it, and any follow-up or reassessment terms.
- adminContact: only if a staff contact for administering it is named.
- Choice fields must be EXACTLY one of the allowed options below, or null if none fits:
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
      let cleaned = raw.replace(/```json|```/g, "").trim();
      const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
      if (a !== -1 && b > a) cleaned = cleaned.slice(a, b + 1);
      parsed = JSON.parse(cleaned);
    } catch (e) { /* fall through with parsed = null */ }
    if (parsed && parsed.values) {
      const extra = applyDefaults(parsed.values, choices, emailDate);
      parsed.flags = (parsed.flags || []).concat(extra);
    }
    return json(200, { result: parsed, raw: parsed ? undefined : raw });
  } catch (err) {
    console.error("parley-commitment-extract failed:", err);
    return json(500, { error: String(err.message || err) });
  }
};
