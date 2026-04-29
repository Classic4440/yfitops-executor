/**
 * YFitOps Terminal Executor Backend
 * -----------------------------------
 * WebSocket server that spawns real bash shells via node-pty.
 * Deploy to Render (Classic4440/yfitops-executor) as a Node.js service.
 *
 * Required env vars (set in Render dashboard):
 *   PORT          — injected by Render automatically
 *   TERMINAL_TOKEN_SECRET — shared secret; set the same value in the
 *                           frontend VITE_TERMINAL_TOKEN_SECRET env var
 *                           (leave blank to disable token validation in dev)
 */

'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 3001;
const TOKEN_SECRET = process.env.TERMINAL_TOKEN_SECRET || '';

// ---------------------------------------------------------------------------
// HTTP server (required by Render — health check endpoint)
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (_req, res) => {
  res.json({
    service: 'YFitOps Terminal Executor',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket server mounted at /ws/terminal
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  server,
  path: '/ws/terminal',
});

wss.on('connection', (ws, req) => {
  // ── Token authentication ──────────────────────────────────
  const parsedUrl = url.parse(req.url || '', true);
  const clientToken = parsedUrl.query.token || '';

  if (TOKEN_SECRET && clientToken !== TOKEN_SECRET) {
    console.warn(`[WS] Rejected connection — invalid token from ${req.socket.remoteAddress}`);
    ws.close(4401, 'Unauthorized');
    return;
  }

  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`[WS] New terminal session from ${clientIp}`);

  // ── Spawn a bash shell via node-pty ──────────────────────
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || '/root',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
      },
    });
  } catch (err) {
    console.error('[WS] Failed to spawn pty:', err);
    ws.close(4500, 'Failed to spawn shell');
    return;
  }

  console.log(`[WS] Spawned shell PID ${ptyProcess.pid}`);

  // ── PTY output → WebSocket ──────────────────────────────
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch (e) {
        console.error('[WS] Send error:', e);
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[WS] Shell PID ${ptyProcess.pid} exited (code=${exitCode}, signal=${signal})`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'Shell exited');
    }
  });

  // ── WebSocket messages → PTY input ─────────────────────
  ws.on('message', (rawMessage) => {
    let msg;
    try {
      // Accept both plain string (raw input) and JSON {type, ...}
      const text = rawMessage.toString();
      msg = JSON.parse(text);
    } catch {
      // Plain string — treat as raw terminal input
      try {
        ptyProcess.write(rawMessage.toString());
      } catch (e) {
        console.error('[WS] Write error (plain):', e);
      }
      return;
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      try {
        ptyProcess.write(msg.data);
      } catch (e) {
        console.error('[WS] Write error (input):', e);
      }
    } else if (msg.type === 'resize') {
      const cols = Math.max(1, parseInt(msg.cols) || 80);
      const rows = Math.max(1, parseInt(msg.rows) || 24);
      try {
        ptyProcess.resize(cols, rows);
        console.log(`[WS] Resized PTY to ${cols}×${rows}`);
      } catch (e) {
        console.error('[WS] Resize error:', e);
      }
    }
  });

  // ── WebSocket close → kill PTY ──────────────────────────
  ws.on('close', (code, reason) => {
    console.log(`[WS] Client disconnected (code=${code}, reason=${reason})`);
    try {
      ptyProcess.kill();
    } catch {
      // Already dead — ignore
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error:', err);
    try {
      ptyProcess.kill();
    } catch {
      // Ignore
    }
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[Server] YFitOps Terminal Executor listening on port ${PORT}`);
  console.log(`[Server] WebSocket endpoint: ws://0.0.0.0:${PORT}/ws/terminal`);
  if (TOKEN_SECRET) {
    console.log('[Server] Token authentication: ENABLED');
  } else {
    console.log('[Server] Token authentication: DISABLED (set TERMINAL_TOKEN_SECRET to enable)');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});
