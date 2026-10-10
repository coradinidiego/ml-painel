/**
 * Shopee Boost Bot - Roda no servidor via Chrome DevTools Protocol
 * Não precisa de nenhuma aba visível. Chrome só precisa estar aberto.
 *
 * PRÉ-REQUISITO (uma vez só):
 *   Fechar o Chrome e reabrir com:
 *   open -a "Google Chrome" --args --remote-debugging-port=9222
 *
 * Depois abra as 3 abas do seller.shopee.com.br nos 3 perfis normalmente.
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const CDP_PORT    = 9222;
const SHOPEE_URL  = 'seller.shopee.com.br/portal/product/list';
const TOKEN       = process.env.TELEGRAM_TOKEN;
const CHAT_IDS    = (process.env.TELEGRAM_CHAT_IDS || '').split(',').filter(Boolean);
const STATE_FILE  = path.join(require('./dados'), 'shopee_boost_state.json');
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutos

// ─── Telegram ────────────────────────────────────────────────────────────────

function sendTelegram(msg) {
  return Promise.all(CHAT_IDS.map(chatId => new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); resolve(); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  })));
}

// ─── Estado (posição por conta) ───────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── CDP ─────────────────────────────────────────────────────────────────────

function getCDPTabs() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${CDP_PORT}/json`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Resposta inválida do CDP')); }
      });
    });
    req.on('error', () => reject(new Error(
      `Chrome não está acessível na porta ${CDP_PORT}.\n` +
      `Feche o Chrome e reabra com:\n` +
      `open -a "Google Chrome" --args --remote-debugging-port=9222`
    )));
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('CDP timeout')); });
  });
}

function executeInTab(wsUrl, script) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgId = Date.now();
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); reject(new Error('CDP execute timeout')); }
    }, 30000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression: script, awaitPromise: true, returnByValue: true }
      }));
    });

    ws.addEventListener('message', event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === msgId) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          if (msg.error) return reject(new Error(msg.error.message));
          resolve(msg.result?.result?.value);
        }
      } catch {}
    });

    ws.addEventListener('error', err => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
    });
  });
}

// ─── Script de boost (injetado nas abas) ─────────────────────────────────────

function buildBoostScript(startIndex) {
  return `
(async function() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function scrollAndLoad() {
    let last = 0;
    for (let i = 0; i < 8; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);
      const c = Array.from(document.querySelectorAll('button,span')).filter(e => e.textContent.trim()==='Mais').length;
      if (c === last && i > 2) break;
      last = c;
    }
    window.scrollTo(0, 0);
    await sleep(500);
    return last;
  }

  await scrollAndLoad();
  document.body.click();
  await sleep(300);

  const getMais = () => Array.from(document.querySelectorAll('button,span')).filter(e => e.textContent.trim()==='Mais');
  const total   = getMais().length;

  let idx = ${startIndex};
  if (idx >= total) idx = 0;

  const boosted = [];
  let slotsLlenos = false;

  while (idx < total) {
    const all = getMais();
    if (idx >= all.length) break;

    all[idx].scrollIntoView({ behavior:'smooth', block:'center' });
    await sleep(500);
    all[idx].click();
    await sleep(600);

    const imp = Array.from(document.querySelectorAll('li')).find(li => li.textContent.trim().includes('Impulsionar Agora'));

    if (!imp) { document.body.click(); await sleep(300); idx++; continue; }

    if (imp.classList.contains('disabled')) {
      document.body.click(); await sleep(300);
      slotsLlenos = true; break;
    }

    // Pegar nome do produto ANTES de clicar
    let nomeProduto = 'Produto ' + (idx+1);
    try {
      const row = all[idx].closest('tr') || all[idx].closest('[class*="item"]') || all[idx].closest('[class*="row"]');
      if (row) {
        const spans = Array.from(row.querySelectorAll('span,div')).filter(s =>
          s.children.length === 0 &&
          s.textContent.trim().length > 15 &&
          s.textContent.trim().length < 100 &&
          !s.textContent.includes('R$') &&
          !s.textContent.includes('Mais') &&
          !s.textContent.includes('Editar') &&
          !s.textContent.includes('SKU') &&
          !s.textContent.includes('ID')
        );
        if (spans.length > 0) nomeProduto = spans[0].textContent.trim().substring(0, 60);
      }
    } catch {}

    imp.click();
    boosted.push({ idx: idx+1, nome: nomeProduto });
    await sleep(1000);
    document.body.click();
    await sleep(400);
    idx++;
  }

  // Nome da conta
  let conta = 'Conta desconhecida';
  try {
    const el = document.querySelector('[class*="shop-name"],[class*="shopName"],[class*="account-name"]');
    if (el) conta = el.textContent.trim();
    else {
      const titleMatch = document.title.match(/^(.+?) [-|]/);
      if (titleMatch) conta = titleMatch[1].trim();
    }
  } catch {}

  return JSON.stringify({ conta, boosted, slotsLlenos, nextIdx: idx >= total ? 0 : idx, total });
})()
`;
}

// ─── Loop principal ───────────────────────────────────────────────────────────

async function runBoostCycle() {
  let tabs;
  try {
    tabs = await getCDPTabs();
  } catch (err) {
    console.error('[Boost] ' + err.message);
    return;
  }

  const shopeeTabs = tabs.filter(t => t.url && t.url.includes(SHOPEE_URL) && t.webSocketDebuggerUrl);

  if (shopeeTabs.length === 0) {
    console.log('[Boost] Nenhuma aba do Shopee encontrada. Abra seller.shopee.com.br em cada perfil.');
    return;
  }

  console.log(`[Boost] ${shopeeTabs.length} conta(s) encontrada(s)`);
  const state = loadState();

  for (const tab of shopeeTabs) {
    const tabKey = tab.id;
    const startIndex = state[tabKey] || 0;

    try {
      const raw = await executeInTab(tab.webSocketDebuggerUrl, buildBoostScript(startIndex));
      if (!raw) continue;
      const result = JSON.parse(raw);

      // Salvar posição
      state[tabKey] = result.nextIdx;
      saveState(state);

      console.log(`[Boost] ${result.conta}: ${result.boosted.length} impulsionados (próx: ${result.nextIdx}/${result.total})`);

      if (result.boosted.length > 0) {
        const lista = result.boosted.map(p => `• #${p.idx}: ${p.nome}`).join('\n');
        await sendTelegram(
          `🚀 <b>Shopee Boost Bot</b>\n🏪 <b>${result.conta}</b>\n✅ ${result.boosted.length} produto(s) impulsionado(s):\n\n${lista}`
        );
      }
    } catch (err) {
      console.error(`[Boost] Erro na conta ${tab.title}: ${err.message}`);
    }
  }
}

// ─── Inicialização ────────────────────────────────────────────────────────────

let boostTimer = null;

function start() {
  console.log('[Boost] Bot iniciado. Verificando a cada 2 minutos.');
  runBoostCycle(); // Rodar imediatamente
  boostTimer = setInterval(runBoostCycle, CHECK_INTERVAL);
}

function stop() {
  if (boostTimer) { clearInterval(boostTimer); boostTimer = null; }
  console.log('[Boost] Bot parado.');
}

module.exports = { start, stop };
