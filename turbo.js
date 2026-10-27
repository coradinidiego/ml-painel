/**
 * Mercado Turbo — conferência e envio de custo/imposto por SKU.
 *
 * A API do Turbo só GRAVA (POST /rest/produtos/sku/{sku} com {custo, imposto}); não há leitura.
 * A resposta serve de conferência:
 *   304 = o Turbo já tinha esse valor (bate)   200 = estava diferente e foi atualizado   201 = SKU não existia (criado)
 *
 * SKUs = os dos anúncios ativos/pausados do ML de cada conta (é o que o Turbo usa).
 * Custo por SKU: ERP (Bling / Tiny) primeiro, planilha de reserva — o mesmo que o painel usa nas margens.
 *
 * Tokens: variáveis do Railway MT_TOKEN_ZAGODINI, MT_TOKEN_MAE, MT_TOKEN_LUFE.
 *
 *  GET  /turbo/:idx               lista SKU × ERP × planilha × último envio
 *  POST /turbo/:idx/enviar        { skus?: [...], imposto?: bool }  (sem skus = todos com custo)
 *  GET  /turbo/:idx/status        progresso do envio
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');
const custos = require('./custos_ml');

const TOKENS = { 0: 'MT_TOKEN_ZAGODINI', 1: 'MT_TOKEN_MAE', 2: 'MT_TOKEN_LUFE' };
const token = idx => String(process.env[TOKENS[idx]] || '').trim().replace(/^["']|["']$/g, '');
const URL = sku => 'https://app.mercadoturbo.com.br/rest/produtos/sku/' + encodeURIComponent(sku);
const arqEnv = idx => path.join(DATA, 'apuracao_cache', `turbo_envios_${idx}.json`);
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const r2 = v => Math.round(v * 100) / 100;
const ENV = {};       // idx -> { sku: { custo, imposto, http, status, em } }
const JOB = {};       // idx -> { rodando, feitos, total, erros, inicio, fim }
const envios = idx => (ENV[idx] ||= lerJson(arqEnv(idx), {}));

function skusDaConta(d) {
  const set = new Map();
  for (const it of [...(d?.ativos || []), ...(d?.pausados || [])]) {
    const add = (s, titulo) => { s = String(s || '').trim(); if (s && !set.has(s)) set.set(s, { titulo, mlb: it.id }); };
    add(it._sku || it.seller_sku || it.seller_custom_field, it.title);
    for (const v of it.variations || []) {
      add(v.seller_custom_field, it.title);
      add((v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name, it.title);
    }
  }
  return set;
}

async function enviarUm(idx, sku, body) {
  try {
    const r = await axios.post(URL(sku), body, {
      headers: { 'Content-Type': 'application/json', Authentication: token(idx) },
      timeout: 20000, validateStatus: () => true,
    });
    return { http: r.status, status: r.data?.status || (r.status === 304 ? 'Sem alteração' : (typeof r.data === 'string' ? r.data.slice(0, 120) : JSON.stringify(r.data || '').slice(0, 120))) };
  } catch (e) { return { http: 0, status: e.message }; }
}

module.exports = function (app, { dadosCache }) {
  app.get('/turbo/:idx', async (req, res) => {
    const idx = +req.params.idx;
    if (!(idx in TOKENS)) return res.status(400).json({ erro: 'conta inválida' });
    const d = dadosCache[idx];
    if (!d) return res.json({ carregando: true });
    const erp = await custos.custosErp(idx), plan = custos.custosConta(idx) || {};
    const imp = Math.round(custos.aliquota(idx) * 1000) / 10;
    const env = envios(idx), lista = [];
    for (const [sku, info] of skusDaConta(d)) {
      const cf = custos.custoComFonte(idx, sku, erp);
      const vErp = cf && cf.fonte !== 'planilha' ? r2(cf.v) : null;
      const vPl = custos.custoSku(idx, sku); const vPlan = vPl > 0 ? r2(vPl) : null;
      const e = env[sku] || null;
      lista.push({
        sku, titulo: info.titulo, mlb: info.mlb,
        erp: vErp, planilha: vPlan,
        divergente: vErp != null && vPlan != null && Math.abs(vErp - vPlan) > Math.max(0.05, vErp * 0.01),
        enviar: cf ? r2(cf.v) : null, fonte: cf?.fonte || null,
        turbo: e,   // último envio: { custo, imposto, http, status, em }
      });
    }
    res.json({ conta: d.nickname, erp: idx === 2 ? 'Tiny' : 'Bling', token: !!token(idx), variavel: TOKENS[idx], imposto: imp, job: JOB[idx] || null, itens: lista });
  });

  app.get('/turbo/:idx/status', (req, res) => res.json(JOB[+req.params.idx] || null));

  app.post('/turbo/:idx/enviar', require('express').json(), async (req, res) => {
    const idx = +req.params.idx;
    if (!(idx in TOKENS)) return res.status(400).json({ erro: 'conta inválida' });
    if (!token(idx)) return res.status(400).json({ erro: `falta a variável ${TOKENS[idx]} no Railway` });
    if (JOB[idx]?.rodando) return res.status(409).json({ erro: 'já está enviando' });
    const d = dadosCache[idx]; if (!d) return res.status(400).json({ erro: 'conta ainda carregando' });
    const erp = await custos.custosErp(idx);
    const imp = Math.round(custos.aliquota(idx) * 1000) / 10;
    const pedidos = Array.isArray(req.body?.skus) && req.body.skus.length ? new Set(req.body.skus.map(String)) : null;
    const fila = [];
    for (const [sku] of skusDaConta(d)) {
      if (pedidos && !pedidos.has(sku)) continue;
      const cf = custos.custoComFonte(idx, sku, erp); if (!cf) continue;
      const body = { custo: r2(cf.v) }; if (req.body?.imposto) body.imposto = imp;
      fila.push([sku, body]);
    }
    const job = JOB[idx] = { rodando: true, feitos: 0, total: fila.length, iguais: 0, atualizados: 0, criados: 0, erros: 0, inicio: new Date().toISOString() };
    res.json({ ok: true, total: fila.length });
    const env = envios(idx);
    for (const [sku, body] of fila) {
      let r = await enviarUm(idx, sku, body);
      if (r.http === 429 || r.http >= 500 || r.http === 0) { await new Promise(s => setTimeout(s, 3000)); r = await enviarUm(idx, sku, body); }
      env[sku] = { ...body, ...r, em: new Date().toISOString() };
      job.feitos++;
      if (r.http === 304) job.iguais++; else if (r.http === 200) job.atualizados++; else if (r.http === 201) job.criados++; else { job.erros++; job.ultimoErro = `${sku}: ${r.http} ${r.status}`; }
      if (r.http === 401) { job.ultimoErro = 'token recusado (401) — confira ' + TOKENS[idx]; break; }
      if (job.feitos % 20 === 0) gravar(arqEnv(idx), env);
      await new Promise(s => setTimeout(s, 250));
    }
    gravar(arqEnv(idx), env);
    job.rodando = false; job.fim = new Date().toISOString();
    console.log('[turbo]', idx, JSON.stringify(job));
  });
};
