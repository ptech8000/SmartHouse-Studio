// CSV Export generator strictly adhering to PRD §8 specifications
// with explicit human-readable event Date, Time Started, Time Submitted, Duration & Timezone columns

function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // Neutralize Excel/spreadsheet formula injection characters
  if (/^[ \t]*[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatEventDateTime(isoString, timeZone = 'Europe/Paris') {
  if (!isoString) return { date: '', time: '' };
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);

    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const hour = map.hour === '24' ? '00' : map.hour;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return {
      date: `${map.year}-${map.month}-${map.day}`,
      time: `${hour}:${map.minute}:${map.second}.${ms}`
    };
  } catch {
    // Fallback to UTC parts if timezone string is invalid
    const iso = d.toISOString();
    return {
      date: iso.slice(0, 10),
      time: iso.slice(11, 23)
    };
  }
}

function computeDurationSec(startedIso, submittedIso) {
  if (!startedIso || !submittedIso) return '';
  const startMs = new Date(startedIso).getTime();
  const submitMs = new Date(submittedIso).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(submitMs)) return '';
  return Math.max(0, (submitMs - startMs) / 1000).toFixed(2);
}

function generateAnnotationsCsv(rows, timeZone = 'Europe/Paris') {
  const headers = [
    'session_id',
    'participant',
    'annotation_id',
    'date',
    'time_started',
    'time_submitted',
    'duration_sec',
    'timezone',
    'timestamp_submitted',
    'timestamp_started',
    'location_id',
    'location',
    'activity_id',
    'activity',
    'interaction',
    'other_person',
    'edited',
    'config_version'
  ];

  const lines = [headers.join(',')];

  for (const r of rows) {
    const startDt = formatEventDateTime(r.timestamp_started || r.timestamp_submitted, timeZone);
    const submitDt = formatEventDateTime(r.timestamp_submitted, timeZone);
    const eventDate = startDt.date || submitDt.date;
    const durationSec = computeDurationSec(r.timestamp_started, r.timestamp_submitted);

    const row = [
      escapeCsvField(r.session_id),
      escapeCsvField(r.participant),
      escapeCsvField(r.seq), // annotation_id: sequential number per participant
      escapeCsvField(eventDate),
      escapeCsvField(startDt.time),
      escapeCsvField(submitDt.time),
      escapeCsvField(durationSec),
      escapeCsvField(timeZone),
      escapeCsvField(r.timestamp_submitted),
      escapeCsvField(r.timestamp_started),
      escapeCsvField(r.location_id),
      escapeCsvField(r.location),
      escapeCsvField(r.activity_id),
      escapeCsvField(r.activity),
      escapeCsvField(r.interaction),
      escapeCsvField(r.other_person || ''),
      escapeCsvField(r.edited === 1 || r.edited === true ? 'true' : 'false'),
      escapeCsvField(r.config_version)
    ];
    lines.push(row.join(','));
  }

  // Prepend UTF-8 BOM so Excel opens special characters cleanly without mojibake
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = {
  generateAnnotationsCsv,
  formatEventDateTime
};
