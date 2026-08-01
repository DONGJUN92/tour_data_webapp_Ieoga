import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { SITE_URL } from "./site-config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "이어가(IEOGA) | 전국 여행 중단 회복 서비스",
    template: "%s | 이어가",
  },
  description:
    "여행이 흔들려도 목적은 이어지도록, 한국관광공사 OpenAPI로 적용 가능한 다음 일정을 검증합니다.",
  applicationName: "이어가",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/icon-192.png", type: "image/png", sizes: "192x192" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "이어가",
  },
  formatDetection: {
    address: false,
    email: false,
    telephone: false,
  },
  robots: {
    index: true,
    follow: true,
  },
  keywords: ["국내여행", "여행 일정", "한국관광공사", "관광데이터", "무장애 관광"],
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "이어가 IEOGA",
    title: "이어가 | 전국 여행 중단 회복 서비스",
    description: "비·지연·혼잡에도 원래 여행의 목적을 지키는 다음 일정을 찾습니다.",
    images: [
      {
        url: `${SITE_URL}/og.png`,
        width: 1732,
        height: 908,
        alt: "중단된 여행 일정 한 구간만 우회해 다음 예약까지 이어지는 경로",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "이어가 | 전국 여행 중단 회복 서비스",
    description:
      "원래 일정과 다음 예약을 지키는 최소변경 여행 복구안을 검증합니다.",
    images: [`${SITE_URL}/og.png`],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: "#174a3a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body>
        <noscript>이어가를 사용하려면 브라우저에서 JavaScript를 허용해 주세요.</noscript>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
