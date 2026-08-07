"use client";

/* 위치 직접 입력.
 *
 * 두 가지 방법을 한 자리에 둔다.
 * 1) 장소명·주소 검색 — 정확한 지점을 아는 경우.
 * 2) 시·도 → 시·군·구 선택 — "대전 서구 어디쯤"만 아는 경우. 여행 중에는 지금
 *    서 있는 곳의 이름을 모르는 일이 흔하다. 그때 장소명을 요구하면 아무것도
 *    할 수 없다.
 *
 * 예전에는 `지금 갈 곳 찾기` 탭의 "위치 권한 없이 직접 입력"이 **여행 복구 탭으로
 * 화면을 바꿔 버렸다.** 검색 흐름을 한 곳에만 두려던 것인데, 사용자 입장에서는
 * 버튼을 눌렀더니 다른 화면에 와 있는 것이다. 지금 하려던 일과 입력한 조건이
 * 함께 사라진다. 그래서 흐름을 컴포넌트로 빼서 두 탭이 같은 것을 제자리에서
 * 쓰도록 했다.
 *
 * 시·군·구 선택의 좌표는 그 이름으로 장소 검색을 한 번 더 돌려 얻는다. 행정구역
 * 경계의 중심점을 우리가 계산해 두지 않았고, 없는 좌표를 지어내는 것보다 이미
 * 검증된 검색 경로를 재사용하는 편이 낫다. 대신 그 지점이 **구 전체를 대표하는
 * 근사치**라는 사실을 화면에 적는다. */

import { useEffect, useState } from "react";

export type ManualPlace = {
  title: string;
  latitude: number;
  longitude: number;
  areaCode?: string;
  sigunguCode?: string;
  address?: string;
  sourceLabel?: string;
  retention?: string;
};

type RegionOption = { code: string; name: string };

type Props = {
  /* 검색 결과나 시·군·구 선택이 끝나면 호출된다. */
  onPick: (place: ManualPlace) => void;
  /* 위치 권한을 다시 시도하는 경로. 없으면 버튼을 만들지 않는다. */
  onRetryGeolocation?: () => void;
  geoBusy?: boolean;
  language?: "ko" | "en";
};

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    throw new Error(error?.message || "요청을 처리하지 못했습니다.");
  }
  return payload;
}

function asPlaces(payload: Record<string, unknown>): ManualPlace[] {
  const list = Array.isArray(payload.places)
    ? payload.places
    : Array.isArray(payload.results)
      ? payload.results
      : [];
  return list.flatMap((entry) => {
    const item = entry as Record<string, unknown>;
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [
      {
        title: String(item.title ?? "").trim() || "이름 없는 장소",
        latitude,
        longitude,
        areaCode:
          typeof item.areaCode === "string" ? item.areaCode : undefined,
        sigunguCode:
          typeof item.sigunguCode === "string" ? item.sigunguCode : undefined,
        address: typeof item.address === "string" ? item.address : undefined,
        sourceLabel:
          typeof item.sourceLabel === "string" ? item.sourceLabel : undefined,
        retention:
          typeof item.retention === "string" ? item.retention : undefined,
      },
    ];
  });
}

export function ManualLocationPicker({
  onPick,
  onRetryGeolocation,
  geoBusy = false,
  language = "ko",
}: Props) {
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);

  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<ManualPlace[]>([]);
  const [searchState, setSearchState] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle");
  const [searchError, setSearchError] = useState("");

  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [districts, setDistricts] = useState<RegionOption[]>([]);
  const [regionCode, setRegionCode] = useState("");
  const [districtCode, setDistrictCode] = useState("");
  const [areaState, setAreaState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [areaError, setAreaError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getJson("/api/v1/regions")
      .then((payload) => {
        if (cancelled) return;
        const list = Array.isArray(payload.regions) ? payload.regions : [];
        setRegions(
          list.map((entry) => {
            const item = entry as Record<string, unknown>;
            return { code: String(item.code ?? ""), name: String(item.name ?? "") };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setRegions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    /* 시·도를 비웠을 때의 정리는 이 효과가 아니라 선택 핸들러에서 한다.
       효과 본문에서 상태를 바로 세우면 렌더가 한 번 더 돌고, 그 사이에 옛
       시·군·구 목록이 잠깐 보인다. */
    if (!regionCode) return;
    let cancelled = false;
    void getJson(`/api/v1/regions/${regionCode}/districts`)
      .then((payload) => {
        if (cancelled) return;
        const list = Array.isArray(payload.districts) ? payload.districts : [];
        setDistricts(
          list.map((entry) => {
            const item = entry as Record<string, unknown>;
            return { code: String(item.code ?? ""), name: String(item.name ?? "") };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setDistricts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [regionCode]);

  async function search() {
    const trimmed = keyword.trim();
    if (trimmed.length < 2) {
      setSearchState("error");
      setSearchError(
        tr("두 글자 이상 입력해 주세요.", "Type at least two characters."),
      );
      return;
    }
    setSearchState("loading");
    setSearchError("");
    try {
      const payload = await getJson(
        `/api/v1/places/search?keyword=${encodeURIComponent(trimmed)}&purpose=current_location&fallback=1`,
      );
      setResults(asPlaces(payload).slice(0, 8));
      setSearchState("success");
    } catch (error) {
      setSearchState("error");
      setSearchError(
        error instanceof Error
          ? error.message
          : tr("장소를 찾지 못했습니다.", "Could not find that place."),
      );
    }
  }

  async function applySelectedArea() {
    const region = regions.find((entry) => entry.code === regionCode);
    const district = districts.find((entry) => entry.code === districtCode);
    if (!region || !district) return;
    setAreaState("loading");
    setAreaError("");
    try {
      const label = `${region.name} ${district.name}`;
      const payload = await getJson(
        `/api/v1/places/search?keyword=${encodeURIComponent(label)}&purpose=current_location&fallback=1`,
      );
      const [first] = asPlaces(payload);
      if (!first) {
        setAreaState("error");
        setAreaError(
          tr(
            "이 시·군·구의 대표 지점을 찾지 못했습니다. 장소명으로 검색해 주세요.",
            "Could not resolve a point for this district. Try searching by place name instead.",
          ),
        );
        return;
      }
      setAreaState("idle");
      /* 행정구역 코드는 검색 결과가 아니라 **사용자가 고른 값**을 쓴다. 검색은
         좌표를 얻는 수단일 뿐이고, 어느 구인지는 사용자가 이미 말했다. */
      onPick({
        ...first,
        title: label,
        areaCode: regionCode,
        sigunguCode: districtCode,
      });
    } catch (error) {
      setAreaState("error");
      setAreaError(
        error instanceof Error
          ? error.message
          : tr("지역을 확인하지 못했습니다.", "Could not resolve that area."),
      );
    }
  }

  return (
    <div className="manual-picker">
      <div className="manual-picker-head">
        <div>
          <strong>{tr("현재 장소 직접 입력", "Enter your location")}</strong>
          <span>
            {tr(
              "장소명으로 찾거나, 시·군·구만 골라도 됩니다.",
              "Search by place name, or just pick a city and district.",
            )}
          </span>
        </div>
        {onRetryGeolocation && (
          <button type="button" onClick={onRetryGeolocation} disabled={geoBusy}>
            {geoBusy
              ? tr("확인 중…", "Locating…")
              : tr("위치 권한 다시 사용", "Use my location")}
          </button>
        )}
      </div>

      <div className="manual-picker-search">
        <label htmlFor="manual-picker-keyword">
          {tr("장소명·주소로 찾기", "Find by place or address")}
        </label>
        <div>
          <input
            id="manual-picker-keyword"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setResults([]);
              setSearchState("idle");
              setSearchError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
            placeholder={tr(
              "예: 대전역, 둔산동, 도로명 주소",
              "e.g. Daejeon Station",
            )}
            maxLength={80}
            autoComplete="off"
            data-testid="manual-picker-keyword"
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={searchState === "loading"}
            data-testid="manual-picker-search"
          >
            {searchState === "loading"
              ? tr("검색 중…", "Searching…")
              : tr("장소 찾기", "Search")}
          </button>
        </div>
        {searchState === "error" && (
          <p className="manual-picker-error" role="alert">
            {searchError}
          </p>
        )}
        {results.length > 0 && (
          <ul className="manual-picker-results">
            {results.map((place) => (
              <li key={`${place.title}-${place.latitude}-${place.longitude}`}>
                <button type="button" onClick={() => onPick(place)}>
                  <strong>{place.title}</strong>
                  {place.address && <span>{place.address}</span>}
                  {place.sourceLabel && <em>{place.sourceLabel}</em>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {searchState === "success" && results.length === 0 && (
          <p className="manual-picker-error" role="status">
            {tr(
              "검색 결과가 없습니다. 아래에서 시·군·구를 골라도 됩니다.",
              "No results. You can pick a city and district below instead.",
            )}
          </p>
        )}
      </div>

      <div className="manual-picker-area">
        <span className="manual-picker-area-title">
          {tr("또는 시·군·구로 고르기", "Or pick a city and district")}
        </span>
        <div className="manual-picker-area-fields">
          <label>
            <span>{tr("시·도", "City / province")}</span>
            <select
              value={regionCode}
              onChange={(event) => {
                setRegionCode(event.target.value);
                /* 시·도를 바꾸면 이전 시·군·구 목록은 더 이상 맞지 않는다.
                   여기서 지워야 잘못된 구가 잠깐이라도 보이지 않는다. */
                setDistricts([]);
                setDistrictCode("");
                setAreaError("");
              }}
              data-testid="manual-picker-region"
            >
              <option value="">{tr("선택", "Select")}</option>
              {regions.map((region) => (
                <option key={region.code} value={region.code}>
                  {region.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{tr("시·군·구", "District")}</span>
            <select
              value={districtCode}
              onChange={(event) => {
                setDistrictCode(event.target.value);
                setAreaError("");
              }}
              disabled={!districts.length}
              data-testid="manual-picker-district"
            >
              <option value="">{tr("선택", "Select")}</option>
              {districts.map((district) => (
                <option key={district.code} value={district.code}>
                  {district.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void applySelectedArea()}
            disabled={!districtCode || areaState === "loading"}
            data-testid="manual-picker-area-apply"
          >
            {areaState === "loading"
              ? tr("확인 중…", "Resolving…")
              : tr("이 지역으로", "Use this area")}
          </button>
        </div>
        {/* 구 전체를 대표하는 근사 지점이라는 사실을 적는다. 정확한 좌표인 것처럼
            보이면 "왜 이 근처가 아니지?"라는 오해가 생긴다. */}
        <p className="manual-picker-hint">
          {tr(
            "시·군·구를 고르면 그 지역을 대표하는 지점을 기준으로 찾습니다. 정확한 현재 위치가 아니라 그 구 일대라는 뜻입니다.",
            "Picking a district searches around a representative point for that area — not your exact position.",
          )}
        </p>
        {areaState === "error" && (
          <p className="manual-picker-error" role="alert">
            {areaError}
          </p>
        )}
      </div>
    </div>
  );
}
