/**
 * ads.js — Diagnóstico + Relatório de ADS do Mercado Livre
 * Uso: node ads.js
 */

const https = require('https');
const fs = require('fs');

const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
const CONTAS = [
  { nome: 'Zagodini', token: tokens.Zagodini?.token },
  { nome: 'Mae',      token: tokens.Mae?.token },
  { nome: 'Lufe',     token: tokens.Lufe?.token },
];

function get(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://api.mercadolibre.com' + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function moeda(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function testar(label, path, token, verbose = false) {
  const r = await get(path, token);
  const ok = r.status >= 200 && r.status < 300;
  const resumo = ok
    ? JSON.stringify(r.body).slice(0, 150)
    : (r.body?.message || r.body?.error || JSON.stringify(r.body).slice(0, 100));
  console.log(`  [${r.status}] ${label}`);
  if (ok) console.log(`         → ${resumo}`);
  else if (verbose) console.log(`         ✗ ${resumo}`);
  return ok ? r.body : null;
}

async function processarConta(conta) {
  if (!conta.token) { console.log(`\n❌ ${conta.nome}: sem token`); return; }

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  📦 CONTA: ${conta.nome}`);
  console.log(`${'═'.repeat(65)}`);

  const me = (await get('/users/me', conta.token)).body;
  if (me.error) { console.log(`  ❌ Token inválido: ${me.message}`); return; }
  const uid = me.id;
  console.log(`  Usuário: ${me.nickname} (ID: ${uid})\n`);

  const hoje = new Date().toISOString().split('T')[0];
  const inicio = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];

  // ── Testa todos os endpoints conhecidos de ADS ──
  console.log('  🔍 Testando endpoints de ADS:\n');

  const endpoints = [
    ['Campanhas',                `/advertising/advertisers/${uid}/product_ads/campaigns`],
    ['Ad Sets',                  `/advertising/advertisers/${uid}/product_ads/ad_sets`],
    ['Ads',                      `/advertising/advertisers/${uid}/product_ads/ads`],
    ['Report custos',            `/advertising/advertisers/${uid}/product_ads/reports/ads_costs?date_from=${inicio}&date_to=${hoje}`],
    ['Report performance',       `/advertising/advertisers/${uid}/product_ads/reports/ads_performance?date_from=${inicio}&date_to=${hoje}`],
  ];

  const resultados = {};
  for (const [label, path] of endpoints) {
    const body = await testar(label, path, conta.token, true);
    if (body) resultados[label] = body;
  }

  // ── Exibe resultados dos que funcionaram ──
  if (Object.keys(resultados).length === 0) {
    console.log('\n  ⚠️  Nenhum endpoint de ADS retornou dados.');
    console.log('      Possível causa: o App não tem o escopo "advertising" autorizado.');
    console.log('      Acesse: https://developers.mercadolivre.com.br → seu App → Permissões');
    console.log('      e adicione o escopo "advertising" (publicidade).');
    return;
  }

  console.log('\n  ✅ Dados encontrados:\n');

  // Campanhas
  const campBody = resultados['Campanhas (v1)'] || resultados['Campanhas (app_version=v2)'];
  if (campBody) {
    const lista = campBody.results || (Array.isArray(campBody) ? campBody : []);
    console.log(`  📣 Campanhas (${lista.length}):`);
    for (const c of lista.slice(0, 10)) {
      console.log(`    • ${(c.name || c.id || '-').padEnd(35)} status: ${c.status || '-'}  budget: ${moeda(c.daily_budget ?? c.budget ?? 0)}`);
    }
  }

  // Report de custos
  const rep = resultados['Report ads_costs'] || resultados['Report product_ads'];
  if (rep) {
    console.log(`\n  📊 Gastos ADS (${inicio} → ${hoje}):`);
    if (rep.total_cost   != null) console.log(`    Gasto total:        ${moeda(rep.total_cost)}`);
    if (rep.total_clicks != null) console.log(`    Cliques:            ${rep.total_clicks}`);
    if (rep.total_prints != null) console.log(`    Impressões:         ${rep.total_prints}`);
    if (rep.total_orders != null) console.log(`    Pedidos via ADS:    ${rep.total_orders}`);
    if (rep.total_revenue!= null) console.log(`    Receita via ADS:    ${moeda(rep.total_revenue)}`);

    const dias = rep.daily_details || rep.results || [];
    if (dias.length) {
      console.log(`\n  📅 Últimos ${Math.min(7, dias.length)} dias:`);
      for (const d of dias.slice(-7)) {
        console.log(`    ${d.date||d.day||'-'}  gasto: ${moeda(d.cost||d.total_cost||0)}  cliques: ${d.clicks||d.total_clicks||0}`);
      }
    }
  }
}

async function main() {
  console.log('\n🚀 ADS — Mercado Livre');
  console.log(`   ${new Date().toLocaleString('pt-BR')}\n`);
  for (const conta of CONTAS) await processarConta(conta);
  console.log(`\n${'═'.repeat(65)}\n`);
}

main().catch(e => { console.error('Erro:', e.message); process.exit(1); });
