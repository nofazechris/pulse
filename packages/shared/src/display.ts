/**
 * Even Realities G2 display facts, verified against
 * https://hub.evenrealities.com/docs/build/display (2026-11-24) and the SDK typings (0.0.16).
 */
export const G2_DISPLAY = {
  /** Canvas per eye, pixels. Origin top-left. */
  width: 576,
  height: 288,
  /** 4-bit greyscale rendered as 16 levels of green. */
  greyLevels: 16,
  /** SDK text brightness range (textColor). 0 = dimmest, 4 = default/brightest. */
  textBrightness: { min: 0, max: 4 },
  /** Container limits per page. */
  maxImageContainers: 4,
  maxOtherContainers: 8,
  /** Text container character limits by SDK call. */
  textLimits: { create: 1000, rebuild: 1000, upgrade: 2000 },
  /** Practical full-screen text budget (docs: roughly 400-500 characters). */
  fullScreenTextBudget: 450,
} as const;
