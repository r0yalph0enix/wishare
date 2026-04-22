const express = require("express");
const multer = require("multer");
const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const os = require("os");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, "uploads");
const MAX_FILE_AGE_DAYS = 7;

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory shared state
let sharedText = "";
let sharedFiles = [];

// Load persisted state on startup
const STATE_FILE = path.join(__dirname, "state.json");
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      sharedText = data.text || "";
      sharedFiles = (data.files || []).filter((f) => {
        const filePath = path.join(UPLOADS_DIR, f.storedName);
        return fs.existsSync(filePath);
      });
    }
  } catch (e) {
    console.log("No previous state found, starting fresh.");
  }
}

function saveState() {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ text: sharedText, files: sharedFiles }, null, 2)
  );
}

loadState();

// Auto-delete files older than MAX_FILE_AGE_DAYS
function cleanOldFiles() {
  const cutoff = Date.now() - MAX_FILE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const before = sharedFiles.length;
  sharedFiles = sharedFiles.filter((f) => {
    if (f.uploadedAt < cutoff) {
      const filePath = path.join(UPLOADS_DIR, f.storedName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return false;
    }
    return true;
  });
  if (sharedFiles.length !== before) {
    saveState();
    broadcast({ type: "files", files: sharedFiles });
  }
}

setInterval(cleanOldFiles, 60 * 60 * 1000); // Run every hour
cleanOldFiles(); // Run on startup

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// WebSocket broadcast helper
function broadcast(data, senderWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== senderWs) {
      client.send(msg);
    }
  });
}

// WebSocket connection
wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`Client connected: ${clientIp}`);

  // Send current state to new client
  ws.send(JSON.stringify({ type: "init", text: sharedText, files: sharedFiles }));

  ws.on("message", (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg);
      if (msg.type === "text") {
        sharedText = msg.text;
        saveState();
        broadcast({ type: "text", text: sharedText }, ws);
      }
    } catch (e) {
      console.error("WS message error:", e);
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected: ${clientIp}`);
  });
});

// ── REST API ──────────────────────────────────────────────

// GET current state
app.get("/api/state", (req, res) => {
  res.json({ text: sharedText, files: sharedFiles });
});

// POST update text
app.post("/api/text", (req, res) => {
  const { text } = req.body;
  if (typeof text !== "string") return res.status(400).json({ error: "Invalid text" });
  sharedText = text;
  saveState();
  broadcast({ type: "text", text: sharedText });
  res.json({ success: true });
});

// POST upload file(s)
app.post("/api/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const newFiles = req.files.map((f) => ({
    id: uuidv4(),
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    uploadedAt: Date.now(),
  }));

  sharedFiles = [...sharedFiles, ...newFiles];
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true, files: newFiles });
});

// GET download file
app.get("/api/download/:storedName", (req, res) => {
  const { storedName } = req.params;
  // Security: only allow simple filenames, no path traversal
  if (!/^[\w\-]+(\.\w+)?$/.test(storedName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(UPLOADS_DIR, storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const fileInfo = sharedFiles.find((f) => f.storedName === storedName);
  const downloadName = fileInfo ? fileInfo.originalName : storedName;
  res.download(filePath, downloadName);
});

// DELETE a file
app.delete("/api/file/:id", (req, res) => {
  const { id } = req.params;
  const fileIdx = sharedFiles.findIndex((f) => f.id === id);
  if (fileIdx === -1) return res.status(404).json({ error: "File not found" });

  const file = sharedFiles[fileIdx];
  const filePath = path.join(UPLOADS_DIR, file.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  sharedFiles.splice(fileIdx, 1);
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true });
});

// DELETE all files
app.delete("/api/files", (req, res) => {
  sharedFiles.forEach((f) => {
    const filePath = path.join(UPLOADS_DIR, f.storedName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  sharedFiles = [];
  saveState();
  broadcast({ type: "files", files: sharedFiles });
  res.json({ success: true });
});

// GET server info (local IP addresses)
app.get("/api/info", (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  res.json({ ips, port: PORT });
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  const interfaces = os.networkInterfaces();
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║          WiShare is running!           ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${PORT}         ║`);
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`║  Network: http://${iface.address}:${PORT}`.padEnd(42) + "║");
      }
    }
  }
  console.log("║                                        ║");
  console.log("║  Open the Network URL on any device    ║");
  console.log("║  connected to the same WiFi!           ║");
  console.log("╚════════════════════════════════════════╝\n");
});
