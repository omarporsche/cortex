// This function runs on Netlify's server, not in the visitor's browser.
// The API key lives only here, as an environment variable â€” visitors never see it.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Serveren mangler en API-nÃ¸gle (ANTHROPIC_API_KEY er ikke sat i Netlify).' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ugyldig forespÃ¸rgsel.' }) };
  }

  const notes = (payload.notes || '').toString();
  const semesterLabel = (payload.semesterLabel || '').toString();
  const deckName = (payload.deckName || '').toString();

  if (!notes.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Noter mangler.' }) };
  }
  if (notes.length > 20000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Noterne er for lange (maks 20.000 tegn).' }) };
  }

  const prompt = 'Du hjaelper en medicinstuderende paa ' + semesterLabel +
    ' med at lave eksamens-flashcards ud fra deres noter. Saettet, kortene tilhoerer, hedder "' + deckName + '".\n\n' +
    'Laes noterne nedenfor og lav praecis 8 flashcards, der tester de vigtigste, eksamensrelevante fakta og koncepter. ' +
    'Foretraek spoergsmaal der tester forstaaelse (mekanismer, differentialdiagnoser, "hvorfor") frem for ren udenadslaere, hvor det giver mening.\n\n' +
    'Svar KUN med et JSON array, ingen anden tekst, ingen markdown-fences.\n' +
    'Hvert element skal se saadan ud: {"question": "...", "answer": "..."}\n\n' +
    'NOTER:\n' + notes;

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
        max_tokens: 4000,
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

    let cards;
    try {
      cards = JSON.parse(raw);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Kunne ikke laese AI-svaret som JSON.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Serverfejl' }) };
  }
};
