import { readDotEnv } from './dotenv.js';
import { requireSupabaseBinary, runSupabase } from './supabaseCli.js';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

function projectRefFromUrl(url: string): string {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/);
  if (!m || !m[1]) throw new Error(`Cannot derive project ref from SUPABASE_URL: ${url}`);
  return m[1];
}

export async function migrateCommand(): Promise<number> {
  requireSupabaseBinary();
  const env = readDotEnv(ENV_PATH);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Wrily persistence is not configured. Run `./wrily persistence init` first.');
    return 1;
  }
  const ref = projectRefFromUrl(env.SUPABASE_URL);
  console.log(`Linking to project ${ref}...`);
  await runSupabase(['link', '--project-ref', ref]).catch((err) => {
    if (!String(err.message).includes('already linked')) throw err;
  });
  console.log('Applying migrations (supabase db push --include-all)...');
  const res = await runSupabase(['db', 'push', '--include-all']);
  process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  console.log('✓ Migrations applied.');
  return 0;
}

migrateCommand().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
