/** Lets pending promises and zero-delay timers run, for a test that needs a view's async work to finish. */
export const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
