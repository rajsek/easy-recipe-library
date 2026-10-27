import test from 'node:test';
import assert from 'node:assert/strict';
import { authGuardViolation, isServerless } from './auth-guard.js';

test('local dev without token is allowed', () => {
  assert.equal(authGuardViolation({}), null);
  assert.equal(authGuardViolation({ HOST: '127.0.0.1' }), null);
  assert.equal(authGuardViolation({ HOST: 'localhost' }), null);
});

test('non-local host without token refuses', () => {
  assert.match(authGuardViolation({ HOST: '0.0.0.0' })!, /not local/);
});

test('serverless without token refuses even with local HOST default', () => {
  assert.match(authGuardViolation({ VERCEL: '1' })!, /serverless/);
  assert.match(authGuardViolation({ AWS_LAMBDA_FUNCTION_NAME: 'f' })!, /serverless/);
  assert.match(authGuardViolation({ K_SERVICE: 'svc' })!, /serverless/);
  assert.match(authGuardViolation({ VERCEL: '1', HOST: '127.0.0.1' })!, /serverless/);
});

test('token set always passes', () => {
  assert.equal(authGuardViolation({ VERCEL: '1', APP_TOKEN: 'x' }), null);
  assert.equal(authGuardViolation({ HOST: '0.0.0.0', APP_TOKEN: 'x' }), null);
});

test('isServerless detects platform markers', () => {
  assert.equal(isServerless({}), false);
  assert.equal(isServerless({ VERCEL: '1' }), true);
});
