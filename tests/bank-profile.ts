// Native profile for the banking-style fixture (test data, imported through the real Import UI).
// Definitions and references only: no tokens, keys or current values.
const now = 1;
type O = { body?: string; headers?: { name: string; value: string }[]; checks?: unknown[]; auth?: boolean; sign?: boolean };
const ep = (id: string, alias: string, name: string, method: string, url: string, o: O = {}) => ({
  id, name, alias,
  request: { method, hostKey: 'default', url, query: [], headers: o.headers ?? [], credentials: 'same-origin', body: o.body ? { kind: 'json', text: o.body } : { kind: 'none' } },
  checks: o.checks ?? [{ kind: 'status', min: 200, max: 299 }],
  provenance: 'G27 banking-style fixture', createdAt: now, updatedAt: now,
  ...(o.auth && { authContextId: 'auth-bank' }), ...(o.sign && { signingRecipeId: 'sign-bank' }),
});
const csrf = { name: 'X-XSRF-TOKEN', value: '{{$cookie("XSRF-TOKEN")}}' };

export function bankProfile(name = 'Bank fixture') {
  const agg = {
    schema: 2, revision: 0,
    profile: { id: 'profile-bank', name, createdAt: now, updatedAt: now, environments: { default: { default: '' } }, activeEnvironment: 'default', globalHeaders: [], settings: { bodyCheckKb: 1024 } },
    endpoints: [
      ep('ep-refresh', 'refresh', 'Refresh token', 'POST', '/api/bank/refresh', { body: '{}' }),
      ep('ep-accounts', 'accounts', 'List accounts', 'GET', '/api/bank/accounts', { auth: true }),
      ep('ep-quote', 'quote', 'Create quote', 'POST', '/api/bank/quotes', { auth: true, body: '{"accountId": "{{accounts.accounts[0].id}}", "amount": "100.10"}' }),
      ep('ep-transfer', 'transfer', 'Submit transfer', 'POST', '/api/bank/transfers', { auth: true, sign: true, headers: [csrf], body: '{"quoteId": "{{quote.id}}", "amount": {{quote.amount}}}', checks: [{ kind: 'status', min: 202, max: 202 }] }),
      ep('ep-status', 'status', 'Transfer status', 'GET', '/api/bank/transfers/{{transfer.id}}', { auth: true }),
      ep('ep-receipt', 'receipt', 'Receipt PDF', 'GET', '/api/bank/transfers/{{transfer.id}}/receipt', { auth: true, checks: [{ kind: 'status', min: 200, max: 200 }, { kind: 'header', name: 'content-type', value: 'application/pdf' }] }),
      ep('ep-again', 'transfer_again', 'Transfer (manual, idempotent)', 'POST', '/api/bank/transfers', { auth: true, sign: true, headers: [csrf, { name: 'Idempotency-Key', value: '{{$uuid}}' }], body: '{"quoteId": "{{$sessionStorage("quote_id")}}", "amount": "100.10"}', checks: [{ kind: 'status', min: 202, max: 202 }] }),
    ],
    plans: [{
      id: 'plan-transfer', name: 'Transfer flow', strategy: 'flow', mode: 'direct', iterations: 2, concurrency: 1, delayMs: 0, rampUp: false, rampStepMs: 1000, onFailure: 'continue', notify: 'panel',
      steps: [
        { endpointId: 'ep-accounts', phase: 'load' },
        { endpointId: 'ep-quote', phase: 'load', assertions: [{ ref: 'quote.total', op: 'eq', value: '100.60' }] },
        { endpointId: 'ep-transfer', phase: 'load', guard: { ref: 'quote.currency', op: 'eq', value: 'EUR' }, idempotency: { header: 'Idempotency-Key' } },
        { endpointId: 'ep-status', phase: 'load', poll: { readOnly: true, until: { ref: 'status.status', op: 'in', value: 'completed,failed' }, maxAttempts: 5, intervalMs: 250, deadlineMs: 5000 },
          assertions: [{ ref: 'status.status', op: 'eq', value: 'completed' }, { ref: 'status.total', op: 'eq', value: '100.60' }, { ref: 'status.amount', op: 'gte', value: '100.10' }] },
        { endpointId: 'ep-receipt', phase: 'load', guard: { ref: 'status.status', op: 'eq', value: 'completed' } },
        { endpointId: 'ep-refresh', phase: 'skip' },
        { endpointId: 'ep-again', phase: 'skip' },
      ],
    }],
    authContexts: [{
      id: 'auth-bank', label: 'Synthetic customer', identity: 'synthetic-customer-a', audience: 'default', credentials: 'same-origin',
      headers: [{ name: 'Authorization', prefix: 'Bearer ', source: { kind: 'localStorage', key: 'bank_token' } }],
      expiry: { source: { kind: 'localStorage', key: 'bank_exp' }, format: 'epoch-ms' },
      refresh: { endpointId: 'ep-refresh', outputs: [{ path: 'token', target: { kind: 'localStorage', key: 'bank_token' } }, { path: 'expiresAt', target: { kind: 'localStorage', key: 'bank_exp' } }], deadlineMs: 5000, readOnlyRetry: true },
    }],
    signingRecipes: [{ id: 'sign-bank', label: 'Bank HMAC', algorithm: 'HMAC-SHA-256', components: ['method', 'path', 'query', 'body-sha256', 'timestamp', 'nonce'], separator: '\n', encoding: 'hex', keyRef: 'bank_key', outputHeader: 'X-Signature', timestampHeader: 'X-Timestamp', nonceHeader: 'X-Nonce', freshnessMs: 30000 }],
    bindings: [], rules: [], legacyRules: [],
  };
  return JSON.stringify({ format: 'api-workbench', kind: 'profile', schema: 2, exportedAt: '2026-10-11T00:00:00.000Z', redacted: false, profiles: [agg] });
}
