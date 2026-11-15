// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { localEnv } from "../../../../packages/jollity-protocol/src/local-network.fixture"
import { chainEndpoints } from "./chain-endpoints"

afterEach(() => vi.unstubAllEnvs())
describe("draw chain endpoints", () => {
  it("uses explicit local endpoints", () => {
    for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
    expect(chainEndpoints()).toEqual({ people: localEnv.NEXT_PUBLIC_PEOPLE_WS, assetHub: localEnv.NEXT_PUBLIC_ASSET_HUB_WS })
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "")
    expect(() => chainEndpoints()).toThrow("NEXT_PUBLIC_PEOPLE_WS")
  })
  it("reads the build's own network from its descriptor, with optional overrides", () => {
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "")
    vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_WS", "")
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "previewnet")
    expect(chainEndpoints()).toEqual({ people: "wss://previewnet.substrate.dev/people", assetHub: "wss://previewnet.substrate.dev/asset-hub" })
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    expect(chainEndpoints().assetHub).toBe("wss://paseo-asset-hub-next-rpc.polkadot.io")
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "ws://override")
    expect(chainEndpoints().people).toBe("ws://override")
  })
})
