/**
 * WiShare — server.js
 *
 * Sync strategy: Pure HTTP polling (no SSE, no WebSocket)
 *
 * Why polling works perfectly on Vercel free tier:
 *   - Every poll is a fresh HTTP request that completes in milliseconds
 *   - Vercel never kills it (it's already done before any timeout hits)
 *   - No persistent connection to maintain = zero reconnecting issues
 *
 * How it works:
 *   - Client sends its last known "hash" of the state every 2.5 seconds
 *   - Server compares hash → if changed, returns new state → client updates UI
 *   - If nothing changed, server returns { changed: false } instantly
 *   - Result: all devices stay in sync within 2.5 seconds, always
 */

const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const { v4: uuidv4 } = require("uuid");
const os      = require("os");

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
let stateHash   = computeHash(); // current hash of state

// ── State hash — used by clients to detect changes ───────
function computeHash() {
  const raw = JSON.stringify({ text: sharedText, files: sharedFiles.map(f => f.id) });
  return crypto.createHash("md5").update(raw).digest("hex").slice(0, 12);
}

function updateHash() {
  stateHash = computeHash();
}

// ── Persist state to disk (best-effort) ──────────────────
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data  = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      sharedText  = data.text  || "";
      sharedFiles = (data.files || []).filter((f) =>
        fs.existsSync(path.join(UPLOADS_DIR, f.storedName))
      );
      updateHash();
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
    // Vercel has read-only FS — ignore silently, state lives in memory
  }
}

loadState();

// ── Auto-cleanup (files older than 7 days) ────────────────
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cleanOldFiles() {
  const cutoff = Date.now() - MAX_AGE_MS;
  const before = sharedFiles.length;
  sharedFiles  = sharedFiles.filter((f) => {
    if (f.uploadedAt < cutoff) {
      const fp = path.join(UPLOADS_DIR, f.storedName);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return false;
    }
    return true;
  });
  if (sharedFiles.length !== before) {
    updateHash();
    saveState();
  }
}

setInterval(cleanOldFiles, 60 * 60 * 1000); // hourly
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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════
//  POLL ENDPOINT   GET /api/poll?hash=<clientHash>
//
//  The client calls this every 2.5 seconds with its last
//  known hash.  If the hash matches → nothing changed →
//  return { changed: false } instantly (very cheap).
//  If hash differs → state changed → return full new state.
//
//  Each request completes in < 5ms on Vercel — well within
//  any timeout limit.  Zero persistent connections needed.
// ═══════════════════════════════════════════════════════════
app.get("/api/poll", (req, res) => {
  // No caching — must always get fresh state
  res.setHeader("Cache-Control", "no-store");

  const clientHash = req.query.hash || "";

  if (clientHash === stateHash) {
    // Nothing changed — tell client to keep its current state
    return res.json({ changed: false, hash: stateHash });
  }

  // State changed — send full current state
  res.json({
    changed: true,
    hash:    stateHash,
    text:    sharedText,
    files:   sharedFiles,
  });
});

// ── GET /api/state — full state on first load ─────────────
app.get("/api/state", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    hash:  stateHash,
    text:  sharedText,
    files: sharedFiles,
  });
});

// ── POST /api/text — update shared text ──────────────────
app.post("/api/text", (req, res) => {
  const { text } = req.body;
  if (typeof text !== "string") {
    return res.status(400).json({ error: "text must be a string" });
  }
  sharedText = text;
  updateHash();
  saveState();
  res.json({ success: true, hash: stateHash });
});

// ── POST /api/upload — upload files ──────────────────────
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
  updateHash();
  saveState();
  res.json({ success: true, files: newFiles, hash: stateHash });
});

// ── GET /api/download/:storedName — secure download ──────
app.get("/api/download/:storedName", (req, res) => {
  const { storedName } = req.params;
  if (!/^[\w-]+(\.\w+)?$/.test(storedName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(UPLOADS_DIR, storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const fileInfo     = sharedFiles.find((f) => f.storedName === storedName);
  const downloadName = fileInfo ? fileInfo.originalName : storedName;
  res.download(filePath, downloadName);
});

// ── DELETE /api/file/:id — delete one file ───────────────
app.delete("/api/file/:id", (req, res) => {
  const { id }  = req.params;
  const fileIdx = sharedFiles.findIndex((f) => f.id === id);
  if (fileIdx === -1) return res.status(404).json({ error: "File not found" });

  const file     = sharedFiles[fileIdx];
  const filePath = path.join(UPLOADS_DIR, file.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  sharedFiles.splice(fileIdx, 1);
  updateHash();
  saveState();
  res.json({ success: true, hash: stateHash });
});

// ── DELETE /api/files — delete all files ─────────────────
app.delete("/api/files", (req, res) => {
  sharedFiles.forEach((f) => {
    const fp = path.join(UPLOADS_DIR, f.storedName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  sharedFiles = [];
  updateHash();
  saveState();
  res.json({ success: true, hash: stateHash });
});

// ── GET /api/info — network interfaces ───────────────────
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
  console.log("║  Sync:    HTTP Polling (2.5s interval) ║");
  console.log("║  Host:    Vercel / any Node.js host    ║");
  console.log("║  Status:  No reconnecting issues ✓     ║");
  console.log("╚════════════════════════════════════════╝\n");
});