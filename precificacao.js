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
  if (!F || F.versao !== 6) F = importar(idx);   // versão 3: imposto/insumos e colunas de lucro por bloco (cheio × promoção)
  const cm = require('./custos_ml');
  const erp = await cm.custosErp(idx);
  const erpNome = idx === 2 ? 'Tiny' : 'Bling';
  const ce = require('./config_empresas').porMlIdx(idx) || {};
  const cfg = { imposto: ce.imposto ?? 0, insumos: ce.embalagem ?? 0, meta: idx === 2 ? 0.20 : 0.15 };
  const kits = cm.kits(idx);
  for (const A of F.abas) {
    const R = A.resumo = { linhas: A.linhas.length, iguais: 0, diferentes: 0, semErp: 0 };
    for (const L of A.linhas) {
      const e = custoErp(idx, L, erp, cm);
      if (!e) { L.situacao = 'sem custo no ' + erpNome; R.semErp++; L.kit = !!(cm.kits(idx)[L.sku]?.length) || /-/.test(L.sku) && L.qtd > 1; }
      else { L.custoErp = r2(e.v); L.fonteErp = e.fonte; L.kit = e.fonte !== 'item'; L.dif = L.custo != null ? r2(e.v - L.custo) : null; }
      if (!e) {}
      else if (L.custo == null) { L.situacao = 'sem custo na planilha'; R.diferentes++; }
      else if (Math.abs(L.dif) < 0.015) { L.situacao = 'igual'; R.iguais++; }
      else { L.situacao = 'diferente'; R.diferentes++; }
      // Margem do painel: custo do ERP + imposto e insumos da empresa (Conta); tarifas do canal (comissão, taxa fixa,
      // frete, custo fixo) ficam como estão na planilha. Preço mínimo p/ a meta: tarifas proporcionais ao preço (aproximado).
      if (A.tipo !== 'base') {
        const conta = (preco, lucro, imp, ins) => {
          if (!(preco > 0) || lucro == null || L.custo == null) return null;
          const taxas = preco - lucro - L.custo - (imp || 0) - (ins || 0);
          const custo = L.custoErp ?? L.custo, lucroP = preco - custo - taxas - cfg.imposto * preco - cfg.insumos;
          const den = 1 - taxas / preco - cfg.imposto - cfg.meta;
          return { lucro: r2(lucroP), margem: lucroP / preco, precoMeta: den > 0.05 ? Math.ceil((custo + cfg.insumos) / den) - 0.01 : null };
        };
        const a = conta(L.preco, L.lucro, L.imp, L.ins), b = conta(L.promo, L.lucroPromo, L.impPromo, L.insPromo);
        if (a) { L.lucroPainel = a.lucro; L.margemPainel = a.margem; L.precoMeta = a.precoMeta; }
        if (b) { L.lucroPromoPainel = b.lucro; L.margemPromoPainel = b.margem; L.precoMetaPromo = b.precoMeta; }
      }
      // margem refeita só trocando o custo (o resto das taxas fica como na planilha)
      if (A.tipo !== 'base' && L.dif != null) {
        if (L.preco > 0 && L.lucro != null) L.margemErp = (L.lucro - L.dif) / L.preco;
        if (L.promo > 0 && L.lucroPromo != null) L.margemPromoErp = (L.lucroPromo - L.dif) / L.promo;
      }
    }
  }
  return { ...F, erp: erpNome, erpItens: Object.keys(erp).length, cfg };
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
.ed{cursor:pointer;color:#1565c0;margin-left:4px;font-size:12px}.card{flex:1;min-width:150px;border:1px solid #eee;border-radius:10px;padding:10px 12px;font-size:13px}.card b{font-size:20px}</style></head><body>
<div class="top"><b>💲 Precificação</b><span style="font-size:12px;opacity:.75">planilha importada × custo do ERP · margens do painel</span><span style="flex:1"></span>
<select id="emp" onchange="carregar()"><option value="0">Zagodini</option><option value="1">Com Amor de Mãe</option><option value="2">Lufe</option></select>
<select id="sit" onchange="render()"><option value="dif">Só custos diferentes</option><option value="sem">Sem custo no ERP</option><option value="">Tudo</option></select>
<input id="q" placeholder="Buscar código ou produto" oninput="render()">
${admin ? '<button id="imp" onclick="importar()">⟳ Importar planilha de novo</button>' : ''}<a href="/painel.html">← Painel</a></div>
<div class="box" id="info">Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)</div><div class="box"><div class="abas" id="abas"></div><div id="lista"></div></div>
<script>
let D=null,A=0;const $=id=>document.getElementById(id);const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const brl=v=>v==null?'—':'R$ '+Number(v).toFixed(2).replace('.',',');const pc=v=>v==null||!isFinite(v)?'—':'<span class="mg '+(v<0.05?'m0':v<0.10?'m1':v<0.15?'m2':'m3')+'">'+(v*100).toFixed(1).replace('.',',')+'%</span>';
const dt=s=>s?new Date(s).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
async function carregar(){$('info').textContent='Carregando… (a primeira leitura dos custos do ERP pode levar 1–2 min)';$('abas').innerHTML='';$('lista').innerHTML='';
 const r=await fetch('/precificacao/dados?emp='+$('emp').value);D=await r.json();if(D.erro){$('info').innerHTML='<span class="dif">'+esc(D.erro)+'</span>';return;}A=0;info();render();}
function info(){const t={l:0,i:0,d:0,s:0};D.abas.forEach(a=>{t.l+=a.resumo.linhas;t.i+=a.resumo.iguais;t.d+=a.resumo.diferentes;t.s+=a.resumo.semErp;});
 $('info').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:10px">Planilha <b>'+esc(D.arquivo)+'</b> (cópia do OneDrive de '+dt(D.planilhaEm)+'), importada em '+dt(D.importadoEm)+'. Custo do ERP: <b>'+D.erp+'</b> ('+D.erpItens+' produtos com custo; kit = soma da composição). <b>Margem do painel</b> = custo do ERP + imposto ('+(D.cfg.imposto*100).toFixed(1).replace('.',',')+'%) e insumos (R$ '+D.cfg.insumos.toFixed(2).replace('.',',')+') da empresa, com as tarifas do canal como estão na planilha. <b>Preço p/ meta</b> = preço mínimo para '+Math.round(D.cfg.meta*100)+'% de margem (aproximado). Cores: <span class="mg m0">&lt;5%</span> <span class="mg m1">5–9,99%</span> <span class="mg m2">10–14,99%</span> <span class="mg m3">15%+</span>. ✎ altera o custo direto no '+D.erp+' (kits não: o custo deles é a soma dos itens).</div>'+
 '<div class="cards"><div class="card">Linhas importadas<br><b>'+t.l+'</b></div><div class="card">Custo igual ao ERP<br><b class="ok">'+t.i+'</b></div><div class="card">Custo diferente<br><b class="dif">'+t.d+'</b></div><div class="card">Sem custo no ERP<br><b class="sem">'+t.s+'</b></div></div>';
 $('abas').innerHTML=D.abas.map((a,i)=>'<button class="aba'+(i===A?' on':'')+'" onclick="A='+i+';render()">'+esc(a.aba)+' <small>'+a.resumo.diferentes+' dif · '+a.resumo.semErp+' sem ERP</small></button>').join('');}
function render(){if(!D||D.erro)return;info();const a=D.abas[A],s=$('sit').value,q=$('q').value.toLowerCase();
 let L=a.linhas.filter(l=>(!s||(s==='dif'?/diferente|sem custo na/.test(l.situacao):/sem custo no/.test(l.situacao)))&&(!q||(l.sku+' '+l.nome).toLowerCase().includes(q)));
 const base=a.tipo==='base';
 $('lista').innerHTML='<div style="font-size:13px;color:#555;margin-bottom:8px">'+L.length+' de '+a.linhas.length+' linhas · colunas de preço lidas: '+esc((a.colunas.precos||[]).join(', ')||'—')+'</div><table><tr><th class="l">Código</th><th class="l">Produto</th><th>Qtd</th><th>Custo planilha</th><th>Custo ERP</th><th>Diferença</th>'+
 (base?'':'<th>Preço</th><th>Margem planilha</th><th>Margem painel</th><th>Preço p/ meta</th><th>Promoção</th><th>Margem planilha</th><th>Margem painel</th><th>Preço p/ meta</th>')+'</tr>'+
 L.slice(0,2000).map(l=>'<tr><td class="l">'+esc(l.sku)+'<br><small>linha '+l.linha+'</small></td><td class="l">'+esc(l.nome)+'</td><td>'+l.qtd+'</td><td>'+brl(l.custo)+'</td>'+
 '<td>'+(l.custoErp!=null?brl(l.custoErp)+(l.fonteErp&&l.fonteErp!=='item'?'<br><small>'+esc(l.fonteErp)+'</small>':''):'<span class="sem">'+esc(l.situacao)+'</span>')+(!l.kit?'<span class="ed" title="Alterar o custo no '+D.erp+'" onclick="editar(\\''+esc(l.sku)+'\\','+(l.custoErp??l.custo??0)+','+l.qtd+')">✎</span>':'')+'</td>'+
 '<td class="'+(l.situacao==='diferente'?'dif':'')+'">'+(l.dif==null?'—':(l.dif>0?'+':'')+brl(l.dif))+'</td>'+
 (base?'':'<td>'+brl(l.preco)+'</td><td>'+pc(l.margem)+'</td><td>'+pc(l.margemPainel)+'</td><td>'+brl(l.precoMeta)+'</td><td>'+brl(l.promo)+'</td><td>'+pc(l.margemPromo)+'</td><td>'+pc(l.margemPromoPainel)+'</td><td>'+brl(l.precoMetaPromo)+'</td>')+'</tr>').join('')+'</table>';}
async function editar(sku,atual,qtd){
 if(qtd>1&&!confirm('Esta linha é de '+qtd+' unidades. O custo alterado é o do código '+sku+' no '+D.erp+'. Continuar?'))return;
 const v=prompt('Novo custo de '+sku+' no '+D.erp+' (R$):',String(atual).replace('.',','));if(v==null)return;
 const n=parseFloat(String(v).replace(',','.'));if(!(n>0))return alert('Valor inválido');
 const r=await fetch('/precificacao/custo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emp:$('emp').value,sku,custo:n})}).then(r=>r.json());
 if(r.erro)return alert('Não gravou: '+r.erro);
 const aba=A;const x=await fetch('/precificacao/dados?emp='+$('emp').value);D=await x.json();A=aba;render();}
async function importar(){if(!confirm('Importar de novo a planilha desta empresa? A fotografia atual no painel é substituída.'))return;$('imp').disabled=true;
 const r=await fetch('/precificacao/importar?emp='+$('emp').value,{method:'POST'}).then(r=>r.json());$('imp').disabled=false;if(r.erro)return alert(r.erro);carregar();}
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
  delete _cache[idx];
  let L = []; try { L = JSON.parse(fs.readFileSync(ARQ_ED)); } catch (e) {}
  L.push({ quando: new Date().toISOString(), quem, emp: idx, sku, de, para: custo });
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(ARQ_ED, JSON.stringify(L.slice(-5000)));
  console.log(`[precificacao] custo ${EMP[idx].nome} ${sku}: ${de} → ${custo} (${quem})`);
  return { sku, de, para: custo };
}

function rotas(app) {
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
  app.get('/precificacao/edicoes', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(ARQ_ED)).slice(-300).reverse()); } catch (e) { res.json([]); } });
  app.post('/precificacao/importar', (req, res) => {
    if (!admin(req)) return res.status(403).json({ erro: 'só o administrador importa a planilha' });
    const idx = parseInt(req.query.emp); if (!EMP[idx]) return res.status(400).json({ erro: 'empresa inválida' });
    try { const F = importar(idx); delete _cache[idx]; res.json({ ok: true, abas: F.abas.map(a => ({ aba: a.aba, linhas: a.linhas.length })) }); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}
module.exports = { rotas, importar, dados, lerAba, tipoAba };
