'use strict';

const express  = require('express');
const multer   = require('multer');
const rateLimit = require('express-rate-limit');

const { login, getMe, updateProfile, changePassword, refreshToken, logout } = require('../controllers/authController');

const {
  createDeviceHandler,
  listDevicesHandler,
  getDeviceHandler,
  deleteDeviceHandler,
} = require('../controllers/deviceController');

const {
  resolveDevice,
  qrEventStream,
  getQRStatus,
  getQRImage,
} = require('../controllers/qrController');

const {
  sendMessage,
  sendMediaMessage,
  bulkSendMessage,
  bulkSendMediaMessage,
  bulkSendCsv,
  getQueue,
  getQueueJob,
  stopCampaign,
} = require('../controllers/messageController');

const {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  suspendCustomer,
  activateCustomer,
  resetCustomerPassword,
} = require('../controllers/customerController');

const {
  createSubCustomer,
  listSubCustomers,
  getSubCustomer,
  updateSubCustomer,
  deleteSubCustomer,
  suspendSubCustomer,
  activateSubCustomer,
  resetSubCustomerPassword,
} = require('../controllers/subCustomerController');

const {
  generateToken,
  regenerateToken,
  enableToken,
  disableToken,
  getTokenInfo,
  listTokens,
} = require('../controllers/apiTokenController');

const { authenticateJWT, authenticateApiToken, authenticateEither, authenticateQR } = require('../middleware/auth');
const { authorize, onlySuperAdmin, superAdminOrCustomer, allRoles } = require('../middleware/authorize');
const { customerRateLimit } = require('../middleware/rateLimiter');
const { logApiRequest }     = require('../middleware/apiLogger');
const { globalErrorHandler, notFoundHandler } = require('../middleware/errorHandler');
const { ROLES } = require('../models/User');

const config = require('../config');
const router = express.Router();

const globalLimiter = rateLimit({
  windowMs:        config.rateLimit.windowMs,
  max:             config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, error: 'Too many requests.' },
});

router.use(globalLimiter);

const csvUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted.'));
    }
  },
});

const mediaUpload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/3gpp', 'video/quicktime',
      'application/pdf',
      'text/csv', 'application/csv', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(file.mimetype) || ext === 'csv' || ext === 'pdf') {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Allowed: Images, Videos, PDF, CSV/Excel.'));
    }
  },
});

function multerErrorHandler(err, req, res, next) {
  if (!err) return next();
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum allowed size is 16 MB.',
    });
  }
  return res.status(400).json({ success: false, error: err.message });
}

router.get('/health', (_req, res) =>
  res.json({ status: 'ok', env: config.server.env, uptime: process.uptime() })
);

router.post('/auth/login',           login);
router.post('/auth/refresh',         refreshToken);
router.post('/auth/logout',          authenticateJWT, logout);
router.get ('/auth/me',              authenticateJWT, getMe);
router.put ('/auth/profile',         authenticateJWT, updateProfile);
router.put ('/auth/change-password', authenticateJWT, changePassword);

router.post  ('/customers',                          authenticateJWT, onlySuperAdmin, createCustomer);
router.get   ('/customers',                          authenticateJWT, onlySuperAdmin, listCustomers);
router.get   ('/customers/:customerId',              authenticateJWT, onlySuperAdmin, getCustomer);
router.put   ('/customers/:customerId',              authenticateJWT, onlySuperAdmin, updateCustomer);
router.delete('/customers/:customerId',              authenticateJWT, onlySuperAdmin, deleteCustomer);
router.post  ('/customers/:customerId/suspend',      authenticateJWT, onlySuperAdmin, suspendCustomer);
router.post  ('/customers/:customerId/activate',     authenticateJWT, onlySuperAdmin, activateCustomer);
router.post  ('/customers/:customerId/reset-password', authenticateJWT, onlySuperAdmin, resetCustomerPassword);

router.post  ('/sub-customers',                             authenticateJWT, authorize(ROLES.CUSTOMER), createSubCustomer);
router.get   ('/sub-customers',                             authenticateJWT, superAdminOrCustomer,      listSubCustomers);
router.get   ('/sub-customers/:subCustomerId',              authenticateJWT, superAdminOrCustomer,      getSubCustomer);
router.put   ('/sub-customers/:subCustomerId',              authenticateJWT, superAdminOrCustomer,      updateSubCustomer);
router.delete('/sub-customers/:subCustomerId',              authenticateJWT, superAdminOrCustomer,      deleteSubCustomer);
router.post  ('/sub-customers/:subCustomerId/suspend',      authenticateJWT, superAdminOrCustomer,      suspendSubCustomer);
router.post  ('/sub-customers/:subCustomerId/activate',     authenticateJWT, superAdminOrCustomer,      activateSubCustomer);
router.post  ('/sub-customers/:subCustomerId/reset-password', authenticateJWT, superAdminOrCustomer,    resetSubCustomerPassword);



router.get ('/api-tokens/my',            authenticateJWT, authorize(ROLES.CUSTOMER), getTokenInfo);
router.post('/api-tokens/my/generate',   authenticateJWT, authorize(ROLES.CUSTOMER), generateToken);
router.post('/api-tokens/my/regenerate', authenticateJWT, authorize(ROLES.CUSTOMER), regenerateToken);
router.post('/api-tokens/my/enable',     authenticateJWT, authorize(ROLES.CUSTOMER), enableToken);
router.post('/api-tokens/my/disable',    authenticateJWT, authorize(ROLES.CUSTOMER), disableToken);

router.get ('/api-tokens',                         authenticateJWT, onlySuperAdmin, listTokens);
router.get ('/api-tokens/:customerId',             authenticateJWT, onlySuperAdmin, getTokenInfo);
router.post('/api-tokens/:customerId/generate',    authenticateJWT, onlySuperAdmin, generateToken);
router.post('/api-tokens/:customerId/regenerate',  authenticateJWT, onlySuperAdmin, regenerateToken);
router.post('/api-tokens/:customerId/enable',      authenticateJWT, onlySuperAdmin, enableToken);
router.post('/api-tokens/:customerId/disable',     authenticateJWT, onlySuperAdmin, disableToken);

router.post  ('/devices',        authenticateJWT, allRoles, createDeviceHandler);
router.get   ('/devices',        authenticateJWT, allRoles, listDevicesHandler);
router.get   ('/devices/:token', authenticateJWT, allRoles, getDeviceHandler);
router.delete('/devices/:token', authenticateJWT, allRoles, deleteDeviceHandler);

router.get('/devices/:token/qrcode/events', authenticateQR, resolveDevice, qrEventStream);
router.get('/devices/:token/qrcode/status', authenticateQR, resolveDevice, getQRStatus);
router.get('/devices/:token/qrcode/image',  authenticateQR, resolveDevice, getQRImage);

router.post(
  '/devices/:token/send',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  sendMessage
);

router.post(
  '/devices/:token/send-media',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  mediaUpload.single('media'),
  multerErrorHandler,
  sendMediaMessage
);

router.post(
  '/devices/:token/bulk-send',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  bulkSendMessage
);

router.post(
  '/devices/:token/bulk-send-media',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  mediaUpload.single('media'),
  multerErrorHandler,
  bulkSendMediaMessage
);

router.post(
  '/devices/:token/bulk-send/csv',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  csvUpload.single('file'),
  multerErrorHandler,
  bulkSendCsv
);

router.get(
  '/devices/:token/queue',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  getQueue
);

router.post(
  '/devices/:token/queue/stop',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  stopCampaign
);

router.get(
  '/devices/:token/queue/:jobId',
  authenticateEither,
  customerRateLimit,
  logApiRequest,
  resolveDevice,
  getQueueJob
);


router.use(notFoundHandler);

module.exports = router;
