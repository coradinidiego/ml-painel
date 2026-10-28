/**
 * Full (Mercado Livre) — custos por estoque antigo, automático (Zagodini e Com Amor de Mãe).
 *
 * A API do ML não informa a idade das unidades; o painel calcula pelas movimentações do Full
 * (/stock/fulfillment/operations/search, janelas de 60 dias): as unidades em estoque hoje são as
 * entradas mais recentes (o Full despacha primeiro as mais antigas — FIFO). Entradas = transferência/
 * recebimento/ajuste positivo. Cancelamentos e devoluções não "rejuvenescem" a unidade.
 *
 * Tarifa por unidade/mês (não supermercado):  ≤4m grátis | 4–6m | 6–12m | >12m
 *   Pequeno 0 | 1,00 | 12,00 | 28,00     Médio 0 | 2,00 | 15,90 | 35,00
 *   Grande  0 | 6,00 | 40,00 | 92,00     Extragrande 0 | 8,00 | 52,00 | 145,00
 * Cobrança mensal no dia DIA_COBRANCA (24). Tamanho estimado pelas medidas da embalagem (ajustável na tela).
 *
 *  GET  /full/estoque/:idx        lista
 *  POST /full/estoque/:idx/atualizar
 *  POST /full/estoque/:idx/tamanho   { inv, tamanho: P|M|G|XG }
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const CONTAS = [0, 1];
const DIA_COBRANCA = 24;
const TARIFA = { P: [0, 1, 12, 28], M: [0, 2, 15.9, 35], G: [0, 6, 40, 92], XG: [0, 8, 52, 145] };
const NOME_TAM = { P: 'Pequeno', M: 'Médio', G: 'Grande', XG: 'Extragrande' };
const arq = idx => path.join(DATA, 'apuracao_cache', `full_estoque_${idx}.json`);
const arqTam = path.join(DATA, 'full_tamanhos.json');
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const gravar = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;
const ST = {};   // idx -> { rodando, fase, feitos, total, inicio, fim, erro }

function proximaCobranca(hoje = new Date()) {
  const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), DIA_COBRANCA, 12));
  if (d <= hoje) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
// meses (fração) entre a entrada e a data
const meses = (de, ate) => (ate - de) / (30.44 * 864e5);
const faixa = m => m < 4 ? 0 : m < 6 ? 1 : m < 12 ? 2 : 3;

// tamanho pelas medidas da embalagem (cm / g) — aproximação; o usuário pode corrigir
function tamanhoPorMedidas(it) {
  const at = id => { const a = (it.attributes || []).find(x => x.id === id); const v = parseFloat(String(a?.value_struct?.number ?? a?.value_name ?? '').replace(',', '.')); if (isNaN(v)) return null; const u = a?.value_struct?.unit || ''; return /mm/.test(u) ? v / 10 : /kg/.test(u) ? v * 1000 : v; };
  let dims = [at('PACKAGE_LENGTH') || at('SELLER_PACKAGE_LENGTH'), at('PACKAGE_WIDTH') || at('SELLER_PACKAGE_WIDTH'), at('PACKAGE_HEIGHT') || at('SELLER_PACKAGE_HEIGHT')].filter(Boolean);
  let peso = at('PACKAGE_WEIGHT') || at('SELLER_PACKAGE_WEIGHT');
  const sd = it.shipping?.dimensions; // "30x20x10,500"
  if (dims.length < 3 && sd) { const m = String(sd).match(/([\d.]+)x([\d.]+)x([\d.]+),([\d.]+)/); if (m) { dims = [+m[1], +m[2], +m[3]]; peso = peso || +m[4]; } }
  if (dims.length < 3) return null;
  const max = Math.max(...dims), soma = dims.reduce((a, b) => a + b, 0), kg = (peso || 0) / 1000;
  if (max <= 28 && soma <= 60 && kg <= 2) return 'P';
  if (max <= 60 && soma <= 120 && kg <= 10) return 'M';
  if (max <= 100 && soma <= 200 && kg <= 25) return 'G';
  return 'XG';
}

module.exports = function (app, { ml, dadosCache, getUid }) {
  let fila = Promise.resolve();
  // chamadas em série, devagar (a API de operações tem cota baixa)
  const get = (idx, p, params) => (fila = fila.then(async () => {
    for (let t = 0; t < 40; t++) {
      try { const r = await ml(idx, p, params); await delay(1500); return r; }
      catch (e) {
        // cota da API de operações do Full: espera e continua de onde parou (pode levar horas na 1ª vez)
        if (e.response?.status === 429) { const st = ST[idx]; if (st) st.aguardando = 'cota da API do ML esgotada — aguardando (' + (t + 1) + ')'; await delay(Math.min(15, 2 + t) * 60e3); if (st) delete st.aguardando; continue; }
        if (e.response?.status === 404) return null; throw e;
      }
    }
    throw new Error('limite da API do ML');
  }));

  async function operacoes(idx, uid, inv, precisa) {
    // volta no tempo em janelas de 60 dias até cobrir as unidades em estoque (máx. ~16 meses)
    const ops = []; let fim = new Date(), entradas = 0, vendas30 = 0;
    for (let w = 0; w < 8; w++) {
      const ini = new Date(fim.getTime() - 59 * 864e5);
      const d = await get(idx, '/stock/fulfillment/operations/search', { seller_id: uid, inventory_id: inv, date_from: ymd(ini), date_to: ymd(fim) });
      const L = d?.results || [];
      ops.push(...L);
      for (const o of L) {
        const q = +o.detail?.available_quantity || 0;
        if (w === 0 && o.type === 'SALE_CONFIRMATION' && Date.parse(o.date_created) > Date.now() - 30 * 864e5) vendas30 += -q;
        if (q > 0 && !/SALE_CANCEL|RETURN|DEVOLU/i.test(o.type)) entradas += q;
      }
      if (entradas >= precisa) break;
      fim = new Date(ini.getTime() - 864e5);
    }
    return { ops, vendas30 };
  }

  async function atualizar(idx) {
    if (ST[idx]?.rodando) return;
    const st = ST[idx] = { rodando: true, fase: 'Listando anúncios do Full...', feitos: 0, total: 0, inicio: new Date().toISOString() };
    try {
      const uid = await getUid(idx);
      const ids = [];
      for (let scroll = null, k = 0; k < 40; k++) {
        const d = await get(idx, `/users/${uid}/items/search`, { logistic_type: 'fulfillment', search_type: 'scan', limit: 100, ...(scroll ? { scroll_id: scroll } : {}) });
        const r = d?.results || []; ids.push(...r); scroll = d?.scroll_id; if (!r.length || !scroll) break;
      }
      // inventários (anúncio sem variação ou cada variação)
      const invs = new Map();
      for (let i = 0; i < ids.length; i += 20) {
        const L = await get(idx, '/items', { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title,price,status,inventory_id,seller_custom_field,attributes,shipping,variations,catalog_product_id,catalog_listing,thumbnail' });
        for (const w of L || []) {
          const it = w.body || w; if (!it?.id) continue;
          const sku = (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || it.seller_custom_field || '';
          const base = { item: it.id, titulo: it.title, preco: it.price, status: it.status, sku, catalogo: !!it.catalog_listing, tamEst: tamanhoPorMedidas(it), thumb: it.thumbnail };
          if (it.inventory_id) invs.set(it.inventory_id, { ...base, inv: it.inventory_id });
          for (const v of it.variations || []) if (v.inventory_id) invs.set(v.inventory_id, { ...base, inv: v.inventory_id, variacao: (v.attribute_combinations || []).map(a => a.value_name).join(' / '), sku: v.seller_custom_field || sku });
        }
      }
      st.total = invs.size; st.fase = 'Estoque e movimentações...';
      const cob = proximaCobranca(), out = [];
      for (const x of invs.values()) {
        try {
          const s = await get(idx, `/inventories/${x.inv}/stock/fulfillment`);
          const total = +s?.total || 0;
          if (total > 0) {
            const { ops, vendas30 } = await operacoes(idx, uid, x.inv, total);
            // FIFO: as unidades de hoje são as entradas mais recentes
            const ent = ops.filter(o => (+o.detail?.available_quantity || 0) > 0 && !/SALE_CANCEL|RETURN|DEVOLU/i.test(o.type))
              .map(o => ({ d: Date.parse(o.date_created), q: +o.detail.available_quantity })).sort((a, b) => b.d - a.d);
            let resta = total; const lotes = [];
            for (const e of ent) { if (resta <= 0) break; const q = Math.min(resta, e.q); lotes.push({ d: e.d, q }); resta -= q; }
            if (resta > 0) lotes.push({ d: Date.now() - 400 * 864e5, q: resta, semData: true });   // mais antigas que o histórico consultado
            // projeção até a cobrança: vende as mais antigas primeiro
            const porDia = vendas30 / 30, dias = Math.max(0, (cob - Date.now()) / 864e5);
            let vende = Math.floor(porDia * dias);
            const hoje = [0, 0, 0, 0], naCob = [0, 0, 0, 0];
            const asc = [...lotes].sort((a, b) => a.d - b.d);
            for (const l of asc) {
              hoje[faixa(meses(l.d, Date.now()))] += l.q;
              const fica = Math.max(0, l.q - vende); vende = Math.max(0, vende - l.q);
              naCob[faixa(meses(l.d, cob))] += fica;
            }
            out.push({ ...x, total, disponivel: +s?.available_quantity || 0, vendas30, porDia: r2(porDia), cobertura: porDia > 0 ? Math.round(total / porDia) : null,
              hoje, naCob, maisAntiga: asc[0] ? ymd(new Date(asc[0].d)) : null, semData: lotes.some(l => l.semData) });
          }
        } catch (e) { st.ultimoErro = x.inv + ': ' + e.message; }
        st.feitos++;
        if (st.feitos % 20 === 0) gravar(arq(idx), { em: new Date().toISOString(), cobranca: ymd(cob), itens: out, parcial: true });
      }
      gravar(arq(idx), { em: new Date().toISOString(), cobranca: ymd(cob), itens: out });
      Object.assign(st, { fase: 'Concluído', fim: new Date().toISOString() });
    } catch (e) { st.erro = e.message; st.fase = 'Erro: ' + e.message; }
    st.rodando = false;
  }

  function montar(idx) {
    const d = ler(arq(idx), null); if (!d) return null;
    const tam = ler(arqTam, {}), cache = dadosCache[idx] || {};
    const cat = {}; for (const k of ['perdendo', 'ganhando', 'grupo']) for (const it of cache[k] || []) cat[it.id] = { st: k, ptw: it.price_to_win, lucroAtual: it.lucro_atual_pct, lucroPtw: it.lucro_ptw_pct, custo: it.custo_produto };
    const itens = d.itens.map(x => {
      const t = tam[x.inv] || x.tamEst || 'M', T = TARIFA[t];
      const custoCob = r2(x.naCob.reduce((s, q, i) => s + q * T[i], 0)), custoHoje = r2(x.hoje.reduce((s, q, i) => s + q * T[i], 0));
      const c = cat[x.item] || null;
      // sugestão
      let sug = 'ok';
      if (custoCob > 0) {
        if (x.cobertura != null && x.cobertura <= 30) sug = 'vende a tempo';
        else if (c?.st === 'perdendo' && c.ptw) sug = 'baixar para ganhar';
        else if (!x.porDia) sug = (x.naCob[2] + x.naCob[3]) > 0 ? 'retirar ou liquidar' : 'promover';
        else sug = 'promover';
      }
      return { ...x, tamanho: t, tamanhoNome: NOME_TAM[t], tamanhoAjustado: !!tam[x.inv], custoCob, custoHoje, unidCobradas: x.naCob[1] + x.naCob[2] + x.naCob[3], catalogo: c, sugestao: sug };
    }).sort((a, b) => b.custoCob - a.custoCob || b.custoHoje - a.custoHoje);
    return { em: d.em, cobranca: d.cobranca, parcial: !!d.parcial, total: r2(itens.reduce((s, x) => s + x.custoCob, 0)), produtos: itens.filter(x => x.custoCob > 0).length, itens };
  }

  app.get('/full/estoque/:idx', (req, res) => {
    const idx = +req.params.idx; if (!CONTAS.includes(idx)) return res.json({ semFull: true });
    res.json({ status: ST[idx] || null, tarifas: TARIFA, ...(montar(idx) || { itens: [] }) });
  });
  app.get('/full/resumo', (req, res) => res.json(Object.fromEntries(CONTAS.map(i => { const m = montar(i); return [i, m ? { total: m.total, produtos: m.produtos, cobranca: m.cobranca, em: m.em } : null]; }))));
  app.post('/full/estoque/:idx/atualizar', (req, res) => { const idx = +req.params.idx; if (!CONTAS.includes(idx)) return res.status(400).json({ erro: 'conta sem Full' }); atualizar(idx).catch(() => {}); res.json({ ok: true }); });
  app.post('/full/estoque/:idx/tamanho', require('express').json(), (req, res) => {
    const t = ler(arqTam, {}), { inv, tamanho } = req.body || {};
    if (!inv || !TARIFA[tamanho]) return res.status(400).json({ erro: 'dados inválidos' });
    t[inv] = tamanho; gravar(arqTam, t); res.json({ ok: true });
  });
  // roda 1x por dia de madrugada (03h), uma conta de cada vez
  setInterval(async () => {
    const h = new Date(Date.now() - 3 * 3600e3);
    if (h.getUTCHours() !== 3) return;
    for (const i of CONTAS) { const d = ler(arq(i), null); if (d?.em && Date.now() - Date.parse(d.em) < 20 * 3600e3) continue; await atualizar(i).catch(() => {}); }
  }, 15 * 60e3).unref?.();
};
