/**
 * The phone's pickers and file reads behind Attach (expo-image-picker, expo-document-picker,
 * expo-file-system). Native only: tests stage through `attach.ts` with their own bytes.
 */
import { getDocumentAsync } from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import {
  type ImagePickerOptions,
  launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode,
} from "expo-image-picker";
import { choose } from "../menus/choices.ts";
import { compatiblePhoto, type Picked, type ReadBytes } from "./attach.ts";

const OCTET_STREAM = "application/octet-stream";

const SELECTION_LIMIT = 10;

/** Photos as JPEG or PNG (never HEIC, which most Harnesses can't read), several at once. */
export const pickPhotos = async (): Promise<ReadonlyArray<Picked>> => {
  const options: ImagePickerOptions = {
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: SELECTION_LIMIT,
    preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible,
  };

  // Android's compressed export exposes actual JPEG bytes in base64, regardless of source MIME.
  if (Platform.OS === "android") {
    options.quality = 0.99;
    options.base64 = true;
  }

  const result = await launchImageLibraryAsync(options);

  if (result.canceled) return [];

  return Promise.all(
    result.assets.map(async (asset, index) => {
      const picked: Picked = {
        uri: asset.uri,
        name: asset.fileName ?? `photo-${index + 1}.jpg`,
        mimeType: asset.mimeType ?? (Platform.OS === "android" ? OCTET_STREAM : "image/jpeg"),
        size: Platform.OS === "android" ? new File(asset.uri).size : (asset.fileSize ?? null),
        isImage: true,
      };

      if (Platform.OS !== "android") return picked;

      return compatiblePhoto(picked, async () => {
        if (!asset.base64)
          throw new Error("Couldn't convert this photo to JPEG. Try a PNG or JPEG file.");
        const file = new File(Paths.cache, `photo-${Date.now()}-${index}.jpg`);
        await file.write(asset.base64, { encoding: "base64" });

        return { uri: file.uri, size: file.size };
      });
    })
  );
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
