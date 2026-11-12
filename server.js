// Intermediário do Elion Fiscal para a Sefin Nacional (NFS-e) — versão Render (Node puro, sem dependências).
// A Sefin pede o certificado por renegociação TLS, que o Cloudflare não suporta; o Node suporta.
// Não guarda nada: o sistema envia o certificado em cada pedido e assina o pedido com uma chave Ed25519 que só ele tem.
// Também hospeda a conexão de TESTE com o WhatsApp por QR Code (wa.js): pedidos com "acao", com a mesma assinatura.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const wa = require('./wa');

const CHAVE_PUBLICA = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6QyfHurOYoLSTZ4TrWZ3ovNFzjz/Fi+ABWUSBPQn9tc=
-----END PUBLIC KEY-----`;
const HOSTS = /^sefin(\.producaorestrita)?\.nfse\.gov\.br$/;
const vistos = new Map();
const json = (res, st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

function verificar(req, raw) {
  const ts = Number(req.headers['x-ts']), nonce = String(req.headers['x-nonce'] || ''), sig = String(req.headers['x-assinatura'] || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 120000 || !/^[0-9a-f]{32}$/.test(nonce) || !sig) return false;
  for (const [n, t] of vistos) if (Date.now() - t > 300000) vistos.delete(n);
  if (vistos.has(nonce)) return false;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(`${ts}.${nonce}.${hash}`), CHAVE_PUBLICA, Buffer.from(sig, 'base64')); } catch { ok = false; }
  if (ok) vistos.set(nonce, Date.now());
  return ok;
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/saude') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { erro: 'Use POST.' });
  const partes = []; let tam = 0;
  req.on('data', d => { tam += d.length; if (tam > 2_000_000) req.destroy(); else partes.push(d); });
  req.on('end', () => {
    const raw = Buffer.concat(partes);
    if (!verificar(req, raw)) return json(res, 401, { erro: 'Assinatura inválida.' });
    let p; try { p = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { erro: 'JSON inválido.' }); }
    if (p.acao) { wa.atender(p).then(r => json(res, 200, r)).catch(e => json(res, 400, { erro: e.message })); return; }
    let u; try { u = new URL(p.url); } catch { return json(res, 400, { erro: 'URL inválida.' }); }
    if (u.protocol !== 'https:' || !HOSTS.test(u.hostname) || !['GET', 'POST'].includes(p.metodo)) return json(res, 403, { erro: 'Destino não permitido.' });
    const corpo = p.corpo ? Buffer.from(p.corpo, 'utf8') : null;
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: p.metodo, cert: p.cert, key: p.key,
      minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', timeout: 60000,
      headers: { accept: 'application/json', ...(corpo ? { 'content-type': 'application/json', 'content-length': corpo.length } : {}) } }, resp => {
      const pr = []; resp.on('data', d => pr.push(d));
      resp.on('end', () => json(res, 200, { status: resp.statusCode, tipo: resp.headers['content-type'] || null, corpo: Buffer.concat(pr).toString('base64') }));
    });
    r.on('timeout', () => r.destroy(new Error('Tempo esgotado falando com a Sefin.')));
    r.on('error', e => { if (!res.headersSent) json(res, 502, { erro: `Falha de conexão com a Sefin: ${e.message}` }); });
    if (corpo) r.write(corpo);
    r.end();
  });
}).listen(process.env.PORT || 10000, () => console.log('intermediário no ar'));
