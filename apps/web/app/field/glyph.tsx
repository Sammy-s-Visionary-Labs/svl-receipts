import type { CSSProperties } from "react";

const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  receipt: "M6 3h12v19l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6M9 16h3",
  camera: "M8 5 6 8H3v12h18V8h-3l-2-3H8Zm8 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01",
  upload: "M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6",
  image: "M3 3h18v18H3V3Zm0 14 6-6 4 4 3-3 5 5M15 7h.01",
  pin: "M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Zm-5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  rotate: "M3 10a9 9 0 1 1 2 8M3 4v6h6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  logout: "M9 3H3v18h6m7-15 6 6-6 6M8 12h14",
  wifi: "M2 8a17 17 0 0 1 20 0M5 12a12 12 0 0 1 14 0M8 16a6 6 0 0 1 8 0m-4 4h.01",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
};
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 22,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
