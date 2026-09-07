'use strict';

const fs = require('fs');
const path = require('path');
const { createDevice, getDevice, listDevices, deleteDevice } = require('../services/deviceRegistry');
const { startNewSession, stopSession } = require('../services/sessionManager');
const { getSession } = require('../whatsapp/client');
const socketManager = require('../services/socketManager');
const config = require('../config');
const logger = require('../utils/logger');
const { buildTenantFilter, buildOwnershipData, isSuperAdmin } = require('../utils/tenantHelpers');
const { ROLES } = require('../models/User');


function resolveOwnership(req) {
  if (isSuperAdmin(req)) {

    const { customerId } = req.body;
    if (!customerId) {
      throw Object.assign(
        new Error('customerId is required in request body for SUPER_ADMIN.'),
        { status: 400 }
      );
    }
    return {
      customerId,
      subCustomerId: req.body.subCustomerId || null,
      createdBy: req.user.userId,
    };
  }

  return buildOwnershipData(req);
}

async function createDeviceHandler(req, res) {
  try {
    const { label } = req.body;
    const ownership = resolveOwnership(req);

    const device = await createDevice(label, ownership);

    require('./qrController').registerSessionToken(device.sessionName, device.token);
    startNewSession(device.sessionName);

    logger.info(
      `[Device] Created: ${device.sessionName} (customerId: ${ownership.customerId})`
    );

    socketManager.emitDevicesUpdate();

    return res.status(201).json({
      success: true,
      message: 'Device created. Connect to the SSE stream to receive the QR code.',
      device: {
        token:                device.token,
        label:                device.label,
        session:              device.sessionName,
        customerId:           device.customerId,
        subCustomerId:        device.subCustomerId,
        createdAt:            device.createdAt,
        status:               'launching',
        isReady:              false,
        estimated_qr_seconds: 20,
        events_url:           `/devices/${device.token}/qrcode/events`,
        status_url:           `/devices/${device.token}/qrcode/status`,
        image_url:            `/devices/${device.token}/qrcode/image`,
      },
    });
  } catch (err) {
    logger.error(`[Device] createDeviceHandler error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function listDevicesHandler(req, res) {
  try {

    const tenantFilter = buildTenantFilter(req);

    const rawDevices = await listDevices(tenantFilter);

    const devices = rawDevices.map((d) => {
      const session = getSession(d.sessionName);
      return {
        token:         d.token,
        label:         d.label,
        session:       d.sessionName,
        customerId:    d.customerId,
        subCustomerId: d.subCustomerId,
        createdAt:     d.createdAt,
        status:        session?.status || 'unknown',
        isReady:       session?.isReady || false,
        events_url:    `/devices/${d.token}/qrcode/events`,
        status_url:    `/devices/${d.token}/qrcode/status`,
        image_url:     `/devices/${d.token}/qrcode/image`,
      };
    });

    return res.json({ success: true, count: devices.length, devices });
  } catch (err) {
    logger.error(`[Device] listDevicesHandler error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to list devices.' });
  }
}

async function getDeviceHandler(req, res) {
  try {
    const tenantFilter = buildTenantFilter(req);

    const device = await getDevice(req.params.token, tenantFilter);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found.' });
    }

    const session = getSession(device.sessionName);
    return res.json({
      success: true,
      device: {
        token:         device.token,
        label:         device.label,
        session:       device.sessionName,
        customerId:    device.customerId,
        subCustomerId: device.subCustomerId,
        createdAt:     device.createdAt,
        status:        session?.status || 'unknown',
        isReady:       session?.isReady || false,
        events_url:    `/devices/${device.token}/qrcode/events`,
        status_url:    `/devices/${device.token}/qrcode/status`,
        image_url:     `/devices/${device.token}/qrcode/image`,
      },
    });
  } catch (err) {
    logger.error(`[Device] getDeviceHandler error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to get device.' });
  }
}

async function deleteDeviceHandler(req, res) {
  try {
    const { token } = req.params;


    const tenantFilter = buildTenantFilter(req);
    const device = await getDevice(token, tenantFilter);

    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found.' });
    }

    logger.info(`[Device] Disconnecting WhatsApp session for "${device.sessionName}"...`);
    await stopSession(device.sessionName, true);


    const sessionFolder = path.resolve(config.whatsapp.sessionPath, device.sessionName);
    try {
      if (fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
        logger.info(`[Device] Removed session folder: ${sessionFolder}`);
      }
    } catch (err) {
      logger.warn(`[Device] Could not remove session folder "${sessionFolder}": ${err.message}`);
    }

    await deleteDevice(token);

    logger.info(`[Device] Deleted: ${device.sessionName} by user ${req.user.userId}`);

    socketManager.emitDevicesUpdate();

    return res.json({ success: true, message: `Device "${device.label}" removed.` });
  } catch (err) {
    logger.error(`[Device] deleteDeviceHandler error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to delete device.' });
  }
}

module.exports = {
  createDeviceHandler,
  listDevicesHandler,
  getDeviceHandler,
  deleteDeviceHandler,
};
