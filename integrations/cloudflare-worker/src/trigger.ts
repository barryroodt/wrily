// Parses an issue_comment body for a Wrily re-request trigger.
// Spec: docs/superpowers/specs/2026-04-30-reply-as-feedback-design.md §1.

export type TriggerResult = { scope_override: "full" | "delta" };

const TRIGGER_RE = /^\s*(?:\/wrily|@wrily)\s+review(?:\s+(full))?\s*$/i;

export function parseTrigger(body: string): TriggerResult | null {
  if (!body) return null;
  // Track the opening fence character so a "```"-opened block isn't accidentally
  // closed by "~~~" (or vice versa). GFM requires the closing fence to match.
  let openFence: "`" | "~" | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const stripped = rawLine.replace(/^\s+/, "");
    if (openFence === null) {
      if (stripped.startsWith("```")) {
        openFence = "`";
        continue;
      }
      if (stripped.startsWith("~~~")) {
        openFence = "~";
        continue;
      }
    } else {
      const closer = openFence === "`" ? "```" : "~~~";
      if (stripped.startsWith(closer)) {
        openFence = null;
      }
      continue;
    }
    if (/^\s*>/.test(rawLine)) continue;
    const match = TRIGGER_RE.exec(rawLine);
    if (match) {
      return { scope_override: match[1] ? "full" : "delta" };
    }
  }
  return null;
}
