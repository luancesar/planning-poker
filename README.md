# Planning Poker

SaaS de Planning Poker: o time entra numa sala pelo link ou por um código de 6 letras, vota com cards (votos ocultos até a revelação) e comenta cada item. Este repositório é o **MVP** descrito na spec (RF-01 a RF-06).

## O que já funciona

- **Salas**: criar com nome, deck e opções; entrar como convidado só com apelido; senha opcional; sala persistente (expira após 90 dias sem uso) ou temporária (24 h); limite de 50 participantes.
- **Decks**: Fibonacci, Fibonacci modificado, T-shirt, potências de 2 e personalizado (até 20 cards). `?` e `☕` não entram na média.
- **Itens**: adicionar um a um, colar uma lista, importar CSV (título, descrição, link); editar, excluir, reordenar arrastando, pular e reabrir.
- **Votação em tempo real**: o servidor é a fonte da verdade e nunca envia o valor de um voto antes da revelação. Revelação manual, automática (todos os votantes online votaram) ou por timer (30 s a 5 min); revotar; estimativa final com sugestão automática; "salvar e próximo".
- **Resultados**: distribuição, média, mediana, moda e indicador de consenso; na divergência, sugere quem deve explicar primeiro (os extremos).
- **Comentários**: por item, em tempo real, com respostas, @menções, reações, edição/exclusão, voto anexado ("votou 13") e fixar como decisão.
- **Papéis**: facilitador, votante e observador; promover, rebaixar e remover participantes (a sala sempre mantém um facilitador).
- **Histórico**: resumo da sessão imprimível em PDF (`/r/CODIGO/resumo`) e export CSV (abre em pt-BR no Excel).
- **Interface** responsiva (abas no celular), modo claro/escuro automático, pt-BR.

Ficou para as próximas fases da spec: contas com login (magic link, Google, Microsoft) e workspaces (RF-07), billing e planos, integrações com Jira/Azure DevOps, idioma inglês, áudio/vídeo, transcrição e IA.

## Arquitetura

Um único processo Node atende tudo na mesma porta, o que permite hospedar de graça em um só serviço:

```
navegador ──HTTP──▶ Next.js (páginas)      ┐
          ──HTTP──▶ /api/* (REST)           ├─ src/server/index.ts (um processo)
          ──WS────▶ Socket.IO (tempo real)  ┘
                              │
                              ▼
                        PostgreSQL (Drizzle ORM, migrations automáticas no start)
```

- Cada ação da sala roda numa transação que trava a linha da sala (`SELECT ... FOR UPDATE`), então funciona igual com várias instâncias. Para escalar horizontalmente, defina `REDIS_URL` (adapter do Socket.IO); com uma instância, Redis não é necessário.
- Depois de cada mudança, o servidor envia um snapshot da sala para cada participante, montado para quem vai recebê-lo (cada pessoa vê o próprio voto, os dos outros ficam ocultos). Na reconexão, o cliente recebe o estado completo e nada se perde.
- Feito para banco distante (ex.: app em Virginia, banco em São Paulo): a ação abre a transação, trava a sala e lê o contexto numa só ida ao banco, o voto é gravado junto com a checagem de auto-revelação, e o snapshot faz suas leituras em paralelo. Com ~120 ms de latência até o banco, um voto aparece para os outros em ~0,5 s (antes: 2,2 s). Para medir: `node scripts/latency-proxy.mjs 6543 localhost:5432 60` e `DATABASE_URL=postgres://postgres:postgres@localhost:6543/poker npx tsx scripts/bench-latency.ts`.
- O timer e a limpeza de salas expiradas só consultam o banco enquanto há alguém conectado, para o Postgres serverless (Neon) poder hibernar. Abas escondidas por mais de 30 minutos se desconectam e voltam sozinhas quando a pessoa retorna.

| Pasta | Conteúdo |
| --- | --- |
| `src/shared` | decks, cálculo de estatísticas e protocolo (schemas zod das ações, tipos do snapshot) |
| `src/server` | servidor HTTP, API REST, Socket.IO, regras da sala (`room-service.ts`), snapshot, export |
| `src/app`, `src/components` | páginas e componentes React (Next.js App Router + Tailwind) |
| `drizzle` | migrations SQL geradas pelo drizzle-kit |
| `tests` | testes unitários, integração (servidor real + Postgres) e smoke test no navegador |

## Rodando localmente

Requisitos: Node 22+ e um Postgres 16 (`docker compose up -d` sobe um).

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL se precisar
npm run dev                   # http://localhost:3000
```

Testes:

```bash
npm test                                     # usa postgres://postgres:postgres@localhost:5432/poker_test
TEST_DATABASE_URL=... npm test               # outro banco (será apagado e recriado)
node tests/e2e-smoke.mjs http://localhost:3000 ./shots   # fluxo completo com 3 navegadores
```

Depois de alterar `src/server/db/schema.ts`, gere a migration com `npm run db:generate`.

## Publicar de graça: Render + Neon

Custo: **R$ 0** para validar com times reais. Limites conferidos em outubro de 2026; confira as páginas oficiais antes de publicar.

| Peça | Serviço | Plano gratuito |
| --- | --- | --- |
| App (Next.js + API + WebSocket) | [Render](https://render.com/docs/free) Free Web Service | 512 MB de RAM; hiberna após 15 min sem tráfego HTTP ou WebSocket; volta em cerca de 1 min |
| Banco | [Neon](https://neon.com/pricing) Free | 0,5 GB e 100 CU-hora por mês; hiberna após 5 min sem uso |

O Postgres gratuito do próprio Render expira, por isso o banco fica na Neon.

1. **Banco**: crie um projeto na [Neon](https://neon.com) (região **AWS US East 1 / N. Virginia**, a mesma do `render.yaml`; o Render não tem região na América do Sul) e copie a connection string (`postgres://...neon.tech/neondb?sslmode=require`).
2. **Código**: suba este repositório para o GitHub.
3. **App**: no Render, *New → Blueprint*, escolha o repositório (ele lê o `render.yaml`) e cole a connection string em `DATABASE_URL`. As tabelas são criadas sozinhas no primeiro start.
4. Abra `https://<seu-app>.onrender.com`, crie uma sala e mande o link para o time.

O que esperar no plano gratuito:

- **Primeiro acesso do dia leva cerca de 1 minuto** (o serviço acorda). Para uma sessão de refinamento, abra o link uns minutos antes. Durante a reunião, o próprio WebSocket mantém o serviço acordado.
- O Render pode reiniciar o serviço a qualquer momento. Os clientes reconectam sozinhos e recebem o estado completo, e os votos já estão salvos no banco.
- 0,5 GB de banco comporta dezenas de milhares de itens com comentários; salas sem uso são apagadas automaticamente.

### Quando quiser sair do gratuito (sem hibernação)

| Opção | Custo aproximado | Observação |
| --- | --- | --- |
| Render Starter | US$ 7/mês | mesmo `render.yaml`, troque `plan: free` por `starter` |
| Fly.io | poucos dólares/mês (pay-as-you-go) | use o `Dockerfile`; `fly launch` |
| Railway | a partir de US$ 5/mês | detecta o `Dockerfile` |
| VPS (Hetzner, Oracle Free Tier) | €4/mês ou grátis | `docker build` + Postgres na própria máquina ou na Neon |

O `Dockerfile` gera uma imagem única que roda em qualquer uma dessas: basta definir `DATABASE_URL` e, opcionalmente, `PORT`.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `DATABASE_URL` | sim (produção) | connection string do Postgres; `sslmode=require` para Neon/Supabase |
| `PORT` | não | porta HTTP (padrão 3000; o Render define sozinho) |
| `REDIS_URL` | não | só para rodar mais de uma instância |
| `DB_POOL_SIZE` | não | conexões no pool (padrão 5, adequado aos planos gratuitos) |
