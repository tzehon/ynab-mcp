import { ToolError } from "../tools/errors.js";
export class AdmissionBudget {
  private active = 0;
  enter() {
    if (this.active >= 4) throw new ToolError("BUSY");
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
export const processBudget = new AdmissionBudget();
export class CallLimits {
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(private budget = processBudget) {}
  async run<T>(
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.closed || caller?.aborted) throw new ToolError("UPSTREAM_TIMEOUT");
    const release = this.budget.enter();
    const controller = new AbortController();
    this.controllers.add(controller);
    const deadline = performance.now() + 3000;
    const abort = () => controller.abort();
    caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 3000);
    const check = () => {
      if (controller.signal.aborted || performance.now() >= deadline)
        throw new ToolError("UPSTREAM_TIMEOUT");
    };
    let stop: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(new ToolError("UPSTREAM_TIMEOUT"));
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    try {
      check();
      const value = await Promise.race([
        Promise.resolve().then(() => {
          check();
          return work(controller.signal, check);
        }),
        cancelled,
      ]);
      check();
      return value;
    } finally {
      controller.abort();
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", stop);
      this.controllers.delete(controller);
      release();
    }
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
}
