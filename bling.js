/**
 * Bling API v3 - OAuth2
 */
const axios = require('axios');
const fs    = require('fs');
const crypto = require('crypto');

// Credenciais por índice de conta (mesmo índice que ML: 0=Zagodini, 1=Mae, 2=Lufe)
const CREDENCIAIS = {
  0: { id: process.env.BLING_ZAGODINI_ID,     secret: process.env.BLING_ZAGODINI_SECRET }, // Zagodini
  1: { id: process.env.BLING_MAE_ID,          secret: process.env.BLING_MAE_SECRET },      // Mae
};

const REDIRECT_URI  = process.env.BLING_REDIRECT_URI || 'http://localhost:3000/bling/callback';
const BASE          = 'https://www.bling.com.br/Api/v3';  // OAuth (authorize + token)
const API_BASE      = 'https://api.bling.com.br/Api/v3';    // Dados (pedidos, produtos, etc.)
const TOKEN_FILE    = './bling_tokens.json';

// ─── Tokens ──────────────────────────────────────────────────────────────────

function getTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE)); }
  catch(e) { return {}; }
}

function saveTokens(idx, data) {
  const all = getTokens();
  all[idx] = data;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2));
}

function getToken(idx) {
  return getTokens()[idx];
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getCreds(idx) {
  const c = CREDENCIAIS[idx];
  if (!c) throw new Error('Credenciais Bling não configuradas para idx ' + idx);
  return c;
}

function getAuthUrl(idx) {
  const { id } = getCreds(idx);
  const state = idx + '_' + crypto.randomBytes(4).toString('hex');
  return `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${id}&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
}

function basicAuth(idx) {
  const { id, secret } = getCreds(idx);
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function exchangeCode(code, idx) {
  const r = await axios.post(`${BASE}/oauth/token`,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }).toString(),
    { headers: { Authorization: basicAuth(idx), 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return r.data;
}

async function refreshToken(idx) {
  const t = getToken(idx);
  if (!t?.refresh_token) throw new Error('Sem refresh_token para conta ' + idx);
  const r = await axios.post(`${BASE}/oauth/token`,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }).toString(),
    { headers: { Authorization: basicAuth(idx), 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  saveTokens(idx, { ...t, access_token: r.data.access_token, refresh_token: r.data.refresh_token });
  console.log('Bling conta ' + idx + ': token renovado!');
  return r.data;
}

// ─── API ──────────────────────────────────────────────────────────────────────

function client(idx) {
  const t = getToken(idx);
  if (!t?.access_token) throw new Error('Bling conta ' + idx + ' não autorizada');
  const instance = axios.create({ baseURL: API_BASE, headers: { Authorization: 'Bearer ' + t.access_token } });

  // Auto-refresh: se a API devolver 401, renova o token e tenta de novo (uma vez)
  instance.interceptors.response.use(null, async (error) => {
    if (error.response?.status === 401 && !error.config._retry) {
      error.config._retry = true;
      try {
        const refreshed = await refreshToken(idx);
        error.config.headers['Authorization'] = 'Bearer ' + refreshed.access_token;
        return axios(error.config);
      } catch(e) {
        // Se o refresh falhar também, propaga o erro original
      }
    }
    throw error;
  });

  return instance;
}

async function getDepositos(idx) {
  const c = client(idx);
  try {
    const r = await c.get('/depositos');
    return r.data?.data || [];
  } catch(e) { return []; }
}

async function getProdutosComEstoque(idx, onProgress) {
  const c = client(idx);

  // Busca depósitos para identificar FULL e Geral
  const depositos = await getDepositos(idx);
  const depFull  = depositos.find(d => /full/i.test(d.descricao));
  const depGeral = depositos.find(d => /geral/i.test(d.descricao) || /principal/i.test(d.descricao));

  // Busca todos os produtos
  const todos = [];
  let pagina = 1;
  while (true) {
    const r = await c.get('/produtos', { params: { limite: 100, pagina, criterio: 1 } });
    const items = r.data?.data || [];
    todos.push(...items);
    if (items.length < 100) break;
    pagina++;
  }

  // Busca estoque por depósito para cada produto
  const resultado = [];
  for (let i = 0; i < todos.length; i++) {
    const p = todos[i];
    if (onProgress) onProgress(i + 1, todos.length);

    let estoqueFull  = 0;
    let estoqueGeral = 0;

    try {
      const re = await c.get(`/estoques/${p.id}`);
      const saldos = re.data?.data?.saldosEstoquePorDeposito || [];
      for (const s of saldos) {
        if (depFull  && s.deposito?.id === depFull.id)  estoqueFull  = parseFloat(s.saldoVirtual ?? s.saldoFisico ?? 0) || 0;
        if (depGeral && s.deposito?.id === depGeral.id) estoqueGeral = parseFloat(s.saldoVirtual ?? s.saldoFisico ?? 0) || 0;
      }
      // fallback: se não achou por ID, tenta por nome
      if (!depFull || !depGeral) {
        for (const s of saldos) {
          const nome = s.deposito?.descricao || '';
          if (/full/i.test(nome))                              estoqueFull  = parseFloat(s.saldoVirtual ?? s.saldoFisico ?? 0) || 0;
          if (/geral/i.test(nome) || /principal/i.test(nome)) estoqueGeral = parseFloat(s.saldoVirtual ?? s.saldoFisico ?? 0) || 0;
        }
      }
    } catch(e) {}

    resultado.push({
      id:           p.id,
      nome:         p.nome,
      codigo:       p.codigo,
      estoque:      parseFloat(p.estoque?.saldoVirtualTotal ?? 0) || 0,
      estoqueFull,
      estoqueGeral,
    });
  }

  return resultado;
}

// ─── Pedidos / Apuração ───────────────────────────────────────────────────────

/**
 * Busca todos os pedidos de venda "Atendido" de um período.
 * @param {number} idx  0=Zagodini, 1=Mae
 * @param {string} dataInicial  "YYYY-MM-DD"
 * @param {string} dataFinal    "YYYY-MM-DD"
 * @returns {Promise<Array>} lista de pedidos com itens expandidos
 */
async function getPedidosVendas(idx, dataInicial, dataFinal) {
  const c = client(idx);
  const todos = [];
  let pagina = 1;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  while (true) {
    let items = null;
    // Retry em caso de 429
    for (let t = 0; t < 6; t++) {
      try {
        const r = await c.get('/pedidos/vendas', {
          params: {
            dataInicial,
            dataFinal,
            'situacoes[]': 9,   // 9 = Atendido
            limite: 100,
            pagina,
          },
        });
        items = r.data?.data || [];
        break;
      } catch(e) {
        if (e.response?.status === 429 && t < 5) {
          const espera = 5000 * Math.pow(2, t);
          console.warn(`[bling] 429 na lista pg=${pagina} — aguardando ${espera/1000}s`);
          await delay(espera);
        } else {
          throw e;
        }
      }
    }

    todos.push(...items);
    if (items.length < 100) break;
    pagina++;
    // Pausa entre páginas para não estourar o rate limit
    await delay(400);
  }

  return todos;
}

/**
 * Busca detalhe completo de um pedido de venda.
 * Necessário para obter taxas.taxaComissao (valor monetário) e custoFrete.
 */
async function getPedidoDetalhe(idx, pedidoId, tentativas = 6) {
  const c = client(idx);
  for (let t = 0; t < tentativas; t++) {
    try {
      const r = await c.get(`/pedidos/vendas/${pedidoId}`);
      return r.data?.data;
    } catch(e) {
      if (e.response?.status === 429 && t < tentativas - 1) {
        // Espera exponencial: 5s, 10s, 20s, 40s, 80s (base 5s)
        const espera = 5000 * Math.pow(2, t);
        console.warn(`[bling] 429 pedido ${pedidoId} — aguardando ${espera/1000}s (tent. ${t+1}/${tentativas})`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw e;
      }
    }
  }
}

/**
 * Busca canais de venda e retorna mapa { lojaId -> descricao }
 * Usado para identificar Amazon/Shein pelo loja.id do pedido.
 */
async function getCanaisVenda(idx) {
  const c = client(idx);
  const mapa = {};
  try {
    const r = await c.get('/canais-venda');
    for (const ch of (r.data?.data || [])) {
      if (ch.id) mapa[ch.id] = ch.descricao || ch.nome || String(ch.id);
    }
  } catch(e) { /* endpoint pode não existir em todas as contas */ }
  return mapa;
}

/**
 * Busca todos os produtos e retorna mapa { codigo -> precoCompra }
 * Usado para preencher custo de cada item na apuração.
 */
async function getCustosPorSku(idx) {
  const c = client(idx);
  const mapa = {};
  let pagina = 1;
  while (true) {
    const r = await c.get('/produtos', { params: { limite: 100, pagina } }); // sem criterio = todos
    const items = r.data?.data || [];
    for (const p of items) {
      if (p.codigo) {
        const custo = parseFloat(p.precoCusto ?? 0) || 0;
        mapa[p.codigo.trim()] = custo;
      }
    }
    if (items.length < 100) break;
    pagina++;
  }
  return mapa;
}

/** Composição dos produtos "com composição" (formato E) do Bling: { CODIGO_DO_KIT: [{ codigo, qtd }] } */
async function getKits(idx) {
  const c = client(idx), idCod = {}, kits = [];
  for (let pagina = 1; ; pagina++) {
    const r = await c.get('/produtos', { params: { limite: 100, pagina } });
    const items = r.data?.data || [];
    for (const p of items) { if (p.id && p.codigo) idCod[p.id] = p.codigo.trim(); if (p.formato === 'E' && p.codigo) kits.push(p); }
    if (items.length < 100) break;
    await new Promise(r => setTimeout(r, 350));
  }
  const mapa = {};
  for (const k of kits) {
    try {
      const P = (await c.get('/produtos/' + k.id)).data?.data || {};
      const comp = (P.estrutura?.componentes || []).map(x => ({ codigo: idCod[x.produto?.id] || x.produto?.codigo || null, qtd: parseFloat(x.quantidade) || 0 }))
        .filter(x => x.codigo && x.qtd > 0);
      if (comp.length) mapa[k.codigo.trim().toUpperCase()] = comp.map(x => ({ codigo: String(x.codigo).trim().toUpperCase(), qtd: x.qtd }));
    } catch (e) { if (e.response?.status === 429) await new Promise(r => setTimeout(r, 2000)); }
    await new Promise(r => setTimeout(r, 350));
  }
  return mapa;
}

module.exports = { getKits, client, getAuthUrl, exchangeCode, refreshToken, saveTokens, getToken, getProdutosComEstoque, getDepositos, getPedidosVendas, getPedidoDetalhe, getCustosPorSku, getCanaisVenda };
