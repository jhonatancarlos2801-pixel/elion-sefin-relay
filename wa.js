// Conexão de TESTE com o WhatsApp por QR Code (WhatsApp Web, não oficial) para o Elion Fiscal.
// Só repassa ao sistema mensagens de números permitidos (a lista vem do próprio sistema, em pedidos assinados)
// e só envia mensagens quando o sistema pede (pedidos assinados com Ed25519). Não guarda conversas.
// A sessão fica em disco temporário: se o serviço reiniciar, é preciso ler o QR Code de novo.
const fs = require('fs');

const PASTA = process.env.WA_AUTH_DIR || '/tmp/elion-wa-auth';
let B = null;                 // módulo Baileys (carregado sob demanda: se faltar, o intermediário da Sefin segue funcionando)
let sock = null, status = 'desconectado', qr = null, erro = null, eu = null, ligando = false, religar = null;
let callback = null;          // { url, token } informado pelo sistema a cada pedido
let permitidos = new Set();   // números canônicos 55 + DDD + 8 últimos dígitos
const recentes = [];          // ids já repassados (evita duplicar)

const canon = d => { d = String(d || '').replace(/\D/g, ''); if (!d.startsWith('55') || d.length < 12) d = `55${d}`; return `55${d.slice(2, 4)}${d.slice(-8)}`; };
const numeroDoJid = j => String(j || '').split('@')[0].split(':')[0];

async function carregar() {
  if (B) return B;
  B = await import('@whiskeysockets/baileys');
  return B;
}

async function avisar(evento) {
  if (!callback?.url || !callback?.token) return;
  try {
    await fetch(callback.url, { method: 'POST', headers: { authorization: `Bearer ${callback.token}`, 'content-type': 'application/json' }, body: JSON.stringify(evento), signal: AbortSignal.timeout(60000) });
  } catch (e) { console.error('callback', e.message); }
}

function textoDe(msg) {
  const m = msg.message || {};
  const x = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.buttonsResponseMessage?.selectedDisplayText || '';
}

/** Agenda UMA reconexão (nunca duas conexões ao mesmo tempo: a segunda invalida o QR Code da primeira). */
function agendar(ms) { if (religar) return; religar = setTimeout(() => { religar = null; ligar(); }, ms); }
const sessaoSalva = () => { try { const c = JSON.parse(fs.readFileSync(`${PASTA}/creds.json`, 'utf8')); return !!(c.registered || c.me); } catch { return false; } };

async function ligar() {
  if (sock || ligando) return; // já existe uma conexão (ou está sendo criada): não cria outra
  ligando = true; erro = null;
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } = await carregar();
    const pino = require('pino');
    const { state, saveCreds } = await useMultiFileAuthState(PASTA);
    let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }
    status = 'conectando';
    const este = makeWASocket({ ...(version ? { version } : {}), auth: state, browser: Browsers.macOS('Elion Fiscal'), logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false, printQRInTerminal: false });
    sock = este;
    este.ev.on('creds.update', saveCreds);
    este.ev.on('connection.update', async u => {
      if (este !== sock) return; // evento de uma conexão antiga
      if (u.qr) { qr = u.qr; status = 'qr'; }
      if (u.connection === 'open') {
        status = 'conectado'; qr = null;
        const id = este.user?.id; let foto = null;
        try { foto = await este.profilePictureUrl(B.jidNormalizedUser(id), 'image'); } catch { foto = null; }
        eu = { numero: numeroDoJid(id), nome: este.user?.name || este.user?.verifiedName || null, foto };
        avisar({ tipo: 'estado', status, eu });
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        const registrado = !!(state.creds?.registered || state.creds?.me);
        console.log('WhatsApp fechou', code, 'registrado:', registrado);
        sock = null; eu = null;
        if (code === DisconnectReason.loggedOut) { fs.rmSync(PASTA, { recursive: true, force: true }); status = 'desconectado'; qr = null; avisar({ tipo: 'estado', status }); return; }
        if (code === DisconnectReason.restartRequired) { status = 'conectando'; qr = null; agendar(500); return; } // normal logo depois de ler o QR
        if (!registrado && code === DisconnectReason.timedOut) { status = 'desconectado'; qr = null; return; } // QR não lido a tempo: para
        status = 'conectando'; agendar(3000);
      }
    });
    este.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (m.key.fromMe || !m.message) continue;
          let jid = m.key.remoteJid || '';
          if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
          // contas com LID: o telefone vem no campo alternativo
          const pn = jid.endsWith('@lid') ? (m.key.remoteJidAlt || m.key.senderPn || m.key.participantPn || '') : jid;
          const numero = numeroDoJid(pn);
          if (!numero || !permitidos.has(canon(numero))) continue; // fora da lista: ignora em silêncio (nem marca como lido)
          if (recentes.includes(m.key.id)) continue;
          recentes.push(m.key.id); if (recentes.length > 500) recentes.shift();
          const x = m.message.ephemeralMessage?.message || m.message;
          const ev = { tipo: 'mensagem', de: numero, jid, waId: m.key.id, nome: m.pushName || null, texto: textoDe(m) };
          if (x.audioMessage || x.imageMessage) {
            const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: este.updateMediaMessage });
            if (buf.length <= 8_000_000) {
              if (x.audioMessage) { ev.audio = buf.toString('base64'); ev.audioMime = x.audioMessage.mimetype || 'audio/ogg'; }
              else { ev.imagem = buf.toString('base64'); }
            }
          }
          await avisar(ev);
        } catch (e) { console.error('mensagem', e.message); }
      }
    });
  } catch (e) { erro = e.message; status = 'erro'; console.error('WhatsApp', e); }
  ligando = false;
}

/** Atende um pedido assinado do sistema: { acao, cb, permitidos, ... } */
async function atender(p) {
  if (p.cb?.url && p.cb?.token) callback = { url: String(p.cb.url), token: String(p.cb.token) };
  if (Array.isArray(p.permitidos)) permitidos = new Set(p.permitidos.map(canon));
  // sessão já autenticada e desligada (ex.: serviço reiniciou): religa sozinho — só se não houver religação agendada
  if (!sock && !ligando && !religar && sessaoSalva() && p.acao !== 'desconectar') ligar();
  switch (p.acao) {
    case 'estado': {
      const contatos = [];
      if (sock && status === 'conectado' && p.fotos) for (const n of permitidos) {
        let foto = null; try { foto = await sock.profilePictureUrl(`${n.slice(0, 4)}9${n.slice(4)}@s.whatsapp.net`, 'image'); } catch { try { foto = await sock.profilePictureUrl(`${n}@s.whatsapp.net`, 'image'); } catch { foto = null; } }
        contatos.push({ numero: n, foto });
      }
      return { status, qr, erro, eu, contatos };
    }
    case 'conectar': {
      if (!sock && !ligando && !religar) { ligar(); await new Promise(r => setTimeout(r, 3000)); }
      // conectar sem câmera: código de 8 letras digitado no próprio celular (WhatsApp > Dispositivos conectados > Conectar com número)
      const num = String(p.numero || '').replace(/\D/g, '');
      if (num && status !== 'conectado') {
        for (let i = 0; i < 10 && !(sock && status === 'qr'); i++) await new Promise(r => setTimeout(r, 1000));
        if (!sock) throw new Error('Conexão ainda não está pronta. Tente de novo.');
        const codigo = await sock.requestPairingCode(num.startsWith('55') ? num : `55${num}`);
        return { status, codigo, eu };
      }
      return { status, qr, erro, eu };
    }
    case 'desconectar': {
      if (religar) { clearTimeout(religar); religar = null; }
      const s0 = sock; sock = null;
      try { await s0?.logout(); } catch { try { s0?.end?.(); } catch { /* já caiu */ } }
      eu = null; qr = null; status = 'desconectado';
      fs.rmSync(PASTA, { recursive: true, force: true });
      return { status };
    }
    case 'enviar': {
      if (!sock || status !== 'conectado') throw new Error('WhatsApp não conectado.');
      const n = String(p.para || '').replace(/\D/g, '');
      if (!permitidos.has(canon(n))) throw new Error('Número fora da lista permitida.');
      let jid = p.jid && /@(s\.whatsapp\.net|lid)$/.test(p.jid) ? p.jid : null;
      if (!jid) {
        const tent = [n, n.length === 13 ? n.slice(0, 4) + n.slice(5) : `${n.slice(0, 4)}9${n.slice(4)}`];
        for (const t of tent) { try { const [r] = await sock.onWhatsApp(t); if (r?.exists) { jid = r.jid; break; } } catch { /* próximo */ } }
      }
      if (!jid) throw new Error('Esse número não tem WhatsApp.');
      const r = await sock.sendMessage(jid, { text: String(p.texto || '').slice(0, 4000) });
      return { ok: true, id: r?.key?.id ?? null };
    }
    default: throw new Error('Ação desconhecida.');
  }
}

module.exports = { atender };
