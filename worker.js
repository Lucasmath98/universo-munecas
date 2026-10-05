// Universo de Muñecas — backend (Cloudflare Worker)
// Bindings: KV namespace PAID; secrets XPAG_ID, XPAG_SECRET, OPENAI_KEY; var WH_TOKEN
const ORIGINS = ['https://lucasmath98.github.io'];
const XPAG = 'https://api.xpag.global';

const SYSTEM = `Eres Sofía Hernández, creadora de "Universo de Muñecas". Hablas por chat con mamás de México, cálida, cercana y breve, en español mexicano informal (corazón, mi cielo, ¿sale?, ¿va?). Máximo 3 líneas, 1-2 emojis. Nunca digas que eres IA ni bot.

PRODUCTO: Universo de Muñecas, kit digital en PDF para imprimir en casa: muñecas de papel (Hada, Bailarina, Princesa, Unicornio), casitas para armar (Casa de Dulces, Casita del Hada, Trailer), vestuarios, peinados y accesorios, y un curso de muñecas de papel. No se envía nada físico. Se descarga aquí mismo en el chat (y por un link de Drive).
MODELO: primero recibe todo el material y después paga. Cooperación sugerida desde $100 MXN (muchas mamás cooperan con $150, $200 o $250).
EXTRA OPCIONAL: Kit de Actividades Creativas, 10 cuadernillos PDF por $100 MXN adicionales, también recibe primero y paga después.
PAGO: transferencia SPEI a la CLABE que se le mostró en el chat, o en efectivo en OXXO con la referencia que se le mostró. Si pregunta cómo pagar, dile que revise los datos de arriba en el chat. Nunca inventes CLABE, referencias ni links.
Si dice que ya pagó o manda comprobante: agradece y dile que en cuanto se confirme el pago le aviso aquí mismo.
Si no quiere: respeta, despídete con cariño.`;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
const clean = (s, n = 64) => String(s || '').replace(/[^\w\-]/g, '').slice(0, n);

async function xpag(env, body) {
  const r = await fetch(XPAG + '/cashin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Client-Id': env.XPAG_ID, 'X-Client-Secret': env.XPAG_SECRET },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });

    // Crear cobro SPEI (CLABE propia de la venta) + voucher OXXO
    if (url.pathname === '/charge' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const sid = clean(b.sid, 40), stage = clean(b.stage, 20);
      const amount = Math.max(10, Math.min(10000, Number(b.amount) || 100));
      if (!sid || !stage) return json(req, { ok: false, error: 'missing' }, 400);
      const eid = sid + '-' + stage;
      const cached = await env.PAID.get('c:' + eid + ':' + amount, 'json');
      if (cached) return json(req, cached);
      const wh = url.origin + '/webhook?t=' + env.WH_TOKEN;
      const name = String(b.name || 'Cliente').slice(0, 60);
      const [spei, oxxo] = await Promise.all([
        xpag(env, { currency: 'MXN', external_id: eid + '-s', webhook_url: wh, name, description: b.desc || 'Universo de Muñecas' }),
        xpag(env, { currency: 'MXN', method: 'OXXO', amount, external_id: eid + '-o' + amount, webhook_url: wh, generateCheckout: false, payerData: { name } }),
      ]);
      const out = {
        ok: !!(spei.clabe || oxxo.payee_data),
        clabe: spei.clabe || null,
        bank: spei.bank_name || 'STP',
        beneficiary: spei.beneficiary || 'Zypher',
        oxxo_ref: oxxo.payee_data?.reference || null,
        oxxo_barcode: oxxo.payee_data?.barcode || null,
        amount,
        err: spei.clabe ? undefined : (spei.error_code || spei.message || spei.status),
        err_oxxo: oxxo.payee_data ? undefined : (oxxo.error_code || oxxo.message || oxxo.status),
      };
      if (out.ok) await env.PAID.put('c:' + eid + ':' + amount, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 10 });
      return json(req, out);
    }

    // Webhook de la XPag
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (url.searchParams.get('t') !== env.WH_TOKEN) return new Response('no', { status: 403 });
      const b = await req.json().catch(() => ({}));
      if (b.type === 'cashin' && b.status === 'confirmed' && b.external_id) {
        const eid = String(b.external_id).replace(/-(s|o\d+)$/, '');
        await env.PAID.put('p:' + eid, JSON.stringify({ amount: b.amount, at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 60 });
      }
      return new Response('ok');
    }

    // Consultar si ya pagó
    if (url.pathname === '/status') {
      const eid = clean(url.searchParams.get('sid'), 40) + '-' + clean(url.searchParams.get('stage'), 20);
      const p = await env.PAID.get('p:' + eid, 'json');
      return json(req, { paid: !!p, amount: p?.amount || null });
    }

    // IA: responde y clasifica la intención del lead
    if (url.pathname === '/chat' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const sid = clean(b.sid, 40);
      const cnt = Number(await env.PAID.get('n:' + sid)) || 0;
      if (cnt > 40) return json(req, { intent: 'duvida', reply: 'Gracias corazón 💕 En un ratito te respondo con calma.' });
      await env.PAID.put('n:' + sid, String(cnt + 1), { expirationTtl: 60 * 60 * 24 });
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-12).map(m => ({ role: m.me ? 'user' : 'assistant', content: String(m.t || '').slice(0, 800) }));
      const opts = Array.isArray(b.options) ? b.options.map(clean).filter(Boolean) : [];
      const task = opts.length
        ? `La última pregunta que hiciste espera una respuesta. Clasifica el último mensaje de la clienta en una de estas intenciones: ${opts.join(', ')}. ("positivo" = acepta/quiere/sí; "negativo" = no quiere/rechaza; "duvida" = pregunta, duda u otra cosa). Si es positivo o negativo, "reply" puede quedar vacío. Si es duda, responde la duda en "reply" y termina repitiendo amablemente la pregunta pendiente.`
        : `Responde a la clienta en "reply". intent = "duvida".`;
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENAI_KEY },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.6,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM + '\n\nCONTEXTO ACTUAL: ' + String(b.context || '').slice(0, 300) + '\n\n' + task + '\nResponde SOLO JSON: {"intent":"...","reply":"..."}' },
            ...hist,
            { role: 'user', content: String(b.text || '').slice(0, 800) },
          ],
        }),
      });
      const j = await r.json().catch(() => ({}));
      let out = { intent: 'duvida', reply: '' };
      try { out = JSON.parse(j.choices[0].message.content); } catch (e) {}
      if (opts.length && !opts.includes(out.intent)) out.intent = 'duvida';
      return json(req, out);
    }

    return json(req, { ok: true, service: 'universo-munecas' });
  },
};
