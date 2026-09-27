/*
  qb-otpi-history.js
  Netlify function — reads prior one-time PI/Co-PI status request history
  for a given PI, keyed on Kerberos, from the QuickBase "PI Status" table.

  Table: bsskfjj57 (Sponsored Research app — same app/QB_TOKEN as Waivers)
  Realm: mit.quickbase.com

  Field IDs used:
    56 = Kerberos          (newly added — only populated going forward;
                             older rows won't have it, so counts reflect
                             Kerberos-tagged history only, same caveat as
                             the Waiver table's Kerberos rollout)
    37 = PI Status Approval (checkbox — true = approved)

  Returns: { count, approved, denied, successRate }
    - count: total prior requests found for this Kerberos
    - approved: how many had PI Status Approval = true
    - denied: count - approved (treats anything not explicitly approved
              as not-approved; adjust if a "still pending" state needs
              its own bucket once you have real data to check against)
    - successRate: approved / count, rounded to 2 decimals; null if count = 0

  BEFORE DEPLOYING:
    1. Reuses the existing QB_TOKEN Netlify env var (same app as Waivers) —
       no new token needed.
    2. This is a READ-only function — safe to call automatically (e.g. on
       blur of a Kerberos field), unlike the Waiver table's write/log step.
    3. Confirm field 37's checkbox is the right "did this succeed" signal —
       if a request can be pending/withdrawn rather than a hard yes/no,
       you may want to also read a status field to separate "denied" from
       "not yet decided" rather than lumping them together as this stands.
*/

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let kerberos;
  try {
    ({ kerberos } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!kerberos || !kerberos.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "kerberos is required" }) };
  }

  const TABLE_ID = "bsskfjj57";
  const KERBEROS_FIELD = 56;
  const APPROVAL_FIELD = 37;

  try {
    const qbResp = await fetch("https://api.quickbase.com/v1/records/query", {
      method: "POST",
      headers: {
        "QB-Realm-Hostname": "mit.quickbase.com",
        "Authorization": `QB-USER-TOKEN ${process.env.QB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: TABLE_ID,
        select: [3, KERBEROS_FIELD, APPROVAL_FIELD],
        where: `{${KERBEROS_FIELD}.EX.'${kerberos.trim()}'}`
      })
    });

    if (!qbResp.ok) {
      const errText = await qbResp.text();
      throw new Error(`QuickBase returned ${qbResp.status}: ${errText}`);
    }

    const data = await qbResp.json();
    const rows = data.data || [];
    const count = rows.length;
    const approved = rows.filter(r => r[APPROVAL_FIELD] && r[APPROVAL_FIELD].value === true).length;
    const denied = count - approved;
    const successRate = count > 0 ? Math.round((approved / count) * 100) / 100 : null;

    return {
      statusCode: 200,
      body: JSON.stringify({ count, approved, denied, successRate })
    };
  } catch (err) {
    console.error("qb-otpi-history failed:", err);
    return {
      statusCode: 200,
      body: JSON.stringify({ count: null, approved: null, denied: null, successRate: null, error: "lookup_failed" })
    };
  }
};
