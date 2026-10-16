const { REALM, TABLE, json, qb, schema, clean } = require('./lib/accounts');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body.' }); }
  if (!body || !['schema', 'create'].includes(body.mode)) return json(400, { error: 'Use schema or create mode.' });
  try {
    const fields = await schema();
    if (body.mode === 'schema') return json(200, { fields });
    let values;
    try { values = clean(body.values, fields); }
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
    const record = {};
    fields.forEach(field => { if (values[field.key]) record[field.id] = { value: values[field.key] }; });
    // Cost Object (7) is the table's unique key. Do NOT merge by 7: that would
    // silently overwrite an existing fund if another user created it meanwhile.
    const saved = await qb('records', { to: TABLE, mergeFieldId: 3, data: [record], fieldsToReturn: [3] });
    if (saved.metadata?.lineErrors && Object.keys(saved.metadata.lineErrors).length) {
      return json(422, { error: 'Quickbase rejected the account. It may already exist or require additional fields. Refresh and check the table before retrying.' });
    }
    const recordId = saved.metadata?.createdRecordIds?.[0];
    if (!recordId) throw new Error('Quickbase did not confirm creation. Check the table before retrying.');
    return json(200, { created: true, recordId, url: recordUrl(recordId) });
  } catch (error) { return json(502, { error: error.message }); }
};
function recordUrl(id) { return 'https://' + REALM + '/db/' + TABLE + '?a=dr&rid=' + encodeURIComponent(id); }
