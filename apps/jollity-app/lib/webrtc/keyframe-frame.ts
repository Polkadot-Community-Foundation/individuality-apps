// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The keyframe request on the mesh data channel (#1917): a receiver whose
 * video froze on a live link (packets arriving, frames flat) asks the sender
 * for a keyframe, and the sender runs its forceKeyframe on that link. It is
 * OURS: an older build reads it as a mux frame it does not know, which falls
 * through the view and away decoders to the caller's onMessage, where the
 * clock and gesture decoders drop it (keyframe-frame.test.ts pins that).
 *
 * Same two layers as away-frame.ts: the `DataChannelMessage` envelope
 * (use-case id plus bytes) around one byte, 1. Decoding never throws.
 */
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"

/** The envelope id the frame rides under. Wire, not a name we may pick freely
 *  once a peer reads it. */
export const USE_CASE_KEYFRAME_REQUEST = "jollity_keyframe_request_use_case"

/** The frame a receiver puts on a channel to ask the sender for a keyframe. */
export function encodeKeyframeRequest(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeChannelMessage({ id: USE_CASE_KEYFRAME_REQUEST, data: new Uint8Array([1]) }))
}

/** Whether one inbound channel frame is a keyframe request. Never throws. */
export function decodeKeyframeRequest(bytes: Uint8Array): boolean {
  try {
    return decodeChannelMessage(bytes).id === USE_CASE_KEYFRAME_REQUEST
  } catch {
    return false
  }
}
