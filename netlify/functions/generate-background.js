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

const BATCH_SIZE = 12;          // cards requested per Claude call — kept small so answers never get cut off
const CONCURRENCY = 4;          // batches run in parallel (text notes), to cut wall-clock time
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
  const pdfPageCount = parseInt(payload.pdfPageCount, 10) || null;
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

    // Split the work into batches, and give each batch its own slice of the material to focus
    // on — this both parallelizes generation (much faster) and reduces overlap between batches,
    // rather than relying on a single sequential "don't repeat these" instruction.
    const numBatches = Math.min(MAX_BATCHES, Math.ceil(targetCount / BATCH_SIZE));
    const batchSizes = [];
    let remaining = targetCount;
    for (let i = 0; i < numBatches; i++) {
      const size = Math.min(BATCH_SIZE, remaining);
      batchSizes.push(size);
      remaining -= size;
    }

    const noteChunks = (!pdfBase64 && notes) ? splitTextIntoChunks(notes, numBatches) : null;

    let cardsCreated = 0;
    const tasks = batchSizes.map((size, i) => async () => {
      const focusHint = pdfBase64
        ? buildPdfFocusHint(i, numBatches, pdfPageCount)
        : '';
      const batchNotes = noteChunks ? noteChunks[i] : notes;

      let batchCards = [];
      try {
        batchCards = await generateBatch({
          apiKey, pdfBase64, notes: batchNotes, semesterLabel, deckName, batchSize: size, focusHint
        });
      } catch (e) {
        batchCards = []; // one failed batch shouldn't sink the whole job
      }

      if (batchCards.length > 0) {
        const rows = batchCards.map(c => ({ deck_id: deckId, question: c.question, answer: c.answer }));
        try {
          await supabaseInsert('cards', rows, accessToken);
          cardsCreated += batchCards.length;
          await setJobStatus(jobId, accessToken, { cards_created: cardsCreated });
        } catch (e) { /* keep going even if one insert fails */ }
      }
      return batchCards;
    });

    const effectiveConcurrency = pdfBase64 ? 2 : CONCURRENCY;
    const results = await runWithConcurrency(tasks, effectiveConcurrency);
    const totalCreated = results.reduce((sum, r) => sum + r.length, 0);

    if (totalCreated === 0) {
      throw new Error('Kunne ikke generere nogen kort ud fra materialet.');
    }

    await setJobStatus(jobId, accessToken, { status: 'complete', cards_created: totalCreated });
  } catch (e) {
    try {
      await setJobStatus(jobId, accessToken, { status: 'error', error_message: (e.message || 'Ukendt fejl').slice(0, 500) });
    } catch (e2) { /* nothing more we can do */ }
  }

  return { statusCode: 200, body: '' };
};

async function runWithConcurrency(taskFns, limit) {
  const results = new Array(taskFns.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < taskFns.length) {
      const i = nextIndex++;
      results[i] = await taskFns[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function splitTextIntoChunks(text, n) {
  if (n <= 1) return [text];
  const chunks = [];
  const chunkLen = Math.ceil(text.length / n);
  let start = 0;
  for (let i = 0; i < n; i++) {
    let end = Math.min(text.length, start + chunkLen);
    if (end < text.length) {
      const nextSpace = text.indexOf(' ', end);
      if (nextSpace !== -1 && nextSpace - end < 200) end = nextSpace;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function buildPdfFocusHint(batchIndex, totalBatches, pageCount) {
  if (!pageCount || totalBatches <= 1) return '';
  const pagesPerBatch = pageCount / totalBatches;
  const fromPage = Math.floor(batchIndex * pagesPerBatch) + 1;
  const toPage = Math.min(pageCount, Math.ceil((batchIndex + 1) * pagesPerBatch));
  return 'Fokusér primaert (men ikke udelukkende) paa materialet omkring side ' + fromPage + ' til ' + toPage + ' ud af ' + pageCount + ' sider i alt.';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateBatch({ apiKey, pdfBase64, notes, semesterLabel, deckName, batchSize, focusHint }, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 2;

  const instructions = 'Du hjaelper en medicinstuderende paa ' + semesterLabel +
    ' med at lave eksamens-flashcards. Saettet, kortene tilhoerer, hedder "' + deckName + '".\n\n' +
    (pdfBase64
      ? 'Laes det vedhaengte PDF-dokument (inklusiv figurer, tabeller og diagrammer, ikke kun broedteksten). '
      : 'Laes noterne nedenfor. ') +
    (focusHint ? focusHint + '\n\n' : '') +
    'Lav praecis ' + batchSize + ' flashcards, der daekker denne del af materialet grundigt. ' +
    'Hold svarene KORTE og praecise (1-3 saetninger) — det er vigtigere at naa alle ' + batchSize + ' kort end at give lange svar. ' +
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

  const maxTokens = Math.min(8192, 1200 + batchSize * 300);

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
    if (response.status === 429 && retriesLeft > 0) {
      await sleep(3000 + Math.random() * 3000);
      return generateBatch({ apiKey, pdfBase64, notes, semesterLabel, deckName, batchSize, focusHint }, retriesLeft - 1);
    }
    const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + response.status);
    throw new Error(msg);
  }

  const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text' && b.text) : null;
  if (!textBlock) throw new Error('Uventet svar fra AI-tjenesten.');

  // If Claude ran out of tokens mid-answer, the JSON will be cut off and unparseable.
  // Retrying with a smaller batch (fewer cards to fit in the same budget) usually fixes it,
  // rather than silently losing this whole batch's cards.
  const wasTruncated = data.stop_reason === 'max_tokens';

  let raw = textBlock.text.trim();
  if (raw.indexOf('```') === 0) {
    raw = raw.replace(/^```json?/, '').replace(/```$/, '').trim();
  }

  let cards = parseCardsLoosely(raw);

  if (cards.length === 0 && (wasTruncated || raw.length > 0) && retriesLeft > 0 && batchSize > 3) {
    const smallerSize = Math.max(3, Math.ceil(batchSize / 2));
    return generateBatch({ apiKey, pdfBase64, notes, semesterLabel, deckName, batchSize: smallerSize, focusHint }, retriesLeft - 1);
  }

  return cards;
}

// Tries a normal JSON.parse first; if the array got cut off mid-way (truncated response),
// salvages whatever complete {"question":...,"answer":...} objects it can find instead of
// discarding the whole batch.
function parseCardsLoosely(raw) {
  try {
    const cards = JSON.parse(raw);
    return Array.isArray(cards) ? cards.filter(c => c && c.question && c.answer) : [];
  } catch (e) {
    const found = [];
    const objRegex = /\{\s*"question"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"answer"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
    const matches = raw.match(objRegex) || [];
    for (const m of matches) {
      try {
        const obj = JSON.parse(m);
        if (obj && obj.question && obj.answer) found.push(obj);
      } catch (e2) { /* skip malformed fragment */ }
    }
    return found;
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
