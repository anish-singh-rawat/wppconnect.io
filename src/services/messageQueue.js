'use strict';

const { v4: uuidv4 } = require('uuid');
const MessageJob = require('../models/MessageJob');
const { getSession } = require('../whatsapp/client');
const { randomDelay, toChatId } = require('../utils/helpers');
const socketManager = require('./socketManager');
const config = require('../config');
const logger = require('../utils/logger');

class MessageQueue {
  constructor() {
    this._pendingIds  = [];
    this._processing  = false;
    this._sessionProcessing = new Map();
    this._sessionStopped = new Map();
  }

  async enqueue(numbers, message, sessionName, ownership = {}) {
    const session = sessionName || config.whatsapp.sessionName;
    const results = [];

    for (const number of numbers) {
      const chatId   = toChatId(number);
      const dedupKey = `${session}:${chatId}:${message}`;

      if (await this._isDuplicate(dedupKey)) {
        logger.warn(`[Queue] Duplicate skipped: ${number}`);
        results.push({ number, jobId: null, status: 'duplicate' });
        continue;
      }

      const jobId = uuidv4();
      await MessageJob.create({
        _id:           jobId,
        dedupKey,
        sessionName:   session,
        number,
        chatId,
        message,
        status:        'pending',
        enqueuedAt:    new Date(),
        customerId:    ownership.customerId    || null,
        subCustomerId: ownership.subCustomerId || null,
        createdBy:     ownership.createdBy     || null,
      });

      this._pendingIds.push(jobId);
      results.push({ number, jobId, status: 'queued' });
    }

    this._processSession(session);
    if (results.some((r) => r.status === 'queued')) {
      socketManager.emitQueueUpdate(session, { queued: results.filter(r => r.status === 'queued').length });
    }
    return results;
  }

  async enqueueRecipients(recipients, fallbackMessage, sessionName, ownership = {}) {
    const session = sessionName || config.whatsapp.sessionName;
    const results = [];

    for (const recipient of recipients) {
      const { number } = recipient;
      const message = recipient.message || fallbackMessage;

      if (!message) {
        logger.warn(`[Queue] Skipped ${number}: no message in CSV row and no fallback provided.`);
        results.push({ number, jobId: null, status: 'skipped', reason: 'no_message' });
        continue;
      }

      const chatId   = toChatId(number);
      const dedupKey = `${session}:${chatId}:${message}`;

      if (await this._isDuplicate(dedupKey)) {
        logger.warn(`[Queue] Duplicate skipped: ${number}`);
        results.push({ number, jobId: null, status: 'duplicate' });
        continue;
      }

      const jobId = uuidv4();
      await MessageJob.create({
        _id:           jobId,
        dedupKey,
        sessionName:   session,
        number,
        chatId,
        message,
        name:          recipient.name  || null,
        title:         recipient.title || null,
        city:          recipient.city  || null,
        status:        'pending',
        enqueuedAt:    new Date(),
        customerId:    ownership.customerId    || null,
        subCustomerId: ownership.subCustomerId || null,
        createdBy:     ownership.createdBy     || null,
      });

      this._pendingIds.push(jobId);
      results.push({ number, jobId, status: 'queued' });
    }

    this._processSession(session);
    if (results.some((r) => r.status === 'queued')) {
      socketManager.emitQueueUpdate(session, { queued: results.filter(r => r.status === 'queued').length });
    }
    return results;
  }

  async enqueueMedia(numbers, fileBuffer, mimeType, filename, caption, sessionName, ownership = {}) {
    const session  = sessionName || config.whatsapp.sessionName;
    const mediaData = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    const results  = [];

    for (const number of numbers) {
      const chatId   = toChatId(number);
      const dedupKey = `${session}:${chatId}:media:${filename}:${Date.now()}`;

      const jobId = uuidv4();
      await MessageJob.create({
        _id:           jobId,
        dedupKey,
        sessionName:   session,
        number,
        chatId,
        message:       caption || '',
        mediaData,
        mimeType,
        filename,
        status:        'pending',
        enqueuedAt:    new Date(),
        customerId:    ownership.customerId    || null,
        subCustomerId: ownership.subCustomerId || null,
        createdBy:     ownership.createdBy     || null,
      });

      this._pendingIds.push(jobId);
      results.push({ number, jobId, status: 'queued' });
    }

    this._processSession(session);
    if (results.length > 0) {
      socketManager.emitQueueUpdate(session, { queued: results.length });
    }
    return results;
  }

  async getJobs(filter = 'all', sessionName = null, tenantFilter = null) {
    const query = {};
    if (sessionName) query.sessionName = sessionName;
    if (filter !== 'all') query.status = filter;
    if (tenantFilter && Object.keys(tenantFilter).length > 0) Object.assign(query, tenantFilter);

    const jobs = await MessageJob.find(query)
      .select('-mediaData')
      .sort({ enqueuedAt: -1 })
      .limit(1000)
      .lean();
    return jobs.map((j) => this._toPlain(j));
  }

  async getJob(jobId) {
    const job = await MessageJob.findById(jobId).select('-mediaData').lean();
    return job ? this._toPlain(job) : null;
  }

  async stopCampaign(sessionName, tenantFilter = null) {
    this._sessionStopped.set(sessionName, true);

    const query = { sessionName, status: 'pending' };
    if (tenantFilter && Object.keys(tenantFilter).length > 0) {
      Object.assign(query, tenantFilter);
    }

    const result = await MessageJob.updateMany(
      query,
      { $set: { status: 'cancelled', processedAt: new Date() } }
    );

    this._pendingIds = [];

    logger.info(`[Queue] Stopped campaign for "${sessionName}". Cancelled ${result.modifiedCount} pending job(s).`);

    socketManager.emitQueueUpdate(sessionName, { cancelled: result.modifiedCount });

    return { stoppedCount: result.modifiedCount };
  }

  async recoverPendingJobs() {
    await MessageJob.updateMany(
      { status: 'sending' },
      { $set: { status: 'pending', attempts: 0 } }
    );

    const pendingJobs = await MessageJob.find({ status: 'pending' })
      .sort({ enqueuedAt: 1 })
      .select('_id sessionName')
      .lean();

    if (pendingJobs.length > 0) {
      logger.info(`[Queue] Recovering ${pendingJobs.length} pending job(s) from MongoDB...`);

      const bySession = {};
      for (const j of pendingJobs) {
        this._pendingIds.push(j._id);
        bySession[j.sessionName] = true;
      }
      for (const sessionName of Object.keys(bySession)) {
        this._processSession(sessionName);
      }
    }
  }

  async _isDuplicate(dedupKey) {
    const existing = await MessageJob.findOne({
      dedupKey,
      status: { $in: ['pending', 'sending'] },
    }).lean();
    return !!existing;
  }

  async _processSession(sessionName) {
    if (this._sessionProcessing.get(sessionName)) return;
    this._sessionProcessing.set(sessionName, true);
    this._sessionStopped.delete(sessionName);

    while (true) {
      if (this._sessionStopped.get(sessionName)) {
        this._sessionStopped.delete(sessionName);
        break;
      }

      const job = await MessageJob.findOne({
        sessionName,
        status: 'pending',
      }).sort({ enqueuedAt: 1 });

      if (!job) break;

      const pos = this._pendingIds.indexOf(String(job._id));
      if (pos !== -1) this._pendingIds.splice(pos, 1);

      await this._sendWithRetry(job);

      if (this._sessionStopped.get(sessionName)) {
        this._sessionStopped.delete(sessionName);
        break;
      }

      const remaining = await MessageJob.countDocuments({ sessionName, status: 'pending' });
      if (remaining === 0) break;

      await randomDelay();
    }

    this._sessionProcessing.set(sessionName, false);
  }

  async _process() {
    if (this._processing) return;
    this._processing = true;

    while (this._pendingIds.length > 0) {
      const jobId = this._pendingIds.shift();
      const job   = await MessageJob.findById(jobId);
      if (!job || job.status !== 'pending') continue;
      await this._sendWithRetry(job);
      if (this._pendingIds.length > 0) {
        await randomDelay();
      }
    }

    this._processing = false;
  }

  async _sendWithRetry(job) {
    const maxRetries = config.messaging.maxRetries;

    while (job.attempts <= maxRetries) {
      job.attempts += 1;
      job.status    = 'sending';
      await job.save();
      socketManager.emitQueueJob(job.sessionName, this._toPlain(job));

      try {
        const session = getSession(job.sessionName);

        if (job.mediaData && job.mimeType) {
          const buffer = Buffer.from(job.mediaData.split(',')[1], 'base64');
          await session.sendMedia(job.chatId, buffer, job.mimeType, job.filename, job.message || '');
        } else {
          await session.sendText(job.chatId, job.message);
        }

        job.status      = 'sent';
        job.processedAt = new Date();
        await job.save();
        socketManager.emitQueueJob(job.sessionName, this._toPlain(job));

        logger.info(`[Queue] ✓ Sent to ${job.number} (attempt ${job.attempts})`);
        return;
      } catch (err) {
        logger.warn(
          `[Queue] ✗ Failed to send to ${job.number} (attempt ${job.attempts}): ${err.message}`
        );
        job.error = err.message;

        if (job.attempts <= maxRetries) {
          await new Promise((r) => setTimeout(r, config.messaging.retryDelay));
        }
      }
    }

    job.status      = 'failed';
    job.processedAt = new Date();
    await job.save();
    socketManager.emitQueueJob(job.sessionName, this._toPlain(job));

    logger.error(`[Queue] ✗ Permanently failed for ${job.number} after ${job.attempts} attempts.`);
  }

  _toPlain(doc) {
    return {
      id:          doc._id,
      dedupKey:    doc.dedupKey,
      sessionName: doc.sessionName,
      number:      doc.number,
      chatId:      doc.chatId,
      message:     doc.message,
      name:        doc.name,
      title:       doc.title,
      city:        doc.city,
      status:      doc.status,
      attempts:    doc.attempts,
      error:       doc.error,
      enqueuedAt:  doc.enqueuedAt,
      processedAt: doc.processedAt,
    };
  }
}

const queue = new MessageQueue();

module.exports = queue;
