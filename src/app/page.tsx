import { CreateRoomForm } from '@/components/CreateRoomForm';
import { JoinByCode } from '@/components/JoinByCode';
import { Panel } from '@/components/ui';

const FEATURES = [
  ['Votos ocultos até a revelação', 'Ninguém é influenciado: o valor só aparece quando o facilitador revela ou todos votam.'],
  ['Comentários por item', 'Registre o porquê da estimativa, anexe seu voto e fixe a decisão do time.'],
  ['Sem cadastro', 'Compartilhe o link ou o código de 6 letras e o time entra só com um apelido.'],
  ['Histórico exportável', 'Baixe CSV ou gere um PDF da sessão com votos, rodadas e comentários.'],
];

export default function Home() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10 sm:py-16 lg:flex-row lg:items-start lg:gap-16">
      <div className="flex flex-1 flex-col gap-8 lg:pt-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-accent">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-on-accent">♠</span>
          Planning Poker
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Estimem juntos, decidam com contexto.</h1>
          <p className="max-w-xl text-lg text-muted">
            Crie uma sala, convide o time e votem em tempo real com cards. Cada item guarda as rodadas e a discussão que levou à estimativa.
          </p>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map(([title, text]) => (
            <li key={title} className="flex flex-col gap-1">
              <span className="font-semibold">{title}</span>
              <span className="text-sm text-muted">{text}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex w-full flex-col gap-4 lg:w-[26rem]">
        <Panel className="p-5 sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">Nova sala</h2>
          <CreateRoomForm />
        </Panel>
        <Panel className="p-5 sm:p-6">
          <h2 className="mb-3 text-lg font-semibold">Já tem um código?</h2>
          <JoinByCode />
        </Panel>
      </div>
    </main>
  );
}
