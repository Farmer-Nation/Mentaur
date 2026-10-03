import { Suspense } from "react";
import NewTeachForm from "./NewTeachForm";

export default function NewTeachPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <NewTeachForm />
    </Suspense>
  );
}
