'use strict';

const path   = require('path');
const fs     = require('fs');
const QRCode = require('qrcode');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

const config = require('../config');
const logger = require('../utils/logger');


const P = require('pino');
const baileysLogger = P({ level: 'silent' });

function toJid(chatId) {
  if (!chatId) return chatId;
  return chatId.replace('@c.us', '@s.whatsapp.net');
}

class WhatsAppClient {
  constructor(sessionName) {
    this.sessionName     = sessionName;
    this.sock            = null;
    this.isReady         = false;
    this.latestQR        = null;
    this.status          = 'initialising';
    this.destroyed       = false;

    this._state      = null;
    this._saveCreds  = null;
    this._version    = null;
    this._qrExpireTimer = null;
    this._qrListeners = new Set();
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;

    this.authDir = path.resolve(config.whatsapp.sessionPath, this.sessionName);
  }

  // Check if there is a valid registered session on disk
  _hasValidSession() {
    try {
      const credsPath = path.join(this.authDir, 'creds.json');
      if (!fs.existsSync(credsPath)) return false;
      const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      // A session is valid if explicitly marked registered, or has account/me data
      return Boolean(data && (data.registered === true || data.me?.id || data.account));
    } catch (_) {
      return false;
    }
  }

  // Fetch WA version with a 2000ms timeout so we never block QR on a slow network
  async _ensureVersion() {
    if (!this._version) {
      try {
        const fetchPromise    = fetchLatestBaileysVersion();
        const timeoutPromise  = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Version fetch timeout')), 2000)
        );
        const { version } = await Promise.race([fetchPromise, timeoutPromise]);
        this._version = version || [2, 3000, 1043857760];
        logger.info(`[WhatsApp:${this.sessionName}] WA version: ${this._version.join('.')}`);
      } catch (_) {
        this._version = [2, 3000, 1043857760];
        logger.warn(`[WhatsApp:${this.sessionName}] Using fallback WA version.`);
      }
    }
    return this._version;
  }

  // Wait up to timeoutMs for a QR to appear (or for the session to become connected)
  _waitForQR(timeoutMs = 5000) {
    if (this.latestQR) return Promise.resolve(this.latestQR);
    if (this.isReady || this.status === 'connected') return Promise.resolve(null);

    return new Promise((resolve) => {
      let cleanup;
      const timer = setTimeout(() => {
        if (cleanup) cleanup();
        resolve(this.latestQR);
      }, timeoutMs);

      const listener = (event, qr) => {
        if (event === 'qr' || qr) {
          clearTimeout(timer);
          if (cleanup) cleanup();
          resolve(qr || this.latestQR);
        } else if (event === 'connected') {
          clearTimeout(timer);
          if (cleanup) cleanup();
          resolve(null);
        }
      };
      this._qrListeners.add(listener);
      cleanup = () => this._qrListeners.delete(listener);
    });
  }

  _notifyQRListeners(event, qr) {
    for (const listener of this._qrListeners) {
      try { listener(event, qr); } catch (_) {}
    }
  }

  async init() {
    logger.info(`[WhatsApp:${this.sessionName}] Initialising (Baileys)...`);
    this.status = 'launching';

    const hasSession = this._hasValidSession();

    // If there is no valid authenticated session on disk, clear any stale incomplete files
    // so Baileys emits QR immediately instead of hanging
    if (!hasSession) {
      this._clearAuth();
    }

    fs.mkdirSync(this.authDir, { recursive: true });

    await this._ensureVersion();

    await this._openSocket();

    // If there was no existing session, wait up to 5 seconds for the QR so callers get it immediately
    if (!hasSession) {
      await this._waitForQR(5000);
    }
  }

  async _openSocket() {
    if (this.destroyed) return;

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    // Refresh auth state from disk
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this._state     = state;
    this._saveCreds = saveCreds;

    await this._ensureVersion();

    const sock = makeWASocket({
      version:                      this._version,
      logger:                       baileysLogger,
      auth: {
        creds: this._state.creds,
        keys:  makeCacheableSignalKeyStore(this._state.keys, baileysLogger),
      },
      browser:                      Browsers.ubuntu('Chrome'),
      printQRInTerminal:            false,
      keepAliveIntervalMs:          30_000,
      retryRequestDelayMs:          2_000,
      markOnlineOnConnect:          true,
      generateHighQualityLinkPreview: false,
      syncFullHistory:              false,
      fireInitQueries:              true,
      maxMsgRetryCount:             5,
      emitOwnEvents:                true,
    });

    this.sock = sock;

    sock.ev.on('creds.update', async () => {
      try {
        await this._saveCreds();
      } catch (err) {
        logger.error(`[WhatsApp:${this.sessionName}] Error saving creds: ${err.message}`);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const base64Png   = await QRCode.toDataURL(qr, { scale: 6 });
          this.latestQR     = base64Png;
          this.status       = 'qr_ready';
          this.isReady      = false;
          if (this._qrExpireTimer) clearTimeout(this._qrExpireTimer);
          this._qrExpireTimer = setTimeout(() => {
            if (this.latestQR === base64Png) {
              this.latestQR = null;
            }
          }, 60_000);
          logger.info(`[WhatsApp:${this.sessionName}] QR ready — scan now`);
          // Notify _waitForQR listeners immediately so init() returns with QR
          this._notifyQRListeners('qr', base64Png);
          try {
            require('../controllers/qrController')
              .notifyQRUpdateForSession(this.sessionName, base64Png);
          } catch (_) {}
        } catch (err) {
          logger.error(`[WhatsApp:${this.sessionName}] QR generation failed: ${err.message}`);
        }
      }

      if (connection === 'connecting') {
        this.status = 'connecting';
        logger.info(`[WhatsApp:${this.sessionName}] Connecting...`);
        try {
          require('../controllers/qrController')
            .notifyStatusForSession(this.sessionName, 'connecting');
        } catch (_) {}
      }

      if (connection === 'open') {
        this.isReady            = true;
        this.latestQR           = null;
        this.status             = 'connected';
        this._reconnectAttempts = 0;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        logger.info(`[WhatsApp:${this.sessionName}] Connected ✓`);

        // Ensure registered flag is saved in creds
        if (this._state?.creds && !this._state.creds.registered) {
          this._state.creds.registered = true;
          try {
            await this._saveCreds();
          } catch (_) {}
        }

        // Notify _waitForQR listeners that we are connected (no QR needed)
        this._notifyQRListeners('connected', null);
        try {
          require('../controllers/qrController')
            .notifyConnectedForSession(this.sessionName);
        } catch (_) {}
        try {
          require('../services/sessionManager')._onSessionReady(this.sessionName);
        } catch (_) {}
      }

      if (connection === 'close') {
        this.isReady  = false;
        this.latestQR = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason     = lastDisconnect?.error?.message || 'unknown';
        logger.warn(
          `[WhatsApp:${this.sessionName}] Closed — code: ${statusCode}, reason: ${reason}`
        );

        if (this.destroyed) {
          this.status = 'disconnected';
          return;
        }

        // Check if this is an intentional logout from WhatsApp (e.g. mobile app -> Linked Devices -> Log out)
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          logger.warn(`[WhatsApp:${this.sessionName}] Logged out by WhatsApp/user — clearing auth & restarting.`);
          this.status = 'qr_pending';
          this._clearAuth();
          try {
            require('../controllers/qrController')
              .notifyStatusForSession(this.sessionName, 'qr_pending');
          } catch (_) {}
          try {
            require('../services/sessionManager').restartSession(this.sessionName);
          } catch (_) {}
          return;
        }

        // For all other reasons (connectionClosed: 428, connectionLost: 408, timedOut: 408,
        // restartRequired: 515, unavailableService: 503, badSession: 500, network drop, etc.):
        // We MUST reconnect automatically without wiping auth or resetting session!
        this.status = 'connecting';
        this._reconnectAttempts++;

        // Exponential backoff: 1.5s, 3s, 6s, 12s, max 30s
        const delay = statusCode === DisconnectReason.restartRequired
          ? 1_500
          : Math.min(1_500 * Math.pow(2, Math.min(this._reconnectAttempts - 1, 4)), 30_000);

        logger.info(
          `[WhatsApp:${this.sessionName}] Reconnecting socket in ${delay}ms (attempt #${this._reconnectAttempts})...`
        );

        try {
          require('../controllers/qrController')
            .notifyStatusForSession(this.sessionName, 'connecting');
        } catch (_) {}

        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(async () => {
          if (!this.destroyed) {
            try {
              await this._openSocket();
            } catch (err) {
              logger.error(`[WhatsApp:${this.sessionName}] _openSocket reconnect error: ${err.message}`);
            }
          }
        }, delay);
      }
    });

  }

  async sendText(chatId, message) {
    this._assertReady();
    const jid = toJid(chatId);
    try {
      return await this.sock.sendMessage(jid, { text: message });
    } catch (err) {
      logger.error(`[WhatsApp:${this.sessionName}] sendText failed: ${err.message}`);
      throw err;
    }
  }

  async sendMedia(chatId, fileBuffer, mimeType, filename, caption) {
    this._assertReady();
    const jid     = toJid(chatId);
    const content = this._buildMediaMessage(fileBuffer, mimeType, filename, caption || '');
    try {
      return await this.sock.sendMessage(jid, content);
    } catch (err) {
      logger.error(`[WhatsApp:${this.sessionName}] sendMedia failed: ${err.message}`);
      throw err;
    }
  }

  onMessage(handler) {}

  async logout() {
    if (this.sock && this.isReady) {
      try {
        logger.info(`[WhatsApp:${this.sessionName}] Logging out from WhatsApp...`);
        await this.sock.logout();
        logger.info(`[WhatsApp:${this.sessionName}] Logged out from WhatsApp.`);
      } catch (err) {
        logger.warn(`[WhatsApp:${this.sessionName}] Logout error (ignored): ${err.message}`);
      }
    }
  }

  async close(logoutFromWhatsApp = false) {
    if (logoutFromWhatsApp) {
      await this.logout();
    }
    this.destroyed = true;
    this.isReady   = false;
    this.status    = 'disconnected';
    if (this._qrExpireTimer) {
      clearTimeout(this._qrExpireTimer);
      this._qrExpireTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.latestQR = null;
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }
    logger.info(`[WhatsApp:${this.sessionName}] Closed.`);
  }

  _buildMediaMessage(buffer, mimeType, filename, caption) {
    if (mimeType === 'image/gif') {
      return { video: buffer, gifPlayback: true, caption, mimetype: mimeType, fileName: filename };
    }
    if (mimeType.startsWith('image/')) {
      return { image: buffer, caption, mimetype: mimeType, fileName: filename };
    }
    if (mimeType.startsWith('video/')) {
      return { video: buffer, caption, mimetype: mimeType, fileName: filename };
    }
    if (mimeType.startsWith('audio/')) {
      return { audio: buffer, mimetype: mimeType, ptt: false };
    }
    return { document: buffer, mimetype: mimeType, fileName: filename, caption };
  }

  _clearAuth() {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
        logger.info(`[WhatsApp:${this.sessionName}] Auth cleared.`);
      }
    } catch (err) {
      logger.warn(`[WhatsApp:${this.sessionName}] Could not clear auth: ${err.message}`);
    }
  }

  _assertReady() {
    if (!this.isReady || !this.sock) {
      throw new Error(
        `Session "${this.sessionName}" is not ready. Scan QR at /devices/{token}/qrcode`
      );
    }
  }
}


const sessions = new Map();

function getSession(name) {
  if (!sessions.has(name)) {
    sessions.set(name, new WhatsAppClient(name));
  }
  return sessions.get(name);
}

function removeSession(name) {
  sessions.delete(name);
}

module.exports = { WhatsAppClient, getSession, removeSession, sessions };
