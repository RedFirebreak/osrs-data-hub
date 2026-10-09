import { OFFBOARD_REASONS } from '@hub/db';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_CAUSES,
  API_AUTH_FAILURES,
  API_RATE_LIMITS,
  DATA_EXPORT_RESULTS,
  DISCORD_VERIFY_BREAKER_RULES,
  DISCORD_VERIFY_FAILURE_KINDS,
  DISCORD_VERIFY_VERDICTS,
  HISCORE_LOOKUP_RESULTS,
  INGEST_IGNORED_REASONS,
  JOB_NAMES,
  JOB_RESULTS,
  PAIR_RESULTS,
  createTestMetrics,
  type HubMetrics,
} from './metrics';

/** Every hub_* sample of a fresh registry as "name{labels} value", without the process metrics. */
async function startupSamples(): Promise<string[]> {
  const text = await createTestMetrics().registry.metrics();
  return text
    .split('\n')
    .filter((line) => line.startsWith('hub_') && !/^hub_(process|nodejs)_/.test(line))
    .filter((line) => !line.includes('_bucket{'));
}

const series = (name: string, label: string, values: readonly string[]) =>
  values.map((value) => `${name}{${label}="${value}"} 0`);

describe('metrics at startup', () => {
  /**
   * The names, labels and values the dashboard and the alert rules in ops/ query (D-85), written out
   * rather than taken from the arrays: a renamed value has to fail here.
   */
  it('exposes every series of a fixed label set at 0 (PROM-1)', async () => {
    const samples = await startupSamples();

    expect(samples).toEqual(
      expect.arrayContaining([
        ...series('hub_ingest_ignored_total', 'reason', ['no_identity', 'blocked']),
        ...series('hub_pair_attempts_total', 'result', [
          'decommissioned',
          'locked_out',
          'rate_limited_global',
          'rate_limited_ip',
          'malformed',
          'outdated',
          'invalid',
          'inactive',
          'paired',
          'unavailable',
          'error',
        ]),
        ...series('hub_discord_verify_failures_total', 'kind', [
          'config',
          'auth',
          'rate_limited',
          'unavailable',
        ]),
        ...series('hub_discord_verify_checks_total', 'verdict', [
          'member',
          'not_member',
          'missing_role',
          'error',
        ]),
        ...series('hub_discord_verify_breaker_trips_total', 'rule', ['batch', 'window']),
        ...series('hub_offboarded_users_total', 'reason', [
          'left_guild',
          'lost_role',
          'admin',
          'self_delete',
        ]),
        ...series('hub_accounts_deleted_total', 'cause', ['grace_expiry', 'orphan_purge']),
        ...series('hub_data_exports_total', 'result', [
          'completed',
          'failed',
          'cancelled',
          'rate_limited',
        ]),
        ...series('hub_api_rate_limited_total', 'limit', ['key', 'snapshot', 'auth_ip']),
        ...series('hub_api_auth_failures_total', 'reason', [
          'missing',
          'malformed',
          'unknown',
          'revoked',
          'expired',
          'inactive_user',
        ]),
        ...['close-stale-sessions', 'reverify-members', 'expire-grace', 'prune-audit-log'].flatMap(
          (job) => [
            `hub_job_runs_total{job_name="${job}",result="success"} 0`,
            `hub_job_runs_total{job_name="${job}",result="failure"} 0`,
            `hub_job_duration_seconds_count{job_name="${job}"} 0`,
            `hub_job_duration_seconds_sum{job_name="${job}"} 0`,
          ],
        ),
      ]),
    );
  });

  it('has no labelled series at startup beyond the fixed sets', async () => {
    const labelled = (await startupSamples()).filter((line) => line.includes('{'));
    const fixed =
      INGEST_IGNORED_REASONS.length +
      PAIR_RESULTS.length +
      DISCORD_VERIFY_FAILURE_KINDS.length +
      DISCORD_VERIFY_VERDICTS.length +
      DISCORD_VERIFY_BREAKER_RULES.length +
      OFFBOARD_REASONS.length +
      ACCOUNT_DELETION_CAUSES.length +
      DATA_EXPORT_RESULTS.length +
      API_RATE_LIMITS.length +
      API_AUTH_FAILURES.length +
      HISCORE_LOOKUP_RESULTS.length +
      // Per job: one counter per result, plus the histogram's _sum and _count.
      JOB_NAMES.length * (JOB_RESULTS.length + 2);

    expect(labelled).toHaveLength(fixed);
    expect(labelled.every((line) => line.endsWith(' 0'))).toBe(true);
  });

  it('only takes label values of the fixed sets (checked by the compiler)', () => {
    const misuse = (m: HubMetrics) => {
      // @ts-expect-error not a PAIR_RESULTS value
      m.pairAttempts.inc({ result: 'nope' });
      // @ts-expect-error not an API_AUTH_FAILURES value
      m.apiAuthFailures.inc({ reason: 'nope' });
      // @ts-expect-error not a JOB_NAMES value
      m.jobRuns.inc({ job_name: 'nope', result: 'success' });
      // @ts-expect-error the label is `cause`
      m.accountsDeleted.inc({ reason: 'grace_expiry' });
    };
    expect(misuse).toBeTypeOf('function');
  });
});
