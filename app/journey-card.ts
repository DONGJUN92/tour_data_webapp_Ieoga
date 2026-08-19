/* 이어 간 여행을 한 컷 카드로 만든다.

   왜 만드는가. 여행이 끝난 뒤 여행자가 남기고 싶은 것은 "이 경로가 공식 근거로
   검증됐다"는 증명서가 아니라 **오늘 이렇게 다녀왔다**는 한 장이다. 예전에는 완료
   화면에 "출발 전 저장한 판정 증명도 공유"가 있었는데, 그것은 출발 전에 만든 판정
   링크를 한 번 더 내미는 버튼이었다. 여행이 끝난 자리에서 출발 전 판정을 남에게
   건네면 받는 사람은 그것을 지금 쓸 수 있는 정보로 읽는다. 그 버튼을 지우고 이
   카드로 바꾼다.

   무엇을 담지 않는가. 영업 여부·경로 가능성·"지금 가도 된다"는 어떤 주장도 담지
   않는다. 카드 아래에 지난 기록이라는 사실을 적어, 이미지만 떠돌아도 오해가
   생기지 않게 한다.

   어떻게 만드는가. 글자와 도형만 쓴 SVG를 만들어 브라우저가 PNG로 굽는다. 공사
   사진이나 지도 타일을 합성하면 다른 출처의 그림이 캔버스를 오염시켜(cross-origin
   taint) `toDataURL`이 예외를 던진다 — 원격 호스트가 CORS 헤더를 주지 않으면 우회
   방법이 없다. 그래서 사진은 넣지 않는다. `data:` 이미지는 캔버스를 오염시키지
   않고, 우리 CSP의 `img-src 'self' data: https:`도 허용한다. */

export type JourneyCardStop = {
  title: string;
  /* 화면에 이미 적혀 있는 그대로의 시각 문자열. 여기서 다시 형식을 정하지 않는다
     — 화면과 카드가 다른 시각을 적으면 어느 쪽이 맞는지 알 수 없다. */
  timeLabel: string;
  /* 이어가가 새로 넣은 곳인가. 원래 일정과 구별해 표시한다. */
  inserted?: boolean;
};

export type JourneyCardInput = {
  stops: JourneyCardStop[];
  headline: string;
  subheadline: string;
  footnote: string;
  language: "ko" | "en";
};

const WIDTH = 1080;
const HEIGHT = 1080;
const BRAND = "#0E9594";
const BRAND_DEEP = "#0B7570";
const INK = "#191F28";
const INK_SOFT = "#5C6670";
const PAPER = "#FFFFFF";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* 글자가 카드 폭을 넘으면 잘라 준다. SVG는 자동 줄바꿈이 없고, 넘친 글자는
   카드 밖으로 그려져 조용히 사라진다. 폭을 재는 것보다 글자 수로 자르는 편이
   폰트가 무엇이든 예측 가능하다 — 한글은 한 글자가 넓으므로 따로 센다. */
function clamp(value: string, koreanLimit: number): string {
  const korean = /[가-힣]/.test(value);
  const limit = korean ? koreanLimit : Math.round(koreanLimit * 1.9);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * 카드 한 장을 SVG 문자열로 만든다.
 *
 * 순수 함수로 둔 이유는 이 문자열을 테스트가 그대로 읽을 수 있어야 하기
 * 때문이다. 브라우저 없이도 "카드에 검증 주장이 새로 들어가지 않았는가"를
 * 확인할 수 있다.
 */
export function buildJourneyCardSvg(input: JourneyCardInput): string {
  /* 들른 곳이 많으면 줄 간격을 줄인다. 여섯 곳까지는 넉넉하게, 그 뒤로는
     좁혀서 카드 안에 들어오게 한다. */
  const stops = input.stops.slice(0, 8);
  const listTop = 430;
  const listBottom = 900;
  const step = Math.min(
    108,
    stops.length > 1
      ? Math.floor((listBottom - listTop) / (stops.length - 1))
      : 108,
  );

  const rows = stops
    .map((stop, index) => {
      const y = listTop + step * index;
      const number = index + 1;
      const title = escapeXml(clamp(stop.title, 16));
      const time = escapeXml(clamp(stop.timeLabel, 14));
      const mark = stop.inserted ? BRAND : "#C3CBD3";
      /* 점과 점을 잇는 선. 마지막 점 아래에는 그리지 않는다. */
      const connector =
        index < stops.length - 1
          ? `<line x1="112" y1="${y + 22}" x2="112" y2="${y + step - 22}" stroke="#DEE3E8" stroke-width="3" />`
          : "";
      return `${connector}
    <circle cx="112" cy="${y}" r="19" fill="${mark}" />
    <text x="112" y="${y + 9}" font-size="22" font-weight="700" fill="${PAPER}" text-anchor="middle">${number}</text>
    <text x="158" y="${y - 4}" font-size="40" font-weight="700" fill="${INK}">${title}</text>
    <text x="158" y="${y + 34}" font-size="28" font-weight="600" fill="${INK_SOFT}">${time}</text>`;
    })
    .join("\n");

  /* 시스템에 있는 글꼴만 쓴다. 이름으로 웹폰트를 가리키면 캔버스로 구울 때
     그 폰트가 없어 다른 모양으로 나온다. */
  const fontStack =
    "'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${fontStack}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}" />
  <rect width="${WIDTH}" height="230" fill="${BRAND}" />
  <text x="80" y="96" font-size="34" font-weight="800" fill="${PAPER}" opacity="0.85">이어가</text>
  <text x="80" y="172" font-size="52" font-weight="800" fill="${PAPER}">${escapeXml(clamp(input.headline, 22))}</text>
  <text x="80" y="300" font-size="32" font-weight="700" fill="${BRAND_DEEP}">${escapeXml(clamp(input.subheadline, 30))}</text>
  <line x1="80" y1="344" x2="${WIDTH - 80}" y2="344" stroke="#EDF0F3" stroke-width="2" />
${rows}
  <line x1="80" y1="962" x2="${WIDTH - 80}" y2="962" stroke="#EDF0F3" stroke-width="2" />
  <text x="80" y="1012" font-size="24" font-weight="600" fill="${INK_SOFT}">${escapeXml(clamp(input.footnote, 44))}</text>
  <text x="80" y="1048" font-size="22" font-weight="600" fill="#8B949E">${escapeXml(
    input.language === "en"
      ? "Place data: Korea Tourism Organization"
      : "장소 정보 출처 · 한국관광공사 국문 관광정보",
  )}</text>
</svg>`;
}

/* SVG를 PNG 데이터 주소로 굽는다. `blob:`을 쓰지 않는 이유는 우리 CSP의
   `img-src`에 `blob:`이 없어서, 만든 이미지를 화면에서 미리 볼 수 없기 때문이다.
   `data:`는 허용되고 캔버스도 오염시키지 않는다. */
export async function rasterizeSvg(
  svg: string,
  width = WIDTH,
  height = HEIGHT,
): Promise<string> {
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  image.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("card_rasterize_failed"));
    image.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("card_canvas_unavailable");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const [header, payload] = dataUrl.split(",", 2);
  const binary = atob(payload ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const type = /data:([^;]+)/.exec(header ?? "")?.[1] ?? "image/png";
  return new File([bytes], filename, { type });
}

/**
 * 카드를 내보낸다. 공유 시트가 파일을 받을 수 있으면 그쪽으로, 아니면 내려받기로
 * 떨어진다. 어느 쪽으로 갔는지 돌려주어, 화면이 사실에 맞는 문장을 적을 수 있게
 * 한다 — "공유했습니다"라고 적어 두고 실제로는 파일이 저장됐으면 그 문장이
 * 거짓이 된다.
 */
export async function exportJourneyCard(
  input: JourneyCardInput,
  filename: string,
): Promise<"shared" | "downloaded"> {
  const dataUrl = await rasterizeSvg(buildJourneyCardSvg(input));
  const file = dataUrlToFile(dataUrl, filename);
  const shareData = { files: [file], title: input.headline };
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare(shareData) &&
    typeof navigator.share === "function"
  ) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (error) {
      /* 사용자가 공유 시트를 닫은 것은 실패가 아니다. 그때 내려받기까지 대신
         해 주면 원하지 않은 파일이 저장된다. */
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
    }
  }
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  /* `append`가 아니라 `appendChild`를 쓴다. 이 저장소의 타입에는 워커 런타임의
     `HTMLRewriter` 타입이 함께 들어와 있고, 그쪽 `Element.append`는 문자열이나
     응답 본문을 받는다 — 같은 이름이 겹쳐 DOM 쪽 서명이 가려진다. 붙이지 않고
     누르면 파이어폭스에서 동작하지 않으므로 붙였다 지운다. */
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return "downloaded";
}
