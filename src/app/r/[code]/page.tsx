import { RoomPage } from '@/components/RoomPage';

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomPage code={code.toUpperCase()} />;
}
