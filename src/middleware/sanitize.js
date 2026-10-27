/**
 * Strip MongoDB operators out of whatever a client sends.
 *
 * Express parses `?status[$ne]=x` into { status: { $ne: 'x' } } and JSON bodies
 * keep any nesting they are given, and plenty of routes copy those values
 * straight into a query. Left alone, a caller could turn "status equals done"
 * into "status is anything but done", or match every user with a `$gt` on a
 * password. Keys that start with `$` or contain a `.` are never legitimate
 * input here, so they are removed before any route sees them.
 */
const bad = (key) => key.startsWith('$') || key.includes('.');

function clean(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { value.forEach((v, i) => { value[i] = clean(v, depth + 1); }); return value; }
  for (const key of Object.keys(value)) {
    if (bad(key)) delete value[key];
    else value[key] = clean(value[key], depth + 1);
  }
  return value;
}

const sanitize = (req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) clean(req.body);
  if (req.query) clean(req.query);
  if (req.params) clean(req.params);
  next();
};

module.exports = sanitize;
module.exports.clean = clean;
