// Adapted from T3 Code, copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.txt.
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
