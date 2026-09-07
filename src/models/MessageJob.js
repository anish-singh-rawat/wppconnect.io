'use strict';

const mongoose = require('mongoose');

const messageJobSchema = new mongoose.Schema(
  {
    _id:         { type: String },
    dedupKey:    { type: String, index: true },
    sessionName: { type: String, required: true, index: true },
    number:      { type: String, required: true },
    chatId:      { type: String, required: true },
    message:     { type: String, default: null },
    mediaData:   { type: String, default: null }, 
    mimeType:    { type: String, default: null },
    filename:    { type: String, default: null },
    name:        { type: String, default: null },
    title:       { type: String, default: null },
    city:        { type: String, default: null },
    status: {
      type:    String,
      enum:    ['pending', 'sending', 'sent', 'failed', 'duplicate', 'skipped', 'cancelled'],
      default: 'pending',
      index:   true,
    },
    attempts:    { type: Number, default: 0 },
    error:       { type: String, default: null },
    enqueuedAt:  { type: Date, default: Date.now, index: true },
    processedAt: { type: Date, default: null },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    subCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    _id:        false,
    versionKey: false,
    timestamps: false,
  }
);

messageJobSchema.index({ dedupKey: 1, status: 1 });
messageJobSchema.index({ customerId: 1, status: 1 });
messageJobSchema.index({ customerId: 1, sessionName: 1 });
messageJobSchema.index({ customerId: 1, subCustomerId: 1, status: 1 });
messageJobSchema.index({ sessionName: 1, enqueuedAt: -1 });
messageJobSchema.index({ sessionName: 1, status: 1, enqueuedAt: 1 });
messageJobSchema.index({ customerId: 1, enqueuedAt: -1 });
messageJobSchema.index({ enqueuedAt: -1 });

module.exports = mongoose.model('MessageJob', messageJobSchema);
