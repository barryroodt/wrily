import { readDotEnv, appendDotEnv, hasKey } from './dotenv.js';
import { requireSupabaseBinary, runSupabase } from './supabaseCli.js';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ENV_PATH = resolve(process.cwd(), '.env');
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

async function prompt(label: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const ans = await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `);
    return ans.trim() || fallback || '';
  } finally {
    rl.close();
  }
}

async function ensureLoggedIn(): Promise<void> {
  try {
    await runSupabase(['projects', 'list', '--output', 'json']);
  } catch (err) {
    if (!/Access token not provided|login/i.test((err as Error).message)) throw err;
    console.log('Not logged in to Supabase. Opening browser for login...');
    await runSupabase(['login']);
  }
}

type Org = { id: string; name: string };

async function pickOrg(): Promise<Org> {
  const res = await runSupabase(['orgs', 'list', '--output', 'json']);
  const orgs = JSON.parse(res.stdout) as Org[];
  if (orgs.length === 0) throw new Error('No Supabase organizations found for this account.');
  if (orgs.length === 1) {
    console.log(`Using organization: ${orgs[0]!.name} (${orgs[0]!.id})`);
    return orgs[0]!;
  }
  console.log('Available organizations:');
  orgs.forEach((o, i) => console.log(`  ${i + 1}. ${o.name} (${o.id})`));
  const pick = await prompt(`Choose (1-${orgs.length})`, '1');
  const idx = Number.parseInt(pick, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= orgs.length) throw new Error('Invalid org selection.');
  return orgs[idx]!;
}

function defaultProjectName(): string {
  return `wrily-${randomBytes(3).toString('hex')}`;
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

type ApiKey = { name: string; api_key: string };

async function fetchServiceRoleKey(ref: string): Promise<string | null> {
  try {
    const res = await runSupabase(['projects', 'api-keys', 'list', '--project-ref', ref, '--output', 'json']);
    const keys = JSON.parse(res.stdout) as ApiKey[];
    return keys.find((k) => k.name === 'service_role')?.api_key ?? null;
  } catch {
    return null;
  }
}

async function pollUntilReady(ref: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const key = await fetchServiceRoleKey(ref);
    if (key) return key;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Project ${ref} did not become ready within ${Math.round(POLL_TIMEOUT_MS / 60_000)} minutes. ` +
      'Re-run `./wrily persistence migrate` once the dashboard shows the project as healthy.',
  );
}

export async function initCommand(): Promise<number> {
  requireSupabaseBinary();

  if (hasKey(ENV_PATH, 'SUPABASE_URL') || hasKey(ENV_PATH, 'SUPABASE_SERVICE_ROLE_KEY')) {
    console.error(
      '.env already contains Supabase credentials. ' +
        'Run `./wrily persistence migrate` to apply pending migrations to an existing project, ' +
        'or remove the existing entries manually first.',
    );
    return 1;
  }
  // Use readDotEnv to enforce the in-memory contract before any side effects.
  void readDotEnv(ENV_PATH);

  await ensureLoggedIn();
  const org = await pickOrg();

  const name = await prompt('Project name', defaultProjectName());
  const region = await prompt('Region', 'us-east-1');
  const password = generatePassword();
  console.log(`Generated DB password: ${password}`);
  console.log('Save this somewhere safe — it is only needed for dashboard SQL access, not for Wrily writes.');

  console.log(`Creating project ${name} in ${region}...`);
  const created = await runSupabase([
    'projects', 'create', name,
    '--org-id', org.id,
    '--region', region,
    '--db-password', password,
    '--output', 'json',
  ]);
  const parsed = JSON.parse(created.stdout) as { id?: string; ref?: string };
  const ref = parsed.ref ?? parsed.id;
  if (!ref) throw new Error(`Could not parse project ref from supabase output: ${created.stdout}`);

  console.log(`Waiting for project ${ref} to become ready (up to 5 min)`);
  const serviceRoleKey = await pollUntilReady(ref);
  console.log(' ready.');

  const url = `https://${ref}.supabase.co`;
  appendDotEnv(ENV_PATH, {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
  console.log(`✓ Credentials written to ${ENV_PATH}`);

  console.log('Linking + applying migrations...');
  await runSupabase(['link', '--project-ref', ref, '--password', password]);
  const push = await runSupabase(['db', 'push', '--include-all']);
  process.stdout.write(push.stdout);

  console.log('');
  console.log(`✓ Project ready: ${name} (${region})`);
  console.log('✓ Migrations applied: 0001_review_runs.sql, 0002_views.sql');
  console.log('Next: open a PR; rows will land here. Query with `./wrily costs`.');
  return 0;
}

initCommand().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
