/**
 * SHEIN Open Platform (Autooperação) — autorização da loja e chamadas assinadas.
 *
 * Railway:  SHEIN_APP_ID, SHEIN_APP_SECRET   (app "Painel Zagodini" na Plataforma Aberta)
 * Autorizar uma loja (admin):  /shein/conectar?loja=zagodini   (ou mae)
 * Retorno:                     /shein/callback  → troca o tempToken por openKeyId + secretKey (guardados no disco)
 *
 * Assinatura (x-lt-signature): random(5) + base64( hex( HMAC-SHA256( key = secretKey + random, value = openKeyId&timestamp&path ) ) )
 * secretKey da loja vem criptografado: AES-128-CBC, chave = 16 primeiros bytes do APP_SECRET, IV = "space-station-de"
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const router = express.Router();
const ARQ = path.join(DATA, 'shein_tokens.json');
const BASE = process.env.SHEIN_BASE || 'https://openapi.sheincorp.com';
const AUTH_URL = process.env.SHEIN_AUTH_URL || 'https://openapi-sem.sheincorp.com/#/empower';
const LOJAS = { zagodini: 'Zagodini', mae: 'Com Amor de Mãe', lufe: 'Lufe' };

const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return {}; } };
const gravar = t => { try { fs.writeFileSync(ARQ, JSON.stringify(t, null, 1)); } catch (e) { console.warn('[shein] gravar', e.message); } };
const configurado = () => !!(process.env.SHEIN_APP_ID && process.env.SHEIN_APP_SECRET);
const soAdmin = (req, res, next) => (!require('./auth').ativo() || req.usuario?.admin) ? next() : res.status(403).send('Só o administrador.');
const base = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function assinar(openKeyId, secretKey, apiPath, timestamp) {
  const rnd = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(5, 'x').slice(0, 5);
  const hex = crypto.createHmac('sha256', secretKey + rnd).update(`${openKeyId}&${timestamp}&${apiPath}`).digest('hex');
  return rnd + Buffer.from(hex).toString('base64');
}
function decifrar(conteudo, chave) {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(chave, 'utf8').subarray(0, 16), Buffer.from('space-station-default-iv').subarray(0, 16));
  return Buffer.concat([d.update(Buffer.from(conteudo, 'base64')), d.final()]).toString('utf8');
}
async function chamarAssinado(openKeyId, secretKey, apiPath, body, extraHeaders = {}, metodo = 'POST') {
  const ts = String(Date.now());
  const headers = { 'Content-Type': 'application/json;charset=UTF-8', 'x-lt-openKeyId': openKeyId, 'x-lt-timestamp': ts, 'x-lt-signature': assinar(openKeyId, secretKey, apiPath, ts), ...extraHeaders };
  const r = await axios({ method: metodo, url: BASE + apiPath, data: metodo === 'GET' ? undefined : (body || {}), params: metodo === 'GET' ? body : undefined, headers, validateStatus: () => true, timeout: 30000 });
  if (r.status >= 400) throw Object.assign(new Error('SHEIN HTTP ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 300)), { resposta: r.data });
  return r.data;
}
/** Chamada na loja autorizada (openKeyId/secretKey da loja) */
async function api(loja, apiPath, body, metodo = 'POST') {
  const t = ler()[loja];
  if (!t?.openKeyId) throw new Error('Loja ' + loja + ' não autorizada na SHEIN — abra /shein/conectar?loja=' + loja);
  try { return await chamarAssinado(t.openKeyId, t.secretKey, apiPath, body, {}, metodo); }
  catch (e) {
    // IP do servidor fora da lista branca (o Railway pode trocar o IP de saída): avisa uma vez por IP
    const ip = String(e.resposta?.msg || '').match(/whitelist:\s*([\d.]+)/)?.[1];
    if (ip && _ipAvisado !== ip) {
      _ipAvisado = ip; ultimoIpBloqueado = { ip, em: new Date().toISOString() };
      try { require('./telegram').sendTelegram('⚠️ <b>SHEIN bloqueou o IP do painel</b>\nAdicione <code>' + ip + '</code> na Lista branca de IP da Plataforma Aberta SHEIN (Kit de desenvolvimento → Lista branca de IP).'); } catch (er) {}
    }
    throw e;
  }
}
let _ipAvisado = null, ultimoIpBloqueado = null;

router.get('/conectar', soAdmin, (req, res) => {
  if (!configurado()) return res.status(400).send('Falta configurar SHEIN_APP_ID e SHEIN_APP_SECRET no Railway.');
  const loja = LOJAS[req.query.loja] ? req.query.loja : 'zagodini';
  const redirect = Buffer.from(base(req) + '/shein/callback').toString('base64');
  res.redirect(`${AUTH_URL}?appid=${encodeURIComponent(process.env.SHEIN_APP_ID)}&redirectUrl=${encodeURIComponent(redirect)}&state=${loja}`);
});
router.get('/callback', soAdmin, async (req, res) => {
  const loja = LOJAS[req.query.state] ? req.query.state : 'zagodini';
  const temp = req.query.tempToken || req.query.temp_token;
  if (!temp) return res.status(400).send('<h2>❌ A SHEIN não devolveu o tempToken</h2><pre>' + JSON.stringify(req.query).replace(/</g, '&lt;') + '</pre>');
  try {
    const d = await chamarAssinado(process.env.SHEIN_APP_ID, process.env.SHEIN_APP_SECRET, '/open-api/auth/get-by-token', { tempToken: temp }, { 'x-lt-appid': process.env.SHEIN_APP_ID });
    const info = d.info || d.data || {};
    if (!info.openKeyId || !info.secretKey) throw new Error('resposta sem openKeyId/secretKey: ' + JSON.stringify(d).slice(0, 300));
    const T = ler();
    T[loja] = { openKeyId: info.openKeyId, secretKey: decifrar(info.secretKey, process.env.SHEIN_APP_SECRET), supplierId: info.supplierId || null, em: new Date().toISOString() };
    gravar(T);
    res.send(`<!DOCTYPE html><meta charset="UTF-8"><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5"><div style="background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px #0001"><div style="font-size:48px">✅</div><h2 style="color:#1e7e34">SHEIN autorizada!</h2><p>${LOJAS[loja]}</p><a href="/painel.html" style="display:inline-block;padding:12px 28px;background:#0d1b2a;color:white;border-radius:8px;text-decoration:none">← Voltar ao painel</a></div></body>`);
  } catch (e) { res.status(500).send('<h2>❌ Erro ao autorizar a SHEIN</h2><pre>' + String(e.message).replace(/</g, '&lt;') + '</pre><a href="/shein/conectar?loja=' + loja + '">Tentar de novo</a>'); }
});
router.get('/status', soAdmin, (req, res) => {
  const T = ler();
  res.json({ configurado: configurado(), ipBloqueado: ultimoIpBloqueado, callback: base(req) + '/shein/callback', lojas: Object.fromEntries(Object.keys(LOJAS).map(k => [k, T[k] ? { autorizada: true, em: T[k].em, supplierId: T[k].supplierId } : { autorizada: false }])) });
});
// diagnóstico (admin): POST /shein/raw?loja=zagodini&path=/open-api/order/order-list  com body JSON
router.post('/raw', soAdmin, express.json(), async (req, res) => {
  if (!/^\/open-api\//.test(String(req.query.path || ''))) return res.status(400).json({ erro: 'path inválido' });
  try { res.json(await api(String(req.query.loja || 'zagodini'), String(req.query.path), req.body || {}, req.query.metodo === 'GET' ? 'GET' : 'POST')); }
  catch (e) { res.status(500).json({ erro: e.message, resposta: e.resposta }); }
});

// ─── Pedidos: lista + detalhe com taxas reais (cache em disco por loja) ──────
// Horários da SHEIN vêm em UTC+8 ("2026-10-19T22:17:20.000+0800" ou "2026-10-19 22:17:20").
const delay = ms => new Promise(r => setTimeout(r, ms));
const autorizada = loja => !!ler()[loja]?.openKeyId;
const arqPed = loja => path.join(DATA, 'apuracao_cache', `shein_pedidos_${loja}.json`);
const _ped = {};
const pedidosCache = loja => (_ped[loja] ||= (() => { try { return JSON.parse(fs.readFileSync(arqPed(loja))); } catch (e) { return {}; } })());
const salvarPed = loja => { try { fs.mkdirSync(path.dirname(arqPed(loja)), { recursive: true }); fs.writeFileSync(arqPed(loja), JSON.stringify(_ped[loja] || {})); } catch (e) {} };
const cn = d => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');   // Date → texto UTC+8
const deCn = t => { if (!t) return null; const s = String(t); const d = /[+-]\d{4}$/.test(s) ? Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : Date.parse(s.replace(' ', 'T') + '+08:00'); return isNaN(d) ? null : new Date(d).toISOString(); };
const FINAL = new Set([5, 6, 8, 9]);   // assinado, reembolsado, perdido, recusado
function resumir(o) {
  const itens = {};
  for (const g of o.orderGoodsInfoList || []) {
    const k = String(g.sellerSku || g.goodsSn || '').trim().toUpperCase();
    const x = itens[k] ||= { n: 0, preco: 0, com: 0, fixo: 0, serv: 0, renda: 0, skuCode: g.skuCode, skc: g.skc, titulo: g.goodsTitle };
    x.n++; x.preco += +g.sellerCurrencyDiscountPrice || +g.sellerCurrencyPrice || 0; x.com += +g.commission || 0;
    x.fixo += +g.performanceServiceCharge || 0; x.serv += +g.serviceCharge || 0; x.renda += +g.estimatedIncome || 0;
  }
  return { st: +o.orderStatus, com: +o.totalCommission || 0, fixo: +o.totalPerformanceServiceCharge || 0, serv: +o.totalServiceCharge || 0,
    frete: +o.sellerShippingFee || 0, renda: +o.estimatedGrossIncome || 0, desconto: (+o.storeDiscountTotalPrice || 0) + (+o.promotionDiscountTotalPrice || 0),
    pedido: deCn(o.orderTime), pago: deCn(o.paymentTime), prazoEnvio: deCn(o.requestDeliveryTime), prazoEntrega: deCn(o.requestHandoverTime),
    enviado: deCn(o.sellerDeliveryTime), coletado: deCn(o.pickUpTime), itens, em: Date.now() };
}
/** Detalhe (com taxas) dos pedidos; usa o cache e só rebusca o que não terminou (a cada `idadeMin`) */
async function detalhes(loja, nums, { idadeMin = 360, prog } = {}) {
  const C = pedidosCache(loja);
  const falta = [...new Set(nums.filter(Boolean))].filter(n => !C[n] || (!FINAL.has(C[n].st) && Date.now() - (C[n].em || 0) > idadeMin * 60e3));
  for (let i = 0; i < falta.length; i += 30) {
    const lote = falta.slice(i, i + 30);
    const d = await api(loja, '/open-api/order/order-detail', { orderNoList: lote });
    for (const o of (Array.isArray(d.info) ? d.info : d.info?.orderList || [])) if (o?.orderNo) C[o.orderNo] = resumir(o);
    prog?.(Math.min(i + 30, falta.length), falta.length);
    await delay(400);
  }
  if (falta.length) salvarPed(loja);
  return C;
}
/** Lista de pedidos por data (de/até: Date) — queryType 1 = data do pedido, 2 = atualização; status opcional */
async function listarPedidos(loja, de, ate, { queryType = 1, status } = {}) {
  const out = [];
  for (let t0 = de.getTime(); t0 < ate.getTime(); t0 += 7 * 864e5) {         // janelas de 7 dias
    const t1 = Math.min(ate.getTime(), t0 + 7 * 864e5);
    for (let page = 1; page <= 200; page++) {
      const d = await api(loja, '/open-api/order/order-list', { queryType, startTime: cn(new Date(t0)), endTime: cn(new Date(t1)), page, pageSize: 30, ...(status ? { orderStatus: status } : {}) });
      const L = d.info?.orderList || [];
      out.push(...L.map(x => ({ num: x.orderNo, st: +x.orderStatus, criado: deCn(x.orderCreateTime), atualizado: deCn(x.orderUpdateTime) })));
      if (L.length < 30) break;
      await delay(300);
    }
  }
  return out;
}

// ─── Catálogo (skuCode SHEIN → SKU do vendedor) e estoque ────────────────────
const arqCat = loja => path.join(DATA, 'apuracao_cache', `shein_catalogo_${loja}.json`);
const _cat = {};
const catCache = loja => (_cat[loja] ||= (() => { try { return JSON.parse(fs.readFileSync(arqCat(loja))); } catch (e) { return { spus: {}, skus: {}, ts: 0 }; } })());
/** Atualiza o catálogo: lista os SPUs publicados e busca o detalhe só dos novos (ou de todos, 1x por semana) */
async function catalogo(loja, { prog } = {}) {
  const C = catCache(loja), spus = new Set();
  for (let pg = 1; pg <= 400; pg++) {
    const d = await api(loja, '/open-api/openapi-business-backend/product/query', { pageNum: pg, pageSize: 50 });
    const L = d.info?.data || [];
    for (const x of L) spus.add(x.spuName);
    if (L.length < 50) break;
    await delay(250);
  }
  const semana = Date.now() - (C.ts || 0) > 7 * 864e5;
  const falta = [...spus].filter(s => semana || !C.spus[s]);
  let i = 0;
  for (const spu of falta) {
    try {
      const d = await api(loja, '/open-api/goods/spu-info', { languageList: ['en'], spuName: spu });
      const I = d.info || {};
      for (const skc of I.skcInfoList || []) for (const k of skc.skuInfoList || []) {
        const preco = (k.priceInfoList || []).find(p => /br/i.test(p.subSite || p.site || '')) || (k.priceInfoList || [])[0] || {};
        C.skus[k.skuCode] = { sku: String(k.supplierSku || skc.supplierCode || I.supplierCode || '').trim(), skc: skc.skcName, spu, titulo: skc.productMultiNameList?.[0]?.productName || I.productMultiNameList?.[0]?.productName || '', preco: +preco.specialPrice || +preco.basePrice || null };
      }
      C.spus[spu] = Date.now();
    } catch (e) { console.warn('[shein] spu', spu, e.message); }
    prog?.(++i, falta.length);
    await delay(250);
  }
  for (const s of Object.keys(C.spus)) if (!spus.has(s)) { delete C.spus[s]; for (const [k, v] of Object.entries(C.skus)) if (v.spu === s) delete C.skus[k]; }
  if (semana) C.ts = Date.now();
  try { fs.mkdirSync(path.dirname(arqCat(loja)), { recursive: true }); fs.writeFileSync(arqCat(loja), JSON.stringify(C)); } catch (e) {}
  return C.skus;
}
/** Estoque do modo autooperação (warehouseType 2), 100 skuCodes por consulta */
async function estoques(loja, skuCodes) {
  const out = {};
  for (let i = 0; i < skuCodes.length; i += 100) {
    const d = await api(loja, '/open-api/stock/stock-query', { skuCodeList: skuCodes.slice(i, i + 100), warehouseType: '2' });
    for (const b of d.info || []) for (const g of b.goodsInventory || []) for (const k of g.skuList || [])
      out[k.skuCode] = { total: +k.totalInventoryQuantity || 0, usavel: +k.totalUsableInventory || 0, travado: +k.totalLockedQuantity || 0, temp: +k.totalTempLockQuantity || 0, deposito: k.warehouseInventoryList?.[0]?.warehouseCode || null };
    await delay(250);
  }
  return out;
}
/** Grava o estoque à venda (= usável + travado temporário) de um SKU SHEIN */
async function atualizarEstoque(loja, skuCode, qtd, deposito) {
  const d = await api(loja, '/open-api/gsp/goods/change-inventory', { updateSkuInventoryQuantityRequests: [{ skuCode, saleInventory: Math.max(0, Math.floor(qtd)), ...(deposito ? { warehouseCode: deposito } : {}) }] });
  if (String(d.code) !== '0') throw new Error('SHEIN: ' + (d.msg || JSON.stringify(d).slice(0, 200)));
  const falha = (d.info?.failedList || d.info?.failList || []).find?.(x => x);
  if (falha) throw new Error('SHEIN: ' + JSON.stringify(falha).slice(0, 200));
  return d;
}

module.exports = { router, api, LOJAS, catalogo, catCache, estoques, atualizarEstoque, autorizada, detalhes, listarPedidos, pedidosCache, deCn, cn };
