import { z } from 'zod';
import type { ReviewType } from '../config/types.js';

const baseFields = {
  severity: z.enum(['critical', 'important', 'minor']),
  path: z.string().min(1),
  line: z.number().int().nonnegative(),
  side: z.enum(['LEFT', 'RIGHT']),
  message: z.string().min(1),
};

export const newCommentSchema = z.object({
  action: z.literal('new_comment'),
  ...baseFields,
});

export const replyInThreadSchema = z.object({
  action: z.literal('reply_in_thread'),
  ...baseFields,
  thread_id: z.string().min(1),
});

export const suppressSchema = z.object({
  action: z.literal('suppress'),
  ...baseFields,
  thread_id: z.string().min(1),
});

// resolve_thread is a model-emitted variant of suppress: the model has
// decided a prior Wrily thread is fully addressed and the thread should be
// resolved via the GraphQL resolveReviewThread mutation. Same routing as
// suppress (no inline comment, mutation by thread_id).
export const resolveThreadSchema = z.object({
  action: z.literal('resolve_thread'),
  ...baseFields,
  thread_id: z.string().min(1),
});

export const findingSchema = z.discriminatedUnion('action', [
  newCommentSchema,
  replyInThreadSchema,
  suppressSchema,
  resolveThreadSchema,
]);

// Claude routinely emits `null` for unset confidence fields rather than
// omitting them. Accept both null and undefined for all soft fields.
export const confidenceSchema = z.object({
  tier: z.number().int().min(1).max(4).nullable().optional(),
  score: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  rounds: z.number().int().nonnegative(),
  unresolved_critical: z.number().int().nonnegative(),
  unresolved_important: z.number().int().nonnegative(),
  unresolved_minor: z.number().int().nonnegative(),
  simplification_applied: z.boolean(),
  skipped_reason: z.string().nullable().optional(),
});

export const verdictSchema = z.enum(['ready', 'with-fixes', 'not-ready']);

export const reviewSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  strengths: z.array(z.string()),
  confidence: confidenceSchema.optional(),
  verdict: verdictSchema.nullable().optional(),
});

export type NewCommentFinding = z.infer<typeof newCommentSchema>;
export type ReplyInThreadFinding = z.infer<typeof replyInThreadSchema>;
export type SuppressFinding = z.infer<typeof suppressSchema>;
export type ResolveThreadFinding = z.infer<typeof resolveThreadSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Review = z.infer<typeof reviewSchema>;

export class ExtractError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/;

// Fallback for when the model emits prose instead of JSON-in-fence and the
// prose plainly says "delta clean" / "no findings". We synthesize an empty
// Review so the workflow can render a delta-clean body without bailing.
// Prompt strengthening pushes models toward emitting the fence; this is a
// safety net for the long tail.
const DELTA_CLEAN_RE = /\b(?:delta\s*clean|no\s+(?:new\s+)?(?:critical|important|actionable)?\s*findings)\b/i;

const RAW_MAX = 2_000;
const truncateRaw = (s: string): string =>
  s.length > RAW_MAX ? `${s.slice(0, RAW_MAX)}…[truncated ${s.length - RAW_MAX}B]` : s;

export function extractFindings(
  modelReply: string,
  opts: { reviewType?: ReviewType } = {},
): Review {
  const match = modelReply.match(FENCE_RE);
  if (!match || !match[1]) {
    if (opts.reviewType === 'delta' && DELTA_CLEAN_RE.test(modelReply)) {
      const summary = modelReply.trim().split('\n')[0]?.slice(0, 280) ?? 'Delta clean.';
      return { summary, findings: [], strengths: [] };
    }
    throw new ExtractError('No ```json fence found in model reply', truncateRaw(modelReply));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new ExtractError(
      `Malformed JSON in fence: ${(err as Error).message}`,
      truncateRaw(match[1]),
    );
  }

  const result = reviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExtractError(`Schema violation: ${result.error.message}`, truncateRaw(match[1]));
  }

  return result.data;
}
