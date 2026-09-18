// Adaptador de envio de WhatsApp — hoje contra a Evolution API (self-hosted,
// gratuita). Trocar de provedor é reescrever só este arquivo; o resto do
// sistema chama apenas sendWhatsApp(numero, texto).
const EVO_URL = process.env.EVOLUTION_API_URL;
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;

async function sendWhatsApp(to, text) {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) {
    console.warn('[whatsapp] não configurado (EVOLUTION_API_URL/KEY/INSTANCE ausentes) — mensagem não enviada para', to);
    return { ok: false, error: 'not_configured' };
  }
  try {
    const r = await fetch(`${EVO_URL.replace(/\/+$/, '')}/message/sendText/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVO_KEY },
      body: JSON.stringify({ number: String(to).replace(/\D/g, ''), text }),
      signal: AbortSignal.timeout(10000)
    });
    return { ok: r.ok, error: r.ok ? null : `http_${r.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendWhatsApp };
