// PI Status table fields confirmed from the table's field list. Never writes waivers.
const TABLE = 'bsskfjj57';
const API = 'https://api.quickbase.com/v1';
const F = { id: 3, requested: 6, effort: 7, decided: 8, endorsement: 9,
  total: 10, notes: 14, emailBody: 15, emailDate: 16, emailSubject: 17,
  mentor: 20, researcher: 22, proposal: 23, start: 25, end: 24, sponsor: 28, department: 29,
  approved: 37, request: 38, title: 41, reason: 42, first: 54, last: 53, kerberos: 56 };
const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (statusCode, body) => ({ statusCode, headers: cors, body: JSON.stringify(body) });
const text = value => typeof value === 'string' ? value.trim() : '';
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const literal = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return reply(204, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST' });
  let v;
  try { v = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'Invalid JSON body' }); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return reply(400, { error: 'Expected a request object' });
  for (const key of ['kerberos', 'researcher', 'mentor', 'emailSubject']) {
    if (!text(v[key])) return reply(400, { error: key + ' is required' });
  }
  if (!/^[a-z0-9_-]+$/i.test(text(v.kerberos))) return reply(400, { error: 'Enter a Kerberos username, not an email address' });
  if (!date(v.dateOfRequest) || !date(v.emailDate)) return reply(400, { error: 'Request and email dates must be valid YYYY-MM-DD dates' });
  if (!['pending', 'approved', 'denied'].includes(v.decision)) return reply(400, { error: 'Choose the decision explicitly' });
  if (v.decision !== 'pending' && !date(v.decisionDate)) return reply(400, { error: 'A valid decision date is required for a decided request' });
  for (const [key, max] of [['effortPercent', 100], ['totalProposalValue', Infinity]]) {
    const n = v[key];
    if (n !== '' && n !== undefined && n !== null &&
        (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max)) {
      return reply(400, { error: 'Invalid ' + key });
    }
  }
  for (const key of ['proposalStart', 'proposalEnd']) {
    if (v[key] && !date(v[key])) return reply(400, { error: 'Invalid ' + key });
  }
  const token = process.env.QB_RESEARCH_TOKEN;
  if (!token) return reply(500, { error: 'QB_RESEARCH_TOKEN is not set in the Netlify environment.' });
  const headers = { 'QB-Realm-Hostname': 'mit.quickbase.com',
    Authorization: 'QB-USER-TOKEN ' + token, 'Content-Type': 'application/json' };
  async function call(path, body) {
    const r = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok || (d.metadata && Object.keys(d.metadata.lineErrors || {}).length)) {
      throw new Error('QuickBase rejected the request. Check token access, required fields and exact multiple-choice values.');
    }
    return d;
  }
  const recordUrl = id => 'https://mit.quickbase.com/db/' + TABLE + '?a=dr&rid=' + id;
  let createdId;
  let writeAttempted = false;
  try {
    // Same researcher + source email. Never create when the duplicate check fails.
    const identity = [[F.kerberos, text(v.kerberos).toLowerCase()], [F.emailSubject, text(v.emailSubject)], [F.emailDate, v.emailDate]];
    const where = identity.map(([id, value]) => '{' + id + ".EX.'" + literal(value) + "'}").join('AND');
    const existing = await call('/records/query', { from: TABLE, select: [F.id], where });
    if (!Array.isArray(existing.data)) throw new Error('QuickBase duplicate check returned no records list.');
    if (existing.data.length) {
      const id = existing.data[0][F.id]?.value;
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('QuickBase returned an invalid duplicate record ID.');
      return reply(200, { duplicate: true, recordId: id, url: recordUrl(id),
        message: 'A PI-status record for this researcher and source email already exists. Review it before adding another.' });
    }
    // Quickbase permits new choices on this field. Never let AI text add one
    // without the reviewer confirming that exact value on this save attempt.
    let department = text(v.department);
    if (department) {
      const response = await fetch(API + '/fields/' + F.department + '?tableId=' + TABLE, { headers });
      const field = await response.json();
      if (!response.ok || !Array.isArray(field.properties?.choices) || field.properties.choices.some(c => typeof c !== 'string')) {
        throw new Error('Could not verify the existing QuickBase departments. Nothing was saved; try again.');
      }
      const choices = field.properties.choices;
      const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
      const match = choices.find(choice => normalize(choice) === normalize(department));
      if (match !== undefined) department = match;
      else if (v.confirmedDepartment !== department) {
        return reply(409, { departmentConfirmationRequired: true, department, choices,
          message: 'This department is not in the current QuickBase list. Confirm the new department or enter the correct existing department. Nothing has been saved.' });
      }
    }
    const rec = {};
    const put = (id, value) => { if (value !== '' && value !== null && value !== undefined) rec[id] = { value }; };
    put(F.kerberos, text(v.kerberos).toLowerCase());
    put(F.first, text(v.firstName)); put(F.last, text(v.lastName));
    put(F.mentor, text(v.mentor)); put(F.researcher, text(v.researcher));
    put(F.request, true); put(F.requested, v.dateOfRequest);
    put(F.title, text(v.proposalTitle)); put(F.proposal, text(v.proposalNumber));
    put(F.sponsor, text(v.sponsor)); put(F.department, department);
    put(F.start, v.proposalStart); put(F.end, v.proposalEnd);
    put(F.emailSubject, text(v.emailSubject)); put(F.emailDate, v.emailDate);
    put(F.emailBody, typeof v.emailBody === 'string' ? v.emailBody : '');
    put(F.reason, text(v.reason)); put(F.endorsement, text(v.endorsement));
    put(F.total, v.totalProposalValue);
    if (typeof v.effortPercent === 'number') put(F.effort, v.effortPercent / 100);
    put(F.notes, 'Reviewer-recorded decision: ' + v.decision + '\n' + text(v.notes));
    // No automatic approval and no decision date for a pending request.
    if (v.decision !== 'pending') {
      put(F.approved, v.decision === 'approved'); put(F.decided, v.decisionDate);
    }
    writeAttempted = true;
    const created = await call('/records', { to: TABLE, data: [rec], fieldsToReturn: [F.id] });
    createdId = created.data?.[0]?.[F.id]?.value ?? created.metadata?.createdRecordIds?.[0];
    if (!Number.isSafeInteger(createdId) || createdId <= 0) {
      throw new Error('QuickBase did not return a created record ID. Check the table before retrying.');
    }
    const verified = await call('/records/query', { from: TABLE, select: [F.id, F.kerberos], where: '{3.EX.' + createdId + '}' });
    const row = verified.data?.find(row => row[F.id]?.value === createdId);
    if (!row || row[F.kerberos]?.value !== text(v.kerberos).toLowerCase()) {
      throw new Error('The created record could not be verified. Check the table before retrying.');
    }
    return reply(200, { created: true, verified: true, recordId: createdId, url: recordUrl(createdId),
      message: 'PI-status request saved to QuickBase and verified. No email was drafted.' });
  } catch (error) {
    return reply(502, { error: createdId ? 'A record may have been created, but verification failed. Open the record before retrying.' : (writeAttempted ? error.message + ' Check QuickBase before retrying; a record may have been created.' : error.message),
      ...(createdId ? { recordId: createdId, url: recordUrl(createdId) } : {}) });
  }
};
