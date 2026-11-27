/**
 * Precificação no painel — Etapa 1: importa as planilhas de precificação (uma por empresa) e compara com o ERP.
 *
 *  Importar: lê a cópia da planilha que o painel já sincroniza do OneDrive (custos_ml.PLANILHAS) e grava uma
 *  fotografia em DATA/precificacao/emp_<idx>.json — aba Base/Custos e cada aba de canal (ML, Shopee, Amazon,
 *  SHEIN, TikTok), com código, qtd, produto, peso, custo, preço cheio, preço de promoção, lucro e % da planilha.
 *  A partir daqui a edição passa a ser no painel (próximas etapas); a planilha fica só como origem da importação.
 *
 *  Comparação: custo da planilha × custo do ERP (Bling para Zagodini e Com Amor de Mãe, Tiny para a Lufe).
 *  Kit = soma da composição cadastrada no ERP. "Margem com custo do ERP" = lucro da planilha refeito trocando
 *  só o custo — mostra quanto a margem muda se o custo do ERP for o certo.
 *
 *  GET  /precificacao                 página
 *  GET  /precificacao/dados?emp=0|1|2 JSON (fotografia + custos do ERP)
 *  POST /precificacao/importar?emp=   (administrador) refaz a fotografia a partir da planilha
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const DATA = require('./dados');

const DIR = path.join(DATA, 'precificacao');
const EMP = [{ idx: 0, nome: 'Zagodini' }, { idx: 1, nome: 'Com Amor de Mãe' }, { idx: 2, nome: 'Lufe' }];
const K = v => (v === null || v === undefined || v === '') ? '' : String(v).trim().toUpperCase();
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[R$\s]/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const arq = idx => path.join(DIR, `emp_${idx}.json`);

// ─── Regras de tarifa por canal (copiadas das fórmulas das planilhas) ─────────
// ML: comissão = preço × % da linha (fórmula "=G2*0,115"); taxa fixa/frete pela tabela ML_FRETE (peso da linha × faixa de preço);
//     + "Frete Grátis" informado na linha; na promoção soma o "Desc. comissão".
// Shopee: comissão 20% até 79,99 e 14% acima; taxa fixa 4,50 até 79,99 · 16 até 99,99 · 20 até 199,99 · 26 acima (na promoção, mesma regra pelo preço da promoção).
// Amazon: comissão da categoria do produto (lida da própria Amazon por SKU; mínimo R$ 1–2), 12% se ainda não lida; custo fixo 4,50 até 30 · 6,50 até 49,99 · 6,75 até 78,99 · 0 acima; + "Frete Grátis" da linha.
// SHEIN: comissão 18% + custo fixo (frete pelo peso) + "Frete Grátis" da linha; promoção = preço − % desconto.
// TikTok: comissão 16% abaixo de 50 e 12% acima; custo fixo 4 abaixo de 50 e 6 acima; promoção desconta o % de afiliado.
const ML_FRETE_PADRAO = { faixas: [0, 19, 49, 79, 100, 120, 150, 200], pesos: [0.3, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, Infinity], tab: [
  [5.65, 6.85, 8.15, 12.95, 14.95, 16.95, 19.05, 21.65], [5.95, 6.95, 8.25, 13.85, 16.15, 18.15, 20.45, 23.25], [6.05, 7.15, 8.45, 14.45, 16.85, 19.05, 21.35, 24.45],
  [6.15, 7.35, 8.65, 14.75, 17.15, 19.45, 21.75, 25.45], [6.25, 7.45, 8.75, 15.05, 17.65, 19.85, 22.25, 25.55], [6.35, 8.65, 9.15, 16.45, 19.15, 21.65, 24.35, 27.05],
  [6.45, 8.75, 9.75, 17.85, 20.75, 23.35, 26.35, 29.25], [6.55, 8.85, 10.25, 19.75, 22.85, 26.05, 29.25, 32.45], [6.65, 8.95, 10.35, 25.95, 29.15, 33.35, 36.45, 40.85],
  [6.75, 9.05, 10.45, 27.55, 31.65, 36.75, 40.85, 45.25], [6.85, 9.25, 10.55, 29.45, 34.35, 39.25, 44.15, 49.35], [6.95, 9.35, 10.65, 30.25, 35.25, 40.35, 45.35, 50.75],
  [7.05, 9.45, 10.85, 38.25, 45.05, 51.95, 58.75, 65.85], [7.05, 9.65, 11.05, 41.65, 48.55, 55.45, 62.35, 69.35], [7.15, 10.05, 11.45, 42.55, 49.75, 56.85, 63.85, 70.95],
  [7.25, 10.25, 11.65, 45.55, 52.95, 60.55, 68.15, 75.65], [7.35, 10.45, 11.85, 48.95, 56.55, 64.05, 71.35, 79.35], [7.45, 10.65, 12.05, 55.15, 64.35, 73.55, 82.75, 91.95],
  [7.65, 11.05, 12.25, 64.55, 75.75, 85.45, 96.25, 106.85], [7.75, 11.25, 12.45, 66.45, 76.05, 86.25, 97.15, 107.85], [7.85, 11.45, 12.65, 68.35, 79.65, 89.75, 100.05, 107.95],
  [7.95, 11.65, 12.85, 70.95, 81.85, 92.85, 103.45, 111.65], [8.05, 11.85, 13.05, 75.55, 87.25, 99.05, 110.25, 119.05], [8.15, 12.05, 13.25, 80.95, 93.75, 105.95, 118.05, 127.45],
  [8.25, 12.25, 13.45, 84.65, 97.95, 110.75, 123.35, 133.15], [8.35, 12.45, 13.65, 94.05, 108.35, 122.95, 136.95, 147.85], [8.45, 12.65, 13.85, 107.45, 124.85, 140.45, 156.45, 168.85],
  [8.55, 12.85, 14.05, 120.15, 138.95, 156.95, 174.85, 188.85], [8.65, 12.85, 14.25, 127.45, 147.05, 166.55, 185.55, 200.35], [8.75, 12.85, 14.45, 167.05, 193.35, 218.45, 243.45, 262.85]] };
/** Tabela ML_FRETE da planilha da empresa (cópia no servidor); se não achar, a padrão acima */
function lerMlFrete(wb) {
  try {
    const n = wb.SheetNames.find(x => /^ml_?frete$/i.test(x.trim())); if (!n) return null;
    const R = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
    const faixas = R[0].slice(1, 9).map(Number); if (faixas.some(isNaN)) return null;
    const tab = [], pesos = [];
    for (const r of R.slice(1)) { if (!r || r.slice(1, 9).some(v => typeof v !== 'number')) continue; tab.push(r.slice(1, 9)); pesos.push(typeof r[9] === 'number' ? r[9] : Infinity); }
    return tab.length ? { faixas, pesos, tab } : null;
  } catch (e) { return null; }
}
function mlFrete(T, peso, preco) {
  T = T || ML_FRETE_PADRAO; if (!(peso > 0) || !(preco > 0)) return null;
  let i = T.pesos.findIndex(p => peso <= p); if (i < 0) i = T.tab.length - 1;
  let j = 0; T.faixas.forEach((f, k) => { if (preco >= f) j = k; });
  return T.tab[Math.min(i, T.tab.length - 1)][j];
}
function sheinFrete(peso) {
  if (!(peso > 0)) return null;
  const t = [[0.3, 4], [0.6, 5], [0.9, 6], [1.2, 8], [1.5, 10], [2, 12], [5, 15], [9, 32], [13, 63], [17, 73], [23, 89], [30, 106]];
  return (t.find(x => peso <= x[0]) || [0, 106])[1];
}
/** Tarifas do canal no preço (sem custo, imposto e insumos). promo = bloco de promoção. null = falta dado para a regra */
function tarifas(tipo, preco, L, promo, T, padraoCom) {
  if (!(preco > 0)) return null; const p = L.p || {};
  if (tipo === 'ml') {
    const com = preco * ((promo ? p.comPromo : null) ?? p.com ?? padraoCom ?? 0.12);
    const peso = L.peso ?? p.peso; let fixa = mlFrete(T, peso, preco);
    if (fixa == null) { if (p.taxa == null) return null; fixa = p.taxa; }   // aba sem peso (ML Premium): taxa da linha
    return com + fixa + (p.frete || 0) - (promo ? (p.descCom || 0) : 0);
  }
  if (tipo === 'shopee') return (preco <= 79.99 ? preco * 0.2 : preco * 0.14) + (preco <= 79.99 ? 4.5 : preco <= 99.99 ? 16 : preco <= 199.99 ? 20 : 26);
  if (tipo === 'amazon') return Math.max(preco * (p.com ?? 0.12), p.comMin ?? 0) + (preco <= 30 ? 4.5 : preco < 50 ? 6.5 : preco < 79 ? 6.75 : 0) + (p.frete || 0);
  if (tipo === 'shein') { const fixo = p.fixo ?? sheinFrete(L.peso ?? p.peso); if (fixo == null) return null; return preco * 0.18 + fixo + (p.frete || 0); }
  if (tipo === 'tiktok') return (preco < 50 ? preco * 0.16 : preco * 0.12) + (preco < 50 ? 4 : 6) + (promo ? preco * (p.afiliado || 0) : 0);
  return null;
}
/** Parâmetros de cada linha lidos das células da planilha (fórmulas e valores) */
function paramsAba(ws, tipo) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const h = rows.slice(0, 8).findIndex(r => (r || []).some(c => /^(produto|descri[çc][aã]o)$/i.test(String(c ?? '').trim())));
  if (h < 0) return {};
  const cab = rows[h].map(c => String(c ?? '').trim());
  const idx = re => cab.map((c, i) => re.test(c) ? i : -1).filter(i => i >= 0);
  const margens = idx(/%\s*(de\s*)?(lucro|bruto)/i), fim = margens[0] ?? 1e9;
  const cel = (r, c) => c == null || c < 0 ? undefined : ws[XLSX.utils.encode_cell({ r, c })];
  const val = (r, c) => { const x = cel(r, c); return x && typeof x.v === 'number' ? x.v : null; };
  const coef = (r, c) => {   // "=G2*0,115" → 0,115; "=U3*$H$1" → valor de H1
    const x = cel(r, c); if (!x || !x.f) return null; const f = x.f.replace(/\s/g, '');
    let m = f.match(/\*([\d.]+)(%?)$/); if (m) return parseFloat(m[1]) / (m[2] ? 100 : 1);
    m = f.match(/\*\$?([A-Z]+)\$?(\d+)$/); if (m) { const y = ws[m[1] + m[2]]; return y && typeof y.v === 'number' ? y.v : null; }
    return null;
  };
  const cPeso = cab.findIndex(c => /^peso$/i.test(c));
  const out = {};
  for (let r = h + 1; r < rows.length; r++) {
    const P = {};
    if (cPeso >= 0 && val(r, cPeso) > 0) P.peso = val(r, cPeso);
    if (tipo === 'ml') {
      const com = idx(/comiss/i).filter(i => !/desc/i.test(cab[i])), taxa = idx(/taxa\s*fixa/i), fr = idx(/frete\s*gr/i), desc = idx(/desc/i).filter(i => i > fim);
      P.com = coef(r, com.find(i => i < fim)); P.comPromo = coef(r, com.find(i => i > fim));
      const t = taxa.find(i => i < fim); if (t != null && !(cel(r, t)?.f) && val(r, t) != null) P.taxa = val(r, t);
      else if (t != null && cPeso < 0 && val(r, t) != null) P.taxa = val(r, t);
      const f = fr.find(i => i < fim); if (f != null && !(cel(r, f)?.f) && val(r, f) > 0) P.frete = val(r, f);
      if (desc[0] != null && val(r, desc[0]) > 0) P.descCom = val(r, desc[0]);
    } else if (tipo === 'amazon') { const f = idx(/frete\s*gr/i)[0]; if (val(r, f) > 0) P.frete = val(r, f); }
    else if (tipo === 'shein') { const fx = idx(/custo\s*fixo/i)[0], f = idx(/frete\s*gr/i)[0], d = idx(/desconto/i)[0];
      if (val(r, fx) != null) P.fixo = val(r, fx); if (val(r, f) > 0) P.frete = val(r, f); if (val(r, d) > 0) P.desconto = val(r, d); }
    else if (tipo === 'tiktok') { const a = idx(/afiliado/i)[0]; if (val(r, a) > 0 && val(r, a) < 1) P.afiliado = val(r, a); }
    for (const k of Object.keys(P)) if (P[k] == null) delete P[k];
    out[r + 1] = P;   // nº da linha da planilha (1-based), igual a L.linha
  }
  return out;
}
/** Uma vez por empresa: lê da planilha os parâmetros das regras de cada linha e a tabela ML_FRETE */
function completarRegras(idx, F) {
  if (F.regrasV === 1) return false;
  const nomeArq = require('./custos_ml').PLANILHAS[idx];
  try {
    const wb = XLSX.readFile(path.join(DATA, nomeArq), { cellFormula: true });
    F.mlFrete = lerMlFrete(wb) || null;
    for (const A of F.abas) {
      if (A.tipo === 'base' || !wb.Sheets[A.abaPlanilha]) continue;
      const P = paramsAba(wb.Sheets[A.abaPlanilha], A.tipo);
      for (const L of A.linhas) if (typeof L.linha === 'number' && P[L.linha]) L.p = { ...P[L.linha], ...(L.p || {}) };
    }
  } catch (e) { console.warn('[precificacao] regras', idx, e.message); }
  // peso das abas de canal sem coluna de peso: usa o peso do mesmo código em outra aba (ML / Custos)
  const pesos = {}; for (const A of F.abas) for (const L of A.linhas) { const w = L.peso ?? L.p?.peso; if (w > 0 && !pesos[L.sku]) pesos[L.sku] = w; }
  for (const A of F.abas) for (const L of A.linhas) if (L.peso == null && !(L.p?.peso) && pesos[L.sku]) L.pesoRef = pesos[L.sku];
  F.regrasV = 1; return true;
}

/** Tipo da aba: base | ml | shopee | amazon | shein | tiktok | null (ignorada) */
function tipoAba(nome) {
  const n = nome.trim().toLowerCase();
  if (/cam[aã]e|frete|full|fba|viabilidade|simplificada|planilha\d|custo (lyor|meio)|custos atelie|magalu|12%/.test(n)) return null;
  if (/^(base|custos)$/.test(n)) return 'base';
  if (/^(ml|mercado)/.test(n)) return 'ml';
  if (/^shopee/.test(n)) return 'shopee';
  if (/^amazon/.test(n)) return 'amazon';
  if (/^shein/.test(n)) return 'shein';
  if (/tiktok/.test(n)) return 'tiktok';
  return null;
}

function lerAba(ws, tipo) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const h = rows.slice(0, 8).findIndex(r => (r || []).some(c => /^(produto|descri[çc][aã]o)$/i.test(String(c ?? '').trim())));
  if (h < 0) return null;
  const cab = rows[h].map(c => String(c ?? '').trim());
  const acha = (re, desde = 0) => cab.findIndex((c, i) => i >= desde && re.test(c));
  let cCod = acha(/^(c[oó]d(igo)?|sku)$/i); if (cCod < 0) cCod = 0;
  const cNome = acha(/^(produto|descri[çc][aã]o)$/i), cQtd = acha(/^(qtd|qnde|quantidade)$/i), cPeso = acha(/^peso$/i);
  const cUn = acha(/^(custo\s*(un|und|unit[aá]rio)\.?|unit[aá]rio)$/i), cTot = acha(/^custo\s*total$/i);
  const precos = cab.map((c, i) => (/pre[çc]o|^venda/i.test(c) && !/lucro|%|comiss|desc|custo|oficial|campanha|final/i.test(c)) ? i : -1).filter(i => i >= 0);
  const lucros = cab.map((c, i) => /^(lucro|bruto)/i.test(c) && !/%|\bms\b/i.test(c) ? i : -1).filter(i => i >= 0);
  const margens = cab.map((c, i) => /%\s*(de\s*)?(lucro|bruto)/i.test(c) ? i : -1).filter(i => i >= 0);
  // bloco do preço cheio termina na 1ª coluna de % de lucro; o da promoção vem depois dela (só se houver 2º preço)
  const fimCheio = margens[0] ?? lucros[0] ?? 1e9, temPromo = precos[1] != null;
  const cheio = lista => lista.find(i => i <= fimCheio), promoC = lista => temPromo ? lista.find(i => i > fimCheio) : undefined;
  const imps = cab.map((c, i) => /^imposto$/i.test(c) ? i : -1).filter(i => i >= 0);
  const inss = cab.map((c, i) => /^insumos/i.test(c) ? i : -1).filter(i => i >= 0);
  const linhas = [];
  rows.slice(h + 1).forEach((r, j) => {
    if (!r) return;
    const sku = K(r[cCod]); if (!sku || /^(COD|CODIGO|SKU)$/.test(sku)) return;
    const nome = cNome >= 0 ? String(r[cNome] ?? '').trim() : '';
    const q0 = num(r[cQtd]), qtd = q0 > 0 && q0 <= 200 ? q0 : 1, un = num(r[cUn]), tot = num(r[cTot]);
    const custo = tot > 0 ? tot : (un > 0 ? un * qtd : null);
    const L = { linha: h + j + 2, sku, nome, qtd, peso: num(r[cPeso]), custo: r2(custo), custoUn: r2(un > 0 ? un : (custo ? custo / qtd : null)) };
    if (tipo !== 'base') {
      const pos = v => (v = num(v)) > 0 ? r2(v) : null;
      L.preco = pos(r[precos[0]]); L.promo = pos(r[precos[1]]);
      L.lucro = r2(num(r[cheio(lucros)])); L.margem = num(r[cheio(margens)]);
      const depoisPromo = lista => temPromo ? lista.find(i => i > precos[1]) : undefined;   // lucro/% da promoção vêm depois do 2º preço
      L.lucroPromo = r2(num(r[depoisPromo(lucros)])); L.margemPromo = num(r[depoisPromo(margens)]);
      // imposto e insumos da planilha (para separar das tarifas do canal); promo usa a 2ª coluna quando existe
      L.imp = num(r[cheio(imps)]); L.ins = num(r[cheio(inss)]);
      L.impPromo = num(r[promoC(imps)]); L.insPromo = promoC(inss) != null ? num(r[promoC(inss)]) : L.ins;
      if (!(L.preco > 0) && !(L.custo > 0)) return;
    } else if (!(L.custo > 0) && !nome) return;
    linhas.push(L);
  });
  return { colunas: { codigo: cab[cCod], custo: cab[cTot >= 0 ? cTot : cUn] || null, precos: precos.map(i => cab[i]) }, linhas };
}

function importar(idx) {
  const nomeArq = require('./custos_ml').PLANILHAS[idx]; if (!nomeArq) throw new Error('empresa inválida');
  const f = path.join(DATA, nomeArq);
  let st; try { st = fs.statSync(f); } catch (e) { throw new Error('planilha não encontrada no servidor: ' + nomeArq); }
  const wb = XLSX.readFile(f);
  const out = { versao: 6, empresa: EMP[idx].nome, arquivo: nomeArq, planilhaEm: new Date(st.mtimeMs).toISOString(), importadoEm: new Date().toISOString(), abas: [] };
  for (const aba of wb.SheetNames) {
    const tipo = tipoAba(aba); if (!tipo) continue;
    const r = lerAba(wb.Sheets[aba], tipo); if (!r || !r.linhas.length) continue;
    out.abas.push({ aba: tipo === 'base' ? 'Custos' : aba, abaPlanilha: aba, tipo, ...r });   // aba de custos sempre com o nome "Custos"
  }
  // itens excluídos no painel continuam fora numa nova importação
  const exc = excluidos(idx);
  for (const A of out.abas) A.linhas = A.linhas.filter(L => !exc[A.aba + '|' + L.sku] && !exc[A.aba + '|' + L.sku.replace(/^0+(?=.)/, '')]);
  // base primeiro, depois a ordem da planilha
  out.abas.sort((a, b) => (a.tipo === 'base' ? 0 : 1) - (b.tipo === 'base' ? 0 : 1));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(arq(idx), JSON.stringify(out));
  console.log(`[precificacao] importada ${nomeArq}: ${out.abas.map(a => a.aba + ' ' + a.linhas.length).join(', ')}`);
  return out;
}
const arqExc = idx => path.join(DIR, `excluidos_${idx}.json`);
function excluidos(idx) { try { return JSON.parse(fs.readFileSync(arqExc(idx))); } catch (e) { return {}; } }
/** Exclui um item de uma aba da precificação do painel (não mexe na planilha nem no ERP) */
function excluir(idx, aba, sku, quem) {
  const F = fotografia(idx); if (!F) throw new Error('precificação ainda não importada');
  const A = F.abas.find(a => a.aba === aba); if (!A) throw new Error('aba não encontrada');
  const z = v => String(v).replace(/^0+(?=.)/, ''), alvo = z(K(sku));
  const antes = A.linhas.length; A.linhas = A.linhas.filter(L => z(L.sku) !== alvo);
  if (A.linhas.length === antes) throw new Error('item não encontrado na aba');
  fs.writeFileSync(arq(idx), JSON.stringify(F));
  const E = excluidos(idx); E[aba + '|' + K(sku)] = E[aba + '|' + alvo] = { quando: new Date().toISOString(), quem }; fs.writeFileSync(arqExc(idx), JSON.stringify(E));
  delete _cache[idx];
  console.log(`[precificacao] excluído ${EMP[idx].nome} / ${aba} / ${sku} (${quem})`);
  return antes - A.linhas.length;
}
/** Altera o "Custo" da precificação do painel (não mexe no ERP). lista = [{sku, custo}] — vale para o código em todas as abas */
function custoPainel(idx, lista, quem) {
  const F = fotografia(idx); if (!F) throw new Error('precificação ainda não importada');
  const z = v => K(v).replace(/^0+(?=.)/, ''); const mapa = {}, antes = {};
  for (const x of lista) { const c = num(x.custo); if (!(c > 0)) throw new Error('custo inválido para ' + x.sku); mapa[z(x.sku)] = r2(c); }
  let n = 0;
  for (const A of F.abas) for (const L of A.linhas) {
    const chave = mapa[z(L.sku)] != null ? z(L.sku) : (L.skuPlanilha && mapa[z(L.skuPlanilha)] != null ? z(L.skuPlanilha) : null); if (chave == null) continue;
    const c = mapa[chave]; if (!(chave in antes)) antes[chave] = L.custo;
    L.custo = c; L.custoUn = r2(c / (L.qtd || 1)); L.custoEm = new Date().toISOString(); L.custoPor = quem; n++;
  }
  fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  let E = []; try { E = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  for (const x of lista) E.push({ quando: new Date().toISOString(), quem, emp: idx, sku: K(x.sku), de: antes[z(x.sku)] ?? null, para: num(x.custo), onde: x.onde || 'painel' });
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ_ED, JSON.stringify(E.slice(-5000)));
  return n;
}
function fotografia(idx) { try { return JSON.parse(fs.readFileSync(arq(idx))); } catch (e) { return null; } }

/** Custo do ERP para a linha: kit pela composição; item simples pelo código (× qtd quando o código é de kit sem composição). */
function custoErp(idx, L, erp, cm) {
  const kit = cm.custoKit(idx, L.sku, erp); if (kit != null) return { v: kit, fonte: 'kit' };
  const d = v => { const s = K(v); if (erp[s] > 0) return erp[s]; const z = s.replace(/^0+/, ''); return erp[z] > 0 ? erp[z] : null; };
  if (L.qtd > 1) {
    const base = L.sku.replace(/-[^-]+$/, '');
    if (base !== L.sku && d(base) != null) return { v: d(base) * L.qtd, fonte: base + ' × ' + L.qtd };
  }
  const v = d(L.sku); if (v != null) return { v: L.qtd > 1 && L.custoUn && Math.abs(v - L.custoUn) < Math.abs(v - L.custo) ? v * L.qtd : v, fonte: 'item' };
  // produto pai sem custo (ex.: Tiny "15" / "000000001"): usa o custo das variações (15-Bege, 15-Preto...), sem contar kits;
  // se as variações tiverem custos diferentes, usa o maior (margem mais conservadora)
  const base = L.sku.replace(/^0+(?=.)/, ''), kits = cm.kits(idx);
  const vars = Object.keys(erp).filter(k => k.includes('-') && !kits[k] && k.split('-')[0].replace(/^0+(?=.)/, '') === base && erp[k] > 0);
  // sufixo só numérico pode ser pacote (1801-10 = 10 un.), não variação: só aceita se não for "-N" sozinho com N ≥ 2
  // e se os custos forem parecidos (até 1,5×)
  const numericos = vars.every(k => /^\d+$/.test(k.split('-').slice(1).join('-')));
  const pacote = numericos && (vars.length === 1 ? parseInt(vars[0].split('-')[1]) >= 2 : Math.max(...vars.map(k => erp[k])) > 1.5 * Math.min(...vars.map(k => erp[k])));
  if (vars.length && !pacote) {
    const vs = vars.map(k => erp[k]), mn = Math.min(...vs), mx = Math.max(...vs);
    return { v: mx * (L.qtd || 1), codigo: vars[0].split('-')[0], fonte: vars.length + ' variações' + (mn !== mx ? ' (R$ ' + mn.toFixed(2).replace('.', ',') + ' a ' + mx.toFixed(2).replace('.', ',') + ')' : ''), variacoes: true };
  }
  return null;
}

// uma leitura por empresa de cada vez (o custo do ERP da Lufe pagina o Tiny inteiro) e cache curto
const _emCurso = {}, _cache = {};
function dados(idx) {
  if (_cache[idx] && Date.now() - _cache[idx].ts < 5 * 60e3) return Promise.resolve(_cache[idx].v);
  if (!_emCurso[idx]) _emCurso[idx] = montar(idx).then(v => { _cache[idx] = { ts: Date.now(), v }; return v; }).finally(() => { delete _emCurso[idx]; });
  return _emCurso[idx];
}
async function montar(idx) {
  let F = fotografia(idx);
  if (!F) F = importar(idx);   // a planilha só foi a origem: depois da 1ª importação a precificação é editada no painel   // versão 3: imposto/insumos e colunas de lucro por bloco (cheio × promoção)
  const cm = require('./custos_ml');
  const erp = await cm.custosErp(idx);
  const erpNome = idx === 2 ? 'Tiny' : 'Bling';
  const ce = require('./config_empresas').porMlIdx(idx) || {};
  const cfg = { imposto: ce.imposto ?? 0, insumos: ce.embalagem ?? 0, meta: idx === 2 ? 0.20 : 0.15 };
  const kits = cm.kits(idx);
  // Excel tira o 0 da frente dos códigos numéricos (09923 → 9923): acha o código certo no ERP (e nos kits)
  // e corrige na precificação do painel — o código passa a ser o do ERP
  const semZero = {}; const reg = c => { const z = String(c).replace(/^0+(?=.)/, ''); (semZero[z] ||= new Set()).add(c); };
  Object.keys(erp).forEach(reg); Object.keys(kits).forEach(reg);
  let corrigidos = 0;
  for (const A of F.abas) for (const L of A.linhas) {
    if (!/^\d+$/.test(L.sku) || erp[L.sku] > 0 || kits[L.sku]) continue;
    const c = semZero[L.sku.replace(/^0+(?=.)/, '')]; if (!c || c.size !== 1) continue;
    const certo = [...c][0]; if (certo === L.sku) continue;
    L.skuPlanilha = L.skuPlanilha || L.sku; L.sku = certo; corrigidos++;
  }
  if (corrigidos) { try { fs.writeFileSync(arq(idx), JSON.stringify(F)); } catch (e) {} console.log(`[precificacao] ${EMP[idx].nome}: ${corrigidos} códigos com 0 na frente corrigidos`); }
  if (completarRegras(idx, F)) { try { fs.writeFileSync(arq(idx), JSON.stringify(F)); } catch (e) {} console.log(`[precificacao] ${EMP[idx].nome}: regras de tarifa lidas da planilha`); }
  // comissão padrão do ML por aba (itens incluídos no painel): a mais comum da aba
  const comPadrao = {};
  for (const A of F.abas) if (A.tipo === 'ml') { const c = {}; A.linhas.forEach(L => { const v = L.p?.com; if (v) c[v] = (c[v] || 0) + 1; }); const m = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; comPadrao[A.aba] = m ? +m[0] : (/premium/i.test(A.aba) ? 0.17 : 0.12); }
  for (const A of F.abas) {
    const R = A.resumo = { linhas: A.linhas.length, iguais: 0, diferentes: 0, semErp: 0 };
    for (const L of A.linhas) {
      if (!L.custoEm) { L.custoEm = F.importadoEm; L.custoPor = 'planilha'; }
      const e = custoErp(idx, L, erp, cm);
      if (!e) { L.situacao = 'sem custo no ' + erpNome; R.semErp++; L.kit = !!(cm.kits(idx)[L.sku]?.length) || /-/.test(L.sku) && L.qtd > 1; }
      else { L.custoErp = r2(e.v); L.fonteErp = e.fonte; L.kit = e.fonte !== 'item' && !e.variacoes; L.variacoes = !!e.variacoes; if (e.codigo && e.codigo !== L.sku) { L.skuPlanilha = L.skuPlanilha || L.sku; L.sku = e.codigo; } L.dif = L.custo != null ? r2(e.v - L.custo) : null; }
      if (!e) {}
      else if (L.custo == null) { L.situacao = 'sem custo na planilha'; R.diferentes++; }
      else if (Math.abs(L.dif) < 0.015) { L.situacao = 'igual'; R.iguais++; }
      else { L.situacao = 'diferente'; R.diferentes++; }
      // Margem do painel pela regra de cada canal (tarifas copiadas das fórmulas da planilha), com o custo do ERP
      // (ou o Custo do painel), imposto e insumos da empresa. "Preço p/ meta" = menor preço ,99 que dá a meta.
      if (A.tipo !== 'base') {
        const custo = L.custoErp ?? L.custo, Lw = { ...L, peso: L.peso ?? L.pesoRef };
        const conta = (preco, promo) => {
          if (!(preco > 0) || custo == null) return null;
          const t = tarifas(A.tipo, preco, Lw, promo, F.mlFrete, comPadrao[A.aba]); if (t == null) return null;
          return preco - custo - t - cfg.imposto * preco - cfg.insumos;
        };
        const meta = promo => { if (custo == null) return null; for (let p = Math.max(1, Math.floor(custo)) + 0.99; p < custo * 20 + 100; p += 1) { const l = conta(p, promo); if (l == null) return null; if (l / p >= cfg.meta) return r2(p); } return null; };
        const a = conta(L.preco, false), b = conta(L.promo, true);
        L.lucroPainel = a == null ? null : r2(a); L.margemPainel = a == null ? null : a / L.preco; L.precoMeta = L.preco > 0 ? meta(false) : null;
        L.lucroPromoPainel = b == null ? null : r2(b); L.margemPromoPainel = b == null ? null : b / L.promo; L.precoMetaPromo = L.promo > 0 ? meta(true) : null;
        L.semRegra = (L.preco > 0 && a == null && custo != null) ? (A.tipo === 'ml' || A.tipo === 'shein' ? 'falta o peso' : 'sem regra') : null;
      }
      // margem refeita só trocando o custo (o resto das taxas fica como na planilha)
      if (A.tipo !== 'base' && L.dif != null) {
        if (L.preco > 0 && L.lucro != null) L.margemErp = (L.lucro - L.dif) / L.preco;
        if (L.promo > 0 && L.lucroPromo != null) L.margemPromoErp = (L.lucroPromo - L.dif) / L.promo;
      }
    }
  }
  return { ...F, erp: erpNome, erpItens: Object.keys(erp).length, cfg, comPadrao };
}

function pagina(admin) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Precificação</title><style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.top a{color:#ffd60a;font-size:13px}
.box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:14px 18px;margin:14px auto;max-width:1300px;overflow-x:auto}select,input,button{padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{background:#0d1b2a;color:#fff;border:none;cursor:pointer;font-weight:600}button:disabled{opacity:.5}
.abas{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.aba{background:#f4f5f7;color:#333;border:1px solid #e3e3e3;font-weight:500;padding:7px 12px}.aba.on{background:#0d1b2a;color:#fff}
.aba small{opacity:.75}table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px 7px;border-bottom:1px solid #f1f1f1;text-align:right;white-space:nowrap}th{position:sticky;top:0;background:#fafafa;font-weight:600}
.l{text-align:left;white-space:normal}small{color:#888}.ok{color:#2e7d32}.dif{color:#c62828;font-weight:600}.sem{color:#E65100}.neg{color:#c62828}.cards{display:flex;gap:10px;flex-wrap:wrap}
.mg{display:inline-block;min-width:54px;text-align:center;padding:2px 6px;border-radius:6px;font-weight:600}.m0{background:#ffcdd2;color:#b71c1c}.m1{background:#fff59d;color:#7a5d00}.m2{background:#c8e6c9;color:#1b5e20}.m3{background:#2e7d32;color:#fff}
.ed{cursor:pointer;color:#1565c0;margin-left:4px;font-size:12px}.card{flex:1;min-width:150px;border:1px solid #eee;border-radius:10px;padding:10px 12px;font-size:13px}.card b{font-size:20px}
#mod{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9;align-items:flex-start;justify-content:center;padding-top:6vh}#mod>div{background:#fff;border-radius:12px;padding:18px 20px;max-width:640px;width:92%;max-height:84vh;overflow:auto;font-size:13.5px}
#mod table td{text-align:left}#mod input{padding:6px 8px}.inf{cursor:pointer;color:#1565c0;font-size:13px;margin-left:3px}</style></head><body>
<div class="top"><b>💲 Precificação</b><span style="font-size:12px;opacity:.75">custos e margens por canal</span><span style="flex:1"></span>
<select id="emp" onchange="carregar()"><option value="0">Zagodini</option><option value="1">Com Amor de Mãe</option><option value="2">Lufe</option></select>
<select id="sit" onchange="render()"><option value="">Tudo</option><option value="dif">Custo diferente do ERP</option><option value="sem">Sem custo no ERP</option><option value="meta">Abaixo da meta</option><option value="site">Não encontrado no site</option></select>
<input id="q" placeholder="Buscar código ou produto" oninput="render()">
<button onclick="novo()" style="background:#2e7d32">＋ Incluir item ou kit</button><button id="btconf" onclick="conferir()" style="background:#6a1b9a">↻ Conferir anúncios nos sites</button><button id="aterp" onclick="atualizarErp()">↻ Atualizar custos do ERP</button><button onclick="igualarTodos()" style="background:#1565c0">⇐ Usar custo do ERP nos diferentes</button><a href="/painel.html">← Painel</a></div>
<div id="mod" onclick="if(event.target.id==='mod')fechar()"><div id="modc"></div></div><div class="box" id="info">Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)</div><div class="box"><div class="abas" id="abas"></div><div id="lista"></div></div>
<script>
let D=null,A=0;const $=id=>document.getElementById(id);const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const brl=v=>v==null?'—':'R$ '+Number(v).toFixed(2).replace('.',',');const pc=v=>v==null||!isFinite(v)?'—':'<span class="mg '+(v<0.05?'m0':v<0.10?'m1':v<0.15?'m2':'m3')+'">'+(v*100).toFixed(1).replace('.',',')+'%</span>';
const pw=l=>l.peso??l.pesoRef??(l.p&&l.p.peso)??null;
const dd=s=>s?new Date(s).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}):'—';
const dt=s=>s?new Date(s).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
async function carregar(){$('info').textContent='Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)';$('abas').innerHTML='';$('lista').innerHTML='';
 const r=await fetch('/precificacao/dados?emp='+$('emp').value);D=await r.json();if(D.erro){$('info').innerHTML='<span class="dif">'+esc(D.erro)+'</span>';return;}A=0;info();render();}
const abaixo=l=>(l.margemPainel!=null&&l.margemPainel<D.cfg.meta)||(l.margemPromoPainel!=null&&l.margemPromoPainel<D.cfg.meta);
function info(){const t={l:0,c:0,s:0,m:0};D.abas.forEach(a=>{t.l+=a.resumo.linhas;t.s+=a.resumo.semErp;t.c+=a.resumo.linhas-a.resumo.semErp;if(a.tipo!=='base')t.m+=a.linhas.filter(abaixo).length;});
 $('info').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:10px"><b>Custo</b> = custo da precificação; <b>Custo ERP</b> = custo do '+D.erp+' (kit = soma da composição; ✎ altera direto no '+D.erp+'). <b>Margem</b> = preço − custo − tarifas do canal (regra da planilha: ML comissão + tabela de frete pelo peso; Shopee e TikTok por faixa de preço (na promoção, pelo preço da promoção); Amazon 12% + custo fixo; SHEIN 18% + frete pelo peso) − imposto ('+(D.cfg.imposto*100).toFixed(1).replace('.',',')+'%) − insumos (R$ '+D.cfg.insumos.toFixed(2).replace('.',',')+'). <b>Preço p/ meta</b> = menor preço terminado em ,99 com '+Math.round(D.cfg.meta*100)+'% de margem. Cores: <span class="mg m0">&lt;5%</span> <span class="mg m1">5–9,99%</span> <span class="mg m2">10–14,99%</span> <span class="mg m3">15%+</span>. <small>Itens importados da planilha em '+dt(D.importadoEm)+'.</small></div>'+
 '<div class="cards"><div class="card">Itens<br><b>'+t.l+'</b></div><div class="card">Com custo<br><b class="ok">'+t.c+'</b></div><div class="card">Sem custo<br><b class="sem">'+t.s+'</b></div><div class="card">Abaixo da meta ('+Math.round(D.cfg.meta*100)+'%)<br><b class="dif">'+t.m+'</b></div></div>';
 $('abas').innerHTML=D.abas.map((a,i)=>'<button class="aba'+(i===A?' on':'')+'" onclick="A='+i+';render()">'+esc(a.aba)+(a.resumo.semErp?' <small>'+a.resumo.semErp+' sem custo</small>':'')+'</button>').join('');}
function render(){if(!D||D.erro)return;info();const a=D.abas[A],s=$('sit').value,q=$('q').value.toLowerCase();
 let L=a.linhas.filter(l=>(!s||(s==='sem'?/sem custo no/.test(l.situacao||''):s==='dif'?l.situacao==='diferente':s==='site'?l.noSite===false:abaixo(l)))&&(!q||(l.sku+' '+l.nome).toLowerCase().includes(q)));
 const base=a.tipo==='base';LV=L.slice(0,2000);
 $('lista').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:8px">'+L.length+' de '+a.linhas.length+' linhas'+(base?'':' · '+(a.conferido?'anúncios conferidos no site em '+dt(a.conferido)+' ('+a.linhas.filter(l=>l.noSite===false).length+' não encontrados, em vermelho)':'anúncios ainda não conferidos no site'))+' · altere Preço/Promoção para simular a margem; 💾 grava</div><table><tr><th></th><th class="l">Código</th><th class="l">Produto</th><th>Qtd</th>'+(base?'':'<th>Peso</th>')+'<th>Custo</th><th>Custo ERP</th><th>Diferença</th>'+
 (base?'':'<th>Preço</th><th>Margem</th><th>Preço p/ meta</th><th>Promoção</th><th>Margem</th><th>Preço p/ meta</th>')+'</tr>'+
 LV.map((l,j)=>'<tr'+(l.noSite===false?' style="background:#ffebee" title="Não encontrado no site ('+esc(a.aba)+')"':'')+'><td><span class="ed" style="color:#c62828" title="Excluir este item da aba" onclick="excluir(\\''+esc(l.sku)+'\\')">🗑</span></td><td class="l">'+esc(l.sku)+'<br><small>linha '+l.linha+(l.skuPlanilha?' · na planilha: '+esc(l.skuPlanilha):'')+'</small></td><td class="l">'+esc(l.nome)+(l.novo?' <small style="color:#2e7d32">· incluído no painel</small>':'')+'</td><td>'+l.qtd+'</td>'+(base?'':'<td>'+(pw(l)!=null?String(pw(l)).replace('.',',')+' kg':'—')+'<span class="ed" title="Alterar o peso (vale para todas as abas)" onclick="editPeso(\\''+esc(l.sku)+'\\','+(pw(l)??0)+')">✎</span></td>')+'<td>'+brl(l.custo)+'<span class="ed" title="Alterar o Custo do painel" onclick="editarPainel(\\''+esc(l.sku)+'\\','+(l.custo??0)+')">✎</span><br><small title="Lançado por '+esc(l.custoPor||'')+'">'+dd(l.custoEm)+'</small><span class="inf" title="Quem lançou e histórico do custo" onclick="hist(\\''+esc(l.sku)+'\\')">ⓘ</span>'+(l.situacao==='diferente'?'<br><span class="ed" style="margin:0" title="Usar o custo do ERP" onclick="igualar(\\''+esc(l.sku)+'\\','+l.custoErp+')">⇐ usar ERP</span>':'')+'</td>'+
 '<td>'+(l.custoErp!=null?brl(l.custoErp)+(l.fonteErp&&l.fonteErp!=='item'?'<br><small>'+esc(l.fonteErp)+'</small>':''):'<span class="sem">sem custo no '+D.erp+'</span>')+(!l.kit&&!l.variacoes?'<span class="ed" title="Alterar o custo no '+D.erp+'" onclick="editar(\\''+esc(l.sku)+'\\','+(l.custoErp??l.custo??0)+','+l.qtd+')">✎</span>':'')+'</td>'+
 '<td class="'+(l.situacao==='diferente'?'dif':'')+'">'+(l.dif==null?'—':(l.dif>0?'+':'')+brl(l.dif))+'</td>'+
 (base?'':'<td>'+inp(j,'preco',l.preco)+(l.semRegra?'<br><small class="sem">'+esc(l.semRegra)+'</small>':'')+((a.tipo==='ml'||a.tipo==='amazon')&&l.p&&l.p.com?'<br><small title="'+esc(l.p.comFonte||'comissão do item')+'">comissão '+(l.p.com*100).toFixed(1).replace('.',',')+'%</small>':'')+'</td><td id="m_'+j+'_preco">'+pc(l.margemPainel)+'</td><td>'+brl(l.precoMeta)+'</td><td>'+inp(j,'promo',l.promo)+'</td><td id="m_'+j+'_promo">'+pc(l.margemPromoPainel)+'</td><td>'+brl(l.precoMetaPromo)+'</td>')+'</tr>').join('')+'</table>';}
async function atualizarErp(){const b=$('aterp'),e=$('emp').value;b.disabled=true;b.textContent='Atualizando custos…';
 await fetch('/precificacao/atualizar-erp?emp='+e,{method:'POST'});
 let st;for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,3000));st=await fetch('/precificacao/atualizar-erp?emp='+e).then(r=>r.json());if(!st.rodando)break;}
 b.disabled=false;b.textContent='↻ Atualizar custos do ERP';if(st&&st.erro)alert('Erro: '+st.erro);
 const aba=A;D=await (await fetch('/precificacao/dados?emp='+e)).json();A=aba;render();}
async function salvarPainel(lista){const r=await fetch('/precificacao/custo-painel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emp:$('emp').value,lista})}).then(r=>r.json());
 if(r.erro)return alert(r.erro);const aba=A;D=await (await fetch('/precificacao/dados?emp='+$('emp').value)).json();A=aba;render();}
async function editarPainel(sku,atual){const v=prompt('Custo de '+sku+' na precificação (R$):',String(atual).replace('.',','));if(v==null)return;const n=parseFloat(String(v).replace(',','.'));if(!(n>0))return alert('Valor inválido');salvarPainel([{sku,custo:n}]);}
function igualar(sku,v){salvarPainel([{sku,custo:v}]);}
async function igualarTodos(){const m={};D.abas.forEach(a=>a.linhas.forEach(l=>{if(l.situacao==='diferente'&&l.custoErp>0)m[l.sku]=l.custoErp;}));const lista=Object.entries(m).map(([sku,custo])=>({sku,custo}));
 if(!lista.length)return alert('Nenhum custo diferente do ERP.');if(!confirm('Trocar o Custo de '+lista.length+' códigos pelo custo do '+D.erp+' (todas as abas desta empresa)?'))return;salvarPainel(lista);}
async function excluir(sku){const a=D.abas[A];if(!confirm('Excluir '+sku+' da aba '+a.aba+' no painel?\\n\\nNão mexe na planilha nem no ERP, e continua fora se a planilha for importada de novo.'))return;
 const r=await fetch('/precificacao/excluir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emp:$('emp').value,aba:a.aba,sku})}).then(r=>r.json());
 if(r.erro)return alert(r.erro);const aba=A;const x=await fetch('/precificacao/dados?emp='+$('emp').value);D=await x.json();A=aba;render();}
async function editar(sku,atual,qtd){
 if(qtd>1&&!confirm('Esta linha é de '+qtd+' unidades. O custo alterado é o do código '+sku+' no '+D.erp+'. Continuar?'))return;
 const v=prompt('Novo custo de '+sku+' no '+D.erp+' (R$):',String(atual).replace('.',','));if(v==null)return;
 const n=parseFloat(String(v).replace(',','.'));if(!(n>0))return alert('Valor inválido');
 const r=await fetch('/precificacao/custo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emp:$('emp').value,sku,custo:n})}).then(r=>r.json());
 if(r.erro)return alert('Não gravou: '+r.erro);
 const aba=A;const x=await fetch('/precificacao/dados?emp='+$('emp').value);D=await x.json();A=aba;render();}
const ML_FRETE_PADRAO=${JSON.stringify(ML_FRETE_PADRAO).replace(/null/g,'Infinity')};
${mlFrete.toString()}
${sheinFrete.toString()}
${tarifas.toString()}
let LV=[];
const nf=v=>v==null?'':Number(v).toFixed(2).replace('.',',');
function inp(j,c,v){return '<input class="pr" id="i_'+j+'_'+c+'" value="'+nf(v)+'" oninput="sim('+j+',\\''+c+'\\')" style="width:78px;text-align:right;padding:4px 6px;font-size:12.5px"><span class="ed" id="s_'+j+'_'+c+'" style="display:none" title="Gravar este preço" onclick="gravarSim('+j+',\\''+c+'\\')">💾</span>';}
function margemCalc(l,tipo,preco,promo){const custo=l.custoErp??l.custo;if(!(preco>0)||custo==null)return null;const t=tarifas(tipo,preco,{...l,peso:pw(l)},promo,D.mlFrete,(D.comPadrao||{})[D.abas[A].aba]);if(t==null)return null;return (preco-custo-t-D.cfg.imposto*preco-D.cfg.insumos)/preco;}
function sim(j,c){const l=LV[j],el=$('i_'+j+'_'+c),v=parseFloat(el.value.replace(/\./g,'').replace(',','.'));const tipo=D.abas[A].tipo;
 const m=margemCalc(l,tipo,v,c==='promo');$('m_'+j+'_'+c).innerHTML=pc(m)+(m!=null?'<br><small>lucro '+brl(m*v)+'</small>':'');
 const mud=!(Math.abs((v||0)-(l[c]||0))<0.005);$('s_'+j+'_'+c).style.display=mud?'':'none';el.style.background=mud?'#fff8e1':'';}
async function gravarSim(j,c){const l=LV[j],a=D.abas[A],v=$('i_'+j+'_'+c).value.trim();const b={emp:$('emp').value,aba:a.aba,sku:l.sku};b[c]=v===''?null:parseFloat(v.replace(/\./g,'').replace(',','.'));
 const r=await fetch('/precificacao/preco',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());if(r.erro)return alert(r.erro);
 const aba=A;D=await (await fetch('/precificacao/dados?emp='+$('emp').value)).json();A=aba;render();}
async function conferir(){const b=$('btconf'),e=$('emp').value;b.disabled=true;await fetch('/precificacao/conferir?emp='+e,{method:'POST'});let st;
 for(let i=0;i<400;i++){await new Promise(r=>setTimeout(r,4000));st=await fetch('/precificacao/conferir?emp='+e).then(r=>r.json());b.textContent='Conferindo… '+(st.fase||'');if(!st.rodando)break;}
 b.disabled=false;b.textContent='↻ Conferir anúncios nos sites';if(st&&st.erro)alert('Erro: '+st.erro);const aba=A;D=await (await fetch('/precificacao/dados?emp='+e)).json();A=aba;render();}

function fechar(){$('mod').style.display='none';}
function abrir(h){$('modc').innerHTML=h;$('mod').style.display='flex';}
const brn=v=>v==null||v===''?'—':(typeof v==='number'?brl(v):esc(v));
async function hist(sku){abrir('Carregando…');const H=await fetch('/precificacao/historico?emp='+$('emp').value+'&sku='+encodeURIComponent(sku)).then(r=>r.json());
 let ult=null;D.abas.forEach(a=>a.linhas.forEach(l=>{if(l.sku===sku&&!ult)ult=l;}));
 abrir('<b>'+esc(sku)+'</b> '+(ult?esc(ult.nome):'')+'<p>Custo atual: <b>'+brl(ult&&ult.custo)+'</b> · lançado em '+dt(ult&&ult.custoEm)+' por <b>'+esc(ult&&ult.custoPor||'—')+'</b></p>'+
 (H.length?'<table><tr><th class="l">Quando</th><th class="l">Quem</th><th class="l">Onde</th><th class="l">De</th><th class="l">Para</th></tr>'+H.map(x=>'<tr><td class="l">'+dt(x.quando)+'</td><td class="l">'+esc(x.quem)+'</td><td class="l">'+esc(x.onde||'')+'</td><td class="l">'+brn(x.de)+'</td><td class="l">'+brn(x.para)+'</td></tr>').join('')+'</table>':'<p><small>Sem alterações no painel (custo veio da planilha).</small></p>')+
 '<p><button onclick="fechar()">Fechar</button></p>');}
async function editPreco(sku,campo,atual){const a=D.abas[A];const v=prompt((campo==='preco'?'Preço cheio':'Preço de promoção')+' de '+sku+' em '+a.aba+' (R$; vazio = sem):',atual?String(atual).replace('.',','):'');if(v==null)return;
 const b={emp:$('emp').value,aba:a.aba,sku};b[campo]=v.trim()===''?null:parseFloat(v.replace(',','.'));
 const r=await fetch('/precificacao/preco',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());if(r.erro)return alert(r.erro);
 const aba=A;D=await (await fetch('/precificacao/dados?emp='+$('emp').value)).json();A=aba;render();}
async function editPeso(sku,atual){const v=prompt('Peso de '+sku+' em kg (o maior entre o real e o cúbico C×L×A÷6000):',atual?String(atual).replace('.',','):'');if(v==null)return;const n=parseFloat(v.replace(',','.'));if(!(n>0))return alert('Peso inválido');
 const r=await fetch('/precificacao/peso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emp:$('emp').value,sku,peso:n})}).then(r=>r.json());if(r.erro)return alert(r.erro);
 const aba=A;D=await (await fetch('/precificacao/dados?emp='+$('emp').value)).json();A=aba;render();}
function novo(){if(!D||D.erro)return;const canais=D.abas.filter(a=>a.tipo!=='base');
 abrir('<b>Incluir item ou kit</b> <small>(empresa: '+esc($('emp').selectedOptions[0].text)+')</small><p>Código no '+D.erp+' <input id="n_sku" style="width:180px"> <button onclick="nbuscar()">Buscar</button></p><div id="n_res"><small>Para kit, use o código do kit cadastrado no '+D.erp+': o custo vem da soma da composição.</small></div>'+
 '<div id="n_form" style="display:none"><p>Produto <input id="n_nome" style="width:100%"></p><p>Qtd <input id="n_qtd" value="1" style="width:60px"> &nbsp; Custo (R$) <input id="n_custo" style="width:100px"> &nbsp; Peso (kg) <input id="n_peso" style="width:80px"> <small id="n_pinfo"></small></p>'+
 '<table><tr><th class="l">Canal</th><th class="l">Preço cheio</th><th class="l">Promoção</th><th class="l"></th></tr>'+canais.map((a,i)=>'<tr><td class="l">'+esc(a.aba)+'</td><td class="l"><input id="n_p'+i+'" style="width:90px" placeholder="0,00"></td><td class="l"><input id="n_q'+i+'" style="width:90px" placeholder="0,00"></td><td class="l">'+(a.tipo==='ml'?'Comissão % <input id="n_c'+i+'" style="width:55px" placeholder="12">':a.tipo==='amazon'?'Frete DBA R$ <input id="n_f'+i+'" style="width:60px" placeholder="0">':'')+'</td></tr>').join('')+'</table>'+
 '<p><small>Só entra nos canais com preço preenchido. As tarifas seguem a regra de cada canal (ML e SHEIN usam o peso; Amazon acima de R$ 79 soma o frete DBA informado).</small></p><p><button onclick="nsalvar()" style="background:#2e7d32">Incluir</button> <button onclick="fechar()" style="background:#888">Cancelar</button></p></div>');
 setTimeout(()=>$('n_sku').focus(),50);}
async function nbuscar(){const sku=$('n_sku').value.trim();if(!sku)return;$('n_res').textContent='Buscando no '+D.erp+'…';
 const r=await fetch('/precificacao/buscar?emp='+$('emp').value+'&sku='+encodeURIComponent(sku)).then(r=>r.json());if(r.erro){$('n_res').innerHTML='<span class="dif">'+esc(r.erro)+'</span>';return;}
 $('n_res').innerHTML=(r.nome?'<b>'+esc(r.nome)+'</b>':'<span class="sem">Não achei no '+D.erp+' — preencha o nome e o custo.</span>')+(r.kit?' · <b>kit</b>':'')+' · custo no '+D.erp+': <b>'+brl(r.custo)+'</b>'+(r.abas.length?'<br><small>Já está em: '+esc(r.abas.join(', '))+'</small>':'');
 $('n_form').style.display='';$('n_nome').value=r.nome||'';$('n_custo').value=r.custo!=null?String(r.custo).replace('.',','):'';$('n_sku').value=r.sku;$('n_peso').value=r.peso?String(r.peso).replace('.',','):'';$('n_pinfo').textContent=r.peso?'(real '+(r.pesoReal??'—')+' · cúbico '+(r.pesoCubico??'—')+')':'informe o peso';}
async function nsalvar(){const canais={};D.abas.filter(a=>a.tipo!=='base').forEach((a,i)=>{const p=$('n_p'+i).value.trim();if(p){const c=$('n_c'+i),f=$('n_f'+i);canais[a.aba]={preco:parseFloat(p.replace(',','.')),promo:$('n_q'+i).value.trim()?parseFloat($('n_q'+i).value.replace(',','.')):null,com:c&&c.value.trim()?parseFloat(c.value.replace(',','.')):null,frete:f&&f.value.trim()?parseFloat(f.value.replace(',','.')):null};}});
 const b={emp:$('emp').value,sku:$('n_sku').value.trim(),nome:$('n_nome').value.trim(),qtd:parseFloat($('n_qtd').value.replace(',','.'))||1,custo:$('n_custo').value.trim()?parseFloat($('n_custo').value.replace(',','.')):null,peso:$('n_peso').value.trim()?parseFloat($('n_peso').value.replace(',','.')):null,canais};
 const r=await fetch('/precificacao/adicionar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());if(r.erro)return alert(r.erro);
 fechar();alert(r.sku+' incluído em: '+r.abas.join(', '));D=await (await fetch('/precificacao/dados?emp='+$('emp').value)).json();render();}
carregar();
</script></body></html>`;
}

// ─── Alterar custo (grava no ERP) ──────────────────────────────────────────
const ARQ_ED = path.join(DIR, 'edicoes.json');
async function gravarCusto(idx, sku, custo, quem) {
  sku = K(sku); if (!sku) throw new Error('código vazio');
  if (!(custo > 0) || custo > 100000) throw new Error('custo inválido');
  const cm = require('./custos_ml');
  if (Array.isArray(cm.kits(idx)[sku]) && cm.kits(idx)[sku].length) throw new Error('é kit: o custo é a soma dos componentes — altere o custo dos itens');
  let de = null;
  if (idx === 2) {
    // Tiny v2: produto.alterar.php regrava o cadastro inteiro — reenvia tudo o que veio do produto.obter.php
    // (descrição complementar, anexos etc.) e confere depois que nada sumiu
    const tiny = require('./tiny');
    const pq = await tiny.chamar('produtos.pesquisa.php', { pesquisa: sku });
    const achado = (pq.produtos || []).map(x => x.produto).find(x => K(x.codigo) === sku);
    if (!achado) throw new Error('produto ' + sku + ' não encontrado no Tiny');
    const ob = (await tiny.chamar('produto.obter.php', { id: achado.id })).produto;
    if (!ob) throw new Error('não consegui ler o produto no Tiny');
    if (String(ob.classe_produto).toUpperCase() === 'K' || ob.kit?.length) throw new Error('é kit no Tiny: altere o custo dos componentes');
    if ((Array.isArray(ob.variacoes) && ob.variacoes.length) || String(ob.classe_produto).toUpperCase() === 'V') throw new Error('produto pai com variações no Tiny: altere o custo de cada variação');
    de = num(ob.preco_custo);
    // o obter devolve a embalagem em camelCase e o alterar espera snake_case (senão zera as medidas)
    const prod = { ...ob, preco_custo: custo, tipo_embalagem: ob.tipoEmbalagem, altura_embalagem: ob.alturaEmbalagem, comprimento_embalagem: ob.comprimentoEmbalagem, largura_embalagem: ob.larguraEmbalagem, diametro_embalagem: ob.diametroEmbalagem };
    for (const k of ['id_produto_pai', 'data_criacao', 'imagens_externas', 'mapeamentos', 'preco_custo_medio', 'tipoEmbalagem', 'alturaEmbalagem', 'comprimentoEmbalagem', 'larguraEmbalagem', 'diametroEmbalagem']) delete prod[k];
    const r = await tiny.chamar('produto.alterar.php', { produto: JSON.stringify({ produtos: [{ produto: { sequencia: '1', ...prod } }] }) });
    const st = r.registros?.[0]?.registro || r.registros?.registro;
    if (st && st.status && st.status !== 'OK') throw new Error('Tiny recusou: ' + JSON.stringify(st.erros || st).slice(0, 200));
    const dep = (await tiny.chamar('produto.obter.php', { id: achado.id })).produto || {};
    if (Math.abs(num(dep.preco_custo) - custo) > 0.005) throw new Error('o Tiny não gravou o custo (ficou ' + dep.preco_custo + ')');
    const mud = ['alturaEmbalagem', 'comprimentoEmbalagem', 'larguraEmbalagem', 'peso_liquido', 'peso_bruto', 'descricao_complementar', 'idProdutoPai', 'gtin', 'preco']
      .filter(k => String(ob[k] ?? '') !== String(dep[k] ?? '')).concat((ob.anexos || []).length !== (dep.anexos || []).length ? ['anexos'] : []);
    if (mud.length) console.warn('[precificacao] ATENÇÃO Tiny ' + sku + ': mudou ' + mud.join(', ') + ' ao alterar o custo');
  } else {
    const c0 = require('./bling').client(idx);
    const tenta = async (m, ...a) => { for (let i = 0; ; i++) { try { return await c0[m](...a); } catch (e) { if (e.response?.status === 429 && i < 8) { await new Promise(r => setTimeout(r, 700)); continue; } throw e; } } };
    const c = { get: (...a) => tenta('get', ...a), put: (...a) => tenta('put', ...a) };
    const r = await c.get('/produtos', { params: { codigo: sku } });
    const p = (r.data?.data || []).find(x => K(x.codigo) === sku);
    if (!p) throw new Error('produto ' + sku + ' não encontrado no Bling');
    if (p.formato === 'E') throw new Error('é kit (composição) no Bling: altere o custo dos componentes');
    const fs_ = (await c.get('/produtos/fornecedores', { params: { idProduto: p.id } })).data?.data || [];
    const f = fs_.find(x => x.padrao) || fs_[0];
    if (!f) throw new Error('produto sem fornecedor cadastrado no Bling: cadastre o fornecedor (o custo fica nele)');
    de = f.precoCusto ?? null;
    await c.put('/produtos/fornecedores/' + f.id, { descricao: f.descricao, codigo: f.codigo, precoCusto: custo, precoCompra: f.precoCompra, padrao: !!f.padrao, produto: { id: p.id }, fornecedor: { id: f.fornecedor?.id } });
  }
  cm.setCustoErp(idx, sku, custo);
  try { custoPainel(idx, [{ sku, custo, onde: 'painel + ' + (idx === 2 ? 'Tiny' : 'Bling') }], quem); } catch (e) {}   // o custo lançado no ERP vale também para a precificação
  delete _cache[idx];
  let L = []; try { L = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  L.push({ quando: new Date().toISOString(), quem, emp: idx, sku, de, para: custo, onde: idx === 2 ? 'Tiny' : 'Bling' });
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ_ED, JSON.stringify(L.slice(-5000)));
  console.log(`[precificacao] custo ${EMP[idx].nome} ${sku}: ${de} → ${custo} (${quem})`);
  return { sku, de, para: custo };
}

// ─── Atualizar custos do ERP agora (sem esperar o ciclo de 6 h) ─────────────
const _atual = {};
function atualizarErp(idx) {
  if (_atual[idx]?.rodando) return _atual[idx];
  const st = _atual[idx] = { rodando: true, inicio: new Date().toISOString() };
  (async () => {
    const cm = require('./custos_ml');
    if (idx !== 2) { try { const m = await require('./bling').getKits(idx); if (Object.keys(m).length) cm.salvarKits(idx, m); st.kits = Object.keys(m).length; } catch (e) { st.erroKits = e.message; } }
    cm.recarregarErp(idx);
    const mapa = await cm.custosErp(idx);
    st.produtos = Object.keys(mapa).length;
  })().catch(e => { st.erro = e.message; }).finally(() => { st.rodando = false; st.fim = new Date().toISOString(); delete _cache[idx]; });
  return st;
}

// ─── Itens novos / kits e preços editados no painel ──────────────────────────
/** Nome e custo do código no ERP (kit = soma da composição) */
async function buscarItem(idx, sku) {
  sku = K(sku); if (!sku) throw new Error('informe o código');
  const cm = require('./custos_ml'); const erp = await cm.custosErp(idx);
  const kit = cm.custoKit(idx, sku, erp), comp = cm.kits(idx)[sku];
  let nome = null, custo = kit ?? (erp[sku] > 0 ? erp[sku] : null), ehKit = kit != null || !!comp?.length, peso = null, pesoReal = null, pesoCubico = null;
  const pesoDe = (real, a, l, c) => { real = num(real); const cub = num(a) > 0 && num(l) > 0 && num(c) > 0 ? num(a) * num(l) * num(c) / 6000 : null; pesoReal = real > 0 ? r2(real) : null; pesoCubico = cub ? r2(cub) : null; peso = Math.max(pesoReal || 0, pesoCubico || 0) || null; };
  try {
    if (idx === 2) {
      const tiny = require('./tiny');
      const pq = await tiny.chamar('produtos.pesquisa.php', { pesquisa: sku });
      const a = (pq.produtos || []).map(x => x.produto).find(x => K(x.codigo) === sku);
      if (a) { nome = a.nome; const ob = (await tiny.chamar('produto.obter.php', { id: a.id })).produto || {};
        if (String(ob.classe_produto).toUpperCase() === 'K') ehKit = true; if (custo == null && num(ob.preco_custo) > 0) custo = num(ob.preco_custo);
        pesoDe(ob.peso_bruto, ob.alturaEmbalagem, ob.larguraEmbalagem, ob.comprimentoEmbalagem); }
    } else {
      const r = await require('./bling').client(idx).get('/produtos', { params: { codigo: sku } });
      const a = (r.data?.data || []).find(x => K(x.codigo) === sku); if (a) { nome = a.nome; if (a.formato === 'E') ehKit = true;
        try { const d = (await require('./bling').client(idx).get('/produtos/' + a.id)).data?.data || {}; const dm = d.dimensoes || {}, f = dm.unidadeMedida === 2 ? 0.1 : dm.unidadeMedida === 0 ? 100 : 1;
          pesoDe(d.pesoBruto, (dm.altura || 0) * f, (dm.largura || 0) * f, (dm.profundidade || 0) * f); } catch (e) {} }
    }
  } catch (e) {}
  const F = fotografia(idx), z = v => K(v).replace(/^0+(?=.)/, '');
  const abas = F ? F.abas.filter(A => A.linhas.some(L => z(L.sku) === z(sku))).map(A => A.aba) : [];
  return { sku, nome, custo: r2(custo), kit: ehKit, peso, pesoReal, pesoCubico, abas, canais: F ? F.abas.filter(A => A.tipo !== 'base').map(A => A.aba) : [] };
}
/** Inclui um item ou kit na aba Custos e nas abas de canal escolhidas: canais = { <aba>: { preco, promo } } */
async function adicionar(idx, b, quem) {
  const F = fotografia(idx); if (!F) throw new Error('precificação ainda não carregada');
  const info = await buscarItem(idx, b.sku);
  const sku = info.sku, nome = String(b.nome || info.nome || '').trim(); if (!nome) throw new Error('informe o nome do produto (não achei ' + sku + ' no ERP)');
  const qtd = num(b.qtd) > 0 ? num(b.qtd) : 1, custo = num(b.custo) > 0 ? r2(num(b.custo)) : info.custo, peso = num(b.peso) > 0 ? num(b.peso) : info.peso;
  const agora = new Date().toISOString(), z = v => K(v).replace(/^0+(?=.)/, '');
  const nova = () => ({ linha: '—', sku, nome, qtd, peso: peso || null, custo, custoUn: custo != null ? r2(custo / qtd) : null, custoEm: agora, custoPor: quem, novo: true, incluidoPor: quem, incluidoEm: agora });
  const feitas = [];
  const base = F.abas.find(A => A.tipo === 'base');
  if (base && !base.linhas.some(L => z(L.sku) === z(sku))) { base.linhas.push(nova()); feitas.push(base.aba); }
  for (const [aba, v] of Object.entries(b.canais || {})) {
    const A = F.abas.find(a => a.aba === aba && a.tipo !== 'base'); if (!A) continue;
    const preco = num(v?.preco), promo = num(v?.promo); if (!(preco > 0)) continue;
    let L = A.linhas.find(x => z(x.sku) === z(sku));
    if (!L) { L = nova(); A.linhas.push(L); }
    L.preco = r2(preco); L.promo = promo > 0 ? r2(promo) : null; if (peso) L.peso = peso;
    L.p = { ...(L.p || {}) }; const com = num(v?.com); if (A.tipo === 'ml' && com > 0) L.p.com = L.p.comPromo = com > 1 ? com / 100 : com;
    const fr = num(v?.frete); if (fr > 0) L.p.frete = fr;
    L.lucro = L.lucroPromo = L.margem = L.margemPromo = null; feitas.push(aba);
  }
  if (!feitas.length) throw new Error(sku + ' já está na aba Custos; informe o preço em pelo menos um canal');
  // itens excluídos antes voltam se forem incluídos de novo
  const E = excluidos(idx); let mud = false; for (const a of feitas) for (const k of [a + '|' + sku, a + '|' + z(sku)]) if (E[k]) { delete E[k]; mud = true; }
  if (mud) fs.writeFileSync(arqExc(idx), JSON.stringify(E));
  fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  let H = []; try { H = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  H.push({ quando: agora, quem, emp: idx, sku, de: null, para: custo, onde: 'incluído: ' + feitas.join(', ') }); fs.writeFileSync(ARQ_ED, JSON.stringify(H.slice(-5000)));
  console.log(`[precificacao] incluído ${EMP[idx].nome} ${sku} em ${feitas.join(', ')} (${quem})`);
  if (feitas.some(a => F.abas.find(x => x.aba === a)?.tipo === 'amazon')) setTimeout(() => { try { amazonComissoes(idx, [sku]); } catch (e) {} }, 500);
  return { sku, abas: feitas };
}
/** Altera preço cheio e/ou promoção de uma linha de canal; as tarifas passam a ser % do preço (como estavam na planilha) */
function alterarPreco(idx, aba, sku, preco, promo, quem) {
  const F = fotografia(idx); if (!F) throw new Error('precificação ainda não carregada');
  const A = F.abas.find(a => a.aba === aba && a.tipo !== 'base'); if (!A) throw new Error('aba não encontrada');
  const z = v => K(v).replace(/^0+(?=.)/, ''); const L = A.linhas.find(x => z(x.sku) === z(sku)); if (!L) throw new Error('item não encontrado na aba');
  const de = { preco: L.preco, promo: L.promo };
  if (preco !== undefined) L.preco = num(preco) > 0 ? r2(num(preco)) : null;
  if (promo !== undefined) L.promo = num(promo) > 0 ? r2(num(promo)) : null;
  L.lucro = L.lucroPromo = L.margem = L.margemPromo = null; L.precoEm = new Date().toISOString(); L.precoPor = quem;
  fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  let H = []; try { H = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  H.push({ quando: L.precoEm, quem, emp: idx, sku: K(sku), onde: 'preço ' + aba, de: (de.preco ?? '—') + ' / ' + (de.promo ?? '—'), para: (L.preco ?? '—') + ' / ' + (L.promo ?? '—') });
  fs.writeFileSync(ARQ_ED, JSON.stringify(H.slice(-5000)));
  return { preco: L.preco, promo: L.promo };
}
/** Peso do código (vale para todas as abas) */
function alterarPeso(idx, sku, peso, quem) {
  const F = fotografia(idx); if (!F) throw new Error('precificação ainda não carregada'); peso = num(peso); if (!(peso > 0) || peso > 500) throw new Error('peso inválido');
  const z = v => K(v).replace(/^0+(?=.)/, ''); let n = 0;
  for (const A of F.abas) for (const L of A.linhas) if (z(L.sku) === z(sku)) { L.peso = peso; delete L.pesoRef; if (L.p) delete L.p.peso; n++; }
  if (!n) throw new Error('item não encontrado');
  fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  let H = []; try { H = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  H.push({ quando: new Date().toISOString(), quem, emp: idx, sku: K(sku), onde: 'peso', para: peso + ' kg' }); fs.writeFileSync(ARQ_ED, JSON.stringify(H.slice(-5000)));
  return n;
}
/** Itens sem peso (incluídos no painel): busca o peso no ERP (maior entre real e cúbico) */
const _pesos = {};
function completarPesos(idx) {
  if (_pesos[idx]?.rodando) return _pesos[idx];
  const st = _pesos[idx] = { rodando: true, feitos: 0, falta: [] };
  (async () => {
    const F = fotografia(idx); const skus = new Set();
    for (const A of F.abas) if (A.tipo === 'ml' || A.tipo === 'shein') for (const L of A.linhas) if (!(L.peso > 0) && !(L.pesoRef > 0) && !(L.p?.peso > 0) && !(A.tipo === 'shein' && L.p?.fixo != null)) skus.add(L.sku);
    st.total = skus.size;
    for (const sku of skus) { try { const i = await buscarItem(idx, sku); if (i.peso > 0) { alterarPeso(idx, sku, i.peso, 'ERP'); st.feitos++; } else st.falta.push(sku); } catch (e) { st.falta.push(sku); } }
  })().catch(e => { st.erro = e.message; }).finally(() => { st.rodando = false; });
  return st;
}

/** Amazon: comissão real da categoria de cada SKU (estimativa de tarifas da própria Amazon). skus = só estes (itens novos) */
const _amz = {};
function amazonComissoes(idx, skus) {
  if (_amz[idx]?.rodando) return _amz[idx];
  const st = _amz[idx] = { rodando: true, inicio: new Date().toISOString(), lidos: 0, gravados: 0, semAnuncio: [] };
  (async () => {
    const amazon = require('./amazon'); const chave = Object.keys(amazon.LOJAS).find(k => amazon.LOJAS[k].ml === idx);
    if (!chave) throw new Error('empresa sem conta Amazon'); const A = amazon.loja(chave);
    const F0 = fotografia(idx); const z = v => K(v).replace(/^0+(?=.)/, '');
    const alvo = new Set(); for (const T of F0.abas) if (T.tipo === 'amazon') for (const L of T.linhas) if (!skus || skus.map(z).includes(z(L.sku))) alvo.add(L.sku);
    st.total = alvo.size;
    // SKU → ASIN pelos anúncios da conta
    const seller = await A.sellerId('B07HGLN8R5'); const asin = {}; let tok = null;
    for (let pg = 0; pg < 400; pg++) {
      const q = { marketplaceIds: A.MARKETPLACE_BR, includedData: 'summaries', pageSize: 20 }; if (tok) q.pageToken = tok;
      const d = await A.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), q);
      for (const it of d.items || []) { const a = it.summaries?.[0]?.asin; if (a) asin[z(it.sku)] = a; }
      st.lidos = Object.keys(asin).length; tok = d.pagination?.nextToken; if (!tok) break; await new Promise(r => setTimeout(r, 250));
    }
    const lista = [...alvo].filter(s => asin[z(s)]); st.semAnuncio = [...alvo].filter(s => !asin[z(s)]);
    const precoDe = s => { for (const T of F0.abas) if (T.tipo === 'amazon') { const L = T.linhas.find(x => z(x.sku) === z(s)); if (L?.preco > 0) return L.preco; } return 100; };
    const res = {};
    for (let i = 0; i < lista.length; i += 20) {
      const lote = lista.slice(i, i + 20).map((s, j) => ({ asin: asin[z(s)], preco: Math.max(precoDe(s), 40), id: 'k' + (i + j) }));
      let out = {}; for (let t = 0; t < 6; t++) { try { out = await A.tarifas(lote); break; } catch (e) { await new Promise(r => setTimeout(r, 3000 * (t + 1))); } }
      lote.forEach((x, j) => { const o = out[x.id]; const fee = o?.det?.ReferralFee; if (fee > 0) res[z(lista[i + j])] = { com: Math.round(fee / x.preco * 10000) / 10000 }; });
      await new Promise(r => setTimeout(r, 2100));
    }
    const F = fotografia(idx);
    for (const T of F.abas) if (T.tipo === 'amazon') for (const L of T.linhas) { const r = res[z(L.sku)]; if (r) { L.p = { ...(L.p || {}), com: r.com, comMin: r.com >= 0.1 ? 2 : 1, comFonte: 'Amazon ' + new Date().toISOString().slice(0, 10) }; st.gravados++; } }
    fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  })().catch(e => { st.erro = e.message; }).finally(() => { st.rodando = false; st.fim = new Date().toISOString(); });
  return st;
}

// ─── Conferência com os sites: anúncio existe? + regras do ML (comissão por categoria e tabela de frete da conta) ───
let _ml = null;   // função ml(idx, path, params) do server.js
const _site = {};
const ML_REPR = [10, 30, 60, 90, 110, 130, 170, 250];   // um preço dentro de cada faixa da tabela de frete do ML
function conferirSites(idx) {
  if (_site[idx]?.rodando) return _site[idx];
  const st = _site[idx] = { rodando: true, inicio: new Date().toISOString(), fase: '', canais: {} };
  const z = v => K(v).replace(/^0+(?=.)/, ''), D = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    const achados = {};   // tipo → Set de códigos encontrados no site (ou null = não deu para conferir)
    const comML = {};     // código → {com, mlb, tipo}
    // Mercado Livre
    if (_ml) try {
      st.fase = 'Mercado Livre: anúncios';
      const uid = (await _ml(idx, '/users/me')).id, ids = new Set();
      for (const status of ['active', 'paused']) { let scroll = null;
        for (let k = 0; k < 200; k++) { const r = await _ml(idx, `/users/${uid}/items/search`, { status, limit: 100, search_type: 'scan', ...(scroll ? { scroll_id: scroll } : {}) });
          (r.results || []).forEach(x => ids.add(x)); scroll = r.scroll_id; if (!(r.results || []).length) break; } }
      const L = [...ids], cats = {}, S = new Set();
      for (let i = 0; i < L.length; i += 20) {
        const R = await _ml(idx, '/items', { ids: L.slice(i, i + 20).join(','), attributes: 'id,category_id,listing_type_id,attributes,variations,seller_custom_field' });
        for (const w of Array.isArray(R) ? R : [R]) { const x = w.body || w; if (!x?.id) continue;
          const skus = [(x.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name, x.seller_custom_field, ...(x.variations || []).map(v => (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || v.seller_custom_field)].filter(Boolean);
          for (const s of skus) { S.add(z(s)); cats[x.category_id] = 1; if (!comML[z(s)] || x.listing_type_id === 'gold_special') comML[z(s)] = { cat: x.category_id, mlb: x.id }; } }
        st.canais.ml = S.size;
      }
      st.fase = 'Mercado Livre: comissão por categoria';
      const pct = {};
      for (const cat of Object.keys(cats)) for (const tipo of ['gold_special', 'gold_pro']) { try {
        const r = await _ml(idx, '/sites/MLB/listing_prices', { price: 100, category_id: cat, listing_type_id: tipo }); const x = Array.isArray(r) ? r[0] : r;
        const pf = x?.sale_fee_details?.percentage_fee; if (pf > 0) pct[cat + '|' + tipo] = pf / 100; } catch (e) {} await D(120); }
      for (const v of Object.values(comML)) { v.classico = pct[v.cat + '|gold_special'] ?? null; v.premium = pct[v.cat + '|gold_pro'] ?? null; }
      achados.ml = S;
      // tabela de frete/custo operacional da conta (peso × faixa de preço), direto do ML
      st.fase = 'Mercado Livre: tabela de frete';
      const T = { faixas: ML_FRETE_PADRAO.faixas, pesos: ML_FRETE_PADRAO.pesos, tab: [] };
      for (const w of T.pesos) { const lin = [];
        for (const p of ML_REPR) { let v = null; try { const r = await _ml(idx, `/users/${uid}/shipping_options/free`, { dimensions: '10x10x10,' + Math.round((w === Infinity ? 160 : w) * 1000), item_price: p, listing_type_id: 'gold_special', mode: 'me2', condition: 'new', logistic_type: 'drop_off', verbose: true });
          v = r?.coverage?.all_country?.list_cost ?? null; } catch (e) {} lin.push(v); await D(120); }
        T.tab.push(lin); }
      if (T.tab.every(l => l.every(v => typeof v === 'number'))) { T.em = new Date().toISOString(); st.mlFrete = T; }
    } catch (e) { st.erroMl = e.message; }
    // Amazon
    try { st.fase = 'Amazon';
      const amazon = require('./amazon'), ch = Object.keys(amazon.LOJAS).find(k => amazon.LOJAS[k].ml === idx);
      if (ch) { const A = amazon.loja(ch); if (A.configurada()) { const seller = await A.sellerId('B07HGLN8R5'), S = new Set(); let tok = null;
        for (let pg = 0; pg < 400; pg++) { const q = { marketplaceIds: A.MARKETPLACE_BR, includedData: 'summaries', pageSize: 20 }; if (tok) q.pageToken = tok;
          const d = await A.get('/listings/2021-08-01/items/' + encodeURIComponent(seller), q); (d.items || []).forEach(it => S.add(z(it.sku))); tok = d.pagination?.nextToken; if (!tok) break; await D(250); }
        achados.amazon = S; st.canais.amazon = S.size; } }
    } catch (e) { st.erroAmazon = e.message; }
    // Shopee
    try { st.fase = 'Shopee';
      const shopee = require('./shopee'), ch = Object.keys(shopee.LOJAS).find(k => shopee.LOJAS[k].ml === idx);
      if (ch) { const SP = shopee.loja(ch), S = new Set(), ids = [];
        for (const status of ['NORMAL', 'UNLIST']) for (let offset = 0; ;) { const d = await SP.shopeeGet('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: status });
          ids.push(...(d.response?.item || []).map(i => i.item_id)); if (!d.response?.has_next_page) break; offset = d.response.next_offset; }
        for (let i = 0; i < ids.length; i += 50) { const d = await SP.shopeeGet('/api/v2/product/get_item_base_info', { item_id_list: ids.slice(i, i + 50).join(',') });
          for (const it of d.response?.item_list || []) { if (it.item_sku) S.add(z(it.item_sku));
            if (it.has_model) { const m = await SP.shopeeGet('/api/v2/product/get_model_list', { item_id: it.item_id }); (m.response?.model || []).forEach(x => x.model_sku && S.add(z(x.model_sku))); } } }
        achados.shopee = S; st.canais.shopee = S.size; }
    } catch (e) { st.erroShopee = e.message; }
    // SHEIN (catálogo que o painel já mantém)
    try { st.fase = 'SHEIN';
      const shein = require('./shein'), ch = Object.keys(shein.LOJAS).find(k => ({ zagodini: 0, mae: 1, lufe: 2 })[k] === idx);
      if (ch) { let C = shein.catCache(ch); if (!C.ts || Date.now() - C.ts > 864e5) { try { await shein.catalogo(ch); C = shein.catCache(ch); } catch (e) {} }
        const S = new Set(Object.values(C.skus || {}).map(v => z(v.sku)).filter(Boolean)); if (S.size) { achados.shein = S; st.canais.shein = S.size; } }
    } catch (e) { st.erroShein = e.message; }
    // grava: linha vermelha quando o código não está no site; comissão do ML pela categoria do anúncio
    st.fase = 'gravando';
    const F = fotografia(idx), agora = new Date().toISOString();
    if (st.mlFrete) F.mlFrete = st.mlFrete;
    for (const A of F.abas) { if (A.tipo === 'base') continue; const S = achados[A.tipo]; if (!S) { A.conferido = null; continue; }
      A.conferido = agora;
      for (const L of A.linhas) { const ok = S.has(z(L.sku)) || (L.skuPlanilha && S.has(z(L.skuPlanilha))); L.noSite = ok;
        if (A.tipo === 'ml') { const c = comML[z(L.sku)], v = c && (/premium/i.test(A.aba) ? c.premium : c.classico); if (v) L.p = { ...(L.p || {}), com: v, comPromo: v, comFonte: 'ML ' + (/premium/i.test(A.aba) ? 'Premium' : 'Clássico') + ' — categoria ' + c.cat + ' (' + c.mlb + ')' }; } } }
    fs.writeFileSync(arq(idx), JSON.stringify(F)); delete _cache[idx];
  })().catch(e => { st.erro = e.message; }).finally(() => { st.rodando = false; st.fim = new Date().toISOString(); st.fase = ''; });
  return st;
}

function historicoSku(idx, sku) {
  const z = v => K(v).replace(/^0+(?=.)/, ''), alvo = z(sku);
  let H = []; try { H = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  return H.filter(x => x.emp === idx && z(x.sku) === alvo).slice(-50).reverse();
}

function rotas(app, deps = {}) {
  _ml = deps.ml || null;
  // conferência diária com os sites (madrugada): uma empresa de cada vez
  setInterval(() => { const h = new Date().getUTCHours(); if (h !== 7) return; for (const i of [0, 1, 2]) if (!_site[i] || Date.now() - new Date(_site[i].inicio).getTime() > 20 * 3600e3) { conferirSites(i); break; } }, 15 * 60e3);
  const admin = req => !require('./auth').ativo() || !!req.usuario?.admin;
  app.get('/precificacao', (req, res) => res.send(pagina(admin(req))));
  app.get('/precificacao/dados', async (req, res) => {
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json(await dados(idx)); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.post('/precificacao/custo', require('express').json(), async (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, ...(await gravarCusto(idx, req.body.sku, num(req.body.custo), req.usuario?.email || 'local')) }); }
    catch (e) { res.status(400).json({ erro: e.response?.data?.error?.description || e.message }); }
  });
  app.post('/precificacao/excluir', require('express').json(), (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, removidas: excluir(idx, String(req.body.aba || ''), req.body.sku, req.usuario?.email || 'local') }); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/custo-painel', require('express').json({ limit: '2mb' }), (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, linhas: custoPainel(idx, req.body.lista || [], req.usuario?.email || 'local') }); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/atualizar-erp', (req, res) => {
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    res.json(atualizarErp(idx));
  });
  app.get('/precificacao/atualizar-erp', (req, res) => res.json(_atual[parseInt(req.query.emp)] || {}));
  app.get('/precificacao/historico', (req, res) => res.json(historicoSku(parseInt(req.query.emp), String(req.query.sku || ''))));
  app.get('/precificacao/buscar', async (req, res) => {
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json(await buscarItem(idx, req.query.sku)); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/adicionar', require('express').json(), async (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, ...(await adicionar(idx, req.body, req.usuario?.email || 'local')) }); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/preco', require('express').json(), (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, ...alterarPreco(idx, String(req.body.aba || ''), req.body.sku, req.body.preco, req.body.promo, req.usuario?.email || 'local') }); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/peso', require('express').json(), (req, res) => {
    const idx = parseInt(req.body?.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json({ ok: true, linhas: alterarPeso(idx, req.body.sku, req.body.peso, req.usuario?.email || 'local') }); } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  app.post('/precificacao/completar-pesos', (req, res) => { const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' }); res.json(completarPesos(idx)); });
  app.get('/precificacao/completar-pesos', (req, res) => res.json(_pesos[parseInt(req.query.emp)] || {}));
  app.post('/precificacao/amazon-comissoes', (req, res) => { const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' }); res.json(amazonComissoes(idx)); });
  app.get('/precificacao/amazon-comissoes', (req, res) => res.json(_amz[parseInt(req.query.emp)] || {}));
  app.post('/precificacao/conferir', (req, res) => { const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' }); res.json(conferirSites(idx)); });
  app.get('/precificacao/conferir', (req, res) => res.json(_site[parseInt(req.query.emp)] || {}));
  app.get('/precificacao/edicoes', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(ARQ_ED)).slice(-300).reverse()); } catch (e) { res.json([]); } });
}
module.exports = { rotas, importar, dados, lerAba, tipoAba, adicionar, alterarPreco, historicoSku, custoPainel };
