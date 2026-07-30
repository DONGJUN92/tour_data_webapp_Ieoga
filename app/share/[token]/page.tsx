/* eslint-disable @next/next/no-html-link-for-pages */

import type { Metadata } from "next";
import { ShareView } from "./ShareView";

export const metadata: Metadata = {
  title: "복구 증명서",
  robots: { index: false, follow: false },
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="share-shell">
      <a className="share-brand" href="/">
        이어가 · IEOGA
      </a>
      <ShareView token={token} />
    </main>
  );
}
