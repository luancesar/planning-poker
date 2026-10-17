import { SummaryPage } from '@/components/SummaryPage';

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <SummaryPage code={code.toUpperCase()} />;
}
