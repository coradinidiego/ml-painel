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
  zagodini: { nome: 'Comercial Zagodini', env: 'ZAGODINI' },
  mae:      { nome: 'Com Amor de Mãe',    env: 'MAE' },
  lufe:     { nome: 'Lufe Casa & Decoração', env: 'LUFE' },
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
      const abertos = todos.filter(o => ['Unshipped', 'PartiallyShipped'].includes(o.OrderStatus) && o.FulfillmentChannel !== 'AFN');
      const enviadosHoje = todos.filter(o => o.OrderStatus === 'Shipped' && o.FulfillmentChannel !== 'AFN' && dia(o.LastUpdateDate) === hoje);
      _ped = { abertos, enviadosHoje, todos, em: Date.now() };
      _pedTs = Date.now();
      return _ped;
    })().finally(() => { _pedProm = null; });
    return _pedProm;
  }

  async function participacoes() { return (await get('/sellers/v1/marketplaceParticipations')).payload || []; }

  return { chave, nome: L.nome, configurada, get, pedidos, pedidosCache, participacoes, MARKETPLACE_BR };
}

const _l = {};
const loja = k => _l[k] ||= criar(k);
module.exports = { loja, LOJAS, MARKETPLACE_BR };
