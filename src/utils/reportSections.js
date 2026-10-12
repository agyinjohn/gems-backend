/**
 * Turn the text of a report someone wrote elsewhere (Word, PDF, plain text)
 * into the fields of a project report, so it does not have to be retyped.
 *
 * Reports written by hand tend to follow the same shape — what was done, what
 * is going wrong, what happens next — under headings that vary in wording.
 * Recognised headings route the text under them; anything before the first
 * heading, or the whole text when there are none, is the summary. A line such
 * as "Progress: 60%" or "Status: at risk" fills those fields too. Nothing here
 * is final: the lead sees every field filled in and edits before submitting.
 */

const SECTION_WORDS = {
  summary: [
    'summary', 'executive summary', 'overview', 'update', 'progress update', 'status update',
    'work done', 'work completed', 'work carried out', 'completed work', 'completed', 'activities',
    'accomplishments', 'achievements', 'progress', 'this week', 'this period', 'highlights',
  ],
  issues: [
    'issues', 'issue', 'risks', 'risk', 'issues and risks', 'issues & risks', 'risks and issues',
    'challenges', 'problems', 'blockers', 'concerns', 'delays', 'constraints',
  ],
  next_steps: [
    'next steps', 'next step', 'next week', 'next period', 'plan', 'plans', 'planned work',
    'upcoming', 'upcoming work', 'actions', 'action items', 'way forward', 'to do', 'todo', 'look ahead',
  ],
};

const HEALTH_WORDS = [
  [/\b(off[ -]?track|red|behind schedule|critical)\b/i, 'off_track'],
  [/\b(at[ -]?risk|amber|yellow|some concerns?)\b/i, 'at_risk'],
  [/\b(on[ -]?track|green|on schedule|good)\b/i, 'on_track'],
];

const norm = (s) => s.toLowerCase().replace(/^[\s#*•\-–—\d.)]+/, '').replace(/[:\s]+$/, '').trim();

/** The section a heading line names, or null. Accepts "Heading" and "Heading: text". */
function headingOf(line) {
  const [head, ...rest] = line.split(':');
  const key = norm(head);
  if (!key || key.length > 40) return null;
  for (const [section, words] of Object.entries(SECTION_WORDS)) {
    if (words.includes(key)) return { section, inline: rest.join(':').trim() };
  }
  return null;
}

function parseReport(text, filename = '') {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = { summary: [], issues: [], next_steps: [] };
  let progress_pct;
  let health;
  let title = '';
  let current = 'summary';
  let found = false;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { out[current].push(''); return; }

    // "Progress: 60%" / "Overall completion – 60 %"
    const pct = line.match(/^(?:overall\s+)?(?:progress|completion|complete|percent complete|% complete)\b[^0-9]{0,15}(\d{1,3})\s*%/i);
    if (pct && Number(pct[1]) <= 100) { progress_pct = Number(pct[1]); return; }

    // "Status: at risk" / "RAG: amber" / "Health – green"
    const st = line.match(/^(?:status|rag|health|rag status|overall status)\s*[:\-–]\s*(.+)$/i);
    if (st) {
      const hit = HEALTH_WORDS.find(([re]) => re.test(st[1]));
      if (hit) { health = hit[1]; return; }
    }

    const h = headingOf(line);
    if (h) {
      current = h.section;
      found = true;
      if (h.inline) out[current].push(h.inline);
      return;
    }

    // A short first line that is not a heading reads as the report's title.
    if (!title && i === lines.findIndex((l) => l.trim()) && line.length <= 80 && !/[.!?]$/.test(line)) {
      title = line.replace(/^#+\s*/, '');
      return;
    }
    out[current].push(line);
  });

  const tidy = (arr) => arr.join('\n').replace(/\n{2,}/g, '\n').trim();
  const fallbackTitle = String(filename).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

  return {
    title: title || fallbackTitle,
    summary: tidy(out.summary),
    issues: tidy(out.issues),
    next_steps: tidy(out.next_steps),
    progress_pct,
    health,
    sections_found: found,
  };
}

module.exports = { parseReport };
