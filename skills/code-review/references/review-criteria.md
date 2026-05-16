# Review Criteria

Evaluate each change against these criteria. Apply the "Before flagging" gate from SKILL.md first — don't surface findings that fail that test.

## 1. Idiomaticity

- Does this code look like it was written by someone fluent in the language, or translated from another?
- Would a native reviewer of this language recognize the naming and structure as conventional, or mark it as noisy?
- Does the standard library offer a cleaner primitive than what's being reimplemented here?

## 2. Best Practices & Patterns

- Which established pattern does this change slot into, and is the fit natural or forced?
- Does error handling match the rest of this codebase's discipline (same propagation strategy, same log-vs-return decisions)?
- Has the author followed the house conventions from `CODING_GUIDELINES.md` / `AGENTS.md` / `CONTRIBUTING.md`, or is this reinventing one?

## 3. Clarity & Conciseness

- If someone came to this function six months from now with no context, where would they slow down?
- Is the complexity essential to the problem, or accumulated while the author figured out the solution?
- What can be deleted without changing behavior?

## 4. Comments & Intent

- Where does the code do something that would surprise a reader who understands the language but not this problem? That's where a WHY comment is load-bearing.
- Which comments describe *what* the code does (redundant) vs. *why* it does it that way (essential)?
- Are any comments stale — contradicted by the code they annotate?

## 5. Performance

- What's the expected scale of input, and does the chosen approach degrade at that scale?
- Is this a hot path, or called rarely enough that clarity wins over micro-optimization?
- What shape of workload would make this loop or query actually matter in production?

## 6. Security

- Who is the attacker in the threat model here? Has this code path been reached by untrusted input before, or is this a new entry point?
- What assumption about input trust, encoding, or authentication would break this code?
- If a value crosses a trust boundary (user → server, service → service, database → code), where is it validated?

## 7. Edge Cases

- What input would make this function's invariants false?
- What happens under concurrent access that the single-threaded reading misses?
- Which error case is the author handling, and which is being swallowed?

## 8. Documentation

- Can a caller use this function / API / feature from the documentation alone, or do they have to read the implementation?
- If behavior changed, did the user-facing documentation follow?
- Are breaking changes surfaced where the person doing the upgrade will actually see them?
