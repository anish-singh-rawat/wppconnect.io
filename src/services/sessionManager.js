'use strict';

const { WhatsAppClient, removeSession, sessions } = require('../whatsapp/client');
const { listDevices } = require('./deviceRegistry');
const logger = require('../utils/logger');

const retryTimers = new Map();
const launching   = new Set();

function resetSession(sessionName) {
  const fresh = new WhatsAppClient(sessionName);
  sessions.set(sessionName, fresh);
  return fresh;
}


async function _onSessionReady(sessionName) {
  launching.delete(sessionName);
  if (retryTimers.has(sessionName)) {
    clearTimeout(retryTimers.get(sessionName));
    retryTimers.delete(sessionName);
  }
}


async function startSession(sessionName, attempt = 1) {
  if (launching.has(sessionName)) {
    logger.info(`[SessionMgr] "${sessionName}" already launching — skip.`);
    return;
  }
  launching.add(sessionName);

  logger.info(`[SessionMgr] Starting "${sessionName}" (attempt #${attempt})...`);

  if (attempt > 1 && sessions.has(sessionName)) {
    try { await sessions.get(sessionName).close(); } catch (_) {}
  }

  const session = resetSession(sessionName);
  session.status = 'launching';

  try {
    require('../controllers/qrController').notifyStatusForSession(sessionName, 'launching');
  } catch (_) {}

  session.init()
    .then(() => {
      logger.info(`[SessionMgr] "${sessionName}" init() done — awaiting WS open.`);
    })
    .catch((err) => {
      launching.delete(sessionName);
      logger.error(`[SessionMgr] "${sessionName}" init error (attempt #${attempt}): ${err.message}`);

      const cur = sessions.get(sessionName);
      if (cur) { cur.isReady = false; cur.latestQR = null; cur.status = 'retrying'; }

      try {
        require('../controllers/qrController').notifyStatusForSession(sessionName, 'retrying');
      } catch (_) {}

      const delay = Math.min(15_000 * attempt, 60_000);
      logger.info(`[SessionMgr] Retrying "${sessionName}" in ${delay / 1000}s...`);
      const t = setTimeout(() => startSession(sessionName, attempt + 1), delay);
      retryTimers.set(sessionName, t);
    });
}

function restartSession(sessionName) {
  launching.delete(sessionName);       
  startSession(sessionName);
}

async function bootAllDevices() {
  const devices = await listDevices();
  if (devices.length === 0) {
    logger.info('[SessionMgr] No registered devices. Use POST /devices to add one.');
    return;
  }
  logger.info(`[SessionMgr] Booting ${devices.length} device(s)...`);

  try {
    const { registerSessionToken } = require('../controllers/qrController');
    for (const device of devices) {
      registerSessionToken(device.sessionName, device.token);
    }
  } catch (_) {}

  for (let i = 0; i < devices.length; i++) {
    startSession(devices[i].sessionName);
    if (i < devices.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function startNewSession(sessionName) {
  startSession(sessionName);
}

async function stopSession(sessionName, logoutFromWhatsApp = false) {
  launching.delete(sessionName);
  if (retryTimers.has(sessionName)) {
    clearTimeout(retryTimers.get(sessionName));
    retryTimers.delete(sessionName);
  }
  if (sessions.has(sessionName)) {
    try { await sessions.get(sessionName).close(logoutFromWhatsApp); } catch (_) {}
    removeSession(sessionName);
  }
}

async function shutdownAll() {
  const { sessions: all } = require('../whatsapp/client');
  for (const [name, session] of all.entries()) {
    try { await session.close(); logger.info(`[SessionMgr] Closed "${name}"`); } catch (_) {}
  }
}

module.exports = {
  startSession,
  startNewSession,
  restartSession,
  bootAllDevices,
  stopSession,
  shutdownAll,
  _onSessionReady,
};
