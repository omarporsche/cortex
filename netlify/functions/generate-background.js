// Background function — Netlify allows these up to 15 minutes of execution (vs 10s for
// normal functions), detected automatically from the "-background" suffix in the filename.
// Background functions never return a response to the caller; progress and results are
// written directly to Supabase (using the calling user's own access token, so normal RLS
// rules apply), and the browser polls the generation_jobs table to know when it's done.
//
// Never let this handler throw an uncaught error — Netlify auto-retries background functions
// that error out (up to twice more), which would duplicate the generated cards. Everything is
// wrapped in try/catch accordingly.

const SUPABASE_URL = 'https://ygwydvssavgfsxpgxxdd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlnd3lkdnNzYXZnZnN4cGd4eGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NDkxMDYsImV4cCI6MjEwMDIyNTEwNn0.ptSE_nFUhzwvGyudbG08ROlbL4B4dHzpGpAR_pUvrOY';

const BATCH_SIZE = 25;          // cards requested per Claude call
const MAX_BATCHES = 30;         // safety valve against runaway loops, not a real content limit
const SAFETY_MAX_CARDS = 400;   // guards against a corrupted/malicious request, not a real coverage limit

exports.handler = async function (event) {
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 200, body: '' };
  }

  const jobId = (payload.jobId || '').toString();
  const accessToken = (payload.accessToken || '').toString();
  const notes = (payload.notes || '').toString();
  const pdfUrl = (payload.pdfUrl || '').toString();
  const semesterLabel = (payload.semesterLabel || '').toString();
  const deckName = (payload.deckName || '').toString();
  const deckId = (payload.deckId || '').toString();

  let targetCount = parseInt(payload.targetCount, 10);
  if (!Number.isFinite(targetCount)) targetCount = 10;
  targetCount = Math.max(5, Math.min(SAFETY_MAX_CARDS, targetCount));

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!jobId || !accessToken || !deckId || !apiKey) {
    return { statusCode: 200, body: '' };
  }

  try {
    await setJobStatus(jobId, accessToken, { status: 'processing', target_count: targetCount });

    let pdfBase64 = '';
    if (pdfUrl) {
      const pdfResp = await fetch(pdfUrl);
      if (!pdfResp.ok) throw new Error('Kunne ikke hente PDF\'en fra storage.');
      const arrayBuf = await pdfResp.arrayBuffer();
      if (arrayBuf.byteLength > 30_000_000) throw new Error('PDF\'en er for stor til Claude (maks ca. 30 MB / 100 sider).');
      pdfBase64 = Buffer.from(arrayBuf).toString('base64');
    }

    if (!notes.trim() && !pdfBase64) {
      throw new Error('Hverken noter eller PDF modtaget.');
    }

    let allCards = [];
    let batchNum = 0;

    while (allCards.length < targetCount && batchNum < MAX_BATCHES) {
      const remaining = targetCount - allCards.length;
      const batchSize = Math.min(BATCH_SIZE, remaining);
      const existingQuestions = allCards.map(c => c.question);

      const batchCards = await generateBatch({
        apiKey, pdfBase64, notes, semesterLabel, deckName, batchSize, existingQuestions
      });

      batchNum++;
      if (batchCards.length === 0) break;

      const rows = batchCards.map(c => ({ deck_id: deckId, question: c.question, answer: c.answer }));
      await supabaseInsert('cards', rows, accessToken);

      allCards = allCards.concat(batchCards);
      await setJobStatus(jobId, accessToken, { cards_created: allCards.length });
    }

    if (allCards.length === 0) {
      throw new Error('Kunne ikke generere nogen kort ud fra materialet.');
    }

    await setJobStatus(jobId, accessToken, { status: 'complete', cards_created: allCards.length });
  } catch (e) {
    try {
      await setJobStatus(jobId, accessToken, { status: 'error', error_message: (e.message || 'Ukendt fejl').slice(0, 500) });
    } catch (e2) { /* nothing more we can do */ }
  }

  return { statusCode: 200, body: '' };
};

async function generateBatch({ apiKey, pdfBase64, notes, semesterLabel, deckName, batchSize, existingQuestions }) {
  const avoidText = existingQuestions.length > 0
    ? '\n\nDisse spoergsmaal er allerede lavet i tidligere omgange for dette saet — lav IKKE de samme eller meget lignende igen:\n' +
      existingQuestions.slice(-100).map(q => '- ' + q.slice(0, 150)).join('\n')
    : '';

  const instructions = 'Du hjaelper en medicinstuderende paa ' + semesterLabel +
    ' med at lave eksamens-flashcards. Saettet, kortene tilhoerer, hedder "' + deckName + '".\n\n' +
    (pdfBase64
      ? 'Laes hele det vedhaengte PDF-dokument (inklusiv figurer, tabeller og diagrammer, ikke kun broedteksten) og '
      : 'Laes noterne nedenfor og ') +
    'lav praecis ' + batchSize + ' NYE flashcards, der daekker materialet grundigt. ' +
    'Foretraek spoergsmaal der tester forstaaelse (mekanismer, differentialdiagnoser, "hvorfor") frem for ren ' +
    'udenadslaere, hvor det giver mening.' + avoidText + '\n\n' +
    'Svar KUN med et JSON array, ingen anden tekst, ingen markdown-fences.\n' +
    'Hvert element skal se saadan ud: {"question": "...", "answer": "..."}' +
    (pdfBase64 ? '' : '\n\nNOTER:\n' + notes);

  const messageContent = pdfBase64
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: instructions }
      ]
    : instructions;

  const maxTokens = Math.min(8000, 800 + batchSize * 150);

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
    throw new Error(msg);
  }

  const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text' && b.text) : null;
  if (!textBlock) throw new Error('Uventet svar fra AI-tjenesten.');

  let raw = textBlock.text.trim();
  if (raw.indexOf('```') === 0) {
    raw = raw.replace(/^```json?/, '').replace(/```$/, '').trim();
  }

  try {
    const cards = JSON.parse(raw);
    return Array.isArray(cards) ? cards.filter(c => c && c.question && c.answer) : [];
  } catch (e) {
    return [];
  }
}

async function supabaseInsert(table, rows, accessToken) {
  const resp = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + accessToken,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Kunne ikke gemme kort: ' + resp.status + ' ' + errText.slice(0, 200));
  }
}

async function setJobStatus(jobId, accessToken, patch) {
  patch.updated_at = new Date().toISOString();
  const resp = await fetch(SUPABASE_URL + '/rest/v1/generation_jobs?id=eq.' + jobId, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + accessToken,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Kunne ikke opdatere status: ' + resp.status + ' ' + errText.slice(0, 200));
  }
}
