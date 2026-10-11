// Decorative layer for the dashboard: starfield, flowing ribbons and sticker art.
// All original inline SVG/CSS. Everything here is aria-hidden, pointer-events: none,
// and animated with transform/opacity only (see globals.css; disabled for reduced motion).

import type { CSSProperties } from "react";

// One wave period is 1200 units; the path spans two periods so translateX(-50%) loops seamlessly.
const WAVE = "M0 210 C 200 50, 400 50, 600 210 S 1000 370, 1200 210 S 1600 50, 1800 210 S 2200 370, 2400 210";
const STRIPES = ["#2bc4b6", "#ffd23f", "#ff8c2b", "#ff4b5c", "#c2408a"];

function Ribbon({ className }: { className: string }) {
  return (
    <div className={`ribbon ${className}`}>
      <svg viewBox="0 0 2400 420" preserveAspectRatio="none" focusable="false">
        <path d={WAVE} className="ribbon-edge" />
        {STRIPES.map((c, i) => (
          <path key={c} d={WAVE} stroke={c} strokeWidth="24" fill="none" transform={`translate(0 ${(i - 2) * 22})`} />
        ))}
      </svg>
    </div>
  );
}

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="stars s1" />
      <div className="stars s2" />
      <div className="stars s3" />
      <div className="ribbon-wrap rw1">
        <Ribbon className="r1" />
      </div>
      <div className="ribbon-wrap rw2">
        <Ribbon className="r2" />
      </div>
      <div className="vignette" />
    </div>
  );
}

type StickerProps = { className?: string; style?: CSSProperties };

export function Cloud({ className = "", style }: StickerProps) {
  return (
    <svg className={`sticker ${className}`} style={style} viewBox="0 0 120 70" aria-hidden focusable="false">
      <path
        d="M28 60 H96 a18 18 0 0 0 0-36 a24 24 0 0 0-44-10 a18 18 0 0 0-30 12 a17 17 0 0 0 6 34 z"
        fill="#fff6e0"
        stroke="#0a0f2c"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path d="M40 46 q6 5 12 0 M66 46 q6 5 12 0" stroke="#0a0f2c" strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Sparkle({ className = "", style, color = "#ffd23f" }: StickerProps & { color?: string }) {
  return (
    <svg className={`sticker ${className}`} style={style} viewBox="0 0 60 60" aria-hidden focusable="false">
      <path d="M30 3 C33 22 38 27 57 30 C38 33 33 38 30 57 C27 38 22 33 3 30 C22 27 27 22 30 3 Z" fill={color} stroke="#0a0f2c" strokeWidth="4" strokeLinejoin="round" />
    </svg>
  );
}

export function Flower({ className = "", style, petal = "#ff7ab6" }: StickerProps & { petal?: string }) {
  const petals = [0, 72, 144, 216, 288];
  return (
    <svg className={`sticker ${className}`} style={style} viewBox="0 0 80 80" aria-hidden focusable="false">
      {petals.map((a) => (
        <ellipse key={a} cx="40" cy="20" rx="13" ry="18" fill={petal} stroke="#0a0f2c" strokeWidth="4" transform={`rotate(${a} 40 40)`} />
      ))}
      <circle cx="40" cy="40" r="12" fill="#ffd23f" stroke="#0a0f2c" strokeWidth="4" />
    </svg>
  );
}

/** A traffic cone sticker - Shoulder Watch's own mascot. */
export function Cone({ className = "", style }: StickerProps) {
  return (
    <svg className={`sticker ${className}`} style={style} viewBox="0 0 70 80" aria-hidden focusable="false">
      <path d="M27 8 h16 l14 58 H13 Z" fill="#ff8c2b" stroke="#0a0f2c" strokeWidth="4" strokeLinejoin="round" />
      <path d="M22 30 h26 l3 12 H19 Z" fill="#fff6e0" stroke="#0a0f2c" strokeWidth="3" strokeLinejoin="round" />
      <rect x="5" y="64" width="60" height="10" rx="4" fill="#ff8c2b" stroke="#0a0f2c" strokeWidth="4" />
    </svg>
  );
}
