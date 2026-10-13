/**
 * Painel da TV — pedidos do dia por empresa, no fluxo da expedição:
 *     Emitir NF  →  A empacotar  →  Empacotados      (+ enviados hoje e próximos dias)
 *
 *  - Mercado Livre: direto da API do ML (ml_envios.js), por pacote.
 *  - Demais canais: ERP — Bling (Zagodini idx 0, Com Amor de Mãe idx 1) e Tiny (Magazine Lufe),
 *    por situação do pedido (mapeada em /tv/config). Só pedidos dos últimos 15 dias.
 *
 *  /tv               tela da TV (login OU link com chave)
 *  /tv/dados         JSON agregado (atualiza em segundo plano a cada ~90s enquanto a TV estiver aberta)
 *  /tv/config        mapeamento de situações (admin)
 *  /tv/diagnostico   pacotes do ML por status/substatus (admin)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');
const bling = require('./bling');
const tiny = require('./tiny');
const mlEnvios = require('./ml_envios');
const amazon = require('./amazon');

const ARQ_CFG = path.join(DATA, 'tv_config.json');
const ARQ_CANAL_TINY = path.join(DATA, 'apuracao_cache', 'tv_tiny_canal.json');
const ARQ_PED_TINY = path.join(DATA, 'apuracao_cache', 'tiny_lufe_pedidos.json');
const INTERVALO = 90 * 1000;
const JANELA_DIAS = 15;
const delay = ms => new Promise(r => setTimeout(r, ms));

const EMPRESAS = [
  { id: 'lufe',     nome: 'Magazine Lufe',   logo: 'lufe',     erp: 'tiny',          ml: 'Lufe', amazon: 'lufe',     canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein'] },
  { id: 'zagodini', nome: 'Zagodini',        logo: 'zagodini', erp: 'bling', idx: 0, ml: 'Zagodini', amazon: 'zagodini', canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein'] },
  { id: 'mae',      nome: 'Com Amor de Mãe', logo: 'mae',      erp: 'bling', idx: 1, ml: 'Mae', amazon: 'mae',      canais: ['Mercado Livre', 'Amazon', 'Shopee', 'Shein', 'TikTok'] },
];
const MARKETPLACES = ['Mercado Livre', 'Amazon', 'Shopee', 'Shein', 'TikTok'];
const ETAPAS = ['emitirNF', 'aEmpacotar', 'empacotado', 'enviado'];
const ROTULO = { emitirNF: 'Emitir NF', aEmpacotar: 'A empacotar', empacotado: 'Empacotado', enviado: 'Enviado', ignorar: 'Ignorar' };
const TINY_SITUACOES = ['Em aberto', 'Aprovado', 'Preparando envio', 'Faturado', 'Pronto para envio', 'Enviado', 'Entregue', 'Não Entregue', 'Cancelado', 'Dados incompletos'];

// ─── Config ────────────────────────────────────────────────────────────────
const vazio = () => ({ emitirNF: [], aEmpacotar: [], empacotado: [], enviado: [] });
function cfgPadrao() {
  return {
    versao: 2,
    tiny: { emitirNF: ['Em aberto', 'Aprovado', 'Preparando envio'], aEmpacotar: ['Faturado'], empacotado: ['Pronto para envio'], enviado: ['Enviado'] },
    bling: { 0: { ...vazio(), emitirNF: [6], aEmpacotar: [15], enviado: [9] }, 1: { ...vazio(), emitirNF: [6], aEmpacotar: [15], enviado: [9] } },
    configurado: false,
  };
}
function getCfg() {
  let c; try { c = JSON.parse(fs.readFileSync(ARQ_CFG)); } catch (e) { return cfgPadrao(); }
  if (c.versao !== 2) { // config antiga (sem "Emitir NF"): Tiny volta ao padrão novo, Bling ganha a etapa vazia
    const p = cfgPadrao();
    c = { ...p, bling: Object.fromEntries(Object.entries(c.bling || p.bling).map(([k, v]) => [k, { ...vazio(), ...v }])), configurado: false };
  }
  return c;
}
function salvarCfg(c) { fs.writeFileSync(ARQ_CFG, JSON.stringify({ ...c, versao: 2 }, null, 2)); }

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
const hojeIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const isoMenosDias = (iso, d) => new Date(new Date(iso + 'T12:00:00Z').getTime() - d * 864e5).toISOString().slice(0, 10);
const isoToBr = iso => iso.split('-').reverse().join('/');
const brToIso = br => /^\d{2}\/\d{2}\/\d{4}$/.test(br || '') ? br.split('/').reverse().join('-') : (br || '').slice(0, 10);
function prazo(dataIso, hoje) {
  if (!dataIso || dataIso < '2000-01-01') return 'hoje';
  if (dataIso < hoje) return 'atrasado';
  if (dataIso === hoje) return 'hoje';
  return 'futuro';
}

// ─── Bling ─────────────────────────────────────────────────────────────────
function qs(params) { // Bling exige idsSituacoes[]=6&idsSituacoes[]=15 (axios serializaria errado)
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) (Array.isArray(v) ? v : [v]).forEach(x => u.append(k, x));
  return u.toString();
}
async function blingGet(c, url, params, tent = 5) {
  for (let t = 0; t < tent; t++) {
    try { return (await c.get(url + (params ? '?' + qs(params) : ''), { timeout: 30000 })).data; }
    catch (e) { if (e.response?.status === 429 && t < tent - 1) { await delay(3000 * (t + 1)); continue; } throw e; }
  }
}
async function blingListar(idx, ids, extra = {}) {
  if (!ids?.length) return [];
  const c = bling.client(idx), todos = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
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
function canalBling(canais, p) { // Bling não devolve o nome das lojas: usa o número do pedido no marketplace
  const porLoja = canalDe(canais[p.loja?.id] || '');
  return porLoja !== 'Outros' ? porLoja : (canalPeloNumero(p.numeroLoja) || 'Outros');
}
async function coletarBling(emp, cfg, hoje) {
  const m = { ...vazio(), ...(cfg.bling[emp.idx] || {}) };
  const canais = await canaisBling(emp.idx);
  const janela = { dataInicial: isoMenosDias(hoje, JANELA_DIAS), dataFinal: hoje };
  const linhas = [];
  for (const etapa of ['emitirNF', 'aEmpacotar', 'empacotado']) {
    for (const p of await blingListar(emp.idx, m[etapa], janela)) {
      linhas.push({ tipo: etapa, canal: canalBling(canais, p), prazo: prazo((p.dataPrevista || '').slice(0, 10), hoje), num: String(p.numeroLoja || '') });
    }
    await delay(350);
  }
  for (const p of await blingListar(emp.idx, m.enviado, { dataAlteracaoInicial: hoje, dataAlteracaoFinal: hoje })) {
    linhas.push({ tipo: 'enviado', canal: canalBling(canais, p), prazo: 'hoje' });
  }
  // Shein e Shopee têm fluxo próprio no Bling: Em aberto = sem nota · Atendido = a empacotar · Verificado = empacotado
  let out = linhas;
  for (const canal of Object.keys(FLUXO_VERIFICADO)) {
    try {
      const l = await coletarFluxoBling(emp, canal, canais, hoje, janela);
      if (l) out = [...out.filter(x => x.canal !== canal), ...l];
    } catch (e) { console.warn('[tv]', canal, 'Bling', emp.id, e.message); }
  }
  return out;
}

// canal -> como reconhecer o pedido pelo número no marketplace (para achar a loja no Bling)
const FLUXO_VERIFICADO = { Shein: /^GSH/i, Shopee: /^\d{6}[A-Z0-9]{8}$/i };

const SIT = { emAberto: 6, atendido: 9, verificado: 24 };
const _lojaCanal = {};   // idx|canal -> { ids:Set, ts }
async function lojasCanal(idx, canal, canais, janela) {
  const chave = idx + '|' + canal, c = _lojaCanal[chave];
  if (c && c.ids.size && Date.now() - c.ts < 6 * 3600e3) return c.ids;
  const ids = new Set(), re = new RegExp(canal, 'i');
  for (const [id, nome] of Object.entries(canais)) if (re.test(nome)) ids.add(String(id));
  if (!ids.size) {  // Bling não informou o nome das lojas: descobre pela numeração dos pedidos do canal
    for (const p of await blingListar(idx, [SIT.verificado], janela)) if (FLUXO_VERIFICADO[canal].test(p.numeroLoja || '') && p.loja?.id) ids.add(String(p.loja.id));
  }
  _lojaCanal[chave] = { ids, ts: Date.now() };
  return ids;
}
async function coletarFluxoBling(emp, canal, canais, hoje, janela) {
  const ids = await lojasCanal(emp.idx, canal, canais, janela);
  if (!ids.size) return null;
  const linhas = [];
  // pedido já pago entra no trabalho do dia (não vai para "próximos dias"); atrasado se passou da data prevista
  const pz = p => { const d = (p.dataPrevista || '').slice(0, 10); return d && d > '2000-01-01' && d < hoje ? 'atrasado' : 'hoje'; };
  const add = (tipo, l) => { for (const p of l) linhas.push({ tipo, canal, prazo: tipo === 'empacotado' ? 'hoje' : pz(p), num: String(p.numeroLoja || '') }); };
  for (const idLoja of ids) {
    add('emitirNF', await blingListar(emp.idx, [SIT.emAberto], { ...janela, idLoja }));
    await delay(350);
    add('aEmpacotar', await blingListar(emp.idx, [SIT.atendido], { ...janela, idLoja }));
    await delay(350);
    add('empacotado', await blingListar(emp.idx, [SIT.verificado], { idLoja, dataAlteracaoInicial: hoje, dataAlteracaoFinal: hoje }));
    await delay(350);
  }
  return linhas;
}

// ─── Tiny (Lufe) ───────────────────────────────────────────────────────────
let _canalTiny = null;
function canalTinyCache() {
  if (_canalTiny) return _canalTiny;
  try { _canalTiny = JSON.parse(fs.readFileSync(ARQ_CANAL_TINY)); } catch (e) { _canalTiny = {}; }
  // aproveita os pedidos já baixados pela apuração (já trazem o canal)
  try {
    for (const [id, p] of Object.entries(JSON.parse(fs.readFileSync(ARQ_PED_TINY))))
      if (!_canalTiny[id] && p?.ecommerce) _canalTiny[id] = { canal: canalDe(p.ecommerce.nomeEcommerce), prevista: brToIso(p.data_prevista) };
  } catch (e) {}
  return _canalTiny;
}
function salvarCanalTiny() { try { fs.mkdirSync(path.dirname(ARQ_CANAL_TINY), { recursive: true }); fs.writeFileSync(ARQ_CANAL_TINY, JSON.stringify(_canalTiny)); } catch (e) {} }
async function tinyListar(situacao, extra) {
  const lista = []; let pagina = 1, total = 1;
  do {
    const ret = await tiny.chamar('pedidos.pesquisa.php', { situacao, pagina, ...extra });
    if (ret.vazio) break;
    total = parseInt(ret.numero_paginas || 1);
    for (const x of ret.pedidos || []) lista.push(x.pedido);
    pagina++; await delay(1100);
  } while (pagina <= total && pagina <= 10);
  return lista;
}
function canalPeloNumero(n) {
  n = String(n || '').trim();
  if (/^2\d{15}$/.test(n)) return 'Mercado Livre';           // ML: 2000xxxxxxxxxxxx
  if (/^\d{3}-\d{7}-\d{7}$/.test(n)) return 'Amazon';        // 701-1234567-1234567
  if (/^GSH/i.test(n)) return 'Shein';
  if (/^\d{6}[A-Z0-9]{8}$/i.test(n)) return 'Shopee';          // 251011ABCDEF12
  if (/^\d{18,19}$/.test(n)) return 'TikTok';                  // 576461413038785752
  return null;
}
async function canalTiny(p, consultas) {
  const cache = canalTinyCache();
  if (cache[p.id]) return cache[p.id];
  const peloNum = canalPeloNumero(p.numero_ecommerce);
  if (peloNum) return (cache[p.id] = { canal: peloNum, prevista: brToIso(p.data_prevista) });
  if (consultas && consultas.n++ >= 40) return { canal: 'Outros', prevista: '' }; // limite por rodada; o resto vem na próxima
  try {
    const d = (await tiny.chamar('pedido.obter.php', { id: p.id })).pedido;
    cache[p.id] = { canal: canalDe(d?.ecommerce?.nomeEcommerce || ''), prevista: brToIso(d?.data_prevista) };
    await delay(1100);
    return cache[p.id];
  } catch (e) { return { canal: 'Outros', prevista: '' }; }
}
async function coletarTiny(cfg, hoje) {
  const linhas = [], consultas = { n: 0 };
  const janela = { dataInicial: isoToBr(isoMenosDias(hoje, JANELA_DIAS)), dataFinal: isoToBr(hoje) };
  for (const etapa of ['emitirNF', 'aEmpacotar', 'empacotado']) {
    for (const sit of cfg.tiny[etapa] || []) {
      for (const p of await tinyListar(sit, janela)) {
        const info = await canalTiny(p, consultas);
        linhas.push({ tipo: etapa, canal: info.canal, prazo: prazo(brToIso(p.data_prevista) || info.prevista, hoje), num: String(p.numero_ecommerce || '') });
      }
    }
  }
  for (const sit of cfg.tiny.enviado || []) {
    for (const p of await tinyListar(sit, { dataAtualizacao: isoToBr(hoje) })) {
      const info = await canalTiny(p, consultas);
      linhas.push({ tipo: 'enviado', canal: info.canal, prazo: 'hoje' });
    }
  }
  salvarCanalTiny();
  return linhas;
}

// ─── Amazon (direto da SP-API) ─────────────────────────────────────────────
// A Amazon diz QUAIS pedidos estão por enviar (e o prazo); a etapa (NF / empacotar / empacotado)
// vem do ERP pelo número do pedido. Pedido que ainda não chegou no ERP conta como "Emitir NF".
async function coletarAmazon(emp, hoje, erpLinhas) {
  const az = amazon.loja(emp.amazon);
  if (!az.configurada()) return null;                     // sem Amazon conectada: fica com o ERP
  const d = await az.pedidosCache();
  const etapaErp = {};
  for (const l of erpLinhas) if (l.canal === 'Amazon' && l.num) etapaErp[l.num] = l.tipo;
  const linhas = [];
  const diaSP = iso => iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : '';
  for (const o of d.abertos) {
    let tipo = etapaErp[o.AmazonOrderId] || 'emitirNF';
    if (tipo === 'enviado') tipo = 'empacotado';           // no ERP já saiu, na Amazon ainda não: aguardando coleta
    // pedido da Amazon já pago entra no trabalho do dia (não vai para "próximos dias"); atrasado se passou do limite
    const lim = diaSP(o.LatestShipDate);
    linhas.push({ tipo, canal: 'Amazon', prazo: lim && lim < hoje ? 'atrasado' : 'hoje' });
  }
  for (const o of d.empacotados || []) linhas.push({ tipo: 'empacotado', canal: 'Amazon', prazo: 'hoje' });   // etiqueta gerada, aguardando coleta
  for (const o of d.enviadosHoje) linhas.push({ tipo: 'enviado', canal: 'Amazon', prazo: 'hoje' });
  return linhas;
}

// ─── Agregação ─────────────────────────────────────────────────────────────
const zerado = () => ({ emitirNF: 0, aEmpacotar: 0, empacotado: 0, enviado: 0, atrasados: 0, futuros: 0 });
function agregar(emp, linhas) {
  const canais = {};
  for (const c of emp.canais) canais[c] = { canal: c, ...zerado() };
  for (const l of linhas) {
    if (!MARKETPLACES.includes(l.canal)) continue;   // venda física / balcão / sem marketplace: fora da TV
    const c = canais[l.canal] ||= { canal: l.canal, ...zerado() };
    if (l.tipo === 'futuro' || ((l.tipo === 'emitirNF' || l.tipo === 'aEmpacotar') && l.prazo === 'futuro')) { c.futuros++; continue; }
    if (!ETAPAS.includes(l.tipo)) continue;
    c[l.tipo]++;
    if ((l.tipo === 'emitirNF' || l.tipo === 'aEmpacotar') && l.prazo === 'atrasado') c.atrasados++;
  }
  const lista = Object.values(canais).filter(c => emp.canais.includes(c.canal) || ETAPAS.some(k => c[k]) || c.futuros);
  const total = lista.reduce((t, c) => { for (const k in t) t[k] += c[k]; return t; }, zerado());
  return { id: emp.id, nome: emp.nome, logo: emp.logo, canais: lista, total };
}

// ─── Coleta em segundo plano ───────────────────────────────────────────────
let ESTADO = { atualizadoEm: null, empresas: [], erros: {} };
let ultimoPedido = 0, rodando = false;
const ULTIMAS = {}; // último dado bom por empresa e fonte

async function coletarEmpresa(emp, cfg, hoje, erros, aoParcial) {
  const ant = ULTIMAS[emp.id] || { ml: [], erp: [], okMl: false, okErp: false };
  const [rMl, rErp] = await Promise.allSettled([
    mlEnvios.coletar(emp.ml, prazo).then(ml => { aoParcial && aoParcial({ ...agregar(emp, [...ml, ...ant.erp]), carregandoErp: !ant.okErp }); return ml; }),
    emp.erp === 'tiny' ? coletarTiny(cfg, hoje) : coletarBling(emp, cfg, hoje),
  ]);
  const atual = { ...ant };
  if (rMl.status === 'fulfilled') Object.assign(atual, { ml: rMl.value, okMl: true });
  else { erros[`${emp.nome} · Mercado Livre`] = rMl.reason?.response?.status === 401 ? 'token do ML expirado' : (rMl.reason?.message || 'erro'); console.warn('[tv] ML', emp.id, rMl.reason?.message); }
  if (rErp.status === 'fulfilled') {
    let erp = rErp.value.filter(l => l.canal !== 'Mercado Livre');
    if (emp.amazon) {
      try {
        const az = await coletarAmazon(emp, hoje, erp);
        if (az) erp = [...erp.filter(l => l.canal !== 'Amazon'), ...az];
      } catch (e) { erros[`${emp.nome} · Amazon`] = e.message; console.warn('[tv] Amazon', emp.id, e.message); }
    }
    Object.assign(atual, { erp, okErp: true });
  }
  else { erros[`${emp.nome} · ${emp.erp === 'tiny' ? 'Tiny' : 'Bling'}`] = rErp.reason?.response?.status === 401 ? 'ERP não autorizado' : (rErp.reason?.message || 'erro'); console.warn('[tv] ERP', emp.id, rErp.reason?.message); }
  ULTIMAS[emp.id] = atual;
  return { ...agregar(emp, [...atual.ml, ...atual.erp]), fontes: { ml: rMl.status === 'fulfilled', erp: rErp.status === 'fulfilled' } };
}

async function atualizar() {
  if (rodando) return; rodando = true;
  const t0 = Date.now();
  try {
    const cfg = getCfg(), hoje = hojeIso(), erros = {};
    const prontas = {};
    const publicar = () => { if (!ESTADO.atualizadoEm) // primeira carga: mostra o que já chegou
      ESTADO = { ...ESTADO, parcial: true, hoje, erros, empresas: EMPRESAS.map(e => prontas[e.id] || { ...agregar(e, []), carregando: true }) }; };
    await Promise.all(EMPRESAS.map(async emp => {
      prontas[emp.id] = await coletarEmpresa(emp, cfg, hoje, erros, parcial => { if (!prontas[emp.id]) { prontas[emp.id] = parcial; publicar(); } });
      publicar();
    }));
    ESTADO = { atualizadoEm: new Date().toISOString(), hoje, empresas: EMPRESAS.map(e => prontas[e.id]), erros, configurado: !!cfg.configurado, parcial: false, duracaoSeg: Math.round((Date.now() - t0) / 1000) };
  } finally { rodando = false; }
}
setInterval(() => { if (Date.now() - ultimoPedido < 10 * 60e3) atualizar().catch(e => console.warn('[tv]', e.message)); }, INTERVALO);

// ─── Rotas ─────────────────────────────────────────────────────────────────
const router = express.Router();
const ehAdmin = req => req.usuario?.admin || !require('./auth').ativo();
router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'tv.html')));
router.get('/fontes/:f', (req, res) => { // fontes servidas pelo próprio painel (a TV não depende do Google)
  const m = String(req.params.f).match(/^(barlow(?:-condensed)?)-latin-(500|600|700|800)-normal\.woff2$/);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'node_modules', '@fontsource', m[1], 'files', req.params.f));
});
router.get('/dados', (req, res) => {
  ultimoPedido = Date.now();
  if (!ESTADO.atualizadoEm && !rodando) atualizar().catch(e => console.warn('[tv]', e.message));
  res.json({ ...ESTADO, carregando: !ESTADO.atualizadoEm && !ESTADO.parcial });
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = `body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;gap:14px;align-items:center}.top a{color:#ffd60a;text-decoration:none;font-size:13px}
.box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:18px 22px;margin:16px auto;max-width:960px}h2{font-size:15px;margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 6px;border-bottom:1px solid #f2f2f2;text-align:left}
button{padding:11px 22px;border:none;border-radius:8px;background:#0d1b2a;color:#fff;font-weight:600;font-size:14px;cursor:pointer}p.s{color:#666;font-size:13px}label{white-space:nowrap}`;

router.get('/config', async (req, res) => {
  if (!ehAdmin(req)) return res.status(403).send('Só o administrador configura a TV.');
  const cfg = getCfg();
  const sel = (nome, atual) => [...ETAPAS, 'ignorar'].map(v => `<label style="margin-right:12px"><input type="radio" name="${esc(nome)}" value="${v}" ${atual === v ? 'checked' : ''}> ${ROTULO[v]}</label>`).join('');
  const papel = (m, x) => ETAPAS.find(e => (m[e] || []).includes(x)) || 'ignorar';
  let blocos = `<div class="box"><h2>Magazine Lufe — Tiny</h2><table>${TINY_SITUACOES.map(s => `<tr><td>${esc(s)}</td><td>${sel('tiny|' + s, papel(cfg.tiny, s))}</td></tr>`).join('')}</table></div>`;
  for (const emp of EMPRESAS.filter(e => e.erp === 'bling')) {
    const m = { ...vazio(), ...(cfg.bling[emp.idx] || {}) };
    let sits; try { sits = await situacoesBling(emp.idx); } catch (e) { sits = null; }
    blocos += `<div class="box"><h2>${esc(emp.nome)} — Bling</h2>` + (sits?.length
      ? `<table>${sits.map(s => `<tr><td>${esc(s.nome)} <small style="color:#999">#${s.id}</small></td><td>${sel('bling|' + emp.idx + '|' + s.id, papel(m, s.id))}</td></tr>`).join('')}</table>`
      : `<p style="color:#c62828">Não consegui ler as situações do Bling desta conta. Autorize o Bling no painel e recarregue esta página.</p>`) + `</div>`;
  }
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configurar TV</title><style>${CSS}</style></head><body>
  <div class="top"><b>📺 Configurar painel da TV</b><span style="flex:1"></span><a href="/tv" target="_blank">Abrir TV</a><a href="/tv/diagnostico">Diagnóstico ML</a><a href="/conta">⚙️ Conta</a></div>
  ${req.query.ok ? '<div class="box" style="background:#e8f5e9;color:#2e7d32">Configuração salva. A TV atualiza em até 2 minutos.</div>' : ''}
  <form method="post" action="/tv/config"><div class="box"><p class="s">O Mercado Livre vem direto da API do ML. Aqui você diz, para os outros canais (Amazon, Shopee, Shein, TikTok), em que etapa da expedição cada situação do pedido está: <b>Emitir NF</b> → <b>A empacotar</b> → <b>Empacotado</b>. <b>Enviado</b> conta só o que mudou para essa situação hoje.</p></div>
  ${blocos}<div class="box" style="text-align:right"><button>Salvar</button></div></form></body></html>`);
});
router.post('/config', express.urlencoded({ extended: false }), (req, res) => {
  if (!ehAdmin(req)) return res.status(403).send('Só o administrador configura a TV.');
  const cfg = getCfg();
  cfg.tiny = vazio();
  const novoBling = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (!ETAPAS.includes(v)) continue;
    const [erp, a, b] = k.split('|');
    if (erp === 'tiny' && TINY_SITUACOES.includes(a)) cfg.tiny[v].push(a);
    if (erp === 'bling') (novoBling[parseInt(a)] ||= vazio())[v].push(parseInt(b));
  }
  for (const idx of Object.keys(novoBling)) cfg.bling[idx] = novoBling[idx];
  cfg.configurado = true;
  salvarCfg(cfg);
  ESTADO = { atualizadoEm: null, empresas: [], erros: {} };
  res.redirect('/tv/config?ok=1');
});

// Diagnóstico das situações do Bling (admin): /tv/bling-situacoes/0
router.get('/bling-situacoes/:idx', async (req, res) => {
  if (!ehAdmin(req)) return res.status(403).send('Só o administrador.');
  const idx = parseInt(req.params.idx), out = {};
  try { out.situacoes = await situacoesBling(idx); } catch (e) { out.erroSituacoes = (e.response?.status || '') + ' ' + JSON.stringify(e.response?.data || e.message).slice(0, 400); }
  const hoje = hojeIso(), janela = { dataInicial: isoMenosDias(hoje, JANELA_DIAS), dataFinal: hoje };
  const canais = await canaisBling(idx);
  if (req.query.fluxo) { try { out.fluxo = await coletarFluxoBling({ idx, id: 'diag' }, req.query.fluxo, canais, hoje, janela); out.fluxo = out.fluxo && out.fluxo.reduce((a, l) => (a[l.tipo] = (a[l.tipo] || 0) + 1, a), {}); } catch (e) { out.fluxoErro = e.stack?.slice(0, 500) || e.message; } }
  out.canais = canais; out.lojasDescobertas = Object.fromEntries(Object.entries(_lojaCanal).map(([k, v]) => [k, [...v.ids]]));
  out.contagem = {};
  for (const id of (req.query.sit ? req.query.sit.split(',').map(Number) : [6, 9, 24])) {
    try { const l = await blingListar(idx, [id], req.query.idLoja ? { ...janela, idLoja: req.query.idLoja } : janela); const pc = {}; l.forEach(p => { const c = canalBling(canais, p) + '#loja' + (p.loja?.id || '?'); pc[c] = (pc[c] || 0) + 1; }); out.contagem[id] = { total: l.length, porCanal: pc, exNum: l.filter(p => /shopee/i.test(canalBling(canais, p))).slice(0, 3).map(p => p.numeroLoja) }; }
    catch (e) { out.contagem[id] = 'erro ' + e.message; }
    await delay(400);
  }
  res.json(out);
});

router.get('/diagnostico', (req, res) => {
  if (!ehAdmin(req)) return res.status(403).send('Só o administrador.');
  const nomes = { Lufe: 'Magazine Lufe', Zagodini: 'Zagodini', Mae: 'Com Amor de Mãe' };
  const rot = { ...ROTULO, futuro: 'Próximos dias', ignorado: 'Não conta' };
  const blocos = Object.entries(nomes).map(([c, n]) => {
    const d = mlEnvios.diagnostico(c);
    const linhas = Object.entries(d.porStatus).sort((a, b) => b[1].qtd - a[1].qtd)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${v.qtd}</td><td>${rot[v.tvConta] || v.tvConta}</td></tr>`).join('') || '<tr><td colspan=3>Sem dados ainda. Abra a TV e aguarde 1–2 minutos.</td></tr>';
    return `<h2>${esc(n)}</h2><table><tr><th>Status / substatus no ML</th><th style="text-align:right">Pacotes</th><th>Na TV conta como</th></tr>${linhas}</table>
      <p style="color:#777;font-size:12px">Logística: ${esc(Object.entries(d.logistica).map(([k, v]) => k + ' ' + v).join(', ') || '—')}. Full (fulfillment) não entra na TV.</p>`;
  }).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Diagnóstico ML</title><style>${CSS} body{max-width:860px;margin:24px auto;padding:0 16px}h2{margin-top:28px;font-size:17px}</style>
  <h1 style="font-size:20px">Pacotes do Mercado Livre por situação</h1><p class="s">Pedidos pagos dos últimos 12 dias ainda não finalizados. Compare com Vendas → Envios no ML.
  Última atualização da TV: ${ESTADO.atualizadoEm ? new Date(ESTADO.atualizadoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ` (levou ${ESTADO.duracaoSeg}s)` : 'ainda carregando'}.</p>
  ${Object.keys(ESTADO.erros || {}).length ? `<p style="color:#c62828">Erros: ${esc(Object.entries(ESTADO.erros).map(([k, v]) => k + ': ' + v).join(' | '))}</p>` : ''}${blocos}`);
});

module.exports = { router, canalDe, agregar, prazo };
