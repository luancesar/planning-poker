'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from './ui';

export function JoinByCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const clean = code.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length === 6) router.push(`/r/${clean}`);
      }}
    >
      <Input
        value={clean}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Código da sala"
        aria-label="Código da sala"
        className="font-mono tracking-[0.3em] uppercase"
        autoCapitalize="characters"
      />
      <Button type="submit" disabled={clean.length !== 6}>
        Entrar
      </Button>
    </form>
  );
}
