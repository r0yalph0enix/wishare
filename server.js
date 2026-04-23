/**
 * WiShare — server.js
 *
 * Real-time sync uses Server-Sent Events (SSE) instead of WebSockets.
 * SSE works on every host including Vercel, Render, Railway, shared hosting, etc.
 * WebSockets require a persistent TCP connection that serverless platforms kill.
 *
 * Architecture:
 *   - SSE  /api/events  → server pushes state changes to all connected clients
 *   - REST /api/*       → clients POST text/file changes to server
 *   - State stored in memory (+ state.json on disk when available)
 */

const express  = require("express");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const { v4: uuidv4 } = require("uuid");
const os       = require("os");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Upload directory ──────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── In-memory state ───────────────────────────────────────
let sharedText  = "";
let sharedFiles = [];

// ── Persist state to disk when possible ──────────────────
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data  = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      sharedText  = data.text  || "";
      sharedFiles = (data.files || []).filter((f) =>
        fs.existsSync(path.join(UPLOADS_DIR, f.storedName))
      );
    }
  } catch (_) {
    console.log("[WiShare] No previous state — starting fresh.");
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ text: sharedText, files: sharedFiles }, null, 2)
    );
  } catch (_) {
    // Vercel / read-only FS: ignore write errors silently
  }
}

loadState();

// ── SSE client registry ───────────────────────────────────
// Map of  clientId → res (SSE response stream)
const sseClients = new Map();

/**
 * Push a JSON event to every connected SSE client except the sender.
 * @param {object} data       — payload to send
 * @param {string} [skipId]   — clientId to exclude (the sender)
 */
function broadcast(data, skipId = null) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of sseClients) {
    if (id !== skipId) {
      try {
        res.write(payload);
      } catch (_) {
        sseClients.delete(id);
      }
    }
  }
}

// ── Auto-cleanup (files older than 7 days) ────────────────
const MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cleanOldFiles() {
  const cutoff  = Date.now() - MAX_FILE_AGE_MS;
  const before  = sharedFiles.length;
  sharedFiles   = sharedFiles.filter((f) => {
    if (f.uploadedAt < cutoff) {
      const fp = path.join(UPLOADS_DIR, f.storedName);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return false;
    }
    return true;
  });
  if (sharedFiles.length !== before) {
    saveState();
    broadcast({ type: "files", files: sharedFiles });
  }
}

setInterval(cleanOldFiles, 60 * 60 * 1000);
cleanOldFiles();

// ── Multer (file uploads) ─────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════
//  SSE ENDPOINT   GET /api/events
//
//  Clients open this as an EventSource.  The connection stays
//  open; the server pushes JSON events whenever state changes.
//  Works on Vercel because SSE is just a long-lived HTTP
//  response — no special TCP upgrade required.
// ═══════════════════════════════════════════════════════════
app.get("/api/events", (req, res) => {
  // SSE headers — critical for proxies / Vercel edge
  res.setHeader("Content-Type",                "text/event-stream");
  res.setHeader("Cache-Control",               "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering",           "no");   // disable nginx buffering
  res.setHeader("Connection",                  "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const clientId = uuidv4();
  sseClients.set(clientId, res);

  // Send current state immediately to the new client
  res.write(`data: ${JSON.stringify({
    type:  "init",
    text:  sharedText,
    files: sharedFiles,
  })}\n\n`);

  // Heartbeat every 25 s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 25000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
    console.log(`[WiShare] SSE client disconnected (${sseClients.size} active)`);
  });

  console.log(`[WiShare] SSE client connected id=${clientId} (${sseClients.size} active)`);
});

// ═══════════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════════

// GET  /api/state  — full state snapshot (used on page load)
app.get("/api/state", (req, res) => {
  res.json({ text: sharedText, files: sharedFiles });
});

// POST /api/text  — update shared text
app.post("/api/text", (req, res) => {
  const { text, clientId } = req.body;
  if (typeof text !== "string") {
    return res.status(400).json({ error: "text must be a string" });
  }
  sharedText = text;
  saveState();
  // Push to all OTHER clients via SSE
  broadcast({ type: "text", text: sharedText }, clientId);
  res.json({ success: true });
});

// POST /api/upload  — upload one or more files
app.post("/api/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const newFiles = req.files.map((f) => ({
    id:           uuidv4(),
    originalName: f.originalname,
    storedName:   f.filename,
    size:         f.size,
    mimetype:     f.mimetype,
    uploadedAt:   Date.now(),
  }));

  sharedFiles = [...sharedFiles, ...newFiles];
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true, files: newFiles });
});

// GET /api/download/:storedName  — secure file download
app.get("/api/download/:storedName", (req, res) => {
  const { storedName } = req.params;
  if (!/^[\w-]+(\.\w+)?$/.test(storedName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(UPLOADS_DIR, storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const fileInfo    = sharedFiles.find((f) => f.storedName === storedName);
  const downloadName = fileInfo ? fileInfo.originalName : storedName;
  res.download(filePath, downloadName);
});

// DELETE /api/file/:id  — delete one file
app.delete("/api/file/:id", (req, res) => {
  const { id }   = req.params;
  const fileIdx  = sharedFiles.findIndex((f) => f.id === id);
  if (fileIdx === -1) return res.status(404).json({ error: "File not found" });

  const file     = sharedFiles[fileIdx];
  const filePath = path.join(UPLOADS_DIR, file.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  sharedFiles.splice(fileIdx, 1);
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true });
});

// DELETE /api/files  — delete all files
app.delete("/api/files", (req, res) => {
  sharedFiles.forEach((f) => {
    const fp = path.join(UPLOADS_DIR, f.storedName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  sharedFiles = [];
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true });
});

// GET /api/info  — server network info
app.get("/api/info", (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips        = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  res.json({ ips, port: PORT });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const ifaces = os.networkInterfaces();
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║          WiShare is running!           ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${PORT}         ║`);
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`║  Network: http://${iface.address}:${PORT}`.padEnd(42) + "║");
      }
    }
  }
  console.log("║                                        ║");
  console.log("║  Transport: Server-Sent Events (SSE)   ║");
  console.log("║  Works on: Vercel, Render, Railway,    ║");
  console.log("║            local network, any host     ║");
  console.log("╚════════════════════════════════════════╝\n");
});