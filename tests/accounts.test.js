const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, parseNotice } = require('../netlify/functions/lib/accounts');
const { handler } = require('../netlify/functions/qb-account');
const extract = require('../netlify/functions/parley-account-extract').handler;
const originalFetch = global.fetch;
const originalToken = process.env.QB_FINANCE_TOKEN;
const originalParley = process.env.PARLEY_FINANCE_API_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of [['QB_FINANCE_TOKEN', originalToken], ['PARLEY_FINANCE_API_KEY', originalParley]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const sample = "Dear Brian O'Conaill,\n Fund 3947890, Quantum Life Sciences Fellowship Fund has been created and added to SAP OR the fund documentation has been updated. Contact Ainsley Cray (ainsleyc@mit.edu).";
const event = body => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const result = response => JSON.parse(response.body);
const liveFields = Object.values(FIELDS).map(f => ({ id: f.id, properties: { choices: f.choice ? ['A', 'B'] : undefined } }));
const ok = data => ({ ok: true, json: async () => data });
function mockQB(callback) {
  process.env.QB_FINANCE_TOKEN = 'test-token';
  global.fetch = async (url, options) => url.includes('/fields?') ? ok(liveFields) : callback(url, url.includes('api.quickbase.com') ? JSON.parse(options.body) : options.body);
}
test('sample extracts only explicit identity and flags created OR updated', () => {
  const parsed = parseNotice(sample);
  assert.deepEqual(parsed.values, { fundNumber: '3947890', name: 'Quantum Life Sciences Fellowship Fund' });
  assert.match(parsed.flags.join(), /does not establish/);
  assert.equal(parsed.values.description, undefined);
});
test('several standard notices do not select a fund silently', () => {
  assert.deepEqual(parseNotice(sample + '\nFund 1234567, Another Fund has been created.').values, {});
});
test('Outlook line wrapping does not lose the fund name', () => {
  assert.equal(parseNotice('Fund 3947890, Quantum Life Sciences\nFellowship Fund has been created.').values.name, 'Quantum Life Sciences Fellowship Fund');
});
test('notice works without AI and PDF details remain blank', async () => {
  global.fetch = () => { throw new Error('AI should not be called'); };
  const data = result(await extract(event({ body: sample })));
  assert.equal(data.result.values.fundNumber, '3947890');
  assert.match(data.result.flags.join(), /No PDF text/);
});
test('missing PDF extraction key is visible to user', async () => {
  delete process.env.PARLEY_FINANCE_API_KEY;
  const data = result(await extract(event({ body: sample, pdfText: 'Purpose: fellowships' })));
  assert.match(data.result.flags.join(), /not interpreted/);
  assert.equal(data.result.values.description, undefined);
});
test('email and PDF fund mismatch blanks identity and warns', async () => {
  process.env.PARLEY_FINANCE_API_KEY = 'test-key';
  mockQB(() => ok({ choices: [{ message: { content: JSON.stringify({ values: { fundNumber: '1234567', name: 'Other', description: 'Explicit purpose', poolCode: 'INVALID' } }) } }] }));
  const data = result(await extract(event({ body: sample, pdfText: 'Fund 1234567' })));
  assert.equal(data.result.values.fundNumber, undefined);
  assert.equal(data.result.values.name, undefined);
  assert.equal(data.result.values.poolCode, undefined);
  assert.match(data.result.flags.join(), /different funds/);
});
test('malformed and oversized extraction inputs are rejected', async () => {
  assert.equal((await extract({ httpMethod: 'POST', body: '{' })).statusCode, 400);
  assert.equal((await extract(event(null))).statusCode, 400);
  assert.equal((await extract(event({ body: {} }))).statusCode, 400);
  assert.equal((await extract(event({ pdfText: 'a'.repeat(100001) }))).statusCode, 413);
});
test('existing Cost Object never triggers a write', async () => {
  mockQB((url, payload) => {
    assert.match(url, /records\/query$/); assert.equal(payload.where, "{7.EX.'3947890'}");
    return ok({ data: [{ 3: { value: 99 } }] });
  });
  const data = result(await handler(event({ mode: 'create', values: { fundNumber: '3947890', name: 'Quantum' } })));
  assert.equal(data.duplicate, true); assert.equal(data.recordId, 99);
});
test('failed duplicate lookup prevents creation', async () => {
  let calls = 0;
  mockQB(url => { calls++; assert.match(url, /records\/query$/); return { ok: false, status: 503 }; });
  assert.equal((await handler(event({ mode: 'create', values: { fundNumber: '3947890', name: 'Quantum' } }))).statusCode, 502);
  assert.equal(calls, 1);
});
test('create uses insert-only API with mapped fields and no balances', async () => {
  mockQB((url, payload) => {
    if (url.endsWith('/query')) return ok({ data: [] });
    assert.equal(url, 'https://mit.quickbase.com/db/br2xvsvpw');
    assert.match(payload, /<field fid="7">3947890<\/field>/);
    assert.match(payload, /<field fid="8">Quantum<\/field>/);
    assert.match(payload, /<field fid="20">Fellowships<\/field>/);
    assert.doesNotMatch(payload, /amount|mergeFieldId|500000/);
    return { ok: true, text: async () => '<qdbapi><errcode>0</errcode><rid>101</rid></qdbapi>' };
  });
  const data = result(await handler(event({ mode: 'create', values: { fundNumber: '3947890', name: 'Quantum', description: 'Fellowships', amount: '500000' } })));
  assert.equal(data.created, true); assert.equal(data.recordId, 101);
});
test('invalid choices and fund numbers never query or write records', async () => {
  mockQB(() => { throw new Error('No record call expected'); });
  for (const values of [{ fundNumber: "3947890'}OR", name: 'Quantum' }, { fundNumber: '3947890', name: 'Quantum', poolCode: 'INVALID' }, { fundNumber: '3947890' }]) {
    assert.equal((await handler(event({ mode: 'create', values }))).statusCode, 400);
  }
});
test('insert-only API rejection never reports success', async () => {
  mockQB(url => url.endsWith('/query') ? ok({ data: [] }) : { ok: true, text: async () => '<qdbapi><errcode>51</errcode><errtext>Unique field contains duplicate data</errtext></qdbapi>' });
  const response = await handler(event({ mode: 'create', values: { fundNumber: '3947890', name: 'Quantum' } }));
  assert.equal(response.statusCode, 502); assert.equal(result(response).created, undefined);
  assert.match(result(response).error, /duplicate data/);
});
test('insert escapes source text and requires a confirmed record ID', async () => {
  mockQB((url,payload) => {
    if (url.endsWith('/query')) return ok({data:[]});
    assert.match(payload, /Quantum &amp; &lt;Life&gt;/);
    return {ok:true,text:async()=>'<qdbapi><errcode>0</errcode></qdbapi>'};
  });
  const response=await handler(event({mode:'create',values:{fundNumber:'3947890',name:'Quantum & <Life>'}}));
  assert.equal(response.statusCode,502); assert.match(result(response).error,/not confirmed/);
});
test('Quickbase timeout returns a visible uncertain-outcome error', async () => {
  mockQB(url => {
    if (url.endsWith('/query')) return ok({data:[]});
    const error=new Error('Timed out'); error.name='TimeoutError'; throw error;
  });
  const response=await handler(event({mode:'create',values:{fundNumber:'3947890',name:'Quantum'}}));
  assert.equal(response.statusCode,504); assert.match(result(response).error,/may have completed/);
});

test('lookup never writes and needs only the fund number', async () => {
  mockQB(url => { assert.match(url,/records\/query$/); return ok({data:[]}); });
  const response=await handler(event({mode:'lookup',values:{fundNumber:'3947890'}}));
  assert.equal(response.statusCode,200); assert.equal(result(response).found,false);
});
test('query failure identifies the stage and safe upstream error', async () => {
  mockQB(() => ({ok:false,status:400,json:async()=>({message:'Bad Request',description:'Invalid query operator test-token'})}));
  const response=await handler(event({mode:'lookup',values:{fundNumber:'3947890'}}));
  assert.match(result(response).error,/Checking existing accounts/);
  assert.match(result(response).error,/Invalid query operator/);
  assert.doesNotMatch(result(response).error,/test-token/);
});
