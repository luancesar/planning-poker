// Browser smoke test: node tests/e2e-smoke.mjs [baseUrl] [screenshotDir]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:3000';
const out = process.argv[3] ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const errors = [];
const page = async (viewport = { width: 1440, height: 900 }, scheme = 'light') => {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return p;
};

const fac = await page();
await fac.goto(base);
await fac.screenshot({ path: `${out}/1-home.png` });
await fac.getByLabel('Nome da sala').fill('Refinamento Sprint 42');
await fac.getByLabel('Seu apelido').fill('Luan');
await fac.getByRole('button', { name: 'Criar sala' }).click();
await fac.waitForURL(/\/r\/[A-Z0-9]{6}$/);
const code = fac.url().split('/').pop();
await fac.getByText('1 online').waitFor();

await fac.getByRole('button', { name: '+ Vários' }).click();
await fac.getByLabel('Cole a lista').fill('Login com Google\nTela de checkout com Pix\nBusca com filtros');
await fac.getByRole('button', { name: /Adicionar 3 itens/ }).click();
await fac.getByText('0 de 3 estimados').waitFor();

const ana = await page();
await ana.goto(`${base}/r/${code}`);
await ana.getByLabel('Seu apelido').fill('Ana');
await ana.getByRole('button', { name: 'Entrar na sala' }).click();
const bia = await page({ width: 390, height: 844 }, 'dark');
await bia.goto(`${base}/r/${code}`);
await bia.getByLabel('Seu apelido').fill('Bia');
await bia.getByRole('button', { name: 'Entrar na sala' }).click();
await fac.getByText('3 online').waitFor();
await ana.getByText('Aguardando um facilitador liberar seu voto').waitFor();
await fac.getByText('2 pessoas pediram para votar').waitFor();
await fac.screenshot({ path: `${out}/2a-approval.png` });
await fac.getByRole('button', { name: 'Aprovar todos' }).click();
await ana.getByText('Aguardando um facilitador liberar seu voto').waitFor({ state: 'hidden' });

await fac.getByRole('button', { name: 'Votar', exact: true }).first().click();
await ana.getByText('Votaram 0 de 3').waitFor();
await ana.getByRole('group', { name: 'Seu voto' }).getByRole('button', { name: '5', exact: true }).click();
await fac.getByText('Votaram 1 de 3').waitFor();
await bia.getByRole('group', { name: 'Seu voto' }).getByRole('button', { name: '13', exact: true }).click();
await fac.getByText('Votaram 2 de 3').waitFor();
await fac.screenshot({ path: `${out}/2-voting-hidden.png` });
await fac.getByRole('group', { name: 'Seu voto' }).getByRole('button', { name: '3', exact: true }).click();
await fac.getByText('Votaram 3 de 3').waitFor();
if (await ana.getByRole('button', { name: 'Revelar votos' }).count()) throw new Error('voter should not see the reveal button');
await fac.getByRole('button', { name: 'Revelar votos' }).click();
await fac.getByText('Votos revelados').waitFor();
await ana.getByText('Divergência: ouçam os extremos').waitFor();

await bia.getByRole('button', { name: /Comentários/ }).click();
await bia.getByLabel('Novo comentário').fill('Precisa integrar com o SSO legado, @Ana viu isso?');
await bia.getByLabel('Novo comentário').press('Enter');
await fac.getByText('votou 13').waitFor();
await fac.screenshot({ path: `${out}/3-revealed.png` });
await bia.screenshot({ path: `${out}/4-mobile-dark-comments.png` });
await bia.getByRole('button', { name: 'Votação' }).click();
await bia.screenshot({ path: `${out}/5-mobile-dark-voting.png`, fullPage: true });

await fac.getByRole('button', { name: 'Salvar e próximo' }).click();
await ana.getByText('Item 2 de 3').waitFor();
await fac.getByText('1 de 3 estimados').waitFor();
await fac.screenshot({ path: `${out}/6-next-item.png` });

const summary = await fac.context().newPage();
await summary.goto(`${base}/r/${code}/resumo`);
await summary.getByText('Rodada 1:').waitFor();
await summary.screenshot({ path: `${out}/7-summary.png`, fullPage: true });

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
console.log('OK room', code);
await browser.close();
