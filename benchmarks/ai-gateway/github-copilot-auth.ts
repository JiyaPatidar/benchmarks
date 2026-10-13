/**
 * Auth for the `github-copilot` AI-gateway participant.
 *
 * - `pat` (default): send the fine-grained PAT in `GITHUB_COPILOT_API_KEY`
 *   directly as the bearer token (unchanged legacy behaviour).
 * - `cts` (opt-in, `GITHUB_COPILOT_AUTH_MODE=cts`): exchange the `gho_`/`ghu_`
 *   user token in `GITHUB_COPILOT_OAUTH_TOKEN` for a short-lived Copilot
 *   (CTS) token, the way VS Code does, and send that instead. CAPI can then
 *   skip authnd/authzd on each request (github/copilot-api#39506). The token
 *   is minted once, cached, and refreshed in the background before it
 *   expires. A fine-grained PAT cannot mint a CTS token (HTTP 403).
 */
import {
  COPILOT_EDITOR_HEADERS,
  exchangeCopilotToken,
  maskSecrets,
  type TokenExchangeResult,
} from './github-copilot-host.js';

export type CopilotAuthMode = 'pat' | 'cts';

export const DEFAULT_COPILOT_HOST = 'api.githubcopilot.com';
const GITHUB_API_VERSION = '2025-10-01';
const CTS_INTEGRATION_ID = 'computesdk-benchmarks';
/** Used when the CTS response omits `expires_at` (matches the reference script). */
const FALLBACK_TTL_MS = 25 * 60_000;

export function resolveCopilotAuthMode(env: NodeJS.ProcessEnv = process.env): CopilotAuthMode {
  const raw = (env.GITHUB_COPILOT_AUTH_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'pat') return 'pat';
  if (raw === 'cts') return 'cts';
  throw new Error(`Invalid GITHUB_COPILOT_AUTH_MODE=${JSON.stringify(env.GITHUB_COPILOT_AUTH_MODE)} (expected "pat" or "cts")`);
}

type Schedule = (fn: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface CopilotTokenManagerOptions {
  /** Mints a CTS token. Returns undefined on failure. */
  exchange: () => Promise<TokenExchangeResult | undefined>;
  now?: () => number;
  schedule?: Schedule;
  log?: (message: string) => void;
  /** Refresh at least this long before `expires_at`. */
  refreshMarginMs?: number;
  /** Treat the token as unusable this long before `expires_at`. */
  expirySkewMs?: number;
  /** Delay before retrying a failed background refresh. */
  retryDelayMs?: number;
}

interface CachedToken {
  token: string;
  apiHost?: string;
  expiresAtMs: number;
}

/**
 * Caches a CTS token and keeps it fresh. `ensure()` is async and
 * single-flight; `token()`/`apiHost()` are sync so they can be used from the
 * provider's sync `buildHeaders()` once `ensure()` has resolved.
 */
export class CopilotTokenManager {
  private current?: CachedToken;
  private inflight?: Promise<CachedToken>;
  private cancelTimer?: () => void;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly log: (message: string) => void;
  private readonly refreshMarginMs: number;
  private readonly expirySkewMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: CopilotTokenManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.log = opts.log ?? (() => {});
    this.refreshMarginMs = opts.refreshMarginMs ?? 5 * 60_000;
    this.expirySkewMs = opts.expirySkewMs ?? 60_000;
    this.retryDelayMs = opts.retryDelayMs ?? 30_000;
  }

  private isUsable(t: CachedToken | undefined): t is CachedToken {
    return !!t && this.now() < t.expiresAtMs - this.expirySkewMs;
  }

  /** Ensures a usable token is cached, minting one if needed. */
  async ensure(): Promise<void> {
    if (this.isUsable(this.current)) return;
    await this.mint();
  }

  /** Current CTS token. Throws if `ensure()` hasn't produced a usable one. */
  token(): string {
    if (!this.isUsable(this.current)) {
      throw new Error('GitHub Copilot CTS token is not available (missing or expired); call ensure() first');
    }
    return this.current.token;
  }

  /** API host from the token's `endpoints.api`, if the CTS response included one. */
  apiHost(): string | undefined {
    return this.current?.apiHost;
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private mint(): Promise<CachedToken> {
    if (!this.inflight) {
      this.inflight = this.doMint().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async doMint(): Promise<CachedToken> {
    const result = await this.opts.exchange();
    if (!result) throw new Error('GitHub Copilot CTS token exchange failed');

    const now = this.now();
    const expiresAtMs = result.expiresAt !== undefined ? result.expiresAt * 1000 : now + FALLBACK_TTL_MS;
    const cached: CachedToken = {
      token: result.sessionToken,
      apiHost: hostFromUrl(result.apiUrl),
      expiresAtMs,
    };
    this.current = cached;

    const byExpiry = expiresAtMs - this.refreshMarginMs - now;
    const byRefreshIn = result.refreshIn !== undefined ? result.refreshIn * 1000 : Infinity;
    const delay = Math.max(1_000, Math.min(byExpiry, byRefreshIn));
    this.log(
      `CTS token minted (expires_at=${new Date(expiresAtMs).toISOString()}, host=${cached.apiHost ?? DEFAULT_COPILOT_HOST}); next refresh in ${Math.round(delay / 1000)}s`,
    );
    this.scheduleRefresh(delay);
    return cached;
  }

  private scheduleRefresh(delayMs: number): void {
    this.stop();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      this.mint().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`CTS token refresh failed (${maskSecrets(msg)}); retrying in ${Math.round(this.retryDelayMs / 1000)}s`);
        this.scheduleRefresh(this.retryDelayMs);
      });
    }, delayMs);
  }
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export interface GitHubCopilotAuth {
  mode: CopilotAuthMode;
  requiredEnvVars: string[];
  /** Auth + Copilot headers for a CAPI request. Sync; in CTS mode requires `prepare()` first. */
  buildHeaders: () => Record<string, string>;
  /** CTS mode only: mints/refreshes the cached token before a request. */
  prepare?: () => Promise<void>;
  /** CTS mode only: host from the token's `endpoints.api`, else the default. */
  resolveHost?: () => string;
}

export interface GitHubCopilotAuthOptions {
  userAgent: string;
  env?: NodeJS.ProcessEnv;
  /** Override the token manager (tests). Defaults to a process-wide shared one. */
  manager?: CopilotTokenManager;
}

let sharedManager: CopilotTokenManager | undefined;

function getSharedManager(env: NodeJS.ProcessEnv): CopilotTokenManager {
  if (!sharedManager) {
    const log = (message: string) => console.error(`[github-copilot] ${maskSecrets(message)}`);
    sharedManager = new CopilotTokenManager({
      exchange: () => {
        const oauthToken = env.GITHUB_COPILOT_OAUTH_TOKEN;
        if (!oauthToken) return Promise.resolve(undefined);
        return exchangeCopilotToken(oauthToken, log);
      },
      log,
    });
  }
  return sharedManager;
}

export function githubCopilotAuth(opts: GitHubCopilotAuthOptions): GitHubCopilotAuth {
  const env = opts.env ?? process.env;
  const mode = resolveCopilotAuthMode(env);

  if (mode === 'pat') {
    return {
      mode,
      requiredEnvVars: ['GITHUB_COPILOT_API_KEY'],
      buildHeaders: () => ({
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': opts.userAgent,
        Authorization: `Bearer ${env.GITHUB_COPILOT_API_KEY || ''}`,
      }),
    };
  }

  const manager = opts.manager ?? getSharedManager(env);
  return {
    mode,
    requiredEnvVars: ['GITHUB_COPILOT_OAUTH_TOKEN'],
    buildHeaders: () => ({
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': opts.userAgent,
      Authorization: `Bearer ${manager.token()}`,
      'Copilot-Integration-Id': CTS_INTEGRATION_ID,
      ...COPILOT_EDITOR_HEADERS,
    }),
    prepare: () => manager.ensure(),
    resolveHost: () => manager.apiHost() ?? DEFAULT_COPILOT_HOST,
  };
}
