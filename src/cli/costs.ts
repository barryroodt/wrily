import { readDotEnv } from './persistence/dotenv.js';
import { queryCosts } from '../persist/supabase.js';
import type { RuntimeEnv } from '../config/types.js';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

type Args = {
  sinceDays: number;
  by: 'repo' | 'model' | 'day';
  repo?: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { sinceDays: 30, by: 'repo', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' || a === '-s') {
      const v = argv[++i] ?? '';
      const m = v.match(/^(\d+)d$/);
      if (!m || !m[1]) throw new Error(`--since expects e.g. 7d or 30d, got: ${v}`);
      out.sinceDays = Number.parseInt(m[1], 10);
    } else if (a === '--by') {
      const v = argv[++i] ?? '';
      if (v !== 'repo' && v !== 'model' && v !== 'day') throw new Error(`--by must be repo|model|day, got: ${v}`);
      out.by = v;
    } else if (a === '--repo') {
      out.repo = argv[++i];
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: wrily costs [--since 30d] [--by repo|model|day] [--repo owner/repo] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmt = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(fmt(cols));
  console.log(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(fmt(cols.map((c) => String(r[c] ?? ''))));
}

async function main(): Promise<number> {
  const env = readDotEnv(ENV_PATH);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Wrily persistence is not configured. Run `./wrily persistence init` first.');
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  const runtimeEnv = { supabase: { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY } } as unknown as RuntimeEnv;
  const result = await queryCosts(runtimeEnv, { sinceDays: args.sinceDays, by: args.by, repo: args.repo });
  if (args.json) {
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    console.log(`Wrily spend (last ${args.sinceDays}d, by ${args.by}):`);
    printTable(result.rows);
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
