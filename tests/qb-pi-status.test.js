const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../netlify/functions/qb-pi-status'), 'utf8');
const request = overrides => ({ kerberos: 'example', researcher: 'Example, Alex', mentor: 'Mentor, Pat',
  firstName: 'Alex', lastName: 'Example', dateOfRequest: '2026-10-15', emailDate: '2026-10-14',
  emailSubject: "PI request for O'Brien", emailBody: 'Synthetic email only',
  decision: 'approved', decisionDate: '2026-10-15', effortPercent: 25, totalProposalValue: 150000,
  proposalTitle: 'Test proposal', proposalNumber: '123', sponsor: 'Example sponsor', department: 'Example department',
  reason: 'Test reason', notes: 'Post-tenure; reviewer confirmed decision.', ...overrides });
function harness(responses = [], token = 'mock-token') {
  const calls = [];
  const context = { exports: {}, process: { env: token ? { QB_RESEARCH_TOKEN: token } : {} },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      assert(responses.length, 'Unexpected upstream call');
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { ok: r.ok !== false, json: async () => r.body };
    } };
  vm.runInNewContext(source, context);
  return { calls, async post(value = request()) {
    const result = await context.exports.handler({ httpMethod: 'POST', body: JSON.stringify(value) });
    return { status: result.statusCode, ...JSON.parse(result.body) };
  }, handler: context.exports.handler };
}
const empty = () => ({ body: { data: [] } });
const created = () => ({ body: { data: [{ 3: { value: 101 } }] } });
const verified = () => ({ body: { data: [{ 3: { value: 101 }, 56: { value: 'example' } }] } });

test('saves the PI-status table, maps screenshot fields, verifies before success', async () => {
  const h = harness([empty(), created(), verified()]);
  const result = await h.post();
  assert.equal(result.status, 200); assert.equal(result.verified, true); assert.equal(result.recordId, 101);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].body.from, 'bsskfjj57');
  assert(h.calls[0].body.where.includes("O\\'Brien"));
  const write = h.calls[1];
  assert.equal(write.body.to, 'bsskfjj57');
  assert.equal(write.headers.Authorization, 'QB-USER-TOKEN mock-token');
  const record = write.body.data[0];
  for (const [id, value] of [[20,'Mentor, Pat'],[22,'Example, Alex'],[38,true],[37,true],[54,'Alex'],[53,'Example'],[7,0.25],
    [10,150000],[41,'Test proposal'],[23,'123'],[28,'Example sponsor'],[29,'Example department'],[42,'Test reason'],
    [15,'Synthetic email only'],[16,'2026-10-14'],[56,'example']]) assert.equal(record[id].value,value,'field '+id);
  assert.equal(record[51], undefined); assert.equal(record[52], undefined);
  assert.equal(h.calls[2].body.where, '{3.EX.101}');
});
test('pending never writes approval or a decision date, even with supplied dates', async () => {
  const h = harness([empty(),created(),verified()]);
  assert.equal((await h.post(request({ decision:'pending' }))).status,200);
  const record=h.calls[1].body.data[0];
  assert.equal(record[37],undefined); assert.equal(record[8],undefined);
  assert.match(record[14].value,/decision: pending/);
});
test('manual not-approved decision writes false, not an approval', async () => {
  const h = harness([empty(),created(),verified()]);
  await h.post(request({decision:'denied'}));
  assert.equal(h.calls[1].body.data[0][37].value,false);
});
test('an existing request is returned without a write', async () => {
  const h=harness([{body:{data:[{3:{value:55}}]}}]);
  const r=await h.post();
  assert.equal(r.duplicate,true); assert.equal(r.recordId,55); assert.equal(h.calls.length,1);
});
test('a failed or malformed duplicate check prevents creation', async () => {
  for(const response of [{ok:false,body:{}},{body:{}},new Error('Network unavailable')]) {
    const h=harness([response]);
    assert.equal((await h.post()).status,502); assert.equal(h.calls.length,1);
  }
});
test('record errors and unsuccessful verification never report success', async () => {
  for(const responses of [
    [empty(),{body:{metadata:{lineErrors:{1:['Required field missing']}}}}],
    [empty(),{body:{data:[]}}],
    [empty(),created(),empty()],
    [empty(),created(),{ok:false,body:{}}],
    [empty(),created(),{body:{data:[{3:{value:101},56:{value:'different'}}]}}]
  ]) {
    const h=harness(responses); const r=await h.post();
    assert.equal(r.status,502); assert.equal(r.created,undefined); assert.match(r.error,/before retrying/);
  }
});
test('validates required fields, reviewer choice, dates and numeric ranges before networking', async () => {
  for(const overrides of [{kerberos:''},{kerberos:'alex@mit.edu'},{researcher:''},{mentor:''},{emailSubject:''},
    {decision:''},{decision:'auto'},{decisionDate:''},{dateOfRequest:'2026-02-30'}, {emailDate:'nonsense'},
    {proposalStart:'2026-13-01'}, {effortPercent:101},{effortPercent:-1},{totalProposalValue:-1}]) {
    const h=harness(); assert.equal((await h.post(request(overrides))).status,400); assert.equal(h.calls.length,0);
  }
});
test('missing credentials and unsupported methods make no upstream request', async () => {
  const h=harness([],null);
  assert.match((await h.post()).error,/QB_RESEARCH_TOKEN/);
  assert.equal((await h.handler({httpMethod:'GET'})).statusCode,405);
  assert.equal((await h.handler({httpMethod:'OPTIONS'})).statusCode,204);
  assert.equal((await h.handler({httpMethod:'POST',body:'{'})).statusCode,400);
  assert.equal((await h.post(null)).status,400); assert.equal(h.calls.length,0);
});
