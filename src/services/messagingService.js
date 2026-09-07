'use strict';

const { getSession } = require('../whatsapp/client');
const queue = require('./messageQueue');
const { toChatId } = require('../utils/helpers');
const logger = require('../utils/logger');

async function sendSingle(number, message, sessionName) {
  const session = getSession(sessionName);
  const chatId = toChatId(number);

  logger.info(`[Messaging] Sending single message to ${number}`);
  await session.sendText(chatId, message);
  logger.info(`[Messaging] ✓ Sent to ${number}`);

  return { number, status: 'sent' };
}

async function sendSingleMedia(number, fileBuffer, mimeType, filename, caption, sessionName) {
  const session = getSession(sessionName);
  const chatId = toChatId(number);

  logger.info(`[Messaging] Sending media (${mimeType}) to ${number}`);
  await session.sendMedia(chatId, fileBuffer, mimeType, filename, caption);
  logger.info(`[Messaging] ✓ Media sent to ${number}`);

  return { number, status: 'sent' };
}

async function enqueueBulk(numbers, message, sessionName, ownership = {}) {
  logger.info(`[Messaging] Enqueueing ${numbers.length} messages`);
  return queue.enqueue(numbers, message, sessionName, ownership);
}

async function enqueueBulkRecipients(recipients, fallbackMessage, sessionName, ownership = {}) {
  logger.info(`[Messaging] Enqueueing ${recipients.length} personalised messages`);
  return queue.enqueueRecipients(recipients, fallbackMessage, sessionName, ownership);
}

async function enqueueBulkMedia(numbers, fileBuffer, mimeType, filename, caption, sessionName, ownership = {}) {
  logger.info(`[Messaging] Enqueueing ${numbers.length} media messages`);
  return queue.enqueueMedia(numbers, fileBuffer, mimeType, filename, caption, sessionName, ownership);
}

async function getQueueStatus(filter, sessionName, tenantFilter) {
  return queue.getJobs(filter, sessionName, tenantFilter);
}

async function getJobById(jobId) {
  return queue.getJob(jobId);
}

async function stopCampaign(sessionName, tenantFilter) {
  return queue.stopCampaign(sessionName, tenantFilter);
}

module.exports = {
  sendSingle,
  sendSingleMedia,
  enqueueBulk,
  enqueueBulkMedia,
  enqueueBulkRecipients,
  getQueueStatus,
  getJobById,
  stopCampaign,
};
