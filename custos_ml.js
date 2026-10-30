/**
 * Margem dos anúncios de catálogo: lucro % no preço atual e no "preço para ganhar".
 *
 *  lucro = preço − custo do produto − tarifa de venda do ML (comissão + taxa fixa)
 *          − embalagem − custo de envio do vendedor (ML cobra por peso/faixa de preço, inclusive abaixo de R$ 79) − imposto
 *
 *  - Custo: ERP primeiro — Bling (Zagodini, Com Amor de Mãe) / Tiny (Lufe), preço de custo do produto;
 *           planilha de precificação só como reserva para SKUs sem custo no ERP.
 *  - Tarifa: API do ML /sites/MLB/listing_prices (por preço, tipo de anúncio e categoria).
 *  - Frete: API do ML /users/{id}/shipping_options/free (custo do vendedor no anúncio).
 *  - Imposto e embalagem: config_empresas.js (página Conta).
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const DATA = require('./dados');

const PLANILHAS = {
  0: 'Precificacao Comercial Zagodini.xlsx',
  1: 'Precificacao Atelie Com S2 de Mãe.xlsx',
  2: 'Precificacao Nova.xlsx',
};
const K = v => (v === null || v === undefined || v === '') ? null : String(v).trim().toUpperCase();
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : n; };

// ─── Custos por SKU a partir da planilha ───────────────────────────────────
const _custos = {};
function custosConta(idx) {
  const arq = path.join(DATA, PLANILHAS[idx] || '');
  let mtime; try { mtime = fs.statSync(arq).mtimeMs; } catch (e) { return null; }
  if (_custos[idx]?.mtime === mtime) return _custos[idx].mapa;
  const wb = XLSX.readFile(arq);
  const mapa = {};
  // abas do ML primeiro (composição de kit igual à do anúncio), depois Base, depois as demais
  const ordem = [...wb.SheetNames].sort((a, b) => peso(a) - peso(b));
  function peso(n) { return /ml|full|mercado/i.test(n) ? 0 : /base|custo/i.test(n) ? 1 : 2; }
  for (const aba of ordem) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
    // acha a linha de cabeçalho (até a 8ª) com uma coluna de código
    let h = -1, cCod = -1, cTot = -1, cUn = -1, cQtd = -1;
    for (let i = 0; i < Math.min(8, linhas.length) && h < 0; i++) {
      const r = linhas[i] || [];
      const idxCod = r.findIndex(c => /^(c[oó]d(igo)?|sku)$/i.test(String(c || '').trim()));
      if (idxCod < 0) continue;
      h = i; cCod = idxCod;
      r.forEach((c, j) => {
        const t = String(c || '').trim();
        if (cTot < 0 && /^custo\s*total$/i.test(t)) cTot = j;
        if (cUn < 0 && /^(custo\s*(un|und|unit[aá]rio)\.?|unit[aá]rio)$/i.test(t)) cUn = j;
        if (cQtd < 0 && /^(qtd|qnde|quantidade)$/i.test(t)) cQtd = j;
      });
    }
    if (h < 0 || (cTot < 0 && cUn < 0)) continue;
    for (const r of linhas.slice(h + 1)) {
      const sku = K(r[cCod]); if (!sku || sku in mapa) continue;
      const q = num(r[cQtd]) || 1, tot = num(r[cTot]), un = num(r[cUn]);
      const custo = tot > 0 ? tot : (un > 0 ? un * q : null);
      if (custo) mapa[sku] = custo;
    }
  }
  _custos[idx] = { mtime, mapa };
  return mapa;
}

// ─── Custo fixo por SKU de uma aba de canal (ex.: Shein "Custo Fixo") ───────
const _fixos = {};
function fixosCanal(idx, canal) {
  const arq = path.join(DATA, PLANILHAS[idx] || '');
  let mtime; try { mtime = fs.statSync(arq).mtimeMs; } catch (e) { return {}; }
  const ck = idx + '|' + canal;
  if (_fixos[ck]?.mtime === mtime) return _fixos[ck].mapa;
  const mapa = {};
  try {
    const wb = XLSX.readFile(arq);
    const re = new RegExp('^\\s*' + canal.replace(/\s+/g, '\\s*') + '\\s*$', 'i');
    const aba = wb.SheetNames.find(n => re.test(n));
    if (aba) {
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
      for (let i = 0; i < Math.min(8, linhas.length); i++) {
        const r = linhas[i] || [], cCod = r.findIndex(c => /^(c[oó]d(igo)?|sku)$/i.test(String(c || '').trim()));
        const cFx = r.findIndex(c => /^custo\s*fixo$/i.test(String(c || '').trim()));
        if (cCod < 0 || cFx < 0) continue;
        for (const l of linhas.slice(i + 1)) { const sku = K(l[cCod]); const v = num(l[cFx]); if (sku && !(sku in mapa) && v != null && v >= 0 && v < 100) mapa[sku] = v; }
        break;
      }
    }
  } catch (e) { console.warn('[custos] fixos', idx, canal, e.message); }
  _fixos[ck] = { mtime, mapa };
  return mapa;
}
// ─── Custos do ERP (Bling / Tiny), cache de 6h em memória e em disco ───────
const _erp = {};
async function custosErp(idx) {
  atualizarKitsBling(idx);   // composição dos kits do Bling (1x/dia, sem travar)
  const arq = path.join(DATA, 'apuracao_cache', `custos_erp_v2_${idx}.json`);
  if (!_erp[idx]) { try { _erp[idx] = JSON.parse(fs.readFileSync(arq)); } catch (e) { _erp[idx] = { ts: 0, mapa: {} }; } }
  if (!Object.keys(historico(idx)).length && Object.keys(_erp[idx].mapa || {}).length) registrarHistorico(idx, _erp[idx].mapa);
  if (Date.now() - _erp[idx].ts < 6 * 3600e3) return _erp[idx].mapa;
  const mapa = {};
  try {
    if (idx === 2) {
      // Tiny: mapeia pelo código e pelo GTIN/EAN (os anúncios da Lufe no ML usam o EAN como SKU)
      const tiny = require('./tiny');
      for (let pagina = 1, total = 1; pagina <= total && pagina <= 50; pagina++) {
        const ret = await tiny.chamar('produtos.pesquisa.php', { pesquisa: '', pagina });
        if (ret.vazio) break;
        total = parseInt(ret.numero_paginas || 1);
        for (const x of ret.produtos || []) {
          const p = x.produto || {};
          const c = num(p.preco_custo) > 0 ? num(p.preco_custo) : num(p.preco_custo_medio);
          if (!(c > 0)) continue;
          if (p.codigo) mapa[K(p.codigo)] = c;
          if (p.gtin) mapa[K(p.gtin)] = c;
        }
        await new Promise(r => setTimeout(r, 1100));
      }
    } else {
      const b = await require('./bling').getCustosPorSku(idx);
      for (const [sku, c] of Object.entries(b)) if (c > 0) mapa[K(sku)] = c;
    }
    _erp[idx] = { ts: Date.now(), mapa };
    try { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(_erp[idx])); } catch (e) {}
    registrarHistorico(idx, mapa);
  } catch (e) { console.warn('[custos ERP]', idx, e.message); }  // falhou: mantém o último cache
  return _erp[idx].mapa;
}

// ─── Histórico de custos do ERP (o painel guarda cada mudança de custo com a data) ───
// O Bling não guarda data do custo e a API v2 do Tiny também não: a cada leitura do ERP (6 h) o painel
// anota { sku: [[AAAA-MM-DD, custo], ...] } quando o custo muda. A apuração usa o custo vigente na data da venda.
const arqHist = idx => path.join(DATA, 'apuracao_cache', `custos_hist_${idx}.json`);
const _hist = {}, _naData = {};
const hojeSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function historico(idx) { if (!_hist[idx]) { try { _hist[idx] = JSON.parse(fs.readFileSync(arqHist(idx))); } catch (e) { _hist[idx] = {}; } } return _hist[idx]; }
function registrarHistorico(idx, mapa) {
  const h = historico(idx), d = hojeSP(); let mud = 0;
  for (const [k, v] of Object.entries(mapa)) {
    const L = h[k] ||= [], u = L[L.length - 1];
    if (u && Math.abs(u[1] - v) < 0.005) continue;
    if (u && u[0] === d) u[1] = v; else L.push([d, v]);
    mud++;
  }
  if (mud) try { fs.writeFileSync(arqHist(idx), JSON.stringify(h)); console.log('[custos] histórico', idx, mud, 'mudanças'); } catch (e) {}
}
function salvarHistorico(idx) { for (const x of Object.keys(_naData)) if (x.startsWith(idx + '|')) delete _naData[x]; try { fs.writeFileSync(arqHist(idx), JSON.stringify(historico(idx))); } catch (e) {} }
/** Mapa de custos do ERP vigente na data (AAAA-MM-DD). Antes do 1º registro vale o 1º custo conhecido. */
function custosNaData(idx, data, erpAtual) {
  const h = historico(idx); if (!data || !Object.keys(h).length) return erpAtual;
  const ck = idx + '|' + data + '|' + (_erp[idx]?.ts || 0);
  if (_naData[ck]) return _naData[ck];
  const m = { ...erpAtual };
  for (const [k, L] of Object.entries(h)) {
    if (!(k in m)) continue;   // produto sem custo hoje: segue sem custo
    let v = L[0][1]; for (const [d, c] of L) { if (d <= data) v = c; else break; }
    m[k] = v;
  }
  for (const x of Object.keys(_naData)) if (x.startsWith(idx + '|') && !x.endsWith('|' + (_erp[idx]?.ts || 0))) delete _naData[x];
  return (_naData[ck] = m);
}

function procurar(mapa, sku) {
  if (!mapa || !sku) return null;
  const s = K(sku);
  if (mapa[s] > 0) return mapa[s];
  const semZeros = s.replace(/^0+/, ''); if (mapa[semZeros] > 0) return mapa[semZeros];
  return kitOuComposicao(s, k => mapa[k] > 0 ? mapa[k] : null);
}
/** "SKU-3" = 3 × SKU (só sufixo 2..20 sem zero à esquerda; "-02" é variação, não kit);
 *  "A-B" com A e B cadastrados = composição (soma dos dois). */
function kitOuComposicao(s, get) {
  const m = s.match(/^(.*)-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[2]), base = get(m[1]);
  if (base != null && !/^0/.test(m[2]) && n >= 2 && n <= 20) return base * n;
  if (base != null && (/^0/.test(m[2]) || n === 1)) return base;   // "-01", "-02": variação do mesmo produto
  const partes = s.split('-');
  if (partes.length >= 2 && partes.every(x => x && get(x) != null)) return partes.reduce((t, x) => t + get(x), 0);
  return null;
}
// ─── Kits do Tiny: custo = soma dos componentes (produto pai × quantidade), nunca o custo do próprio kit ───
// A composição vem do Tiny v3 (tiny3.js grava kits_<idx>.json na importação diária). Sem composição importada,
// vale o padrão do SKU: "PAI-3" = 3 × PAI (sufixo 2..20 sem zero à esquerda). Como o custo do pai vem do
// histórico com data (custosNaData), o kit ganha um novo custo na mesma data em que o pai muda.
const arqKits = idx => path.join(DATA, 'apuracao_cache', `kits_${idx}.json`);
const _kits = {};
function kits(idx) { if (!_kits[idx]) { try { _kits[idx] = JSON.parse(fs.readFileSync(arqKits(idx))); } catch (e) { _kits[idx] = {}; } } return _kits[idx]; }
const _kitsRodando = {};
function atualizarKitsBling(idx) {
  if (idx === 2 || _kitsRodando[idx]) return;
  let idade = Infinity; try { idade = Date.now() - fs.statSync(arqKits(idx)).mtimeMs; } catch (e) {}
  if (idade < 24 * 3600e3) return;
  _kitsRodando[idx] = true;
  require('./bling').getKits(idx).then(m => { if (Object.keys(m).length) { salvarKits(idx, m); console.log('[kits Bling]', idx, Object.keys(m).length, 'kits'); } })
    .catch(e => console.warn('[kits Bling]', idx, e.message)).finally(() => { _kitsRodando[idx] = false; });
}
function salvarKits(idx, mapa) { _kits[idx] = mapa; try { fs.mkdirSync(path.dirname(arqKits(idx)), { recursive: true }); fs.writeFileSync(arqKits(idx), JSON.stringify(mapa)); } catch (e) {} }
function direto(mapa, s) { if (!mapa || !s) return null; if (mapa[s] > 0) return mapa[s]; const z = s.replace(/^0+/, ''); return mapa[z] > 0 ? mapa[z] : null; }
function custoKit(idx, sku, mapa) {
  const s = K(sku); if (!s) return null;
  const comp = kits(idx)[s];
  if (Array.isArray(comp) && comp.length) {
    let t = 0;
    for (const c of comp) { const v = direto(mapa, K(c.codigo)); if (v == null) return null; t += v * c.qtd; }
    return t;
  }
  const m = idx === 2 && s.match(/^(.*)-(\d+)$/);   // padrão do SKU só no Tiny; no Bling vale a composição cadastrada
  if (m && !/^0/.test(m[2])) { const n = parseInt(m[2]); if (n >= 2 && n <= 20) { const b = direto(mapa, m[1]); if (b != null) return b * n; } }
  return null;
}

/** Custo do SKU: ERP primeiro, planilha de reserva. Retorna { v, fonte } ou null. */
function custoComFonte(idx, sku, erp) {
  const k = custoKit(idx, sku, erp); if (k != null) return { v: k, fonte: (idx === 2 ? 'Tiny' : 'Bling') + ' (kit)' };
  const e = procurar(erp, sku); if (e != null) return { v: e, fonte: idx === 2 ? 'Tiny' : 'Bling' };
  const p = procurar(custosConta(idx), sku); if (p != null) return { v: p, fonte: 'planilha' };
  return null;
}

function custoSku(idx, sku) {
  const mapa = custosConta(idx); if (!mapa || !sku) return null;
  const s = K(sku);
  if (s in mapa) return mapa[s];
  const semZeros = s.replace(/^0+/, ''); if (semZeros in mapa) return mapa[semZeros];
  return kitOuComposicao(s, k => (k in mapa) ? mapa[k] : null);
}

function aliquota(idx) { return require('./config_empresas').porMlIdx(idx)?.imposto ?? (idx === 2 ? 0.05 : idx === 0 ? 0.11 : 0.09); }
function embalagem(idx) { return require('./config_empresas').porMlIdx(idx)?.embalagem ?? 0; }

// ─── Tarifas e frete do ML (com cache) ─────────────────────────────────────
const _tarifa = new Map(), _frete = new Map();
async function tarifaML(ml, idx, preco, tipo, categoria, itemId) {
  // sem Mercado Envios o ML cobra a taxa fixa abaixo de R$ 79 (com ME2 ela vira custo de frete)
  const modo = itemId ? await modoEnvio(ml, idx, itemId) : '';
  const k = `${preco.toFixed(2)}|${tipo}|${categoria}|${modo}`;
  if (_tarifa.has(k)) return _tarifa.get(k);
  const r = await ml(idx, '/sites/MLB/listing_prices', { price: preco.toFixed(2), listing_type_id: tipo, category_id: categoria, ...(modo ? { shipping_mode: modo } : {}) });
  const linha = Array.isArray(r) ? r.find(x => x.listing_type_id === tipo) || r[0] : r;
  const valor = num(linha?.sale_fee_amount);
  const v = valor == null ? null : { valor, pct: num(linha?.sale_fee_details?.percentage_fee), fixa: num(linha?.sale_fee_details?.fixed_fee) || 0, tipo: linha?.listing_type_name || tipo };
  if (v) _tarifa.set(k, v);
  return v;
}
// frete do vendedor NO PREÇO SIMULADO: o ML muda a faixa (abaixo/acima de R$ 79) e o desconto conforme o preço
const _modoEnvio = new Map();
async function modoEnvio(ml, idx, itemId) {
  let modo = _modoEnvio.get(itemId);
  if (!modo || Date.now() - modo.ts > 6 * 3600e3) { try { const it = await ml(idx, '/items/' + itemId, { attributes: 'shipping' }); modo = { m: it?.shipping?.mode || '', ts: Date.now() }; _modoEnvio.set(itemId, modo); } catch (e) { return ''; } }
  return modo.m;
}
async function freteML(ml, idx, uid, itemId, preco) {
  const k = itemId + '|' + (preco ? Math.round(preco * 100) : '');
  const c = _frete.get(k);
  if (c && Date.now() - c.ts < 6 * 3600e3) return c.v;
  try {
    // anúncio sem Mercado Envios (frete a combinar / retirada): o vendedor não paga frete ao ML
    const m = await modoEnvio(ml, idx, itemId);
    if (m && !/^me/.test(m)) { const v = { valor: 0, pesoG: null, semME: true }; _frete.set(k, { v, ts: Date.now() }); return v; }
    const r = await ml(idx, `/users/${uid}/shipping_options/free`, preco ? { item_id: itemId, item_price: Math.round(preco * 100) / 100, verbose: true } : { item_id: itemId });
    const v = { valor: num(r?.coverage?.all_country?.list_cost) ?? 0, pesoG: num(r?.coverage?.all_country?.billable_weight) };
    _frete.set(k, { v, ts: Date.now() });
    return v;
  } catch (e) { return null; }
}

// Campanhas com co-participação do ML (rebate): o ML banca meli_percentage% do preço original.
// Considera tanto a campanha em que o anúncio já está (started) quanto as que ele pode entrar
// (candidate/pending) — ex.: PRICE_MATCHING / SMART, em que o ML sugere o preço e banca parte da tarifa.
const _promo = new Map();
const STATUS_PROMO = { started: 'ativa', pending: 'programada', candidate: 'disponível' };
async function campanhasML(ml, idx, itemId) {
  const c = _promo.get(itemId);
  let lista = c && Date.now() - c.ts < 3600e3 ? c.v : null;
  if (!lista) {
    try { lista = await ml(idx, '/seller-promotions/items/' + itemId, { app_version: 'v2' }); } catch (e) { lista = []; }
    if (!Array.isArray(lista)) lista = [];
    _promo.set(itemId, { v: lista, ts: Date.now() });
  }
  return lista.filter(p => STATUS_PROMO[p.status] && num(p.meli_percentage) > 0)
    .map(p => {
      const preco = num(p.price) || num(p.suggested_discounted_price) || num(p.max_discounted_price);
      const base = num(p.original_price) || 0;
      const pc = num(p.meli_percentage), v = base * pc / 100;   // % do ML é sobre o preço original (ML% + seller% = desconto total)
      return { preco, valor: Math.round(v * 100) / 100, meliPct: pc,
               nome: p.name || p.type, tipo: p.type, status: STATUS_PROMO[p.status], base };
    })
    .filter(p => p.preco > 0 && p.base > 0);
}

/**
 * Preenche em cada item perdendo: lucro_atual_pct, lucro_ptw_pct, lucro_ptw (R$), custo_produto, e margem_obs.
 * `ml` é a função do server.js que chama a API do ML com o token da conta.
 */
async function calcularMargens(ml, idx, uid, itens) {
  const imp = aliquota(idx), emb = embalagem(idx);
  const erp = await custosErp(idx);
  for (const it of itens) {
    // limpa o cálculo anterior (para o recálculo manual não deixar valores velhos)
    for (const k of ['margem_obs', 'custo_fonte', 'custo_produto', 'lucro_atual_pct', 'lucro_ptw_pct', 'lucro_ptw', 'tarifa_ptw', 'frete_ptw', 'calc_atual', 'calc_ptw', 'calc_campanha', 'lucro_campanha_pct', 'lucro_melhor_pct', 'calc_subir', 'lucro_subir_pct']) delete it[k];
    try {
      const cf = custoComFonte(idx, it._sku || it.seller_sku, erp);
      if (!cf) { it.margem_obs = 'sem custo no ' + (idx === 2 ? 'Tiny' : 'Bling') + ' nem na planilha'; continue; }
      const custo = cf.v; it.custo_fonte = cf.fonte;
      if (!it.listing_type_id || !it.category_id) { it.margem_obs = 'sem dados do anúncio'; continue; }
      const freteBase = await freteML(ml, idx, uid, it.id);
      const r2 = x => Math.round(x * 100) / 100;
      const campanhas = await campanhasML(ml, idx, it.id);
      const ativa = campanhas.find(p => p.status === 'ativa' && Math.abs(p.preco - it.current_price) < 0.05) || null;
      const calc = async (preco, camp) => {
        if (!(preco > 0)) return null;
        const t = await tarifaML(ml, idx, preco, it.listing_type_id, it.category_id, it.id);
        if (!t) return null;
        const frete = (await freteML(ml, idx, uid, it.id, preco))?.valor ?? freteBase?.valor ?? 0;   // custo de envio do vendedor nesse preço
        const imposto = preco * imp;
        // rebate só vale no preço da campanha
        const c = camp || campanhas.find(p => Math.abs(p.preco - preco) < 0.05) || null;
        const reb = c ? c.valor : 0;
        const lucro = preco - custo - t.valor - frete - emb - imposto + reb;
        return { preco: r2(preco), frete: r2(frete), rebate: r2(reb), campanha: c ? c.nome : null, campanhaStatus: c ? c.status : null, campanhaMeliPct: c ? c.meliPct : null,
                 perdeCampanha: !!(ativa && !c), campanhaNome: ativa?.nome || null, pesoG: freteBase?.pesoG || null, tarifa: r2(t.valor), tarifaPct: t.pct, tarifaFixa: t.fixa, tipoAnuncio: t.tipo,
                 custo: r2(custo), custoFonte: cf.fonte, embalagem: r2(emb), imposto: r2(imposto), impostoPct: Math.round(imp * 1000) / 10,
                 lucro: r2(lucro), pct: Math.round(lucro / preco * 1000) / 10 };
      };
      const atual = await calc(it.current_price);
      const ganhar = await calc(it.price_to_win);
      // Melhor campanha com rebate que também ganha o catálogo (preço ≤ preço para ganhar)
      let melhor = null;
      if (it.price_to_win > 0) for (const c of campanhas) {
        if (c.preco > it.price_to_win + 0.05 || Math.abs(c.preco - it.price_to_win) < 0.05) continue;
        const r = await calc(c.preco, c);
        if (r && (!melhor || r.lucro > melhor.lucro)) melhor = r;
      }
      if (melhor && (!ganhar || melhor.lucro > ganhar.lucro)) { it.calc_campanha = melhor; it.lucro_campanha_pct = melhor.pct; }
      it.lucro_melhor_pct = Math.max(ganhar?.pct ?? -Infinity, it.lucro_campanha_pct ?? -Infinity);
      if (!isFinite(it.lucro_melhor_pct)) delete it.lucro_melhor_pct;
      // ganhando o catálogo: margem se subir o preço até perto do 2º colocado
      if (it.preco_subir > 0) { const sb = await calc(it.preco_subir); if (sb) { it.calc_subir = sb; it.lucro_subir_pct = sb.pct; } }
      it.custo_produto = custo;
      if (atual) { it.lucro_atual_pct = atual.pct; it.calc_atual = atual; }
      if (ganhar) { it.lucro_ptw_pct = ganhar.pct; it.lucro_ptw = ganhar.lucro; it.tarifa_ptw = ganhar.tarifa; it.frete_ptw = ganhar.frete; it.calc_ptw = ganhar; }
      it.imposto_pct = Math.round(imp * 1000) / 10; it.embalagem = emb;
    } catch (e) { it.margem_obs = 'erro ao calcular'; }
  }
}

/** Lucro de um anúncio do ML a um preço (com rebate do ML, se houver). Custo só do ERP (Bling/Tiny). */
async function margemPreco(ml, idx, uid, it, preco, rebate = 0, erp) {
  if (!(preco > 0)) return { erro: 'sem preço' };
  const cf = custoComFonte(idx, it._sku || it.seller_sku, erp || await custosErp(idx));
  if (!cf || cf.fonte === 'planilha') return { erro: 'sem custo no ' + (idx === 2 ? 'Tiny' : 'Bling') };
  if (!it.listing_type_id || !it.category_id) return { erro: 'sem dados do anúncio' };
  const t = await tarifaML(ml, idx, preco, it.listing_type_id, it.category_id, it.id);
  if (!t) return { erro: 'tarifa do ML indisponível' };
  const fr = await freteML(ml, idx, uid, it.id, preco);
  const r2 = x => Math.round(x * 100) / 100, imp = aliquota(idx), emb = embalagem(idx);
  const frete = fr?.valor || 0, imposto = preco * imp;
  const lucro = preco - cf.v - t.valor - frete - emb - imposto + (rebate || 0);
  return { preco: r2(preco), custo: r2(cf.v), tarifa: r2(t.valor), frete: r2(frete), imposto: r2(imposto), embalagem: r2(emb), rebate: r2(rebate || 0), lucro: r2(lucro), pct: Math.round(lucro / preco * 1000) / 10 };
}

function recarregarErp(idx) { if (_erp[idx]) _erp[idx].ts = 0; }

module.exports = { salvarKits, kits, custoKit, custosNaData, historico, salvarHistorico, PLANILHAS, fixosCanal, recarregarErp, calcularMargens, margemPreco, custoSku, custosConta, custosErp, custoComFonte, aliquota };
