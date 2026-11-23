// SPDX-License-Identifier: LicenseRef-Proprietary
import { encodeQr, toSvgPath } from "./encode";
import type { EcLevel } from "./tables";
import s from "./qr-code.module.css";

export function QrCode({ value, label, ecLevel = "M" }: { value: string; label: string; ecLevel?: EcLevel }) {
  let encoded: { total: number; path: string } | null = null;
  try {
    encoded = toSvgPath(encodeQr(value, ecLevel));
  } catch {
    if (ecLevel !== "L") {
      try {
        encoded = toSvgPath(encodeQr(value, "L"));
      } catch {
        encoded = null;
      }
    }
  }
  if (!encoded) return null;
  const { total, path } = encoded;
  return (
    <figure className={s.frame}>
      <svg className={s.svg} role="img" aria-label={label} viewBox={`0 0 ${total} ${total}`} shapeRendering="crispEdges">
        <rect className={s.bg} width={total} height={total} />
        <path className={s.fg} d={path} />
      </svg>
    </figure>
  );
}

export default QrCode;
