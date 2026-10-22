/**
 * Amazon SP-API (Brasil) — conexão por loja.
 * Credenciais por variável de ambiente: AMAZON_<LOJA>_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN
 * (LOJA = ZAGODINI | MAE | LUFE). Desde 2023 a SP-API não exige mais assinatura AWS (SigV4):
 * basta o access token do LWA no cabeçalho x-amz-access-token.
 */
const axios = require('axios');

const ENDPOINT = 'https://sellingpartnerapi-na.amazon.com';
const MARKETPLACE_BR = 'A2Q3Y263D00KWC';
const LOJAS = {
  zagodini: { nome: 'Comercial Zagodini', env: 'ZAGODINI', ml: 0 },
  mae:      { nome: 'Com Amor de Mãe',    env: 'MAE', ml: 1 },
  lufe:     { nome: 'Lufe Casa & Decoração', env: 'LUFE', ml: 2 },
};
const delay = ms => new Promise(r => setTimeout(r, ms));

function criar(chave) {
  const L = LOJAS[chave];
  const cred = () => ({
    id: process.env['AMAZON_' + L.env + '_CLIENT_ID'],
    secret: process.env['AMAZON_' + L.env + '_CLIENT_SECRET'],
    refresh: process.env['AMAZON_' + L.env + '_REFRESH_TOKEN'],
  });
  const configurada = () => { const c = cred(); return !!(c.id && c.secret && c.refresh); };
  let tok = null, tokAte = 0;

  async function accessToken() {
    if (tok && Date.now() < tokAte - 60e3) return tok;
    const c = cred();
    if (!configurada()) throw new Error('Amazon ' + chave + ': faltam variáveis AMAZON_' + L.env + '_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.id, client_secret: c.secret });
    try {
      const r = await axios.post('https://api.amazon.com/auth/o2/token', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
      tok = r.data.access_token; tokAte = Date.now() + (r.data.expires_in || 3600) * 1000;
      return tok;
    } catch (e) {
      const d = e.response?.data;
      throw new Error('Login Amazon (LWA) falhou: ' + (d?.error_description || d?.error || e.message));
    }
  }

  async function get(path, params = {}, tent = 4) {
    for (let i = 0; i < tent; i++) {
      try {
        const r = await axios.get(ENDPOINT + path, { params, timeout: 30000, headers: { 'x-amz-access-token': await accessToken() } });
        return r.data;
      } catch (e) {
        const st = e.response?.status;
        if ((st === 429 || st >= 500) && i < tent - 1) { await delay(2000 * (i + 1)); continue; }
        const er = e.response?.data?.errors?.[0];
        throw new Error(path + ': ' + (er ? er.code + ' — ' + er.message : e.message));
      }
    }
  }

  /** Pedidos criados nos últimos `dias` (paginado). */
  async function pedidos(dias = 15, max = 2000) {
    const out = [];
    let next = null;
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    for (let pg = 0; pg < 40 && out.length < max; pg++) {
      const d = await get('/orders/v0/orders', next ? { MarketplaceIds: MARKETPLACE_BR, NextToken: next } : { MarketplaceIds: MARKETPLACE_BR, CreatedAfter: desde, MaxResultsPerPage: 100 });
      out.push(...(d.payload?.Orders || []));
      next = d.payload?.NextToken;
      if (!next) break;
      await delay(1100);   // limite da API de pedidos (~1 req/s)
    }
    return out;
  }

  // Cache de pedidos (a API de pedidos da Amazon libera ~1 consulta por minuto): renova no máx. a cada 5 min
  let _ped = null, _pedTs = 0, _pedProm = null;
  /** { abertos: [...], enviadosHoje: [...], todos15: [...] } */
  async function pedidosCache(forcar) {
    if (!forcar && _ped && Date.now() - _pedTs < 5 * 60e3) return _ped;
    if (_pedProm) return _pedProm;
    _pedProm = (async () => {
      const todos = await pedidos(15);
      const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      const dia = iso => iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : '';
      // Envios Fácil (DBA): ao gerar a etiqueta a Amazon já marca "Shipped", mas o pacote ainda está com você
      // aguardando coleta (EasyShipShipmentStatus = PendingPickUp / PendingDropOff) → empacotado.
      const AGUARDA_COLETA = ['PendingPickUp', 'PendingDropOff'];
      const mfn = todos.filter(o => o.FulfillmentChannel !== 'AFN');
      const empacotados = mfn.filter(o => AGUARDA_COLETA.includes(o.EasyShipShipmentStatus) && o.OrderStatus !== 'Canceled');
      const abertos = mfn.filter(o => ['Unshipped', 'PartiallyShipped'].includes(o.OrderStatus) && !AGUARDA_COLETA.includes(o.EasyShipShipmentStatus));
      const enviadosHoje = mfn.filter(o => o.OrderStatus === 'Shipped' && !AGUARDA_COLETA.includes(o.EasyShipShipmentStatus) && dia(o.LastUpdateDate) === hoje);
      _ped = { abertos, empacotados, enviadosHoje, todos, em: Date.now() };
      _pedTs = Date.now();
      return _ped;
    })().finally(() => { _pedProm = null; });
    return _pedProm;
  }

  async function post(path, body, tent = 4) {
    for (let i = 0; i < tent; i++) {
      try {
        return (await axios.post(ENDPOINT + path, body, { timeout: 30000, headers: { 'x-amz-access-token': await accessToken(), 'Content-Type': 'application/json' } })).data;
      } catch (e) {
        const st = e.response?.status;
        if ((st === 429 || st >= 500) && i < tent - 1) { await delay(3000 * (i + 1)); continue; }
        const er = e.response?.data?.errors?.[0];
        throw new Error(path + ': ' + (er ? er.code + ' — ' + er.message : e.message));
      }
    }
  }

  /** Pede um relatório, espera ficar pronto e devolve o texto (TSV). */
  async function relatorio(tipo, maxEspera = 300e3) {
    const c = await post('/reports/2021-06-30/reports', { reportType: tipo, marketplaceIds: [MARKETPLACE_BR] });
    const t0 = Date.now();
    let r;
    do {
      await delay(15000);
      r = await get('/reports/2021-06-30/reports/' + c.reportId);
      if (['CANCELLED', 'FATAL'].includes(r.processingStatus)) throw new Error('relatório ' + tipo + ': ' + r.processingStatus);
    } while (r.processingStatus !== 'DONE' && Date.now() - t0 < maxEspera);
    if (r.processingStatus !== 'DONE') throw new Error('relatório ' + tipo + ' demorou demais');
    const doc = await get('/reports/2021-06-30/documents/' + r.reportDocumentId);
    const bin = (await axios.get(doc.url, { responseType: 'arraybuffer', timeout: 60000 })).data;
    const buf = doc.compressionAlgorithm === 'GZIP' ? require('zlib').gunzipSync(Buffer.from(bin)) : Buffer.from(bin);
    // relatórios do BR vêm em UTF-8 ou Latin-1
    let txt = buf.toString('utf8');
    if (txt.includes('\uFFFD')) txt = buf.toString('latin1');
    return txt;
  }
  const tsv = txt => {
    const [cab, ...ls] = txt.split(/\r?\n/).filter(Boolean);
    const h = cab.split('\t');
    return ls.map(l => { const v = l.split('\t'); return Object.fromEntries(h.map((k, i) => [k, v[i]])); });
  };

  /** Ofertas de até 20 ASINs (Buy Box, ganhador, menor preço). */
  async function ofertas(asins) {
    const requests = asins.slice(0, 20).map(a => ({ uri: '/products/pricing/v0/items/' + a + '/offers', method: 'GET', MarketplaceId: MARKETPLACE_BR, ItemCondition: 'New', CustomerType: 'Consumer' }));
    const d = await post('/batches/products/pricing/v0/itemOffers', { requests });
    return d.responses || [];
  }

  /** Imagem e título de até 20 ASINs (Catalog Items). */
  async function catalogo(asins) {
    const d = await get('/catalog/2022-04-01/items', { identifiers: asins.slice(0, 20).join(','), identifiersType: 'ASIN', marketplaceIds: MARKETPLACE_BR, includedData: 'images,summaries' });
    const out = {};
    for (const it of d.items || []) {
      const imgs = (it.images?.[0]?.images || []).filter(i => i.variant === 'MAIN');
      const img = imgs.sort((a, b) => Math.abs(a.width - 300) - Math.abs(b.width - 300))[0] || it.images?.[0]?.images?.[0];
      out[it.asin] = { img: img?.link || null, titulo: it.summaries?.[0]?.itemName || null };
    }
    return out;
  }

  /** Tarifas da Amazon (comissão, tarifa fixa, FBA) para vários preços de uma vez. itens: [{asin, preco, fba, id}] */
  async function tarifas(itens) {
    const body = itens.slice(0, 20).map(i => ({
      FeesEstimateRequest: { MarketplaceId: MARKETPLACE_BR, IsAmazonFulfilled: !!i.fba, Identifier: i.id,
        PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'BRL', Amount: Number(i.preco.toFixed(2)) }, Shipping: { CurrencyCode: 'BRL', Amount: 0 } } },
      IdType: 'ASIN', IdValue: i.asin,
    }));
    const d = await post('/products/fees/v0/feesEstimate', body);
    const out = {};
    for (const r of Array.isArray(d) ? d : []) {
      const id = r.FeesEstimateIdentifier?.SellerInputIdentifier;
      const fe = r.FeesEstimate;
      if (!id) continue;
      if (r.Status !== 'Success' || !fe) { out[id] = { erro: r.Error?.Message || r.Status }; continue; }
      const det = {};
      for (const f of fe.FeeDetailList || []) det[f.FeeType] = (f.FinalFee?.Amount ?? f.FeeAmount?.Amount ?? 0);
      out[id] = { total: fe.TotalFeesEstimate?.Amount ?? 0, det };
    }
    return out;
  }

  /**
   * Histórico financeiro (últimos `dias`) por SKU: comissão %, outras tarifas por unidade e frete por unidade
   * (MFNPostageFee = frete do Envios Fácil/DBA, cobrado por pedido e rateado pelas unidades do pedido).
   */
  async function historicoTarifas(dias = 60) {
    const ev = { ship: [], serv: [] };
    let next = null;
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    const t0 = Date.now();
    for (let pg = 0; pg < 40 && Date.now() - t0 < 6 * 60e3; pg++) {
      const d = await get('/finances/v0/financialEvents', next ? { NextToken: next } : { PostedAfter: desde, MaxResultsPerPage: 100 });
      const fe = d.payload?.FinancialEvents || {};
      ev.ship.push(...(fe.ShipmentEventList || []));
      ev.serv.push(...(fe.ServiceFeeEventList || []));
      next = d.payload?.NextToken;
      if (!next) break;
      await delay(2100);
    }
    const amt = x => Number(x?.CurrencyAmount ?? x?.Amount ?? 0);
    const sku = {}, unidPedido = {}, skusPedido = {}, valorPedido = {};
    for (const s of ev.ship) for (const it of s.ShipmentItemList || []) {
      const q = it.QuantityShipped || 1, k = it.SellerSKU;
      const princ = (it.ItemChargeList || []).filter(c => c.ChargeType === 'Principal').reduce((a, c) => a + amt(c.ChargeAmount), 0);
      let com = 0, outras = 0;
      for (const f of it.ItemFeeList || []) { const v = -amt(f.FeeAmount); if (f.FeeType === 'Commission') com += v; else outras += v; }
      const S = sku[k] ||= { princ: 0, com: 0, outras: 0, unid: 0, frete: 0, pedidos: 0 };
      S.princ += princ; S.com += com; S.outras += outras; S.unid += q; S.pedidos++;
      unidPedido[s.AmazonOrderId] = (unidPedido[s.AmazonOrderId] || 0) + q;
      valorPedido[s.AmazonOrderId] = (valorPedido[s.AmazonOrderId] || 0) + princ;
      (skusPedido[s.AmazonOrderId] ||= []).push([k, q]);
    }
    let freteTot = 0, fretePed = 0;
    // frete médio por faixa de valor do pedido (a tarifa do Envios Fácil muda com o preço)
    const FAIXAS = [30, 50, 79, 120, 200, Infinity], fx = FAIXAS.map(() => ({ t: 0, n: 0 }));
    const faixa = v => FAIXAS.findIndex(l => v < l);
    for (const s of ev.serv) {
      const v = (s.FeeList || []).filter(f => /Postage|Shipping/i.test(f.FeeType)).reduce((a, f) => a - amt(f.FeeAmount), 0);
      if (!v || !s.AmazonOrderId) continue;
      freteTot += v; fretePed++;
      if (valorPedido[s.AmazonOrderId] != null) { const f = fx[faixa(valorPedido[s.AmazonOrderId])]; f.t += v; f.n++; }
      const tot = unidPedido[s.AmazonOrderId];
      for (const [k, q] of skusPedido[s.AmazonOrderId] || []) if (sku[k] && tot) sku[k].frete += v * q / tot;
    }
    const out = {};
    for (const [k, S] of Object.entries(sku)) if (S.unid) out[k] = {
      comPct: S.princ ? S.com / S.princ : null, outrasUn: S.outras / S.unid, freteUn: S.frete / S.unid, unid: S.unid, pedidos: S.pedidos };
    const freteFaixas = FAIXAS.map((l, i) => ({ ate: l === Infinity ? null : l, medio: fx[i].n ? fx[i].t / fx[i].n : null, pedidos: fx[i].n }));
    return { porSku: out, freteMedioPedido: fretePed ? freteTot / fretePed : null, pedidosComFrete: fretePed, freteFaixas, dias };
  }

  // ID do vendedor (Merchant Token): a estimativa de tarifas devolve no identificador
  let _seller = null;
  async function sellerId(asin) {
    if (_seller) return _seller;
    if (process.env['AMAZON_' + L.env + '_SELLER_ID']) return (_seller = process.env['AMAZON_' + L.env + '_SELLER_ID'].trim());
    const d = await post('/products/fees/v0/feesEstimate', [{ FeesEstimateRequest: { MarketplaceId: MARKETPLACE_BR, IsAmazonFulfilled: false, Identifier: 'seller',
      PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'BRL', Amount: 50 }, Shipping: { CurrencyCode: 'BRL', Amount: 0 } } }, IdType: 'ASIN', IdValue: asin }]);
    const id = (Array.isArray(d) ? d : [])[0]?.FeesEstimateIdentifier?.SellerId;
    if (!id) throw new Error('não consegui descobrir o ID de vendedor da Amazon');
    return (_seller = id);
  }
  /** Muda a quantidade (envio pelo vendedor / DBA, não FBA) de um SKU pela Listings API. */
  async function atualizarEstoque(sku, asin, qtd) {
    const seller = await sellerId(asin);
    const base = '/listings/2021-08-01/items/' + encodeURIComponent(seller) + '/' + encodeURIComponent(sku);
    const it = await get(base, { marketplaceIds: MARKETPLACE_BR, includedData: 'summaries' });
    const productType = it.summaries?.[0]?.productType;
    if (!productType) throw new Error('Amazon não devolveu o tipo do produto do SKU ' + sku);
    for (let i = 0; i < 4; i++) {
      try {
        const r = await axios.patch(ENDPOINT + base, { productType, patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: qtd }] }] },
          { params: { marketplaceIds: MARKETPLACE_BR }, timeout: 30000, headers: { 'x-amz-access-token': await accessToken(), 'Content-Type': 'application/json' } });
        if (r.data?.status && r.data.status !== 'ACCEPTED') throw new Error('Amazon recusou: ' + (r.data.issues || []).map(x => x.message).join('; ').slice(0, 200));
        return r.data;
      } catch (e) {
        const st = e.response?.status;
        if ((st === 429 || st >= 500) && i < 3) { await delay(3000 * (i + 1)); continue; }
        const er = e.response?.data?.errors?.[0];
        throw er ? new Error('Amazon: ' + er.code + ' — ' + er.message) : e;
      }
    }
  }

  async function participacoes() { return (await get('/sellers/v1/marketplaceParticipations')).payload || []; }

  return { chave, nome: L.nome, configurada, get, post, relatorio, tsv, ofertas, catalogo, tarifas, historicoTarifas, pedidos, pedidosCache, participacoes, atualizarEstoque, MARKETPLACE_BR };
}

const _l = {};
const loja = k => _l[k] ||= criar(k);
module.exports = { loja, LOJAS, MARKETPLACE_BR };
