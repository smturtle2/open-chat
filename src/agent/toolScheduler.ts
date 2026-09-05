// Only consecutive read-only calls can overlap. A mutation is a barrier:
// reads following it observe the completed write, even within one model turn.
const READ_ONLY = new Set(["read_file", "view_image", "search_files", "list_files", "read_output", "load_skill"]);

export async function scheduleTools<T extends { function: { name: string } }, R>(
  calls: T[], execute: (call: T) => Promise<R>, concurrency = 4,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < calls.length;) {
    if (!READ_ONLY.has(calls[i].function.name)) {
      results.push(await execute(calls[i++]));
      continue;
    }
    const batch: T[] = [];
    while (i < calls.length && batch.length < concurrency && READ_ONLY.has(calls[i].function.name)) batch.push(calls[i++]);
    results.push(...await Promise.all(batch.map(execute)));
  }
  return results;
}
