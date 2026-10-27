const path = require('path'); const SRC = path.join(__dirname, '../src');
process.env.JWT_SECRET = 'test-secret';
const jwt = require(require.resolve('jsonwebtoken'));
const { Server } = require(require.resolve('socket.io'));
const { io: Client } = require('socket.io-client');
const http = require('http');

const users = [
  { _id: 'u1', role: 'business_owner', tenant_id: 'T1', is_active: true, token_version: 0 },
  { _id: 'u2', role: 'business_owner', tenant_id: 'T2', is_active: true, token_version: 0 },
  { _id: 'u3', role: 'platform_admin', tenant_id: null, is_active: true, token_version: 0 },
  { _id: 'u4', role: 'business_owner', tenant_id: 'T1', is_active: false, token_version: 0 },
];
const convs = [{ _id: 'c1', tenant_id: 'T1' }, { _id: 'c2', tenant_id: 'T2' }];
const q = (v) => ({ select: async () => v });
require.cache[path.join(SRC, 'models/index.js')] = { loaded: true, exports: {
  User: { findById: (id) => q(users.find(u => u._id === id)) },
  ChatConversation: { findById: (id) => q(convs.find(c => c._id === id)) },
} };

const server = http.createServer(); const io = new Server(server, { cors: { origin: '*' } });
require(path.join(SRC, 'sockets/chatSocket.js'))(io);
let pass = 0, fail = 0; const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n, e); };
const tok = (id, extra = {}) => jwt.sign({ id, tv: 0, ...extra }, 'test-secret', { expiresIn: '1h' });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const connect = (token) => new Promise((resolve) => {
  const s = Client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false });
  s.on('connect', () => resolve({ s, connected: true }));
  s.on('connect_error', (e) => { s.close(); resolve({ connected: false, error: e.message }); });
});
const inRoom = (room) => io.sockets.adapter.rooms.get(room)?.size || 0;

server.listen(0, async () => {
  let c = await connect(null); ok('no token: refused', !c.connected, c.error);
  c = await connect('garbage'); ok('invalid token: refused', !c.connected);
  c = await connect(jwt.sign({ id: 'u1', tv: 0 }, 'wrong-secret')); ok('token signed with another key: refused', !c.connected);
  c = await connect(tok('u1', { type: 'store_customer' })); ok("a shopper's token: refused", !c.connected);
  c = await connect(tok('u1', { purpose: '2fa' })); ok('a half-finished sign-in: refused', !c.connected);
  c = await connect(tok('u4')); ok('deactivated user: refused', !c.connected);
  c = await connect(jwt.sign({ id: 'u1', tv: 5 }, 'test-secret')); ok('revoked session (old token_version): refused', !c.connected);

  const t1 = await connect(tok('u1')); ok('valid tenant user connects', t1.connected);
  const t2 = await connect(tok('u2'));
  const admin = await connect(tok('u3'));

  t1.s.emit('join_admin'); await wait(150);
  ok('tenant user cannot join the admin room', inRoom('admin_room') === 0);
  admin.s.emit('join_admin'); await wait(150);
  ok('platform admin can join the admin room', inRoom('admin_room') === 1);

  t1.s.emit('join_conversation', 'c2'); await wait(150);
  ok("tenant cannot join another business's conversation", inRoom('conv_c2') === 0);
  t1.s.emit('join_conversation', 'c1'); await wait(150);
  ok('tenant can join its own conversation', inRoom('conv_c1') === 1);
  t1.s.emit('join_conversation', { $ne: 1 }); t1.s.emit('join_conversation', 'does-not-exist'); await wait(150);
  ok('malformed or unknown ids are ignored', inRoom('conv_[object Object]') === 0 && inRoom('conv_does-not-exist') === 0);
  admin.s.emit('join_conversation', 'c2'); await wait(150);
  ok('admin can join any conversation', inRoom('conv_c2') === 1);

  const got = { t1: 0, t2: 0 };
  t1.s.on('new_message', () => got.t1++); t2.s.on('new_message', () => got.t2++);
  io.to('conv_c1').emit('new_message', { message: 'hi' }); await wait(200);
  ok('only members of the room receive its messages', got.t1 === 1 && got.t2 === 0, JSON.stringify(got));

  [t1, t2, admin].forEach(x => x.s.close()); server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
});
