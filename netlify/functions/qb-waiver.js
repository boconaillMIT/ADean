// netlify/functions/qb-waiver.js
//
// QuickBase bridge for the waiver 3-per-fiscal-year rule.
//   mode "count": how many waivers this PI (by Kerberos) already has in the current FY.
//   mode "log":   create a new waiver row (dedup on KC Proposal Number).
// QB_TOKEN lives in the Netlify environment, never client-side.
//
// Deploy: netlify/functions/qb-waiver.js   Env var: QB_TOKEN (a QuickBase user token
// scoped to app bssjvdn99).

const QB_REALM = "mit.quickbase.com"; 
const QB_TABLE = "bsskgh8yi";
const QB_API = "https://api.quickbase.com/v1";

// Field IDs (from the table's field list)
const F = {
  DATE_CREATED: 1, RECORD_ID: 3,
  FISCAL_YEAR: 6, PI: 7, DLC: 8, DEPT_ENDORSEMENT: 9, SPONSOR: 10,
  PROPOSAL_TITLE: 11, DATE_OF_REQUEST: 12, SPONSOR_DEADLINE: 13,
  DECISION_DATE: 14, DECISION: 15, REASON: 16, PRIME_SPONSOR: 17,
  RAS: 28, KC_NUMBER: 29, ANTICIPATED_RAS: 31, KERBEROS: 33,
};

function currentFY() {
  // FY runs Jul 1 - Jun 30; label = the calendar year it ENDS in (Sep 2026 -> "2027").
  const now = new Date();
  return String(now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function qesc(v) { return String(v).replace(/'/g, ""); } // QB where-literals: drop quotes defensively

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Use POST" }) };

  const token = process.env.QB_TOKEN;
  if (!token) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "QB_TOKEN is not set in the Netlify environment." }) };

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) }; }

  const headers = {
    "QB-Realm-Hostname": QB_REALM,
    Authorization: "QB-USER-TOKEN " + token,
    "Content-Type": "application/json",
  };
  const fy = input.fy || currentFY();
  const ok = (obj) => ({ statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const fail = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });

  try {
    // ---------- COUNT ----------
    if (input.mode === "count") {
      const kerb = (input.kerberos || "").trim();
      if (!kerb) return fail(400, { error: "kerberos required" });
      // Only APPROVED waivers count toward the 3-per-FY limit (denied ones do not).
      const where = "{" + F.KERBEROS + ".EX.'" + qesc(kerb) + "'}AND{" + F.FISCAL_YEAR + ".EX.'" + qesc(fy) + "'}AND{" + F.DECISION + ".EX.'Approved'}";
      const r = await fetch(QB_API + "/records/query", {
        method: "POST", headers,
        body: JSON.stringify({ from: QB_TABLE, select: [F.RECORD_ID, F.KC_NUMBER, F.PROPOSAL_TITLE, F.DECISION], where }),
      });
      const d = await r.json();
      if (!r.ok) return fail(502, { error: "QuickBase query failed", detail: d });
      const rows = (d.data || []).map((row) => ({
        kc: row[F.KC_NUMBER] && row[F.KC_NUMBER].value,
        title: row[F.PROPOSAL_TITLE] && row[F.PROPOSAL_TITLE].value,
        decision: row[F.DECISION] && row[F.DECISION].value,
      }));
      return ok({ count: rows.length, fy, rows });
    }

    // ---------- LOG ----------
    if (input.mode === "log") {
      const kerb = (input.kerberos || "").trim();
      const v = input.values || {};
      if (!kerb) return fail(400, { error: "kerberos required" });

      // Dedup on KC Proposal Number
      if (v.kc_number !== undefined && v.kc_number !== null && String(v.kc_number) !== "") {
        const dupWhere = "{" + F.KC_NUMBER + ".EX.'" + qesc(v.kc_number) + "'}";
        const dr = await fetch(QB_API + "/records/query", {
          method: "POST", headers,
          body: JSON.stringify({ from: QB_TABLE, select: [F.RECORD_ID], where: dupWhere }),
        });
        const dd = await dr.json();
        if (dr.ok && (dd.data || []).length > 0) {
          return ok({ logged: false, duplicate: true, message: "KC# " + v.kc_number + " is already logged in QuickBase." });
        }
      }

      const rec = {};
      const put = (fid, val) => { if (val !== undefined && val !== null && String(val) !== "") rec[fid] = { value: val }; };
      put(F.KERBEROS, kerb);
      put(F.FISCAL_YEAR, fy);
      put(F.KC_NUMBER, v.kc_number);
      put(F.PI, v.pi);
      put(F.DLC, v.dlc);
      put(F.SPONSOR, v.sponsor);
      put(F.PRIME_SPONSOR, v.prime_sponsor);
      put(F.PROPOSAL_TITLE, v.proposal_title);
      put(F.RAS, v.ras);
      put(F.REASON, v.reason_text);
      put(F.SPONSOR_DEADLINE, v.sponsor_deadline);
      put(F.DATE_OF_REQUEST, v.date_of_request || todayISO());
      put(F.DECISION, "Approved");
      put(F.DECISION_DATE, todayISO());

      const cr = await fetch(QB_API + "/records", {
        method: "POST", headers,
        body: JSON.stringify({ to: QB_TABLE, data: [rec] }),
      });
      const cd = await cr.json();
      if (!cr.ok) return fail(502, { error: "QuickBase create failed", detail: cd });
      const id = cd.metadata && cd.metadata.createdRecordIds && cd.metadata.createdRecordIds[0];
      return ok({ logged: true, recordId: id, message: "Waiver logged to QuickBase (record " + id + ")." });
    }

    return fail(400, { error: "Unknown mode; use 'count' or 'log'." });
  } catch (e) {
    return fail(500, { error: String(e) });
  }
};
