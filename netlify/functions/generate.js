// This function runs on Netlify's server, not in the visitor's browser.
// The API key lives only here, as an environment variable — visitors never see it.

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

  const notes = (payload.notes || '').toString();
  const pdfUrl = (payload.pdfUrl || '').toString();
  const semesterLabel = (payload.semesterLabel || '').toString();
  const deckName = (payload.deckName || '').toString();

  // Clamp requested card count to a sane, cost-safe range regardless of what the client sent.
  let targetCount = parseInt(payload.targetCount, 10);
  if (!Number.isFinite(targetCount)) targetCount = 10;
  targetCount = Math.max(5, Math.min(60, targetCount));

  if (!notes.trim() && !pdfUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Hverken noter eller PDF modtaget.' }) };
  }
  if (notes.length > 20000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Noterne er for lange (maks 20.000 tegn).' }) };
  }

  // The PDF itself never passes through the client -> function request body (that has a ~6MB
  // ceiling on Netlify). Instead the browser uploads it to Supabase Storage and hands us a
  // short-lived signed URL, which we fetch server-side. Claude's own ceiling is ~32MB / 100 pages.
  let pdfBase64 = '';
  if (pdfUrl) {
    let pdfResp;
    try {
      pdfResp = await fetch(pdfUrl);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Kunne ikke hente PDF\'en fra storage.' }) };
    }
    if (!pdfResp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Kunne ikke hente PDF\'en fra storage (status ' + pdfResp.status + ').' }) };
    }
    const arrayBuf = await pdfResp.arrayBuffer();
    if (arrayBuf.byteLength > 30_000_000) {
      return { statusCode: 413, body: JSON.stringify({ error: 'PDF\'en er for stor til Claude (maks ca. 30 MB / 100 sider).' }) };
    }
    pdfBase64 = Buffer.from(arrayBuf).toString('base64');
  }

  const instructions = 'Du hjaelper en medicinstuderende paa ' + semesterLabel +
    ' med at lave eksamens-flashcards. Saettet, kortene tilhoerer, hedder "' + deckName + '".\n\n' +
    (pdfBase64
      ? 'Laes hele det vedhaengte PDF-dokument (inklusiv figurer, tabeller og diagrammer, ikke kun broedteksten) og '
      : 'Laes noterne nedenfor og ') +
    'lav praecis ' + targetCount + ' flashcards, der tilsammen daekker materialet grundigt — fra grundlaeggende ' +
    'begreber til vigtige detaljer, saa hele det indsatte pensum bliver testet, ikke kun de foerste sider. ' +
    'Foretraek spoergsmaal der tester forstaaelse (mekanismer, differentialdiagnoser, "hvorfor") frem for ren ' +
    'udenadslaere, hvor det giver mening.\n\n' +
    'Svar KUN med et JSON array, ingen anden tekst, ingen markdown-fences.\n' +
    'Hvert element skal se saadan ud: {"question": "...", "answer": "..."}' +
    (pdfBase64 ? '' : '\n\nNOTER:\n' + notes);

  const messageContent = pdfBase64
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: instructions }
      ]
    : instructions;

  // More cards need more room to answer in — scale the output budget with the request.
  const maxTokens = Math.min(8000, 800 + targetCount * 150);

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
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: messageContent }]
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
