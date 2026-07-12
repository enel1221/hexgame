import packageMetadata from "../../package.json";

declare const __APP_VERSION__: string | undefined;
declare const __BUILD_NUMBER__: string | undefined;
declare const __COMMIT_SHA__: string | undefined;

function injectedValue(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export const APP_VERSION = injectedValue(
  typeof __APP_VERSION__ === "undefined" ? undefined : __APP_VERSION__,
  packageMetadata.version,
);
export const BUILD_NUMBER = injectedValue(
  typeof __BUILD_NUMBER__ === "undefined" ? undefined : __BUILD_NUMBER__,
  `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.local`,
);
export const COMMIT_SHA = injectedValue(
  typeof __COMMIT_SHA__ === "undefined" ? undefined : __COMMIT_SHA__,
  "local",
).slice(0, 12);

export const VERSION_LABEL = `v${APP_VERSION} · build ${BUILD_NUMBER}`;
