import TeachClient from "./TeachClient";

export default async function TeachPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <TeachClient teachSessionId={sessionId} />;
}
