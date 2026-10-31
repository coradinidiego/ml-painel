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
app.use('/apuracao-mkt', require('./apuracao_mkt').router); // Apuração Amazon / Shein / TikTok (3 empresas)
app.use('/tv', require('./tv').router); // Painel da TV (expedição)
app.use('/onedrive', require('./onedrive').router); // planilhas do OneDrive (Microsoft Graph)
app.use('/shein', require('./shein').router); // SHEIN Open Platform (Autooperação)
require('./relampago').rotas(app); // Oferta Relâmpago da Shopee automática (1 por dia, só registro)

// ─── Cache Shopee ──────────────────────────────────────────────────────────
// Um estado por loja Shopee (zagodini, mae, lufe)
const SHP = {};
for (const k of Object.keys(shopee.LOJAS)) SHP[k] = { cache: null, status: 'aguardando', erros: {} };
const lojaDe = req => { const k = String(req.query.loja || req.body?.loja || 'zagodini'); return SHP[k] ? k : 'zagodini'; };

async function carregarShopee(chave = 'zagodini') {
  const shopee_ = shopee.loja(chave), E = SHP[chave];
  const tokens = shopee_.getTokens();
  if (!tokens.access_token) { E.status = 'sem_auth'; return; }
  E.status = 'carregando';
  // cada parte é independente: se uma falhar, as outras ainda aparecem
  const erros = {};
  const parte = async (nome, fn) => { try { return await fn(); } catch (e) { erros[nome] = e.message; console.log('Shopee ' + chave + ' ' + nome + ': ' + e.message); return null; } };
  let produtos = await parte('produtos', () => shopee_.listarProdutos());
  // token expirado (vale 4h): renova e tenta de novo
  if (produtos === null && /invalid_acceess_token|invalid_access_token|access_token/i.test(erros.produtos || '')) {
    await shopee_.refreshToken().catch(e => { erros.token = e.message; });
    delete erros.produtos;
    produtos = await parte('produtos', () => shopee_.listarProdutos());
  }
  // Promoções e variações (para a aba "Sem promoção")
  if (produtos?.length) await parte('promocoes', async () => {
    const promos = await shopee_.promocoesPorItem(produtos.map(p => p.item_id));
    for (const p of produtos) {
      const ps = promos[p.item_id] || [];
      p._promoAtiva = ps.filter(x => x.situacao === 'ongoing');
      p._promoFutura = ps.filter(x => x.situacao === 'upcoming');
      if (p.has_model) {
        try {
          p._variacoes = await shopee_.variacoes(p.item_id);
          const comPromo = new Set(p._promoAtiva.map(x => String(x.modelo)));
          for (const v of p._variacoes) v.emPromo = comPromo.has(String(v.model_id));
          // variação com saldo zero não aceita promoção na Shopee: não conta
          const estV = v => v.estoqueVendedor ?? v.estoque ?? 0;
          p._varSemPromo = p._variacoes.filter(v => !v.emPromo && estV(v) > 0).length;
        } catch (e) {}
      }
      p._promoProibida = PROMO_PROIBIDA.test(p.item_name || ''); // mamadeiras etc. não podem ter promoção
      shpMarcarOculto(chave, p);
    }
  });
  const pedidos = await parte('pedidos', () => shopee_.listarPedidos());
  const avaliacoes = await parte('avaliacoes', () => shopee_.listarAvaliacoes());
  const conversas = await parte('chat', () => shopee_.listarConversas());
  E.erros = erros;
  if (produtos === null && pedidos === null && avaliacoes === null) { E.status = 'erro'; return; }
  E.cache = { produtos: produtos || [], pedidos: pedidos || [], avaliacoes: avaliacoes || [], conversas: conversas || [], erros,
                  ultimaAtualizacao: new Date().toLocaleTimeString('pt-BR') };
  E.cache.loja = chave; E.cache.nome = shopee_.nome; E.cache.shopId = tokens.shop_id;
  E.status = 'pronto';
  console.log(new Date().toLocaleTimeString('pt-BR') + ' - Shopee ' + chave + ': carregado! ' + E.cache.produtos.length + ' produtos, ' + E.cache.pedidos.length + ' pedidos');
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
    req.on('error', reject); // sem isto, uma falha de rede derrubava o servidor inteiro
    req.setTimeout(20000, () => req.destroy(new Error('timeout renovando token ML')));
    req.write(data); req.end();
  });
}

const RENOV_ML = {};   // última renovação do token do ML por conta (ok/erro)
async function renovarTodos() {
  try {
    const tokens = getTokens();
    for (const conta of CONTAS) {
      try {
        const novo = await renovarToken(conta, tokens[conta.nome].refresh);
        tokens[conta.nome] = novo;
        RENOV_ML[conta.nome] = { ok: true, em: new Date().toISOString() };
        console.log(new Date().toLocaleTimeString('pt-BR') + ' - ' + conta.nome + ': renovado!');
      } catch(e) {
        const msg = (typeof e === 'string' ? e : e?.message || String(e)).slice(0, 200);
        RENOV_ML[conta.nome] = { ok: false, em: new Date().toISOString(), erro: msg };
        console.log('Erro renovando token ML ' + conta.nome + ': ' + msg);
      }
    }
    fs.writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));
  } catch(e) { console.log('Erro geral renovacao: ' + e); }
}

// Extrai SKU do item ML (seller_sku, seller_custom_field, ou array attributes)
function extrairSKU(it) {
  if (it.seller_sku) return it.seller_sku;
  // atributo SELLER_SKU primeiro: nos anúncios sincronizados (uma variação por anúncio) o seller_custom_field
  // fica com o SKU antigo da família (ex.: "Lunch") e o SKU certo da variação está no atributo
  if (Array.isArray(it.attributes)) {
    const a = it.attributes.find(a => a.id === 'SELLER_SKU');
    if (a?.value_name) return a.value_name;
  }
  if (it.seller_custom_field) return it.seller_custom_field;
  return null;
}

async function ml(idx, path, params) {
  const token = getToken(idx);
  const url = BASE + path + (params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '');
  const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + token } });
  return r.data;
}

// Vendedores concorrentes (cache de 24h — o mesmo concorrente costuma ganhar vários catálogos)
const _vendedores = new Map();
async function vendedorML(idx, sellerId) {
  if (!sellerId) return null;
  const c = _vendedores.get(sellerId);
  if (c && c.medalha !== undefined && Date.now() - c.ts < 24 * 3600e3) return c;
  try {
    const u = await ml(idx, '/users/' + sellerId);
    const nick = u.nickname || String(sellerId);
    const rep = u.seller_reputation || {};
    const v = { nome: nick, loja: (u.permalink || ('https://perfil.mercadolivre.com.br/' + encodeURIComponent(nick))).replace(/^http:/, 'https:'),
      medalha: rep.power_seller_status || null,          // platinum | gold | silver | null (MercadoLíder)
      nivel: rep.level_id || null,                        // termômetro: 5_green, 4_light_green...
      oficial: u.user_type === 'brand' || (u.tags || []).includes('brand'),   // loja oficial
      ts: Date.now() };
    _vendedores.set(sellerId, v);
    return v;
  } catch (e) { return null; }
}

// IDs de vendedor das MINHAS contas ML (Zagodini, Mãe, Lufe): quando uma delas ganha o catálogo
// de outra, não é concorrência — é o grupo ganhando. Cache por processo.
const _meusSellers = new Map(); // seller_id -> nome da conta
async function meusSellers() {
  for (let i = 0; i < CONTAS.length; i++) {
    if ([..._meusSellers.values()].includes(CONTAS[i].nome)) continue;
    try { const u = await ml(i, '/users/me'); if (u?.id) _meusSellers.set(String(u.id), CONTAS[i].nome); } catch (e) {}
  }
  return _meusSellers;
}

// ─── Visão geral: pendências de todas as empresas e canais ─────────────────
app.get('/resumo', (req, res) => {
  const EMP = [{ id: 'zagodini', nome: 'Comercial Zagodini', ml: 0 }, { id: 'mae', nome: 'Com Amor de Mãe', ml: 1 }, { id: 'lufe', nome: 'Lufe Casa & Decoração', ml: 2 }];
  const out = EMP.map(e => {
    const r = { id: e.id, nome: e.nome, idx: e.ml, canais: {} };
    const d = dadosCache[e.ml];
    if (d) r.canais.ml = { ok: true, ativos: d.ativos, pausados: d.pausados, semPromo: d.semPromo.length, perdendo: d.perdendo.length, ganhando: d.ganhando.length, catalogo: d.catTotal,
      perdendoLucro: d.perdendo.filter(x => x.lucro_ptw_pct != null && x.lucro_ptw_pct >= 10).length, em: d.ultimaAtualizacao };
    else r.canais.ml = { ok: false, status: statusCache[e.ml] || 'carregando' };
    const S = SHP[e.id];
    if (S?.cache) { const P = S.cache.produtos; r.canais.shopee = { ok: true, ativos: P.length, semPromo: P.filter(p => p._semPromo && estoqueShp(p) > 0).length, semEstoque: P.filter(p => estoqueShp(p) <= 0).length,
      chat: (S.cache.conversas || []).filter(c => c.pendente).length, em: S.cache.ultimaAtualizacao }; }
    else r.canais.shopee = { ok: false, status: S?.status || 'sem_auth' };
    const A = AZ_ANUNCIOS[e.id];
    if (A?.anuncios) { const L = A.anuncios, at = L.filter(a => a.status === 'Active');
      r.canais.amazon = { ok: true, ativos: at.length, semEstoque: L.filter(a => !a.fba && a.qtd <= 0 && a.status !== 'Incomplete').length, inativos: L.filter(a => a.status === 'Inactive').length,
        incompletos: L.filter(a => a.status === 'Incomplete').length, perdendo: at.filter(a => a.bb?.situacao === 'perdendo').length, semBB: at.filter(a => a.bb?.situacao === 'sem').length,
        ganhando: at.filter(a => a.bb?.situacao === 'ganhando').length, perdendoLucro: at.filter(a => a.lucro_ptw_pct != null && a.lucro_ptw_pct >= 10).length, em: A.em }; }
    else r.canais.amazon = { ok: false, status: amazon.loja(e.id).configurada() ? (A?.status || 'aguardando') : 'sem_auth' };
    return r;
  });
  res.json({ empresas: out, em: new Date().toISOString() });
});

// Itens fora da lista "Sem promoção": proibidos de ter promoção por lei (mamadeira, chupeta, bico, protetor de mamilo)
// e os que você ocultar à mão no painel (promo_ignorar.json, por conta).
// Acessórios (aquecedor, esterilizador, escova de mamadeira…) podem ter promoção: só conta se o título não começar por eles.
const PROMO_PROIBIDA_RE = /mamadeira|chupeta|bicos? (de |para )?(mamadeira|silicone|ortod[oô]ntico)|protetor(es)? de mamilo/i;
const PROMO_ACESSORIO_RE = /^\s*(kit\s+)?(aquecedor|esterilizador|escova|escovinha|secador|escorredor|porta|organizador|suporte|bolsa|capa|lava|limpador)/i;
const PROMO_PROIBIDA = { test: t => PROMO_PROIBIDA_RE.test(t || '') && !PROMO_ACESSORIO_RE.test(t || '') };
const ARQ_PROMO_IGN = path.join(DATA, 'promo_ignorar.json');
function promoIgnorarTudo() { try { return JSON.parse(fs.readFileSync(ARQ_PROMO_IGN)); } catch (e) { return {}; } }
function promoIgnorar(idx) { return new Set(promoIgnorarTudo()[idx] || []); }
app.post('/promo/ignorar/:idx', (req, res) => {
  const idx = String(parseInt(req.params.idx)), { id, ignorar = true } = req.body || {};
  if (!/^MLB\d+$/.test(String(id || ''))) return res.status(400).json({ ok: false });
  const t = promoIgnorarTudo(), set = new Set(t[idx] || []);
  ignorar ? set.add(id) : set.delete(id);
  t[idx] = [...set]; fs.writeFileSync(ARQ_PROMO_IGN, JSON.stringify(t));
  const d = dadosCache[idx];
  if (d) {
    if (ignorar) { const i = d.semPromo.findIndex(x => x.id === id); if (i >= 0) d.semPromoIgnorados.push(...d.semPromo.splice(i, 1)); }
    else { const i = d.semPromoIgnorados.findIndex(x => x.id === id); if (i >= 0 && !PROMO_PROIBIDA.test(d.semPromoIgnorados[i].title || '')) d.semPromo.push(...d.semPromoIgnorados.splice(i, 1)); }
  }
  res.json({ ok: true });
});

// Shopee: itens ocultados à mão da lista "Sem promoção" (mesmo arquivo, chave shopee_<loja>)
function shpMarcarOculto(chave, p, ign = promoIgnorar('shopee_' + chave)) {
  p._ocultoPromo = ign.has(String(p.item_id));
  // sem promoção = o item não tem nenhuma promoção ativa OU alguma variação ficou de fora dela
  p._semPromo = ((p._promoAtiva || []).length === 0 || (p._varSemPromo || 0) > 0) && !p._promoProibida && !p._ocultoPromo;
}
app.post('/shopee/promo/ignorar', (req, res) => {
  const chave = lojaDe(req), { id, ignorar = true } = req.body || {};
  if (!/^\d+$/.test(String(id || ''))) return res.status(400).json({ ok: false });
  const k = 'shopee_' + chave, t = promoIgnorarTudo(), set = new Set(t[k] || []);
  ignorar ? set.add(String(id)) : set.delete(String(id));
  t[k] = [...set]; fs.writeFileSync(ARQ_PROMO_IGN, JSON.stringify(t));
  const p = (SHP[chave]?.cache?.produtos || []).find(x => String(x.item_id) === String(id));
  if (p) shpMarcarOculto(chave, p, set);
  res.json({ ok: true });
});

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
      const det = await ml(idx, '/items', {ids:chunk.join(','), attributes:'id,title,price,thumbnail,seller_sku,attributes,listing_type_id,category_id'});
      const list = Array.isArray(det) ? det : [det];
      list.forEach(w => { const it = w.body||w; it._sku = extrairSKU(it); details[it.id] = it; });
    }

    // Price to win
    const perdendo = [], ganhando = [], atualizando = [], grupo = [];
    let naoListados = 0;
    const meus = await meusSellers();
    meus.set(String(uid), CONTAS[idx].nome);
    for (let i = 0; i < catIds.length; i++) {
      try {
        const ptw = await ml(idx, '/items/'+catIds[i]+'/price_to_win');
        const it = details[catIds[i]] || {id:catIds[i], title:catIds[i], price:0};
        it.current_price = ptw.current_price;
        it.price_to_win = ptw.price_to_win;
        it.winner_price = ptw.winner?.price;
        it.status_cat = ptw.status;
        it.ptw_reason = ptw.reason || [];
        it.preco_nao_resolve = (ptw.reason || []).includes('no_improvement_price') || !(ptw.price_to_win < ptw.current_price - 0.005);
        // boosts: lista [{id,status,description}] (v2) ou objeto {fulfillment: true, ...} (v1)
        const NOMEB = { fulfillment: 'Envios Full', free_shipping: 'Frete grátis', free_installments: 'Pagamento sem juros', same_day_shipping: 'Envios no mesmo dia', cross_docking: 'Envios com coleta', drop_off: 'Envios por agência', shipping_collect: 'Envios com coleta' };
        const normB = b => Array.isArray(b) ? b.map(x => ({ id: x.id, on: x.status === 'boosted', d: x.description || NOMEB[x.id] || x.id })) : Object.entries(b || {}).map(([id, on]) => ({ id, on: !!on, d: NOMEB[id] || id }));
        let meusB = {}, ganB = {};
        try {
          meusB = Object.fromEntries(normB(ptw.boosts).map(x => [x.id, x.on])); ganB = Object.fromEntries(normB(ptw.winner?.boosts).map(x => [x.id, x.on]));
          it.vantagens_ganhador = normB(ptw.winner?.boosts).filter(x => x.on && !meusB[x.id]).map(x => x.d);
        } catch (eb) { it.vantagens_ganhador = []; }
        // Frete grátis do ML só vale de R$ 19 para cima (fora do Full): baixar para menos de R$ 19 tira o frete grátis
        // do seu anúncio e ele continua perdendo — o ML não considera isso no price_to_win.
        const LIM19 = 19;
        if (!meusB.fulfillment && ptw.price_to_win > 0 && ptw.price_to_win < LIM19 && ganB.free_shipping) {   // (se o ganhador também não tem frete grátis, o preço ainda pode resolver)
          it.abaixo19 = true; it.preco_nao_resolve = true;
          it.vantagens_ganhador = [ptw.current_price >= LIM19 ? 'o ML pede ' + String(ptw.price_to_win.toFixed(2)).replace('.', ',') + ', mas abaixo de R$ 19 você perde o Frete grátis' : 'abaixo de R$ 19 você já perdeu o Frete grátis'].concat(ganB.fulfillment ? ['o ganhador é Full (mantém o frete grátis abaixo de R$ 19)'] : []);
        }
        if (it.preco_nao_resolve && ptw.status === 'competing' && !it.vantagens_ganhador.length) {
          try { const p2 = await ml(idx, '/items/' + catIds[i] + '/price_to_win', { siteId: 'MLB', version: 'v2' }); const mB = Object.fromEntries(normB(p2.boosts).map(x => [x.id, x.on])); it.vantagens_ganhador = normB(p2.winner?.boosts).filter(x => x.on && !mB[x.id]).map(x => x.d); } catch (e4) {}
        }
        it.visit_share = ptw.visit_share;
        it.catalog_product_id = ptw.catalog_product_id;
        it.diff = ptw.current_price && ptw.price_to_win ? (ptw.current_price - ptw.price_to_win) : 999;
        if (ptw.status === 'competing') {
          // quem está ganhando o catálogo: anúncio ganhador -> vendedor (nome + link da loja)
          try {
            // O ML bloqueia (403) ler anúncios de outros vendedores; a lista de anúncios do produto
            // de catálogo traz o vendedor de cada um — achamos o ganhador ali.
            const wid = ptw.winner?.item_id;
            let sellerId = ptw.winner?.seller_id;
            if (wid) {
              it.winner_item_id = wid;
              it.winner_permalink = 'https://produto.mercadolivre.com.br/' + wid.replace(/^MLB/, 'MLB-');
            }
            if (!sellerId && ptw.catalog_product_id) {
              for (let off = 0; off < 200 && !sellerId; off += 50) {
                const pr = await ml(idx, '/products/' + ptw.catalog_product_id + '/items', { limit: 50, offset: off });
                const lista = pr.results || [];
                const w = wid ? lista.find(x => x.item_id === wid) : lista.find(x => x.seller_id != uid);
                if (w) { sellerId = w.seller_id; if (w.official_store_id) it.winner_oficial = true; if (!wid) { it.winner_item_id = w.item_id; it.winner_permalink = 'https://produto.mercadolivre.com.br/' + w.item_id.replace(/^MLB/, 'MLB-'); } }
                if (lista.length < 50) break;
              }
            }
            const v = await vendedorML(idx, sellerId);
            if (v) { it.winner_nome = v.nome; it.winner_loja = v.loja; it.winner_medalha = v.medalha; it.winner_nivel = v.nivel; it.winner_oficial = !!(it.winner_oficial || v.oficial); }
            if (sellerId && meus.has(String(sellerId))) it.winner_conta = String(sellerId) === String(uid) ? 'outro anúncio seu nesta conta' : meus.get(String(sellerId));
          } catch(e3) {}
          // ganhador é outra conta minha → não é concorrência
          if (it.winner_conta) grupo.push(it); else perdendo.push(it);
        }
        else if (ptw.status === 'winning') {
          try {
            if (ptw.catalog_product_id) {
              const comp = await ml(idx, '/products/'+ptw.catalog_product_id+'/items', {status:'active',limit:50});
              const others = (comp.results||[]).filter(r => r.seller_id != uid && !meus.has(String(r.seller_id)));
              if (others.length > 0) {
                const s2 = others.sort((a,b) => a.price-b.price)[0];
                it.s2price = s2.price;
                it.margem = s2.price - ptw.current_price;
                it.s2_concorrentes = others.length;
                if (s2.item_id) it.s2_permalink = 'https://produto.mercadolivre.com.br/' + s2.item_id.replace(/^MLB/, 'MLB-');
                const v = await vendedorML(idx, s2.seller_id);
                if (v) { it.s2_nome = v.nome; it.s2_loja = v.loja; it.s2_medalha = v.medalha; it.s2_nivel = v.nivel; }
                it.s2_oficial = !!(s2.official_store_id || v?.oficial);
                // dá para subir até R$ 0,10 abaixo do 2º colocado
                const alvo = Math.floor((s2.price - 0.10) * 100) / 100;
                if (alvo > ptw.current_price + 0.009) it.preco_subir = alvo;
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
      const det = await ml(idx, '/items', {ids:chunk.join(','), attributes:'id,title,price,original_price,thumbnail,catalog_listing,seller_sku,available_quantity,shipping,attributes,listing_type_id,category_id,permalink'});
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
        if (sp.regular_amount) it.regular_amount = sp.regular_amount;   // preço cheio (o "price" do anúncio pode já vir com desconto)
        const temPromo = sp.amount && sp.regular_amount && sp.amount < sp.regular_amount;
        if (temPromo) { it.sale_amount = sp.amount; comPromo.push(it); }
        else { if(catStatusMap[it.id]){it.status_cat=catStatusMap[it.id].status_cat;it.catalog_listing=true;} semPromo.push(it); }
      } catch(e) {
        if (!it.original_price) semPromo.push(it);
        else comPromo.push(it);
      }
      progressoCache[idx].promo = (i+1)/allItems.length;
    }

    // Produtos que não podem ter promoção (ex.: mamadeiras/chupetas — Lei 11.265/NBCAL) + itens ocultados à mão
    {
      const ign = promoIgnorar(idx);
      const fora = it => PROMO_PROIBIDA.test(it.title || '') || ign.has(it.id);
      const foraLista = semPromo.filter(fora);
      for (const it of foraLista) semPromo.splice(semPromo.indexOf(it), 1);
      semPromo.ignorados = foraLista;
    }

    // Lucro % no preço atual e no preço para ganhar (custo da planilha + tarifa/frete do ML + imposto)
    try { await require('./custos_ml').calcularMargens(ml, idx, uid, perdendo); }
    catch (e) { console.warn('[margens]', idx, e.message); }
    try { await require('./custos_ml').calcularMargens(ml, idx, uid, ganhando); }
    catch (e) { console.warn('[margens ganhando]', idx, e.message); }

    perdendo.sort((a,b) => a.diff-b.diff);
    ganhando.sort((a,b) => (b.margem||0)-(a.margem||0));

    dadosCache[idx] = {
      uid, nickname,
      ativos, pausados,
      perguntas,
      perdendo, ganhando, atualizando, grupo,
      semPromo, comPromo, semPromoIgnorados: semPromo.ignorados || [],
      catTotal: catIds.length,
      naoListados,
      ultimaAtualizacao: new Date().toLocaleTimeString('pt-BR')
    };
    statusCache[idx] = 'pronto';
    progressoCache[idx] = { conta:1, cat:1, promo:1, perguntas:1 };
    console.log(new Date().toLocaleTimeString('pt-BR') + ' - ' + CONTAS[idx].nome + ': carregado!');
  } catch(e) {
    statusCache[idx] = 'erro';
    const det = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data || '').slice(0, 200) + ' em ' + (e.config?.url || '').replace(/access_token=[^&]+/, '').slice(0, 120)) : '';
    erroCache[idx] = { em: new Date().toISOString(), msg: e.message, det };
    console.log('Erro conta ' + idx + ': ' + e.message + ' ' + det);
    // tenta de novo em 5 min (sem esperar o ciclo normal)
    clearTimeout(_retryConta[idx]); _retryConta[idx] = setTimeout(() => { if (statusCache[idx] === 'erro') carregarConta(idx).catch(() => {}); }, 5 * 60e3);
  }
}

const erroCache = {}, _retryConta = {};
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
    erro: statusCache[idx] === 'erro' ? erroCache[idx] || null : null,
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

// Atualizar custos (botão na aba Perdendo): relê o preço de custo no Bling/Tiny e recalcula o lucro dos catálogos
const _atualizandoCustos = {};
app.post('/custos/atualizar/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const d = dadosCache[idx];
  if (!d) return res.status(409).json({ ok: false, erro: 'A conta ainda está carregando. Tente em instantes.' });
  if (_atualizandoCustos[idx]) return res.status(409).json({ ok: false, erro: 'Já estou atualizando os custos desta conta.' });
  _atualizandoCustos[idx] = true;
  try {
    const cm = require('./custos_ml');
    cm.recarregarErp(idx);
    const erp = await cm.custosErp(idx);
    await cm.calcularMargens(ml, idx, d.uid, d.perdendo || []);
    await cm.calcularMargens(ml, idx, d.uid, d.ganhando || []);
    const p = d.perdendo || [];
    res.json({ ok: true, produtosComCusto: Object.keys(erp).length, catalogos: p.length, comLucro: p.filter(x => x.lucro_ptw_pct != null).length, erp: idx === 2 ? 'Tiny' : 'Bling' });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  finally { _atualizandoCustos[idx] = false; }
});

// ─── Rotas Shopee (todas aceitam ?loja=zagodini|mae|lufe; padrão zagodini) ──
app.get('/shopee/auth', (req, res) => {
  res.redirect(shopee.loja(lojaDe(req)).getAuthUrl());
});

app.get('/shopee/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  const chave = lojaDe(req), sp = shopee.loja(chave);
  const pg = (t, c) => '<div style="font-family:system-ui;padding:2rem"><h2>' + t + '</h2>' + c + '<p><a href="/painel.html">Voltar ao painel</a></p></div>';
  if (!code || !shop_id) return res.send(pg('❌ Parâmetros inválidos', ''));
  try {
    // evita conectar a mesma loja em duas contas do painel por engano
    for (const k of Object.keys(SHP)) if (k !== chave && String(shopee.loja(k).getTokens().shop_id) === String(parseInt(shop_id)))
      return res.status(400).send(pg('⚠️ Esta loja Shopee já está conectada em ' + shopee.loja(k).nome, '<p>Você entrou na Shopee com a conta errada? Saia da Shopee, entre com a conta de <b>' + sp.nome + '</b> e autorize de novo.</p>'));
    const data = await sp.getToken(code, parseInt(shop_id));
    if (!data.access_token) {
      console.error('[shopee/callback]', chave, 'sem token:', JSON.stringify(data));
      return res.status(400).send(pg('❌ A Shopee não liberou o acesso', '<p>' + String(data.message || data.error || 'resposta sem token').replace(/</g, '&lt;') + '</p>'));
    }
    sp.saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, shop_id: parseInt(shop_id) });
    carregarShopee(chave);
    res.send(pg('✅ Shopee autorizada: ' + sp.nome, '<p>Loja ' + parseInt(shop_id) + ' conectada' + (sp.SANDBOX ? ' (ambiente de teste)' : '') + '. Os dados aparecem no painel em 1 a 2 minutos.</p>'));
  } catch (e) {
    const det = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[shopee/callback]', chave, 'erro:', det);
    res.status(500).send(pg('❌ Erro ao autorizar a Shopee (' + sp.nome + ')', '<pre style="white-space:pre-wrap">' + String(det).replace(/</g, '&lt;') + '</pre>'));
  }
});

app.get('/shopee/config', (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const info = k => { const sp = shopee.loja(k), t = sp.getTokens();
    return { loja: k, nome: sp.nome, ambiente: sp.SANDBOX ? 'sandbox (teste)' : 'produção', partnerId: sp.PARTNER_ID || null, appProprio: sp.appProprio,
             redirect: sp.REDIRECT_URL || null, autorizada: !!t.access_token, shopId: t.shop_id || null, status: SHP[k].status, erros: SHP[k].erros }; };
  res.json(req.query.loja ? info(lojaDe(req)) : Object.keys(SHP).map(info));
});

// status resumido de todas as lojas (para as bolinhas do topo)
app.get('/shopee/status', (req, res) => {
  res.json(Object.fromEntries(Object.keys(SHP).map(k => [k, { status: SHP[k].status, pendChat: (SHP[k].cache?.conversas || []).filter(c => c.pendente).length }])));
});

app.get('/shopee/dados', (req, res) => {
  const E = SHP[lojaDe(req)];
  res.json({ status: E.status, dados: E.cache, erros: E.erros });
});

// Chat Shopee: conversas, mensagens de uma conversa e resposta
app.get('/shopee/chat', async (req, res) => {
  const k = lojaDe(req);
  try { const c = await shopee.loja(k).listarConversas(); if (SHP[k].cache) SHP[k].cache.conversas = c; res.json({ ok: true, conversas: c }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});
app.get('/shopee/chat/:id', async (req, res) => {
  try { res.json({ ok: true, mensagens: await shopee.loja(lojaDe(req)).mensagens(req.params.id) }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});
app.post('/shopee/chat/:id/responder', async (req, res) => {
  const k = lojaDe(req);
  const { to_id, texto } = req.body || {};
  if (!to_id || !String(texto || '').trim()) return res.status(400).json({ ok: false, erro: 'Escreva a mensagem.' });
  try {
    await shopee.loja(k).enviarMensagem(to_id, String(texto).trim().slice(0, 1000));
    const c = SHP[k].cache?.conversas?.find(x => x.id === req.params.id);
    if (c) { c.pendente = false; c.texto = String(texto).trim(); c.quando = Date.now(); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/shopee/recarregar', (req, res) => {
  const k = lojaDe(req);
  SHP[k].status = 'aguardando';
  carregarShopee(k);
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
process.on('config-empresas', () => { try { IMPOSTO_RATE = { ...IMPOSTO_RATE, ...JSON.parse(fs.readFileSync(IMPOSTOS_FILE)) }; } catch(e) {} });

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
    const r = await axios.get('https://api.bling.com.br/Api/v3/produtos', {
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
    const lista = await axios.get('https://api.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: 'Bearer ' + t.access_token },
      params: { dataInicial, dataFinal, 'situacoes[]': 9, limite: 2, pagina: 1 },
    });
    const ids = (lista.data?.data || []).map(p => p.id);

    // Busca detalhe completo dos primeiros 2 pedidos (inclui itens, comissão, etc.)
    const detalhes = await Promise.all(ids.map(id =>
      axios.get(`https://api.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
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

app.get('/ml/token-status', (req, res) => res.json(RENOV_ML));

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
    const r = await require('axios').get('https://api.bling.com.br/Api/v3/depositos', {
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
    const r = await axios.get('https://api.bling.com.br/Api/v3/canais-venda', {
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
    const lista = await axios.get('https://api.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: 'Bearer ' + t.access_token },
      params: { numero, limite: 5, pagina: 1 },
    });
    const ids = (lista.data?.data || []).map(p => p.id);
    if (!ids.length) return res.json({ erro: 'Pedido não encontrado', numero });
    const detalhes = await Promise.all(ids.map(id =>
      axios.get(`https://api.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
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
// Diagnóstico (admin, só leitura): GET na API v3 do Bling. /debug/bling-raw/0?path=/nfe&situacao=5
app.get('/debug/bling-raw/:idx', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const { path: p, ...q } = req.query;
  if (!/^\/(nfe|pedidos|situacoes|contatos|produtos|naturezas-operacoes|logisticas|depositos|estoques)/.test(String(p || ''))) return res.status(400).json({ erro: 'path não permitido' });
  try { const u = new URLSearchParams(); for (const [k, v] of Object.entries(q)) (Array.isArray(v) ? v : [v]).forEach(x => u.append(k, x));
    res.json((await bling.client(parseInt(req.params.idx)).get(String(p) + (u.toString() ? '?' + u : ''), { timeout: 30000 })).data); }
  catch (e) { res.status(e.response?.status || 500).json({ erro: e.message, body: e.response?.data }); }
});
// Diagnóstico (admin, só leitura): Tiny API v2. /debug/tiny-raw?metodo=notas.fiscais.pesquisa.php&situacao=6
app.get('/debug/tiny-raw', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const { metodo, ...q } = req.query;
  if (!/^(notas?\.fiscais?\.(pesquisa|obter)|nota\.fiscal\.obter|pedidos\.pesquisa|pedido\.obter|produtos?\.(pesquisa|obter)[\w.]*|produto\.[\w.]*custo[\w.]*)\.php$/.test(String(metodo || ''))) return res.status(400).json({ erro: 'método não permitido' });
  try { res.json(await require('./tiny').chamar(String(metodo), q)); } catch (e) { res.status(500).json({ erro: e.message }); }
});
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

// Ativa Mercado Envios Flex num anúncio (admin)
app.post('/ml/item/:idx/:item/flex', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const idx = parseInt(req.params.idx), item = String(req.params.item);
  if (!/^MLB\d+$/.test(item)) return res.status(400).json({ erro: 'anúncio inválido' });
  const tent = [];
  for (const [m, p] of [['post', '/sites/MLB/shipping/selfservice/items/' + item], ['post', '/flex/sites/MLB/items/' + item + '/v2']]) {
    try { const r = await mlReq(idx, m, p, {}); tent.push({ p, ok: true, r: r.data }); break; }
    catch (e) { tent.push({ p, status: e.response?.status, body: e.response?.data }); }
  }
  try { const d = await ml(idx, '/items/' + item, { attributes: 'id,shipping' }); res.json({ tent, tags: d.shipping?.tags }); }
  catch (e) { res.json({ tent, erro: e.message }); }
});
// Muda a categoria de um anúncio (admin): PUT /items/{id} { category_id }
app.post('/ml/item/:idx/:item/categoria', require('express').json(), async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const idx = parseInt(req.params.idx), item = String(req.params.item), cat = String(req.body?.categoria || '');
  if (!/^MLB\d+$/.test(item) || !/^MLB\d+$/.test(cat)) return res.status(400).json({ erro: 'dados inválidos' });
  try {
    await mlReq(idx, 'put', '/items/' + item, { category_id: cat });
    const d = await ml(idx, '/items/' + item, { attributes: 'id,category_id,shipping,status' });
    res.json({ ok: true, item: d });
  } catch (e) { res.status(e.response?.status || 500).json({ erro: e.message, body: e.response?.data }); }
});
// Ativa Mercado Envios num anúncio (admin): PUT /items/{id} { shipping: { mode: 'me2', local_pick_up: false } }
app.post('/ml/item/:idx/:item/mercado-envios', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const idx = parseInt(req.params.idx), item = String(req.params.item);
  if (!/^MLB\d+$/.test(item)) return res.status(400).json({ erro: 'anúncio inválido' });
  try {
    const r = await mlReq(idx, 'put', '/items/' + item, { shipping: { mode: 'me2', local_pick_up: false } });
    const d = await ml(idx, '/items/' + item, { attributes: 'id,shipping,status' });
    res.json({ ok: true, shipping: d.shipping, status: d.status });
  } catch (e) { res.status(e.response?.status || 500).json({ erro: e.message, body: e.response?.data }); }
});
// Diagnóstico (admin): GET cru na API do ML com o token da conta. Ex.: /debug/ml-raw/0?path=/products/MLB123
app.get('/debug/ml-raw/:idx', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const p = String(req.query.path || '');
  if (!/^\/(items|products|users|shipments|orders|sites|seller-promotions|marketplace|post-purchase|packs|inventories|stock|billing|fulfillment|warehouse|categories|highlights|trends)[\/?]/.test(p)) return res.status(400).json({ erro: 'path não permitido' });
  try { res.json(await ml(parseInt(req.params.idx), p)); }
  catch (e) { res.status(e.response?.status || 500).json({ erro: e.message, body: e.response?.data }); }
});

// ─── Amazon SP-API ─────────────────────────────────────────────────────────
const amazon = require('./amazon');
// Situação da conexão de cada loja (admin)
app.get('/amazon/config', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const out = [];
  for (const k of Object.keys(amazon.LOJAS)) {
    const a = amazon.loja(k), it = { loja: k, nome: a.nome, configurada: a.configurada() };
    if (it.configurada && req.query.testar) {
      try { const p = await a.participacoes(); it.ok = true; it.marketplaces = p.map(x => x.marketplace?.name + ' (' + x.marketplace?.id + ')' + (x.participation?.isParticipating ? '' : ' — inativo')); }
      catch (e) { it.ok = false; it.erro = e.message; }
    }
    out.push(it);
  }
  res.json(out);
});
// Quais lojas têm Amazon conectada (para mostrar a chave no painel)
app.get('/amazon/lojas', (req, res) => res.json(Object.fromEntries(Object.keys(amazon.LOJAS).map(k => [k, amazon.loja(k).configurada()]))));
// Pedidos da Amazon (15 dias) resumidos para o painel
app.get('/amazon/dados', async (req, res) => {
  const k = amazon.LOJAS[req.query.loja] ? req.query.loja : 'lufe', az = amazon.loja(k);
  if (!az.configurada()) return res.json({ status: 'sem_auth' });
  try {
    const d = await az.pedidosCache(!!req.query.forcar);
    const r = o => ({ id: o.AmazonOrderId, status: o.OrderStatus, criado: o.PurchaseDate, atualizado: o.LastUpdateDate,
      limiteEnvio: o.LatestShipDate, entregaAte: o.LatestDeliveryDate, total: Number(o.OrderTotal?.Amount || 0), itens: (o.NumberOfItemsShipped || 0) + (o.NumberOfItemsUnshipped || 0),
      canal: o.FulfillmentChannel, envioFacil: o.EasyShipShipmentStatus || null, servico: o.ShipServiceLevel, prime: !!o.IsPrime, empresa: !!o.IsBusinessOrder });
    res.json({ status: 'pronto', atualizadoEm: new Date(d.em).toISOString(), pedidos: d.todos.map(r) });
  } catch (e) { res.json({ status: 'erro', erro: e.message }); }
});
// ─── Amazon: anúncios, estoque e Buy Box (atualiza a cada 2h por loja) ──────
const AZ_ANUNCIOS = {};   // loja -> { status, em, anuncios, erro }
const ARQ_AZ = k => path.join(DATA, 'apuracao_cache', 'amazon_anuncios_' + k + '.json');
for (const k of Object.keys(amazon.LOJAS)) { try { AZ_ANUNCIOS[k] = JSON.parse(fs.readFileSync(ARQ_AZ(k))); } catch (e) {} }
async function carregarAnunciosAmazon(k) {
  const az = amazon.loja(k);
  if (!az.configurada()) return;
  const E = AZ_ANUNCIOS[k] ||= {};
  if (E.status === 'carregando' && Date.now() - (E.inicio || 0) < 40 * 60e3) return;   // trava de segurança: 40 min
  E.status = 'carregando'; E.inicio = Date.now();
  try {
    E.etapa = 'relatório de anúncios';
    const ls = az.tsv(await az.relatorio('GET_MERCHANT_LISTINGS_ALL_DATA'));
    const col = (l, n) => l[n] ?? l['\uFEFF' + n];
    const anuncios = ls.map(l => ({ sku: col(l, 'seller-sku'), asin: col(l, 'asin1'), nome: col(l, 'item-name'), preco: Number(col(l, 'price') || 0),
      qtd: Number(col(l, 'quantity') || 0), status: col(l, 'status'), fba: /AMAZON/i.test(col(l, 'fulfillment-channel') || ''), aberto: col(l, 'open-date') }));
    // Buy Box: ofertas dos ASINs ativos (20 por consulta; a Amazon libera ~1 consulta a cada 10 s)
    const asins = [...new Set(anuncios.filter(a => a.status === 'Active' && a.asin).map(a => a.asin))];
    const of = {};
    E.etapa = 'Buy Box';
    for (let i = 0; i < asins.length; i += 20) {
      try { for (const r of await az.ofertas(asins.slice(i, i + 20))) { const pl = r.body?.payload; if (pl?.ASIN) of[pl.ASIN] = pl; } }
      catch (e) { console.log('[amazon] ofertas ' + k + ': ' + e.message); }
      await new Promise(r => setTimeout(r, 10500));
    }
    // meu SellerId: o vendedor das ofertas em que só existe uma oferta (a minha)
    const conta = {};
    for (const pl of Object.values(of)) if ((pl.Offers || []).length === 1) { const id = pl.Offers[0].SellerId; conta[id] = (conta[id] || 0) + 1; }
    const eu = Object.entries(conta).sort((a, b) => b[1] - a[1])[0]?.[0] || E.eu || null;
    const cm = require('./custos_ml'), idxErp = amazon.LOJAS[k].ml ?? 2;
    const custos = await cm.custosErp(idxErp).catch(() => ({}));
    for (const a of anuncios) {
      const cf = cm.custoComFonte(idxErp, a.sku, custos); a.custo = cf?.v ?? null; a.custoFonte = cf?.fonte || null;
      const pl = of[a.asin];
      if (!pl) continue;
      const offers = pl.Offers || [];
      const win = offers.find(o => o.IsBuyBoxWinner);
      const preco = o => (o?.ListingPrice?.Amount || 0) + (o?.Shipping?.Amount || 0);
      // como a oferta é entregue: Prime/FBA, prazo de despacho (horas) e estado de origem — explica Buy Box perdida sem ser por preço
      const envioOferta = o => ({ prime: !!(o.PrimeInformation?.IsPrime || o.PrimeInformation?.IsNationalPrime), envioMin: o.ShippingTime?.minimumHours ?? null,
        envioMax: o.ShippingTime?.maximumHours ?? null, disp: o.ShippingTime?.availabilityType || null, uf: o.ShipsFrom?.State || null });
      const outros = offers.filter(o => o.SellerId !== eu);
      a.bb = {
        situacao: !win ? 'sem' : win.SellerId === eu ? 'ganhando' : 'perdendo',
        preco: win ? preco(win) : (pl.Summary?.BuyBoxPrices?.[0]?.LandedPrice?.Amount ?? null),
        ganhador: win && win.SellerId !== eu ? { id: win.SellerId, fba: !!win.IsFulfilledByAmazon, preco: preco(win), nota: win.SellerFeedbackRating?.SellerPositiveFeedbackRating, avaliacoes: win.SellerFeedbackRating?.FeedbackCount, ...envioOferta(win) } : null,
        minha: (o => o ? { fba: !!o.IsFulfilledByAmazon, destaque: !!o.IsFeaturedMerchant, total: preco(o), frete: o.Shipping?.Amount || 0, ...envioOferta(o) } : null)(offers.find(o => o.SellerId === eu)),
        concorrentes: outros.length,
        menorConcorrente: outros.length ? Math.min(...outros.map(preco)) : null,
      };
      // A Amazon compara preço + frete. "alvo" = preço do produto que empata com a Buy Box, descontando o MEU frete.
      if (a.bb.preco > 0) a.bb.alvo = Math.round((a.bb.preco - (a.bb.minha?.frete || 0)) * 100) / 100;
    }
    // Imagens (catálogo da Amazon, 20 ASINs por consulta)
    E.etapa = 'imagens';
    const imgs = { ...(E.imgs || {}) };
    const faltam = [...new Set(anuncios.map(a => a.asin).filter(x => x && !imgs[x]))];
    for (let i = 0; i < faltam.length; i += 20) {
      for (let t = 0; t < 3; t++) {
        try { Object.assign(imgs, await az.catalogo(faltam.slice(i, i + 20))); break; }
        catch (e) { console.log('[amazon] catálogo ' + k + ': ' + e.message); await new Promise(r => setTimeout(r, 5000 * (t + 1))); }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    for (const a of anuncios) a.img = imgs[a.asin]?.img || null;
    // Histórico financeiro (comissão real, outras tarifas e frete DBA por SKU) — renova a cada 6h
    let hist = E.hist;
    if (!hist || !hist.freteFaixas || Date.now() - (E.histTs || 0) > 6 * 3600e3) {
      E.etapa = 'histórico financeiro';
      try { hist = await az.historicoTarifas(60); E.hist = hist; E.histTs = Date.now(); } catch (e) { console.log('[amazon] financeiro ' + k + ': ' + e.message); }
    }
    // Tarifa de comissão estimada pela Amazon no preço atual e no preço da Buy Box
    const pedidosTar = [];
    for (const a of anuncios) if (a.status === 'Active' && a.asin) {
      pedidosTar.push({ asin: a.asin, preco: a.preco, fba: a.fba, id: a.sku + '|atual' });
      if (a.bb?.situacao === 'perdendo' && a.bb.alvo > 0 && a.bb.alvo < a.preco) pedidosTar.push({ asin: a.asin, preco: a.bb.alvo, fba: a.fba, id: a.sku + '|bb' });
    }
    const tar = {};
    E.etapa = 'tarifas';
    for (let i = 0; i < pedidosTar.length; i += 20) {
      for (let t = 0; t < 3; t++) {
        try { Object.assign(tar, await az.tarifas(pedidosTar.slice(i, i + 20))); break; }
        catch (e) { console.log('[amazon] tarifas ' + k + ' (tentativa ' + (t + 1) + '): ' + e.message); await new Promise(r => setTimeout(r, 8000 * (t + 1))); }
      }
      await new Promise(r => setTimeout(r, 2500));
    }
    // comissão média real da loja (reserva quando a Amazon não devolve a estimativa do produto)
    let cTot = 0, pTot = 0;
    for (const h of Object.values(hist?.porSku || {})) if (h.comPct != null) { cTot += h.comPct * h.unid; pTot += h.unid; }
    const comMediaLoja = pTot ? cTot / pTot : 0.12;
    const cfgE = require('./config_empresas').porMlIdx(idxErp) || {};
    const imp = cfgE.imposto ?? 0.05, emb = cfgE.embalagem ?? 0;
    const r2 = x => Math.round(x * 100) / 100;
    const calc = (a, preco, t) => {
      if (!(preco > 0) || a.custo == null) return null;
      const h = hist?.porSku?.[a.sku];
      const comEst = t && !t.erro && preco ? (t.det?.ReferralFee ?? t.total) / preco : null;
      const comPct = comEst ?? h?.comPct ?? comMediaLoja;
      const fonteCom = comEst != null ? 'estimada pela Amazon para este produto' : h?.comPct != null ? 'média real deste SKU' : 'média da loja (a Amazon não devolveu a estimativa deste produto)';
      const tarifa = preco * comPct;
      const fixa = (t && !t.erro ? (t.total - (t.det?.ReferralFee ?? t.total)) : 0) + (h ? h.outrasUn : 0);
      const fxs = hist?.freteFaixas || [], fxi = fxs.find(f => f.ate == null || preco < f.ate);
      const freteFaixa = fxi && fxi.medio != null && fxi.pedidos >= 3 ? fxi.medio : null;
      const frete = a.fba ? 0 : (h && h.freteUn > 0 && h.pedidos >= 2 ? h.freteUn : (freteFaixa ?? hist?.freteMedioPedido ?? 0));
      const fonteFrete = a.fba ? 'FBA' : (h && h.freteUn > 0 && h.pedidos >= 2 ? 'sku' : freteFaixa != null ? 'faixa' : 'loja');
      const imposto = preco * imp;
      const lucro = preco - a.custo - tarifa - fixa - frete - emb - imposto;
      return { preco: r2(preco), frete: r2(frete), tarifa: r2(tarifa + fixa), tarifaPct: Math.round(comPct * 1000) / 10, tarifaFixa: fixa ? r2(fixa) : 0,
        custo: r2(a.custo), custoFonte: a.custoFonte, embalagem: r2(emb), imposto: r2(imposto), impostoPct: Math.round(imp * 1000) / 10, rebate: 0,
        lucro: r2(lucro), pct: Math.round(lucro / preco * 1000) / 10, mkt: 'Amazon',
        nota: 'Comissão ' + fonteCom + (fixa ? '; outras tarifas e ' : '; ') + (fonteFrete === 'FBA' ? 'FBA.' : fonteFrete === 'sku' ? 'frete Envios Fácil = média real dos seus pedidos deste SKU (' + h.pedidos + ' pedidos, 60 dias).' : fonteFrete === 'faixa' ? 'frete Envios Fácil = média dos seus pedidos na faixa de ' + (fxi.ate ? 'até R$ ' + fxi.ate : 'acima de R$ 200') + ' (' + fxi.pedidos + ' pedidos, 60 dias).' : 'frete Envios Fácil = média da loja (' + (hist?.pedidosComFrete || 0) + ' pedidos, 60 dias).') };
    };
    for (const a of anuncios) {
      if (a.status !== 'Active') continue;
      const atual = calc(a, a.preco, tar[a.sku + '|atual']);
      if (atual) { a.calc_atual = atual; a.lucro_atual_pct = atual.pct; }
      if (a.bb?.situacao === 'perdendo' && a.bb.alvo > 0) {
        const bb = a.bb.alvo < a.preco ? calc(a, a.bb.alvo, tar[a.sku + '|bb']) : atual;
        if (bb) { a.calc_ptw = bb; a.lucro_ptw_pct = bb.pct; }
      }
      if (a.custo == null) a.margem_obs = 'sem custo no Tiny/Bling';
    }
    Object.assign(E, { status: 'pronto', em: new Date().toISOString(), anuncios, eu, erro: null, imgs });
    try { fs.mkdirSync(path.dirname(ARQ_AZ(k)), { recursive: true }); fs.writeFileSync(ARQ_AZ(k), JSON.stringify(E)); } catch (e) {}
    E.duracaoSeg = Math.round((Date.now() - E.inicio) / 1000);
    console.log('[amazon] ' + k + ': ' + anuncios.length + ' anúncios, ' + Object.keys(of).length + ' com ofertas');
  } catch (e) { E.status = 'erro'; E.erro = e.message; console.log('[amazon] anúncios ' + k + ': ' + e.message); }
}
async function anunciosAmazonTodas() { for (const k of Object.keys(amazon.LOJAS)) await carregarAnunciosAmazon(k); }
setTimeout(anunciosAmazonTodas, 2 * 60e3);
setInterval(anunciosAmazonTodas, 2 * 3600e3);
app.get('/amazon/anuncios', (req, res) => {
  const k = amazon.LOJAS[req.query.loja] ? req.query.loja : 'lufe';
  if (!amazon.loja(k).configurada()) return res.json({ status: 'sem_auth' });
  const { imgs, hist, ...E } = AZ_ANUNCIOS[k] || { status: 'aguardando' };
  res.json(E);
});
app.post('/amazon/anuncios/atualizar', (req, res) => {
  const k = amazon.LOJAS[req.query.loja] ? req.query.loja : 'lufe';
  carregarAnunciosAmazon(k); res.json({ ok: true });
});

// Diagnóstico (admin): catálogo, tarifas e eventos financeiros de exemplo
app.get('/debug/amazon-teste2', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const k = req.query.loja || 'lufe', az = amazon.loja(k), A = AZ_ANUNCIOS[k]?.anuncios || [];
  const ex = A.filter(a => a.status === 'Active').slice(0, 3);
  const out = {};
  try { out.catalogo = await az.catalogo(ex.map(a => a.asin)); } catch (e) { out.catalogo = e.message; }
  try { out.tarifas = await az.tarifas(ex.map(a => ({ asin: a.asin, preco: a.preco, fba: a.fba, id: a.sku }))); } catch (e) { out.tarifas = e.message; }
  try {
    const desde = new Date(Date.now() - 20 * 864e5).toISOString();
    const f = await az.get('/finances/v0/financialEvents', { PostedAfter: desde, MaxResultsPerPage: 20 });
    const ev = f.payload?.FinancialEvents || {};
    out.financeiro = { chaves: Object.keys(ev).filter(x => ev[x]?.length), envio: JSON.stringify(ev.ShipmentEventList?.slice(0, 2)).slice(0, 3000), servico: JSON.stringify(ev.ServiceFeeEventList?.slice(0, 3)).slice(0, 1500) };
  } catch (e) { out.financeiro = e.message; }
  res.json(out);
});
// Diagnóstico (admin): relatório de anúncios cru (primeiras linhas) e ofertas de 2 ASINs
app.get('/debug/amazon-teste', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const az = amazon.loja(req.query.loja || 'lufe');
  try {
    const txt = await az.relatorio('GET_MERCHANT_LISTINGS_ALL_DATA');
    const ls = az.tsv(txt);
    const asins = [...new Set(ls.map(l => l.asin1).filter(Boolean))].slice(0, 2);
    const of = asins.length ? await az.ofertas(asins) : [];
    res.json({ linhas: ls.length, colunas: Object.keys(ls[0] || {}), exemplo: ls.slice(0, 2), status: ls.reduce((a, l) => (a[l.status] = (a[l.status] || 0) + 1, a), {}), ofertas: of });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
// Diagnóstico (admin): GET cru na SP-API. /debug/amazon-raw?loja=lufe&path=/orders/v0/orders&CreatedAfter=...
app.get('/debug/amazon-raw', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const { loja: lj = 'lufe', path: p, ...extra } = req.query;
  if (!amazon.LOJAS[lj] || !/^\/[a-zA-Z]/.test(String(p || ''))) return res.status(400).json({ erro: 'loja/path inválido' });
  if (/orders\/v0\/orders/.test(p) && !extra.MarketplaceIds) extra.MarketplaceIds = amazon.MARKETPLACE_BR;
  try { res.json(await amazon.loja(lj).get(String(p), extra)); } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Diagnóstico (admin): GET cru na API da Shopee. Ex.: /debug/shopee-raw?path=/api/v2/shop/get_shop_info&x=1
app.get('/debug/shopee-raw', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const { path: p, ...extra } = req.query;
  if (!/^\/api\/v2\/(shop|product|order|logistics|sellerchat|discount|shop_flash_sale|bundle_deal|add_on_deal|voucher|ads|account_health|payment|returns)\//.test(String(p || ''))) return res.status(400).json({ erro: 'path não permitido' });
  const { loja: lj, ...ex2 } = extra;
  try { res.json(await shopee.loja(SHP[lj] ? lj : 'zagodini').shopeeGet(String(p), ex2)); } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Diagnóstico (admin): de onde vem o custo de um SKU. /debug/custo/2?sku=7898501766807&recarregar=1
app.get('/debug/custo/:idx', async (req, res) => {
  if (require('./auth').ativo() && !req.usuario?.admin) return res.status(403).json({ erro: 'só admin' });
  const idx = parseInt(req.params.idx), sku = String(req.query.sku || '').trim();
  const cm = require('./custos_ml');
  try {
    if (req.query.recarregar) cm.recarregarErp(idx);
    const erp = await cm.custosErp(idx);
    const out = { idx, sku, produtosComCustoNoErp: Object.keys(erp).length, resultado: cm.custoComFonte(idx, sku, erp) };
    if (idx === 2 && sku) { // o que o Tiny devolve para esse código
      const r = await require('./tiny').chamar('produtos.pesquisa.php', { pesquisa: sku });
      out.tiny = (r.produtos || []).map(x => ({ id: x.produto.id, codigo: x.produto.codigo, gtin: x.produto.gtin, nome: x.produto.nome, preco_custo: x.produto.preco_custo, preco_custo_medio: x.produto.preco_custo_medio }));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ erro: e.message }); }
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

// Texto padrão de resposta das avaliações, assinado por loja
const SHP_ASSINA = { zagodini: 'Comercial Zagodini', mae: 'Com Amor de Mãe', lufe: 'Lufe Casa & Decoração' };
const textoAval = k => 'Ficamos felizes pela sua avaliação e agradecemos sua compra. Esperamos lhe atender novamente. Att. ' + (SHP_ASSINA[k] || shopee.loja(k).nome);
app.get('/shopee/texto-avaliacao', (req, res) => res.json({ texto: textoAval(lojaDe(req)) }));

// Responde em lote as avaliações sem resposta de N estrelas (opcionalmente só as sem texto do cliente)
app.post('/shopee/avaliacoes/responder-lote', async (req, res) => {
  const k = lojaDe(req), sp = shopee.loja(k);
  const { estrelas = 5, somenteSemTexto = true, max = 1000, simular = false } = req.body || {};
  const texto = String(req.body?.texto || textoAval(k)).trim();
  try {
    const todas = await sp.listarAvaliacoes(max);
    const est = [].concat(estrelas).map(Number);
    const alvo = todas.filter(r => est.includes(r.rating_star) && !r.comment && (!somenteSemTexto || !(r.comment_list?.[0] || '').trim()));
    if (simular) return res.json({ ok: true, lidas: todas.length, alvo: alvo.length, texto });
    const r = await sp.responderAvaliacoesLote(alvo.map(x => x.rating_id), texto.slice(0, 500));
    const C = SHP[k].cache;
    if (C) { const set = new Set(r.ok.map(String)); for (const a of C.avaliacoes) if (set.has(String(a.rating_id))) a.comment = texto; }
    res.json({ ok: true, lidas: todas.length, alvo: alvo.length, respondidas: r.ok.length, falhas: r.falhas.slice(0, 20), totalFalhas: r.falhas.length });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Resposta automática diária das avaliações 4★ e 5★ (uma vez por dia por loja, a partir das 9h de Brasília)
const ARQ_AUTO_AVAL = path.join(DATA, 'shopee_auto_avaliacoes.json');
let autoAval = (() => { try { const v = JSON.parse(fs.readFileSync(ARQ_AUTO_AVAL)); return v.ultimoDia !== undefined ? { zagodini: v } : v; } catch (e) { return {}; } })();
async function autoResponderAvaliacoes(forcar) {
  const agora = new Date(), dia = agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hora = Number(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  for (const k of Object.keys(SHP)) {
    const sp = shopee.loja(k), st = autoAval[k] ||= {};
    if (!forcar && (st.ultimoDia === dia || hora < 9)) continue;
    if (!sp.getTokens().access_token) continue;
    st.ultimoDia = dia;
    try {
      const todas = await sp.listarAvaliacoes(1000);
      const alvo = todas.filter(r => (r.rating_star === 4 || r.rating_star === 5) && !r.comment);
      const r = alvo.length ? await sp.responderAvaliacoesLote(alvo.map(x => x.rating_id), textoAval(k)) : { ok: [], falhas: [] };
      st.ultimo = { em: agora.toISOString(), respondidas: r.ok.length, falhas: r.falhas.length, erroExemplo: r.falhas[0]?.erro || null };
      console.log('[auto-avaliacoes] ' + k + ': ' + r.ok.length + ' respondidas, ' + r.falhas.length + ' falhas');
    } catch (e) {
      st.ultimo = { em: agora.toISOString(), erro: e.message };
      st.ultimoDia = null;   // tenta de novo na próxima verificação
      console.log('[auto-avaliacoes] ' + k + ' erro: ' + e.message);
    }
  }
  try { fs.writeFileSync(ARQ_AUTO_AVAL, JSON.stringify(autoAval)); } catch (e) {}
}
setInterval(() => autoResponderAvaliacoes().catch(() => {}), 15 * 60 * 1000);
setTimeout(() => autoResponderAvaliacoes().catch(() => {}), 90 * 1000);
app.get('/shopee/auto-avaliacoes', (req, res) => res.json(autoAval[lojaDe(req)] || {}));

// ─── Impulsionar automático (Shopee) ─────────────────────────────────────────
// A Shopee deixa 5 produtos impulsionados por vez, por 4h. Alterna as rodadas:
//   rodada "top"   → os 5 mais vendidos (15 dias)
//   rodada "novos" → produtos criados nos últimos 30 dias (do mais novo para o mais antigo, em rodízio)
//   rodada "fila"  → os próximos 5 do fim da lista (menos vendidos), andando até zerar e recomeçar
//   ordem: mais vendidos → novos → fim da lista → mais vendidos…  (sem novos, pula direto para o fim da lista)
// Só produtos ativos com estoque. Verifica a cada 10 min e preenche as vagas livres.
const ARQ_BOOST = path.join(DATA, 'shopee_boost_auto.json');
let boostSt = (() => { try { return JSON.parse(fs.readFileSync(ARQ_BOOST)); } catch (e) { return {}; } })();
const salvarBoost = () => { try { fs.writeFileSync(ARQ_BOOST, JSON.stringify(boostSt)); } catch (e) {} };
function estoqueShp(p) { return p._variacoes?.length ? p._variacoes.reduce((a, v) => a + (v.estoque || 0), 0) : (p.stock_info_v2?.summary_info?.total_available_stock ?? 0); }
async function cicloBoost(k) {
  const sp = shopee.loja(k), C = SHP[k].cache;
  if (!sp.getTokens().access_token || !C?.produtos?.length) return;
  const st = boostSt[k] ||= { ativo: true, proxima: 'top', fila: 0, historico: [] };
  if (st.ativo === false) return;
  const atuais = await sp.impulsionados();
  const ocupados = new Set(atuais.map(x => String(x.item_id)));
  await medirBoost(k, sp, st, ocupados, C).catch(e => console.log('[boost] medição ' + k + ': ' + e.message));
  const livres = 5 - atuais.length;
  if (livres <= 0) return;
  // vendas por item (15 dias)
  const vend = {};
  for (const o of C.pedidos || []) if (!['CANCELLED', 'UNPAID', 'IN_CANCEL'].includes(o.order_status))
    for (const i of o.item_list || []) vend[i.item_id] = (vend[i.item_id] || 0) + (i.model_quantity_purchased || 1);
  const elegiveis = C.produtos.filter(p => estoqueShp(p) > 0);
  const porVenda = [...elegiveis].sort((a, b) => (vend[b.item_id] || 0) - (vend[a.item_id] || 0));
  const top = porVenda.slice(0, 5);
  const topIds = new Set(top.map(p => String(p.item_id)));
  const fila = porVenda.filter(p => !topIds.has(String(p.item_id))).reverse();   // do menos vendido para cima
  const limNovo = Date.now() / 1000 - 60 * 86400;   // item novo = criado nos últimos 60 dias
  const novos = elegiveis.filter(p => (p.create_time || 0) >= limNovo && !topIds.has(String(p.item_id))).sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  // Sempre preenche as 5 vagas na mesma rodada: começa pelo tipo da vez e, se faltar item, completa com os próximos tipos
  const ORDEM = ['top', 'novos', 'fila'];
  const escolhidos = [], tipoDe = {}, usado = id => ocupados.has(String(id)) || escolhidos.some(p => String(p.item_id) === String(id));
  const pegar = t => {
    if (t === 'top') { for (const p of top) if (escolhidos.length < livres && !usado(p.item_id)) { escolhidos.push(p); tipoDe[p.item_id] = t; } return; }
    if (t === 'novos') {
      if (!novos.length) return;
      if (!(st.novos >= 0) || st.novos >= novos.length) st.novos = 0;   // 1ª rodada de novos: índice ainda não existia
      for (let n = 0; escolhidos.length < livres && n < novos.length; n++) {
        const p = novos[st.novos]; st.novos = (st.novos + 1) % novos.length;
        if (p && !usado(p.item_id)) { escolhidos.push(p); tipoDe[p.item_id] = t; }
      }
      return;
    }
    // fila: do menos vendido para cima; ao chegar no fim, volta ao começo (até completar as vagas)
    if (!fila.length) return;
    if (st.fila >= fila.length) st.fila = 0;
    for (let n = 0; escolhidos.length < livres && n < fila.length; n++) {
      const p = fila[st.fila++];
      if (st.fila >= fila.length) { st.fila = 0; st.voltas = (st.voltas || 0) + 1; }
      if (p && !usado(p.item_id)) { escolhidos.push(p); tipoDe[p.item_id] = t; }
    }
  };
  const ini = ORDEM.includes(st.proxima) ? ORDEM.indexOf(st.proxima) : 0;
  for (let i = 0; i < ORDEM.length && escolhidos.length < livres; i++) pegar(ORDEM[(ini + i) % ORDEM.length]);
  // tipo da rodada = o primeiro que entrou (a alternância segue a partir dele)
  const tipo = escolhidos.length ? tipoDe[escolhidos[0].item_id] : ORDEM[ini];
  if (!escolhidos.length) return;
  const r = await sp.impulsionar(escolhidos.map(p => p.item_id));
  const okSet = new Set(r.ok.map(String));
  const feitos = escolhidos.filter(p => okSet.has(String(p.item_id)));
  // medição: anota visualizações e vendas no início do impulsionamento
  if (feitos.length) {
    try {
      const ex = await extraShp(sp, feitos.map(p => p.item_id));
      const M = st.medicao ||= { ativos: {}, resultados: [] };
      for (const p of feitos) { const x = ex[p.item_id]; if (x) M.ativos[p.item_id] = { nome: p.item_name, tipo: tipoDe[p.item_id] || tipo, t0: Date.now(), v0: x.views, s0: x.sale }; }
    } catch (e) { console.log('[boost] medição início ' + k + ': ' + e.message); }
  }
  st.proxima = tipo === 'top' ? 'novos' : tipo === 'novos' ? 'fila' : 'top';
  st.ultimo = { em: new Date().toISOString(), tipo, itens: feitos.map(p => ({ id: p.item_id, nome: p.item_name, vendas: vend[p.item_id] || 0, tipo: tipoDe[p.item_id] })), falhas: r.falhas.slice(0, 5), filaPos: st.fila, filaTotal: fila.length, novosTotal: novos.length };
  st.historico = [st.ultimo, ...(st.historico || [])].slice(0, 20);
  salvarBoost();
  console.log('[boost] ' + k + ' ' + tipo + ': ' + feitos.length + ' impulsionados, ' + r.falhas.length + ' falhas');
  // Telegram só em caso de erro (nenhum item impulsionado na rodada); o registro de cada rodada fica no painel
  if (!feitos.length) await avisarErroBoost(k, sp.nome, 'nenhum item impulsionado: ' + (r.falhas.map(f => f.erro || f.msg || JSON.stringify(f)).slice(0, 2).join('; ') || 'sem detalhe'));
}
// ─── Medição do impulsionamento: visualizações e vendas durante as 4h vs o ritmo normal do produto ───
async function extraShp(sp, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await sp.shopeeGet('/api/v2/product/get_item_extra_info', { item_id_list: ids.slice(i, i + 50).join(',') });
    for (const x of d.response?.item_list || []) out[x.item_id] = { views: x.views || 0, sale: x.sale || 0 };
  }
  return out;
}
async function medirBoost(k, sp, st, ocupados, C) {
  const M = st.medicao ||= { ativos: {}, resultados: [] };
  const agora = Date.now(), hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  // foto diária das visualizações de todos os produtos (base para o ritmo normal)
  if (M.fotoDia !== hoje && C.produtos?.length) {
    const ex = await extraShp(sp, C.produtos.map(p => p.item_id));
    M.fotos = { ...(M.fotos || {}), [hoje]: Object.fromEntries(Object.entries(ex).map(([id, x]) => [id, x.views])) };
    const dias = Object.keys(M.fotos).sort(); while (dias.length > 15) delete M.fotos[dias.shift()];
    M.fotoDia = hoje;
  }
  // impulsionamentos que terminaram: mede o ganho
  const fim = Object.keys(M.ativos).filter(id => !ocupados.has(String(id)) || agora - M.ativos[id].t0 > 4.5 * 3600e3);
  if (!fim.length) { salvarBoost(); return; }
  const ex = await extraShp(sp, fim);
  const dias = Object.keys(M.fotos || {}).sort();
  for (const id of fim) {
    const a = M.ativos[id], x = ex[id]; delete M.ativos[id];
    if (!x) continue;
    const horas = Math.max(0.5, (agora - a.t0) / 3600e3);
    // ritmo normal: visualizações por hora entre a foto mais antiga e a mais recente (até 15 dias)
    let base = null;
    if (dias.length >= 2) { const d0 = dias[0], d1 = dias[dias.length - 1], v0 = M.fotos[d0][id], v1 = M.fotos[d1][id];
      const h = (Date.parse(d1) - Date.parse(d0)) / 3600e3; if (v0 != null && v1 != null && h > 0) base = Math.max(0, (v1 - v0) / h); }
    M.resultados.unshift({ id, nome: a.nome, tipo: a.tipo, inicio: new Date(a.t0).toISOString(), horas: Math.round(horas * 10) / 10,
      views: Math.max(0, x.views - a.v0), vendas: Math.max(0, x.sale - a.s0), viewsNormal: base == null ? null : Math.round(base * horas * 10) / 10 });
  }
  M.resultados = M.resultados.slice(0, 200);
  salvarBoost();
}
app.get('/shopee/boost/resultados', (req, res) => {
  const M = boostSt[lojaDe(req)]?.medicao || {};
  res.json({ resultados: M.resultados || [], ativos: M.ativos || {}, dias: Object.keys(M.fotos || {}).length });
});
const _ultErroBoost = {};
async function avisarErroBoost(k, nome, msg) {
  const st = boostSt[k] ||= { ativo: true, proxima: 'top', fila: 0, historico: [] };
  st.historico = [{ em: new Date().toISOString(), tipo: 'erro', erro: String(msg).slice(0, 200), itens: [] }, ...(st.historico || [])].slice(0, 20);
  salvarBoost();
  const chave = k + '|' + String(msg).slice(0, 60);
  if (_ultErroBoost[chave] && Date.now() - _ultErroBoost[chave] < 6 * 3600e3) return;   // mesmo erro: no máximo 1 aviso a cada 6h
  _ultErroBoost[chave] = Date.now();
  try { const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    await require('./telegram').sendTelegram('⚠️ <b>Impulsionar Shopee com erro - ' + esc(nome) + '</b>\n' + esc(msg)); } catch (e) {}
}
async function boostTodas() { for (const k of Object.keys(SHP)) await cicloBoost(k).catch(e => { console.log('[boost] ' + k + ' erro: ' + e.message); return avisarErroBoost(k, SHP[k]?.cache?.nome || k, e.message); }); }
setInterval(boostTodas, 10 * 60 * 1000);
setTimeout(boostTodas, 3 * 60 * 1000);
app.get('/shopee/boost', (req, res) => { const { medicao, ...b } = boostSt[lojaDe(req)] || { ativo: true }; res.json(b); });
app.post('/shopee/boost/ativo', (req, res) => {
  const k = lojaDe(req); const st = boostSt[k] ||= { ativo: true, proxima: 'top', fila: 0 };
  st.ativo = !!req.body?.ativo; salvarBoost();
  if (st.ativo) cicloBoost(k).catch(() => {});
  res.json({ ok: true, ativo: st.ativo });
});

app.post('/shopee/reply-rating', async (req, res) => {
  try {
    const { rating_id, comment } = req.body;
    const result = await shopee.loja(lojaDe(req)).replyRating(rating_id, comment);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Página Início: pendências e divergência de estoque de todas as empresas
async function mlReq(idx, method, path, body, headers = {}) { const r = await axios({ method, url: BASE + path, data: body, headers: { Authorization: 'Bearer ' + getToken(idx), ...headers } }); return { data: r.data, headers: r.headers }; }
async function mlPut(idx, path, body) { return (await axios.put(BASE + path, body, { headers: { Authorization: 'Bearer ' + getToken(idx) } })).data; }
require('./inicio')(app, { ml, mlPut, mlReq, dadosCache, SHP, AZ_ANUNCIOS, extrairSKU, estoqueShp });
require('./posvenda')(app, { ml, dadosCache });
require('./full')(app, { ml }); // envio para o Full: reposição, novos e parados
require('./apuracao_mkt').setFontes({ ml }); // apuração: ML direto da API
require('./relatorio_diario')(app); // relatório diário (PDF no Telegram às 06:00)
require('./nf_cancelar')(app, { ml });
require('./turbo')(app, { dadosCache });
require('./tiny3')(app);
require('./fornecedores').iniciar(); require('./fornecedores').rotas(app); // fornecedor por SKU (apuração por fornecedor)
require('./nfe_shein')(app); // NF-e automática dos pedidos SHEIN no Bling
require('./despesas')(app); // despesas fixas → DRE e ponto de equilíbrio

// Só as telas são públicas para quem está logado — nunca a pasta inteira (.env, tokens...)
app.get('/', (req, res) => res.redirect('/painel.html'));
for (const pg of ['painel.html', 'painel_ads.html', 'apuracao_painel.html'])
  app.get('/' + pg, (req, res) => res.sendFile(path.join(__dirname, pg)));

process.on('unhandledRejection', e => console.error('[erro não tratado]', e?.message || e));
process.on('uncaughtException', e => console.error('[exceção não tratada]', e?.message || e));
const PORT = process.env.PORT || 3000;
// Aviso no Telegram vindo da extensão "Monitor Full ML" (Chrome do Diego, logado no painel)
app.post('/alertas/telegram', express.json(), async (req, res) => {
  if (require('./auth').ativo() && !req.usuario) return res.status(401).json({ erro: 'login' });
  const texto = String(req.body?.texto || '').slice(0, 1000);
  if (!texto) return res.status(400).json({ erro: 'sem texto' });
  try { await require('./telegram').sendTelegram(texto); res.json({ ok: true }); } catch (e) { res.status(500).json({ erro: e.message }); }
});
const _uidML = {};
require('./promos_ml').rotas(app, { ml, mlReq, dados: () => dadosCache, uid: async idx => (_uidML[idx] ||= (await ml(idx, '/users/me')).id) }); // Promoções do ML com margem, rebate e catálogo
require('./ads_ml').rotas(app, { ml, token: getToken, dados: () => dadosCache, uid: async idx => (_uidML[idx] ||= (await ml(idx, '/users/me')).id) }); // ADS do ML com lucro real
require('./ads_plano').rotas(app); // ADS: o que fazer hoje (7 e 15 dias, todas as contas)
require('./precos').rotas(app, { ml: () => dadosCache, shp: () => SHP, az: () => AZ_ANUNCIOS,
  // "Refazer análise agora": baixa a planilha de novo e recarrega os sites da empresa
  refazer: (idx, k) => {
    require('./onedrive').sincronizar(idx).catch(() => {});
    if (statusCache[idx] !== 'carregando') carregarConta(idx);
    if (SHP[k] && SHP[k].status !== 'carregando') { SHP[k].status = 'aguardando'; carregarShopee(k); }
    if (amazon.loja(k).configurada() && AZ_ANUNCIOS[k]?.status !== 'carregando') carregarAnunciosAmazon(k).catch(() => {});
  },
  situacao: (idx, k) => ({ ml: { status: statusCache[idx], progresso: progressoCache[idx] }, shopee: SHP[k]?.status || null, amazon: AZ_ANUNCIOS[k]?.status || null, amazonEtapa: AZ_ANUNCIOS[k]?.etapa || null }) }); // Conferência de preços: planilha × sites

app.listen(PORT, async () => {
  console.log('Servidor rodando na porta ' + PORT + ' — dados em ' + DATA);
  await renovarTodos();
  carregarTodas();
  for (const k of Object.keys(SHP)) await carregarShopee(k);
  setInterval(async () => {
    await renovarTodos();
    carregarTodas();
    for (const k of Object.keys(SHP)) {
      if (shopee.loja(k).getTokens().refresh_token) await shopee.loja(k).refreshToken().catch(() => {});
      await carregarShopee(k);
    }
    for (const i of [0,1,2]) await bling.refreshToken(i).catch(() => {});
  }, 30 * 60 * 1000);
});
