/* 복구 한 번에 허용하는 전체 시간. 목표가 아니라 상한이다.
   /api/v1/recover가 이 값으로 마감을 세우고, /api/v1/capabilities가 같은 값을
   공개 계약으로 알린다. 두 곳에 따로 적어 두었더니 12초에서 25초로 넓힌 변경이
   한쪽에만 반영돼 계약이 실제 동작보다 5초 짧다고 말하는 상태가 됐다. 다시
   갈라지지 않도록 여기 한 곳에서만 정한다. */
export const RECOVERY_RESPONSE_BUDGET_MS = 25_000;

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
