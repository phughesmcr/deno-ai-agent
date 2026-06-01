/** Extract tool implementation for unit tests (LM Studio Tool type hides the signature). */
export function toolImplementation<TArgs, TResult>(
  toolDef: unknown,
): (args: TArgs) => Promise<TResult> {
  return (toolDef as { implementation: (args: TArgs) => Promise<TResult> }).implementation;
}
