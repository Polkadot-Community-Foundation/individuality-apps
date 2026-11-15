// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decodeChannelMessage, encodeChannelMessage, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { decodeAway } from "./away-frame"
import { decodeClockFrame } from "./clock-frame"
import { decodeGesture } from "./gesture"
import { decodeViewFrame } from "./link-view"
import { decodeKeyframeRequest, encodeKeyframeRequest, USE_CASE_KEYFRAME_REQUEST } from "./keyframe-frame"

/** The wire, pinned: the id and the one byte an older build will meet. */
const WIRE_ID = "jollity_keyframe_request_use_case"
const wireFrame = () => new Uint8Array(encodeChannelMessage({ id: WIRE_ID, data: new Uint8Array([1]) }))

/** An older build's receive path for one inbound channel frame, as main had it
 *  at b4039e38b: Mesh's channel.onmessage (the renegotiation lane, the e2e
 *  renegotiation lane, the view frame, the away frame, then the caller's
 *  onMessage), and useMesh's onMessage (the clock frame, then the gesture,
 *  and anything else dropped quietly). Returns who took the frame. */
function olderBuildReceive(bytes: Uint8Array): "renegotiation" | "e2e" | "view" | "away" | "clock" | "gesture" | "dropped" {
  let frame: { id: string; data: Uint8Array } | undefined
  try {
    frame = decodeChannelMessage(bytes)
  } catch {
    /* not a mux frame */
  }
  if (frame?.id === USE_CASE_RENEGOTIATION) return "renegotiation"
  if (frame?.id === "jollity-e2e-renegotiation-v1") return "e2e"
  if (decodeViewFrame(bytes) !== null) return "view"
  if (decodeAway(bytes) !== null) return "away"
  // useMesh's onMessage
  if (decodeClockFrame(bytes)) return "clock"
  if (decodeGesture(bytes)) return "gesture"
  return "dropped"
}

describe("the keyframe request frame (#1917)", () => {
  it("is dropped harmlessly by an older build's receive path", () => {
    const bytes = wireFrame()
    // a valid mux frame, so nothing throws on the way
    expect(decodeChannelMessage(bytes).id).toBe(WIRE_ID)
    expect(() => olderBuildReceive(bytes)).not.toThrow()
    expect(olderBuildReceive(bytes)).toBe("dropped")
    // no decoder on the way reads it as its own: no view row, no away mark, no clock, no gesture
    expect(decodeViewFrame(bytes)).toBeNull()
    expect(decodeAway(bytes)).toBeNull()
    expect(decodeClockFrame(bytes)).toBeNull()
    expect(decodeGesture(bytes)).toBeNull()
  })

  it("rides its own pinned use-case id, one byte", () => {
    expect(USE_CASE_KEYFRAME_REQUEST).toBe(WIRE_ID)
    expect([...encodeKeyframeRequest()]).toEqual([...wireFrame()])
  })

  it("reads only itself, and never throws", () => {
    expect(decodeKeyframeRequest(encodeKeyframeRequest())).toBe(true)
    expect(decodeKeyframeRequest(new Uint8Array(encodeChannelMessage({ id: "other", data: new Uint8Array([1]) })))).toBe(false)
    expect(decodeKeyframeRequest(new Uint8Array([9, 9, 9]))).toBe(false)
    expect(decodeKeyframeRequest(new Uint8Array())).toBe(false)
  })
})
