const express = require('express');
const axios = require('axios');
const https = require('https');
const fs   = require('fs');
const path = require('path');

// Carrega variáveis do .env manualmente (sem dependência de dotenv)
try {
  const envPath = path.join(__dirname, '.env');
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch(e) { /* .env não encontrado */ }
const app = express();
// Estado (tokens, cache, planilhas) fica em DATA_DIR — caminhos relativos ('tokens.json') passam a apontar para lá
const DATA = require('./dados');
process.chdir(DATA);
const auth = require('./auth');
auth.montar(app);   // login obrigatório (quando há usuários configurados)
app.use(require('cors')());
app.use(express.json());
require('./telegram');
const shopeeBoost = require('./shopee-boost-server');
if (!process.env.DATA_DIR) shopeeBoost.start(); // boost depende do Chrome do Mac — desligado na nuvem
const shopee = require('./shopee');
const bling  = require('./bling');
const apuracao = require('./apuracao');
app.use('/apuracao', apuracao.router);
app.use('/apuracao-tiny', require('./tiny_apuracao').router); // Apuração LUFE (Tiny)
app.use('/tv', require('./tv').router); // Painel da TV (expedição)

// ─── Cache Shopee ──────────────────────────────────────────────────────────
let shopeeCache = null;
let shopeeStatus = 'aguardando';

async function carregarShopee() {
  const tokens = shopee.getTokens();
  if (!tokens.access_token) { shopeeStatus = 'sem_auth'; return; }
  shopeeStatus = 'carregando';
  try {
    // Produtos
    const prodList = await shopee.getProducts();
    const itemIds = (prodList.response?.item || []).map(i => i.item_id);
    let produtos = [];
    if (itemIds.length > 0) {
      const det = await shopee.getProductDetails(itemIds);
      produtos = det.response?.item_list || [];
    }
    // Pedidos
    const ordList = await shopee.getOrders();
    const orderSns = (ordList.response?.order_list || []).map(o => o.order_sn);
    let pedidos = [];
    if (orderSns.length > 0) {
      const ordDet = await shopee.getOrderDetails(orderSns);
      pedidos = ordDet.response?.order_list || [];
    }
    // Avaliações
    const ratList = await shopee.getRatings();
    const avaliacoes = ratList.response?.rating_list || [];

    shopeeCache = { produtos, pedidos, avaliacoes, ultimaAtualizacao: new Date().toLocaleTimeString('pt-BR') };
    shopeeStatus = 'pronto';
    console.log(new Date().toLocaleTimeString('pt-BR') + ' - Shopee: carregado!');
  } catch (e) {
    shopeeStatus = 'erro';
    console.log('Shopee erro: ' + e.message);
  }
}

const BASE = 'https://api.mercadolibre.com';
const logos = require('./logos.json');

const CONTAS = [
  { nome: 'Zagodini', cid: process.env.ML_ZAGODINI_CID, secret: process.env.ML_ZAGODINI_SECRET },
  { nome: 'Mae',      cid: process.env.ML_MAE_CID,      secret: process.env.ML_MAE_SECRET },
  { nome: 'Lufe',     cid: process.env.ML_LUFE_CID,     secret: process.env.ML_LUFE_SECRET }
];

// Cache de dados por conta
const dadosCache = { 0: null, 1: null, 2: null };
const statusCache = { 0: 'aguardando', 1: 'aguardando', 2: 'aguardando' };
const progressoCache = { 0: {}, 1: {}, 2: {} };

function getTokens() {
  return JSON.parse(fs.readFileSync('tokens.json'));
}

function getToken(idx) {
  const t = getTokens();
  return t[CONTAS[idx].nome].token;
}

function renovarToken(conta, refresh) {
  return new Promise((resolve, reject) => {
    const data = 'grant_type=refresh_token&client_id='+conta.cid+'&client_secret='+conta.secret+'&refresh_token='+refresh;
    const req = https.request({
      hostname: 'api.mercadolibre.com', path: '/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.access_token) resolve({ token: j.access_token, refresh: j.refresh_token });
          else reject(b);
        } catch(e) { reject(e); }
      });
    });
    req.write(data); req.end();
  });
}

async function renovarTodos() {
  try {
    const tokens = getTokens();
    for (const conta of CONTAS) {
      try {
        const novo = await renovarToken(conta, tokens[conta.nome].refresh);
        tokens[conta.nome] = novo;
        console.log(new Date().toLocaleTimeString('pt-BR') + ' - ' + conta.nome + ': renovado!');
      } catch(e) { console.log('Erro ' + conta.nome); }
    }
    fs.writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));
  } catch(e) { console.log('Erro geral renovacao: ' + e); }
}

// Extrai SKU do item ML (seller_sku, seller_custom_field, ou array attributes)
function extrairSKU(it) {
  if (it.seller_sku) return it.seller_sku;
  if (it.seller_custom_field) return it.seller_custom_field;
  if (Array.isArray(it.attributes)) {
    const a = it.attributes.find(a => a.id === 'SELLER_SKU');
    if (a?.value_name) return a.value_name;
  }
  return null;
}

async function ml(idx, path, params) {
  const token = getToken(idx);
  const url = BASE + path + (params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '');
  const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + token } });
  return r.data;
}

async function carregarConta(idx) {
  statusCache[idx] = 'carregando';
  progressoCache[idx] = { conta: 0, cat: 0, promo: 0, perguntas: 0 };
  try {
    // Conectar
    const u = await ml(idx, '/users/me');
    const uid = u.id;
    const nickname = u.nickname || u.first_name;
    progressoCache[idx].conta = 1;

    // Totais ativos/pausados
    const [da, dp] = await Promise.all([
      ml(idx, '/users/'+uid+'/items/search', {status:'active',limit:1}),
      ml(idx, '/users/'+uid+'/items/search', {status:'paused',limit:1})
    ]);
    const ativos = da.paging?.total || 0;
    const pausados = dp.paging?.total || 0;

    // Perguntas
    const perg = await ml(idx, '/questions/search', {seller_id:uid, status:'UNANSWERED', limit:20});
    const perguntas = perg.questions || [];
    progressoCache[idx].perguntas = 1;

    // Catalogos
    let catIds = [], off = 0, catTotal = 9999;
    while (catIds.length < catTotal) {
      const d = await ml(idx, '/users/'+uid+'/items/search', {catalog_listing:true, limit:50, offset:off});
      if (off === 0) catTotal = d.paging?.total || 0;
      catIds = [...catIds, ...(d.results || [])];
      off += 50;
      if ((d.results || []).length < 50) break;
    }

    // Detalhes dos itens de catalogo
    const details = {};
    for (let i = 0; i < catIds.length; i += 20) {
      const chunk = catIds.slice(i, i+20);
      const det = await ml(idx, '/items', {ids:chunk.join(','), attributes:'id,title,price,thumbnail,seller_sku,attributes'});
      const list = Array.isArray(det) ? det : [det];
      list.forEach(w => { const it = w.body||w; it._sku = extrairSKU(it); details[it.id] = it; });
    }

    // Price to win
    const perdendo = [], ganhando = [], atualizando = [];
    let naoListados = 0;
    for (let i = 0; i < catIds.length; i++) {
      try {
        const ptw = await ml(idx, '/items/'+catIds[i]+'/price_to_win');
        const it = details[catIds[i]] || {id:catIds[i], title:catIds[i], price:0};
        it.current_price = ptw.current_price;
        it.price_to_win = ptw.price_to_win;
        it.winner_price = ptw.winner?.price;
        it.status_cat = ptw.status;
        it.visit_share = ptw.visit_share;
        it.catalog_product_id = ptw.catalog_product_id;
        it.diff = ptw.current_price && ptw.price_to_win ? (ptw.current_price - ptw.price_to_win) : 999;
        if (ptw.status === 'competing') perdendo.push(it);
        else if (ptw.status === 'winning') {
          try {
            if (ptw.catalog_product_id) {
              const comp = await ml(idx, '/products/'+ptw.catalog_product_id+'/items', {status:'active',limit:5});
              const others = (comp.results||[]).filter(r => r.seller_id != uid);
              if (others.length > 0) {
                const s2 = others.sort((a,b) => a.price-b.price)[0];
                it.s2price = s2.price;
                it.margem = s2.price - ptw.current_price;
              }
            }
          } catch(e2) {}
          ganhando.push(it);
        } else if (ptw.status === 'updating' || ptw.status === 'out_of_stock' || ptw.status) {
          atualizando.push(it);
        } else naoListados++;
      } catch(e) {}
      progressoCache[idx].cat = (i+1)/catIds.length;
    }

    // Sem promo
    let idsAtivos = [], off2 = 0, totalAtivos = 9999;
    while (idsAtivos.length < totalAtivos) {
      const da2 = await ml(idx, '/users/'+uid+'/items/search', {status:'active',limit:50,offset:off2});
      if (off2 === 0) totalAtivos = da2.paging?.total || 0;
      idsAtivos = [...idsAtivos, ...(da2.results||[])];
      off2 += 50;
      if ((da2.results||[]).length < 50) break;
    }

    let allItems = [];
    for (let i = 0; i < idsAtivos.length; i += 20) {
      const chunk = idsAtivos.slice(i, i+20);
      const det = await ml(idx, '/items', {ids:chunk.join(','), attributes:'id,title,price,original_price,thumbnail,catalog_listing,seller_sku,available_quantity,shipping,attributes'});
      const list = Array.isArray(det) ? det : [det];
      allItems = [...allItems, ...list.map(w=>{ const it=w.body||w; it._sku=extrairSKU(it); return it; })];
    }

    const catStatusMap = {};
perdendo.forEach(it => catStatusMap[it.id] = {status_cat:"competing"});
ganhando.forEach(it => catStatusMap[it.id] = {status_cat:"winning"});
const semPromo = [], comPromo = [];
    for (let i = 0; i < allItems.length; i++) {
      const it = allItems[i];
      try {
        const sp = await ml(idx, '/items/'+it.id+'/sale_price');
        const temPromo = sp.amount && sp.regular_amount && sp.amount < sp.regular_amount;
        if (temPromo) { it.sale_amount = sp.amount; comPromo.push(it); }
        else { if(catStatusMap[it.id]){it.status_cat=catStatusMap[it.id].status_cat;it.catalog_listing=true;} semPromo.push(it); }
      } catch(e) {
        if (!it.original_price) semPromo.push(it);
        else comPromo.push(it);
      }
      progressoCache[idx].promo = (i+1)/allItems.length;
    }

    perdendo.sort((a,b) => a.diff-b.diff);
    ganhando.sort((a,b) => (b.margem||0)-(a.margem||0));

    dadosCache[idx] = {
      uid, nickname,
      ativos, pausados,
      perguntas,
      perdendo, ganhando, atualizando,
      semPromo, comPromo,
      catTotal: catIds.length,
      naoListados,
      ultimaAtualizacao: new Date().toLocaleTimeString('pt-BR')
    };
    statusCache[idx] = 'pronto';
    progressoCache[idx] = { conta:1, cat:1, promo:1, perguntas:1 };
    console.log(new Date().toLocaleTimeString('pt-BR') + ' - ' + CONTAS[idx].nome + ': carregado!');
  } catch(e) {
    statusCache[idx] = 'erro';
    console.log('Erro conta ' + idx + ': ' + e.message);
  }
}

async function carregarTodas() {
  console.log(new Date().toLocaleTimeString('pt-BR') + ' - Iniciando carregamento de todas as contas...');
  await Promise.all([carregarConta(0), carregarConta(1), carregarConta(2)]);
  console.log(new Date().toLocaleTimeString('pt-BR') + ' - Todas as contas carregadas!');
}

// Endpoints
app.get('/logo/:n', (req, res) => {
  const d = logos[req.params.n];
  if (!d) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.send(Buffer.from(d, 'base64'));
});

app.get('/dados/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  res.json({
    status: statusCache[idx],
    progresso: progressoCache[idx],
    dados: dadosCache[idx]
  });
});

app.get('/api', async (req, res) => {
  try {
    const token = req.query._token || '';
    const p = req.query.path;
    const params = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'path' && k !== '_token'));
    const url = BASE + p + (Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '');
    const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + token } });
    res.json(r.data);
  } catch(e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

app.get('/recarregar/:idx', (req,res) => {
  const idx = parseInt(req.params.idx);
  statusCache[idx] = 'aguardando';
  carregarConta(idx);
  res.json({ok:true});
});

// ─── Rotas Shopee ──────────────────────────────────────────────────────────
app.get('/shopee/auth', (req, res) => {
  res.redirect(shopee.getAuthUrl());
});

app.get('/shopee/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) return res.send('<h2>❌ Parâmetros inválidos</h2>');
  try {
    const data = await shopee.getToken(code, parseInt(shop_id));
    shopee.saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, shop_id: parseInt(shop_id) });
    res.send('<h2 style="font-family:system-ui;padding:2rem">✅ Shopee autorizada com sucesso! <a href="/">Voltar ao painel</a></h2>');
    carregarShopee();
  } catch (e) {
    res.status(500).send('Erro: ' + e.message);
  }
});

app.get('/shopee/dados', (req, res) => {
  res.json({ status: shopeeStatus, dados: shopeeCache });
});

app.get('/shopee/recarregar', (req, res) => {
  shopeeStatus = 'aguardando';
  carregarShopee();
  res.json({ ok: true });
});

// ─── Rotas Bling OAuth ────────────────────────────────────────────────────
app.get('/bling/auth/:idx', (req, res) => {
  res.redirect(bling.getAuthUrl(parseInt(req.params.idx)));
});

app.get('/bling/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('<h2>❌ Código não recebido</h2>');
  const idx = parseInt((state||'0').split('_')[0]);
  const nomesConta = { 0: 'Zagodini', 1: 'Com Amor de Mae' };
  const nomeConta = nomesConta[idx] ?? `Conta ${idx}`;
  try {
    const data = await bling.exchangeCode(code, idx);
    console.log(`[bling/callback] idx=${idx} (${nomeConta}) access_token=${data.access_token ? 'OK' : 'AUSENTE'} refresh_token=${data.refresh_token ? 'OK' : 'AUSENTE'}`);
    if (!data.access_token) return res.status(500).send('Bling não retornou access_token: ' + JSON.stringify(data));
    bling.saveTokens(idx, { access_token: data.access_token, refresh_token: data.refresh_token });
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bling Autorizado</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5}
      .card{background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px #0001;max-width:400px}
      h2{color:#1e7e34;margin-bottom:8px}p{color:#555;margin-bottom:24px}
      a{display:inline-block;padding:12px 28px;background:#0d1b2a;color:white;border-radius:8px;text-decoration:none;font-weight:600}</style>
    </head><body><div class="card">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h2>Bling autorizado!</h2>
      <p>Conta: <strong>${nomeConta}</strong></p>
      <a href="/painel.html">← Voltar ao painel</a>
    </div></body></html>`);
  } catch(e) {
    console.error('[bling/callback] erro:', e.response?.data || e.message);
    res.status(500).send(`<h2>❌ Erro ao autorizar ${nomeConta}</h2><p>${e.message}</p><a href="/bling/auth/${idx}">Tentar novamente</a>`);
  }
});

// ─── Apuração via Bling API ───────────────────────────────────────────────

// Taxas de imposto por conta (Simples Nacional sobre faturamento)
// Carrega de impostos.json se existir, senão usa padrão
const IMPOSTOS_FILE = path.join(DATA, 'impostos.json');
let IMPOSTO_RATE = { 0: 0.11, 1: 0.09 };
try { IMPOSTO_RATE = { ...IMPOSTO_RATE, ...JSON.parse(fs.readFileSync(IMPOSTOS_FILE)) }; } catch(e) {}

app.get('/apuracao-bling/impostos', (req, res) => {
  res.json(IMPOSTO_RATE);
});
app.post('/apuracao-bling/impostos', express.json(), (req, res) => {
  const { 0: r0, 1: r1 } = req.body;
  if (r0 != null) IMPOSTO_RATE[0] = parseFloat(r0);
  if (r1 != null) IMPOSTO_RATE[1] = parseFloat(r1);
  fs.writeFileSync(IMPOSTOS_FILE, JSON.stringify(IMPOSTO_RATE));
  res.json({ ok: true, IMPOSTO_RATE });
});

// Custo fixo por SKU carregado das planilhas de precificação
let FIXO_JSON = { zagodini: { amazon: {}, shein: {} }, camae: { amazon: {}, shein: {} } };
let CUSTO_JSON = { zagodini: {}, camae: {} };

function recarregarJsonsCusto() {
  try {
    FIXO_JSON = JSON.parse(fs.readFileSync(path.join(DATA, 'fixo_por_sku.json')));
    console.log('[fixo_por_sku.json] carregado');
  } catch(e) { console.warn('[fixo_por_sku.json] não encontrado'); }
  try {
    CUSTO_JSON = JSON.parse(fs.readFileSync(path.join(DATA, 'custo_por_sku.json')));
    console.log('[custo_por_sku.json] carregado');
  } catch(e) { console.warn('[custo_por_sku.json] não encontrado'); }
}

recarregarJsonsCusto();

function getFixoMapAmazon(idx) {
  const conta = idx === 0 ? 'zagodini' : 'camae';
  return FIXO_JSON[conta]?.amazon || {};
}

function getFixoMapShein(idx) {
  const conta = idx === 0 ? 'zagodini' : 'camae';
  return FIXO_JSON[conta]?.shein || {};
}

// Tarifa fixa Amazon apenas para produtos < R$79 (acima disso usa freteGratis da planilha)
function fixoPorPreco(valorUnit) {
  if (valorUnit < 30)    return 4.50;  // < R$30
  if (valorUnit < 50)    return 6.50;  // R$30–49,99
  if (valorUnit <= 78.99) return 6.75; // R$50–78,99
  return 0; // acima de R$79: precisa de freteGratis da planilha
}

// Retorna custo fixo Amazon para um SKU e preço unitário
// Normaliza SKU: tenta exato, depois sem zeros à esquerda (ex: '00440027' → '440027')
function normalizarSku(mapa, sku) {
  if (!sku) return null;
  if (mapa[sku]) return mapa[sku];
  const semZeros = sku.replace(/^0+/, '') || sku; // evita esvaziar '0'
  if (mapa[semZeros]) return mapa[semZeros];
  return null;
}

// Custo fixo Amazon: até R$78,99 calcula por faixa de preço; acima disso usa coluna H (freteGratis) da planilha
function fixoAmazon(idx, sku, valUnit) {
  if (valUnit <= 78.99) return fixoPorPreco(valUnit);
  const mapa = getFixoMapAmazon(idx);
  const entrada = normalizarSku(mapa, sku);
  return entrada?.freteGratis ?? 0;
}

// ─── Cache de Apuração ────────────────────────────────────────────────────
const PASTA_CACHE_AP = path.join(DATA, 'apuracao_cache');
fs.mkdirSync(PASTA_CACHE_AP, { recursive: true });

function cacheFile(idx, dataInicial, dataFinal) {
  return path.join(PASTA_CACHE_AP, `ap_${idx}_${dataInicial}_${dataFinal}.json`);
}
function lerCache(idx, dataInicial, dataFinal) {
  try { return JSON.parse(fs.readFileSync(cacheFile(idx, dataInicial, dataFinal))); }
  catch(e) { return null; }
}
function salvarCache(idx, dataInicial, dataFinal, dados) {
  fs.writeFileSync(cacheFile(idx, dataInicial, dataFinal), JSON.stringify(dados));
}

// ─── Cache por dia (YYYY-MM-DD) ───────────────────────────────────────────
function dayFile(idx, dateIso) {
  return path.join(PASTA_CACHE_AP, `ap_day_${idx}_${dateIso}.json`);
}
function lerDiaCache(idx, dateIso) {
  try { return JSON.parse(fs.readFileSync(dayFile(idx, dateIso))).linhas; }
  catch(e) { return null; }
}
function salvarDiaCache(idx, dateIso, linhas) {
  fs.writeFileSync(dayFile(idx, dateIso), JSON.stringify({ geradoEm: new Date().toISOString(), linhas }));
}
// Enumera todas as datas YYYY-MM-DD entre ini e fim, inclusive
function enumDates(ini, fim) {
  const dates = [];
  const cur = new Date(ini + 'T12:00:00Z');
  const end = new Date(fim + 'T12:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}
// Retorna array de [iniGap, fimGap] para dias sem cache
function lacunasDias(idx, dates) {
  const gaps = []; let start = null;
  for (let i = 0; i < dates.length; i++) {
    const sem = lerDiaCache(idx, dates[i]) === null;
    if (sem && !start) start = dates[i];
    if (!sem && start) { gaps.push([start, dates[i - 1]]); start = null; }
  }
  if (start) gaps.push([start, dates[dates.length - 1]]);
  return gaps;
}
// Monta o objeto resultado final a partir das linhas já processadas
function montarResultadoLinhas(idx, dataInicial, dataFinal, linhas) {
  const totalFaturamento = linhas.reduce((s, l) => s + (l.valTotal || 0), 0);
  const lucrosBruto      = linhas.reduce((s, l) => s + (l.lucroFinal || 0), 0);
  const imposto          = totalFaturamento * (IMPOSTO_RATE[idx] ?? 0.09);
  const pedidosUnicos    = new Set(linhas.map(l => l.pedido)).size;
  return {
    ok: true, dataInicial, dataFinal,
    conta:       idx === 0 ? 'Zagodini' : 'Com Amor de Mae',
    impostoRate: IMPOSTO_RATE[idx] ?? 0.09,
    geradoEm:    new Date().toISOString(),
    linhas,
    resumo: {
      totalPedidos:     pedidosUnicos,
      totalLinhas:      linhas.length,
      totalFaturamento: Math.round(totalFaturamento * 100) / 100,
      lucrosBruto:      Math.round(lucrosBruto * 100) / 100,
      imposto:          Math.round(imposto * 100) / 100,
      lucroFinalTotal:  Math.round((lucrosBruto - imposto) * 100) / 100,
    },
  };
}

// Progresso de apuração por chave
const apuracaoProgress = {};
const apuracaoCancelados = new Set();
// Rastreia fetches em andamento por idx para evitar duas buscas simultâneas
const apuracaoEmAndamento = new Set();
// Geração por idx — evita que processo antigo apague lock do processo novo
const apuracaoGeneration = { 0: 0, 1: 0 };

app.get('/apuracao-progress', (req, res) => {
  const key = `${req.query.idx}-${req.query.ini}-${req.query.fim}`;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = () => {
    const p = apuracaoProgress[key] || { fase: 'aguardando', pct: 0 };
    res.write(`data: ${JSON.stringify(p)}\n\n`);
  };
  // Heartbeat a cada 15s para manter a conexão viva mesmo com tab em background
  const ping = () => res.write(': ping\n\n');
  send();
  const iv  = setInterval(send, 600);
  const hb  = setInterval(ping, 15000);
  req.on('close', () => { clearInterval(iv); clearInterval(hb); });
});

// Converte array de detalhes de pedidos em linhas de apuração
function _processarPedidosParaLinhas(detalhes, canaisMap, custoMapAm, custoMapSh, idx) {
  const linhas = [];
  for (const ped of detalhes) {
    const numLoja     = (ped.numeroLoja || '').trim();
    const lojaId      = ped.loja?.id || null;
    const lojaNomeApi = lojaId ? (canaisMap[lojaId] || '') : '';
    const isAmazon = /amazon/i.test(lojaNomeApi)
      || (!lojaNomeApi && (/^70[12]-/.test(numLoja) || /^AMZ/i.test(numLoja) || /^\d{3}-\d{7}-\d{7}$/.test(numLoja)));
    const isShein  = /shein/i.test(lojaNomeApi)
      || (!lojaNomeApi && /^GSH/i.test(numLoja));
    if (!isAmazon && !isShein) continue;
    const canal       = isAmazon ? 'Amazon' : 'Shein';
    const _dataIso    = (ped.data || '').split('T')[0] || '';
    const dataCriacao = ped.data ? new Date(ped.data).toLocaleDateString('pt-BR') : '';
    const dataFat     = ped.dataSaida || '';
    const comissaoTotalPedido = parseFloat(ped.taxas?.taxaComissao ?? 0) || 0;
    const freteTotalPedido    = parseFloat(ped.taxas?.custoFrete   ?? 0) || 0;
    const itens = ped.itens || [];
    const valorTotalPedido = itens.reduce((s, it) =>
      s + (parseFloat(it.valor) || 0) * (parseFloat(it.quantidade) || 1), 0);
    for (const item of itens) {
      const sku      = (item.codigo || '-').trim();
      const qty      = parseFloat(item.quantidade) || 1;
      const valUnit  = parseFloat(item.valor)      || 0;
      const valTotal = round2(valUnit * qty);
      const custoMap = isAmazon ? custoMapAm : custoMapSh;
      const custo    = parseFloat(item.precoCompra) || normalizarSku(custoMap, sku) || 0;
      const lucro    = valTotal - custo * qty;
      const proporcao  = valorTotalPedido > 0 ? valTotal / valorTotalPedido : 1 / Math.max(itens.length, 1);
      const taxaComVal = round2(comissaoTotalPedido * proporcao);
      const freteItem  = round2(freteTotalPedido * proporcao);
      let fixoUnit = 0;
      if (isAmazon)     fixoUnit = fixoAmazon(idx, sku, valUnit);
      else if (isShein) fixoUnit = normalizarSku(getFixoMapShein(idx), sku) ?? 0;
      const fixo       = round2(fixoUnit * qty);
      const lucroFinal = round2(lucro - taxaComVal - fixo - (isShein ? freteItem : 0));
      const pctLucro   = valTotal > 0 ? round2((lucroFinal / valTotal) * 100) : 0;
      linhas.push({
        _dataIso, codigoVenda: numLoja, pedido: ped.numero,
        situacao: ped.situacao?.valor || 'Atendido', canal, dataCriacao,
        dataFaturamento: dataFat, cliente: ped.contato?.nome || '', sku,
        descricao: item.descricao || '', quantidade: qty, precoUnit: valUnit,
        desconto: parseFloat(item.desconto) || 0, frete: freteItem, valTotal,
        precoCusto: round2(custo * qty), lucro: round2(lucro),
        taxaComissao: taxaComVal, fixo, lucroFinal, pctLucro,
      });
    }
  }
  return linhas;
}

// Função core que busca do Bling e processa — pode ser lenta (rate limit)
async function fetchApuracaoBling(idx, dataInicial, dataFinal, key) {
  if (apuracaoEmAndamento.has(idx)) {
    throw new Error(`Já existe uma apuração em andamento para esta conta. Aguarde terminar antes de iniciar outra.`);
  }
  apuracaoEmAndamento.add(idx);
  const gen = ++apuracaoGeneration[idx];
  try {
    return await _fetchApuracaoBlingImpl(idx, dataInicial, dataFinal, key);
  } finally {
    if (apuracaoGeneration[idx] === gen) apuracaoEmAndamento.delete(idx);
  }
}

// Busca com cache por dia: reutiliza dias já apurados, busca só os dias faltantes
async function buscarComCacheDia(idx, dataInicial, dataFinal, key) {
  const dates   = enumDates(dataInicial, dataFinal);
  const lacunas = lacunasDias(idx, dates);

  // Tudo em cache — retorna imediatamente
  if (lacunas.length === 0) {
    const linhas = dates.flatMap(d => lerDiaCache(idx, d) || []);
    return { ...montarResultadoLinhas(idx, dataInicial, dataFinal, linhas), doCache: true };
  }

  if (apuracaoEmAndamento.has(idx)) {
    throw new Error('Já existe uma apuração em andamento para esta conta. Aguarde terminar antes de iniciar outra.');
  }
  // Limpa cancelamento anterior antes de iniciar novo processo
  apuracaoCancelados.delete(key);
  apuracaoEmAndamento.add(idx);
  const gen = ++apuracaoGeneration[idx];

  // Só escreve progresso se ainda somos o processo atual — evita corrida com processo novo
  const setProgress = (val) => {
    if (apuracaoGeneration[idx] === gen) apuracaoProgress[key] = val;
  };
  // Verifica cancelamento pela geração OU pelo Set de cancelados
  const foiCancelado = () => {
    if (apuracaoGeneration[idx] !== gen) return true;
    if (apuracaoCancelados.has(key)) { apuracaoCancelados.delete(key); return true; }
    return false;
  };

  try {
    await bling.refreshToken(idx).catch(e => console.warn(`[apuracao] refresh idx=${idx} falhou:`, e.response?.data?.error || e.message));

    if (foiCancelado()) return null;

    const contaNome  = idx === 0 ? 'zagodini' : 'camae';
    const custoMapAm = CUSTO_JSON[contaNome]?.amazon || {};
    const custoMapSh = CUSTO_JSON[contaNome]?.shein  || {};

    const CACHE_24H       = 24 * 60 * 60 * 1000;
    const canaisCacheFile = path.join(PASTA_CACHE_AP, `canais_${idx}.json`);
    const lerCS  = f => { try { const d = JSON.parse(fs.readFileSync(f)); if (Date.now() - new Date(d._ts).getTime() < CACHE_24H) return d.dados; } catch(e) {} return null; };
    const salCS  = (f, d) => fs.writeFileSync(f, JSON.stringify({ _ts: new Date().toISOString(), dados: d }));

    let canaisMap = lerCS(canaisCacheFile);
    if (!canaisMap) {
      setProgress({ fase: 'Buscando canais de venda...', pct: 3 });
      canaisMap = await bling.getCanaisVenda(idx);
      salCS(canaisCacheFile, canaisMap);
    }

    if (foiCancelado()) return null;

    const idsAmazonShein = new Set(
      Object.entries(canaisMap)
        .filter(([, nome]) => /amazon|shein/i.test(nome))
        .map(([id]) => Number(id))
    );

    // Processa cada lacuna separadamente
    for (let gi = 0; gi < lacunas.length; gi++) {
      const [ini, fim] = lacunas[gi];
      const pctBase  = 8 + Math.round(gi / lacunas.length * 75);
      const pctSlice = Math.round(75 / lacunas.length);

      if (foiCancelado()) return null;
      setProgress({ fase: `Buscando pedidos ${ini} → ${fim}...`, pct: pctBase });
      const listaPedidos = await bling.getPedidosVendas(idx, ini, fim);

      if (foiCancelado()) return null;

      const listFiltrada = listaPedidos.filter(ped => {
        const lojaId = ped.loja?.id;
        if (lojaId && idsAmazonShein.has(lojaId)) return true;
        if (lojaId && idsAmazonShein.size > 0) return false;
        const n = (ped.numeroLoja || '').trim();
        return /^70[12]-/.test(n) || /^AMZ/i.test(n) || /^\d{3}-\d{7}-\d{7}$/.test(n) || /^GSH/i.test(n);
      });

      setProgress({
        fase: `${listaPedidos.length} pedidos (${ini}→${fim}) → ${listFiltrada.length} Amazon/Shein`,
        pct: pctBase + 1,
      });

      let feitos = 0;
      const detalhes = [];
      const falhos429 = [];

      for (let i = 0; i < listFiltrada.length; i++) {
        if (foiCancelado()) return null;
        let ped = null;
        try { ped = await bling.getPedidoDetalhe(idx, listFiltrada[i].id); }
        catch(e) { if (e.response?.status === 429) { falhos429.push(listFiltrada[i].id); console.warn(`[apuracao] 429 pedido ${listFiltrada[i].id}`); } }
        feitos++;
        setProgress({
          fase: `Detalhes (${ini}→${fim}): ${feitos}/${listFiltrada.length}${falhos429.length ? ` (${falhos429.length} retry)` : ''}`,
          pct: pctBase + 1 + Math.round((feitos / Math.max(listFiltrada.length, 1)) * (pctSlice - 2)),
        });
        if (ped) detalhes.push(ped);
        if (i < listFiltrada.length - 1) await new Promise(r => setTimeout(r, 700));
      }

      if (falhos429.length > 0) {
        setProgress({ fase: `${falhos429.length} com 429 — aguardando 90s...`, pct: pctBase + pctSlice - 1 });
        await new Promise(r => setTimeout(r, 90000));
        for (let j = 0; j < falhos429.length; j++) {
          if (foiCancelado()) return null;
          const ped = await bling.getPedidoDetalhe(idx, falhos429[j], 8).catch(() => null);
          if (ped) detalhes.push(ped);
          if (j < falhos429.length - 1) await new Promise(r => setTimeout(r, 1500));
        }
      }

      // Processa e salva cache por dia
      const novasLinhas = _processarPedidosParaLinhas(detalhes, canaisMap, custoMapAm, custoMapSh, idx);
      const porDia = {};
      for (const l of novasLinhas) { const d = l._dataIso || ini; (porDia[d] = porDia[d] || []).push(l); }
      for (const d of enumDates(ini, fim)) salvarDiaCache(idx, d, porDia[d] || []);
    }

    if (foiCancelado()) return null;
    setProgress({ fase: 'Calculando...', pct: 92 });
    const todasLinhas = dates.flatMap(d => lerDiaCache(idx, d) || []);
    const resultado = montarResultadoLinhas(idx, dataInicial, dataFinal, todasLinhas);

    setProgress({ fase: 'Concluído!', pct: 100 });
    setTimeout(() => { delete apuracaoProgress[key]; }, 5000);
    return resultado;

  } finally {
    if (apuracaoGeneration[idx] === gen) apuracaoEmAndamento.delete(idx);
  }
}

async function _fetchApuracaoBlingImpl(idx, dataInicial, dataFinal, key) {
  await bling.refreshToken(idx).catch(e => console.warn(`[apuracao] refresh idx=${idx} falhou:`, e.response?.data?.error || e.message));

  // Custo unitário vem das abas específicas de cada canal (Amazon ou Shein)
  const contaNome   = idx === 0 ? 'zagodini' : 'camae';
  const custoMapAm  = CUSTO_JSON[contaNome]?.amazon || {};
  const custoMapSh  = CUSTO_JSON[contaNome]?.shein  || {};

  // Canais de venda cacheados em disco por 24h
  const CACHE_24H = 24 * 60 * 60 * 1000;
  const canaisCacheFile = path.join(PASTA_CACHE_AP, `canais_${idx}.json`);

  function lerCacheSimples(arquivo) {
    try {
      const d = JSON.parse(fs.readFileSync(arquivo));
      if (Date.now() - new Date(d._ts).getTime() < CACHE_24H) return d.dados;
    } catch(e) {}
    return null;
  }
  function salvarCacheSimples(arquivo, dados) {
    fs.writeFileSync(arquivo, JSON.stringify({ _ts: new Date().toISOString(), dados }));
  }

  // Busca canais PRIMEIRO para poder filtrar a lista antes de ir um-a-um
  let canaisMap = lerCacheSimples(canaisCacheFile);
  if (!canaisMap) {
    apuracaoProgress[key] = { fase: 'Buscando canais de venda...', pct: 3 };
    canaisMap = await bling.getCanaisVenda(idx);
    salvarCacheSimples(canaisCacheFile, canaisMap);
  }

  apuracaoProgress[key] = { fase: 'Buscando lista de pedidos...', pct: 8 };
  const listaPedidos = await bling.getPedidosVendas(idx, dataInicial, dataFinal);

  // IDs dos canais Amazon e Shein — usados para filtrar a lista antes de buscar detalhes
  const idsAmazonShein = new Set(
    Object.entries(canaisMap)
      .filter(([, nome]) => /amazon|shein/i.test(nome))
      .map(([id]) => Number(id))
  );

  // Filtra a lista pelo loja.id ou, como fallback, pelo padrão do numeroLoja
  const listFiltrada = listaPedidos.filter(ped => {
    const lojaId = ped.loja?.id;
    if (lojaId && idsAmazonShein.has(lojaId)) return true;
    if (lojaId && idsAmazonShein.size > 0) return false; // canal identificado, mas não é Amazon/Shein
    // Fallback quando o loja.id não veio na lista
    const n = (ped.numeroLoja || '').trim();
    return /^70[12]-/.test(n) || /^AMZ/i.test(n) || /^\d{3}-\d{7}-\d{7}$/.test(n) || /^GSH/i.test(n);
  });

  apuracaoProgress[key] = {
    fase: `${listaPedidos.length} pedidos no período → ${listFiltrada.length} Amazon/Shein — buscando detalhes...`,
    pct: 15,
  };

  let feitos = 0;
  const detalhes = [];
  const falhos429 = []; // pedidos que falharam por rate limit após todos os retries
  for (let i = 0; i < listFiltrada.length; i++) {
    let ped = null;
    try {
      ped = await bling.getPedidoDetalhe(idx, listFiltrada[i].id);
    } catch(e) {
      if (e.response?.status === 429) {
        falhos429.push(listFiltrada[i].id);
        console.warn(`[apuracao] 429 esgotado para pedido ${listFiltrada[i].id} — será retentado ao final`);
      }
      // outros erros: ignora (pedido não encontrado, etc.)
    }
    feitos++;
    apuracaoProgress[key] = {
      fase: `Detalhes: ${feitos}/${listFiltrada.length}${falhos429.length ? ` (${falhos429.length} aguardando retry)` : ''}`,
      pct: Math.round(15 + (feitos / listFiltrada.length) * 70),
    };
    if (ped) detalhes.push(ped);
    if (apuracaoCancelados.has(key)) { apuracaoCancelados.delete(key); break; }
    // Pausa entre cada chamada — respeita rate limit do Bling
    if (i < listFiltrada.length - 1) await new Promise(r => setTimeout(r, 700));
  }

  // Retry dos pedidos que falharam por 429 — aguarda 90s antes de retentar
  if (falhos429.length > 0) {
    const pausaSeg = 90;
    apuracaoProgress[key] = { fase: `${falhos429.length} pedido(s) com 429 — aguardando ${pausaSeg}s para retentar...`, pct: 87 };
    await new Promise(r => setTimeout(r, pausaSeg * 1000));
    for (let j = 0; j < falhos429.length; j++) {
      const ped = await bling.getPedidoDetalhe(idx, falhos429[j], 8).catch(() => null);
      if (ped) detalhes.push(ped);
      apuracaoProgress[key] = {
        fase: `Retry 429: ${j + 1}/${falhos429.length}`,
        pct: Math.round(87 + ((j + 1) / falhos429.length) * 6),
      };
      if (j < falhos429.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
  }

  apuracaoProgress[key] = { fase: 'Calculando...', pct: 95 };
  const linhas = _processarPedidosParaLinhas(detalhes, canaisMap, custoMapAm, custoMapSh, idx);

  // Salva cache por dia (sobrescreve dias existentes pois veio do atualizar)
  const porDia = {};
  for (const l of linhas) {
    const d = l._dataIso || dataInicial;
    if (!porDia[d]) porDia[d] = [];
    porDia[d].push(l);
  }
  for (const d of enumDates(dataInicial, dataFinal)) {
    salvarDiaCache(idx, d, porDia[d] || []);
  }

  const resultado = montarResultadoLinhas(idx, dataInicial, dataFinal, linhas);
  salvarCache(idx, dataInicial, dataFinal, resultado);
  apuracaoProgress[key] = { fase: 'Concluído!', pct: 100 };
  setTimeout(() => { delete apuracaoProgress[key]; }, 5000);
  return resultado;
}

// GET /apuracao-bling — retorna cache se existir, senão busca do Bling
app.get('/apuracao-bling', async (req, res) => {
  const idx = parseInt(req.query.idx ?? '1');

  // Aceita dataInicial/dataFinal diretamente ou mes (YYYY-MM) por compatibilidade
  let dataInicial = (req.query.dataInicial || '').trim();
  let dataFinal   = (req.query.dataFinal   || '').trim();
  const mes = (req.query.mes || '').trim();

  if (dataInicial && dataFinal) {
    // já OK
  } else if (mes && /^\d{4}-\d{2}$/.test(mes)) {
    const [ano, m] = mes.split('-');
    dataInicial = `${ano}-${m}-01`;
    const dias  = new Date(parseInt(ano), parseInt(m), 0).getDate();
    dataFinal   = `${ano}-${m}-${String(dias).padStart(2,'0')}`;
  } else {
    return res.status(400).json({ erro: 'Informe dataInicial+dataFinal (YYYY-MM-DD) ou mes (YYYY-MM)' });
  }

  const key = `${idx}-${dataInicial}-${dataFinal}`;

  // Usa cache por dia: reutiliza dias já apurados, busca apenas os dias faltantes
  try {
    const resultado = await buscarComCacheDia(idx, dataInicial, dataFinal, key);
    if (!resultado) return res.json({ ok: false, erro: 'Busca cancelada' });
    res.json(resultado);
  } catch (e) {
    delete apuracaoProgress[key];
    const st = e.response?.status;
    console.error('[apuracao-bling] ERRO idx=' + idx + ' status=' + st + ' msg=' + e.message + ' body=' + JSON.stringify(e.response?.data));
    if (st === 401 || st === 403) {
      return res.status(401).json({ ok: false, erro: 'Bling não autorizado', authUrl: '/bling/auth/' + idx });
    }
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /apuracao-bling/cancelar — cancela fetch em andamento
app.post('/apuracao-bling/cancelar', (req, res) => {
  const idx         = parseInt(req.query.idx ?? '1');
  const dataInicial = (req.query.dataInicial || '').trim();
  const dataFinal   = (req.query.dataFinal   || '').trim();
  const key = `${idx}-${dataInicial}-${dataFinal}`;
  apuracaoCancelados.add(key);
  delete apuracaoProgress[key];
  apuracaoEmAndamento.delete(idx);   // libera imediatamente para nova busca
  apuracaoGeneration[idx] = (apuracaoGeneration[idx] || 0) + 1; // invalida processo antigo
  res.json({ ok: true });
});

// POST /apuracao-bling/atualizar — força novo fetch ignorando cache
app.post('/apuracao-bling/atualizar', async (req, res) => {
  const idx          = parseInt(req.query.idx ?? '1');
  const dataInicial  = (req.query.dataInicial || '').trim();
  const dataFinal    = (req.query.dataFinal   || '').trim();
  if (!dataInicial || !dataFinal) return res.status(400).json({ erro: 'dataInicial e dataFinal obrigatórios' });

  const key = `${idx}-${dataInicial}-${dataFinal}`;

  // Apaga cache por dia para todo o range (força rebusca completa)
  for (const d of enumDates(dataInicial, dataFinal)) {
    try { fs.unlinkSync(dayFile(idx, d)); } catch(e) {}
  }
  try { fs.unlinkSync(cacheFile(idx, dataInicial, dataFinal)); } catch(e) {}

  // Responde imediatamente — fetch roda em background via buscarComCacheDia
  res.json({ ok: true, msg: 'Atualizando em background, acompanhe pelo progresso' });

  buscarComCacheDia(idx, dataInicial, dataFinal, key).catch(e => {
    console.error('[apuracao-bling/atualizar]', e.message);
  });
});

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ─── Debug: campos de preço de um produto Bling ──────────────────────────
// Acesse: /bling/produto-raw/1?sku=73
app.get('/bling/produto-raw/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const sku = req.query.sku || '';
  try {
    await bling.refreshToken(idx).catch(() => {});
    const t = bling.getToken(idx);
    const r = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: 'Bearer ' + t.access_token },
      params: { limite: 5, pagina: 1, criterio: 1 },
    });
    const items = r.data?.data || [];
    // Mostra todos os campos de preço dos primeiros produtos
    const amostra = items.map(p => ({
      id: p.id, codigo: p.codigo, nome: p.nome,
      preco: p.preco, precoCusto: p.precoCusto,
      precoCompra: p.precoCompra, custoMedio: p.custoMedio,
      todosOsCampos: Object.keys(p),
    }));
    res.json({ ok: true, amostra });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Debug: estrutura raw de um pedido Bling ─────────────────────────────
// Acesse: /bling/pedido-raw/1?mes=2026-05
// Retorna os primeiros 2 pedidos do mês para inspeção de campos
app.get('/bling/pedido-raw/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const mes = (req.query.mes || '').trim();
  if (!mes) return res.json({ erro: 'Parâmetro "mes" obrigatório (YYYY-MM)' });

  const [ano, m] = mes.split('-');
  const dataInicial = `${ano}-${m}-01`;
  const diasNoMes = new Date(parseInt(ano), parseInt(m), 0).getDate();
  const dataFinal  = `${ano}-${m}-${String(diasNoMes).padStart(2,'0')}`;

  try {
    await bling.refreshToken(idx).catch(() => {});
    const t = bling.getToken(idx);
    const lista = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: 'Bearer ' + t.access_token },
      params: { dataInicial, dataFinal, 'situacoes[]': 9, limite: 2, pagina: 1 },
    });
    const ids = (lista.data?.data || []).map(p => p.id);

    // Busca detalhe completo dos primeiros 2 pedidos (inclui itens, comissão, etc.)
    const detalhes = await Promise.all(ids.map(id =>
      axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
        headers: { Authorization: 'Bearer ' + t.access_token },
      }).then(r => r.data?.data)
    ));

    res.json({ ok: true, amostra: detalhes });
  } catch(e) {
    const st = e.response?.status;
    if (st === 401 || st === 403) {
      return res.status(401).json({
        erro: 'Token expirado — reautorize o Bling',
        authUrl: `/bling/auth/${idx}`,
        instrucao: `Acesse /bling/auth/${idx} no painel para renovar`
      });
    }
    res.status(500).json({ erro: e.message, detalhe: e.response?.data });
  }
});

// ─── Recarregar planilhas de custo (sem reiniciar o servidor) ────────────
app.post('/apuracao-bling/recarregar-custos', (req, res) => {
  const { execFile } = require('child_process');
  const script = path.join(__dirname, 'gerar_custos_json.py');
  execFile('python3', [script], { cwd: __dirname, timeout: 120000, env: { ...process.env, DATA_DIR: DATA } }, (err, stdout, stderr) => {
    if (err) {
      console.error('[recarregar-custos]', stderr);
      return res.status(500).json({ erro: stderr || err.message });
    }
    recarregarJsonsCusto();
    // Limpa cache de apuração para forçar recálculo com novos custos
    try {
      const files = fs.readdirSync(PASTA_CACHE_AP).filter(f => /^(ap_|canais_)/.test(f)); // só cache do Bling (preserva Tiny/backups)
      files.forEach(f => { try { fs.unlinkSync(path.join(PASTA_CACHE_AP, f)); } catch(e) {} });
      console.log(`[recarregar-custos] cache apuração limpo (${files.length} arquivos)`);
    } catch(e) {}
    console.log('[recarregar-custos] JSONs recarregados em memória');
    res.json({ ok: true, log: stdout, avisos: stderr || null });
  });
});

// ─── Limpar cache de apuração ────────────────────────────────────────────
// Acesse: /apuracao-bling/limpar-cache
app.get('/apuracao-bling/limpar-cache', (req, res) => {
  try {
    const files = fs.readdirSync(PASTA_CACHE_AP).filter(f => /^(ap_|canais_)/.test(f)); // só cache do Bling
    files.forEach(f => {
      try { fs.unlinkSync(path.join(PASTA_CACHE_AP, f)); } catch(e) {}
    });
    res.json({ ok: true, removidos: files });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── Debug: status token Bling ───────────────────────────────────────────
// GET /bling/auth-check — verifica apenas se o token existe (refresh é feito pelo interceptor nas chamadas reais)
app.get('/bling/auth-check', (req, res) => {
  const contas = [
    { idx: 0, nome: 'Zagodini' },
    { idx: 1, nome: 'Com Amor de Mae' },
  ];
  const resultado = {};
  for (const { idx, nome } of contas) {
    const t = bling.getToken(idx);
    if (t?.access_token) {
      resultado[idx] = { ok: true, nome };
    } else {
      resultado[idx] = { ok: false, nome, authUrl: `/bling/auth/${idx}` };
    }
  }
  res.json(resultado);
});

app.get('/bling/token-status/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const t = bling.getToken(idx);
  if (!t) return res.json({ status: 'sem token salvo' });

  const info = {
    tem_access_token: !!t.access_token,
    access_token_inicio: t.access_token?.slice(0,10) + '...',
    tem_refresh_token: !!t.refresh_token,
  };

  // Testa o token atual chamando um endpoint simples
  try {
    const r = await require('axios').get('https://www.bling.com.br/Api/v3/depositos', {
      headers: { Authorization: 'Bearer ' + t.access_token },
    });
    info.token_valido = true;
    info.depositos = r.data?.data?.length;
  } catch(e) {
    info.token_valido = false;
    info.erro_api = e.response?.status + ' ' + JSON.stringify(e.response?.data);
  }

  // Testa refresh
  try {
    await bling.refreshToken(idx);
    info.refresh_ok = true;
  } catch(e) {
    info.refresh_ok = false;
    info.refresh_erro = e.response?.data || e.message;
  }

  res.json(info);
});

// ─── Debug: canais de venda ────────────────────────────────────────────
// Acesse: /bling/canais/1
app.get('/bling/canais/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  try {
    await bling.refreshToken(idx).catch(() => {});
    const t = bling.getToken(idx);
    const r = await axios.get('https://www.bling.com.br/Api/v3/canais-venda', {
      headers: { Authorization: 'Bearer ' + t.access_token },
    });
    res.json({ ok: true, data: r.data });
  } catch(e) {
    res.status(500).json({ erro: e.message, detalhe: e.response?.data });
  }
});

// ─── Debug: pedido por número ────────────────────────────────────────────
// Acesse: /bling/pedido-numero/1?numero=110164
app.get('/bling/pedido-numero/:idx', async (req, res) => {
  const idx    = parseInt(req.params.idx);
  const numero = parseInt(req.query.numero);
  if (!numero) return res.json({ erro: 'Parâmetro "numero" obrigatório' });
  try {
    await bling.refreshToken(idx).catch(() => {});
    const t = bling.getToken(idx);
    // Busca pelo numero do pedido
    const lista = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: 'Bearer ' + t.access_token },
      params: { numero, limite: 5, pagina: 1 },
    });
    const ids = (lista.data?.data || []).map(p => p.id);
    if (!ids.length) return res.json({ erro: 'Pedido não encontrado', numero });
    const detalhes = await Promise.all(ids.map(id =>
      axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
        headers: { Authorization: 'Bearer ' + t.access_token },
      }).then(r => r.data?.data)
    ));
    // Retorna campos relevantes para diagnóstico de canal
    const resumo = detalhes.map(p => ({
      id: p?.id,
      numero: p?.numero,
      numeroLoja: p?.numeroLoja,
      loja: p?.loja,
      taxas: p?.taxas,
      situacao: p?.situacao,
    }));
    res.json({ ok: true, resumo, raw: detalhes });
  } catch(e) {
    res.status(500).json({ erro: e.message, detalhe: e.response?.data });
  }
});

// ─── Debug ────────────────────────────────────────────────────────────────
app.get('/debug/bling/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const CONTAS_BLING = {
    0: process.env.BLING_ZAGODINI_ID,
    1: process.env.BLING_MAE_ID,
  };
  const apikey = CONTAS_BLING[idx];
  try {
    const r = await axios.get('https://www.bling.com.br/Api/v2/produtos/json/', {
      params: { apikey, page: 1 }
    });
    res.json({ status: r.status, data: r.data });
  } catch(e) {
    res.json({ erro: e.message, status: e.response?.status, data: e.response?.data });
  }
});

app.get('/debug/ml/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  try {
    const uid = (await ml(idx, '/users/me')).id;
    const lista = await ml(idx, '/users/'+uid+'/items/search', { status:'active', limit:1 });
    const itemId = lista.results?.[0];
    if (!itemId) return res.json({ erro: 'sem itens' });
    // Busca item completo sem filtro de atributos
    const det = await ml(idx, '/items/'+itemId);
    res.json(det);
  } catch(e) {
    res.json({ erro: e.message });
  }
});

// ─── Rota Estoque Progress (SSE) ──────────────────────────────────────────
const estoqueProgress = {}; // idx -> { total, feito, status }

app.get('/estoque-progress/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = () => {
    const p = estoqueProgress[idx] || { total: 0, feito: 0, status: 'aguardando' };
    res.write(`data: ${JSON.stringify(p)}\n\n`);
  };
  send();
  const iv = setInterval(send, 800);
  req.on('close', () => clearInterval(iv));
});

// ─── Rota Estoque: Bling x ML ─────────────────────────────────────────────
app.get('/estoque/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  try {
    // Dados ML já em cache
    const mlDados = dadosCache[idx];
    if (!mlDados) return res.json({ erro: 'ML ainda carregando, tente em instantes.' });

    // Todos os itens ML com SKU e estoque
    const mlItens = mlDados.semPromo.concat(mlDados.comPromo).reduce((acc, it) => {
      const sku = it._sku || extrairSKU(it);
      if (sku) acc[sku] = it;
      return acc;
    }, {});

    // Busca Bling com progresso
    estoqueProgress[idx] = { total: 0, feito: 0, status: 'buscando produtos' };
    const blingProdutos = await bling.getProdutosComEstoque(idx, (feito, total) => {
      estoqueProgress[idx] = { total, feito, status: 'buscando estoque' };
    });

    const resultado = [];
    const skusVistosML = new Set(Object.keys(mlItens));

    for (const bp of blingProdutos) {
      const sku = bp.codigo;
      if (!sku) continue;
      const mlItem = mlItens[sku];
      const isFull = mlItem?.shipping?.logistic_type === 'fulfillment';
      const estoqueML = mlItem?.available_quantity ?? null;
      // Compara: Full → Bling Full vs ML; não-Full → Bling Geral vs ML
      const estoqueBlingComp = isFull ? bp.estoqueFull : bp.estoqueGeral;
      const diff = estoqueML !== null ? estoqueBlingComp - estoqueML : null;
      resultado.push({
        sku,
        nome:          bp.nome,
        estoqueBling:  bp.estoque,       // total Bling
        estoqueFull:   bp.estoqueFull,   // Bling depósito Full
        estoqueGeral:  bp.estoqueGeral,  // Bling depósito Geral
        estoqueML,                       // ML available_quantity
        isFull,
        mlId:          mlItem?.id || null,
        mlTitulo:      mlItem?.title || null,
        diff,
        semML:         !mlItem,
      });
      if (mlItem) skusVistosML.delete(sku);
    }

    // Itens que estão no ML mas não no Bling
    for (const sku of skusVistosML) {
      const mlItem = mlItens[sku];
      resultado.push({
        sku,
        nome:         mlItem.title,
        estoqueBling: null,
        estoqueML:    mlItem.available_quantity ?? 0,
        mlId:         mlItem.id,
        mlTitulo:     mlItem.title,
        diff:         null,
        semBling:     true,
      });
    }

    // Ordena: divergentes primeiro, depois sem ML, depois ok
    resultado.sort((a, b) => {
      const pa = a.semML || a.semBling ? 2 : Math.abs(a.diff||0) > 0 ? 1 : 0;
      const pb = b.semML || b.semBling ? 2 : Math.abs(b.diff||0) > 0 ? 1 : 0;
      return pb - pa || Math.abs(b.diff||0) - Math.abs(a.diff||0);
    });

    res.json({ ok: true, total: resultado.length, itens: resultado });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/shopee/reply-rating', async (req, res) => {
  try {
    const { rating_id, comment } = req.body;
    const result = await shopee.replyRating(rating_id, comment);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Só as telas são públicas para quem está logado — nunca a pasta inteira (.env, tokens...)
app.get('/', (req, res) => res.redirect('/painel.html'));
for (const pg of ['painel.html', 'painel_ads.html', 'apuracao_painel.html'])
  app.get('/' + pg, (req, res) => res.sendFile(path.join(__dirname, pg)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Servidor rodando na porta ' + PORT + ' — dados em ' + DATA);
  await renovarTodos();
  carregarTodas();
  carregarShopee();
  setInterval(async () => {
    await renovarTodos();
    carregarTodas();
    await shopee.refreshToken().catch(() => {});
    carregarShopee();
    for (const i of [0,1,2]) await bling.refreshToken(i).catch(() => {});
  }, 30 * 60 * 1000);
});
