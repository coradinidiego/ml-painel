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

/** Tipo da aba: base | ml | shopee | amazon | shein | tiktok | null (ignorada) */
function tipoAba(nome) {
  const n = nome.trim().toLowerCase();
  if (/cam[aã]e|frete|viabilidade|simplificada|planilha\d|custo (lyor|meio)|custos atelie|magalu|12%/.test(n)) return null;
  if (/^(base|custos)$/.test(n)) return 'base';
  if (/^(ml|full\s*ml|mercado)/.test(n)) return 'ml';
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
  const lucros = cab.map((c, i) => /^lucro/i.test(c) && !/%/.test(c) ? i : -1).filter(i => i >= 0);
  const margens = cab.map((c, i) => /%\s*(de\s*)?(lucro|bruto)/i.test(c) ? i : -1).filter(i => i >= 0);
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
      L.lucro = r2(num(r[lucros[0]])); L.margem = num(r[margens[0]]);
      L.lucroPromo = r2(num(r[lucros[1]])); L.margemPromo = num(r[margens[1]]);
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
  const out = { empresa: EMP[idx].nome, arquivo: nomeArq, planilhaEm: new Date(st.mtimeMs).toISOString(), importadoEm: new Date().toISOString(), abas: [] };
  for (const aba of wb.SheetNames) {
    const tipo = tipoAba(aba); if (!tipo) continue;
    const r = lerAba(wb.Sheets[aba], tipo); if (!r || !r.linhas.length) continue;
    out.abas.push({ aba, tipo, ...r });
  }
  // base primeiro, depois a ordem da planilha
  out.abas.sort((a, b) => (a.tipo === 'base' ? 0 : 1) - (b.tipo === 'base' ? 0 : 1));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(arq(idx), JSON.stringify(out));
  console.log(`[precificacao] importada ${nomeArq}: ${out.abas.map(a => a.aba + ' ' + a.linhas.length).join(', ')}`);
  return out;
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
  if (!F) F = importar(idx);
  const cm = require('./custos_ml');
  const erp = await cm.custosErp(idx);
  const erpNome = idx === 2 ? 'Tiny' : 'Bling';
  for (const A of F.abas) {
    const R = A.resumo = { linhas: A.linhas.length, iguais: 0, diferentes: 0, semErp: 0 };
    for (const L of A.linhas) {
      const e = custoErp(idx, L, erp, cm);
      if (!e) { L.situacao = 'sem custo no ' + erpNome; R.semErp++; continue; }
      L.custoErp = r2(e.v); L.fonteErp = e.fonte; L.dif = L.custo != null ? r2(e.v - L.custo) : null;
      if (L.custo == null) { L.situacao = 'sem custo na planilha'; R.diferentes++; }
      else if (Math.abs(L.dif) < 0.015) { L.situacao = 'igual'; R.iguais++; }
      else { L.situacao = 'diferente'; R.diferentes++; }
      // margem refeita só trocando o custo (o resto das taxas fica como na planilha)
      if (A.tipo !== 'base' && L.dif != null) {
        if (L.preco > 0 && L.lucro != null) L.margemErp = (L.lucro - L.dif) / L.preco;
        if (L.promo > 0 && L.lucroPromo != null) L.margemPromoErp = (L.lucroPromo - L.dif) / L.promo;
      }
    }
  }
  return { ...F, erp: erpNome, erpItens: Object.keys(erp).length };
}

function pagina(admin) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Precificação</title><style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#1a1a2e}.top{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.top a{color:#ffd60a;font-size:13px}
.box{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:14px 18px;margin:14px auto;max-width:1300px;overflow-x:auto}select,input,button{padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{background:#0d1b2a;color:#fff;border:none;cursor:pointer;font-weight:600}button:disabled{opacity:.5}
.abas{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.aba{background:#f4f5f7;color:#333;border:1px solid #e3e3e3;font-weight:500;padding:7px 12px}.aba.on{background:#0d1b2a;color:#fff}
.aba small{opacity:.75}table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px 7px;border-bottom:1px solid #f1f1f1;text-align:right;white-space:nowrap}th{position:sticky;top:0;background:#fafafa;font-weight:600}
.l{text-align:left;white-space:normal}small{color:#888}.ok{color:#2e7d32}.dif{color:#c62828;font-weight:600}.sem{color:#E65100}.neg{color:#c62828}.cards{display:flex;gap:10px;flex-wrap:wrap}
.card{flex:1;min-width:150px;border:1px solid #eee;border-radius:10px;padding:10px 12px;font-size:13px}.card b{font-size:20px}</style></head><body>
<div class="top"><b>💲 Precificação</b><span style="font-size:12px;opacity:.75">Etapa 1 · planilha importada × custo do ERP</span><span style="flex:1"></span>
<select id="emp" onchange="carregar()"><option value="0">Zagodini</option><option value="1">Com Amor de Mãe</option><option value="2">Lufe</option></select>
<select id="sit" onchange="render()"><option value="dif">Só custos diferentes</option><option value="sem">Sem custo no ERP</option><option value="">Tudo</option></select>
<input id="q" placeholder="Buscar código ou produto" oninput="render()">
${admin ? '<button id="imp" onclick="importar()">⟳ Importar planilha de novo</button>' : ''}<a href="/painel.html">← Painel</a></div>
<div class="box" id="info">Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)</div><div class="box"><div class="abas" id="abas"></div><div id="lista"></div></div>
<script>
let D=null,A=0;const $=id=>document.getElementById(id);const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const brl=v=>v==null?'—':'R$ '+Number(v).toFixed(2).replace('.',',');const pc=v=>v==null||!isFinite(v)?'—':'<span class="'+(v<0.15?'neg':'')+'">'+(v*100).toFixed(1).replace('.',',')+'%</span>';
const dt=s=>s?new Date(s).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
async function carregar(){$('info').textContent='Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)';$('abas').innerHTML='';$('lista').innerHTML='';
 const r=await fetch('/precificacao/dados?emp='+$('emp').value);D=await r.json();if(D.erro){$('info').innerHTML='<span class="dif">'+esc(D.erro)+'</span>';return;}A=0;info();render();}
function info(){const t={l:0,i:0,d:0,s:0};D.abas.forEach(a=>{t.l+=a.resumo.linhas;t.i+=a.resumo.iguais;t.d+=a.resumo.diferentes;t.s+=a.resumo.semErp;});
 $('info').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:10px">Planilha <b>'+esc(D.arquivo)+'</b> (cópia do OneDrive de '+dt(D.planilhaEm)+'), importada em '+dt(D.importadoEm)+'. Custo do ERP: <b>'+D.erp+'</b> ('+D.erpItens+' produtos com custo; kit = soma da composição). A margem "com custo do ERP" refaz o lucro da planilha trocando só o custo.</div>'+
 '<div class="cards"><div class="card">Linhas importadas<br><b>'+t.l+'</b></div><div class="card">Custo igual ao ERP<br><b class="ok">'+t.i+'</b></div><div class="card">Custo diferente<br><b class="dif">'+t.d+'</b></div><div class="card">Sem custo no ERP<br><b class="sem">'+t.s+'</b></div></div>';
 $('abas').innerHTML=D.abas.map((a,i)=>'<button class="aba'+(i===A?' on':'')+'" onclick="A='+i+';render()">'+esc(a.aba)+' <small>'+a.resumo.diferentes+' dif · '+a.resumo.semErp+' sem ERP</small></button>').join('');}
function render(){if(!D||D.erro)return;info();const a=D.abas[A],s=$('sit').value,q=$('q').value.toLowerCase();
 let L=a.linhas.filter(l=>(!s||(s==='dif'?/diferente|sem custo na/.test(l.situacao):/sem custo no/.test(l.situacao)))&&(!q||(l.sku+' '+l.nome).toLowerCase().includes(q)));
 const base=a.tipo==='base';
 $('lista').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:8px">'+L.length+' de '+a.linhas.length+' linhas · colunas de preço lidas: '+esc((a.colunas.precos||[]).join(', ')||'—')+'</div><table><tr><th class="l">Código</th><th class="l">Produto</th><th>Qtd</th><th>Custo planilha</th><th>Custo ERP</th><th>Diferença</th>'+
 (base?'':'<th>Preço</th><th>Margem planilha</th><th>Margem c/ custo ERP</th><th>Promoção</th><th>Margem planilha</th><th>Margem c/ custo ERP</th>')+'</tr>'+
 L.slice(0,2000).map(l=>'<tr><td class="l">'+esc(l.sku)+'<br><small>linha '+l.linha+'</small></td><td class="l">'+esc(l.nome)+'</td><td>'+l.qtd+'</td><td>'+brl(l.custo)+'</td>'+
 '<td>'+(l.custoErp!=null?brl(l.custoErp)+(l.fonteErp&&l.fonteErp!=='item'?'<br><small>'+esc(l.fonteErp)+'</small>':''):'<span class="sem">'+esc(l.situacao)+'</span>')+'</td>'+
 '<td class="'+(l.situacao==='diferente'?'dif':'')+'">'+(l.dif==null?'—':(l.dif>0?'+':'')+brl(l.dif))+'</td>'+
 (base?'':'<td>'+brl(l.preco)+'</td><td>'+pc(l.margem)+'</td><td>'+pc(l.margemErp)+'</td><td>'+brl(l.promo)+'</td><td>'+pc(l.margemPromo)+'</td><td>'+pc(l.margemPromoErp)+'</td>')+'</tr>').join('')+'</table>';}
async function importar(){if(!confirm('Importar de novo a planilha desta empresa? A fotografia atual no painel é substituída.'))return;$('imp').disabled=true;
 const r=await fetch('/precificacao/importar?emp='+$('emp').value,{method:'POST'}).then(r=>r.json());$('imp').disabled=false;if(r.erro)return alert(r.erro);carregar();}
carregar();
</script></body></html>`;
}

function rotas(app) {
  const admin = req => !require('./auth').ativo() || !!req.usuario?.admin;
  app.get('/precificacao', (req, res) => res.send(pagina(admin(req))));
  app.get('/precificacao/dados', async (req, res) => {
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { res.json(await dados(idx)); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.post('/precificacao/importar', (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só o administrador importa a planilha' });
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { const F = importar(idx); delete _cache[idx]; res.json({ ok: true, abas: F.abas.map(a => ({ aba: a.aba, linhas: a.linhas.length })) }); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}
module.exports = { rotas, importar, dados, lerAba, tipoAba };
