import { ImageResponse } from "next/og";

// Generates the PNG icons the web manifest points at, e.g.
//   /pwa-icon?size=192        → "any" purpose
//   /pwa-icon?size=512&mask=1 → "maskable" (extra padding so nothing is clipped)
// Rendering on-demand keeps real PNGs out of the repo while staying Lighthouse-clean.
export const contentType = "image/png";

const clampSize = (raw: string | null): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 512;
  return Math.min(1024, Math.max(48, Math.round(n)));
};

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const size = clampSize(searchParams.get("size"));
  const maskable = searchParams.get("mask") === "1";

  // Maskable icons must keep content inside the inner ~80% safe zone.
  const boltScale = maskable ? 0.52 : 0.64;
  const boltPx = Math.round(size * boltScale);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0F0F14",
        }}
      >
        <svg width={boltPx} height={boltPx} viewBox="0 0 48 48">
          <path
            d="M 24 9.5 L 14.5 25.5 H 21 L 16.5 38.5 L 27 22.5 H 20.5 L 24 9.5 Z"
            fill="#B9FF66"
          />
        </svg>
      </div>
    ),
    {
      width: size,
      height: size,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  );
}
