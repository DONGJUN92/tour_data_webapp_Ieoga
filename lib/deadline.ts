export class DeadlineExceededError extends Error {
  constructor() {
    super("DEADLINE_EXCEEDED");
    this.name = "DeadlineExceededError";
  }
}

export async function beforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  if (Date.now() >= deadlineAt) throw new DeadlineExceededError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineExceededError()),
          Math.max(1, deadlineAt - Date.now()),
        );
      }),
    ]);
    /* A resolved promise can win the microtask queue after the event loop was
       blocked past the absolute deadline but before the timer callback ran.
       Recheck wall-clock time so the budget cannot be bypassed by queue order. */
    if (Date.now() >= deadlineAt) throw new DeadlineExceededError();
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
