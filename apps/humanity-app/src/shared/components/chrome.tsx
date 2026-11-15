// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Screen surface and ambient light (screen/ambient), laid out as a
 *  responsive page: the host draws the device frame, status bar and top bar. */
import type { CSSProperties, ReactNode } from "react";

import { useCardFaceHidden } from "@shared/hooks/card-face.ts";

export interface ScreenProps {
  className?: string;
  /** Covers an open Pocket card's face while up (see `card-face.ts`). */
  hideCardFace?: boolean;
  children: ReactNode;
}

export function Screen({ className = "", hideCardFace = false, children }: ScreenProps) {
  useCardFaceHidden(hideCardFace);
  const classes = ["screen", hideCardFace ? "covers-card" : "", className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
}

export function Ambient({ color }: { color: string }) {
  const style = { "--ambient-c": color } as CSSProperties;
  return <div className="ambient" style={style} />;
}
