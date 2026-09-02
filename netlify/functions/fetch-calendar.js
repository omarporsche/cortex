// Fetches an iCal (.ics) calendar feed server-side and returns parsed events as JSON.
// Calendar feed endpoints (Absalon/Canvas included) typically don't allow direct browser
// fetches (no CORS headers), so this proxy exists purely to work around that — same pattern
// as the PDF handling.
//
// Note: this is a lightweight, best-effort ICS parser. It handles the common case (individual
// dated events with DTSTART/DTEND) but does not expand RRULE-based recurring events beyond
// their first listed instance. Untested against a real Absalon feed — may need adjustment.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig forespørgsel.' }) };
  }

  let calendarUrl = (payload.calendarUrl || '').toString().trim();
  if (!calendarUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ingen kalender-URL modtaget.' }) };
  }
  if (calendarUrl.indexOf('webcal://') === 0) {
    calendarUrl = 'https://' + calendarUrl.slice('webcal://'.length);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(calendarUrl);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig kalender-URL.' }) };
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Kun http/https-links understøttes.' }) };
  }

  try {
    const resp = await fetch(calendarUrl, { headers: { 'Accept': 'text/calendar' } });
    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Kunne ikke hente kalenderen (status ' + resp.status + '). Tjek at linket er korrekt.' }) };
    }
    const text = await resp.text();
    const events = parseIcs(text);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Kunne ikke hente eller læse kalenderen: ' + (e.message || 'ukendt fejl') }) };
  }
};

function unfoldLines(text) {
  // RFC5545: a line starting with a space or tab is a continuation of the previous line.
  const rawLines = text.split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseIcsDate(value) {
  if (!value) return null;
  const clean = value.trim();
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const y = m[1], mo = m[2], d = m[3], h = m[4], mi = m[5], s = m[6];
  if (h === undefined) {
    return new Date(Date.UTC(+y, +mo - 1, +d)).toISOString();
  }
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

function unescapeIcsText(s) {
  return s.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcs(text) {
  const lines = unfoldLines(text);
  const events = [];
  let current = null;

  const now = Date.now();
  const windowStart = now - 24 * 60 * 60 * 1000; // include events from yesterday onward
  const windowEnd = now + 60 * 24 * 60 * 60 * 1000; // next 60 days

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.start) {
        const startMs = new Date(current.start).getTime();
        if (!isNaN(startMs) && startMs >= windowStart && startMs <= windowEnd) {
          events.push(current);
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const keyPart = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const key = keyPart.split(';')[0];

    if (key === 'SUMMARY') current.title = unescapeIcsText(value);
    else if (key === 'LOCATION') current.location = unescapeIcsText(value);
    else if (key === 'DESCRIPTION') current.description = unescapeIcsText(value);
    else if (key === 'DTSTART') current.start = parseIcsDate(value);
    else if (key === 'DTEND') current.end = parseIcsDate(value);
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  return events.slice(0, 200);
}
