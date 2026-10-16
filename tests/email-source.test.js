const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportMessage, filename } = require('../email-source');
const supported = { isSetSupported: (name, version) => name === 'Mailbox' && version === '1.14' };
test('exports the selected original message and sanitizes its filename', async () => {
  const data = Buffer.from('Subject: Fund notice\r\n\r\nOriginal message').toString('base64');
  const item = { itemId: 'source-id', subject: 'Fund / quantum', getAsFileAsync: callback => callback({ status: 'succeeded', value: data }) };
  assert.deepEqual(await exportMessage(item, supported, 'source-id'), { fileName: 'Email - Fund   quantum.eml', data });
  assert.equal(filename('Question?'), 'Email - Question.eml');
});
test('never exports another message after the Outlook selection changes', async () => {
  const item = { itemId: 'other-id', getAsFileAsync: () => { throw new Error('Must not be called'); } };
  await assert.rejects(exportMessage(item, supported, 'source-id'), /Read the source email again/);
});
test('unsupported Outlook and failed exports require user action', async () => {
  const item = { itemId: 'source-id', getAsFileAsync: callback => callback({ status: 'failed' }) };
  await assert.rejects(exportMessage(item, { isSetSupported: () => false }, 'source-id'), /Upload a saved .eml/);
  await assert.rejects(exportMessage(item, supported, 'source-id'), /could not export/);
});
test('emails exceeding the upload limit are not silently omitted', async () => {
  const item = { itemId: 'source-id', getAsFileAsync: callback => callback({ status: 'succeeded', value: 'A'.repeat(4000004) }) };
  await assert.rejects(exportMessage(item, supported, 'source-id'), /over 3 MB/);
});
