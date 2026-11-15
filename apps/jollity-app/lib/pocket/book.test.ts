// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOOK, CLAIM_AT, SWIPE_REACH, claims, closedBookAt, landing, onCover, openBookAt, openScale, trackSwipe } from "./book"

const stage = { width: 390, height: 844 }

describe("the Pocket book", () => {
  it("peeks over the foot at rest and stands fully on screen when the swipe completes", () => {
    // Given
    const atRest = openBookAt(0, stage)
    const up = openBookAt(1, stage)

    // Then
    const half = BOOK.height / 2
    expect(atRest.y - half).toBeCloseTo(stage.height - 104)
    expect(up.y + half).toBeCloseTo(stage.height - 24)
    expect(atRest.x).toBeCloseTo(stage.width / 2 + BOOK.width / 2)
  })

  it("keeps both open pages on screen", () => {
    // When
    const wide = openScale({ width: 402, height: 874 })
    const narrow = openScale({ width: 320, height: 568 })

    // Then
    expect(wide).toBe(1)
    expect(BOOK.width * 2 * narrow).toBeLessThanOrEqual(320 - 24)
  })

  it("closes in the middle of the screen", () => {
    expect(closedBookAt(stage)).toEqual({ x: 195, y: 422 })
  })

  it("puts the first half of an odd haul on the cover", () => {
    expect(onCover(5)).toBe(3)
    expect(onCover(6)).toBe(3)
  })
})

describe("the swipe", () => {
  it("counts only the distance down from where the finger landed", () => {
    // Given
    const landed = trackSwipe(null, { x: 100, y: 300 })

    // When
    const halfway = trackSwipe(landed, { x: 160, y: 300 + SWIPE_REACH / 2 })
    const upwards = trackSwipe(landed, { x: 100, y: 200 })
    const past = trackSwipe(landed, { x: 100, y: 300 + SWIPE_REACH * 2 })

    // Then
    expect(landed.progress).toBe(0)
    expect(halfway.progress).toBe(0.5)
    expect(halfway.start).toEqual({ x: 100, y: 300 })
    expect(upwards.progress).toBe(0)
    expect(past.progress).toBe(1)
  })

  it("claims from the threshold on and springs back below it", () => {
    expect(claims(CLAIM_AT)).toBe(true)
    expect(claims(CLAIM_AT - 0.01)).toBe(false)
  })
})

describe("a piece landing", () => {
  const trip = { from: { x: 80, y: 200 }, to: { x: 150, y: 760 }, rotation: 12, endScale: 0.5 }

  it("floats where it was before the swipe", () => {
    expect(landing({ ...trip, progress: 0 })).toEqual({ x: 0, y: 0, rotate: 12, scale: 1, opacity: 1 })
  })

  it("lies on its cell at the size of the cell and hands over to the page when the swipe completes", () => {
    // When
    const pose = landing({ ...trip, progress: 1 })

    // Then
    expect(pose.x).toBeCloseTo(70)
    expect(pose.y).toBeCloseTo(560)
    expect(pose.rotate).toBeCloseTo(0)
    expect(pose.scale).toBeCloseTo(0.5)
    expect(pose.opacity).toBe(0)
  })

  it("lands the pieces nearest their cell first", () => {
    // When
    const near = landing({ ...trip, from: { x: 150, y: 700 }, progress: 0.5 })
    const far = landing({ ...trip, progress: 0.5 })

    // Then
    expect(near.y / 60).toBeGreaterThan(far.y / 560)
  })
})
