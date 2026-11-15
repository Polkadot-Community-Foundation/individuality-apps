// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Pocket book the chest's collectables are swiped into, as the claim gesture draws it.
 *
 * The open book lies at the foot of the screen, leaning back as if on a table with its pages bent up from the
 * spine. A swipe down raises it while each piece follows the finger onto its own cell, and the cover then shuts
 * while the book grows in the middle of the screen.
 */

export const BOOK = { width: 180, height: 240, grown: 1.4, tilt: 46, bend: 14 }
export const CELL = 54
export const PAGE_HALF = BOOK.width / 2
export const CLAIM_AT = 0.7
export const SWIPE_REACH = 150
const PEEK = 104
const FOOT_GAP = 24
const SIDE_MARGIN = 12
const LAND_SPREAD = 700

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Pose {
  x: number
  y: number
  rotate: number
  scale: number
  opacity: number
}

export interface Swipe {
  start: Point
  progress: number
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** How big the open spread is drawn: its own size, or smaller when the two pages would not fit across the screen. */
export const openScale = (stage: Size) => Math.min(1, (stage.width - SIDE_MARGIN * 2) / (BOOK.width * 2))

/** Where the spine of the open book sits: peeking at the foot at rest, fully up as the swipe completes. */
export function openBookAt(progress: number, stage: Size): Point {
  const scale = openScale(stage)
  const half = (BOOK.height * scale) / 2
  const rest = stage.height - PEEK + half
  const up = stage.height - FOOT_GAP - half
  return { x: stage.width / 2 + PAGE_HALF * scale, y: mix(rest, up, progress) }
}

export const closedBookAt = (stage: Size): Point => ({ x: stage.width / 2, y: stage.height / 2 })

/** The first half of the pieces goes on the inside of the cover, the rest on the page, as the app always laid them out. */
export const onCover = (count: number) => Math.ceil(count / 2)

/** Reads a drag downwards from where the finger landed. Sideways and upwards give nothing. */
export function trackSwipe(previous: Swipe | null, finger: Point): Swipe {
  const start = previous?.start ?? finger
  return { start, progress: clamp01((finger.y - start.y) / SWIPE_REACH) }
}

export const claims = (progress: number) => progress >= CLAIM_AT

/**
 * How far a piece has come from where it floats onto its cell, as the swipe goes on. The pieces nearest their cell
 * land first, each shrinks to the cell and turns upright, and it fades out as it lands so the art on the page takes
 * over.
 */
export function landing({ from, to, progress, rotation, endScale }: { from: Point; to: Point; progress: number; rotation: number; endScale: number }): Pose {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const q = clamp01(progress * 1.5 - Math.min(1, Math.hypot(dx, dy) / LAND_SPREAD) * 0.5)
  return {
    x: dx * q,
    y: dy * q,
    rotate: rotation * (1 - q) + (dx < 0 ? -8 : 8) * q * (1 - q) * 4,
    scale: 1 + (endScale - 1) * q,
    opacity: 1 - clamp01((q - 0.7) / 0.3),
  }
}
