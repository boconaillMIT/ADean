const { REALM, TABLE, json, qb, schema, clean, insertAccount } = require('./lib/accounts');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body.' }); }
  if (!body || !['schema', 'lookup', 'create'].includes(body.mode)) return json(400, { error: 'Use schema, lookup or create mode.' });
  try {
    const fields = await schema();
    if (body.mode === 'schema') return json(200, { fields });
    let values;
    try {
      values = clean(body.values, fields, body.mode !== 'lookup');
      if (!values.fundNumber) throw new Error('Enter a seven-digit MIT fund number.');
    }
    catch (error) { return json(400, { error: error.message }); }
    // Fail closed: a failed duplicate lookup must never turn into a write.
    const found = await qb('records/query', {
      from: TABLE, select: [3, 7, 8], where: "{7.EX.'" + values.fundNumber + "'}", options: { top: 2 }
    });
    if (!Array.isArray(found.data)) throw new Error('Quickbase returned an invalid duplicate check. Nothing was created.');
    if (found.data.length) {
      const recordId = found.data[0]['3'].value;
      return json(200, { duplicate: true, recordId, url: recordUrl(recordId) });
    }
    if (body.mode === 'lookup') return json(200, { found: false });
    const record = {};
    fields.forEach(field => { if (values[field.key]) record[field.id] = { value: values[field.key] }; });
    const recordId = await insertAccount(record);
    return json(200, { created: true, recordId, url: recordUrl(recordId) });
  } catch (error) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
    return json(timedOut ? 504 : 502, { error: timedOut ? 'Quickbase did not respond in time. Check the Accounts table before retrying; creation may have completed.' : error.message });
  }
};
function recordUrl(id) { return 'https://' + REALM + '/db/' + TABLE + '?a=dr&rid=' + encodeURIComponent(id); }
