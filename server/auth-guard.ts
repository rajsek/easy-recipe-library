/**
 * Fail-closed auth guard. The app may serve without APP_TOKEN ONLY when it is
 * provably local: local bind host AND not running on a serverless platform.
 * Serverless (Vercel etc.) never trips the old HOST-based check, so it must be
 * detected from platform env vars instead.
 */
export interface GuardEnv {
  HOST?: string;
  APP_TOKEN?: string;
  VERCEL?: string;
  AWS_LAMBDA_FUNCTION_NAME?: string;
  K_SERVICE?: string;
  FUNCTIONS_WORKER_RUNTIME?: string;
}

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

export function isServerless(env: GuardEnv): boolean {
  return !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.K_SERVICE || env.FUNCTIONS_WORKER_RUNTIME);
}

/** Returns the refusal reason, or null when serving without a token is safe. */
export function authGuardViolation(env: GuardEnv): string | null {
  if (env.APP_TOKEN) return null;
  const host = env.HOST || '127.0.0.1';
  if (isServerless(env)) {
    return 'serverless platform detected (VERCEL/lambda/cloud-run) and APP_TOKEN is not set - refusing to serve an unauthenticated API. Set APP_TOKEN.';
  }
  if (!LOCAL_HOSTS.has(host)) {
    return `HOST=${host} is not local and APP_TOKEN is not set. Set APP_TOKEN in .env (see README "Security").`;
  }
  return null;
}
