import type { BusabaseClient } from "busabase-sdk";
import { describe, expect, it } from "vitest";
import { BaseResolver, isServerSortable, UnknownBaseError } from "./base-resolver";

const BASES = [
  {
    id: "bas_contacts",
    slug: "contacts",
    fields: [
      { slug: "name", type: "text" },
      { slug: "score", type: "number" },
      { slug: "due", type: "date" },
      { slug: "rank", type: "auto_number" },
      { slug: "made", type: "created_time" },
      { slug: "stage", type: "select" },
      { slug: "active", type: "checkbox" },
    ],
  },
  { id: "bas_orders", slug: "orders", fields: [{ slug: "total", type: "number" }] },
];

const makeClient = () => {
  let calls = 0;
  const client = {
    bases: {
      list: async () => {
        calls += 1;
        return BASES;
      },
    },
  } as unknown as BusabaseClient;
  return { client, listCalls: () => calls };
};

describe("resolution", () => {
  it("resolves a table name as a Base slug", async () => {
    const fake = makeClient();
    const base = await new BaseResolver(fake.client).resolve("contacts");
    expect(base.id).toBe("bas_contacts");
    expect(base.slug).toBe("contacts");
    expect(base.fields.get("score")).toEqual({ slug: "score", type: "number" });
  });

  it("resolves a bas_ id as well, so a schema can pin one", async () => {
    const fake = makeClient();
    const base = await new BaseResolver(fake.client).resolve("bas_orders");
    expect(base.slug).toBe("orders");
  });

  it("honours an explicit override", async () => {
    const fake = makeClient();
    const base = await new BaseResolver(fake.client, { people: "contacts" }).resolve("people");
    expect(base.id).toBe("bas_contacts");
  });

  it("prefers a slug match over an id match", async () => {
    // A Base whose slug equals another's id would otherwise be ambiguous.
    const tricky = {
      bases: {
        list: async () => [
          { id: "x", slug: "bas_orders", fields: [] },
          { id: "bas_orders", slug: "orders", fields: [] },
        ],
      },
    } as unknown as BusabaseClient;
    const base = await new BaseResolver(tricky).resolve("bas_orders");
    expect(base.id).toBe("x");
  });
});

describe("failure", () => {
  it("names the missing slug and lists what does exist", async () => {
    const fake = makeClient();
    await expect(new BaseResolver(fake.client).resolve("nope")).rejects.toThrow(UnknownBaseError);
    await expect(new BaseResolver(fake.client).resolve("nope")).rejects.toThrow(/contacts, orders/);
  });

  it("tells the caller how to map the table explicitly", async () => {
    const fake = makeClient();
    await expect(new BaseResolver(fake.client).resolve("nope")).rejects.toThrow(/bases: \{ nope:/);
  });

  it("does not cache a failure — the Base may not exist YET", async () => {
    let bases: { id: string; slug: string; fields: unknown[] }[] = [];
    const client = {
      bases: { list: async () => bases },
    } as unknown as BusabaseClient;
    const resolver = new BaseResolver(client);

    await expect(resolver.resolve("later")).rejects.toThrow(UnknownBaseError);
    bases = [{ id: "bas_later", slug: "later", fields: [] }];
    await expect(resolver.resolve("later")).resolves.toMatchObject({ id: "bas_later" });
  });
});

describe("caching", () => {
  it("resolves a table once, however many queries ask", async () => {
    const fake = makeClient();
    const resolver = new BaseResolver(fake.client);
    await resolver.resolve("contacts");
    await resolver.resolve("contacts");
    expect(fake.listCalls()).toBe(1);
  });

  it("shares one round trip between concurrent callers", async () => {
    // The promise is cached, not the result — otherwise queries firing together
    // would each start their own lookup.
    const fake = makeClient();
    const resolver = new BaseResolver(fake.client);
    await Promise.all([resolver.resolve("contacts"), resolver.resolve("contacts")]);
    expect(fake.listCalls()).toBe(1);
  });
});

describe("isServerSortable", () => {
  const base = {
    id: "bas_contacts",
    slug: "contacts",
    fields: new Map(BASES[0]!.fields.map((f) => [f.slug, f])),
  };

  it.each([
    ["number", "score", true],
    ["date", "due", true],
    ["auto_number", "rank", true],
    ["created_time", "made", true],
    ["text", "name", false],
    ["select", "stage", false],
    ["checkbox", "active", false],
  ])("%s → %s", (_type, slug, expected) => {
    expect(isServerSortable(base, slug)).toBe(expected);
  });

  it("is false for a field the Base does not have", () => {
    expect(isServerSortable(base, "nope")).toBe(false);
  });
});
