/**
 * auth_ml.js — Reautoriza contas do Mercado Livre
 *
 * PASSO 1: node auth_ml.js urls
 *   → Exibe os links de autorização. Abra cada um no navegador e autorize.
 *   → Após autorizar, você será redirecionado para o Google com ?code=XXXX na URL.
 *   → Copie o código de cada conta.
 *
 * PASSO 2: node auth_ml.js salvar Zagodini SEU_CODE_AQUI
 *          node auth_ml.js salvar Mae      SEU_CODE_AQUI
 *          node auth_ml.js salvar Lufe     SEU_CODE_AQUI
 */

const https = require('https');
// Credenciais vêm do .env / variáveis de ambiente (nunca fixas no código)
try { for (const l of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([^#=]+)=(.*)$/); if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch (e) {}
const fs    = require('fs');

const REDIRECT_URI = 'https://www.google.com';

const CONTAS = [
  { nome: 'Zagodini', cid: process.env.ML_ZAGODINI_CID, secret: process.env.ML_ZAGODINI_SECRET },
  { nome: 'Mae',      cid: process.env.ML_MAE_CID,      secret: process.env.ML_MAE_SECRET },
  { nome: 'Lufe',     cid: process.env.ML_LUFE_CID,     secret: process.env.ML_LUFE_SECRET },
];

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadolibre.com',
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ _raw: d }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const cmd = process.argv[2];

if (cmd === 'urls' || !cmd) {
  console.log('\n📋 Links de autorização — abra cada um no navegador:\n');
  for (const c of CONTAS) {
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${c.cid}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=offline_access%20advertising%20read%20write`;
    console.log(`──────────────────────────────────────────────`);
    console.log(`  Conta: ${c.nome}`);
    console.log(`  ${url}\n`);
  }
  console.log('Após autorizar cada conta, você será redirecionado para o Google.');
  console.log('Copie o valor de "code" da URL e rode:\n');
  console.log('  node auth_ml.js salvar Zagodini SEU_CODE');
  console.log('  node auth_ml.js salvar Mae      SEU_CODE');
  console.log('  node auth_ml.js salvar Lufe     SEU_CODE\n');

} else if (cmd === 'salvar') {
  const nomeConta = process.argv[3];
  const code      = process.argv[4];

  if (!nomeConta || !code) {
    console.log('Uso: node auth_ml.js salvar NOME_CONTA CODE');
    process.exit(1);
  }

  const conta = CONTAS.find(c => c.nome.toLowerCase() === nomeConta.toLowerCase());
  if (!conta) {
    console.log(`Conta "${nomeConta}" não encontrada. Use: Zagodini, Mae ou Lufe`);
    process.exit(1);
  }

  console.log(`\n🔄 Trocando code por token para ${conta.nome}...`);

  const body = `grant_type=authorization_code&client_id=${conta.cid}&client_secret=${conta.secret}&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  post('/oauth/token', body).then(r => {
    if (!r.access_token) {
      console.log('❌ Erro:', JSON.stringify(r, null, 2));
      process.exit(1);
    }

    const tokens = JSON.parse(fs.readFileSync(require('path').join(require('./dados'), 'tokens.json'), 'utf8'));
    tokens[conta.nome] = { token: r.access_token, refresh: r.refresh_token };
    fs.writeFileSync(require('path').join(require('./dados'), 'tokens.json'), JSON.stringify(tokens, null, 2));

    console.log(`✅ ${conta.nome}: token salvo com sucesso!`);
    console.log(`   access_token:  ${r.access_token.slice(0, 20)}...`);
    console.log(`   refresh_token: ${r.refresh_token.slice(0, 20)}...\n`);
  }).catch(e => {
    console.error('Erro:', e.message);
    process.exit(1);
  });

} else {
  console.log('Comandos: node auth_ml.js urls | node auth_ml.js salvar CONTA CODE');
}
