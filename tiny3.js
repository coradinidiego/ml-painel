/**
 * Tiny (Olist ERP) API v3 — histórico de custos dos produtos da Lufe, com data.
 * A API v2 (token) só tem o custo atual; a v3 (OAuth) devolve em GET /produtos/{id} o array
 * "custos" (histórico dos últimos custos: data, precoCusto, custoMedio...).
 *
 * Variáveis do Railway: TINY3_CLIENT_ID, TINY3_CLIENT_SECRET
 * URL de redirecionamento do app no Tiny: https://zagodini-gestao.up.railway.app/tiny3/callback
 *
 *  GET  /tiny3/login      autoriza (abre o login do Tiny)
 *  GET  /tiny3/callback   recebe o código e guarda os tokens
 *  GET  /tiny3/status     situação da conexão e da última importação
 *  POST /tiny3/importar   importa o histórico de custos (roda sozinho 1x por dia)
 *  GET  /tiny3/produto?sku=FOTM0045   histórico de um produto (conferência)
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');

const AUTH = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect';
const API = 'https://api.tiny.com.br/public-api/v3';
const REDIRECT = process.env.TINY3_REDIRECT || 'https://zagodini-gestao.up.railway.app/tiny3/callback';
const ARQ_TOK = path.join(DATA, 'tiny3_tokens.json');
const ARQ_ST = path.join(DATA, 'apuracao_cache', 'tiny3_status.json');
const IDX = 2;   // Lufe
const env = k => String(process.env[k] || '').trim().replace(/^["']|["']$/g, '');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
let ST = ler(ARQ_ST, {});

async function token(grant) {
  const body = new URLSearchParams({ client_id: env('TINY3_CLIENT_ID'), client_secret: env('TINY3_CLIENT_SECRET'), ...grant });
  const { data } = await axios.post(AUTH + '/token', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
  const t = { access_token: data.access_token, refresh_token: data.refresh_token, expira: Date.now() + (data.expires_in || 14400) * 1000, refreshExpira: Date.now() + (data.refresh_expires_in || 86400) * 1000, em: new Date().toISOString() };
  gravar(ARQ_TOK, t);
  return t;
}
async function accessToken() {
  let t = ler(ARQ_TOK, null);
  if (!t?.refresh_token) throw new Error('Tiny v3 não autorizado — abra /tiny3/login');
  if (Date.now() > t.expira - 10 * 60e3) t = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return t.access_token;
}
async function get(p, params) {
  for (let i = 0; i < 5; i++) {
    try {
      return (await axios.get(API + p, { params, headers: { Authorization: 'Bearer ' + await accessToken() }, timeout: 30000 })).data;
    } catch (e) {
      const s = e.response?.status;
      if (s === 429 || s >= 500) { await delay(3000 * (i + 1)); continue; }
      if (s === 401 && i === 0) { const t = ler(ARQ_TOK, {}); t.expira = 0; gravar(ARQ_TOK, t); continue; }
      throw new Error(`Tiny v3 ${p}: ${s || ''} ${JSON.stringify(e.response?.data || e.message).slice(0, 200)}`);
    }
  }
  throw new Error('Tiny v3: limite de requisições');
}

// data do Tiny ("2026-10-20", "2026-10-20 10:00:00" ou "20/10/2026") → AAAA-MM-DD
const dia = s => { s = String(s || ''); const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10); };
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const K = s => String(s || '').trim().toUpperCase();

/** Histórico de custo do produto: [[AAAA-MM-DD, custo], ...] em ordem de data (custo de compra; médio se não houver) */
function historicoProduto(prod) {
  const L = (prod?.custos || []).map(c => [dia(c.data), num(c.precoCusto) > 0 ? num(c.precoCusto) : num(c.custoMedio)]).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x[0]) && x[1] > 0);
  L.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const out = []; for (const x of L) { const u = out[out.length - 1]; if (u && u[0] === x[0]) u[1] = x[1]; else if (!u || Math.abs(u[1] - x[1]) >= 0.005) out.push(x); }
  return out;
}

let rodando = false;
async function importar() {
  if (rodando) return; rodando = true;
  ST = { ...ST, rodando: true, inicio: new Date().toISOString(), erro: null, feitos: 0 };
  try {
    // ids dos produtos pela API v2 (mesmo id na v3)
    const tiny = require('./tiny'), prods = [];
    for (let pagina = 1, total = 1; pagina <= total && pagina <= 60; pagina++) {
      const ret = await tiny.chamar('produtos.pesquisa.php', { pesquisa: '', pagina });
      if (ret.vazio) break; total = parseInt(ret.numero_paginas || 1);
      for (const x of ret.produtos || []) if (x.produto?.id) prods.push({ id: x.produto.id, codigo: x.produto.codigo, gtin: x.produto.gtin });
      await delay(1100);
    }
    ST.total = prods.length;
    const cm = require('./custos_ml'), H = cm.historico(IDX);
    let comHist = 0;
    for (const p of prods) {
      try {
        const d = await get('/produtos/' + p.id);
        const L = historicoProduto(d);
        if (L.length) {
          comHist++;
          for (const k of [K(p.codigo), K(p.gtin)].filter(Boolean)) {
            // histórico do Tiny + anotações do painel posteriores à última data do Tiny
            const ult = L[L.length - 1][0];
            H[k] = [...L, ...(H[k] || []).filter(x => x[0] > ult)];
          }
        }
      } catch (e) { ST.ultimoErro = `${p.codigo}: ${e.message}`; if (/não autorizado/.test(e.message)) throw e; }
      ST.feitos++;
      if (ST.feitos % 25 === 0) { cm.salvarHistorico(IDX); gravar(ARQ_ST, ST); }
      await delay(700);
    }
    cm.salvarHistorico(IDX);
    Object.assign(ST, { comHistorico: comHist, fim: new Date().toISOString(), ok: new Date().toISOString() });
  } catch (e) { ST.erro = e.message; }
  ST.rodando = false; rodando = false; gravar(ARQ_ST, ST);
  console.log('[tiny3]', JSON.stringify(ST));
}

module.exports = function (app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/tiny3/login', (req, res) => {
    if (!admin(req, res)) return;
    if (!env('TINY3_CLIENT_ID')) return res.status(400).send('Falta a variável TINY3_CLIENT_ID no Railway.');
    res.redirect(`${AUTH}/auth?` + new URLSearchParams({ client_id: env('TINY3_CLIENT_ID'), redirect_uri: REDIRECT, scope: 'openid', response_type: 'code' }));
  });
  app.get('/tiny3/callback', async (req, res) => {
    if (!req.query.code) return res.status(400).send('Sem código de autorização: ' + (req.query.error_description || req.query.error || ''));
    try {
      await token({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: REDIRECT });
      importar().catch(() => {});
      res.send('<h2>Tiny v3 conectado ✅</h2><p>O painel está importando o histórico de custos da Lufe (alguns minutos). Pode fechar esta aba.</p>');
    } catch (e) { res.status(500).send('Erro ao autorizar o Tiny v3: ' + JSON.stringify(e.response?.data || e.message)); }
  });
  app.get('/tiny3/status', (req, res) => {
    const t = ler(ARQ_TOK, null);
    res.json({ configurado: !!env('TINY3_CLIENT_ID') && !!env('TINY3_CLIENT_SECRET'), redirect: REDIRECT, autorizado: !!t?.refresh_token, tokenEm: t?.em || null, refreshExpira: t?.refreshExpira ? new Date(t.refreshExpira).toISOString() : null, importacao: ST });
  });
  app.post('/tiny3/importar', (req, res) => { if (!admin(req, res)) return; importar().catch(() => {}); res.json({ ok: true }); });
  app.get('/tiny3/produto', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const r = await require('./tiny').chamar('produtos.pesquisa.php', { pesquisa: String(req.query.sku || '') });
      const p = (r.produtos || []).map(x => x.produto).find(x => K(x.codigo) === K(req.query.sku)) || r.produtos?.[0]?.produto;
      if (!p) return res.status(404).json({ erro: 'produto não encontrado' });
      const d = await get('/produtos/' + p.id);
      res.json({ id: p.id, codigo: p.codigo, custosTiny: d.custos || [], historico: historicoProduto(d), noPainel: require('./custos_ml').historico(IDX)[K(p.codigo)] || null });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  // mantém o token vivo (refresh vale 1 dia) e importa 1x por dia de madrugada
  setInterval(async () => {
    const t = ler(ARQ_TOK, null); if (!t?.refresh_token) return;
    try { if (Date.now() > t.expira - 30 * 60e3) await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token }); } catch (e) { ST.erro = 'renovar token: ' + (e.response?.data?.error_description || e.message); gravar(ARQ_ST, ST); }
    const h = new Date(Date.now() - 3 * 3600e3);
    if (h.getUTCHours() === 2 && (!ST.ok || ST.ok.slice(0, 10) !== new Date().toISOString().slice(0, 10))) importar().catch(() => {});
  }, 20 * 60e3).unref?.();
};
