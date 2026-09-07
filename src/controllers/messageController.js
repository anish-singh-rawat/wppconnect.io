'use strict';

const {
  sendSingle,
  sendSingleMedia,
  enqueueBulk,
  enqueueBulkMedia,
  enqueueBulkRecipients,
  getQueueStatus,
  getJobById,
  stopCampaign: messagingServiceStopCampaign,
} = require('../services/messagingService');
const { parseCsvNumbers, parseCsvRecipients } = require('../utils/csvParser');
const { isNonEmptyString, isNonEmptyArray } = require('../utils/helpers');
const { getDevice } = require('../services/deviceRegistry');
const { buildTenantFilter, getEffectiveCustomerId } = require('../utils/tenantHelpers');
const { ROLES } = require('../models/User');
const MessageJob = require('../models/MessageJob');
const logger = require('../utils/logger');


async function validateSessionOwnership(req) {
  const tenantFilter = buildTenantFilter(req);
  const device = await getDevice(req.params.token, tenantFilter);

  if (!device) {
    const err = new Error('Device not found or does not belong to your account.');
    err.status = 403;
    throw err;
  }

  return device;
}

function resolveJobOwnership(req) {
  const userId = req.user?.userId;
  const role   = req.user?.role;

  if (role === ROLES.CUSTOMER) {
    return {
      customerId:    userId,
      subCustomerId: null,
      createdBy:     userId,
    };
  }

  if (role === ROLES.SUB_CUSTOMER) {
    return {
      customerId:    req.user.parentCustomerId,
      subCustomerId: userId,
      createdBy:     userId,
    };
  }

  return {
    customerId:    null,
    subCustomerId: null,
    createdBy:     userId,
  };
}

async function sendMessage(req, res) {
  try {
    const device = await validateSessionOwnership(req);

    const { number, message, link } = req.body;
    const { sessionName } = req;

    if (!isNonEmptyString(number)) {
      return res.status(400).json({ success: false, error: '"number" is required.' });
    }
    if (!isNonEmptyString(message)) {
      return res.status(400).json({ success: false, error: '"message" is required.' });
    }

    const fullMessage =
      link && link.trim() ? `${message.trim()}\n\n${link.trim()}` : message.trim();

    const result = await sendSingle(number.trim(), fullMessage, sessionName);
    return res.json({ success: true, result });
  } catch (err) {
    logger.error(`[Controller] sendMessage error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function sendMediaMessage(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: 'Media file required (field: "media").' });
    }

    const device = await validateSessionOwnership(req);

    const { number, message, link } = req.body;
    const { sessionName } = req;

    if (!isNonEmptyString(number)) {
      return res.status(400).json({ success: false, error: '"number" is required.' });
    }

    const captionParts = [];
    if (message && message.trim()) captionParts.push(message.trim());
    if (link && link.trim())       captionParts.push(link.trim());
    const caption = captionParts.join('\n\n');

    const result = await sendSingleMedia(
      number.trim(),
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      caption,
      sessionName
    );

    return res.json({ success: true, result });
  } catch (err) {
    logger.error(`[Controller] sendMediaMessage error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function bulkSendMessage(req, res) {
  try {
    const device = await validateSessionOwnership(req);
    const ownership = resolveJobOwnership(req);
    if (!ownership.customerId) ownership.customerId = device.customerId;

    const { numbers, message, link } = req.body;
    const { sessionName } = req;

    if (!isNonEmptyArray(numbers)) {
      return res
        .status(400)
        .json({ success: false, error: '"numbers" must be a non-empty array.' });
    }
    if (!isNonEmptyString(message)) {
      return res.status(400).json({ success: false, error: '"message" is required.' });
    }

    const sanitised = numbers
      .map((n) => String(n).trim())
      .filter((n) => n.length > 0);

    if (sanitised.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid numbers provided.' });
    }

    const fullMessage =
      link && link.trim() ? `${message.trim()}\n\n${link.trim()}` : message.trim();

    const jobs = await enqueueBulk(sanitised, fullMessage, sessionName, ownership);

    return res.json({
      success:    true,
      session:    sessionName,
      queued:     jobs.filter((j) => j.status === 'queued').length,
      duplicates: jobs.filter((j) => j.status === 'duplicate').length,
      jobs,
    });
  } catch (err) {
    logger.error(`[Controller] bulkSendMessage error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}


async function bulkSendMediaMessage(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: 'Media file required (field: "media").' });
    }

    const device = await validateSessionOwnership(req);
    const ownership = resolveJobOwnership(req);
    if (!ownership.customerId) ownership.customerId = device.customerId;

    const { numbers: numbersRaw, message, link } = req.body;
    const { sessionName } = req;

    let numbers;
    try {
      numbers = typeof numbersRaw === 'string' ? JSON.parse(numbersRaw) : numbersRaw;
    } catch {
      return res
        .status(400)
        .json({ success: false, error: '"numbers" must be a JSON array.' });
    }

    if (!isNonEmptyArray(numbers)) {
      return res
        .status(400)
        .json({ success: false, error: '"numbers" must be a non-empty array.' });
    }

    const sanitised = numbers
      .map((n) => String(n).trim())
      .filter((n) => n.length > 0);

    if (sanitised.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid numbers provided.' });
    }

    const captionParts = [];
    if (message && message.trim()) captionParts.push(message.trim());
    if (link && link.trim())       captionParts.push(link.trim());
    const caption = captionParts.join('\n\n');

    const jobs = await enqueueBulkMedia(
      sanitised,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      caption,
      sessionName,
      ownership
    );

    return res.json({
      success: true,
      session: sessionName,
      queued:  jobs.filter((j) => j.status === 'queued').length,
      jobs,
    });
  } catch (err) {
    logger.error(`[Controller] bulkSendMediaMessage error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function bulkSendCsv(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: 'CSV file required (field: "file").' });
    }

    const device = await validateSessionOwnership(req);
    const ownership = resolveJobOwnership(req);
    if (!ownership.customerId) ownership.customerId = device.customerId;

    const fallbackMessage = isNonEmptyString(req.body.message) ? req.body.message.trim() : null;
    const link = isNonEmptyString(req.body.link) ? req.body.link.trim() : null;
    const { sessionName } = req;

    let recipients;
    try {
      recipients = await parseCsvRecipients(req.file.buffer);
    } catch (err) {
      return res
        .status(400)
        .json({ success: false, error: `CSV parse error: ${err.message}` });
    }

    if (recipients.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'No recipients found in CSV.' });
    }

    const hasCsvMessages = recipients.some((r) => r.message);
    if (!hasCsvMessages && !fallbackMessage) {
      return res.status(400).json({
        success: false,
        error:
          'No "Message" column in CSV and no fallback "message" field in the request.',
      });
    }

    const fullFallbackMessage =
      fallbackMessage && link ? `${fallbackMessage}\n\n${link}` : fallbackMessage;

    const recipientsWithLink = link
      ? recipients.map((r) => ({
          ...r,
          message: r.message ? `${r.message}\n\n${link}` : undefined,
        }))
      : recipients;

    const jobs = await enqueueBulkRecipients(
      recipientsWithLink,
      fullFallbackMessage,
      sessionName,
      ownership
    );

    return res.json({
      success:    true,
      session:    sessionName,
      parsed:     recipients.length,
      queued:     jobs.filter((j) => j.status === 'queued').length,
      duplicates: jobs.filter((j) => j.status === 'duplicate').length,
      skipped:    jobs.filter((j) => j.status === 'skipped').length,
      jobs,
    });
  } catch (err) {
    logger.error(`[Controller] bulkSendCsv error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function getQueue(req, res) {
  try {
    const { sessionName } = req;
    const { status } = req.query;


    await validateSessionOwnership(req);


    const tenantFilter = buildTenantFilter(req);
    const jobs = await getQueueStatus(status || 'all', sessionName, tenantFilter);

    return res.json({ success: true, session: sessionName, count: jobs.length, jobs });
  } catch (err) {
    logger.error(`[Controller] getQueue error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

async function getQueueJob(req, res) {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }


    const userId   = req.user?.userId?.toString();
    const role     = req.user?.role;
    const parentId = req.user?.parentCustomerId?.toString();

    if (role !== ROLES.SUPER_ADMIN) {
      const jobCustId = job.customerId?.toString();
      const jobSubId  = job.subCustomerId?.toString();

      const allowed =
        (role === ROLES.CUSTOMER && jobCustId === userId) ||
        (role === ROLES.SUB_CUSTOMER && jobCustId === parentId && jobSubId === userId);

      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden. Job does not belong to your account.',
        });
      }
    }

    return res.json({ success: true, job });
  } catch (err) {
    logger.error(`[Controller] getQueueJob error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to fetch job.' });
  }
}

async function stopCampaign(req, res) {
  try {
    const { sessionName } = req;
    await validateSessionOwnership(req);

    const tenantFilter = buildTenantFilter(req);
    const result = await messagingServiceStopCampaign(sessionName, tenantFilter);

    return res.json({
      success: true,
      message: 'Campaign stopped successfully.',
      session: sessionName,
      stoppedCount: result.stoppedCount,
    });
  } catch (err) {
    logger.error(`[Controller] stopCampaign error: ${err.message}`);
    const status = err.status || 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

module.exports = {
  sendMessage,
  sendMediaMessage,
  bulkSendMessage,
  bulkSendMediaMessage,
  bulkSendCsv,
  getQueue,
  getQueueJob,
  stopCampaign,
};
