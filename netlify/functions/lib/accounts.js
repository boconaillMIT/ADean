// Field IDs verified against SoE Finance / Accounts on 2026-10-16.
const REALM = 'mit.quickbase.com';
const TABLE = 'br2xvsvpw';
const FIELDS = {
  fundNumber: { id: 7, label: 'Cost Object / fund number', required: true },
  name: { id: 8, label: 'Cost Object Name', required: true },
  fundCenter: { id: 6, label: 'Fund Center', choice: true },
  poolCode: { id: 9, label: 'Pool Code', choice: true },
  adminFlag: { id: 11, label: 'Admin Flag', choice: true },
  description: { id: 20, label: 'Fund Description', multiline: true },
  restriction: { id: 21, label: 'Fund Restriction', multiline: true },
  notes: { id: 22, label: 'Notes', multiline: true },
  stewardship: { id: 41, label: 'Stewardship', choice: true },
  stewardshipNote: { id: 42, label: 'Stewardship Note', multiline: true }
};
function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) };
}
async function qb(path, payload) {
  const token = process.env.QB_FINANCE_TOKEN;
  if (!token) throw new Error('Set QB_FINANCE_TOKEN in Netlify to a token with access to the Accounts table.');
  const response = await fetch('https://api.quickbase.com/v1/' + path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'QB-Realm-Hostname': REALM, Authorization: 'QB-USER-TOKEN ' + token, 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Quickbase request failed (' + response.status + '). Check the token, permissions, and table fields.');
  return response.json();
}
async function schema() {
  const live = await qb('fields?tableId=' + TABLE);
  return Object.entries(FIELDS).map(([key, field]) => {
    const actual = live.find(f => f.id === field.id);
    if (!actual || actual.properties?.formula || actual.properties?.summaryFunction) throw new Error('Accounts field configuration has changed: ' + field.label);
    return { key, ...field, choices: field.choice ? actual.properties?.choices || [] : undefined };
  });
}
function clean(values, fields, requireIdentity = true) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Values must be an object.');
  const result = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') throw new Error(field.label + ' must be text.');
    const value = (raw || '').trim();
    if (!value) {
      if (requireIdentity && field.required) throw new Error(field.label + ' is required.');
      continue;
    }
    if (value.length > (field.multiline ? 60000 : 1000)) throw new Error(field.label + ' is too long.');
    if (field.key === 'fundNumber' && !/^\d{7}$/.test(value)) throw new Error('Enter a seven-digit MIT fund number.');
    if (field.choice && !field.choices.includes(value)) throw new Error('Choose an allowed value for ' + field.label + '.');
    result[field.key] = value;
  }
  return result;
}
function parseNotice(text) {
  const matches = [...String(text).replace(/\s+/g, ' ').matchAll(/\bFund\s+(\d{7})\s*,\s*(.+?)\s+has\s+been\b/gi)];
  const numbers = new Set(matches.map(m => m[1]));
  const flags = [];
  if (numbers.size > 1) return { values: {}, flags: ['Several funds appear in this thread. Select the intended fund manually.'] };
  const values = matches.length ? { fundNumber: matches[0][1], name: matches[0][2].trim() } : {};
  if (/created[\s\S]{0,80}\bOR\b[\s\S]{0,80}updated/i.test(text)) flags.push('The notice says created OR updated; it does not establish which occurred.');
  if (!matches.length) flags.push('No standard fund notice was found. Verify the fund number and name.');
  return { values, flags };
}
module.exports = { REALM, TABLE, FIELDS, json, qb, schema, clean, parseNotice };
