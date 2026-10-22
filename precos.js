/**
 * Conferência de preços: planilha de precificação (OneDrive) × preço nos sites.
 *
 *  Planilha: para cada aba de canal (ML…, Shopee…, Amazon…, Shein…) acha a linha de cabeçalho (a que tem "Produto"),
 *  a coluna do código e as colunas de preço ("Preço Venda", "VENDA", "Preço", "Preço Promocional"…).
 *  A 1ª coluna de preço é o preço cheio; as seguintes são preços de promoção/campanha.
 *
 *  Sites (dados que o painel já carrega):
 *   - Mercado Livre: preço cheio (original_price ou price) e preço promocional (sale_price), tipo do anúncio e Full
 *   - Shopee: preço cheio (original_price) e preço da promoção de desconto em andamento, por variação
 *   - Amazon: preço do anúncio
 *   - SHEIN: preço do catálogo (preço especial ou base)
 *
 *  Situação: ok = o preço do site bate com algum preço da planilha para aquele SKU no canal
 *            (cheio com o cheio; promoção com um dos preços de promoção ou com o cheio).
 *            No ML só o preço cheio é conferido (a promoção varia com as campanhas do ML).
 *
 *  GET /precos/conferencia?emp=0|1|2   JSON
 *  GET /precos                          página
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const DATA = require('./dados');

const EMP = [
  { idx: 0, id: 'zagodini', nome: 'Zagodini' },
  { idx: 1, id: 'mae', nome: 'Com Amor de Mãe' },
  { idx: 2, id: 'lufe', nome: 'Lufe' },
];
const K = v => String(v ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[R$\s]/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const r2 = v => Math.round(v * 100) / 100;
const igual = (a, b) => a != null && b != null && Math.abs(a - b) < 0.015;

function canalAba(nome) {
  const n = nome.toLowerCase();
  if (/frete|camãe|camae/.test(n)) return null;
  if (/^(full\s*ml|ml|mercado)/.test(n)) return 'ml';
  if (/^shopee/.test(n)) return 'shopee';
  if (/^amazon/.test(n)) return 'amazon';
  if (/^shein/.test(n)) return 'shein';
  return null;
}
function tipoAbaML(nome) {
  const n = nome.toLowerCase();
  if (/full/.test(n)) return 'full';
  if (/premium/.test(n)) return 'gold_pro';
  if (/cl[aá]ssico|normal/.test(n)) return 'gold_special';
  return null;
}

/** { canal: { SKU: [{ aba, tipo, precos:[cheio, promo1, ...] }] } } */
const _pl = {};
function lerPlanilha(idx) {
  const nome = require('./custos_ml').PLANILHAS[idx], arq = path.join(DATA, nome || '');
  let mtime; try { mtime = fs.statSync(arq).mtimeMs; } catch (e) { return null; }
  if (_pl[idx]?.mtime === mtime) return _pl[idx];
  const wb = XLSX.readFile(arq, { cellDates: true });
  const out = { mtime, arquivo: nome, atualizada: new Date(mtime).toISOString(), canais: {}, abas: [] };
  for (const aba of wb.SheetNames) {
    const canal = canalAba(aba); if (!canal) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: null, raw: true });
    const h = rows.slice(0, 10).findIndex(r => r.some(c => /^produto$/i.test(String(c ?? '').trim())));
    if (h < 0) continue;
    const cab = rows[h].map(c => String(c ?? '').trim());
    let cCod = cab.findIndex(c => /^c[oó]d/i.test(c)); if (cCod < 0) cCod = 0;
    const cProd = cab.findIndex(c => /^produto$/i.test(c));
    const cPreco = cab.map((c, i) => (/pre[çc]o|^venda/i.test(c) && !/lucro|%|comiss|desc|custo|oficial|campanha/i.test(c)) ? i : -1).filter(i => i >= 0);
    if (!cPreco.length) continue;
    out.abas.push({ aba, canal, colunas: cPreco.map(i => cab[i]) });
    const tipo = canal === 'ml' ? tipoAbaML(aba) : null;
    for (const r of rows.slice(h + 1)) {
      const sku = K(r[cCod]); if (!sku || sku === 'COD' || sku === 'CODIGO') continue;
      const precos = cPreco.map(i => num(r[i])).map(v => v > 0 ? r2(v) : null);
      if (!precos.some(v => v)) continue;
      ((out.canais[canal] ||= {})[sku] ||= []).push({ aba, tipo, precos, produto: r[cProd] || '' });
    }
  }
  _pl[idx] = out;
  return out;
}

/** Itens dos sites no formato { canal, sku, nome, anuncio, link, cheio, promo, tipo, variacao } */
function itensSites(e, fontes) {
  const out = [];
  // Mercado Livre
  const d = fontes.ml()[e.idx];
  for (const it of [...(d?.semPromo || []), ...(d?.comPromo || []), ...(d?.semPromo?.ignorados || [])]) {
    const cheio = it.regular_amount || it.original_price || it.price, promo = it.sale_amount && it.sale_amount < cheio ? it.sale_amount : (it.original_price && it.price < it.original_price ? it.price : null);
    out.push({ canal: 'ml', sku: it._sku, nome: it.title, anuncio: it.id, link: 'https://www.mercadolivre.com.br/anuncios/lista?search=' + it.id,
      cheio, promo, tipo: it.shipping?.logistic_type === 'fulfillment' ? 'full' : it.listing_type_id || null });
  }
  // Shopee
  for (const p of fontes.shp()[e.id]?.cache?.produtos || []) {
    const promo = m => (p._promoAtiva || []).find(x => /discount/i.test(x.tipo || '') && String(x.modelo || 0) === String(m || 0))?.preco ?? null;
    const link = 'https://seller.shopee.com.br/portal/product/' + p.item_id;
    if (p._variacoes?.length) for (const v of p._variacoes) out.push({ canal: 'shopee', sku: v.sku || p.item_sku, nome: p.item_name, variacao: v.nome, anuncio: p.item_id, link, cheio: v.original ?? v.preco, promo: promo(v.model_id) });
    else out.push({ canal: 'shopee', sku: p.item_sku, nome: p.item_name, anuncio: p.item_id, link, cheio: p.price_info?.[0]?.original_price ?? p.price_info?.[0]?.current_price, promo: promo(0) });
  }
  // Amazon
  for (const a of fontes.az()[e.id]?.anuncios || []) if (a.status === 'Active')
    out.push({ canal: 'amazon', sku: a.sku, nome: a.nome, anuncio: a.asin, link: 'https://sellercentral.amazon.com.br/myinventory/inventory?searchField=all&searchTerm=' + encodeURIComponent(a.sku || ''), cheio: a.preco, promo: null, tipo: a.fba ? 'fba' : null });
  // SHEIN
  try {
    const sh = require('./shein');
    if (sh.autorizada(e.id)) for (const [code, c] of Object.entries(sh.catCache(e.id).skus || {})) if (!c.inativo)
      out.push({ canal: 'shein', sku: c.sku, nome: c.titulo, anuncio: code, link: 'https://sellerhub.shein.com/', cheio: c.preco, promo: null });
  } catch (er) {}
  return out.filter(x => x.cheio > 0);
}

function conferir(idx, fontes) {
  const e = EMP.find(x => x.idx === idx); if (!e) throw new Error('empresa inválida');
  const pl = lerPlanilha(idx);
  if (!pl) return { empresa: e.nome, erro: 'planilha de precificação não encontrada no servidor (sincronização do OneDrive)' };
  const itens = itensSites(e, fontes), linhas = [], resumo = {};
  for (const s of itens) {
    const R = resumo[s.canal] ||= { total: 0, ok: 0, diferente: 0, semPlanilha: 0, semSku: 0 };
    R.total++;
    const base = { canal: s.canal, sku: s.sku || '', nome: s.nome, variacao: s.variacao || '', anuncio: s.anuncio, link: s.link, tipo: s.tipo || null, site: { cheio: r2(s.cheio), promo: s.promo ? r2(s.promo) : null } };
    if (!s.sku) { R.semSku++; linhas.push({ ...base, situacao: 'sem SKU no anúncio' }); continue; }
    const regs = pl.canais[s.canal]?.[K(s.sku)];
    if (!regs?.length) { R.semPlanilha++; linhas.push({ ...base, situacao: 'não está na planilha' }); continue; }
    // ML: usa a aba do tipo do anúncio (Premium/Clássico/Full) quando o SKU estiver nela
    const preferidos = s.canal === 'ml' && s.tipo ? regs.filter(r => r.tipo === s.tipo) : [];
    const usar = preferidos.length ? preferidos : regs;
    const cheios = usar.map(r => r.precos[0]).filter(Boolean), promos = usar.flatMap(r => r.precos.slice(1)).filter(Boolean);
    const okCheio = cheios.some(p => igual(p, s.cheio));
    // ML: o preço promocional muda com as campanhas do ML (com desconto bancado pelo ML) — confere só o preço cheio
    const okPromo = s.canal === 'ml' || !s.promo || [...promos, ...cheios].some(p => igual(p, s.promo));
    const planilha = { abas: [...new Set(usar.map(r => r.aba))], cheio: [...new Set(cheios)], promos: [...new Set(promos)] };
    if (okCheio && okPromo) { R.ok++; linhas.push({ ...base, planilha, situacao: 'ok' }); continue; }
    R.diferente++;
    linhas.push({ ...base, planilha, situacao: !okCheio && !okPromo ? 'preço e promoção diferentes' : !okCheio ? 'preço cheio diferente' : 'promoção diferente' });
  }
  return { empresa: e.nome, planilha: { arquivo: pl.arquivo, atualizada: pl.atualizada, abas: pl.abas }, resumo, linhas };
}

function pagina() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conferência de preços</title><style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}.top a{color:#ffd60a;font-size:13px}
.box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:16px 20px;margin:16px auto;max-width:1200px;overflow-x:auto}select,input{padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 8px;border-bottom:1px solid #f2f2f2;text-align:right;vertical-align:top}.l{text-align:left}small{color:#888}.cards{display:flex;gap:10px;flex-wrap:wrap}
.card{flex:1;min-width:170px;border:1px solid #eee;border-radius:10px;padding:10px 12px;font-size:13px}.card b{font-size:18px}.ok{color:#2e7d32}.dif{color:#c62828}.sem{color:#E65100}</style></head><body>
<div class="top"><b>💲 Conferência de preços — planilha × sites</b><span style="flex:1"></span>
<select id="emp" onchange="carregar()"><option value="0">Zagodini</option><option value="1">Com Amor de Mãe</option><option value="2">Lufe</option></select>
<select id="canal" onchange="render()"><option value="">Todos os sites</option><option value="ml">Mercado Livre</option><option value="shopee">Shopee</option><option value="amazon">Amazon</option><option value="shein">SHEIN</option></select>
<select id="sit" onchange="render()"><option value="dif">Só diferenças</option><option value="sem">Não estão na planilha</option><option value="">Tudo</option></select>
<input id="q" placeholder="Buscar SKU ou nome" oninput="render()"><a href="/painel.html">← Painel</a></div>
<div class="box" id="info">Carregando…</div><div class="box" id="lista"></div>
<script>
let D=null;const $=id=>document.getElementById(id);const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const brl=v=>v==null?'—':'R$ '+Number(v).toFixed(2).replace('.',',');const NOME={ml:'Mercado Livre',shopee:'Shopee',amazon:'Amazon',shein:'SHEIN'};
const TIPO={gold_pro:'Premium',gold_special:'Clássico',full:'Full',fba:'FBA'};
async function carregar(){$('info').textContent='Carregando…';$('lista').innerHTML='';D=await (await fetch('/precos/conferencia?emp='+$('emp').value)).json();
 if(D.erro){$('info').innerHTML='<span class="dif">'+esc(D.erro)+'</span>';return;}
 $('info').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:10px">Planilha <b>'+esc(D.planilha.arquivo)+'</b> (cópia do OneDrive de '+new Date(D.planilha.atualizada).toLocaleString('pt-BR')+'). Abas lidas: '+D.planilha.abas.map(a=>esc(a.aba)).join(', ')+'. Ok = o preço do site bate com a planilha (cheio com o cheio; promoção com um dos preços de promoção da aba). No Mercado Livre só o preço cheio é conferido — a promoção muda com as campanhas do ML.</div><div class="cards">'+
 Object.entries(D.resumo).map(([c,r])=>'<div class="card"><div>'+NOME[c]+'</div><b class="ok">'+r.ok+'</b> ok · <b class="dif">'+r.diferente+'</b> diferentes<br><small>'+r.semPlanilha+' fora da planilha · '+r.semSku+' sem SKU · '+r.total+' anúncios</small></div>').join('')+'</div>';render();}
function render(){if(!D||D.erro)return;const c=$('canal').value,s=$('sit').value,q=$('q').value.toLowerCase();
 let L=D.linhas.filter(l=>(!c||l.canal===c)&&(!s||(s==='dif'?/diferente/.test(l.situacao):/planilha|SKU/.test(l.situacao)))&&(!q||(l.sku+' '+l.nome).toLowerCase().includes(q)));
 $('lista').innerHTML='<div style="margin-bottom:8px;font-size:13px;color:#555">'+L.length+' anúncios</div><table><tr><th class="l">Produto</th><th class="l">Site</th><th>Site: preço / promoção</th><th>Planilha: preço / promoção</th><th class="l">Situação</th></tr>'+
 L.slice(0,1500).map(l=>'<tr><td class="l"><a href="'+esc(l.link)+'" target="_blank" style="color:inherit">'+esc(l.nome)+'</a>'+(l.variacao?'<br><small>'+esc(l.variacao)+'</small>':'')+'<br><small>SKU '+esc(l.sku||'—')+' · '+esc(l.anuncio)+'</small></td>'+
 '<td class="l">'+NOME[l.canal]+(l.tipo&&TIPO[l.tipo]?'<br><small>'+TIPO[l.tipo]+'</small>':'')+'</td>'+
 '<td><b>'+brl(l.site.cheio)+'</b>'+(l.site.promo?'<br>promo '+brl(l.site.promo):'')+'</td>'+
 '<td>'+(l.planilha?l.planilha.cheio.map(brl).join(' / ')+(l.planilha.promos.length?'<br><small>promo '+l.planilha.promos.map(brl).join(', ')+'</small>':'')+'<br><small>'+esc(l.planilha.abas.join(', '))+'</small>':'—')+'</td>'+
 '<td class="l '+(l.situacao==='ok'?'ok':/diferente/.test(l.situacao)?'dif':'sem')+'">'+esc(l.situacao)+'</td></tr>').join('')+'</table>';}
carregar();
</script></body></html>`;
}

function rotas(app, fontes) {
  app.get('/precos/conferencia', (req, res) => {
    try { res.json(conferir(parseInt(req.query.emp) || 0, fontes)); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.get('/precos', (req, res) => res.send(pagina()));
}
module.exports = { rotas, conferir, lerPlanilha };
