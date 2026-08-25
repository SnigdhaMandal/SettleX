import { ImageResponse } from "next/og";

// iOS home-screen icon. iOS ignores SVG apple-touch-icons, so we render a PNG.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        <svg width="128" height="128" viewBox="0 0 48 48">
          <path
            d="M 24 9.5 L 14.5 25.5 H 21 L 16.5 38.5 L 27 22.5 H 20.5 L 24 9.5 Z"
            fill="#B9FF66"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
