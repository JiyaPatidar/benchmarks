import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CopilotTokenManager,
  DEFAULT_COPILOT_HOST,
  githubCopilotAuth,
  resolveCopilotAuthMode,
} from './github-copilot-auth.js';
import type { TokenExchangeResult } from './github-copilot-host.js';

/** Manual clock + timer queue so refresh scheduling is deterministic. */
function fakeTime(start = 1_700_000_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    schedule: (fn: () => void, delayMs: number) => {
      const t = { at: now + delayMs, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    pending: () => timers.filter((t) => !t.cancelled).map((t) => t.at - now),
    /** Advances the clock, firing due timers in order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
  };
}

function tokenAt(t: ReturnType<typeof fakeTime>, n: number, overrides: Partial<TokenExchangeResult> = {}): TokenExchangeResult {
  return {
    sessionToken: `tid=token-${n}`,
    apiUrl: 'https://api.individual.githubcopilot.com',
    expiresAt: Math.floor(t.now() / 1000) + 30 * 60,
    refreshIn: 25 * 60,
    ...overrides,
  };
}

describe('resolveCopilotAuthMode', () => {
  it('defaults to pat', () => {
    assert.equal(resolveCopilotAuthMode({}), 'pat');
    assert.equal(resolveCopilotAuthMode({ GITHUB_COPILOT_AUTH_MODE: '' }), 'pat');
    assert.equal(resolveCopilotAuthMode({ GITHUB_COPILOT_AUTH_MODE: 'PAT' }), 'pat');
  });
  it('accepts cts', () => {
    assert.equal(resolveCopilotAuthMode({ GITHUB_COPILOT_AUTH_MODE: 'cts' }), 'cts');
  });
  it('rejects anything else', () => {
    assert.throws(() => resolveCopilotAuthMode({ GITHUB_COPILOT_AUTH_MODE: 'oauth' }), /Invalid GITHUB_COPILOT_AUTH_MODE/);
  });
});

describe('CopilotTokenManager', () => {
  it('mints once for concurrent ensure() calls and caches the token', async () => {
    const t = fakeTime();
    let calls = 0;
    const m = new CopilotTokenManager({
      exchange: async () => tokenAt(t, ++calls),
      now: t.now,
      schedule: t.schedule,
    });
    await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
    await m.ensure();
    assert.equal(calls, 1);
    assert.equal(m.token(), 'tid=token-1');
    assert.equal(m.apiHost(), 'api.individual.githubcopilot.com');
  });

  it('token() throws before ensure()', () => {
    const t = fakeTime();
    const m = new CopilotTokenManager({ exchange: async () => tokenAt(t, 1), now: t.now, schedule: t.schedule });
    assert.throws(() => m.token(), /not available/);
  });

  it('schedules refresh at min(refresh_in, expires_at - margin) and refreshes in the background', async () => {
    const t = fakeTime();
    let calls = 0;
    const m = new CopilotTokenManager({
      exchange: async () => tokenAt(t, ++calls),
      now: t.now,
      schedule: t.schedule,
    });
    await m.ensure();
    assert.deepEqual(t.pending(), [25 * 60_000]);

    await t.advance(25 * 60_000);
    assert.equal(calls, 2);
    assert.equal(m.token(), 'tid=token-2');
    assert.deepEqual(t.pending(), [25 * 60_000]);
  });

  it('uses expires_at minus the margin when it is sooner than refresh_in', async () => {
    const t = fakeTime();
    const m = new CopilotTokenManager({
      exchange: async () => tokenAt(t, 1, { expiresAt: Math.floor(t.now() / 1000) + 10 * 60, refreshIn: 25 * 60 }),
      now: t.now,
      schedule: t.schedule,
      refreshMarginMs: 5 * 60_000,
    });
    await m.ensure();
    assert.deepEqual(t.pending(), [5 * 60_000]);
  });

  it('keeps the current token and retries when a background refresh fails', async () => {
    const t = fakeTime();
    let calls = 0;
    const responses: Array<TokenExchangeResult | undefined> = [];
    const logs: string[] = [];
    const m = new CopilotTokenManager({
      exchange: async () => {
        calls++;
        return calls === 1 ? tokenAt(t, 1) : responses.shift();
      },
      now: t.now,
      schedule: t.schedule,
      log: (msg) => logs.push(msg),
      retryDelayMs: 30_000,
    });
    await m.ensure();

    responses.push(undefined);
    await t.advance(25 * 60_000);
    assert.equal(calls, 2);
    assert.equal(m.token(), 'tid=token-1');
    assert.deepEqual(t.pending(), [30_000]);
    assert.ok(logs.some((l) => l.includes('refresh failed')));

    responses.push(tokenAt(t, 3));
    await t.advance(30_000);
    assert.equal(calls, 3);
    assert.equal(m.token(), 'tid=token-3');
  });

  it('re-mints on ensure() once the cached token has expired', async () => {
    const t = fakeTime();
    let calls = 0;
    const m = new CopilotTokenManager({
      exchange: async () => tokenAt(t, ++calls),
      now: t.now,
      // Never fire background refreshes, to simulate them all failing/being skipped.
      schedule: () => () => {},
    });
    await m.ensure();
    await t.advance(31 * 60_000);
    assert.throws(() => m.token(), /not available/);
    await m.ensure();
    assert.equal(calls, 2);
    assert.equal(m.token(), 'tid=token-2');
  });

  it('ensure() rejects when the exchange fails and nothing is cached', async () => {
    const t = fakeTime();
    const m = new CopilotTokenManager({ exchange: async () => undefined, now: t.now, schedule: t.schedule });
    await assert.rejects(m.ensure(), /exchange failed/);
  });

  it('falls back to a 25 minute lifetime when expires_at is missing', async () => {
    const t = fakeTime();
    const m = new CopilotTokenManager({
      exchange: async () => tokenAt(t, 1, { expiresAt: undefined, refreshIn: undefined }),
      now: t.now,
      schedule: t.schedule,
      refreshMarginMs: 5 * 60_000,
    });
    await m.ensure();
    assert.deepEqual(t.pending(), [20 * 60_000]);
  });
});

describe('githubCopilotAuth', () => {
  const userAgent = 'benchsdk-runner/test';

  it('pat mode sends exactly the legacy headers', () => {
    const auth = githubCopilotAuth({ userAgent, env: { GITHUB_COPILOT_API_KEY: 'github_pat_x' } });
    assert.equal(auth.mode, 'pat');
    assert.deepEqual(auth.requiredEnvVars, ['GITHUB_COPILOT_API_KEY']);
    assert.equal(auth.prepare, undefined);
    assert.equal(auth.resolveHost, undefined);
    assert.deepEqual(Object.entries(auth.buildHeaders()), [
      ['X-GitHub-Api-Version', '2025-10-01'],
      ['User-Agent', userAgent],
      ['Authorization', 'Bearer github_pat_x'],
    ]);
  });

  it('cts mode sends the CTS token, editor headers, and endpoints.api host', async () => {
    const t = fakeTime();
    const manager = new CopilotTokenManager({ exchange: async () => tokenAt(t, 1), now: t.now, schedule: t.schedule });
    const auth = githubCopilotAuth({
      userAgent,
      env: { GITHUB_COPILOT_AUTH_MODE: 'cts', GITHUB_COPILOT_OAUTH_TOKEN: 'gho_x' },
      manager,
    });
    assert.equal(auth.mode, 'cts');
    assert.deepEqual(auth.requiredEnvVars, ['GITHUB_COPILOT_OAUTH_TOKEN']);
    assert.throws(() => auth.buildHeaders(), /not available/);
    assert.equal(auth.resolveHost?.(), DEFAULT_COPILOT_HOST);

    await auth.prepare?.();
    assert.deepEqual(auth.buildHeaders(), {
      'X-GitHub-Api-Version': '2025-10-01',
      'User-Agent': userAgent,
      Authorization: 'Bearer tid=token-1',
      'Copilot-Integration-Id': 'computesdk-benchmarks',
      'Editor-Version': 'vscode/1.105.1',
      'Editor-Plugin-Version': 'copilot-chat/0.32.4',
    });
    assert.equal(auth.resolveHost?.(), 'api.individual.githubcopilot.com');
  });

  it('cts mode falls back to the default host when endpoints.api is absent', async () => {
    const t = fakeTime();
    const manager = new CopilotTokenManager({
      exchange: async () => tokenAt(t, 1, { apiUrl: undefined }),
      now: t.now,
      schedule: t.schedule,
    });
    const auth = githubCopilotAuth({ userAgent, env: { GITHUB_COPILOT_AUTH_MODE: 'cts' }, manager });
    await auth.prepare?.();
    assert.equal(auth.resolveHost?.(), DEFAULT_COPILOT_HOST);
  });
});
