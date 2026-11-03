/**
 * The phone's pickers and file reads behind Attach (expo-image-picker, expo-document-picker,
 * expo-file-system). Native only: tests stage through `attach.ts` with their own bytes.
 */
import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import {
  launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode,
} from "expo-image-picker";
import { choose } from "../menus/choices.ts";
import type { Picked, ReadBytes } from "./attach.ts";

const OCTET_STREAM = "application/octet-stream";

const SELECTION_LIMIT = 10;

/** Photos as JPEG or PNG (never HEIC, which most Harnesses can't read), several at once. */
export const pickPhotos = async (): Promise<ReadonlyArray<Picked>> => {
  const result = await launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: SELECTION_LIMIT,
    preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });

  if (result.canceled) return [];

  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `photo-${index + 1}.jpg`,
    mimeType: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? null,
    isImage: true,
  }));
};

export const pickFiles = async (): Promise<ReadonlyArray<Picked>> => {
  const result = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });

  if (result.canceled) return [];

  return result.assets.map((asset) => {
    const mimeType = asset.mimeType ?? OCTET_STREAM;

    return {
      uri: asset.uri,
      name: asset.name,
      mimeType,
      size: asset.size ?? null,
      isImage: mimeType.startsWith("image/"),
    };
  });
};

/** Attach's sheet: a photo or a file; nothing when cancelled. */
export const pickAttachments = (): Promise<ReadonlyArray<Picked>> =>
  new Promise((resolve, reject) => {
    choose(
      undefined,
      ["Photo library", "Files"],
      (index) => {
        const pick = [pickPhotos, pickFiles][index];

        if (pick === undefined) resolve([]);
        else pick().then(resolve, reject);
      },
      undefined,
      () => resolve([])
    );
  });

export const readBytes: ReadBytes = async (uri) =>
  new Uint8Array(await new File(uri).arrayBuffer());
