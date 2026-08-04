import type { Metadata } from "next";
import { EmbedRecoverWidget, type EmbedOrigin } from "./EmbedRecoverWidget";

/* 파트너 임베드 위젯.
 *
 * 기획 15.4의 발전성 방어조건 3은 "1개 이상 기관·사업자에게 임베드 데모를
 * 제공"을 요구하는데, 저장소에 embed·widget 이름의 파일이 하나도 없었다.
 *
 * 별도 엔진을 만들지 않는다. 같은 `POST /api/v1/recover`를 호출하고 같은 검증·
 * 저장 보장을 받는다. 기획 11.1의 "하나의 구현을 여러 심사 증거로 전환" 원칙이
 * 여기서 지켜져야 의미가 있다. 다른 점은 화면 크기와, 파트너 사이트 안에서
 * 브랜드가 남의 것이라는 전제뿐이다.
 *
 * 파트너가 넘긴 좌표는 **서버에서** 읽어 검증한 뒤 props로 내린다. 클라이언트
 * 효과에서 `window.location`을 읽으면 서버 렌더와 결과가 갈려 하이드레이션이
 * 어긋나고, 잘못된 좌표를 한 번 렌더한 뒤 고치는 순서가 된다. */

export const metadata: Metadata = {
  title: "이어가 복구 위젯",
  description:
    "숙박·교통·지역 관광 웹에 넣는 이어가 복구 위젯. 같은 복구 엔진을 호출합니다.",
  /* 파트너 사이트 안에서 뜨는 화면이므로 검색 결과에 따로 잡히지 않게 한다. */
  robots: { index: false, follow: false },
};

function readOne(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/* 파트너가 넘긴 값을 그대로 믿지 않는다. 한반도 범위를 벗어난 좌표는 좌표계
   혼동의 신호이므로 버리고, 위젯이 방문자에게 직접 위치를 묻게 한다. */
function parseOrigin(
  params: Record<string, string | string[] | undefined>,
): EmbedOrigin | null {
  const latitude = Number(readOne(params.lat));
  const longitude = Number(readOne(params.lng));
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 32 ||
    latitude > 39.8 ||
    longitude < 124 ||
    longitude > 132
  ) {
    return null;
  }
  const areaCode = readOne(params.area);
  const sigunguCode = readOne(params.sigungu);
  return {
    latitude,
    longitude,
    label: readOne(params.label).slice(0, 80) || "파트너 지정 위치",
    areaCode: /^\d{2}$|^\d{5}$/.test(areaCode) ? areaCode : undefined,
    sigunguCode: /^\d{5}$/.test(sigunguCode) ? sigunguCode : undefined,
  };
}

export default async function EmbedRecoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <EmbedRecoverWidget
      hostName={readOne(params.host).slice(0, 40)}
      partnerOrigin={parseOrigin(params)}
    />
  );
}
