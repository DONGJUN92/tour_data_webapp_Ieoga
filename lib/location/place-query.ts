import { z } from "zod";
import {
  districtBelongsToRegion,
  isOfficialRegionCode,
  isPlausibleOfficialDistrictCode,
} from "@/lib/kto/registry";

function optionalCoordinate(minimum: number, maximum: number) {
  return z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      if (typeof value === "string" && value.trim() === "") {
        return Number.NaN;
      }
      return typeof value === "string" ? Number(value) : value;
    },
    z.number().finite().min(minimum).max(maximum).optional(),
  );
}

export const placeSearchQuerySchema = z
  .object({
    keyword: z.string().trim().min(2).max(80),
    purpose: z
      .enum(["saved_stop", "current_origin"])
      .default("saved_stop"),
    fallback: z.enum(["auto", "force"]).default("auto"),
    areaCode: z
      .string()
      .refine(
        isOfficialRegionCode,
        "공식 시도 코드를 확인해 주세요.",
      )
      .optional(),
    sigunguCode: z
      .string()
      .refine(
        isPlausibleOfficialDistrictCode,
        "공식 시군구 코드 형식을 확인해 주세요.",
      )
      .optional(),
    latitude: optionalCoordinate(32, 39.8),
    longitude: optionalCoordinate(124, 132),
  })
  .superRefine((query, context) => {
    if (
      (query.latitude === undefined) !==
      (query.longitude === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["latitude"],
        message: "위도와 경도는 함께 입력해야 합니다.",
      });
    }
    if (
      query.sigunguCode &&
      !query.areaCode
    ) {
      context.addIssue({
        code: "custom",
        path: ["areaCode"],
        message: "시군구 코드와 함께 공식 시도 코드가 필요합니다.",
      });
    }
    if (
      query.areaCode &&
      query.sigunguCode &&
      !districtBelongsToRegion(query.areaCode, query.sigunguCode)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sigunguCode"],
        message: "시군구 코드가 선택한 시도에 속하지 않습니다.",
      });
    }
  });
