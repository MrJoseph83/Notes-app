// Simple Notes API using Express, Prisma and Supabase auth
// import pkg from 'pg';
// const { Client } = pkg;

// (async () => {
//   try {
//     console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

//     const client = new Client({
//       connectionString: process.env.DATABASE_URL,
//       ssl: { rejectUnauthorized: false },
//     });

//     await client.connect();
//     console.log("RAW POSTGRES CONNECTED");

//     await client.end();
//   } catch (e) {
//     console.error("RAW POSTGRES FAILED:");
//     console.error(e);
//   }
// })();


// Load environment variables from `.env` during local development only
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
  // require("dotenv").config();
}
// import express from "express";

const express = require("express");
// Prefer IPv4 address resolution to avoid environments without IPv6 outbound routes
try {
  
  const dns = require('dns');
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {
  console.warn('Could not set DNS result order to ipv4first:', e && e.message);
}
// import cors from "cors";
const cors = require("cors");

// import { PrismaClient } from "@prisma/client";
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

// CORS configuration: allow Vercel and Render deployments, plus localhost for development
const allowedOrigins = [
  "https://notes-app-one-murex-78.vercel.app",
  "https://notes-app-7it6.onrender.com",
  "http://localhost:3000",
  "http://localhost:3001",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Health check
app.get("/", (req, res) => {
  const checks = {
    status: "ok",
    service: "api",
    env: process.env.NODE_ENV || "development",
    database: process.env.DATABASE_URL ? "configured" : "not configured",
    supabase: process.env.SUPABASE_URL ? "configured" : "not configured",
  };
  res.json(checks);
});

// Temporary diagnostic endpoint: attempt a lightweight DB query to verify connectivity
app.get("/diag/db", async (req, res) => {
  try {
    // Ensure Prisma is connected and run a simple query
    await prisma.$connect();
    const result = await prisma.$queryRaw`SELECT 1 as ok`;
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("DB DIAG ERROR:", err && err.message ? { message: err.message, stack: err.stack } : err);
    return res.status(500).json({ ok: false, message: err?.message || String(err), stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined });
  }
});

// TCP reachability diagnostic: attempt a raw TCP connection to the DB host/port
// import net from 'net';
const net = import('net');
import { URL } from 'url';
app.get('/diag/tcp', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return res.status(400).json({ ok: false, message: 'DATABASE_URL not configured' });

  try {
    // Parse host and port from the DATABASE_URL
    const parsed = new URL(dbUrl.replace(/^postgres:/, 'postgres:'));
    const host = parsed.hostname;
    const port = Number(parsed.port) || 5432;

    const socket = new net.Socket();
    let settled = false;
    const timeout = 5000;

    const cleanup = (ok, info) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      res.json({ ok, info });
    };

    socket.setTimeout(timeout);
    socket.once('error', (err) => cleanup(false, { message: err.message }));
    socket.once('timeout', () => cleanup(false, { message: 'timeout' }));
    socket.connect(port, host, () => {
      cleanup(true, { host, port });
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message || String(err) });
  }
});

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

const { noteSchema } = require("./validation/note.schema.js");

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
  console.error("UNHANDLED ERROR:", {
    message: err.message,
    code: err.code,
    status: err.status,
    stack: err.stack,
  });
  const status = err.status || 500;
  const isDev = process.env.NODE_ENV === "development";
  const message = isDev ? err.message || "Internal Server Error" : "Internal Server Error";
  res.status(status).json({ error: message, ...(isDev && { details: err.code || err.message }) });
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
