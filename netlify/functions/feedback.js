// Runs server-side on Netlify. Uses the same server-only API key as generate.js —
// visitors never see it, and this is only reachable by logged-in users (enforced in the frontend).

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Serveren mangler en API-nøgle (ANTHROPIC_API_KEY er ikke sat i Netlify).' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig forespørgsel.' }) };
  }

  const session = Array.isArray(payload.session) ? payload.session : [];
  const semesterLabel = (payload.semesterLabel || '').toString();
  const deckName = (payload.deckName || '').toString();

  if (session.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ingen sessionsdata modtaget.' }) };
  }
  if (session.length > 200) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Session er for stor.' }) };
  }

  const lines = session.map((c, i) => {
    const q = (c.question || '').toString().slice(0, 500);
    const a = (c.answer || '').toString().slice(0, 500);
    const r = (c.rating || 'ukendt').toString();
    return (i + 1) + '. [' + r + '] Spørgsmål: ' + q + ' | Svar: ' + a;
  }).join('\n');

  const prompt = 'En medicinstuderende paa ' + semesterLabel + ' har lige gennemgaaet flashcard-saettet "' + deckName +
    '" og selv vurderet hvert kort som svaert, mellem eller nemt.\n\n' +
    'Her er kortene med deres vurdering:\n' + lines + '\n\n' +
    'Analysér mønstret og svar KUN med et JSON-objekt, ingen anden tekst, ingen markdown-fences:\n' +
    '{"strengths": ["kort punkt om et emne de har styr på", "..."], "review": ["kort punkt om et emne de bør laese op paa", "..."]}\n\n' +
    'Regler:\n' +
    '- Hvert punkt skal vaere kort (maks en halv saetning) og navngive det konkrete emne/begreb fra spørgsmålene, ikke generisk opmuntring.\n' +
    '- "strengths" er baseret paa kort vurderet nemt/mellem, "review" er baseret paa kort vurderet svaert.\n' +
    '- Maks 5 punkter i hver kategori. Hvis en kategori er tom (fx ingen svaere kort), returnér et tomt array for den.\n' +
    '- Skriv paa dansk.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + response.status);
      return { statusCode: response.status, body: JSON.stringify({ error: msg }) };
    }

    const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text' && b.text) : null;
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Uventet svar fra AI-tjenesten.' }) };
    }

    let raw = textBlock.text.trim();
    if (raw.indexOf('```') === 0) {
      raw = raw.replace(/^```json?/, '').replace(/```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Kunne ikke laese AI-svaret som JSON.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        review: Array.isArray(parsed.review) ? parsed.review : []
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Serverfejl' }) };
  }
};
