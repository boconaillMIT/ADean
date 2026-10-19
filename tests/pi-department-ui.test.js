const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(require.resolve('../waiver.html'), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function harness() {
  const elements = {}, requests = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; }
    set id(value) { this._id = value; elements[value] = this; }
    get id() { return this._id; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ''; }
    replaceChildren(...children) { this.children = children; this.text = ''; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    scrollIntoView() {}
    focus() { this.focused = true; }
    reportValidity() { return true; }
    click() { return this.listeners.click?.({ preventDefault() {} }); }
  }
  const context = { Office: { onReady() {} }, document: {
    getElementById(id) { if (!elements[id]) { const element = new Element(); element.id = id; } return elements[id]; },
    createElement(tag) { return new Element(tag); }
  }, fetch: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ created: true, message: 'Saved' }) };
  } };
  vm.runInNewContext(source, context);
  context.lastResult = { one_time_pi: {} }; context.lastRequestEmail = { body: 'Synthetic source' };
  for (const [id, value] of Object.entries({ piKerberos: 'example', piResearcher: 'Example, Alex', piMentor: 'Mentor, Pat', piDepartment: 'Robotics Labb', piDecision: 'pending', piRequested: '2026-10-19', piEmailDate: '2026-10-19', piSubject: 'Synthetic request' })) context.document.getElementById(id).value = value;
  context.confirmPiDepartment({ department: 'Robotics Labb', choices: ['Mechanical Engineering'] });
  return { context, elements, requests };
}
test('asking about a new department sends no write request', () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  assert.match(h.elements.piSaveResult.children[0].textContent, /Robotics Labb/);
  assert.match(h.elements.piSaveResult.children[0].textContent, /lab within an existing department/);
});
test('Yes confirms only the exact proposed department', async () => {
  const h = harness(); await h.elements.piSaveResult.children[1].click();
  assert.equal(h.requests[0].department, 'Robotics Labb'); assert.equal(h.requests[0].confirmedDepartment, 'Robotics Labb');
});
test('No opens a correction box and saves the corrected department without stale consent', async () => {
  const h = harness(); await h.elements.piSaveResult.children[2].click();
  assert.equal(h.requests.length, 0);
  assert.equal(h.elements.piDepartmentCorrection.focused, true);
  assert.equal(h.elements.piDepartmentChoices.children[0].value, 'Mechanical Engineering');
  h.elements.piDepartmentCorrection.value = 'Mechanical Engineering';
  await h.elements.piSaveResult.children[2].click();
  assert.equal(h.requests[0].department, 'Mechanical Engineering'); assert.equal(h.requests[0].confirmedDepartment, undefined);
});
test('changing the department before Yes does not confirm the new value', async () => {
  const h = harness(); h.elements.piDepartment.value = 'Another Unit';
  await h.elements.piSaveResult.children[1].click();
  assert.equal(h.requests[0].department, 'Another Unit'); assert.equal(h.requests[0].confirmedDepartment, undefined);
});
