/**
 * Meshtastic Routes
 * Proxies to a local Meshtastic device's HTTP API for node/message data.
 * Can be configured from the UI (persists to data/meshtastic-config.json)
 * or via .env (MESHTASTIC_ENABLED=true, MESHTASTIC_HOST=http://meshtastic.local).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const fetch = require('node-fetch');

module.exports = function meshtasticRoutes(app, ctx) {
  const { logDebug, logInfo, logWarn, logErrorOnce, requireWriteAuth, writeLimiter, ROOT_DIR } = ctx;

  // ── Constants ──
  const CONFIG_FILE = path.join(ROOT_DIR, 'data', 'meshtastic-config.json');
  const MIN_POLL_MS = 5000;
  const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes max

  // ── SSRF protection: validate and sanitize device host URLs ──
  // Meshtastic devices live on the local network. We allow private/loopback
  // IPs and .local/.lan hostnames, but block public IPs, metadata endpoints,
  // and non-http schemes to prevent this endpoint from being used as an SSRF gadget.

  function validateDeviceHost(raw) {
    if (!raw || typeof raw !== 'string') return { ok: false, error: 'Host is required' };

    // Strip trailing slashes without a vulnerable regex — just trim the end
    let trimmed = raw.trim();
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);

    // Parse with URL constructor
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, error: 'Host must be a valid URL (e.g. http://meshtastic.local)' };
    }

    // Enforce http/https only
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Host must use http or https' };
    }

    const hostname = parsed.hostname;

    // Block known dangerous endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return { ok: false, error: 'Cloud metadata endpoints are not allowed' };
    }

    // If it's an IP address, only allow private/loopback ranges
    if (net.isIP(hostname)) {
      const parts = hostname.split('.').map(Number);
      if (parts.length === 4) {
        const [o1, o2] = parts;
        const isPrivate =
          o1 === 127 || // loopback
          o1 === 10 || // 10.0.0.0/8
          (o1 === 172 && o2 >= 16 && o2 <= 31) || // 172.16.0.0/12
          (o1 === 192 && o2 === 168); // 192.168.0.0/16
        if (!isPrivate) {
          return { ok: false, error: 'Only private/local network IP addresses are allowed for Meshtastic devices' };
        }
      } else {
        // IPv6 — block unless loopback
        if (hostname !== '::1') {
          return { ok: false, error: 'Only IPv4 private addresses or ::1 are allowed' };
        }
      }
    }

    // Use the parsed origin (scheme + host + port) as the canonical URL
    // This normalizes the input and prevents path traversal
    return { ok: true, host: parsed.origin };
  }

  function clampPollMs(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 10000;
    return Math.min(Math.max(MIN_POLL_MS, parsed), MAX_POLL_MS);
  }

  // ── Persisted config ──

  function loadConfig() {
    // .env takes highest priority
    if (process.env.MESHTASTIC_ENABLED === 'true') {
      const envHost = process.env.MESHTASTIC_HOST || 'http://meshtastic.local';
      const validated = validateDeviceHost(envHost);
      return {
        enabled: true,
        host: validated.ok ? validated.host : envHost.replace(/\/+$/, ''),
        pollMs: clampPollMs(process.env.MESHTASTIC_POLL_MS || '10000'),
        source: 'env',
      };
    }
    // Then try saved config file
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (data.enabled && data.host) {
          const validated = validateDeviceHost(data.host);
          if (!validated.ok) {
            logWarn(`[Meshtastic] Saved host rejected: ${validated.error}`);
            return { enabled: false, host: '', pollMs: 10000, source: 'none' };
          }
          return { enabled: true, host: validated.host, pollMs: clampPollMs(data.pollMs), source: 'saved' };
        }
        return { ...data, source: 'saved' };
      }
    } catch (e) {
      logWarn(`[Meshtastic] Failed to load config: ${e.message}`);
    }
    return { enabled: false, host: '', pollMs: 10000, source: 'none' };
  }

  function saveConfig(cfg) {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      return true;
    } catch (e) {
      logWarn(`[Meshtastic] Failed to save config: ${e.message}`);
      return false;
    }
  }

  // Runtime config — can change without restart
  let config = loadConfig();

  // In-memory state
  const state = {
    connected: false,
    lastSeen: 0,
    lastError: null,
    myNodeNum: null,
    nodes: new Map(),
    messages: [],
    maxMessages: 200,
    deviceInfo: null,
  };

  let pollTimer = null;
  let infoTimer = null;

  // ── Data parsing ──

  function parseNodeInfo(packet) {
    if (!packet?.user && !packet?.position) return null;
    const num = packet.num || packet.nodeNum;
    if (!num) return null;

    const existing = state.nodes.get(num) || {};
    const node = {
      ...existing,
      num,
      id: packet.user?.id || existing.id || `!${num.toString(16)}`,
      longName: packet.user?.longName || existing.longName || '',
      shortName: packet.user?.shortName || existing.shortName || '',
      hwModel: packet.user?.hwModel || existing.hwModel || '',
      lat: packet.position?.latitudeI != null ? packet.position.latitudeI / 1e7 : existing.lat || null,
      lon: packet.position?.longitudeI != null ? packet.position.longitudeI / 1e7 : existing.lon || null,
      alt: packet.position?.altitude ?? existing.alt ?? null,
      batteryLevel: packet.deviceMetrics?.batteryLevel ?? existing.batteryLevel ?? null,
      voltage: packet.deviceMetrics?.voltage ?? existing.voltage ?? null,
      snr: packet.snr ?? existing.snr ?? null,
      lastHeard: packet.lastHeard ? packet.lastHeard * 1000 : existing.lastHeard || Date.now(),
      hopsAway: packet.hopsAway ?? existing.hopsAway ?? null,
    };
    state.nodes.set(num, node);
    return node;
  }

  function addMessage(msg) {
    if (msg.id && state.messages.some((m) => m.id === msg.id)) return;
    state.messages.push(msg);
    if (state.messages.length > state.maxMessages) {
      state.messages = state.messages.slice(-state.maxMessages);
    }
  }

  // ── Device communication (all use validated config.host) ──

  async function fetchNodes() {
    try {
      const res = await fetch(`${config.host}/api/v1/nodes`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const nodeList = data.nodes || data;
      if (Array.isArray(nodeList)) nodeList.forEach((n) => parseNodeInfo(n));
      else if (typeof nodeList === 'object') Object.values(nodeList).forEach((n) => parseNodeInfo(n));

      state.connected = true;
      state.lastSeen = Date.now();
      state.lastError = null;
      logDebug(`[Meshtastic] Fetched ${state.nodes.size} nodes`);
    } catch (e) {
      if (state.connected) logErrorOnce('Meshtastic', `Node fetch failed: ${e.message}`);
      state.connected = false;
      state.lastError = e.message;
    }
  }

  async function fetchMessages() {
    try {
      const res = await fetch(`${config.host}/api/v1/messages`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();

      const msgList = data.messages || data;
      if (Array.isArray(msgList)) {
        msgList.forEach((m) => {
          const fromNode = state.nodes.get(m.from);
          addMessage({
            id: m.id || m.packetId || `${m.from}-${m.rxTime || Date.now()}`,
            from: m.from,
            to: m.to,
            text: m.text || m.payload || '',
            timestamp: m.rxTime ? m.rxTime * 1000 : Date.now(),
            channel: m.channel ?? 0,
            fromName: fromNode?.longName || fromNode?.shortName || `!${(m.from || 0).toString(16)}`,
          });
        });
      }
    } catch {}
  }

  async function fetchDeviceInfo() {
    try {
      const res = await fetch(`${config.host}/api/v1/config`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();
      state.deviceInfo = {
        firmwareVersion: data.firmwareVersion || data.version || null,
        hwModel: data.hwModel || null,
        region: data.lora?.region || data.region || null,
        modemPreset: data.lora?.modemPreset || null,
        shortName: data.owner?.shortName || null,
        longName: data.owner?.longName || null,
      };
    } catch {}
  }

  // ── Polling lifecycle ──

  function startPolling() {
    stopPolling();
    if (!config.enabled || !config.host) return;

    const interval = clampPollMs(config.pollMs);
    logInfo(`[Meshtastic] Starting — polling ${config.host} every ${interval}ms`);

    setTimeout(async () => {
      await fetchDeviceInfo();
      await fetchNodes();
      await fetchMessages();
    }, 1000);

    pollTimer = setInterval(async () => {
      await fetchNodes();
      await fetchMessages();
    }, interval);

    infoTimer = setInterval(fetchDeviceInfo, 5 * 60 * 1000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (infoTimer) {
      clearInterval(infoTimer);
      infoTimer = null;
    }
  }

  // Start if already configured
  if (config.enabled) startPolling();

  // ── API Endpoints ──

  app.get('/api/meshtastic/status', (req, res) => {
    res.json({
      enabled: config.enabled,
      connected: state.connected,
      lastSeen: state.lastSeen,
      lastError: state.lastError,
      host: config.enabled ? config.host : null,
      pollMs: config.pollMs,
      configSource: config.source,
      nodeCount: state.nodes.size,
      messageCount: state.messages.length,
      deviceInfo: state.deviceInfo,
    });
  });

  app.get('/api/meshtastic/nodes', (req, res) => {
    const nodes = [...state.nodes.values()].map((n) => ({
      num: n.num,
      id: n.id,
      longName: n.longName,
      shortName: n.shortName,
      lat: n.lat,
      lon: n.lon,
      alt: n.alt,
      batteryLevel: n.batteryLevel,
      voltage: n.voltage,
      snr: n.snr,
      lastHeard: n.lastHeard,
      hopsAway: n.hopsAway,
      hwModel: n.hwModel,
      hasPosition: n.lat != null && n.lon != null,
    }));
    res.json({ connected: state.connected, nodes, timestamp: Date.now() });
  });

  app.get('/api/meshtastic/messages', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const messages = since ? state.messages.filter((m) => m.timestamp > since) : state.messages;
    res.json({ connected: state.connected, messages: messages.slice(-100), timestamp: Date.now() });
  });

  app.post('/api/meshtastic/send', writeLimiter, requireWriteAuth, async (req, res) => {
    if (!config.enabled || !state.connected) {
      return res.status(503).json({ error: 'Meshtastic not connected' });
    }
    const { text, to, channel } = req.body || {};
    if (!text || typeof text !== 'string' || text.length > 228) {
      return res.status(400).json({ error: 'Text required (max 228 chars)' });
    }
    try {
      const payload = { text: text.trim(), to: to || 0xffffffff, channel: channel || 0 };
      const sendRes = await fetch(`${config.host}/api/v1/sendtext`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!sendRes.ok) throw new Error(`Device returned ${sendRes.status}`);
      addMessage({
        id: `local-${Date.now()}`,
        from: state.myNodeNum || 0,
        to: payload.to,
        text: payload.text,
        timestamp: Date.now(),
        channel: payload.channel,
        fromName: state.deviceInfo?.longName || 'Me',
      });
      res.json({ ok: true });
    } catch (e) {
      logErrorOnce('Meshtastic', `Send failed: ${e.message}`);
      res.status(500).json({ error: `Send failed: ${e.message}` });
    }
  });

  // POST /api/meshtastic/configure — enable/disable and set host from the UI
  app.post('/api/meshtastic/configure', writeLimiter, requireWriteAuth, async (req, res) => {
    const { enabled, host, pollMs } = req.body || {};

    // Enable with host
    if (enabled && host) {
      // Validate and sanitize the host URL (SSRF protection)
      const validated = validateDeviceHost(host);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }
      const safeHost = validated.host;

      // Test connection before saving
      try {
        const testRes = await fetch(`${safeHost}/api/v1/nodes`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!testRes.ok) {
          return res.status(502).json({ error: `Device returned HTTP ${testRes.status}. Check the address.` });
        }
      } catch (e) {
        return res.status(502).json({
          error: `Cannot reach ${safeHost} — ${e.message}. Make sure the device is on and the address is correct.`,
        });
      }

      // Save and start
      const safePollMs = clampPollMs(pollMs);
      config = { enabled: true, host: safeHost, pollMs: safePollMs, source: 'saved' };
      saveConfig({ enabled: config.enabled, host: config.host, pollMs: config.pollMs });
      state.nodes.clear();
      state.messages = [];
      state.connected = false;
      state.deviceInfo = null;
      state.lastError = null;
      startPolling();

      return res.json({ ok: true, enabled: true, host: config.host, message: 'Connected and saved.' });
    }

    // Disable
    if (enabled === false) {
      stopPolling();
      config = { enabled: false, host: config.host, pollMs: config.pollMs, source: 'saved' };
      state.connected = false;
      state.lastError = null;
      saveConfig({ enabled: false, host: config.host, pollMs: config.pollMs });
      return res.json({ ok: true, enabled: false, message: 'Meshtastic disabled.' });
    }

    res.status(400).json({ error: 'Provide { enabled: true, host: "http://..." } or { enabled: false }' });
  });

  return { meshtasticState: state };
};
