/**
 * Settings' "Allow an app…" on this Mac (ENG-846): the native picker on /Applications, and the
 * picked bundle's id and name from its Info.plist, converted to JSON by `plutil`.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppId } from "@polaris/protocol";
import { Option, Schema } from "effect";
import type { PickedApp } from "../shared/computerUseContract.ts";

const BundleInfo = Schema.Struct({
  CFBundleIdentifier: Schema.String.check(Schema.isMinLength(1)),
  CFBundleDisplayName: Schema.optionalKey(Schema.String),
  CFBundleName: Schema.optionalKey(Schema.String),
});

const run = promisify(execFile);

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(BundleInfo));

/** The `.app` folder's name without the extension, when the plist names nothing. */
const folderName = (bundlePath: string) =>
  (bundlePath.split("/").findLast((part) => part.length > 0) ?? bundlePath).replace(/\.app$/, "");

/** The app in a bundle, or null when its Info.plist is missing or has no bundle id. */
export const readBundle = async (bundlePath: string): Promise<PickedApp | null> => {
  const plist = join(bundlePath, "Contents", "Info.plist");

  const json = await run("plutil", ["-convert", "json", "-o", "-", plist]).then(
    ({ stdout }) => stdout,
    () => null
  );

  if (json === null) return null;

  return Option.match(decodeInfo(json), {
    onNone: () => null,
    onSome: (info) => ({
      id: AppId.make(info.CFBundleIdentifier),
      name: info.CFBundleDisplayName ?? info.CFBundleName ?? folderName(bundlePath),
    }),
  });
};
