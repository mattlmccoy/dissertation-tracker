import { test } from 'node:test';
import assert from 'node:assert';
import { PROVIDERS, detectProvider, genKey } from '../js/ghsecrets.js';

test('detectProvider maps domains', () => {
  assert.strictEqual(detectProvider('a@gmail.com'), 'gmail');
  assert.strictEqual(detectProvider('a@googlemail.com'), 'gmail');
  assert.strictEqual(detectProvider('a@outlook.com'), 'outlook');
  assert.strictEqual(detectProvider('a@hotmail.com'), 'outlook');
  assert.strictEqual(detectProvider('prof@gatech.edu'), 'outlook');
  assert.strictEqual(detectProvider('x@acme.io'), 'custom');
  assert.strictEqual(detectProvider(''), null);
  assert.strictEqual(detectProvider('not-an-email'), null);
});

// Regression (Bug 1): a half-typed gmail address transiently reads as 'custom' before it's complete.
// The form's oninput handler MUST keep re-detecting so the finished address corrects to 'gmail'
// rather than sticking on the transient 'custom'.
test('partial gmail domain reads custom, complete reads gmail', () => {
  assert.strictEqual(detectProvider('me@gmail.c'), 'custom');   // mid-typing
  assert.strictEqual(detectProvider('me@gmail.co'), 'custom');  // still mid-typing
  assert.strictEqual(detectProvider('me@gmail.com'), 'gmail');  // finished → must win
});

test('PROVIDERS have host/port and sendgrid is userFixed', () => {
  assert.strictEqual(PROVIDERS.gmail.host, 'smtp.gmail.com');
  assert.strictEqual(String(PROVIDERS.gmail.port), '465');
  assert.strictEqual(PROVIDERS.outlook.host, 'smtp.office365.com');
  assert.strictEqual(String(PROVIDERS.outlook.port), '587');
  assert.strictEqual(PROVIDERS.sendgrid.userFixed, 'apikey');
});

test('genKey is 32 base62 chars', () => {
  const k = genKey();
  assert.match(k, /^[0-9A-Za-z]{32}$/);
  assert.notStrictEqual(genKey(), genKey());
});
