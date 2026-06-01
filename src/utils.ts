export class Result {
  static async try<T, E = Error>(
    fn: () => T | Promise<T>,
  ): Promise<{ success: true; value: T } | { success: false; error: E }> {
    try {
      const value = await Promise.try(fn);
      return { success: true, value: value as T };
    } catch (error) {
      return { success: false, error: error as E };
    }
  }
}
