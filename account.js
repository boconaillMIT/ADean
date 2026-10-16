'use strict';
const $ = id => document.getElementById(id);
let fields = [], busy = false, saved = false;
const setStatus = message => { $('status').textContent = message; };
async function post(name, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), name === 'qb-account' ? 45000 : 65000);
  try {
  const response = await fetch('/.netlify/functions/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The service is unavailable. Check that the Netlify functions are deployed.'); }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Check Quickbase before retrying account creation.');
    throw error;
  } finally { clearTimeout(timer); }
}
function lock(value) {
  busy = value;
  $('extract').disabled = value;
  $('readEmail').disabled = value || !(window.Office?.context?.mailbox?.item);
  $('create').disabled = value || saved || !fields.length || !$('reviewed').checked;
  for (const element of document.querySelectorAll('input,select,textarea')) element.disabled = value;
}
function invalidate() { $('reviewed').checked = false; $('create').disabled = true; }
for (const id of ['subject', 'emailBody', 'pdfText']) $(id).addEventListener('input', () => {
  $('review').hidden = true; invalidate(); $('result').replaceChildren();
});
$('reviewed').addEventListener('change', () => lock(busy));
async function readEmail() {
  const item = window.Office?.context?.mailbox?.item;
  if (!item) { $('emailDetails').open = true; setStatus('Paste the email contents below.'); return; }
  lock(true); invalidate(); $('review').hidden = true; $('result').replaceChildren();
  try {
    const text = await new Promise((resolve, reject) => item.body.getAsync(Office.CoercionType.Text, result => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value || '');
      else reject(new Error(result.error?.message || 'Could not read the email.'));
    }));
    $('subject').value = item.subject || ''; $('emailBody').value = text;
    $('emailSummary').textContent = item.subject || 'Email loaded.';
    setStatus('Email loaded. Paste the gift memo text if available, then propose the account.');
  } catch (error) { setStatus(error.message); }
  finally { lock(false); }
}
$('readEmail').addEventListener('click', readEmail);
$('extract').addEventListener('click', async () => {
  if (!$('emailBody').value.trim() && !$('pdfText').value.trim()) { setStatus('Read an email or paste the PDF contents first.'); return; }
  lock(true); saved = false; invalidate(); $('review').hidden = true; $('result').replaceChildren(); $('flags').replaceChildren();
  setStatus('Reading the source and loading the Accounts fields…');
  try {
    const schema = await post('qb-account', { mode: 'schema' });
    fields = schema.fields;
    const data = await post('parley-account-extract', { subject: $('subject').value, body: $('emailBody').value, pdfText: $('pdfText').value });
    if (!data.result?.values) throw new Error('No account proposal was returned. Try again.');
    render(data.result.values, data.result.flags || []);
    setStatus('Proposal ready. Review and edit the values before creating the account.');
  } catch (error) { setStatus(error.message); }
  finally { lock(false); }
});
function render(values, flags) {
  $('fields').replaceChildren(); $('flags').replaceChildren();
  for (const flag of flags) { const li = document.createElement('li'); li.textContent = flag; $('flags').append(li); }
  for (const field of fields) {
    const label = document.createElement('label'); label.htmlFor = 'field_' + field.key;
    label.textContent = field.label + (field.required ? ' *' : '');
    const input = document.createElement(field.choice ? 'select' : field.multiline ? 'textarea' : 'input');
    input.id = label.htmlFor; input.name = field.key; input.required = !!field.required;
    if (field.choice) for (const choice of ['', ...field.choices]) {
      const option = document.createElement('option'); option.value = choice; option.textContent = choice || 'Not specified'; input.append(option);
    }
    if (field.multiline) input.rows = 4;
    if (field.key === 'fundNumber') { input.pattern = '[0-9]{7}'; input.inputMode = 'numeric'; input.maxLength = 7; }
    input.value = values[field.key] || '';
    input.addEventListener('input', invalidate); input.addEventListener('change', invalidate);
    $('fields').append(label, input);
  }
  $('review').hidden = false;
}
$('lookup').addEventListener('click', async () => {
  if (busy) return;
  lock(true); $('result').textContent = 'Checking Quickbase…';
  try {
    const data = await post('qb-account', { mode: 'lookup', values: { fundNumber: $('field_fundNumber').value } });
    $('result').textContent = data.duplicate ? 'This account already exists. ' : 'No account with this fund number was found. You can review the proposal and create it.';
    if (data.duplicate) {
      const link = document.createElement('a'); link.href = data.url; link.textContent = 'Open existing account'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('result').append(link);
    }
  } catch (error) { $('result').textContent = error.message; }
  finally { lock(false); $('result').scrollIntoView({ block: 'nearest' }); }
});
$('accountForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || saved || !$('reviewed').checked || !$('accountForm').reportValidity()) return;
  const values = Object.fromEntries(fields.map(f => [f.key, $('field_' + f.key).value]));
  lock(true); $('result').replaceChildren(); setStatus('Checking the fund number and creating the account…');
  $('create').textContent = 'Creating account…';
  $('result').textContent = 'Checking for an existing fund and saving to Quickbase…';
  try {
    const data = await post('qb-account', { mode: 'create', values });
    if (!data.created && !data.duplicate) throw new Error('Creation was not confirmed. Check Quickbase before retrying.');
    saved = true;
    const message = document.createElement('p');
    message.textContent = data.duplicate ? 'This fund already exists. Review its account and update the documentation there if needed.' : 'Account #' + data.recordId + ' created in Quickbase.';
    const link = document.createElement('a'); link.textContent = 'Open account in Quickbase'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    // The service produces this URL, but only a verified Quickbase link is opened.
    const url = new URL(data.url);
    if (url.origin !== 'https://mit.quickbase.com') throw new Error('Unexpected record URL. Open the Accounts table to verify the result.');
    link.href = url.href; $('result').replaceChildren(message, link); setStatus(data.duplicate ? 'Existing account found. No new account was created.' : 'Account created.');
  } catch (error) {
    const message = error.message + ' Check the Accounts table before retrying.';
    setStatus(message); $('result').replaceChildren();
    const paragraph = document.createElement('p'); paragraph.textContent = message;
    const link = document.createElement('a'); link.href = 'https://mit.quickbase.com/nav/app/br2xvzd7a/table/br2xvsvpw/action/td';
    link.textContent = 'Check Accounts in Quickbase'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('result').append(paragraph, link);
  }
  finally { $('create').textContent = 'Create account in Quickbase'; invalidate(); lock(false); $('result').scrollIntoView({ block: 'nearest' }); }
});
if (window.Office) Office.onReady(info => {
  if (info.host === Office.HostType.Outlook) { lock(false); readEmail(); }
});
