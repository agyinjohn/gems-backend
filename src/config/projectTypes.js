/**
 * What kind of job a project is.
 *
 * The engine underneath — weighted stages, variations, cost against earned
 * value, progress billing, the cash curve — is the same whatever the trade. The
 * parts that are not the same are the vocabulary and a handful of practices
 * that only one industry actually has.
 *
 * A software house shown a "Site diary" asking for today's weather concludes,
 * correctly, that the software was not built for them. So the type a project is
 * created as decides three things and nothing else:
 *
 *   capabilities — which tabs exist at all
 *   terms        — what things are called on screen
 *   lists        — the causes and document kinds offered
 *
 * No arithmetic branches on type. That matters: it keeps one tested engine
 * rather than four half-tested ones, and it means a project can change type
 * without any figure moving.
 */

/**
 * Extensions of time and payment certificates are genuinely construction
 * practices, not merely construction words — a print run does not argue an
 * extension, and a software client would not know what to do with an interim
 * certificate. Retention is the interesting one: common in building, common in
 * software as an acceptance holdback, rare in print.
 */
const TYPES = {
  construction: {
    key: 'construction',
    label: 'Construction',
    description: 'Building and civil works, billed on valuations with retention.',
    capabilities: {
      programme: true,
      site_diary: true,
      time_claims: true,
      retention: true,
      certificate: true,
    },
    terms: {
      stage: 'Stage',
      stages: 'Stages',
      application: 'Application',
      applications: 'Applications',
      client_role: 'Employer',
      certificate_title: 'Interim Payment Certificate',
      work_done: 'Work executed',
      site_tab: 'Site',
    },
    delay_causes: ['weather', 'materials', 'labour', 'plant', 'client_instruction', 'access', 'other'],
    document_categories: ['contract', 'drawing', 'permit', 'certificate', 'photo', 'correspondence', 'other'],
  },

  printing: {
    key: 'printing',
    label: 'Printing',
    description: 'Print and signage contracts run in production stages.',
    capabilities: {
      programme: true,
      // Installs happen away from the shop, so a job log still earns its place.
      site_diary: true,
      time_claims: false,
      retention: false,
      certificate: false,
    },
    terms: {
      stage: 'Production stage',
      stages: 'Production stages',
      application: 'Invoice',
      applications: 'Invoices',
      client_role: 'Client',
      certificate_title: 'Statement of Account',
      work_done: 'Work completed',
      site_tab: 'Job log',
    },
    delay_causes: ['artwork_approval', 'materials', 'machine_downtime', 'delivery', 'client_instruction', 'other'],
    document_categories: ['contract', 'artwork', 'proof', 'delivery_note', 'photo', 'correspondence', 'other'],
  },

  software: {
    key: 'software',
    label: 'Software',
    description: 'Development work billed by phase, with an acceptance holdback.',
    capabilities: {
      programme: true,
      site_diary: false,
      time_claims: false,
      // Acceptance holdback — the same mechanism under a different name.
      retention: true,
      certificate: false,
    },
    terms: {
      stage: 'Phase',
      stages: 'Phases',
      application: 'Milestone invoice',
      applications: 'Milestone invoices',
      client_role: 'Client',
      certificate_title: 'Statement of Account',
      work_done: 'Work delivered',
      site_tab: 'Files',
    },
    delay_causes: [],
    document_categories: ['contract', 'specification', 'design', 'test_report', 'correspondence', 'other'],
  },

  general: {
    key: 'general',
    label: 'General',
    description: 'Any other contract work run to stages and a budget.',
    capabilities: {
      programme: true,
      site_diary: false,
      time_claims: false,
      retention: true,
      certificate: false,
    },
    terms: {
      stage: 'Milestone',
      stages: 'Milestones',
      application: 'Invoice',
      applications: 'Invoices',
      client_role: 'Client',
      certificate_title: 'Statement of Account',
      work_done: 'Work completed',
      site_tab: 'Files',
    },
    delay_causes: [],
    document_categories: ['contract', 'photo', 'correspondence', 'other'],
  },
};

const DEFAULT_TYPE = 'construction';

/**
 * Projects created before types existed have no value stored, and every one of
 * them is a building job — so a missing type reads as construction rather than
 * as the blandest option. Nothing an existing tenant sees changes.
 */
function profileFor(type) {
  return TYPES[type] || TYPES[DEFAULT_TYPE];
}

const can = (type, capability) => !!profileFor(type).capabilities[capability];

/** Every value any type may store, so the schema stays a real constraint. */
const ALL_DELAY_CAUSES = [...new Set(Object.values(TYPES).flatMap((t) => t.delay_causes))];
const ALL_DOCUMENT_CATEGORIES = [...new Set(Object.values(TYPES).flatMap((t) => t.document_categories))];

module.exports = {
  TYPES,
  DEFAULT_TYPE,
  TYPE_KEYS: Object.keys(TYPES),
  ALL_DELAY_CAUSES,
  ALL_DOCUMENT_CATEGORIES,
  profileFor,
  can,
};
