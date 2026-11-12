import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localEnvPath = path.join(backendRoot, '.env.local');

const requiredVariables = [
  'NPL_LOCAL_SUPABASE_URL',
  'NPL_LOCAL_SUPABASE_SERVICE_ROLE_KEY',
  'NPL_LOCAL_SUPABASE_ANON_KEY',
] as const;

for (const name of requiredVariables) delete process.env[name];
const localEnvironment = config({ path: localEnvPath, override: true });
if (localEnvironment.error) {
  console.error('BLOCKED: PostgreSQL integration environment is unavailable; NPL-Backend/.env.local could not be loaded.');
  process.exitCode = 2;
}

const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (process.exitCode !== 2 && missingVariables.length) {
  console.error(`BLOCKED: PostgreSQL integration environment is unavailable; set ${missingVariables.join(', ')}.`);
  process.exitCode = 2;
} else if (process.exitCode !== 2) {
  let url: URL | null = null;
  try {
    url = new URL(process.env.NPL_LOCAL_SUPABASE_URL!);
  } catch {
    console.error('BLOCKED: NPL_LOCAL_SUPABASE_URL is not a valid URL.');
    process.exitCode = 2;
  }
  const hostname = url?.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (process.exitCode !== 2
    && (!['http:', 'https:'].includes(url!.protocol)
      || !['127.0.0.1', 'localhost', '::1'].includes(hostname!))) {
    console.error('BLOCKED: refusing to run integration tests against a non-loopback Supabase URL.');
    process.exitCode = 2;
  } else if (process.exitCode !== 2) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'tests/ingestion-postgres.integration.test.ts'],
      { cwd: backendRoot, env: process.env, stdio: 'inherit' },
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
