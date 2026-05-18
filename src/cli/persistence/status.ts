import { readDotEnv } from './dotenv.js';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

const ENV_PATH = resolve(process.cwd(), '.env');
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase', 'migrations');

export async function statusCommand(): Promise<number> {
  const env = readDotEnv(ENV_PATH);
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('Wrily persistence: disabled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env)');
    return 0;
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'count=exact',
  };

  const reachable = await fetch(`${url}/rest/v1/review_runs?select=id&limit=0`, { headers });
  if (reachable.status === 404 || reachable.status === 400) {
    console.log('Wrily persistence: project reachable but migrations not applied.');
    console.log('Run `./wrily persistence migrate` to apply them.');
    return 0;
  }
  if (!reachable.ok) {
    console.error(`Wrily persistence: error reaching Supabase (${reachable.status})`);
    return 1;
  }

  const runsCount = parseCount(reachable.headers.get('content-range'));
  const subRes = await fetch(`${url}/rest/v1/review_subagent_runs?select=id&limit=0`, { headers });
  const subsCount = subRes.ok ? parseCount(subRes.headers.get('content-range')) : 'unknown';

  const localMigrations = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  console.log('Wrily persistence: enabled');
  console.log(`  URL:                       ${url}`);
  console.log(`  review_runs rows:          ${runsCount}`);
  console.log(`  review_subagent_runs rows: ${subsCount}`);
  console.log(`  migration files in repo:   ${localMigrations.length}`);
  for (const m of localMigrations) console.log(`    - ${m}`);
  return 0;
}

function parseCount(contentRange: string | null): string {
  if (!contentRange) return 'unknown';
  const slash = contentRange.indexOf('/');
  return slash >= 0 ? contentRange.slice(slash + 1) : 'unknown';
}

statusCommand().then((code) => process.exit(code)).catch((err) => {
  console.error(`status failed: ${(err as Error).message}`);
  process.exit(1);
});
