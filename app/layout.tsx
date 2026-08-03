import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { SITE_URL } from "./site-config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "이어가 | 여행이 틀어졌을 때, 다음 예약을 지키는 앱",
    template: "%s | 이어가",
  },
  description:
    "비가 오거나 길이 막혀 일정이 틀어졌을 때, 깨진 한 곳만 바꿔 다음 예약을 지킵니다. 한국관광공사 OpenAPI로 갈 수 있는 곳만 검증해 보여 드립니다.",
  applicationName: "이어가",
  alternates: {
    canonical: "/",
    languages: {
      "ko-KR": "/",
      "x-default": "/",
    },
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
  keywords: [
    "국내여행",
    "여행 일정 변경",
    "비 올 때 갈 곳",
    "한국관광공사",
    "관광데이터",
    "무장애 관광",
  ],
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "이어가 IEOGA",
    title: "이어가 | 여행이 틀어졌을 때, 다음 예약을 지키는 앱",
    description: "깨진 한 곳만 바꿔서 다음 예약과 남은 일정을 지켜 드립니다.",
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
    title: "이어가 | 여행이 틀어졌을 때, 다음 예약을 지키는 앱",
    description:
      "깨진 한 곳만 바꿔서 다음 예약과 남은 일정을 지켜 드립니다.",
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
