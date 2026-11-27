/**
 * Apuração de lucro — Magazine Lufe (Tiny ERP + Precificacao Nova.xlsx)
 * Montado em server.js:  app.use('/apuracao-tiny', require('./tiny_apuracao').router)
 *
 *  POST /apuracao-tiny/iniciar?ini=YYYY-MM-DD&fim=YYYY-MM-DD   -> busca no Tiny (em segundo plano)
 *  GET  /apuracao-tiny/status?ini&fim                          -> progresso
 *  GET  /apuracao-tiny/resultado?ini&fim                       -> apuração (recalcula com planilha/config atuais)
 *  GET/POST /apuracao-tiny/config  {imposto, mlComissao}
 */
const express = require('express');
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const tiny = require('./tiny');
const DATA = require('./dados');

const DIR        = path.join(DATA, 'apuracao_cache');
const CACHE_PED  = path.join(DIR, 'tiny_lufe_pedidos.json');   // { id: detalhe }
const CONFIG     = path.join(DATA, 'tiny_lufe_config.json');
const PLANILHA   = path.join(DATA, 'Precificacao Nova.xlsx');
const PAUSA      = 1100;
fs.mkdirSync(DIR, { recursive: true });

const delay = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : n; };
const f   = v => num(v) || 0;
const K   = v => (v === null || v === undefined || v === '') ? null : String(v).trim().toUpperCase();
const r2  = v => Math.round(v * 100) / 100;
const isoToBr = iso => iso.split('-').reverse().join('/');
const brToIso = br => (br || '').split('/').reverse().join('-');

// ─── Config ────────────────────────────────────────────────────────────────
function getConfig() {
  let c = { imposto: 0.05, mlComissao: 0.115 };
  try { c = { ...c, ...JSON.parse(fs.readFileSync(CONFIG)) }; } catch (e) {}
  return c;
}

// ─── Cache de pedidos ──────────────────────────────────────────────────────
let _ped = null;
function pedidos() {
  if (_ped) return _ped;
  try { _ped = JSON.parse(fs.readFileSync(CACHE_PED)); } catch (e) { _ped = {}; }
  // semente: arquivos baixados pelo "node tiny.js ini fim"
  if (!Object.keys(_ped).length) {
    for (const a of fs.readdirSync(DIR).filter(a => /^tiny_lufe_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(a))) {
      try { for (const p of JSON.parse(fs.readFileSync(path.join(DIR, a))).pedidos || []) if (p.id && !p._erro) _ped[p.id] = p; } catch (e) {}
    }
    salvarPedidos();
  }
  return _ped;
}
function salvarPedidos() { fs.writeFileSync(CACHE_PED, JSON.stringify(_ped)); }
function periodoFile(ini, fim) { return path.join(DIR, `tiny_ap_${ini}_${fim}.json`); }

// ─── Regras e custos: Precificação do painel (as planilhas não são mais usadas) ───
const PR = () => require('./precificacao');

const BRINDES_SKU = ['SOFLENS59-200'];
const BRINDES_DESC = /vetnil\s+enterex/i;
function calcular(lista, cfg) {
  // Custo: o do Tiny vigente na data da venda (histórico de custos: cada mudança fica gravada com a data);
  // sem custo no Tiny, o Custo da Precificação do painel
  const cmod = require('./custos_ml');
  const custo = (s, dataIso) => {
    if (cfg.erp) { try { const f = cmod.custoComFonte(2, s, dataIso ? cmod.custosNaData(2, dataIso, cfg.erp) : cfg.erp); if (f) return [f.v, f.fonte === 'planilha' ? 'Precificação' : f.fonte + (dataIso ? ' (custo em ' + dataIso.split('-').reverse().join('/') + ')' : '')]; } catch (e) {} }
    return [null, 'SEM CUSTO'];
  };
  // tarifas de cada canal: as mesmas regras da tela de Precificação (ML: comissão da categoria + tabela de frete pelo peso;
  // Shopee/TikTok por faixa de preço; Amazon comissão da categoria + custo fixo; SHEIN 18% + frete pelo peso)
  const regra = (canal, s, pu) => { const r = PR().regraVenda(2, canal, s, pu); return [r, r.origem]; };
  const pesoSku = s => PR().pesoSku(2, s);
  const mlEnvio = (preco, kg) => PR().mlFreteEmp(2, kg || 0.5, preco) ?? 0;

  const linhas = []; let cancelados = 0;
  for (const p of lista) {
    if (p.situacao === 'Cancelado') { cancelados++; continue; }
    const canal = p.ecommerce?.nomeEcommerce || 'Outros';
    const tp = f(p.total_produtos), tped = f(p.total_pedido);
    const fator = tp ? tped / tp : 1;
    (p.itens || []).forEach((it, idx) => {
      const i = it.item, s = K(i.codigo) || '', q = f(i.quantidade), pu = f(i.valor_unitario) * fator;
      const receita = r2(q * pu);
      // brindes (definidos pelo Diego em 24/11): custo zero
      const brinde = BRINDES_SKU.includes(s) || (!s && BRINDES_DESC.test(String(i.descricao || '')));
      const [cu, origCusto] = brinde ? [0, 'Brinde (custo zero)'] : custo(s, brToIso(p.data_pedido));
      const [rg, origTaxa] = regra(canal, s, pu);
      const cmv = (cu || 0) * q, imposto = receita * cfg.imposto, comissao = receita * (rg.rate || 0);
      let taxa;
      if (canal === 'Mercado Livre') { const kg = pesoSku(s); taxa = pu >= 79 ? mlEnvio(pu, (kg || 0.5) * q) : mlEnvio(pu, kg) * q; }
      else taxa = ((rg.fixo || 0) + (rg.frete || 0)) * q;
      const insumos = idx === 0 ? (cfg.embalagem ?? 0) : 0;   // embalagem por pedido (página Conta)
      const lucro = receita - cmv - imposto - comissao - taxa - insumos;
      linhas.push({
        data: p.data_pedido, dataIso: brToIso(p.data_pedido), pedido: p.numero, pedidoCanal: p.numero_ecommerce, canal, situacao: p.situacao,
        cliente: p.cliente?.nome || '', sku: s, descricao: i.descricao, qtd: q, precoUn: r2(pu), receita, custoUn: cu,
        cmv: r2(cmv), comissao: r2(comissao), taxa: r2(taxa), imposto: r2(imposto), insumos: r2(insumos), lucro: r2(lucro),
        pct: receita ? r2(lucro / receita * 100) : 0, origemCusto: origCusto, origemTaxa: origTaxa,
      });
    });
  }
  const canais = {}; const tot = { pedidos: new Set(), receita: 0, cmv: 0, comissao: 0, taxa: 0, imposto: 0, insumos: 0, lucro: 0 };
  for (const l of linhas) {
    const c = canais[l.canal] ||= { canal: l.canal, pedidos: new Set(), receita: 0, cmv: 0, comissao: 0, taxa: 0, imposto: 0, insumos: 0, lucro: 0 };
    for (const o of [c, tot]) { o.pedidos.add(l.pedido); for (const k of ['receita', 'cmv', 'comissao', 'taxa', 'imposto', 'insumos', 'lucro']) o[k] += l[k]; }
  }
  const fech = o => ({ ...o, pedidos: o.pedidos.size, ...Object.fromEntries(['receita', 'cmv', 'comissao', 'taxa', 'imposto', 'insumos', 'lucro'].map(k => [k, r2(o[k])])) });
  linhas.sort((a, b) => a.dataIso < b.dataIso ? -1 : a.dataIso > b.dataIso ? 1 : (+a.pedido) - (+b.pedido));
  return {
    resumo: Object.values(canais).map(fech).sort((a, b) => b.receita - a.receita),
    total: fech(tot), cancelados, linhas,
    semCusto: linhas.filter(l => l.custoUn == null).map(l => ({ sku: l.sku, descricao: l.descricao, canal: l.canal, qtd: l.qtd, receita: l.receita })),
    config: cfg,
  };
}

// ─── Busca no Tiny (em segundo plano) ──────────────────────────────────────
const jobs = {}; // key -> {fase, pct, rodando, erro, fim}
async function buscar(ini, fim, key) {
  const job = jobs[key] = { rodando: true, fase: 'Listando pedidos no Tiny...', pct: 2, erro: null, cancelar: false };
  try {
    const cache = pedidos();
    const lista = []; let pagina = 1, total = 1;
    do {
      const ret = await tiny.chamar('pedidos.pesquisa.php', { dataInicial: isoToBr(ini), dataFinal: isoToBr(fim), pagina });
      if (ret.vazio) break;
      total = parseInt(ret.numero_paginas || 1);
      for (const x of ret.pedidos || []) lista.push(x.pedido);
      job.fase = `Listando pedidos... pág ${pagina}/${total} (${lista.length})`; job.pct = 2 + Math.round(8 * pagina / total);
      pagina++; await delay(PAUSA);
      if (job.cancelar) throw new Error('Cancelado');
    } while (pagina <= total);

    // só baixa detalhe de pedidos novos ou que mudaram de situação
    const faltam = lista.filter(p => !cache[p.id] || cache[p.id].situacao !== p.situacao);
    for (let i = 0; i < faltam.length; i++) {
      if (job.cancelar) throw new Error('Cancelado');
      job.fase = `Baixando detalhes: ${i + 1}/${faltam.length} (${lista.length - faltam.length} já em cache)`;
      job.pct = 10 + Math.round(88 * (i + 1) / faltam.length);
      try { cache[faltam[i].id] = await tiny.obterPedido(faltam[i].id); }
      catch (e) { console.warn('[tiny] pedido', faltam[i].id, e.message); }
      if ((i + 1) % 25 === 0) salvarPedidos();
      await delay(PAUSA);
    }
    salvarPedidos();
    fs.writeFileSync(periodoFile(ini, fim), JSON.stringify({ ini, fim, geradoEm: new Date().toISOString(), ids: lista.map(p => p.id) }));
    Object.assign(job, { rodando: false, fase: 'Concluído!', pct: 100 });
  } catch (e) {
    Object.assign(job, { rodando: false, erro: e.message, fase: 'Erro: ' + e.message });
  }
}

// ─── Rotas ─────────────────────────────────────────────────────────────────
const router = express.Router();
const periodo = q => {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!ok(q.ini) || !ok(q.fim)) throw new Error('Informe ini e fim (YYYY-MM-DD)');
  return [q.ini, q.fim, `${q.ini}_${q.fim}`];
};

router.post('/iniciar', (req, res) => {
  try {
    const [ini, fim, key] = periodo(req.query);
    if (Object.values(jobs).some(j => j.rodando)) return res.status(409).json({ ok: false, erro: 'Já existe uma busca do Tiny em andamento.' });
    buscar(ini, fim, key);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

router.post('/cancelar', (req, res) => { for (const j of Object.values(jobs)) j.cancelar = true; res.json({ ok: true }); });

router.get('/status', (req, res) => {
  try { const [, , key] = periodo(req.query); const j = jobs[key]; res.json(j ? { rodando: j.rodando, fase: j.fase, pct: j.pct, erro: j.erro } : { rodando: false }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

router.get('/resultado', async (req, res) => {
  try {
    const [ini, fim] = periodo(req.query);
    let meta; try { meta = JSON.parse(fs.readFileSync(periodoFile(ini, fim))); } catch (e) {}
    const cache = pedidos();
    let lista;
    if (meta) lista = meta.ids.map(id => cache[id]).filter(Boolean);
    else { // sem busca registrada: usa o que houver em cache no período (ex.: setembro já baixado)
      lista = Object.values(cache).filter(p => { const d = brToIso(p.data_pedido); return d >= ini && d <= fim; });
      if (!lista.length) return res.json({ ok: false, vazio: true });
    }
    let erp = null; try { erp = await require('./custos_ml').custosErp(2); } catch (e) {}
    const ce = require('./config_empresas').get().find(e => e.id === 'lufe') || {};
    res.json({ ok: true, ini, fim, geradoEm: meta?.geradoEm || null, ...calcular(lista, { ...getConfig(), ...(ce.imposto != null ? { imposto: ce.imposto } : {}), erp, embalagem: ce.embalagem }) });
  } catch (e) { console.error('[apuracao-tiny]', e); res.status(500).json({ ok: false, erro: e.message }); }
});

router.get('/config', (req, res) => res.json(getConfig()));
router.post('/config', express.json(), (req, res) => {
  const c = getConfig();
  if (req.body.imposto != null) c.imposto = parseFloat(req.body.imposto);
  if (req.body.mlComissao != null) c.mlComissao = parseFloat(req.body.mlComissao);
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  res.json(c);
});


// ─── Status das planilhas de custo (alerta nas apurações) ──────────────────
const PLANILHAS_CUSTO = {
  lufe:  [{ nome: 'Precificacao Nova.xlsx', empresa: 'Magazine Lufe' }],
  bling: [{ nome: 'Precificacao Comercial Zagodini.xlsx', empresa: 'Zagodini', json: 'custo_por_sku.json' },
          { nome: 'Precificacao Atelie Com S2 de Mãe.xlsx', empresa: 'Com Amor de Mãe', json: 'custo_por_sku.json' }],
};
const DIAS_ALERTA = 30;
router.get('/planilhas', (req, res) => res.json({ diasAlerta: 30, planilhas: [] }));   // planilhas abandonadas (26/11/2026): custos e regras vêm da Precificação do painel

// ─── Usado pela apuração Amazon / Shein / TikTok (apuracao_mkt.js) ─────────
async function buscarPeriodo(ini, fim, aoProgresso) {
  const key = `${ini}_${fim}`;
  if (jobs[key]?.rodando) { while (jobs[key]?.rodando) { aoProgresso?.(jobs[key]); await delay(1000); } }
  else {
    const p = buscar(ini, fim, key);
    const t = setInterval(() => jobs[key] && aoProgresso?.(jobs[key]), 1000);
    await p; clearInterval(t);
  }
  if (jobs[key]?.erro) throw new Error(jobs[key].erro);
}
function pedidosPeriodo(ini, fim) {
  let per; try { per = JSON.parse(fs.readFileSync(periodoFile(ini, fim))); } catch (e) { return null; }
  const cache = pedidos();
  return per.ids.map(id => cache[id]).filter(Boolean);
}
function planilhaLufe() {
  // (nome mantido) custo e regras da Lufe pela Precificação do painel
  const cmod = require('./custos_ml');
  return {
    custo: s => { const f = cmod.custoComFonte(2, s, {}); return f ? f.v : null; },
    regra: (canal, s, pu) => PR().regraVenda(2, canal, s, pu),
  };
}

module.exports = { router, calcular, getConfig, buscarPeriodo, pedidosPeriodo, planilhaLufe };
