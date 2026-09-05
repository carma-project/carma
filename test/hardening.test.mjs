import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../server/config.js';
import { RateLimiter } from '../server/ratelimit.js';
import { enforceTokenLifetime } from '../server/middleware/guardrails.js';

test('parseConfig: defaults, warnings, and SSL mapping', () => {
  const c = parseConfig({});
  assert.equal(c.port, 7100);
  assert.equal(c.dbSslConfig, false);
  assert.ok(c.warnings.some((w) => w.includes('PUBLIC_KEY')));
  assert.ok(c.warnings.some((w) => w.includes('DATABASE_URL')));

  assert.deepEqual(parseConfig({ DATABASE_SSL: 'require' }).dbSslConfig, { rejectUnauthorized: false });
  assert.deepEqual(parseConfig({ DATABASE_SSL: 'verify' }).dbSslConfig, { rejectUnauthorized: true });

  const bogus = parseConfig({ DATABASE_SSL: 'bogus' });
  assert.equal(bogus.dbSslConfig, false);
  assert.ok(bogus.warnings.some((w) => w.includes('DATABASE_SSL')));

  const strict = parseConfig({ TOKEN_MAX_AGE_WRITE: '120', RATE_LIMIT_RPS: '5' });
  assert.equal(strict.tokenMaxAgeWrite, 120);
  assert.equal(strict.rateLimitRps, 5);
});

test('RateLimiter: burst then throttle, refills over time', () => {
  let t = 0;
  const rl = new RateLimiter({ rps: 10, burst: 3, now: () => t });
  assert.equal(rl.take('k').allowed, true);
  assert.equal(rl.take('k').allowed, true);
  assert.equal(rl.take('k').allowed, true);
  const blocked = rl.take('k');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);

  // A different key has its own bucket.
  assert.equal(rl.take('other').allowed, true);

  // After 1s, ~10 tokens refill (capped at burst=3) -> allowed again.
  t += 1000;
  assert.equal(rl.take('k').allowed, true);
});

test('enforceTokenLifetime: age ceilings per action', () => {
  const limits = { read: 3600, write: 900 };
  const now = Math.floor(Date.now() / 1000);
  assert.ok(enforceTokenLifetime({ iat: now }, 'read', limits));
  assert.ok(enforceTokenLifetime({ iat: now }, 'write', limits));
  assert.ok(enforceTokenLifetime({ iat: now - 1000 }, 'read', limits)); // under 3600
  assert.throws(() => enforceTokenLifetime({ iat: now - 1000 }, 'write', limits)); // over 900
  assert.throws(() => enforceTokenLifetime({}, 'read', limits)); // missing iat
});
