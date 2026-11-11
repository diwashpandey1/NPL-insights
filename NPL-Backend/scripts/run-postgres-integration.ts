import { spawnSync } from 'node:child_process';

const requiredVariables = [
  'NPL_LOCAL_SUPABASE_URL',
  'NPL_LOCAL_SUPABASE_SERVICE_ROLE_KEY',
  'NPL_LOCAL_SUPABASE_ANON_KEY',
] as const;

const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (missingVariables.length) {
  console.error(`BLOCKED: PostgreSQL integration environment is unavailable; set ${missingVariables.join(', ')}.`);
  process.exitCode = 2;
} else {
  let url: URL;
  try {
    url = new URL(process.env.NPL_LOCAL_SUPABASE_URL!);
  } catch {
    console.error('BLOCKED: NPL_LOCAL_SUPABASE_URL is not a valid URL.');
    process.exitCode = 2;
  }
  if (process.exitCode !== 2 && !['127.0.0.1', 'localhost', '::1'].includes(url!.hostname)) {
    console.error('BLOCKED: refusing to run integration tests against a non-loopback Supabase URL.');
    process.exitCode = 2;
  } else if (process.exitCode !== 2) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'tests/ingestion-postgres.integration.test.ts'],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    );
    if (result.error) {
      console.error(`FAILED: could not start PostgreSQL integration tests: ${result.error.message}`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
      console.log(result.status === 0 ? 'PASSED: PostgreSQL integration tests executed.' : 'FAILED: PostgreSQL integration tests failed.');
    }
  }
}
