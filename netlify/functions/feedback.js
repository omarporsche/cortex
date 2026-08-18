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
    'Giv kort, konkret feedback paa dansk (maks ca. 150 ord):\n' +
    '- Hvilke emner/begreber ser ud til at sidde godt fast (dem vurderet nemt/mellem)?\n' +
    '- Hvilke emner boer de repetere snarest (dem vurderet svaert)?\n' +
    'Vaer specifik om de faktiske emner i sporgsmaalene, ikke generisk opmuntring. ' +
    'Skriv i en venlig, faglig tone, som en studiekammerat der giver et hurtigt overblik. ' +
    'Svar KUN med selve feedback-teksten, ingen indledning som "Her er din feedback".';

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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: textBlock.text.trim() })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Serverfejl' }) };
  }
};
