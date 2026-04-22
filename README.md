<<<<<<< HEAD
# Wishare
Share files &amp; text across your WiFi Instant sync on every device — no internet, no account, no app required.
=======
# WiShare 📡

> Share text and files instantly across all devices on your WiFi — no account, no cloud, no internet required.

---

## What is WiShare?

WiShare is a self-hosted, local-network file and text sharing tool. Run it on any computer and every device on the same WiFi (phones, tablets, laptops) can instantly share text snippets and files through a browser — no app installs needed.

---

## Features

- 📝 **Real-time text sync** — type on one device, see it instantly on all others (WebSocket)
- 📁 **File sharing** — drag & drop or click to upload; anyone on the network downloads with one click
- 📥 **Collapsible Downloads panel** — click "Downloads" to reveal files with name, size & upload time
- 🔄 **Refresh button** — instant page reload in the header
- 🌙☀️ **Dark / Light mode toggle** — saved in localStorage
- 💾 **Persistent state** — text and file list survive server restarts
- 🗑️ **Auto-cleanup** — files older than 7 days deleted automatically
- 📡 **Network Info** — shows your LAN IP so you can share the URL with other devices

---

## ❓ Will it work after hosting (same network question)?

**YES — automatically, with one important condition:**

When you run `npm start`, WiShare listens on `0.0.0.0` (all network interfaces). This means:

- Any device on your **local WiFi / LAN** can open `http://<your-computer-ip>:3000` and use it
- The **receiving device does NOT need to do anything special** — just open the URL in any browser
- You only need to find your computer's local IP once (shown in terminal on startup, or via the 📡 button in the app)

**Example flow:**
1. You run `npm start` on your laptop → terminal shows `http://192.168.1.42:3000`
2. Your phone (on same WiFi) opens `http://192.168.1.42:3000` in its browser
3. Everything syncs automatically — done ✅

**Note:** If you deploy to a real public server (VPS/cloud), it becomes accessible from anywhere on the internet via the server's public IP, not just your WiFi. The app will still work perfectly in that case.

---

## Requirements

- **Node.js** v16 or higher → [nodejs.org](https://nodejs.org)
- npm (bundled with Node.js)

---

## Installation & Running

```bash
# 1. Enter the project folder
cd wishare

# 2. Install dependencies (one time only)
npm install

# 3. Start the server
npm start
```

Terminal output:
```
╔════════════════════════════════════════╗
║          WiShare is running!           ║
╠════════════════════════════════════════╣
║  Local:   http://localhost:3000        ║
║  Network: http://192.168.1.42:3000    ║
╚════════════════════════════════════════╝
```

- **This computer:** `http://localhost:3000`
- **Other devices on same WiFi:** use the `Network:` URL

---

## Change Port

```bash
PORT=8080 npm start          # macOS / Linux
set PORT=8080 && npm start   # Windows CMD
$env:PORT=8080; npm start    # Windows PowerShell
```

---

## Project Structure

```
wishare/
├── server.js          ← Node.js backend (Express + WebSocket + Multer)
├── package.json       ← Dependencies
├── state.json         ← Auto-created: persists text & file list
├── public/
│   └── index.html     ← Single-page UI (dark/light, collapsible downloads)
└── uploads/           ← Auto-created: uploaded files live here
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Other devices can't connect | Check firewall — allow port 3000 for Node.js |
| `EADDRINUSE` error | Port in use, run `PORT=3001 npm start` |
| Files not saved after restart | Check `uploads/` folder is writable |
| Can't find network IP | Click the 📡 icon in the WiShare header |

**Firewall quick fixes:**
- Windows: Allow Node.js through Windows Defender Firewall
- macOS: System Settings → Network → Firewall → Allow incoming for Node
- Linux: `sudo ufw allow 3000`

---

## Security

WiShare has no authentication — anyone on your WiFi can read, upload, and download. Designed for trusted local networks. **Do not expose port 3000 to the public internet** unless you add authentication.

---

## Stop the server

Press `Ctrl + C` in the terminal.

---

© WiShare — Developed with ❤️ for seamless local sharing.
>>>>>>> f62d8fd (Initial commit)
