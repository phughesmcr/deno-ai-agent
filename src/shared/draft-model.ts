/** Optional `draftModel` for LM Studio `model.act()` when `DRAFT_MODEL` is set. */
export function getActDraftModel(): { readonly draftModel: string } | undefined {
  const draftModel = Deno.env.get("DRAFT_MODEL");
  if (!draftModel) return undefined;
  return { draftModel };
}
