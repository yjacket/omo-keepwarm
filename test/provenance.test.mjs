import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvenance, STALE_INPUT_MS } from '../src/provenance.mjs';

function setup() {
  let t = 1000;
  return { provenance: createProvenance({ now: () => t }), setTime(value) { t = value; }, time() { return t; } };
}

test('interactive started and rpc queued are human returns; extension is automated', () => {
  const { provenance: p } = setup();
  p.noteInput({ inputId: 'a', source: 'interactive' });
  assert.deepEqual(p.noteDisposition({ inputId: 'a', disposition: 'started' }), { kind: 'human_return', source: 'input:interactive', atMs: 1000 });
  p.noteInput({ inputId: 'b', source: 'rpc' });
  assert.equal(p.noteDisposition({ inputId: 'b', disposition: 'queued' }).kind, 'human_return');
  p.noteInput({ inputId: 'c', source: 'extension' });
  assert.equal(p.noteDisposition({ inputId: 'c', disposition: 'started' }).kind, 'automated');
});

test('handled and rejected human input are presence markers', () => {
  const { provenance: p } = setup();
  p.noteInput({ inputId: 1, source: 'interactive' });
  assert.equal(p.noteDisposition({ inputId: 1, disposition: 'handled' }).source, 'input_handled');
  p.noteInput({ inputId: 2, source: 'rpc' });
  assert.equal(p.noteDisposition({ inputId: 2, disposition: 'rejected' }).source, 'input_rejected');
});

test('disposition without known input is unattributed', () => {
  assert.equal(setup().provenance.noteDisposition({ inputId: 8, disposition: 'started' }).source, 'disposition_without_input');
});

test('custom message types are classified; manual continue takes precedence', () => {
  const { provenance: p } = setup();
  for (const customType of ['goal-continuation', 'omo-health', 'senpi-terminal:restore-digest', 'senpi.todo-owed']) {
    assert.deepEqual(p.noteMessageStart({ role: 'custom', customType }), { kind: 'automated', source: customType });
  }
  assert.deepEqual(p.noteMessageStart({ role: 'custom', customType: 'manual-continue' }), { kind: 'human_return', source: 'manual_continue' });
  assert.deepEqual(p.noteMessageStart({ role: 'custom', customType: 'environment-context' }), { kind: 'none', source: 'environment-context' });
  assert.deepEqual(p.noteMessageStart({ role: 'custom', customType: 'environment-context', manualContinue: true }), { kind: 'none', source: 'environment-context' });
  assert.deepEqual(p.noteMessageStart({ role: 'custom', customType: 'manual-continue', environmentContext: true }), { kind: 'human_return', source: 'manual_continue' });
  assert.deepEqual(p.noteMessageStart({ role: 'custom', customType: 'future-kind' }), { kind: 'automated', source: 'future-kind' });
});

test('user message without corresponding input is unattributed', () => {
  const { provenance: p } = setup();
  assert.deepEqual(p.noteMessageStart({ role: 'user' }), { kind: 'unattributed', source: 'user_message_without_input' });
});

test('stale pending inputs are discarded', () => {
  const { provenance: p, setTime } = setup();
  p.noteInput({ inputId: 1, source: 'interactive' });
  setTime(1000 + STALE_INPUT_MS + 1);
  assert.equal(p.pendingInputCount(), 0);
  assert.equal(p.noteDisposition({ inputId: 1, disposition: 'started' }).kind, 'unattributed');
});

test('reset clears inputs and imminent turn', () => {
  const { provenance: p } = setup();
  p.noteInput({ inputId: 1, source: 'rpc' });
  p.noteTurnImminent('agent');
  p.reset();
  assert.equal(p.pendingInputCount(), 0);
  assert.equal(p.turnImminent(), null);
});

test('input IDs pair dispositions to their own source', () => {
  const { provenance: p } = setup();
  p.noteInput({ inputId: 1, source: 'interactive' });
  p.noteInput({ inputId: 2, source: 'extension' });
  assert.equal(p.noteDisposition({ inputId: 2, disposition: 'started' }).kind, 'automated');
  assert.equal(p.noteDisposition({ inputId: 1, disposition: 'queued' }).kind, 'human_return');
});

test('classification signatures do not accept message text', () => {
  assert.equal(createProvenance.length, 1);
  assert.equal(createProvenance({ now: () => 1 }).noteMessageStart.length, 1);
});
