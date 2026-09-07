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

    this.authDir = path.resolve(config.whatsapp.sessionPath, this.sessionName);
  }

  // Check if there is a valid registered session on disk
  _hasValidSession() {
    try {
      const credsPath = path.join(this.authDir, 'creds.json');
      if (!fs.existsSync(credsPath)) return false;
      const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      return data.registered === true;
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

    // CRITICAL: If there is no valid registered session, clear any stale creds
    // so Baileys emits QR immediately instead of hanging for 30+ seconds
    if (!this._hasValidSession()) {
      this._clearAuth();
    }

    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this._state     = state;
    this._saveCreds = saveCreds;

    await this._ensureVersion();

    this._openSocket();

    // Wait up to 5 seconds for the QR so callers get it immediately
    await this._waitForQR(5000);
  }

  _openSocket() {
    if (this.destroyed) return;

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    const sock = makeWASocket({
      version:                      this._version,
      logger:                       baileysLogger,
      auth: {
        creds: this._state.creds,
        keys:  makeCacheableSignalKeyStore(this._state.keys, baileysLogger),
      },
      browser:                      ['WhatsApp', 'Chrome', '3.0'],
      printQRInTerminal:            false,
      keepAliveIntervalMs:          25_000,
      retryRequestDelayMs:          2_000,
      markOnlineOnConnect:          false,
      generateHighQualityLinkPreview: false,
      syncFullHistory:              false,
      fireInitQueries:              true,
      maxMsgRetryCount:             3,
      emitOwnEvents:                true,
    });

    this.sock = sock;

    sock.ev.on('creds.update', this._saveCreds);

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
        this.isReady  = true;
        this.latestQR = null;
        this.status   = 'connected';
        logger.info(`[WhatsApp:${this.sessionName}] Connected ✓`);
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

        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn(`[WhatsApp:${this.sessionName}] Logged out — clearing auth & restarting.`);
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

        if (statusCode === DisconnectReason.restartRequired) {
          logger.info(`[WhatsApp:${this.sessionName}] Restart required — reopening socket...`);
          this.status = 'connecting';
          setTimeout(() => this._openSocket(), 1_500);
          return;
        }

        this.status = 'retrying';
        try {
          require('../controllers/qrController')
            .notifyStatusForSession(this.sessionName, 'retrying');
        } catch (_) {}
        try {
          require('../services/sessionManager').restartSession(this.sessionName);
        } catch (_) {}
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
