/**
 * Theme utilities for generating color palettes from a base theme color
 */

export function normalizeThemeColor(themeColor?: string | null) {
  if (!themeColor) return "#E91E63"; // Default pink/magenta for sales portal
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeColor)
    ? themeColor
    : "#E91E63";
}

function expandHex(hex: string) {
  const normalized = hex.replace("#", "");
  if (normalized.length === 3) {
    return normalized
      .split("")
      .map((char) => char + char)
      .join("");
  }
  return normalized;
}

export function hexToRgb(hex: string) {
  const value = expandHex(hex);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHexColors(first: string, second: string, ratio: number) {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  return rgbToHex(
    a.r + (b.r - a.r) * ratio,
    a.g + (b.g - a.g) * ratio,
    a.b + (b.b - a.b) * ratio,
  );
}

function getContrastColor(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;
  return luminance >= 160 ? "#111827" : "#ffffff";
}

export interface ThemePalette {
  accent: string;
  accentDark: string;
  accentSoft: string;
  accentLighter: string;
  accentTint: string;
  contrast: string;
  focusRing: string;
}

export function getThemePalette(themeColor?: string | null): ThemePalette {
  const accent = normalizeThemeColor(themeColor);
  const accentDark = mixHexColors(accent, "#000000", 0.18);
  const accentSoft = mixHexColors(accent, "#ffffff", 0.9);
  const accentLighter = mixHexColors(accent, "#ffffff", 0.96);
  const accentTint = mixHexColors(accent, "#ffffff", 0.8);
  const rgb = hexToRgb(accent);

  return {
    accent,
    accentDark,
    accentSoft,
    accentLighter,
    accentTint,
    contrast: getContrastColor(accent),
    focusRing: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`,
  };
}
