// Universo de Muñecas — backend (Cloudflare Worker)
// Secrets: XPAG_ID, XPAG_SECRET, OPENAI_KEY, UTMIFY_TOKEN, LEONA_WH (sin KV)
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

async function xget(env, q) {
  const r = await fetch(XPAG + '/consult-transaction?' + q, { headers: { Accept: 'application/json', 'X-Client-Id': env.XPAG_ID, 'X-Client-Secret': env.XPAG_SECRET } });
  try { return await r.json(); } catch (e) { return {}; }
}

const b64e = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => { try { s = s.replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch (e) { return null; } };
const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const UTM_KEYS = ['src', 'sck', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term'];

async function utmify(env, m, status, amount, method) {
  if (!env.UTMIFY_TOKEN || !m) return;
  const cents = Math.round(Number(amount || m.a || 0) * 100);
  const tp = {}; for (const k of UTM_KEYS) tp[k] = (m.u && m.u[k]) || null;
  const body = {
    orderId: m.i + '-' + m.s,
    platform: 'UniversoMunecas',
    paymentMethod: method === 'oxxo' ? 'boleto' : 'pix',
    status,
    createdAt: m.t || utcNow(),
    approvedDate: status === 'paid' ? utcNow() : null,
    refundedAt: null,
    customer: { name: 'Cliente', email: m.i + '@universomunecas.app', phone: null, document: null, country: 'MX' },
    products: [{ id: m.s, name: m.p || 'Universo de Muñecas', planId: null, planName: null, quantity: 1, priceInCents: cents }],
    trackingParameters: tp,
    commission: { totalPriceInCents: cents, gatewayFeeInCents: 0, userCommissionInCents: cents, currency: 'MXN' },
    isTest: false,
  };
  await fetch('https://api.utmify.com.br/api-credentials/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': env.UTMIFY_TOKEN }, body: JSON.stringify(body) }).catch(() => {});
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });

    // Crear cobro SPEI (CLABE propia de la venta) + voucher OXXO
    if (url.pathname === '/charge' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const sid = clean(b.sid, 40), stage = clean(b.stage, 20);
      const amount = Math.max(10, Math.min(10000, Number(b.amount) || 100));
      if (!sid || !stage) return json(req, { ok: false, error: 'missing' }, 400);
      const eid = sid + '-' + stage;
      const name = String(b.name || 'Cliente').slice(0, 60);
      const u = {}; if (b.utm && typeof b.utm === 'object') for (const k of UTM_KEYS) if (b.utm[k]) u[k] = String(b.utm[k]).slice(0, 150);
      const meta = { i: sid, s: stage, a: amount, p: String(b.desc || 'Universo de Muñecas').slice(0, 60), u, t: utcNow() };
      const wh = url.origin + '/wh?d=' + b64e(meta);
      const [spei, oxxo] = await Promise.all([
        xpag(env, { currency: 'MXN', external_id: eid + '-s', webhook_url: wh, name, description: b.desc || 'Universo de Muñecas' }),
        xpag(env, { currency: 'MXN', method: 'OXXO', amount, external_id: eid + '-o' + amount + '-' + Date.now().toString(36), webhook_url: wh, generateCheckout: false, payerData: { name } }),
      ]);
      const out = {
        ok: !!(spei.clabe || oxxo.payee_data),
        clabe: spei.clabe || null,
        bank: spei.bank_name || 'STP',
        beneficiary: spei.beneficiary || 'Zypher',
        oxxo_ref: oxxo.payee_data?.reference || null,
        oxxo_barcode: oxxo.payee_data?.barcode || null,
        oxxo_rn: oxxo.request_number || oxxo.transaction_id || null,
        amount,
        err: spei.clabe ? undefined : (spei.error_code || spei.message || spei.status),
        err_oxxo: oxxo.payee_data ? undefined : (oxxo.error_code || oxxo.message || oxxo.status),
      };
      if (out.ok && ctx) ctx.waitUntil(utmify(env, meta, 'waiting_payment', amount, 'spei'));
      return json(req, out);
    }

    // Webhook XPag -> confirma y manda la venta a la UTMify
    if (url.pathname === '/wh' && req.method === 'POST') {
      const m = b64d(url.searchParams.get('d') || '');
      const b = await req.json().catch(() => ({}));
      if (m && b.type === 'cashin' && b.status === 'confirmed') {
        // verifica en la XPag antes de registrar
        const q = b.request_number ? 'request_number=' + encodeURIComponent(b.request_number) : 'external_id=' + encodeURIComponent(b.external_id || '');
        const v = await xget(env, q);
        const ok = v.status === 'confirmed' || (v.payments || []).some(x => x.status === 'confirmed');
        if (ok) await utmify(env, m, 'paid', b.amount || m.a, /OXXO|oxxo|-o\d/.test(String(b.external_id || b.request_number || '')) ? 'oxxo' : 'spei');
      }
      return new Response('ok');
    }

    // Lead de la app -> dispara el funil de cobranza en Leona (WhatsApp)
    if (url.pathname === '/lead' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      let phone = String(b.phone || '').replace(/\D/g, '');
      if (phone.length === 10) phone = '52' + phone;
      if (phone.length === 13 && phone.startsWith('521')) phone = '52' + phone.slice(3);
      if (!/^52\d{10}$/.test(phone) || !env.LEONA_WH) return json(req, { ok: false });
      const r = await fetch(env.LEONA_WH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: String(b.name || 'Cliente').slice(0, 60), telefone: phone, valor: String(Number(b.amount) || ''), origem: 'app', sid: clean(b.sid, 40) }) }).catch(() => null);
      return json(req, { ok: !!(r && r.ok) });
    }

    // Consultar si ya pagó
    if (url.pathname === '/status') {
      const eid = clean(url.searchParams.get('sid'), 40) + '-' + clean(url.searchParams.get('stage'), 20);
      const rn = clean(url.searchParams.get('rn'), 80);
      const [a, o] = await Promise.all([xget(env, 'external_id=' + encodeURIComponent(eid + '-s')), rn ? xget(env, 'request_number=' + encodeURIComponent(rn)) : Promise.resolve({})]);
      const p = (a.payments || []).find(x => x.status === 'confirmed');
      if (p) return json(req, { paid: true, amount: p.amount });
      if (o.status === 'confirmed') return json(req, { paid: true, amount: o.amount });
      return json(req, { paid: false });
    }

    // IA: responde y clasifica la intención del lead
    if (url.pathname === '/chat' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const sid = clean(b.sid, 40);
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-12).map(m => ({ role: m.me ? 'user' : 'assistant', content: String(m.t || '').slice(0, 800) }));
      const opts = Array.isArray(b.options) ? b.options.map(x => clean(x)).filter(Boolean) : [];
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
