// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { localNetwork, NETWORK_CONFIG, networkName } from "@jollity/protocol"

/**
 * The build's own network's chains, for a page whose host serves none (the
 * local host CLI): where the names on the draw's wheel are read
 * from (../player-names.ts), and linked (./name-link.ts), without one. They are
 * the endpoints of the network's Trinity stack descriptor, through protocol's
 * network table, never a copy of them.
 *
 * `NEXT_PUBLIC_ASSET_HUB_WS` and `NEXT_PUBLIC_PEOPLE_WS` override them.
 */
export function chainEndpoints(): { assetHub: string; people: string } {
  const local = localNetwork()
  if (local) return local.endpoints
  const hosted = NETWORK_CONFIG[networkName() as keyof typeof NETWORK_CONFIG]
  return {
    assetHub: process.env.NEXT_PUBLIC_ASSET_HUB_WS || hosted.assetHubRpc,
    people: process.env.NEXT_PUBLIC_PEOPLE_WS || hosted.peopleRpc,
  }
}
