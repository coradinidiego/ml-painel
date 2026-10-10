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
const SANDBOX = true; // Mude para false ao fazer Go Live

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

async function shopeeGet(apiPath, extraParams = {}) {
  const tokens = getTokens();
  if (!tokens.access_token) throw new Error('Sem autenticação Shopee');
  const params = { ...commonParams(apiPath, tokens.access_token, tokens.shop_id), ...extraParams };
  const r = await axios.get(BASE_URL + apiPath, { params });
  return r.data;
}

async function shopeePost(apiPath, body) {
  const tokens = getTokens();
  if (!tokens.access_token) throw new Error('Sem autenticação Shopee');
  const params = commonParams(apiPath, tokens.access_token, tokens.shop_id);
  const r = await axios.post(BASE_URL + apiPath, body, { params });
  return r.data;
}

// ─── Produtos ────────────────────────────────────────────────────────────────

async function getProducts(offset = 0) {
  return shopeeGet('/api/v2/product/get_item_list', {
    offset, page_size: 50, item_status: 'NORMAL',
  });
}

async function getProductDetails(itemIds) {
  return shopeeGet('/api/v2/product/get_item_base_info', {
    item_id_list: itemIds.join(','),
  });
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────

async function getOrders() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - (15 * 24 * 3600); // últimos 15 dias
  return shopeeGet('/api/v2/order/get_order_list', {
    time_range_field: 'create_time',
    time_from: from,
    time_to: to,
    page_size: 50,
    response_optional_fields: 'order_status',
  });
}

async function getOrderDetails(orderSns) {
  return shopeeGet('/api/v2/order/get_order_detail', {
    order_sn_list: orderSns.join(','),
    response_optional_fields: 'item_list,total_amount,order_status,buyer_username,pay_time',
  });
}

// ─── Avaliações ──────────────────────────────────────────────────────────────

async function getRatings(offset = 0) {
  return shopeeGet('/api/v2/product/get_rating_list', { offset, limit: 50 });
}

async function replyRating(ratingId, comment) {
  return shopeePost('/api/v2/product/reply_rating', {
    rating_id: ratingId,
    comment,
  });
}

module.exports = {
  getAuthUrl, getToken, refreshToken,
  saveTokens, getTokens,
  getProducts, getProductDetails,
  getOrders, getOrderDetails,
  getRatings, replyRating,
};
