const {
  Project, ProjectDocument, ProjectMessage,
} = require('../models');
const { uploadProjectFile } = require('../services/uploadService');

/**
 * What a client can do, not just see.
 *
 * Everything here is reached by the tracking token and nothing else. That token
 * was issued by the tenant to a specific job, which is the whole access model:
 * holding it lets you act on that one project and no other, and it can be
 * withdrawn in a click.
 *
 * The asymmetry is deliberate. A client may add — send a file, ask a question —
 * and may read only what has been deliberately shared with them. They cannot
 * edit, delete, or reach anything the office has not published. Nothing here
 * takes an id from the caller and trusts it; the project is always resolved
 * from the token.
 */

/** Resolve the token to a project, or nothing. */
async function fromToken(token) {
  if (!token || token.length < 8) return null;
  return Project.findOne({ track_token: token }).lean();
}

/* ── Documents ────────────────────────────────────────────────────────────── */

/**
 * What the client may see: documents the office has shared, plus everything the
 * client sent in themselves.
 */
async function visibleDocuments(project) {
  return ProjectDocument.find({
    project_id: project._id,
    tenant_id: project.tenant_id,
    $or: [{ shared_with_client: true }, { from_client: true }],
  }).sort({ createdAt: -1 }).lean();
}

const listDocuments = async (req, res) => {
  const project = await fromToken(req.params.token);
  if (!project) return res.status(404).json({ success: false, message: 'That link is not valid.' });

  const docs = await visibleDocuments(project);
  res.json({
    success: true,
    data: docs.map((d) => ({
      id: String(d._id),
      name: d.name,
      category: d.category,
      url: d.url,
      size: d.size,
      from_client: !!d.from_client,
      uploaded_at: d.createdAt,
    })),
  });
};

/**
 * A file from the client.
 *
 * Filed against the project like any other document, but flagged as theirs so
 * the office can tell at a glance what arrived from outside, and so it is never
 * hidden back from the person who sent it.
 */
const uploadDocument = async (req, res) => {
  const project = await fromToken(req.params.token);
  if (!project) return res.status(404).json({ success: false, message: 'That link is not valid.' });
  if (!req.file) return res.status(400).json({ success: false, message: 'Choose a file to send.' });

  const saved = await uploadProjectFile(project.tenant_id, project._id, req.file);
  const doc = await ProjectDocument.create({
    tenant_id: project.tenant_id,
    project_id: project._id,
    name: req.body.name?.trim() || req.file.originalname,
    // Whatever the client sends is filed as correspondence. Letting them pick
    // a category would put their guess where the office's filing should be.
    category: 'correspondence',
    url: saved.url,
    public_id: saved.public_id,
    mime_type: req.file.mimetype,
    size: saved.size || req.file.size,
    from_client: true,
    shared_with_client: true,
    client_name: project.customer_name || 'Client',
  });

  res.status(201).json({ success: true, data: { id: String(doc._id), name: doc.name, url: doc.url } });
};

/* ── Messages ─────────────────────────────────────────────────────────────── */

const shapeMessage = (m) => ({
  id: String(m._id),
  body: m.body,
  from: m.from,
  author: m.from === 'staff' ? (m.author_name || 'The team') : (m.author_name || 'You'),
  attachments: (m.attachments || []).map((a) => ({ name: a.name, url: a.url })),
  at: m.createdAt,
});

const listMessages = async (req, res) => {
  const project = await fromToken(req.params.token);
  if (!project) return res.status(404).json({ success: false, message: 'That link is not valid.' });

  const messages = await ProjectMessage.find({ project_id: project._id, tenant_id: project.tenant_id })
    .sort({ createdAt: 1 }).limit(500).lean();

  // Opening the thread is what marks it read on the client's side.
  await ProjectMessage.updateMany(
    { project_id: project._id, tenant_id: project.tenant_id, from: 'staff', read_by_client: false },
    { $set: { read_by_client: true } },
  );

  res.json({ success: true, data: messages.map(shapeMessage) });
};

const postMessage = async (req, res) => {
  const project = await fromToken(req.params.token);
  if (!project) return res.status(404).json({ success: false, message: 'That link is not valid.' });

  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ success: false, message: 'Write something first.' });
  if (body.length > 4000) return res.status(400).json({ success: false, message: 'That message is too long.' });

  const message = await ProjectMessage.create({
    tenant_id: project.tenant_id,
    project_id: project._id,
    body,
    from: 'client',
    author_name: project.customer_name || 'Client',
    read_by_client: true,
  });

  res.status(201).json({ success: true, data: shapeMessage(message) });
};

module.exports = {
  fromToken,
  visibleDocuments,
  listDocuments,
  uploadDocument,
  listMessages,
  postMessage,
  shapeMessage,
};
