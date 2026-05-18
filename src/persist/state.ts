// Process-local flag indicating whether the success-path persistUsageStep
// has already written a row for this review. main.ts inspects it from its
// catch block so failure-path persistence doesn't insert a duplicate when
// the workflow fails AFTER usage was recorded (e.g. post-step 422).
//
// One value per Node process — safe because each `wrily` invocation is a
// single review.

let usagePersisted = false;

export function markUsagePersisted(): void {
  usagePersisted = true;
}

export function wasUsagePersisted(): boolean {
  return usagePersisted;
}

/** Test-only: reset between cases. */
export function _resetUsagePersistedForTest(): void {
  usagePersisted = false;
}
