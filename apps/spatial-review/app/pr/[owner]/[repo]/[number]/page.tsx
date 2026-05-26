import { PrReadingPath } from "@/components/PrReadingPath";

interface Params {
  params: Promise<{ owner: string; repo: string; number: string }>;
}

export default async function PrPage({ params }: Params) {
  const { owner, repo, number: numberStr } = await params;
  const number = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return (
      <div style={{ padding: 40 }}>
        Invalid PR number: <code>{numberStr}</code>
      </div>
    );
  }
  return <PrReadingPath owner={owner} repo={repo} number={number} />;
}
