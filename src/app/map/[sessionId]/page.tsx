import MapClient from "./MapClient";

export default async function MapPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <MapClient sessionId={sessionId} />;
}
