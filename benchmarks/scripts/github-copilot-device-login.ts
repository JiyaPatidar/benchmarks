/**
 * GitHub OAuth device-flow login, for LOCAL testing of the `github-copilot`
 * AI-gateway participant in CTS mode (`GITHUB_COPILOT_AUTH_MODE=cts`).
 *
 * Prints the resulting `gho_` user token to stdout (and nothing else), so:
 *
 *   export GITHUB_COPILOT_OAUTH_TOKEN="$(npx tsx benchmarks/scripts/github-copilot-device-login.ts)"
 *
 * The default client ID is VS Code's GitHub OAuth app, which is on the CTS
 * allowlist. That is a TEMPORARY stand-in until a dedicated benchmark app is
 * allowlisted; override with `--client-id <id>` or `GITHUB_COPILOT_CLIENT_ID`.
 * Do not use this in CI and never commit the printed token.
 */
const DEFAULT_CLIENT_ID = '01ab8ac9400c4e429b23';
const SCOPE = 'read:user';

function parseClientId(argv: string[]): string {
  const idx = argv.indexOf('--client-id');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith('--client-id='));
  if (eq) return eq.slice('--client-id='.length);
  return process.env.GITHUB_COPILOT_CLIENT_ID || DEFAULT_CLIENT_ID;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${url} returned HTTP ${res.status} with a non-JSON body`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const clientId = parseClientId(process.argv.slice(2));
  const device = await postForm('https://github.com/login/device/code', { client_id: clientId, scope: SCOPE });
  if (typeof device.device_code !== 'string') {
    throw new Error(`device code request failed: ${String(device.error ?? 'unknown error')}`);
  }

  process.stderr.write(`\n>> Open ${String(device.verification_uri)} and enter code: ${String(device.user_code)}\n\n`);

  let interval = typeof device.interval === 'number' ? device.interval : 5;
  const deadline = Date.now() + (typeof device.expires_in === 'number' ? device.expires_in : 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof res.access_token === 'string') {
      process.stderr.write('Signed in.\n');
      process.stdout.write(`${res.access_token}\n`);
      return;
    }
    if (res.error === 'slow_down') interval += 5;
    else if (res.error !== 'authorization_pending') {
      throw new Error(`device flow failed: ${String(res.error ?? 'unknown error')}`);
    }
  }
  throw new Error('device flow timed out');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
