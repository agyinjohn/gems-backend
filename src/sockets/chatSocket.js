const jwt = require('jsonwebtoken');
const { User, ChatConversation } = require('../models');

/**
 * Authentication and room rules for the live support chat.
 *
 * The REST routes already refuse a tenant another tenant's conversation; the
 * socket used to accept any connection and let it join any room by name, so
 * anyone on the internet could sit in the admin room or listen to a business's
 * support conversation. Now:
 *   - a connection must present a valid staff session token;
 *   - only the platform admin may join the admin room;
 *   - a conversation may be joined only by the platform admin or by someone in
 *     the business it belongs to.
 */
module.exports = function chatSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type || decoded.purpose) return next(new Error('unauthorized'));
      const user = await User.findById(decoded.id).select('role tenant_id is_active token_version');
      if (!user || !user.is_active || (decoded.tv ?? 0) !== (user.token_version || 0)) return next(new Error('unauthorized'));
      socket.data.user = { id: String(user._id), role: user.role, tenant_id: user.tenant_id ? String(user.tenant_id) : null };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;

    socket.on('join_admin', () => {
      if (me.role === 'platform_admin') socket.join('admin_room');
    });

    socket.on('join_conversation', async (conversationId) => {
      try {
        if (typeof conversationId !== 'string' && typeof conversationId !== 'number') return;
        const conv = await ChatConversation.findById(String(conversationId)).select('tenant_id');
        if (!conv) return;
        const mine = me.tenant_id && String(conv.tenant_id) === me.tenant_id;
        if (me.role === 'platform_admin' || mine) socket.join(`conv_${conv._id}`);
      } catch { /* a malformed id is simply ignored */ }
    });

    socket.on('leave_conversation', (conversationId) => socket.leave(`conv_${conversationId}`));
  });
};
