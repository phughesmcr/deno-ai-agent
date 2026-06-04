/** Runs `fn` with env overrides, restoring previous values in `finally`. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}
