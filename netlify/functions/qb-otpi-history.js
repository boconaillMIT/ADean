/*
  qb-otpi-history.js
  Netlify function — reads prior one-time PI/Co-PI status request history
  for a given PI, keyed on Kerberos, from the QuickBase "PI Status" table.

  Table: bsskfjj57 (Sponsored Research app — same app/QB_RESEARCH_TOKEN as Waivers)
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
    1. Reuses the existing QB_RESEARCH_TOKEN Netlify env var (same app as Waivers) —
       no new token needed.
    2. This is a READ-only function — safe to call automatically (e.g. on
       blur of a Kerberos field), unlike the Waiver table's write/log step.
    3. Confirm field 37's checkbox is the right "did this succeed" signal —
       if a request can be pending/withdrawn rather than a hard yes/no,
       you may want to also read a status field to separate "denied" from
       "not yet decided" rather than lumping them together as this stands.
*/

const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function reply(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
function failure(statusCode, error, message) {
  return reply(statusCode, { count: null, approved: null, denied: null, successRate: null, error, message });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return reply(204, {});
  if (event.httpMethod !== "POST") return reply(405, { error: "Use POST" });
  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "Invalid JSON body" }); }
  const kerberos = typeof input?.kerberos === "string" ? input.kerberos.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]+$/.test(kerberos)) {
    return reply(400, { error: "invalid_kerberos", message: "Enter a Kerberos username (for example, jsmith), not an email address." });
  }
  const token = process.env.QB_RESEARCH_TOKEN;
  if (!token) return failure(500, "missing_token",
    "QB_RESEARCH_TOKEN is not set for this Netlify function. Set it in Netlify's production environment and redeploy.");

  try {
    const response = await fetch("https://api.quickbase.com/v1/records/query", {
      method: "POST",
      headers: { "QB-Realm-Hostname": "mit.quickbase.com", "Authorization": "QB-USER-TOKEN " + token,
        "Content-Type": "application/json" },
      body: JSON.stringify({ from: "bsskfjj57", select: [3, 56, 37], where: "{56.EX.'" + kerberos + "'}" })
    });
    if (!response.ok) {
      // Do not return or log raw upstream responses, headers or credentials.
      console.error("qb-otpi-history: QuickBase HTTP " + response.status);
      if (response.status === 401) return failure(502, "invalid_token",
        "QuickBase rejected the research user token (HTTP 401). Update QB_RESEARCH_TOKEN in Netlify and redeploy.");
      if (response.status === 403) return failure(502, "access_denied",
        "The Netlify research token cannot read the PI Status table (QuickBase HTTP 403). Check token app access and user permissions.");
      if (response.status === 429) return failure(503, "rate_limited", "QuickBase is rate-limiting requests. Try the history check again later.");
      return failure(502, "query_failed", "QuickBase history query failed (HTTP " + response.status + "). Check table bsskfjj57 and fields 56 and 37.");
    }
    const data = await response.json();
    if (!Array.isArray(data.data)) return failure(502, "invalid_response", "QuickBase returned an unexpected history response. Try again later.");
    const rows = data.data;
    const count = rows.length;
    const approved = rows.filter(row => row[37]?.value === true).length;
    return reply(200, { count, approved, denied: count - approved,
      successRate: count ? Math.round(approved / count * 100) / 100 : null });
  } catch {
    console.error("qb-otpi-history: request or response processing failed");
    return failure(502, "connection_failed", "The Netlify function could not complete the QuickBase history request. Check its function logs and try again.");
  }
};
