/**
 * Login do painel (usuário + senha) — sem dependências externas.
 *
 *  - Usuários ficam em DATA_DIR/usuarios.json (senhas com scrypt + salt).
 *  - Primeiro acesso na nuvem: defina ADMIN_EMAIL e ADMIN_SENHA nas variáveis de ambiente.
 *  - Sem usuários e sem ADMIN_EMAIL (ex.: no Mac) o login fica desligado, como antes.
 *  - Sessão: cookie assinado (HMAC) com validade de 30 dias.
 *
 *  Rotas: /login  /logout  /conta (usuários, senha, envio de planilhas/arquivos de dados)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const DATA = require('./dados');

const ARQ_USU = path.join(DATA, 'usuarios.json');
const DIAS_SESSAO = 30;

// ─── Usuários ──────────────────────────────────────────────────────────────
function lerUsuarios() { try { return JSON.parse(fs.readFileSync(ARQ_USU)); } catch (e) { return []; } }
function salvarUsuarios(u) { fs.writeFileSync(ARQ_USU, JSON.stringify(u, null, 2)); }
function hash(senha, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(senha), salt, 64).toString('hex') };
}
function confere(u, senha) {
  const h = crypto.scryptSync(String(senha), u.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
}
const normEmail = e => String(e || '').trim().toLowerCase();

function bootstrap() {
  const adminEmail = normEmail(process.env.ADMIN_EMAIL);
  let u = lerUsuarios();
  if (adminEmail && !u.find(x => x.email === adminEmail)) {
    if (!process.env.ADMIN_SENHA) { console.warn('[auth] ADMIN_EMAIL definido sem ADMIN_SENHA — admin não criado'); }
    else {
      u.push({ email: adminEmail, nome: 'Administrador', admin: true, criadoEm: new Date().toISOString(), ...hash(process.env.ADMIN_SENHA) });
      salvarUsuarios(u);
      console.log('[auth] administrador criado:', adminEmail);
    }
  }
  return u;
}
const ativo = () => lerUsuarios().length > 0;

// ─── Chave da TV (acesso só à tela /tv, sem login) ─────────────────────────
const ARQ_TV = path.join(DATA, 'tv_chave.txt');
function chaveTv(nova = false) {
  if (!nova) { try { const k = fs.readFileSync(ARQ_TV, 'utf8').trim(); if (k) return k; } catch (e) {} }
  const k = crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(ARQ_TV, k, { mode: 0o600 }); return k;
}
function acessoTv(req, res) {
  if (!(req.path === '/tv' || req.path === '/tv/' || req.path === '/tv/dados' || req.path.startsWith('/tv/fontes/') || req.path.startsWith('/logo/'))) return false;
  const k = chaveTv(), q = String(req.query.chave || '');
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)painel_tv=([^;]+)/);
  const igual = v => v && v.length === k.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(k));
  if (igual(q)) { res.setHeader('Set-Cookie', `painel_tv=${k}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${req.secure ? '; Secure' : ''}`); return true; }
  return igual(m && m[1]);
}

// ─── Sessão (cookie assinado) ──────────────────────────────────────────────
function segredo() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA, '.session_secret');
  try { return fs.readFileSync(f, 'utf8'); } catch (e) {}
  const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, s, { mode: 0o600 }); return s;
}
const assinar = v => crypto.createHmac('sha256', segredo()).update(v).digest('base64url');
function criarCookie(email) {
  const v = Buffer.from(JSON.stringify({ e: email, x: Date.now() + DIAS_SESSAO * 864e5 })).toString('base64url');
  return v + '.' + assinar(v);
}
function lerCookie(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)painel_sess=([^;]+)/);
  if (!m) return null;
  const [v, sig] = m[1].split('.');
  if (!v || !sig) return null;
  const esperado = assinar(v);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const d = JSON.parse(Buffer.from(v, 'base64url').toString());
    if (d.x < Date.now()) return null;
    return lerUsuarios().find(u => u.email === d.e) || null; // usuário removido perde acesso na hora
  } catch (e) { return null; }
}
function setCookie(req, res, valor, maxAgeSeg) {
  const seguro = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `painel_sess=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeg}${seguro}`);
}

// ─── Proteção contra tentativas repetidas ──────────────────────────────────
const tentativas = new Map(); // ip -> {n, ate}
function bloqueado(ip) { const t = tentativas.get(ip); return t && t.n >= 10 && t.ate > Date.now(); }
function falhou(ip) { const t = tentativas.get(ip) || { n: 0, ate: 0 }; if (t.ate < Date.now()) t.n = 0; t.n++; t.ate = Date.now() + 15 * 60e3; tentativas.set(ip, t); }

// ─── Páginas ───────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = `*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}
.top{background:#0d1b2a;color:white;padding:14px 24px;display:flex;align-items:center;gap:12px}.top a{color:#ffd60a;text-decoration:none;font-size:13px}
.box{background:white;border:1px solid #e6e6e6;border-radius:12px;padding:22px 24px;margin:0 auto 16px;max-width:760px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}p.s{color:#777;font-size:13px;margin:0 0 16px}
label{font-size:12px;color:#666;display:block;margin:10px 0 4px}input,select{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px}
button{padding:10px 18px;border:none;border-radius:8px;background:#0d1b2a;color:white;font-weight:600;font-size:14px;cursor:pointer;margin-top:14px}
button.del{background:#c62828;padding:6px 12px;font-size:12px;margin:0}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:8px;border-bottom:1px solid #f0f0f0;text-align:left}
.msg{padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px}.ok{background:#e8f5e9;color:#2e7d32}.err{background:#ffebee;color:#c62828}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}@media(max-width:640px){.row{grid-template-columns:1fr}}`;

function paginaLogin(erro, next) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel — Entrar</title><style>${css}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}.card{background:white;border-radius:14px;padding:32px 28px;width:100%;max-width:380px;box-shadow:0 8px 30px rgba(13,27,42,.12)}</style></head>
  <body><div class="wrap"><form class="card" method="post" action="/login">
  <h1>Painel Marketplaces</h1><p class="s">Zagodini · Com Amor de Mãe · Lufe</p>
  ${erro ? `<div class="msg err">${esc(erro)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(next || '/')}">
  <label>E-mail</label><input name="email" type="email" autocomplete="username" required autofocus>
  <label>Senha</label><input name="senha" type="password" autocomplete="current-password" required>
  <button style="width:100%">Entrar</button></form></div></body></html>`;
}

const ARQUIVOS_DADOS = {
  'Precificacao Nova.xlsx': 'Planilha de custos — Magazine Lufe',
  'Precificacao Comercial Zagodini.xlsx': 'Planilha de custos — Zagodini (apuração Bling)',
  'Precificacao Atelie Com S2 de Mãe.xlsx': 'Planilha de custos — Com Amor de Mãe (apuração Bling)',
  'precificacao_zagodini.xlsx': 'Planilha Zagodini (apuração Amazon por upload)',
  'precificacao_camae.xlsx': 'Planilha Com Amor de Mãe (apuração Amazon por upload)',
  'tokens.json': 'Tokens Mercado Livre (migração)',
  'bling_tokens.json': 'Tokens Bling (migração)',
  'shopee_tokens.json': 'Tokens Shopee (migração)',
  'notificadas.json': 'Perguntas já notificadas no Telegram (migração)',
  'impostos.json': 'Alíquotas Bling (migração)',
  'custo_por_sku.json': 'Custos por SKU Bling (migração)',
  'fixo_por_sku.json': 'Custo fixo por SKU Bling (migração)',
  'tiny_lufe_config.json': 'Config apuração LUFE (migração)',
  'apuracao_cache/tiny_lufe_pedidos.json': 'Pedidos já baixados do Tiny (migração)',
};

function paginaConta(u, msg, hostBase = '') {
  const usuarios = lerUsuarios();
  const quando = f => { try { return new Date(fs.statSync(path.join(DATA, f)).mtimeMs).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return '—'; } };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel — Conta</title><style>${css}</style></head><body>
  <div class="top"><b>⚙️ Conta e configurações</b><span style="flex:1"></span><span style="font-size:13px;opacity:.8">${esc(u.email)}</span><a href="/painel.html">← Voltar ao painel</a><a href="/logout">Sair</a></div>
  <div style="padding:20px 16px">
  ${msg ? `<div class="box" style="padding:0;border:none;background:none"><div class="msg ${msg.tipo}">${esc(msg.texto)}</div></div>` : ''}

  <div class="box"><h2>📤 Enviar planilha ou arquivo de dados</h2>
  <p class="s">Atualize aqui as planilhas de custo. Depois de enviar as planilhas do Bling, clique em <b>Atualizar</b> na aba Apuração para recarregar os custos.</p>
  <form method="post" action="/conta/upload" enctype="multipart/form-data">
    <label>Qual arquivo</label><select name="destino">${Object.entries(ARQUIVOS_DADOS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)} — ${esc(k)} (atual: ${quando(k)})</option>`).join('')}</select>
    <label>Arquivo</label><input type="file" name="arquivo" id="up-arq" required>
    <div id="up-aviso" style="font-size:12px;margin-top:6px;color:#2e7d32"></div>
    <button>Enviar</button></form>
  <script>
  // Seleciona sozinho o destino certo pelo nome do arquivo escolhido
  document.getElementById('up-arq').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const sel = document.querySelector('select[name=destino]'), aviso = document.getElementById('up-aviso');
    const nome = f.name.normalize('NFC').toLowerCase();
    const op = [...sel.options].find(o => o.value.split('/').pop().normalize('NFC').toLowerCase() === nome);
    if (op) { sel.value = op.value; aviso.style.color = '#2e7d32'; aviso.textContent = '✔ Destino ajustado automaticamente: ' + op.value; }
    else { aviso.style.color = '#c62828'; aviso.textContent = 'Nome de arquivo não reconhecido — confira o destino no menu acima.'; }
  });
  </script></div>

  ${u.admin ? `<div class="box"><h2>👥 Usuários</h2><p class="s">Todos os usuários têm acesso completo ao painel.</p>
  <table><tr><th>Nome</th><th>E-mail</th><th></th></tr>${usuarios.map(x => `<tr><td>${esc(x.nome)}${x.admin ? ' <small style="color:#999">(admin)</small>' : ''}</td><td>${esc(x.email)}</td><td style="text-align:right">${x.email === u.email ? '' : `<form method="post" action="/conta/remover" style="margin:0" onsubmit="return confirm('Remover ${esc(x.email)}?')"><input type="hidden" name="email" value="${esc(x.email)}"><button class="del">Remover</button></form>`}</td></tr>`).join('')}</table>
  <form method="post" action="/conta/usuarios" style="margin-top:12px"><div class="row">
    <div><label>Nome</label><input name="nome" required></div><div><label>E-mail</label><input name="email" type="email" required></div><div><label>Senha inicial</label><input name="senha" type="text" minlength="8" required></div></div>
    <button>Adicionar usuário</button></form></div>` : ''}

  ${u.admin ? `<div class="box"><h2>📺 Painel da TV</h2><p class="s">Abra este link uma vez no navegador da TV — ela fica com acesso só à tela de expedição, sem precisar de senha. Não compartilhe fora da empresa.</p>
  <input readonly value="${esc(hostBase)}/tv?chave=${esc(chaveTv())}" onclick="this.select()" style="font-family:monospace;font-size:13px">
  <div style="display:flex;gap:10px;flex-wrap:wrap"><a href="/tv/config"><button type="button">Configurar situações</button></a>
  <form method="post" action="/conta/tv-nova-chave" style="margin:0" onsubmit="return confirm('Gerar nova chave? A TV atual vai perder o acesso até abrir o link novo.')"><button style="background:#c62828">Gerar nova chave</button></form></div></div>` : ''}

  <div class="box"><h2>🧾 Impostos e embalagem</h2><p class="s">Usados no lucro do "preço para ganhar" do catálogo e nas apurações. A embalagem é o custo por pedido (caixa, fita, etiqueta).</p>
  <form method="post" action="/conta/empresas"><table><tr><th>Empresa</th><th>Imposto (%)</th><th>Embalagem por pedido (R$)</th></tr>
  ${require('./config_empresas').get().map(e => `<tr><td>${esc(e.nome)}</td>
    <td><input name="imp_${e.id}" type="number" step="0.01" min="0" max="99" value="${+(e.imposto * 100).toFixed(2)}" ${u.admin ? '' : 'disabled'} style="max-width:110px"></td>
    <td><input name="emb_${e.id}" type="number" step="0.01" min="0" value="${(+e.embalagem).toFixed(2)}" ${u.admin ? '' : 'disabled'} style="max-width:130px"></td></tr>`).join('')}
  </table>${u.admin ? '<button>Salvar impostos e embalagem</button>' : '<p class="s">Só o administrador altera.</p>'}</form></div>

  <div class="box"><h2>🔑 Trocar minha senha</h2><form method="post" action="/conta/senha"><div class="row">
    <div><label>Senha atual</label><input name="atual" type="password" required></div><div><label>Nova senha</label><input name="nova" type="password" minlength="8" required></div><div><label>Repita a nova</label><input name="nova2" type="password" minlength="8" required></div></div>
    <button>Trocar senha</button></form></div>
  </div></body></html>`;
}

// ─── Montagem ──────────────────────────────────────────────────────────────
function montar(app) {
  bootstrap();
  app.set('trust proxy', 1); // Railway fica atrás de proxy HTTPS
  const form = express.urlencoded({ extended: false });

  app.get('/login', (req, res) => { if (!ativo()) return res.redirect('/'); res.send(paginaLogin(null, req.query.next)); });
  app.post('/login', form, (req, res) => {
    const ip = req.ip;
    if (bloqueado(ip)) return res.status(429).send(paginaLogin('Muitas tentativas. Aguarde 15 minutos.'));
    const u = lerUsuarios().find(x => x.email === normEmail(req.body.email));
    if (!u || !confere(u, req.body.senha || '')) { falhou(ip); return res.status(401).send(paginaLogin('E-mail ou senha incorretos.', req.body.next)); }
    tentativas.delete(ip);
    setCookie(req, res, criarCookie(u.email), DIAS_SESSAO * 86400);
    const next = String(req.body.next || '/');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  });
  app.get('/logout', (req, res) => { setCookie(req, res, '', 0); res.redirect('/login'); });

  // Tudo abaixo exige login (se o login estiver ativo)
  app.use((req, res, next) => {
    if (!ativo()) { req.usuario = null; return next(); }
    const u = lerCookie(req);
    if (u) { req.usuario = u; return next(); }
    if (acessoTv(req, res)) { req.usuario = null; return next(); }
    const querHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (querHtml) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    res.status(401).json({ ok: false, erro: 'Sessão expirada — faça login novamente', login: '/login' });
  });

  app.get('/conta/eu', (req, res) => res.json(req.usuario ? { ativo: true, email: req.usuario.email, nome: req.usuario.nome, admin: !!req.usuario.admin } : { ativo: false }));
  const exigeLogin = (req, res, next) => req.usuario ? next() : res.redirect('/');
  app.get('/conta', exigeLogin, (req, res) => res.send(paginaConta(req.usuario, req.query.ok ? { tipo: 'ok', texto: req.query.ok } : req.query.erro ? { tipo: 'err', texto: req.query.erro } : null, `${req.protocol}://${req.get('host')}`)));
  const volta = (res, tipo, texto) => res.redirect('/conta?' + tipo + '=' + encodeURIComponent(texto));

  app.post('/conta/usuarios', exigeLogin, form, (req, res) => {
    if (!req.usuario.admin) return volta(res, 'erro', 'Só o administrador pode adicionar usuários.');
    const email = normEmail(req.body.email), senha = req.body.senha || '';
    if (!email || senha.length < 8) return volta(res, 'erro', 'Informe e-mail e senha com pelo menos 8 caracteres.');
    const u = lerUsuarios();
    if (u.find(x => x.email === email)) return volta(res, 'erro', 'Esse e-mail já está cadastrado.');
    u.push({ email, nome: String(req.body.nome || email).slice(0, 80), admin: false, criadoEm: new Date().toISOString(), ...hash(senha) });
    salvarUsuarios(u); volta(res, 'ok', `Usuário ${email} adicionado. Passe a senha inicial para ele trocar no primeiro acesso.`);
  });
  app.post('/conta/remover', exigeLogin, form, (req, res) => {
    if (!req.usuario.admin) return volta(res, 'erro', 'Só o administrador pode remover usuários.');
    const email = normEmail(req.body.email);
    if (email === req.usuario.email) return volta(res, 'erro', 'Você não pode remover a si mesmo.');
    salvarUsuarios(lerUsuarios().filter(x => x.email !== email)); volta(res, 'ok', `Usuário ${email} removido.`);
  });
  app.post('/conta/empresas', exigeLogin, form, (req, res) => {
    if (!req.usuario.admin) return volta(res, 'erro', 'Só o administrador altera impostos e embalagem.');
    const n = v => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(x) ? null : x; };
    const novo = {};
    for (const e of require('./config_empresas').EMPRESAS) {
      const imp = n(req.body['imp_' + e.id]), emb = n(req.body['emb_' + e.id]);
      novo[e.id] = { imposto: imp == null ? null : imp / 100, embalagem: emb };
    }
    require('./config_empresas').set(novo);
    volta(res, 'ok', 'Impostos e embalagem salvos. O lucro do catálogo usa os novos valores na próxima atualização das contas.');
  });
  app.post('/conta/tv-nova-chave', exigeLogin, (req, res) => {
    if (!req.usuario.admin) return volta(res, 'erro', 'Só o administrador.');
    chaveTv(true); volta(res, 'ok', 'Nova chave da TV gerada. Abra o link novo na TV.');
  });
  app.post('/conta/senha', exigeLogin, form, (req, res) => {
    const { atual, nova, nova2 } = req.body;
    if (!confere(req.usuario, atual || '')) return volta(res, 'erro', 'Senha atual incorreta.');
    if (!nova || nova.length < 8 || nova !== nova2) return volta(res, 'erro', 'A nova senha precisa ter 8+ caracteres e ser igual nos dois campos.');
    const u = lerUsuarios(); const me = u.find(x => x.email === req.usuario.email); Object.assign(me, hash(nova)); salvarUsuarios(u);
    volta(res, 'ok', 'Senha alterada.');
  });

  const multer = require('multer');
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
  app.post('/conta/upload', exigeLogin, up.single('arquivo'), (req, res) => {
    let destino = req.body.destino;
    if (!ARQUIVOS_DADOS[destino]) return volta(res, 'erro', 'Destino inválido.');
    if (!req.file) return volta(res, 'erro', 'Escolha um arquivo.');
    // nome do arquivo enviado (multer entrega em latin1) — se bater com um destino conhecido, usa ele
    const nomeEnviado = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8').normalize('NFC').toLowerCase();
    const peloNome = Object.keys(ARQUIVOS_DADOS).find(k => k.split('/').pop().normalize('NFC').toLowerCase() === nomeEnviado);
    if (peloNome && peloNome !== destino) destino = peloNome;
    const ehXlsx = destino.endsWith('.xlsx'), buf = req.file.buffer;
    if (ehXlsx && !(buf[0] === 0x50 && buf[1] === 0x4b)) return volta(res, 'erro', 'O arquivo não parece ser um .xlsx.');
    if (!ehXlsx) { try { JSON.parse(buf.toString('utf8')); } catch (e) { return volta(res, 'erro', 'O arquivo não é um JSON válido.'); } }
    const alvo = path.join(DATA, destino);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    try { if (fs.existsSync(alvo)) fs.copyFileSync(alvo, alvo + '.anterior'); } catch (e) {}
    fs.writeFileSync(alvo, buf);
    console.log(`[conta/upload] ${req.usuario.email} enviou ${destino} (${buf.length} bytes)`);
    volta(res, 'ok', `${destino} atualizado.` + (destino.includes('Zagodini') || destino.includes('Atelie') ? ' Agora clique em "Atualizar" na aba Apuração para recarregar os custos do Bling.' : ''));
  });
}

module.exports = { montar, ativo };
