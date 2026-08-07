import { getRuntimeSecret } from "@/lib/runtime-env";

type KakaoDocument = {
  id?: string;
  phone?: string;
  place_name?: string;
  address_name?: string;
  road_address_name?: string;
  x?: string;
  y?: string;
  place_url?: string;
};

export type KakaoLocalPlace = {
  provider: "kakao_local";
  providerId: string;
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  sourceLabel: "카카오 로컬";
  externalUrl?: string;
  /* 카카오 로컬은 **영업시간을 주지 않는다**(반환 필드 실측: address·category·
     phone·place_name·place_url·좌표). 하지만 전화번호는 준다. 공사 응답에
     연락처가 없을 때 이 값이 "직접 확인하세요"를 실행 가능한 안내로 바꾼다. */
  phone?: string;
  retention: "ephemeral";
};

export function kakaoLocalConfigured(): boolean {
  return Boolean(getRuntimeSecret("KAKAO_REST_API_KEY"));
}

export async function searchKakaoLocal(params: {
  keyword: string;
  latitude?: number;
  longitude?: number;
}): Promise<KakaoLocalPlace[]> {
  const key = getRuntimeSecret("KAKAO_REST_API_KEY");
  if (!key) return [];

  const url = new URL(
    "https://dapi.kakao.com/v2/local/search/keyword.json",
  );
  url.searchParams.set("query", params.keyword);
  url.searchParams.set("size", "10");
  if (
    typeof params.latitude === "number" &&
    typeof params.longitude === "number"
  ) {
    url.searchParams.set("y", String(params.latitude));
    url.searchParams.set("x", String(params.longitude));
    url.searchParams.set("radius", "20000");
    url.searchParams.set("sort", "distance");
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `KakaoAK ${key}`,
    },
    signal: AbortSignal.timeout(4_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`KAKAO_LOCAL_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as {
    documents?: KakaoDocument[];
  };
  return (payload.documents ?? []).flatMap((item): KakaoLocalPlace[] => {
    const latitude = Number(item.y);
    const longitude = Number(item.x);
    const title = item.place_name?.trim() ?? "";
    if (
      !title ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < 32 ||
      latitude > 39.8 ||
      longitude < 124 ||
      longitude > 132
    ) {
      return [];
    }
    return [
      {
        provider: "kakao_local",
        providerId: item.id || `${latitude},${longitude}`,
        title,
        address:
          item.road_address_name?.trim() ||
          item.address_name?.trim() ||
          title,
        latitude,
        longitude,
        sourceLabel: "카카오 로컬",
        externalUrl: item.place_url?.trim() || undefined,
        phone: (item.phone ?? "").trim() || undefined,
        retention: "ephemeral",
      },
    ];
  });
}
