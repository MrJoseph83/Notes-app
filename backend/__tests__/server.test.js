// ...new file...
const request = require("supertest");

// Mock Prisma and Supabase BEFORE importing app
jest.mock("@prisma/client", () => {
  const mNote = {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const PrismaClient = jest.fn(() => ({ note: mNote }));
  return { PrismaClient };
});
jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({ auth: { getUser: jest.fn() } })),
}));

// Require app AFTER mocks
const { app, prisma, supabase } = require("../server");
// const { createClient } = require("@supabase/supabase-js"); // no longer needed

describe("Notes API (unit)", () => {
  let prismaMock;
  let supabaseMock;
  beforeEach(() => {
    // grab the prisma instance exported by server.js
    prismaMock = prisma.note;

    // grab the supabase client instance exported by server.js
    supabaseMock = supabase;

    // default authenticated user
    supabaseMock.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });

    // reset prisma method mocks between tests
    prismaMock.create.mockReset();
    prismaMock.findMany.mockReset();
    prismaMock.findUnique.mockReset();
    prismaMock.update.mockReset();
  });

  test("POST /notes - invalid input -> 400", async () => {
    const res = await request(app)
      .post("/notes")
      .set("Authorization", "Bearer token")
      .send({ title: "" }); // invalid per schema
    expect(res.status).toBe(400);
  });

  test("POST /notes - success", async () => {
    prismaMock.create.mockResolvedValue({
      id: 1,
      title: "t",
      content: "c",
      userId: "user-1",
    });

    const res = await request(app)
      .post("/notes")
      .set("Authorization", "Bearer token")
      .send({ title: "t", content: "c" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("t");
  });

  test("PUT /notes/:id - invalid id -> 400", async () => {
    const res = await request(app)
      .put("/notes/abc")
      .set("Authorization", "Bearer token")
      .send({ title: "x", content: "y" });
    expect(res.status).toBe(400);
  });

  test("GET /notes - internal error -> central handler returns 500", async () => {
    prismaMock.findMany.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await request(app)
      .get("/notes")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal Server Error");
  });

  test("GET /notes - development exposes actual error message", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    prismaMock.findMany.mockImplementation(() => {
      throw new Error("boom-dev");
    });
    const res = await request(app)
      .get("/notes")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("boom-dev");
    process.env.NODE_ENV = prev;
  });

  test("DELETE /notes/:id - success (soft delete)", async () => {
    prismaMock.findUnique.mockResolvedValue({
      id: 1,
      userId: "user-1",
      deletedAt: null,
    });
    prismaMock.update.mockResolvedValue({ id: 1, deletedAt: new Date() });

    const res = await request(app)
      .delete("/notes/1")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { deletedAt: expect.any(Date) },
    });
  });

  test("DELETE /notes/:id - forbidden when not owner", async () => {
    prismaMock.findUnique.mockResolvedValue({
      id: 2,
      userId: "other-user",
      deletedAt: null,
    });

    const res = await request(app)
      .delete("/notes/2")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(403);
  });

  test("PUT /notes/:id - success (update)", async () => {
    prismaMock.findUnique.mockResolvedValue({
      id: 3,
      userId: "user-1",
      deletedAt: null,
    });
    prismaMock.update.mockResolvedValue({
      id: 3,
      title: "updated",
      content: "updated content",
      userId: "user-1",
    });

    const res = await request(app)
      .put("/notes/3")
      .set("Authorization", "Bearer token")
      .send({ title: "updated", content: "updated content" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("updated");
    expect(prismaMock.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { title: "updated", content: "updated content" },
    });
  });

  test("PUT /notes/:id - cannot modify deleted note -> 400", async () => {
    prismaMock.findUnique.mockResolvedValue({
      id: 4,
      userId: "user-1",
      deletedAt: new Date(),
    });

    const res = await request(app)
      .put("/notes/4")
      .set("Authorization", "Bearer token")
      .send({ title: "x", content: "y" });

    expect(res.status).toBe(400);
  });

  test("PUT /notes/:id - forbidden when not owner", async () => {
    prismaMock.findUnique.mockResolvedValue({
      id: 5,
      userId: "other-user",
      deletedAt: null,
    });

    const res = await request(app)
      .put("/notes/5")
      .set("Authorization", "Bearer token")
      .send({ title: "x", content: "y" });

    expect(res.status).toBe(403);
  });
});
// ...new file...