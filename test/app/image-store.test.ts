import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { QueuedImageStore } from "../../src/app/image-store.ts";

Deno.test("QueuedImageStore round-trips image payloads larger than one KV value", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let id = 0;
    const store = new QueuedImageStore(kv, { createId: () => `image-${++id}` });
    const base64 = "a".repeat(140_000);

    const refs = await store.putImages([{ fileName: "large.png", base64 }]);
    assertEquals(refs, [{ imageId: "image-1", fileName: "large.png", chunkCount: 3 }]);
    assertEquals(await store.loadImages(refs), [{ fileName: "large.png", base64 }]);
  } finally {
    kv.close();
  }
});

Deno.test("QueuedImageStore deletes image chunks and metadata", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new QueuedImageStore(kv, { createId: () => "image-1" });
    const refs = await store.putImages([{ fileName: "gone.png", base64: "aW1hZ2U=" }]);

    await store.deleteImages(refs);

    await assertRejects(
      () => store.loadImages(refs),
      Error,
      "Queued image payload not found",
    );
  } finally {
    kv.close();
  }
});
