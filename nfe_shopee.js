/**
 * NF-e da Shopee pendente de upload (só Bling: Zagodini e Com Amor de Mãe).
 * O Bling às vezes autoriza a nota mas não manda à Shopee. Aqui o painel:
 *   1. lista os pedidos da Shopee "A enviar" com a NF-e pendente na Shopee (invoice_data.status = pending);
 *   2. acha o pedido no Bling (numeroLoja) e a nota; só segue se a nota estiver AUTORIZADA;
 *   3. espera ESPERA_MIN minutos depois da emissão (dá a chance de o próprio Bling mandar);
 *   4. manda os dados da NF-e à Shopee (POST /api/v2/order/add_invoice_data) — número, série, chave, data, valores e CFOP do XML;
 *   5. confere que a Shopee aceitou e organiza o envio (logistics/ship_order): coleta no endereço de coleta da loja, horário recomendado.
 * Modo "auto" (padrão): roda sozinho a cada 15 min. Modo "manual": só lista; envia no botão.
 *
 *  GET  /nfe-shopee                lista + histórico
 *  POST /nfe-shopee/atualizar      relista
 *  POST /nfe-shopee/enviar         { loja, sn }  envia a NF-e e organiza o envio de um pedido
 *  POST /nfe-shopee/modo           { modo: 'manual' | 'auto' }
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DATA = require('./dados');
const bling = require('./bling');
const shopee = require('./shopee');

const EMP = [{ loja: 'zagodini', nome: 'Zagodini', idx: 0 }, { loja: 'mae', nome: 'Com Amor de Mãe', idx: 1 }];
const DIAS = 15, ESPERA_MIN = 15;
const ARQ = path.join(DATA, 'apuracao_cache', 'nfe_shopee.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const S = Object.assign({ modo: 'manual', lista: [], hist: [], enviados: {} }, ler(ARQ, {}));
const salvar = () => {
  S.hist = S.hist.slice(0, 300);
  for (const [k, v] of Object.entries(S.enviados)) if (Date.now() - Date.parse(v.em) > 20 * 864e5) delete S.enviados[k];
  gravar(ARQ, S);
};
const erroTxt = e => { const d = e.response?.data?.error; return d ? [d.message, d.description, ...(d.fields || []).map(f => f.msg)].filter(Boolean).join(' · ') : e.message; };
const SIT = { 1: 'pendente', 2: 'cancelada', 3: 'aguardando recibo', 4: 'rejeitada', 5: 'autorizada', 6: 'autorizada', 7: 'autorizada', 8: 'aguardando protocolo', 9: 'denegada', 10: 'em consulta', 11: 'bloqueada' };
const autorizada = s => [5, 6, 7].includes(Number(s));

// Bling: 3 req/s — repete em 429
async function breq(c, url, cfg) {
  for (let t = 0; ; t++) {
    try { return await c.get(url, cfg); }
    catch (e) { if (e.response?.status === 429 && t < 8) { await delay(1500 * (t + 1)); continue; } throw e; }
  }
}
// Shopee: repete em limite de requisições
async function sp(loja, metodo, apiPath, arg) {
  const L = shopee.loja(loja);
  for (let t = 0; ; t++) {
    try { return metodo === 'get' ? await L.shopeeGet(apiPath, arg) : metodo === 'form' ? await L.shopeePostForm(apiPath, arg()) : await L.shopeePost(apiPath, arg); }
    catch (e) {
      if (/too many|rate|limit|429/i.test(e.message) && t < 8) { await delay(2000 * (t + 1)); continue; }
      if (/invalid_access_token|access token/i.test(e.message) && t === 0) { await L.refreshToken().catch(() => {}); continue; }
      throw e;
    }
  }
}

async function pedidosShopee(loja) {
  const to = Math.floor(Date.now() / 1000), from = to - DIAS * 864e2;
  const sns = [];
  let cursor = '';
  for (let pg = 0; pg < 30; pg++) {
    const d = await sp(loja, 'get', '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor, order_status: 'READY_TO_SHIP' });
    sns.push(...(d.response?.order_list || []).map(o => o.order_sn));
    if (!d.response?.more) break;
    cursor = d.response.next_cursor;
  }
  return detalhes(loja, sns);
}
async function detalhes(loja, sns) {
  const out = [];
  for (let i = 0; i < sns.length; i += 50) {
    const d = await sp(loja, 'get', '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'invoice_data,package_list,total_amount,ship_by_date,buyer_username' });
    out.push(...(d.response?.order_list || []));
  }
  return out;
}

// pedido + nota no Bling pelo número do pedido da Shopee
async function notaBling(idx, sn) {
  const c = bling.client(idx);
  const b = (await breq(c, '/pedidos/vendas', { params: { 'numerosLojas[]': sn } })).data?.data?.[0];
  if (!b) return null;
  await delay(350);
  const ped = (await breq(c, '/pedidos/vendas/' + b.id)).data?.data;
  const r = { pedidoId: b.id, pedido: b.numero, cliente: b.contato?.nome || '' };
  if (!ped?.notaFiscal?.id) return r;
  await delay(350);
  const nf = (await breq(c, '/nfe/' + ped.notaFiscal.id)).data?.data;
  return Object.assign(r, { nfeId: nf?.id, numeroNota: nf?.numero, sitNota: SIT[nf?.situacao] || ('situação ' + nf?.situacao), autorizada: autorizada(nf?.situacao), emissao: nf?.dataEmissao, nf });
}

async function listar() {
  const out = [];
  for (const E of EMP) {
    try {
      if (!shopee.loja(E.loja).getTokens().access_token) continue;
      const L = (await pedidosShopee(E.loja)).filter(o => o.order_status === 'READY_TO_SHIP' && o.invoice_data && o.invoice_data.status !== 'valid');
      for (const o of L) {
        const x = { loja: E.loja, empresa: E.nome, idx: E.idx, sn: o.order_sn, total: o.total_amount, criado: o.create_time * 1000, prazo: o.ship_by_date ? o.ship_by_date * 1000 : null,
          invStatus: o.invoice_data.status, logistica: (o.package_list || []).map(p => p.logistics_status).join(',') };
        try { Object.assign(x, await notaBling(E.idx, o.order_sn) || { semPedido: true }); } catch (e) { x.erro = erroTxt(e); }
        delete x.nf;
        x.motivo = x.erro ? 'erro ao consultar o Bling' : x.semPedido ? 'pedido ainda não importado no Bling' : !x.nfeId ? 'sem nota no Bling ainda' : !x.autorizada ? 'nota ' + x.sitNota + ' no Bling' : 'nota autorizada no Bling, pendente na Shopee';
        out.push(x);
        await delay(300);
      }
    } catch (e) { out.push({ loja: E.loja, empresa: E.nome, erroLoja: e.message }); }
  }
  S.lista = out; S.listadoEm = new Date().toISOString(); salvar();
  return out;
}

// dados da NF-e para a Shopee: do XML (vProd, vNF, CFOP); se o XML falhar, do JSON do Bling
async function dadosNota(nf) {
  let xml = '';
  try { if (nf.xml) xml = String((await axios.get(nf.xml, { timeout: 20000, responseType: 'text' })).data || ''); } catch (e) {}
  const tag = (t, s = xml) => (s.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1];
  const tot = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
  const chave = String(nf.chaveAcesso || (xml.match(/Id="NFe(\d{44})"/) || [])[1] || '');
  const dhEmi = tag('dhEmi') || String(nf.dataEmissao || '').replace(' ', 'T') + '-03:00';
  const itens = nf.itens || [];
  const d = {
    number: String(Number(tag('nNF') || nf.numero)),
    series_number: String(Number(tag('serie') || nf.serie || 1)),
    access_key: chave,
    issue_date: Math.floor(Date.parse(dhEmi) / 1000),
    total_value: +(tag('vNF', tot) || nf.valorNota || 0),
    products_total_value: +(tag('vProd', tot) || itens.reduce((s, i) => s + (+i.valor || 0) * (+i.quantidade || 1), 0) || nf.valorNota || 0),
    tax_code: String(tag('CFOP') || itens[0]?.cfop || ''),
  };
  Object.defineProperty(d, 'xml', { value: xml, enumerable: false });
  if (d.access_key.length !== 44) throw new Error('chave de acesso da nota não encontrada');
  if (!d.issue_date) throw new Error('data de emissão da nota inválida');
  if (!d.tax_code) throw new Error('CFOP da nota não encontrado');
  return d;
}

// manda a NF-e à Shopee: o XML (upload_invoice_doc, file_type 4 — o que a Shopee Brasil usa); se recusar, tenta os campos (add_invoice_data)
async function subirNota(loja, sn, d) {
  if (!/<nfeProc|<NFe/.test(d.xml || '')) throw new Error('não consegui baixar o XML da nota no Bling');
  if (Buffer.byteLength(d.xml) > 1024 * 1024) throw new Error('XML maior que 1 MB');
  try {
    return await sp(loja, 'form', '/api/v2/order/upload_invoice_doc', () => {
      const fd = new FormData();
      fd.append('order_sn', sn); fd.append('file_type', '4');
      fd.append('file', new Blob([d.xml], { type: 'text/xml' }), 'NFe' + d.access_key + '.xml');
      return fd;
    });
  } catch (e1) {
    try { return await sp(loja, 'post', '/api/v2/order/add_invoice_data', { order_sn: sn, invoice_data: d }); }
    catch (e2) { throw new Error(e1.message + ' | ' + e2.message); }
  }
}

// organiza o envio: coleta no endereço de coleta (senão o padrão), horário recomendado; postagem se for o caso
async function organizar(loja, sn) {
  const p = (await sp(loja, 'get', '/api/v2/logistics/get_shipping_parameter', { order_sn: sn })).response || {};
  const need = p.info_needed || {};
  let corpo = null, desc = '';
  if (need.pickup) {
    const ends = p.pickup?.address_list || [];
    const end = ends.find(a => (a.address_flag || []).includes('pickup_address')) || ends.find(a => (a.address_flag || []).includes('default_address')) || ends[0];
    const slot = end && ((end.time_slot_list || []).find(s => (s.flags || []).includes('recommended')) || (end.time_slot_list || [])[0]);
    if (!end || !slot) throw new Error('a Shopee não ofereceu endereço/horário de coleta');
    corpo = { order_sn: sn, pickup: { address_id: end.address_id, pickup_time_id: slot.pickup_time_id } };
    desc = 'coleta ' + new Date(slot.date * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' em ' + (end.address || '').split(',').slice(0, 2).join(',');
  } else if (need.dropoff && !(need.dropoff || []).length) {
    corpo = { order_sn: sn, dropoff: {} }; desc = 'postagem';
  } else throw new Error('a Shopee pede dados de envio que o painel não preenche: ' + JSON.stringify(need));
  await sp(loja, 'post', '/api/v2/logistics/ship_order', corpo);
  return desc;
}

async function enviar(x, por) {
  const reg = { em: new Date().toISOString(), loja: x.loja, empresa: x.empresa, sn: x.sn, pedido: x.pedido, por: por || 'automático' };
  try {
    // 1. Shopee: confere de novo o pedido
    const o = (await detalhes(x.loja, [x.sn]))[0];
    if (!o) throw new Error('pedido não encontrado na Shopee');
    if (o.order_status !== 'READY_TO_SHIP') { reg.situacao = 'pedido ' + o.order_status + ' na Shopee — nada feito'; S.hist.unshift(reg); salvar(); return reg; }
    // 2. NF-e: manda se ainda pendente na Shopee
    if (o.invoice_data?.status !== 'valid') {
      const b = await notaBling(x.idx, x.sn);
      if (!b?.nf || !b.autorizada) throw new Error(b?.nfeId ? 'nota ' + b.sitNota + ' no Bling' : 'pedido sem nota no Bling');
      reg.pedido = b.pedido; reg.numeroNota = b.numeroNota;
      const d = await dadosNota(b.nf);
      await subirNota(x.loja, x.sn, d);
      reg.nfEnviada = true;
      S.enviados[x.sn] = { em: reg.em, loja: x.loja };
      let st = '';
      for (let t = 0; t < 5; t++) { await delay(3000); st = (await detalhes(x.loja, [x.sn]))[0]?.invoice_data?.status; if (st === 'valid') break; }
      reg.invStatus = st;
      if (st !== 'valid') { reg.situacao = 'NF-e enviada; Shopee ainda mostra "' + (st || '?') + '" — organiza o envio na próxima rodada'; S.hist.unshift(reg); salvar(); return reg; }
    } else reg.invStatus = 'valid';
    // 3. organiza o envio
    const pk = (await detalhes(x.loja, [x.sn]))[0]?.package_list || [];
    if (pk.length && pk.every(p => p.logistics_status !== 'LOGISTICS_READY')) { reg.situacao = 'NF-e ok; envio não está pronto para organizar (' + pk.map(p => p.logistics_status).join(',') + ')'; reg.ok = reg.nfEnviada; }
    else { reg.envio = await organizar(x.loja, x.sn); reg.situacao = 'NF-e ok e envio organizado (' + reg.envio + ')'; reg.ok = true; if (S.enviados[x.sn]) S.enviados[x.sn].organizado = true; }
  } catch (e) { reg.situacao = reg.nfEnviada ? 'NF-e enviada, mas erro ao organizar o envio' : 'erro'; reg.erro = erroTxt(e); }
  S.hist.unshift(reg); salvar();
  try {
    const tg = require('./telegram');
    if (reg.erro) tg.sendTelegram(`⚠️ Shopee ${x.empresa} pedido ${x.sn}: ${reg.situacao} — ${reg.erro}`);
  } catch (e) {}
  return reg;
}

// pedidos cuja NF-e o painel mandou e que ainda não foram organizados (a Shopee demorou a validar a nota)
async function organizarPendentes() {
  for (const [sn, v] of Object.entries(S.enviados)) {
    if (v.organizado || Date.now() - Date.parse(v.em) > 5 * 864e5) continue;
    const E = EMP.find(e => e.loja === v.loja);
    try {
      const o = (await detalhes(v.loja, [sn]))[0];
      if (!o || o.order_status !== 'READY_TO_SHIP') { v.organizado = true; continue; }
      if (o.invoice_data?.status !== 'valid') continue;
      if ((o.package_list || []).some(p => p.logistics_status === 'LOGISTICS_READY')) await enviar({ loja: v.loja, empresa: E.nome, idx: E.idx, sn });
      else v.organizado = true;
    } catch (e) {}
    await delay(500);
  }
  salvar();
}

let rodando = false;
async function rodar() {
  if (rodando) return; rodando = true;
  try {
    const L = await listar();
    if (S.modo === 'auto') {
      for (const x of L.filter(x => x.autorizada && x.invStatus !== 'valid')) {
        if (x.emissao && Date.now() - Date.parse(String(x.emissao).replace(' ', 'T') + '-03:00') < ESPERA_MIN * 60e3) continue;   // dá tempo ao Bling
        if (S.hist.some(h => h.sn === x.sn && h.erro && Date.now() - Date.parse(h.em) < 2 * 3600e3)) continue;   // erro recente: não insiste
        await enviar(x); await delay(1500);
      }
      await organizarPendentes();
      await listar();
    }
  } catch (e) { S.erro = e.message; }
  rodando = false;
}

module.exports = function (app) {
  const admin = (req, res) => { if (require('./auth').ativo() && !req.usuario?.admin) { res.status(403).json({ erro: 'só admin' }); return false; } return true; };
  app.get('/nfe-shopee', (req, res) => res.json({ modo: S.modo, listadoEm: S.listadoEm, rodando, espera: ESPERA_MIN, lista: S.lista, hist: S.hist.slice(0, 60) }));
  app.post('/nfe-shopee/atualizar', async (req, res) => { try { await listar(); res.json({ ok: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });
  app.post('/nfe-shopee/rodar', (req, res) => { if (!admin(req, res)) return; rodar().catch(() => {}); res.json({ ok: true }); });
  app.post('/nfe-shopee/enviar', require('express').json(), async (req, res) => {
    if (!admin(req, res)) return;
    const x = S.lista.find(y => y.loja === req.body?.loja && y.sn === req.body?.sn);
    if (!x) return res.status(404).json({ erro: 'pedido não está na lista (atualize)' });
    const r = await enviar(x, req.usuario?.nome || req.usuario?.email || 'painel');
    listar().catch(() => {});
    res.json(r);
  });
  app.post('/nfe-shopee/modo', require('express').json(), (req, res) => {
    if (!admin(req, res)) return;
    if (!['manual', 'auto'].includes(req.body?.modo)) return res.status(400).json({ erro: 'modo inválido' });
    S.modo = req.body.modo; salvar(); res.json({ ok: true, modo: S.modo });
  });
  // diagnóstico (só leitura): dados que seriam mandados à Shopee. GET /nfe-shopee/previa?loja=mae&sn=XXX
  app.get('/nfe-shopee/previa', async (req, res) => {
    try { const E = EMP.find(e => e.loja === req.query.loja); const b = await notaBling(E.idx, String(req.query.sn)); res.json({ nota: b?.numeroNota, sit: b?.sitNota, dados: b?.nf ? await dadosNota(b.nf) : null }); }
    catch (e) { res.status(500).json({ erro: erroTxt(e) }); }
  });
  setTimeout(() => rodar().catch(() => {}), 120e3);
  setInterval(() => rodar().catch(() => {}), 15 * 60e3).unref?.();
};
