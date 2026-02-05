// Simple Notes API using Express, Prisma and Supabase auth

const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@supabase/supabase-js");

// Database and auth clients
const prisma = new PrismaClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NODE_ENV === 'production') {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const app = express();
app.use(express.json());

// Helper: wrap async route handlers to forward errors to central handler
function wrapAsync(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// CORS configuration (allow local frontend and production origin)
app.use(
  cors({
    origin: ["https://notes-app-one-murex-78.vercel.app"],
    credentials: true,
  })
);

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "api" }));

// Middleware: validate Bearer token via Supabase and attach user to request
async function authenticateUser(req, res, next) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing token" });

    const { data: { user } = {}, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

const { noteSchema } = require("./validation/note.schema");

// Create a note for the authenticated user
app.post(
  "/notes",
  authenticateUser,
  wrapAsync(async (req, res) => {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { title, content } = parsed.data;
    const note = await prisma.note.create({ data: { title, content, userId: req.user.id } });
    res.json(note);
  })
);

// List notes with basic pagination; exclude soft-deleted notes
app.get(
  "/notes",
  authenticateUser,
  wrapAsync(async (req, res) => {
    const limit = Math.min(100, Number.parseInt(req.query.limit, 10) || 10);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

    const notes = await prisma.note.findMany({
      where: { userId: req.user.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    res.json(notes);
  })
);

// Soft-delete a note after verifying ownership
app.delete(
  "/notes/:id",
  authenticateUser,
  wrapAsync(async (req, res) => {
    const noteId = Number(req.params.id);
    if (!Number.isInteger(noteId) || noteId <= 0) return res.status(400).json({ error: "Invalid note id" });

    const note = await prisma.note.findUnique({ where: { id: noteId } });
    if (!note || String(note.userId) !== String(req.user.id)) return res.status(403).json({ error: "Forbidden" });

    await prisma.note.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
    res.json({ success: true });
  })
);

// Update a note after validation and ownership check
app.put(
  "/notes/:id",
  authenticateUser,
  wrapAsync(async (req, res) => {
    const noteId = Number(req.params.id);
    if (!Number.isInteger(noteId) || noteId <= 0) return res.status(400).json({ error: "Invalid note id" });

    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });

    const { title, content } = parsed.data;
    if (!title) return res.status(400).json({ error: "Title required" });

    const note = await prisma.note.findUnique({ where: { id: noteId } });
    if (!note || String(note.userId) !== String(req.user.id)) return res.status(403).json({ error: "Forbidden" });
    if (note.deletedAt) return res.status(400).json({ error: "Cannot modify deleted note" });

    const updatedNote = await prisma.note.update({ where: { id: noteId }, data: { title, content } });
    res.json(updatedNote);
  })
);

// Central error handler: log full error but expose generic message in production
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === "development" ? err.message || "Internal Server Error" : "Internal Server Error";
  res.status(status).json({ error: message });
});

// Graceful Prisma disconnect on shutdown signals
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

// Export app and clients for tests; start server only when run directly
module.exports = { app, prisma, supabase };

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
