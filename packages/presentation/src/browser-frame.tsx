import React from "react";
import { interpolate, Easing } from "remotion";
export const ease = Easing.bezier(0.2, 0.85, 0.2, 1);
export const mix = (f: number, a: number, b: number, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
export function Mark({ size = 24 }: { size?: number }) {
  const cutId = React.useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="88 80 336 352"
      width={size}
      height={size}
      fill="none"
    >
      <defs>
        <mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          <rect x="118" y="218" width="276" height="76" rx="26" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${cutId})`} fill="#011627">
        <rect x="140" y="84" width="68" height="344" rx="34" />
        <rect x="304" y="84" width="68" height="344" rx="34" />
      </g>
      <rect x="104" y="204" width="304" height="104" rx="40" stroke="#011627" strokeWidth="28" />
      <rect x="236" y="226" width="40" height="60" rx="20" fill="#267CE8" />
    </svg>
  );
}
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    down: <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />,
    plus: <path d="M12 5v14M5 12h14" />,
    lock: (
      <>
        <rect x="6" y="10" width="12" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    refresh: (
      <>
        <path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
    chat: <path d="M5 4h14v12H9l-4 4V4Z" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v11H3V6Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
export function BrowserFrame({
  children,
  section = "Get started",
  address = "Harness",
  download,
}: {
  children: React.ReactNode;
  section?: string;
  address?: string;
  download?: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: 1600,
        height: 1000,
        background: "#fff",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          height: 60,
          background: "linear-gradient(#f4f4f2,#e9eae7)",
          borderBottom: "1px solid #d8dad5",
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "0 23px",
          color: "#73776e",
          position: "relative",
          zIndex: 4,
        }}
      >
        <div style={{ display: "flex", gap: 8 }}>
          {["#c4c8bf", "#c4c8bf", "#c4c8bf"].map((c, i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: c,
                border: "1px solid #aeb4a660",
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 18,
            alignItems: "center",
            marginLeft: 8,
          }}
        >
          <span style={{ transform: "rotate(180deg)", display: "flex" }}>
            <Icon name="chevron" size={16} />
          </span>
          <Icon name="chevron" size={16} />
          <Icon name="refresh" size={16} />
        </div>
        <div
          style={{
            width: 240,
            display: "flex",
            gap: 10,
            alignItems: "center",
            color: "#333a30",
            fontSize: 13,
            fontWeight: 550,
          }}
        >
          <Mark size={17} />
          Harness{" "}
          <span style={{ color: "#a5aa9e", fontSize: 12, fontWeight: 400 }}>
            {" "}
            / {section}
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 585,
            top: 12,
            width: 430,
            height: 35,
            borderRadius: 8,
            border: "1px solid #d1d5ca",
            boxShadow: "inset 0 1px 2px #00000004",
            background: "#f9faf7",
            display: "flex",
            gap: 9,
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            color: "#646d5c",
          }}
        >
          <Icon name="lock" size={12} />
          {address}
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 25,
          }}
        >
          <Icon name="down" size={17} />
          <span style={{ fontSize: 20, lineHeight: 1 }}>⋯</span>
        </div>
      </div>
      <div style={{ height: 940, position: "relative", overflow: "hidden" }}>
        {children}
      </div>
      {download}
    </div>
  );
}
export function DownloadToast({
  f,
  progress,
  complete,
  bytes,
}: {
  f: number;
  progress: number;
  complete: boolean;
  bytes: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        right: 24,
        top: 73,
        width: 368,
        padding: 21,
        borderRadius: 15,
        background: "#fffffff5",
        border: "1px solid #dce1d5",
        boxShadow: "0 20px 70px #1c2d2126,0 3px 10px #1c2d210b",
        zIndex: 20,
        transform: `translateY(${mix(f, 0, 18, -12, 0)}px)`,
        opacity: mix(f, 0, 12),
        color: "#253124",
      }}
    >
      <div style={{ display: "flex", gap: 15, alignItems: "center" }}>
        <div
          style={{
            width: 45,
            height: 45,
            borderRadius: 12,
            background: complete ? "#e7efdf" : "#f1f3ec",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#526c3d",
          }}
        >
          <Icon name={complete ? "check" : "down"} size={23} />
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {complete ? "Harness downloaded" : "Downloading Harness"}
          </div>
          <div style={{ fontSize: 12, color: "#8a9381", marginTop: 5 }}>
            Linux desktop app · {(bytes / 1e6).toFixed(1)} MB
          </div>
        </div>
      </div>
      <div
        style={{
          height: 3,
          borderRadius: 3,
          background: "#edf0e7",
          marginTop: 18,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: 3,
            width: `${progress * 100}%`,
            background: "#74896b",
          }}
        />
      </div>
      {complete && (
        <div
          style={{
            marginTop: 16,
            padding: "12px 16px",
            borderRadius: 8,
            background: "#253322",
            color: "#f7faf2",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          Open Harness
          <Icon name="arrow" size={15} />
        </div>
      )}
    </div>
  );
}
