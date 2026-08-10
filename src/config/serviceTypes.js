/**
 * What kind of work a service request is for.
 *
 * A request is a request whatever the trade: the client asks, the shop prices
 * it, the client agrees, the work happens, the client collects and pays. That
 * sequence never changes and none of the arithmetic branches on type.
 *
 * What does change is what the middle of it is called. "On the press" is
 * meaningful to somebody waiting on 500 flyers and meaningless to somebody
 * whose generator is being repaired, and a client told their consultancy job is
 * "Finishing" learns nothing. So a type supplies two things and nothing else:
 *
 *   stages       — the steps between accepting a quote and finishing the work
 *   requires_file — whether this kind of work normally needs something sent in
 *
 * The second is only a default offered when a service is set up. The real flag
 * lives on the service itself, because one shop's site survey wants photos and
 * another's does not.
 *
 * Every type shares the same bookends. A request is priced, then agreed, then
 * worked; it can be cancelled from anywhere. Those three are the lifecycle, not
 * the trade, so they live here once rather than in each type.
 */

/** Before the work: true of every request, whatever it is for. */
const LEAD_IN = [
  { key: 'awaiting_quote', label: 'Awaiting quote', client: 'Being priced' },
  { key: 'quoted',         label: 'Quoted',         client: 'Quote sent' },
];

/** The way out. Not a step on the journey, so it is not shown as one. */
const CANCELLED = { key: 'cancelled', label: 'Cancelled', client: 'Cancelled' };

const TYPES = {
  printing: {
    key: 'printing',
    label: 'Printing & production',
    description: 'Print, signage and copy work run through the press.',
    requires_file: true,
    stages: [
      { key: 'queued',    label: 'In the queue',   client: 'In the queue' },
      { key: 'preparing', label: 'Preparing',      client: 'Preparing artwork' },
      // Nothing goes on the press until the client has seen it. A reprint of
      // 500 flyers with the wrong phone number is the shop's loss, not theirs.
      { key: 'proof',     label: 'Proof sent',     client: 'With you for approval' },
      { key: 'printing',  label: 'Printing',       client: 'On the press' },
      { key: 'finishing', label: 'Finishing',      client: 'Finishing' },
      { key: 'ready',     label: 'Ready',          client: 'Ready for collection' },
      { key: 'collected', label: 'Collected',      client: 'Collected' },
    ],
  },

  design: {
    key: 'design',
    label: 'Design & artwork',
    description: 'Logos, layouts and artwork prepared for a client.',
    requires_file: true,
    stages: [
      { key: 'queued',    label: 'In the queue', client: 'In the queue' },
      { key: 'drafting',  label: 'Drafting',     client: 'Being designed' },
      { key: 'proof',     label: 'Sent for approval', client: 'With you for approval' },
      { key: 'revisions', label: 'Revisions',    client: 'Making your changes' },
      { key: 'ready',     label: 'Ready',        client: 'Ready for you' },
      { key: 'delivered', label: 'Delivered',    client: 'Delivered' },
    ],
  },

  repair: {
    key: 'repair',
    label: 'Repair & servicing',
    description: 'Something is brought in, assessed, fixed and collected.',
    requires_file: false,
    stages: [
      { key: 'received',   label: 'Received',   client: 'Received' },
      { key: 'diagnosing', label: 'Assessing',  client: 'Being assessed' },
      { key: 'repairing',  label: 'Repairing',  client: 'Being repaired' },
      { key: 'testing',    label: 'Testing',    client: 'Being tested' },
      { key: 'ready',      label: 'Ready',      client: 'Ready for collection' },
      { key: 'collected',  label: 'Collected',  client: 'Collected' },
    ],
  },

  installation: {
    key: 'installation',
    label: 'Installation & site work',
    description: 'Work carried out at the client’s premises.',
    requires_file: false,
    stages: [
      { key: 'scheduled',  label: 'Scheduled',   client: 'Scheduled' },
      { key: 'on_site',    label: 'On site',     client: 'Our team is on site' },
      { key: 'installing', label: 'Installing',  client: 'Installation under way' },
      { key: 'snagging',   label: 'Final checks', client: 'Final checks' },
      { key: 'completed',  label: 'Completed',   client: 'Completed' },
    ],
  },

  professional: {
    key: 'professional',
    label: 'Professional services',
    description: 'Consulting, accounting, legal, training and similar work.',
    requires_file: false,
    stages: [
      { key: 'scheduled',   label: 'Scheduled',  client: 'Scheduled' },
      { key: 'in_progress', label: 'In progress', client: 'Under way' },
      { key: 'review',      label: 'With client', client: 'With you for review' },
      { key: 'delivered',   label: 'Delivered',  client: 'Delivered' },
    ],
  },

  general: {
    key: 'general',
    label: 'General service',
    description: 'Any other service the business offers.',
    requires_file: false,
    stages: [
      { key: 'queued',      label: 'In the queue', client: 'In the queue' },
      { key: 'in_progress', label: 'In progress',  client: 'Under way' },
      { key: 'ready',       label: 'Ready',        client: 'Ready' },
      { key: 'delivered',   label: 'Delivered',    client: 'Delivered' },
    ],
  },
};

const DEFAULT_TYPE = 'general';

/**
 * Requests taken before types existed are print jobs — that is all this could
 * take at the time — but they are migrated to carry the type explicitly rather
 * than relying on a fallback to say so. Anything genuinely unlabelled is a
 * plain service, which is why the fallback here is general and not printing.
 */
function profileFor(type) {
  return TYPES[type] || TYPES[DEFAULT_TYPE];
}

/** The whole journey a client sees: priced, agreed, then the work itself. */
function stagesFor(type) {
  return [...LEAD_IN, ...profileFor(type).stages];
}

/** Just the work — what cannot start until the quote has been accepted. */
const workStagesFor = (type) => profileFor(type).stages;

const isWorkStage = (type, key) => workStagesFor(type).some((s) => s.key === key);

/** The stage that means there is nothing left to do. */
const finalStageKey = (type) => workStagesFor(type)[workStagesFor(type).length - 1].key;

/** What to call a stage, to staff or to the client. */
function stageLabel(type, key, audience = 'label') {
  if (key === CANCELLED.key) return CANCELLED[audience];
  const stage = stagesFor(type).find((s) => s.key === key);
  return stage ? stage[audience] : key;
}

/** Every value production_stage may hold, so the schema stays a real constraint. */
const ALL_STAGE_KEYS = [...new Set([
  ...LEAD_IN.map((s) => s.key),
  ...Object.values(TYPES).flatMap((t) => t.stages.map((s) => s.key)),
  CANCELLED.key,
])];

/**
 * What a request is, given the services on it.
 *
 * A client can put a banner and a business-card design in one request, so the
 * type is whichever kind most of the work is. Ties go to the first line, which
 * is the one they asked for first.
 */
function typeForLines(services) {
  const counts = new Map();
  for (const s of services || []) {
    const key = TYPES[s?.service_type] ? s.service_type : DEFAULT_TYPE;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return DEFAULT_TYPE;
  let best = DEFAULT_TYPE;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best;
}

module.exports = {
  TYPES,
  DEFAULT_TYPE,
  TYPE_KEYS: Object.keys(TYPES),
  LEAD_IN,
  CANCELLED,
  ALL_STAGE_KEYS,
  profileFor,
  stagesFor,
  workStagesFor,
  isWorkStage,
  finalStageKey,
  stageLabel,
  typeForLines,
};
