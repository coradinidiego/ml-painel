/**
 * Shopee Open Platform - Módulo de integração
 * Conta: Zagodini
 */
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

const PARTNER_ID  = parseInt(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const REDIRECT_URL = process.env.SHOPEE_REDIRECT_URL;
// Ambiente: produção por padrão. Para usar o sandbox (lojas de teste da Shopee), defina SHOPEE_SANDBOX=true no Railway.
const SANDBOX = String(process.env.SHOPEE_SANDBOX || '').toLowerCase() === 'true';

const BASE_URL = SANDBOX
  ? 'https://partner.test-stable.shopeemobile.com'
  : 'https://partner.shopeemobile.com';

const TOKEN_FILE = './shopee_tokens.json';

// ─── Utilitários ─────────────────────────────────────────────────────────────

function sign(apiPath, timestamp, accessToken = '', shopId = 0) {
  let base = `${PARTNER_ID}${apiPath}${timestamp}`;
  if (shopId) base += `${accessToken}${shopId}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(base).digest('hex');
}

function commonParams(apiPath, accessToken = '', shopId = 0) {
  const ts = Math.floor(Date.now() / 1000);
  const params = {
    partner_id: PARTNER_ID,
    timestamp: ts,
    sign: sign(apiPath, ts, accessToken, shopId),
  };
  if (shopId) {
    params.access_token = accessToken;
    params.shop_id = shopId;
  }
  return params;
}

function getTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE)); }
  catch (e) { return {}; }
}

function saveTokens(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

// ─── Autenticação ─────────────────────────────────────────────────────────────

function getAuthUrl() {
  const apiPath = '/api/v2/shop/auth_partner';
  const ts = Math.floor(Date.now() / 1000);
  const s = sign(apiPath, ts);
  return `${BASE_URL}${apiPath}?partner_id=${PARTNER_ID}&timestamp=${ts}&sign=${s}&redirect=${encodeURIComponent(REDIRECT_URL)}`;
}

async function getToken(code, shopId) {
  const apiPath = '/api/v2/auth/token/get';
  const params = commonParams(apiPath);
  const r = await axios.post(BASE_URL + apiPath, {
    code, shop_id: parseInt(shopId), partner_id: PARTNER_ID
  }, { params });
  return r.data;
}

async function refreshToken() {
  const tokens = getTokens();
  if (!tokens.refresh_token) throw new Error('Sem refresh_token salvo');
  const apiPath = '/api/v2/auth/access_token/get';
  const params = commonParams(apiPath);
  const r = await axios.post(BASE_URL + apiPath, {
    refresh_token: tokens.refresh_token,
    shop_id: tokens.shop_id,
    partner_id: PARTNER_ID,
  }, { params });
  if (r.data.access_token) {
    saveTokens({ ...tokens, access_token: r.data.access_token, refresh_token: r.data.refresh_token });
    console.log(new Date().toLocaleTimeString('pt-BR') + ' - Shopee: token renovado!');
  }
  return r.data;
}

// ─── Helpers de requisição ───────────────────────────────────────────────────
// A Shopee responde 200 com { error, message } quando algo dá errado — vira exceção com a mensagem dela.
function checar(apiPath, d) {
  if (d && d.error) throw new Error(`${apiPath}: ${d.error}${d.message ? ' — ' + d.message : ''}`);
  return d;
}
function erroAxios(apiPath, e) {
  const b = e.response?.data;
  if (b && (b.error || b.message)) return new Error(`${apiPath}: ${b.error || ''}${b.message ? ' — ' + b.message : ''}`);
  return new Error(`${apiPath}: ${e.message}`);
}

async function shopeeGet(apiPath, extraParams = {}) {
  const tokens = getTokens();
  if (!tokens.access_token) throw new Error('Sem autenticação Shopee');
  const params = { ...commonParams(apiPath, tokens.access_token, tokens.shop_id), ...extraParams };
  try { return checar(apiPath, (await axios.get(BASE_URL + apiPath, { params, timeout: 30000 })).data); }
  catch (e) { throw e.response ? erroAxios(apiPath, e) : e; }
}

async function shopeePost(apiPath, body) {
  const tokens = getTokens();
  if (!tokens.access_token) throw new Error('Sem autenticação Shopee');
  const params = commonParams(apiPath, tokens.access_token, tokens.shop_id);
  try { return checar(apiPath, (await axios.post(BASE_URL + apiPath, body, { params, timeout: 30000 })).data); }
  catch (e) { throw e.response ? erroAxios(apiPath, e) : e; }
}

// ─── Produtos ────────────────────────────────────────────────────────────────

/** Todos os produtos ativos, com detalhes (nome, preço, estoque, imagem). */
async function listarProdutos(max = 2000) {
  const ids = [];
  for (let offset = 0; ids.length < max;) {
    const d = await shopeeGet('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: 'NORMAL' });
    ids.push(...(d.response?.item || []).map(i => i.item_id));
    if (!d.response?.has_next_page) break;
    offset = d.response.next_offset;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await shopeeGet('/api/v2/product/get_item_base_info', { item_id_list: ids.slice(i, i + 50).join(',') });
    out.push(...(d.response?.item_list || []));
  }
  return out;
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────

/** Pedidos criados nos últimos `dias` (máx. 15, limite da Shopee por consulta), com detalhes. */
async function listarPedidos(dias = 15) {
  const to = Math.floor(Date.now() / 1000), from = to - dias * 24 * 3600;
  const sns = [];
  let cursor = '';
  for (let pg = 0; pg < 50; pg++) {
    const d = await shopeeGet('/api/v2/order/get_order_list', {
      time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor,
      response_optional_fields: 'order_status',
    });
    sns.push(...(d.response?.order_list || []).map(o => o.order_sn));
    if (!d.response?.more) break;
    cursor = d.response.next_cursor;
  }
  const out = [];
  for (let i = 0; i < sns.length; i += 50) {
    const d = await shopeeGet('/api/v2/order/get_order_detail', {
      order_sn_list: sns.slice(i, i + 50).join(','),
      response_optional_fields: 'buyer_username,pay_time,item_list,total_amount,shipping_carrier,ship_by_date',
    });
    out.push(...(d.response?.order_list || []));
  }
  return out.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
}

// ─── Avaliações ──────────────────────────────────────────────────────────────

/** Avaliações recentes da loja, no formato que o painel usa. */
async function listarAvaliacoes(max = 200) {
  const out = [];
  let cursor = '';
  while (out.length < max) {
    const d = await shopeeGet('/api/v2/product/get_comment', { cursor, page_size: 100 });
    for (const c of d.response?.item_comment_list || []) out.push({
      rating_id: c.comment_id, item_id: c.item_id, rating_star: c.rating_star || 0, create_time: c.create_time,
      buyer_username: c.buyer_username, comment_list: c.comment ? [c.comment] : [], comment: c.comment_reply?.reply || '',
    });
    if (!d.response?.more) break;
    cursor = d.response.next_cursor;
  }
  return out;
}

async function replyRating(ratingId, comment) {
  return shopeePost('/api/v2/product/reply_comment', { comment_list: [{ comment_id: Number(ratingId), comment }] });
}

module.exports = { SANDBOX, BASE_URL,
  getAuthUrl, getToken, refreshToken,
  saveTokens, getTokens,
  listarProdutos, listarPedidos, listarAvaliacoes, replyRating, shopeeGet,
};
