const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);

  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Each image must be 5MB or smaller.'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'You can upload up to 8 images at a time.'
        : err.message;
    return res.status(400).json({ success: false, message });
  }

  // Postgres unique violation
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'A record with this value already exists.' });
  }
  // Postgres foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'Referenced record does not exist.' });
  }
  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
};

module.exports = errorHandler;
