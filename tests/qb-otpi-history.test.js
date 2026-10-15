const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../netlify/functions/qb-otpi-history'), 'utf8');
function harness(response, token = 'mock-token') {
  const calls = [];
  const sandbox = { exports: {}, console: { error() {} }, process: { env: token ? { QB_RESEARCH_TOKEN: token } : {} },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (response instanceof Error) throw response;
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    } };
  vm.runInNewContext(source, sandbox);
  return { calls, handler: sandbox.exports.handler, async post(kerberos = 'Example') {
    const r = await sandbox.exports.handler({ httpMethod: 'POST', body: JSON.stringify({ kerberos }) });
    return { status: r.statusCode, ...JSON.parse(r.body) };
  } };
}
test('returns history counts with the research token and normalized username', async () => {
  const h = harness({ status: 200, body: { data: [{37:{value:true}},{37:{value:false}},{37:{value:true}}] } });
  const r = await h.post(' Example ');
  assert.deepEqual(r, {status:200,count:3,approved:2,denied:1,successRate:0.67});
  assert.equal(h.calls[0].headers.Authorization,'QB-USER-TOKEN mock-token');
  assert.equal(JSON.parse(h.calls[0].body).where,"{56.EX.'example'}");
});
test('zero records is a successful lookup, not a credential failure', async () => {
  const h=harness({status:200,body:{data:[]}});
  assert.deepEqual(await h.post(),{status:200,count:0,approved:0,denied:0,successRate:null});
});
test('missing token is identified before any upstream call', async () => {
  const h=harness(null,null); const r=await h.post();
  assert.equal(r.status,500); assert.equal(r.error,'missing_token'); assert.match(r.message,/QB_RESEARCH_TOKEN/);
  assert.equal(h.calls.length,0);
});
test('distinguishes upstream failures without leaking response or token values', async () => {
  for(const [status,error] of [[401,'invalid_token'],[403,'access_denied'],[429,'rate_limited'],[400,'query_failed'],[500,'query_failed']]) {
    const h=harness({status,body:{message:'sensitive upstream body'}});
    const r=await h.post(); assert.equal(r.error,error); assert(r.status>=500); assert.equal(r.count,null);
    assert(!JSON.stringify(r).includes('sensitive')); assert(!JSON.stringify(r).includes('mock-token'));
  }
});
test('network and malformed responses are failures, never zero-history success', async () => {
  for(const response of [new Error('internal credential detail'),{status:200,body:{}}]) {
    const r=await harness(response).post(); assert.equal(r.status,502); assert.equal(r.count,null);
    assert(!JSON.stringify(r).includes('internal credential detail'));
  }
});
test('rejects invalid usernames, JSON and methods without networking', async () => {
  const h=harness(null);
  for(const value of ['',1,{},null,"name'OR",'user@mit.edu']) assert.equal((await h.post(value)).status,400);
  assert.equal((await h.handler({httpMethod:'POST',body:'{'})).statusCode,400);
  assert.equal((await h.handler({httpMethod:'POST',body:'null'})).statusCode,400);
  assert.equal((await h.handler({httpMethod:'GET'})).statusCode,405);
  assert.equal((await h.handler({httpMethod:'OPTIONS'})).statusCode,204);
  assert.equal(h.calls.length,0);
});
