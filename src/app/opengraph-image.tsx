import { ImageResponse } from "next/og";
import { LINK_PREVIEW_DESCRIPTION } from "@/lib/site-metadata";

export const alt = "ParkSwap — fork of IguanaDEX on Tezos X EVM testnet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#131313",
          padding: 56,
          gap: 56,
        }}
      >
        <svg width={220} height={220} viewBox="0 0 200 200" fill="none">
          <circle cx="100" cy="100" r="90" fill="rgb(6, 95, 70)" fillOpacity="0.12" />
          <path
            d="M100 40C100 40 60 70 60 110C60 150 100 160 100 160C100 160 140 150 140 110C140 85 125 65 110 55"
            stroke="#10B981"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M95 30L105 40L95 50"
            stroke="#10B981"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M100 160V100C100 100 100 80 120 75"
            stroke="#34D399"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <circle cx="145" cy="65" r="5" fill="#34D399" />
        </svg>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 20,
            maxWidth: 760,
          }}
        >
          <div style={{ fontSize: 68, fontWeight: 700, color: "#ffffff", letterSpacing: "-0.02em" }}>ParkSwap</div>
          <div style={{ fontSize: 34, color: "rgba(255,255,255,0.88)", lineHeight: 1.4 }}>{LINK_PREVIEW_DESCRIPTION}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
