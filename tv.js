/**
 * Painel da TV — pacotes a empacotar x empacotados (envios de hoje), por empresa e canal.
 *  - Zagodini (Bling idx 0) e Com Amor de Mãe (Bling idx 1): /pedidos/vendas por situação
 *  - Magazine Lufe: Tiny (pedidos.pesquisa por situação + canal via pedido.obter, com cache)
 *  - Quais situações contam como "a empacotar", "empacotado" e "enviado" é configurado em /tv/config
 *
 *  /tv            tela cheia para a TV (acesso por login OU pelo link com chave)
 *  /tv/dados      JSON agregado (atualizado em segundo plano a cada ~90s enquanto a TV estiver aberta)
 *  /tv/config     mapeamento de situações (admin)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const bling = require('./bling');
const tiny = require('./tiny');
const mlEnvios = require('./ml_envios');

const ARQ_CFG = path.join(DATA, 'tv_config.json');
const ARQ_CANAL_TINY = path.join(DATA, 'apuracao_cache', 'tv_tiny_canal.json');
const INTERVALO = 90 * 1000;
const delay = ms => new Promise(r => setTimeout(r, ms));

const EMPRESAS = [
  { id: 'lufe',     nome: 'Magazine Lufe',    logo: 'lufe',     erp: 'tiny',  ml: 'Lufe',  canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein'] },
  { id: 'zagodini', nome: 'Zagodini',         logo: 'zagodini', erp: 'bling', idx: 0, ml: 'Zagodini', canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein'] },
  { id: 'mae',      nome: 'Com Amor de Mãe',  logo: 'mae',      erp: 'bling', idx: 1, ml: 'Mae', canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein', 'TikTok'] },
];
const TINY_SITUACOES = ['Em aberto', 'Aprovado', 'Preparando envio', 'Faturado', 'Pronto para envio', 'Enviado', 'Entregue', 'Não Entregue', 'Cancelado', 'Dados incompletos'];

// ─── Config ────────────────────────────────────────────────────────────────
function cfgPadrao() {
  return {
    tiny: { aEmpacotar: ['Em aberto', 'Aprovado', 'Preparando envio', 'Faturado'], empacotado: ['Pronto para envio'], enviado: ['Enviado'] },
    bling: { 0: { aEmpacotar: [6, 15], empacotado: [], enviado: [9] }, 1: { aEmpacotar: [6, 15], empacotado: [], enviado: [9] } },
    configurado: false,
  };
}
function getCfg() { try { return { ...cfgPadrao(), ...JSON.parse(fs.readFileSync(ARQ_CFG)) }; } catch (e) { return cfgPadrao(); } }
function salvarCfg(c) { fs.writeFileSync(ARQ_CFG, JSON.stringify(c, null, 2)); }

// ─── Utilidades ────────────────────────────────────────────────────────────
function canalDe(nome) {
  const s = String(nome || '').toLowerCase();
  if (/mercado ?livre|mercadolivre|meli|\bml\b/.test(s)) return 'Mercado Livre';
  if (/amazon/.test(s)) return 'Amazon';
  if (/shopee/.test(s)) return 'Shopee';
  if (/shein/.test(s)) return 'Shein';
  if (/tik ?tok/.test(s)) return 'TikTok';
  return 'Outros';
}
const hojeIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
const brToIso = br => /^\d{2}\/\d{2}\/\d{4}$/.test(br || '') ? br.split('/').reverse().join('-') : (br || '').slice(0, 10);
function prazo(dataIso, hoje) {           // classifica pelo prazo de envio
  if (!dataIso || dataIso < '2000-01-01') return 'hoje'; // sem data prevista: considera para hoje
  if (dataIso < hoje) return 'atrasado';
  if (dataIso === hoje) return 'hoje';
  return 'futuro';
}

// ─── Bling ─────────────────────────────────────────────────────────────────
async function blingGet(c, url, params, tent = 5) {
  for (let t = 0; t < tent; t++) {
    try { return (await c.get(url, { params })).data; }
    catch (e) { if (e.response?.status === 429 && t < tent - 1) { await delay(3000 * (t + 1)); continue; } throw e; }
  }
}
async function blingListar(idx, ids, extra = {}) {
  if (!ids.length) return [];
  const c = bling.client(idx), todos = [];
  for (let pagina = 1; pagina <= 30; pagina++) {
    const d = await blingGet(c, '/pedidos/vendas', { limite: 100, pagina, 'idsSituacoes[]': ids, ...extra });
    const items = d?.data || [];
    todos.push(...items);
    if (items.length < 100) break;
    await delay(400);
  }
  return todos;
}
const _canaisBling = {};
async function canaisBling(idx) {
  if (_canaisBling[idx] && Date.now() - _canaisBling[idx].ts < 6 * 3600e3) return _canaisBling[idx].mapa;
  const mapa = await bling.getCanaisVenda(idx).catch(() => ({}));
  _canaisBling[idx] = { ts: Date.now(), mapa };
  return mapa;
}
async function situacoesBling(idx) {
  const c = bling.client(idx);
  const mods = (await blingGet(c, '/situacoes/modulos'))?.data || [];
  const vendas = mods.find(m => /venda/i.test(m.nome || m.descricao || '')) || mods[0];
  if (!vendas) return [];
  const sits = (await blingGet(c, `/situacoes/modulos/${vendas.id}`))?.data || [];
  return sits.map(s => ({ id: s.id, nome: s.nome || s.descricao || String(s.id) }));
}
async function coletarBling(emp, cfg, hoje) {
  const m = cfg.bling[emp.idx] || { aEmpacotar: [], empacotado: [], enviado: [] };
  const canais = await canaisBling(emp.idx);
  const grupos = { aEmpacotar: m.aEmpacotar, empacotado: m.empacotado };
  const linhas = [];
  for (const [tipo, ids] of Object.entries(grupos)) {
    for (const p of await blingListar(emp.idx, ids)) {
      linhas.push({ tipo, canal: canalDe(canais[p.loja?.id] || ''), prazo: prazo((p.dataPrevista || '').slice(0, 10), hoje) });
    }
    await delay(400);
  }
  // enviados hoje: alterados hoje para uma situação de "enviado"
  for (const p of await blingListar(emp.idx, m.enviado, { dataAlteracaoInicial: hoje, dataAlteracaoFinal: hoje })) {
    linhas.push({ tipo: 'enviado', canal: canalDe(canais[p.loja?.id] || ''), prazo: 'hoje' });
  }
  return linhas;
}

// ─── Tiny (Lufe) ───────────────────────────────────────────────────────────
let _canalTiny = null;
function canalTinyCache() { if (!_canalTiny) { try { _canalTiny = JSON.parse(fs.readFileSync(ARQ_CANAL_TINY)); } catch (e) { _canalTiny = {}; } } return _canalTiny; }
async function tinyListar(situacao, extra = {}) {
  const lista = []; let pagina = 1, total = 1;
  do {
    const ret = await tiny.chamar('pedidos.pesquisa.php', { situacao, pagina, ...extra });
    if (ret.vazio) break;
    total = parseInt(ret.numero_paginas || 1);
    for (const x of ret.pedidos || []) lista.push(x.pedido);
    pagina++; await delay(1100);
  } while (pagina <= total && pagina <= 20);
  return lista;
}
async function canalTiny(p) {
  const cache = canalTinyCache();
  if (cache[p.id]) return cache[p.id];
  try {
    const d = (await tiny.chamar('pedido.obter.php', { id: p.id })).pedido;
    cache[p.id] = { canal: canalDe(d?.ecommerce?.nomeEcommerce || ''), prevista: brToIso(d?.data_prevista) };
    fs.mkdirSync(path.dirname(ARQ_CANAL_TINY), { recursive: true });
    fs.writeFileSync(ARQ_CANAL_TINY, JSON.stringify(cache));
    await delay(1100);
    return cache[p.id];
  } catch (e) { return { canal: 'Outros', prevista: '' }; }
}
async function coletarTiny(cfg, hoje) {
  const linhas = [];
  const grupos = { aEmpacotar: cfg.tiny.aEmpacotar, empacotado: cfg.tiny.empacotado };
  for (const [tipo, sits] of Object.entries(grupos)) {
    for (const sit of sits) {
      for (const p of await tinyListar(sit)) {
        const info = await canalTiny(p);
        linhas.push({ tipo, canal: info.canal, prazo: prazo(brToIso(p.data_prevista) || info.prevista, hoje) });
      }
    }
  }
  for (const sit of cfg.tiny.enviado) {
    for (const p of await tinyListar(sit, { dataAtualizacao: hoje.split('-').reverse().join('/') })) {
      const info = await canalTiny(p);
      linhas.push({ tipo: 'enviado', canal: info.canal, prazo: 'hoje' });
    }
  }
  return linhas;
}

// ─── Agregação + laço em segundo plano ─────────────────────────────────────
let ESTADO = { atualizadoEm: null, empresas: [], erros: {} };
let ultimoPedido = 0, rodando = false;
const ULTIMAS = {}; // último dado bom por empresa/fonte

function agregar(emp, linhas) {
  const canais = {};
  for (const c of emp.canais) canais[c] = { canal: c, aEmpacotar: 0, atrasados: 0, futuros: 0, empacotados: 0, enviados: 0 };
  for (const l of linhas) {
    const c = canais[l.canal] ||= { canal: l.canal, aEmpacotar: 0, atrasados: 0, futuros: 0, empacotados: 0, enviados: 0 };
    if (l.tipo === 'aEmpacotar') { if (l.prazo === 'futuro') c.futuros++; else { c.aEmpacotar++; if (l.prazo === 'atrasado') c.atrasados++; } }
    else if (l.tipo === 'empacotado') c.empacotados++;
    else if (l.tipo === 'enviado') c.enviados++;
  }
  const lista = Object.values(canais).filter(c => emp.canais.includes(c.canal) || c.aEmpacotar + c.empacotados + c.enviados + c.futuros > 0);
  const tot = lista.reduce((t, c) => { for (const k of ['aEmpacotar', 'atrasados', 'futuros', 'empacotados', 'enviados']) t[k] += c[k]; return t; }, { aEmpacotar: 0, atrasados: 0, futuros: 0, empacotados: 0, enviados: 0 });
  return { id: emp.id, nome: emp.nome, logo: emp.logo, canais: lista, total: tot };
}

async function atualizar() {
  if (rodando) return; rodando = true;
  const cfg = getCfg(), hoje = hojeIso(), empresas = [], erros = {};
  for (const emp of EMPRESAS) {
    // Mercado Livre direto da API do ML; demais canais pelo ERP (sem o ML, para não contar duas vezes)
    const anterior = ULTIMAS[emp.id] || { ml: [], erp: [] };
    let ml = anterior.ml, erp = anterior.erp, desatualizado = false;
    try { ml = await mlEnvios.coletar(emp.ml, prazo); }
    catch (e) { desatualizado = true; erros[emp.id + ' ML'] = e.response?.status === 401 ? 'token do ML expirado' : (e.message || 'erro'); console.warn('[tv] ML', emp.id, e.message); }
    try {
      const linhas = emp.erp === 'tiny' ? await coletarTiny(cfg, hoje) : await coletarBling(emp, cfg, hoje);
      erp = linhas.filter(l => l.canal !== 'Mercado Livre');
    } catch (e) {
      desatualizado = true;
      erros[emp.id + ' ' + emp.erp] = e.response?.status === 401 ? 'ERP não autorizado' : (e.message || 'erro');
      console.warn('[tv]', emp.id, e.message);
    }
    ULTIMAS[emp.id] = { ml, erp };
    empresas.push({ ...agregar(emp, [...ml, ...erp]), desatualizado });
    if (!ESTADO.atualizadoEm) { // primeira carga: mostra cada empresa assim que fica pronta
      const vazias = EMPRESAS.filter(e => !empresas.find(x => x.id === e.id)).map(e => ({ ...agregar(e, []), carregando: true }));
      ESTADO = { ...ESTADO, parcial: true, empresas: [...empresas, ...vazias], hoje };
    }
  }
  ESTADO = { atualizadoEm: new Date().toISOString(), hoje, empresas, erros, configurado: !!cfg.configurado, parcial: false };
  rodando = false;
}
setInterval(() => { if (Date.now() - ultimoPedido < 10 * 60e3) atualizar().catch(e => { rodando = false; console.warn('[tv]', e.message); }); }, INTERVALO);

// ─── Rotas ─────────────────────────────────────────────────────────────────
const router = express.Router();
router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'tv.html')));
router.get('/dados', async (req, res) => {
  ultimoPedido = Date.now();
  if (!ESTADO.atualizadoEm && !rodando) atualizar().catch(() => { rodando = false; }); // primeira carga em segundo plano
  res.json({ ...ESTADO, atualizadoEm: ESTADO.atualizadoEm || new Date().toISOString(), carregando: !ESTADO.atualizadoEm && !ESTADO.parcial });
});

router.get('/diagnostico', (req, res) => {
  if (!req.usuario?.admin && require('./auth').ativo()) return res.status(403).send('Só o administrador.');
  const nomes = { Lufe: 'Magazine Lufe', Zagodini: 'Zagodini', Mae: 'Com Amor de Mãe' };
  const rot = { aEmpacotar: 'A empacotar', empacotado: 'Empacotado', enviado: 'Enviado hoje', ignorado: 'Não conta' };
  const blocos = Object.entries(nomes).map(([c, n]) => {
    const d = mlEnvios.diagnostico(c);
    const linhas = Object.entries(d.porStatus).sort((a, b) => b[1].qtd - a[1].qtd)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${v.qtd}</td><td>${rot[v.tvConta]}</td></tr>`).join('') || '<tr><td colspan=3>Sem dados ainda — abra a TV e aguarde 1–2 min.</td></tr>';
    return `<h2>${esc(n)}</h2><table><tr><th>status / substatus no ML</th><th>pacotes</th><th>na TV conta como</th></tr>${linhas}</table>
      <p style="color:#777;font-size:12px">Tipos de logística: ${esc(Object.entries(d.logistica).map(([k, v]) => k + ': ' + v).join(' · ') || '—')} (fulfillment = Full, não entra na TV)</p>`;
  }).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Diagnóstico ML</title><style>body{font-family:-apple-system,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1a1a2e}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:7px;border-bottom:1px solid #eee;text-align:left}h2{margin-top:28px;font-size:17px}</style>
  <h1 style="font-size:20px">📦 Pacotes do Mercado Livre por situação</h1><p style="color:#666">Pedidos pagos dos últimos 12 dias ainda não finalizados. Compare com <i>Vendas → Envios</i> no ML.</p>${blocos}`);
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
router.get('/config', async (req, res) => {
  if (!req.usuario?.admin && require('./auth').ativo()) return res.status(403).send('Só o administrador configura a TV.');
  const cfg = getCfg();
  const sel = (nome, valorAtual) => ['aEmpacotar', 'empacotado', 'enviado', 'ignorar'].map(v =>
    `<label style="margin-right:10px"><input type="radio" name="${esc(nome)}" value="${v}" ${valorAtual === v ? 'checked' : ''}> ${{ aEmpacotar: 'A empacotar', empacotado: 'Empacotado', enviado: 'Enviado', ignorar: 'Ignorar' }[v]}</label>`).join('');
  const papelTiny = s => cfg.tiny.aEmpacotar.includes(s) ? 'aEmpacotar' : cfg.tiny.empacotado.includes(s) ? 'empacotado' : cfg.tiny.enviado.includes(s) ? 'enviado' : 'ignorar';
  let blocos = `<div class="box"><h2>Magazine Lufe — Tiny</h2><table>${TINY_SITUACOES.map(s => `<tr><td>${esc(s)}</td><td>${sel('tiny|' + s, papelTiny(s))}</td></tr>`).join('')}</table></div>`;
  for (const emp of EMPRESAS.filter(e => e.erp === 'bling')) {
    const m = cfg.bling[emp.idx] || { aEmpacotar: [], empacotado: [], enviado: [] };
    const papel = id => m.aEmpacotar.includes(id) ? 'aEmpacotar' : m.empacotado.includes(id) ? 'empacotado' : m.enviado.includes(id) ? 'enviado' : 'ignorar';
    let sits; try { sits = await situacoesBling(emp.idx); } catch (e) { sits = null; }
    blocos += `<div class="box"><h2>${esc(emp.nome)} — Bling</h2>` + (sits?.length
      ? `<table>${sits.map(s => `<tr><td>${esc(s.nome)} <small style="color:#999">#${s.id}</small></td><td>${sel('bling|' + emp.idx + '|' + s.id, papel(s.id))}</td></tr>`).join('')}</table>`
      : `<p style="color:#c62828">Não consegui ler as situações do Bling desta conta (autorize o Bling no painel e recarregue).</p>`) + `</div>`;
  }
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configurar TV</title>
  <style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;gap:14px;align-items:center}.top a{color:#ffd60a;text-decoration:none;font-size:13px}
  .box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:18px 22px;margin:16px auto;max-width:900px}h2{font-size:15px;margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:13px}td{padding:7px 6px;border-bottom:1px solid #f2f2f2}
  button{padding:11px 22px;border:none;border-radius:8px;background:#0d1b2a;color:#fff;font-weight:600;font-size:14px;cursor:pointer}p.s{color:#666;font-size:13px}</style></head><body>
  <div class="top"><b>📺 Configurar painel da TV</b><span style="flex:1"></span><a href="/tv" target="_blank">Abrir TV</a><a href="/conta">⚙️ Conta</a><a href="/painel.html">Painel</a></div>
  <form method="post" action="/tv/config"><div class="box"><p class="s">Para cada situação do pedido, diga o que ela significa na expedição. A TV conta como <b>A empacotar</b> e <b>Empacotado</b> os pedidos que estão hoje nessas situações, e como <b>Enviado</b> os que mudaram para essa situação hoje.</p></div>
  ${blocos}<div class="box" style="text-align:right"><button>Salvar</button></div></form></body></html>`);
});
router.post('/config', express.urlencoded({ extended: false }), (req, res) => {
  if (!req.usuario?.admin && require('./auth').ativo()) return res.status(403).send('Só o administrador configura a TV.');
  const cfg = getCfg();
  cfg.tiny = { aEmpacotar: [], empacotado: [], enviado: [] };
  const blingNovo = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (!['aEmpacotar', 'empacotado', 'enviado'].includes(v)) continue;
    const [erp, a, b] = k.split('|');
    if (erp === 'tiny' && TINY_SITUACOES.includes(a)) cfg.tiny[v].push(a);
    if (erp === 'bling') { const idx = parseInt(a), id = parseInt(b); (blingNovo[idx] ||= { aEmpacotar: [], empacotado: [], enviado: [] })[v].push(id); }
  }
  for (const idx of Object.keys(blingNovo)) cfg.bling[idx] = blingNovo[idx];
  cfg.configurado = true;
  salvarCfg(cfg);
  ESTADO.atualizadoEm = null; // força nova leitura
  res.redirect('/tv/config?ok=1');
});

module.exports = { router, canalDe, agregar, prazo };
