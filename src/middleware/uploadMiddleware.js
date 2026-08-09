const multer = require('multer');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 8;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype?.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

const hrDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype?.startsWith('image/') || file.mimetype === 'application/pdf';
    if (ok) return cb(null, true);
    cb(new Error('Only images and PDF files are allowed.'));
  },
});

/**
 * Files a client sends in to be printed.
 *
 * This one is reachable without a login, so it is the tightest of the three:
 * a small, explicit list of what a print shop actually receives, a hard cap on
 * size and count, and no fallback that lets an unexpected type through.
 */
const PRINTABLE = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/tiff', 'image/webp',
];

const printUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (PRINTABLE.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Send a PDF, an Office document or an image.'));
  },
});

module.exports = { imageUpload, hrDocUpload, printUpload, MAX_FILES };
