// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOUNCY, SNUG, coverSwing, standUp, settled, sparksFor, stepSpring, type Spring } from "./motion"

const run = (from: Spring, target: number, tune = BOUNCY, frames = 240) => {
  let spring = from
  let peak = from.x
  for (let i = 0; i < frames; i++) {
    spring = stepSpring(spring, target, tune, 1 / 60)
    peak = Math.max(peak, spring.x)
  }
  return { spring, peak }
}

describe("a spring", () => {
  it("overshoots its target once and settles on it", () => {
    // When
    const { spring, peak } = run({ x: 0, v: 0 }, 1)

    // Then
    expect(peak).toBeGreaterThan(1.05)
    expect(settled(spring, 1)).toBe(true)
  })

  it("stays put through a long stall instead of flying off", () => {
    // When
    const after = stepSpring({ x: 0, v: 0 }, 1, SNUG, 5)

    // Then
    expect(after.x).toBeGreaterThan(0)
    expect(after.x).toBeLessThan(1.5)
  })
})

describe("the cover", () => {
  it("lifts off slowly and is still moving when it lands", () => {
    // When
    const start = coverSwing(0.1) - coverSwing(0)
    const end = coverSwing(1) - coverSwing(0.9)

    // Then
    expect(coverSwing(0)).toBe(0)
    expect(coverSwing(1)).toBeCloseTo(1)
    expect(end).toBeGreaterThan(start * 2)
  })
})

describe("the book standing up", () => {
  it("leaves the table quickly, leans a hair past upright and settles", () => {
    // When
    const early = standUp(0.2)
    const late = standUp(0.9) - standUp(0.8)
    const peak = Math.max(...[0.6, 0.7, 0.8, 0.9].map(standUp))

    // Then
    expect(standUp(0)).toBeCloseTo(0)
    expect(early).toBeGreaterThan(0.35)
    expect(Math.abs(late)).toBeLessThan(0.05)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.08)
    expect(standUp(1)).toBeCloseTo(1)
  })
})

describe("the confetti", () => {
  it("is thrown upwards and is the same for the same seed", () => {
    // When
    const sparks = sparksFor(12, 3)

    // Then
    expect(sparks).toHaveLength(12)
    expect(sparks.every((spark) => spark.rise <= 0)).toBe(true)
    expect(sparksFor(12, 3)).toEqual(sparks)
  })
})
