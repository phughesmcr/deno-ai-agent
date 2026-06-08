import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { KvSessionCatalog } from "../../src/core/mod.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("KvSessionCatalog creates v4 sessions and resolves by id or name", async () => {
  await withKv(async (kv) => {
    const catalog = new KvSessionCatalog(kv);
    const session = await catalog.create({
      id: "00000000-0000-4000-8000-000000000001",
      name: "alpha",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assertEquals(session, {
      id: "00000000-0000-4000-8000-000000000001",
      version: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "alpha",
    });
    assertEquals(await catalog.resolve("00000000-0000-4000-8000-000000000001"), session);
    assertEquals(await catalog.resolve("alpha"), session);
    assertEquals(await catalog.list(), [session]);
  });
});

Deno.test("KvSessionCatalog rejects duplicate ids, duplicate names, and invalid names", async () => {
  await withKv(async (kv) => {
    const catalog = new KvSessionCatalog(kv);
    await catalog.create({ id: "00000000-0000-4000-8000-000000000001", name: "taken" });

    await assertRejects(
      () => catalog.create({ id: "00000000-0000-4000-8000-000000000001" }),
      Error,
      "Session already exists",
    );
    await assertRejects(
      () => catalog.create({ id: "00000000-0000-4000-8000-000000000002", name: "taken" }),
      Error,
      "Session name already in use",
    );
    await assertRejects(
      () => catalog.create({ id: "00000000-0000-4000-8000-000000000002", name: "bad name" }),
      Error,
      "Invalid session name",
    );
  });
});

Deno.test("KvSessionCatalog rename updates the name index atomically", async () => {
  await withKv(async (kv) => {
    const catalog = new KvSessionCatalog(kv);
    const session = await catalog.create({
      id: "00000000-0000-4000-8000-000000000001",
      name: "old",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await catalog.create({ id: "00000000-0000-4000-8000-000000000002", name: "other" });

    const renamed = await catalog.rename(session.id, "new", {
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    assertEquals(renamed.name, "new");
    assertEquals(renamed.updatedAt, "2026-01-01T00:00:01.000Z");
    assertEquals(await catalog.resolve("new"), renamed);
    await assertRejects(() => catalog.resolve("old"), Error, 'No v4 session named "old"');
    await assertRejects(() => catalog.rename(session.id, "other"), Error, "Session name already in use");
  });
});

Deno.test("KvSessionCatalog resolves only known v4 sessions", async () => {
  await withKv(async (kv) => {
    const catalog = new KvSessionCatalog(kv);

    await assertRejects(
      () => catalog.resolve("00000000-0000-4000-8000-000000000099"),
      Error,
      "No v4 session with id",
    );
    await assertRejects(
      () => catalog.resolve("missing"),
      Error,
      'No v4 session named "missing"',
    );
  });
});

Deno.test("KvSessionCatalog creates fork metadata linked to a parent session", async () => {
  await withKv(async (kv) => {
    const catalog = new KvSessionCatalog(kv);
    const parent = await catalog.create({
      id: "00000000-0000-4000-8000-000000000001",
      name: "parent",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const fork = await catalog.fork(parent.id, {
      id: "00000000-0000-4000-8000-000000000002",
      now: new Date("2026-01-01T00:00:02.000Z"),
    });

    assertEquals(fork.parentSessionId, parent.id);
    assertEquals(fork.name, undefined);
    assertEquals(fork.createdAt, "2026-01-01T00:00:02.000Z");
  });
});
