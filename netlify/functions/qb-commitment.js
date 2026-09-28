/*
  qb-commitment.js
  Netlify function (POST) for the Commitments table (br2xvzd7a).

    { mode: "choices" }
        -> { choices: { "<fieldId>": [allowed values] } } for the multiple-choice fields,
           so the pane can fill dropdowns and Parley can be held to real values.

    { mode: "create", values: {...}, force?: true, attachment?: { fileName, data(base64) } }
        -> creates one Commitment record. Unless force is true, first checks for an
           existing record with the same person + commitment name and, if found,
           returns { duplicate: true, recordId } instead of creating another. Only the name is required (a commitment can be for a project, not a person).

  TOKEN: this table's ID starts with "br" (the Waiver/PI Status tables start with "bss"),
  so it is probably in a different QuickBase app. Set QB_COMMITMENTS_TOKEN in Netlify env
  (a user token with access to that app). If it is not set, this falls back to QB_TOKEN,
  which only works if that token also covers this app.
*/

const REALM = "mit.quickbase.com";
const TABLE_ID = "br2xvzd7a";

const F = {
  fyStart: 6, years: 30, dateCommitted: 10, amount: 11, person: 28,
  department: 12, generalCategory: 42, detailedCategory: 13, name: 14,
  inOut: 31, adminContact: 29, status: 26, type: 16, notes: 18
};
const ATTACHMENT_FIELD = 25;   // "Attachment" (file field) - holds the .eml of the source email
const CHOICE_IDS = [F.fyStart, F.department, F.generalCategory, F.detailedCategory, F.inOut, F.status, F.type];

function qbHeaders() {
  return {
    "QB-Realm-Hostname": REALM,
    "Authorization": "QB-USER-TOKEN " + (process.env.QB_COMMITMENTS_TOKEN || process.env.QB_TOKEN),
    "Content-Type": "application/json"
  };
}
function json(status, obj) { return { statusCode: status, body: JSON.stringify(obj) }; }

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON body" }); }

  try {
    if (body.mode === "choices") return await getChoices();
    if (body.mode === "create") return await createCommitment(body.values || {}, !!body.force, body.attachment || null);
    return json(400, { error: "mode must be 'choices' or 'create'" });
  } catch (err) {
    console.error("qb-commitment failed:", err);
    return json(500, { error: String(err.message || err) });
  }
};

async function getChoices() {
  const r = await fetch("https://api.quickbase.com/v1/fields?tableId=" + TABLE_ID, { headers: qbHeaders() });
  if (!r.ok) throw new Error("QuickBase fields " + r.status + ": " + (await r.text()));
  const fields = await r.json();
  const choices = {};
  fields.forEach(function (f) {
    if (CHOICE_IDS.indexOf(f.id) >= 0) choices[f.id] = (f.properties && f.properties.choices) || [];
  });
  return json(200, { choices: choices });
}

async function createCommitment(values, force, attachment) {
  const rec = {};
  Object.keys(F).forEach(function (k) {
    let v = values[k];
    if (v === null || v === undefined || String(v).trim() === "") return;
    if (k === "years" || k === "amount") {
      const n = Number(String(v).replace(/[$,]/g, ""));
      if (isNaN(n)) return;
      v = n;
    } else {
      v = String(v).trim();
    }
    rec[F[k]] = { value: v };
  });

  if (!rec[F.name]) {
    return json(400, { error: "Commitment name is required." });
  }

  // Optional file for the Attachment field: { fileName, data } with data as base64.
  if (attachment && attachment.fileName && attachment.data) {
    rec[ATTACHMENT_FIELD] = { value: { fileName: String(attachment.fileName), data: String(attachment.data) } };
  }

  if (!force) {
    const esc = function (s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); };
    const q = await fetch("https://api.quickbase.com/v1/records/query", {
      method: "POST",
      headers: qbHeaders(),
      body: JSON.stringify({
        from: TABLE_ID,
        select: [3],
        where: (rec[F.person] ? "{" + F.person + ".EX.'" + esc(rec[F.person].value) + "'}AND" : "") +
               "{" + F.name + ".EX.'" + esc(rec[F.name].value) + "'}"
      })
    });
    if (q.ok) {
      const d = await q.json();
      if ((d.data || []).length) {
        const id = d.data[0]["3"].value;
        return json(200, { duplicate: true, recordId: id, url: "https://" + REALM + "/db/" + TABLE_ID + "?a=dr&rid=" + id });
      }
    }
  }

  const r = await fetch("https://api.quickbase.com/v1/records", {
    method: "POST",
    headers: qbHeaders(),
    body: JSON.stringify({ to: TABLE_ID, data: [rec], fieldsToReturn: [3] })
  });
  const text = await r.text();
  if (!r.ok) throw new Error("QuickBase " + r.status + ": " + text);
  const d = JSON.parse(text);
  const lineErrors = d.metadata && d.metadata.lineErrors;
  if (lineErrors && Object.keys(lineErrors).length) {
    throw new Error("QuickBase rejected the record: " + JSON.stringify(lineErrors));
  }
  const id = (d.metadata && d.metadata.createdRecordIds && d.metadata.createdRecordIds[0]) ||
             (d.data && d.data[0] && d.data[0]["3"] && d.data[0]["3"].value);
  return json(200, { created: true, recordId: id, url: "https://" + REALM + "/db/" + TABLE_ID + "?a=dr&rid=" + id });
}
