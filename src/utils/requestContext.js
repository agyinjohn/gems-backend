/**
 * Extract client IP and device info from a request, for audit logging.
 * Works behind a proxy when `app.set('trust proxy', true)` is set, and also
 * falls back to the X-Forwarded-For header directly.
 */
function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
}

/** Turn a raw user-agent string into a concise, human-readable device label. */
function parseDevice(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari'
    : 'Browser';
  const os = /Windows NT/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown OS';
  const kind = /Mobile|Android|iPhone|iPad|iPod/.test(ua) ? 'Mobile' : 'Desktop';
  return `${browser} on ${os} · ${kind}`;
}

/** Bundle everything an audit entry needs about the request origin. */
function getRequestContext(req) {
  const user_agent = req.headers?.['user-agent'] || null;
  return { ip: getClientIp(req), user_agent, device: parseDevice(user_agent) };
}

module.exports = { getClientIp, parseDevice, getRequestContext };
