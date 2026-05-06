const { ChatConversation, ChatMessage } = require('../models');

// GET /chat/conversation — get or create open conversation for the current user
const getOrCreateConversation = async (req, res) => {
  let conv = await ChatConversation.findOne({ tenant_id: req.tenant_id, opened_by: req.user._id, status: 'open' });
  if (!conv) {
    conv = await ChatConversation.create({
      tenant_id: req.tenant_id,
      opened_by: req.user._id,
      subject: 'Support Request',
    });
  }
  res.json({ success: true, data: conv });
};

// GET /chat/messages/:conversationId
const getMessages = async (req, res) => {
  const conv = await ChatConversation.findById(req.params.conversationId);
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  // Scope check — tenant can only see their own, admin sees all
  if (req.user.role !== 'platform_admin' && String(conv.tenant_id) !== String(req.tenant_id)) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const messages = await ChatMessage.find({ conversation_id: conv._id })
    .populate('sender_id', 'name role')
    .sort({ createdAt: 1 });

  // Mark messages as read
  const readerRole = req.user.role === 'platform_admin' ? 'tenant' : 'admin';
  await ChatMessage.updateMany(
    { conversation_id: conv._id, sender_role: readerRole, read: false },
    { read: true }
  );

  // Reset unread count
  if (req.user.role === 'platform_admin') {
    await ChatConversation.findByIdAndUpdate(conv._id, { unread_admin: 0 });
  } else {
    await ChatConversation.findByIdAndUpdate(conv._id, { unread_tenant: 0 });
  }

  res.json({ success: true, data: messages });
};

// POST /chat/messages — send a message
const sendMessage = async (req, res) => {
  const { conversation_id, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'message required.' });

  const conv = await ChatConversation.findById(conversation_id);
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found.' });

  if (req.user.role !== 'platform_admin' && String(conv.tenant_id) !== String(req.tenant_id)) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const senderRole = req.user.role === 'platform_admin' ? 'admin' : 'tenant';

  const msg = await ChatMessage.create({
    conversation_id: conv._id,
    tenant_id: conv.tenant_id,
    sender_id: req.user._id,
    sender_role: senderRole,
    message: message.trim(),
  });

  // Update conversation last_message_at + unread count for the other side
  const update = { last_message_at: new Date() };
  if (senderRole === 'tenant') update.$inc = { unread_admin: 1 };
  else update.$inc = { unread_tenant: 1 };
  await ChatConversation.findByIdAndUpdate(conv._id, update);

  const populated = await msg.populate('sender_id', 'name role');

  // Emit via socket if available
  const io = req.app.get('io');
  if (io) {
    io.to(`conv_${conv._id}`).emit('new_message', populated);
    // Notify admin room of new tenant message
    if (senderRole === 'tenant') io.to('admin_room').emit('new_tenant_message', { conversation_id: conv._id, tenant_id: conv.tenant_id });
  }

  res.status(201).json({ success: true, data: populated });
};

// GET /chat/admin/conversations — platform admin sees all conversations
const getAllConversations = async (req, res) => {
  const convs = await ChatConversation.find()
    .populate('tenant_id', 'business_name email')
    .populate('opened_by', 'name')
    .sort({ last_message_at: -1 });
  res.json({ success: true, data: convs });
};

// PATCH /chat/conversations/:id/resolve
const resolveConversation = async (req, res) => {
  const conv = await ChatConversation.findByIdAndUpdate(req.params.id, { status: 'resolved' }, { new: true });
  if (!conv) return res.status(404).json({ success: false, message: 'Conversation not found.' });
  res.json({ success: true, data: conv });
};

module.exports = { getOrCreateConversation, getMessages, sendMessage, getAllConversations, resolveConversation };
