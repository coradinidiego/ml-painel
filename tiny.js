/**
 * Tiny ERP - API v2 (token) — conta LUFE
 *
 * Uso (no Terminal, dentro de ~/ml-painel):
 *   node tiny.js teste                      -> valida o token (info da conta)
 *   node tiny.js 2026-09-01 2026-09-30      -> baixa pedidos + itens + custos do período
 *   node tiny.js                            -> mês anterior completo
 *   node tiny.js receber 2026-09-01 2026-09-30 -> contas a receber do período
 *
 * Saída: apuracao_cache/tiny_lufe_<ini>_<fim>.json
 */
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const DATA  = require('./dados');

// .env manual (mesmo esquema do server.js)
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (e) {}

const TOKEN = (process.env.TINY_LUFE_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const BASE  = 'https://api.tiny.com.br/api2';
const PAUSA = 1100; // ms entre chamadas (limite da API por minuto)
const delay = ms => new Promise(r => setTimeout(r, ms));

const isoToBr = iso => iso.split('-').reverse().join('/');
const num = v => { const n = parseFloat(String(v ?? '0').replace(',', '.')); return isNaN(n) ? 0 : n; };

async function chamar(endpoint, params = {}, tentativas = 6) {
  if (!TOKEN) throw new Error('TINY_LUFE_TOKEN não definido no .env');
  for (let t = 0; t < tentativas; t++) {
    let r;
    try {
      r = await axios.post(`${BASE}/${endpoint}`,
        new URLSearchParams({ token: TOKEN, formato: 'json', ...params }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
    } catch (e) {
      if (t < tentativas - 1) { await delay(5000 * (t + 1)); continue; }
      throw e;
    }
    const ret = r.data?.retorno || {};
    if (ret.status === 'OK') return ret;
    const cod = String(ret.codigo_erro || '');
    const msg = (ret.erros || []).map(x => x.erro || JSON.stringify(x)).join('; ');
    if (cod === '20') return { ...ret, vazio: true };             // consulta sem registros
    if (cod === '6' && t < tentativas - 1) {                       // API bloqueada por excesso de acessos
      const espera = 15000 * Math.pow(2, t);
      console.warn(`[tiny] limite de acessos — aguardando ${espera / 1000}s`);
      await delay(espera); continue;
    }
    throw new Error(`Tiny ${endpoint}: erro ${cod} ${msg}`);
  }
}

async function listarPedidos(ini, fim) {
  const todos = [];
  let pagina = 1, total = 1;
  do {
    const ret = await chamar('pedidos.pesquisa.php', { dataInicial: isoToBr(ini), dataFinal: isoToBr(fim), pagina });
    if (ret.vazio) break;
    total = parseInt(ret.numero_paginas || 1);
    for (const p of (ret.pedidos || [])) todos.push(p.pedido);
    console.log(`[tiny] lista pág ${pagina}/${total} — ${todos.length} pedidos`);
    pagina++;
    await delay(PAUSA);
  } while (pagina <= total);
  return todos;
}

async function obterPedido(id) {
  const ret = await chamar('pedido.obter.php', { id });
  return ret.pedido;
}

async function custosPorSku() {
  const mapa = {};
  let pagina = 1, total = 1;
  do {
    const ret = await chamar('produtos.pesquisa.php', { pesquisa: '', pagina });
    if (ret.vazio) break;
    total = parseInt(ret.numero_paginas || 1);
    for (const x of (ret.produtos || [])) {
      const p = x.produto;
      if (p?.codigo) mapa[String(p.codigo).trim()] = {
        nome: p.nome,
        precoCusto: num(p.preco_custo),
        precoCustoMedio: num(p.preco_custo_medio),
        preco: num(p.preco),
      };
    }
    console.log(`[tiny] produtos pág ${pagina}/${total}`);
    pagina++;
    await delay(PAUSA);
  } while (pagina <= total);
  return mapa;
}


async function contasReceber(ini, fim) {
  const lista = [];
  let pagina = 1, total = 1;
  do {
    const ret = await chamar('contas.receber.pesquisa.php', { data_ini_emissao: isoToBr(ini), data_fim_emissao: isoToBr(fim), pagina });
    if (ret.vazio) break;
    total = parseInt(ret.numero_paginas || 1);
    for (const c of (ret.contas || [])) lista.push(c.conta);
    console.log(`[tiny] contas a receber pág ${pagina}/${total} — ${lista.length}`);
    pagina++;
    await delay(PAUSA);
  } while (pagina <= total);
  // detalhe das 5 primeiras para ver quais campos existem
  const amostra = [];
  for (const c of lista.slice(0, 5)) {
    try { amostra.push((await chamar('conta.receber.obter.php', { id: c.id })).conta); } catch (e) { amostra.push({ id: c.id, _erro: e.message }); }
    await delay(PAUSA);
  }
  return { lista, amostra };
}

async function main() {
  const [a, b] = process.argv.slice(2);

  if (a === 'receber') {
    const ini = b, fim = process.argv[4] || b;
    const r = await contasReceber(ini, fim);
    const arq = path.join(DATA, 'apuracao_cache', `tiny_lufe_receber_${ini}_${fim}.json`);
    fs.writeFileSync(arq, JSON.stringify({ geradoEm: new Date().toISOString(), ini, fim, ...r }, null, 1));
    console.log(`\n✔ ${r.lista.length} contas a receber salvas em ${arq}`);
    return;
  }

  if (a === 'teste') {
    const ret = await chamar('info.php');
    console.log('Token OK. Conta:', JSON.stringify(ret.conta || ret, null, 2));
    return;
  }

  let ini = a, fim = b;
  if (!ini) {
    const h = new Date(); const p = new Date(h.getFullYear(), h.getMonth() - 1, 1); const u = new Date(h.getFullYear(), h.getMonth(), 0);
    const f = d => d.toISOString().slice(0, 10); ini = f(p); fim = f(u);
  }
  if (!fim) fim = ini;
  console.log(`[tiny] período ${ini} a ${fim}`);

  const lista = await listarPedidos(ini, fim);
  const pedidos = [];
  for (let i = 0; i < lista.length; i++) {
    try { pedidos.push(await obterPedido(lista[i].id)); }
    catch (e) { console.warn(`[tiny] falhou pedido ${lista[i].id}: ${e.message}`); pedidos.push({ id: lista[i].id, _erro: e.message, _resumo: lista[i] }); }
    if ((i + 1) % 10 === 0 || i + 1 === lista.length) console.log(`[tiny] detalhes ${i + 1}/${lista.length}`);
    await delay(PAUSA);
  }

  const custos = await custosPorSku();

  const dir = path.join(DATA, 'apuracao_cache');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `tiny_lufe_${ini}_${fim}.json`);
  fs.writeFileSync(arq, JSON.stringify({ geradoEm: new Date().toISOString(), conta: 'Lufe', ini, fim, pedidos, custos }, null, 1));
  console.log(`\n✔ ${pedidos.length} pedidos e ${Object.keys(custos).length} produtos salvos em ${arq}`);
}

if (require.main === module) main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
module.exports = { chamar, listarPedidos, obterPedido, custosPorSku };
