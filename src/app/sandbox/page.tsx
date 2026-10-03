import { Suspense } from "react";
import SandboxApp from "./SandboxApp";

export default function SandboxPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-950" />}>
      <SandboxApp />
    </Suspense>
  );
}
