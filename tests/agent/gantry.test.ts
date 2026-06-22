import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
  type MockInstance,
} from 'vitest';
import { mkdtempSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GantryRunner, type GantryHooks } from '../../src/agent/gantry.js';
import {
  AgentBudgetExceededError,
  AgentTimeoutError,
  AgentRateLimitedError,
} from '../../src/agent/errors.js';
import type { AgentRunOptions, AgentEvent } from '../../src/agent/runner.js';

// These tests never invoke the real gantry binary. They replay committed NDJSON
// streams (generated once against gantry v0.1.0 — see fixtures/gantry/README.md)
// through GantryRunner, with two shell stubs standing in for the binary:
//   * gantry-stub.sh      — replays a fixture, records argv, exits a chosen code
//   * gantry-stub-hang.sh — sleeps so stdout never closes (watchdog / SIGTERM)
// The runner has no public "parser" entry point, so each fixture is driven
// through `run()` two ways: with the stub exiting 0 (the fixture's `result`
// event is authoritative — the parse path) and with the real exit code (which
// matters only when no `result` event is present — the synthesis path).

const FIXDIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/gantry');
const STUB = join(FIXDIR, 'gantry-stub.sh');
const HANG = join(FIXDIR, 'gantry-stub-hang.sh');
const fix = (name: string): string => join(FIXDIR, name);

const PROFILE_DIR = '/wrily/profiles/review';
const OPUS_SLUG = 'anthropic/claude-opus-4-8';

let scratch: string;
let counter = 0;
let warnSpy: MockInstance<typeof console.warn>;

beforeAll(() => {
  // Committed with the exec bit, but make the stubs runnable defensively.
  chmodSync(STUB, 0o755);
  chmodSync(HANG, 0o755);
  scratch = mkdtempSync(join(tmpdir(), 'gantry-test-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  warnSpy?.mockClear();
});

// Keep the runner's best-effort warnings (malformed lines, schema drift) out of
// the test log while letting individual tests assert on them.
warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A unique scratch-file path for per-run side channels (argv dump, run log). */
function tmpFile(label: string): string {
  return join(scratch, `${label}-${counter++}`);
}

/** Child env for the replay stub. GantryRunner spawns with `{ env: req.env }`,
 *  so all stub control inputs must ride the returned env, not the ambient one. */
function replayEnv(
  fixture: string,
  opts: { exit?: number; argvOut?: string; runLog?: string } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GANTRY_STUB_FIXTURE: fix(fixture),
    GANTRY_STUB_EXIT: String(opts.exit ?? 0),
  };
  if (opts.argvOut) env.GANTRY_STUB_ARGV_OUT = opts.argvOut;
  if (opts.runLog) env.GANTRY_STUB_RUN_LOG = opts.runLog;
  return env;
}

function makeOpts(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: 'review this diff',
    model: OPUS_SLUG,
    maxTokens: 2_000_000,
    workingDir: '/repo',
    env: process.env,
    mode: 'single',
    ...overrides,
  };
}

function runner(binary = STUB, hooks?: GantryHooks): GantryRunner {
  return new GantryRunner({ binary, profileDir: PROFILE_DIR, hooks });
}

function readArgv(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

/** Value following `flag` in an argv list (`undefined` if the flag is absent). */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every value following each occurrence of `flag`, in order. */
function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]!);
  }
  return out;
}

describe('GantryRunner — completed run → AgentResult (result event authoritative)', () => {
  it('single run: maps assistant text, totals, cost, model, and buffers events', async () => {
    const res = await runner().run(makeOpts({ env: replayEnv('happy-single.ndjson') }));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('LGTM: no issues found.');
    expect(res.stderr).toBe('');
    expect(res.model).toBe(OPUS_SLUG);
    expect(res.durationMs).toBe(12);

    expect(res.events?.map((e) => e.event)).toEqual([
      'start',
      'agent_turn',
      'assistant_text',
      'result',
    ]);

    expect(res.tokenUsage).toMatchObject({
      inputTokens: 120,
      outputTokens: 24,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // opus rates input=5 output=25 per MTok → 120/1e6*5 + 24/1e6*25.
    expect(res.tokenUsage?.costUsd).toBeCloseTo((120 * 5 + 24 * 25) / 1_000_000, 8);
  });

  it('team run: final stdout is the coordinator (unify) text, not lane reports', async () => {
    const res = await runner().run(makeOpts({ mode: 'team', env: replayEnv('happy-team.ndjson') }));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Unified review across correctness and spec-compliance lanes.');
    // Lane reports (role !== coordinator) must not bleed into the final text.
    expect(res.stdout).not.toContain('Reviewed the change; one minor issue.');

    expect(res.events).toHaveLength(16);
    const kinds = res.events?.map((e) => e.event) ?? [];
    expect(kinds.filter((k) => k === 'subagent_spawn')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'subagent_done')).toHaveLength(2);
    expect(kinds).toContain('changes');

    expect(res.tokenUsage).toMatchObject({ inputTokens: 1600, outputTokens: 480 });
    expect(res.tokenUsage?.costUsd).toBeCloseTo((1600 * 5 + 480 * 25) / 1_000_000, 8);
  });
});

describe('GantryRunner — non-ok result.exit → mapped error', () => {
  it('budget (2) → AgentBudgetExceededError', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('budget.ndjson', { exit: 2 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentBudgetExceededError);
  });

  it('timeout (3) → AgentTimeoutError carrying the configured timeout', async () => {
    const err = await runner()
      .run(makeOpts({ timeoutMs: 4321, env: replayEnv('timeout.ndjson', { exit: 3 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTimeoutError);
    expect((err as AgentTimeoutError).timeoutMs).toBe(4321);
  });

  it('error (1) → generic Error carrying the provider message', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('error-provider.ndjson', { exit: 1 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^gantry: /);
    expect((err as Error).message).toContain('could not reach the server');
  });

  it('config (4) → "gantry config:" error (stream had no start event)', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('config.ndjson', { exit: 4 }) }))
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^gantry config: /);
  });

  it('team_collapse (error exit) → generic Error from the terminal error event', async () => {
    const err = await runner()
      .run(makeOpts({ mode: 'team', env: replayEnv('team-collapse.ndjson', { exit: 1 }) }))
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe('gantry: all subagents crashed or produced no output');
  });

  it('result.exit wins over the process exit code (budget result, child exits 0)', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('budget.ndjson', { exit: 0 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentBudgetExceededError);
  });
});

describe('GantryRunner — EOF without a result event → synthesize from exit code', () => {
  it('exit 2 → AgentBudgetExceededError', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('eof-no-result.ndjson', { exit: 2 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentBudgetExceededError);
  });

  it('exit 3 → AgentTimeoutError', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('eof-no-result.ndjson', { exit: 3 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTimeoutError);
  });

  it('exit 4 → "gantry config:" error (not mislabelled generic)', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('eof-no-result.ndjson', { exit: 4 }) }))
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^gantry config: /);
  });

  it('exit 5 → AgentRateLimitedError (recoverable, not mislabelled generic)', async () => {
    // tiny budget so the retry loop exhausts immediately without real delay.
    const err = await runner()
      .run(makeOpts({ timeoutMs: 50, env: replayEnv('eof-no-result.ndjson', { exit: 5 }) }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRateLimitedError);
  });

  it('exit 0 with no result → generic "exited 0 without a result event"', async () => {
    const err = await runner()
      .run(makeOpts({ env: replayEnv('eof-no-result.ndjson', { exit: 0 }) }))
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exited 0 without a result event/);
  });
});

describe('GantryRunner — rate_limited (exit 5) retry policy', () => {
  it('retries to the attempt cap, honoring retry_after_ms, then throws with the hint', async () => {
    const runLog = tmpFile('runlog');
    const err = await runner()
      .run(
        makeOpts({
          timeoutMs: 10_000,
          env: replayEnv('rate-limited-retry-hint.ndjson', { exit: 5, runLog }),
        }),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentRateLimitedError);
    expect((err as AgentRateLimitedError).retryAfterMs).toBe(5);
    // MAX_RATE_LIMIT_ATTEMPTS = 3 spawns.
    expect(readFileSync(runLog, 'utf8')).toBe('xxx');
  });

  it('no hint + exhausted remaining budget → throws on the first attempt, retryAfterMs 0', async () => {
    const runLog = tmpFile('runlog');
    const err = await runner()
      .run(
        makeOpts({
          timeoutMs: 50,
          env: replayEnv('rate-limited.ndjson', { exit: 5, runLog }),
        }),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentRateLimitedError);
    expect((err as AgentRateLimitedError).retryAfterMs).toBe(0);
    expect(readFileSync(runLog, 'utf8')).toBe('x');
  });
});

describe('GantryRunner — malformed NDJSON', () => {
  it('skips unparseable lines (warns) and still resolves the run', async () => {
    const res = await runner().run(makeOpts({ env: replayEnv('malformed-line.ndjson') }));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('LGTM: no issues found.');
    // The two bad lines are dropped; only the four valid events survive.
    expect(res.events?.map((e) => e.event)).toEqual([
      'start',
      'agent_turn',
      'assistant_text',
      'result',
    ]);
    // One warn for the non-JSON line, one for the JSON line lacking `event`.
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GantryRunner — watchdog + signal handling', () => {
  it('force-kills a wedged child whose stream never closes → AgentTimeoutError', async () => {
    // WATCHDOG_GRACE_MS is a fixed 30s constant; a negative per-run timeout
    // collapses the watchdog deadline (timeoutMs + grace) into test range
    // without faking the clock. The hang stub sleeps, so stdout never closes.
    const timeoutMs = -30_000 + 300;
    const err = await runner(HANG)
      .run(makeOpts({ timeoutMs, env: { ...process.env, GANTRY_STUB_SLEEP: '30' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentTimeoutError);
  }, 10_000);

  it.skipIf(process.platform === 'win32')(
    'forwards a SIGTERM received by this process to the child',
    async () => {
      const marker = tmpFile('sigterm');
      let signalReady: () => void;
      const ready = new Promise<void>((resolve) => {
        signalReady = resolve;
      });
      // The hang stub installs its TERM trap before emitting the preamble, so a
      // `start` event guarantees the child is alive AND trap-armed.
      const r = runner(HANG, {
        onEvent(e: AgentEvent) {
          if (e.event === 'start') signalReady();
        },
      });

      const before = new Set(process.listeners('SIGTERM'));
      const p = r
        .run(
          makeOpts({
            env: {
              ...process.env,
              GANTRY_STUB_FIXTURE: fix('eof-no-result.ndjson'),
              GANTRY_STUB_SIGTERM_MARKER: marker,
              GANTRY_STUB_SLEEP: '30',
            },
          }),
        )
        .catch((e: unknown) => e);

      await ready;
      const added = process.listeners('SIGTERM').filter((l) => !before.has(l));
      expect(added).toHaveLength(1);
      // Simulate this process receiving SIGTERM — invoke only the runner's
      // forwarder, never the real signal (which would kill the test runner).
      (added[0] as () => void)();

      await p; // child traps the forwarded SIGTERM → writes marker → exits → run settles
      expect(readFileSync(marker, 'utf8')).toBe('got-sigterm');
    },
    10_000,
  );
});

describe('GantryRunner — argv assembly + alias resolution', () => {
  it('single mode: resolves the alias before spawn and emits the required flags', async () => {
    const argvOut = tmpFile('argv');
    await runner().run(
      makeOpts({
        model: 'opus', // alias — must be canonicalized before reaching the child
        mode: 'single',
        workingDir: '/work/repo',
        maxTokens: 1234,
        timeoutMs: 5678,
        skillsDir: '/stage/skills',
        extraSkills: ['x-skill', 'y-skill'],
        env: replayEnv('happy-single.ndjson', { argvOut }),
      }),
    );
    const argv = readArgv(argvOut);

    expect(flagValue(argv, '--profile')).toBe(PROFILE_DIR);
    expect(flagValue(argv, '--mode')).toBe('single');
    expect(flagValue(argv, '--model')).toBe(OPUS_SLUG);
    expect(flagValue(argv, '--workdir')).toBe('/work/repo');
    expect(flagValue(argv, '--max-tokens')).toBe('1234');
    expect(flagValue(argv, '--timeout-ms')).toBe('5678');
    expect(flagValue(argv, '--prompt-file')).toMatch(/prompt\.md$/);
    expect(flagValue(argv, '--skills-dir')).toBe('/stage/skills');
    // --inject-skill order preserved, appended after the profile's invariant set.
    expect(flagValues(argv, '--inject-skill')).toEqual(['x-skill', 'y-skill']);
    // --unify-file is team-only.
    expect(argv).not.toContain('--unify-file');
  });

  it('team mode: includes --unify-file when a unify path is supplied', async () => {
    const argvOut = tmpFile('argv');
    await runner().run(
      makeOpts({
        mode: 'team',
        unifyPromptPath: '/tmp/unify.md',
        env: replayEnv('happy-team.ndjson', { argvOut }),
      }),
    );
    const argv = readArgv(argvOut);
    expect(flagValue(argv, '--mode')).toBe('team');
    expect(flagValue(argv, '--unify-file')).toBe('/tmp/unify.md');
  });

  it('single mode: omits --unify-file even when a unify path is supplied', async () => {
    const argvOut = tmpFile('argv');
    await runner().run(
      makeOpts({
        mode: 'single',
        unifyPromptPath: '/tmp/unify.md',
        env: replayEnv('happy-single.ndjson', { argvOut }),
      }),
    );
    expect(readArgv(argvOut)).not.toContain('--unify-file');
  });

  it('omits --skills-dir and --inject-skill when none are supplied', async () => {
    const argvOut = tmpFile('argv');
    await runner().run(makeOpts({ env: replayEnv('happy-single.ndjson', { argvOut }) }));
    const argv = readArgv(argvOut);
    expect(argv).not.toContain('--skills-dir');
    expect(argv).not.toContain('--inject-skill');
  });
});
