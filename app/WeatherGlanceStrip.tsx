import type { WeatherGlance } from "@/lib/recovery/types";

/* 시점별 날씨 한 줄.
 *
 * 지정 여행지와 대안을 **같은 시점으로 나란히** 놓아 사용자가 직접 비교하게
 * 하는 것이 목적이다. 순위에는 쓰지 않는다 — 강수 임계값을 실측으로 조정하지
 * 못했으므로, 검증되지 않은 숫자를 순위에 박아 넣는 대신 예보를 그대로 보여
 * 주고 판단은 사용자에게 남긴다.
 *
 * 시점은 1시간 간격이다. 기상청에는 30분 단위 예보가 없다 — 단기예보와
 * 초단기예보 모두 정시 슬롯이다(실측 확인). 정시 값을 "30분 후"라고 적으면
 * 없는 정밀도를 주장하는 것이므로 상대 시각으로 표기한다. */

type Props = {
  label: string;
  slots: WeatherGlance[];
  language?: "ko" | "en";
  /* 기준 지점(원래 가려던 곳)인가. 대안과 시각적으로 구분한다. */
  isBaseline?: boolean;
};

/* PTY(강수형태)가 SKY(하늘상태)보다 강한 신호다. 비가 오는 중이면 구름 상태는
   결정을 바꾸지 않는다. */
function symbolFor(slot: WeatherGlance): { icon: string; text: string; textEn: string } {
  const pty = slot.precipitationType ?? 0;
  if (pty === 3) return { icon: "❄️", text: "눈", textEn: "Snow" };
  if (pty === 2) return { icon: "🌨️", text: "비/눈", textEn: "Rain or snow" };
  if (pty === 4) return { icon: "🌦️", text: "소나기", textEn: "Showers" };
  if (pty === 1) return { icon: "🌧️", text: "비", textEn: "Rain" };
  /* SKY: 1 맑음 3 구름많음 4 흐림. */
  if (slot.skyCode === 4) return { icon: "☁️", text: "흐림", textEn: "Overcast" };
  if (slot.skyCode === 3) return { icon: "🌤️", text: "구름많음", textEn: "Mostly cloudy" };
  if (slot.skyCode === 1) return { icon: "☀️", text: "맑음", textEn: "Clear" };
  return { icon: "•", text: "확인 못 함", textEn: "Unknown" };
}

function timeLabel(hoursAhead: number, language: "ko" | "en"): string {
  if (hoursAhead === 0) return language === "en" ? "Now" : "지금";
  return language === "en"
    ? `+${hoursAhead}h`
    : `${hoursAhead}시간 후`;
}

export function WeatherGlanceStrip({
  label,
  slots,
  language = "ko",
  isBaseline = false,
}: Props) {
  /* 예보를 못 받았으면 아무것도 그리지 않는다. 빈 칸 세 개를 보여 주면
     "확인했는데 날씨가 없다"로 읽힌다. */
  if (!slots.length) return null;
  const tr = (ko: string, en: string) => (language === "en" ? en : ko);

  /* 읽어 주는 문장을 따로 만든다. 아이콘만 있으면 스크린리더 사용자는 이 줄을
     전혀 쓸 수 없다. */
  const spoken = slots
    .map((slot) => {
      const symbol = symbolFor(slot);
      const time = timeLabel(slot.hoursAhead, language);
      const temperature =
        slot.temperatureCelsius !== undefined
          ? `${Math.round(slot.temperatureCelsius)}${tr("도", "°C")}`
          : "";
      const chance =
        slot.precipitationProbabilityPercent !== undefined
          ? tr(
              `강수확률 ${slot.precipitationProbabilityPercent}퍼센트`,
              `${slot.precipitationProbabilityPercent}% chance of precipitation`,
            )
          : "";
      return [time, language === "en" ? symbol.textEn : symbol.text, temperature, chance]
        .filter(Boolean)
        .join(" ");
    })
    .join(", ");

  return (
    <div
      className={isBaseline ? "weather-glance is-baseline" : "weather-glance"}
      /* 아이콘만 있으면 스크린리더 사용자는 이 줄을 전혀 쓸 수 없다. 시각
         목록은 숨기고 같은 내용을 읽어 주는 라벨을 컨테이너에 붙인다 — 별도
         유틸리티 클래스를 새로 만들지 않아도 된다. */
      role="group"
      aria-label={`${label}: ${spoken}`}
    >
      <span className="weather-glance-label" aria-hidden="true">
        {label}
      </span>
      <ul aria-hidden="true">
        {slots.map((slot) => {
          const symbol = symbolFor(slot);
          return (
            <li key={slot.hoursAhead}>
              <span className="weather-glance-time">
                {timeLabel(slot.hoursAhead, language)}
              </span>
              <span className="weather-glance-icon">{symbol.icon}</span>
              <span className="weather-glance-text">
                {language === "en" ? symbol.textEn : symbol.text}
              </span>
              {slot.temperatureCelsius !== undefined && (
                <span className="weather-glance-temp">
                  {Math.round(slot.temperatureCelsius)}°
                </span>
              )}
              {slot.precipitationProbabilityPercent !== undefined &&
                slot.precipitationProbabilityPercent > 0 && (
                  <span className="weather-glance-pop">
                    {slot.precipitationProbabilityPercent}%
                  </span>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
